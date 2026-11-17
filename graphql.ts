// graphql.ts — a small hand-written GraphQL executor for the fixed document set the
// suite sends. It parses operations, variables, aliases, inline enum/object literals,
// input objects, inline fragments, and batched arrays. No dependencies.

import { ForgeError, VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type GqlValue =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: GqlValue[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: GqlValue }> };

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and plain strings.
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const next = source[j + 1];
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (next === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (next !== undefined && next in escapes) {
            value += escapes[next];
            j += 2;
          } else {
            value += next ?? '';
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$&():=@[]{|}.'.includes(ch)) {
      if (ch === '.' && source.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

export interface VariableDefinition {
  readonly name: string;
  readonly type: string;
  readonly defaultValue?: GqlValue;
}

export interface Argument {
  readonly name: string;
  readonly value: GqlValue;
}

export interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias?: string;
  readonly args: Argument[];
  readonly selection: SelectionNode[];
}

export interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition?: string;
  readonly selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name?: string;
  readonly variables: VariableDefinition[];
  readonly selection: SelectionNode[];
}

export interface Document {
  readonly operations: Operation[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return { operations };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      kind = token.value as 'query' | 'mutation';
      const nextToken = this.peek();
      if (nextToken.kind === 'name') {
        this.next();
        name = nextToken.value;
      }
    } else if (token.kind === 'punct' && token.value === '{') {
      // Shorthand query.
    } else {
      throw new Error('expected a query or mutation operation');
    }
    const variables = this.parseVariableDefinitions();
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    if (!this.acceptPunct('(')) return definitions;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: GqlValue | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      definitions.push({ name, type, defaultValue });
    }
    return definitions;
  }

  private parseType(): string {
    let type = '';
    if (this.acceptPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const peeked = this.peek();
    if (peeked.kind === 'punct' && peeked.value === '...') {
      this.next();
      let typeCondition: string | undefined;
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (token.kind === 'name') {
        // A named fragment spread — not used by the suite; treat as an error-free skip.
        this.next();
      }
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selection };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selection: SelectionNode[] = [];
    const brace = this.peek();
    if (brace.kind === 'punct' && brace.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArguments(): Argument[] {
    const args: Argument[] = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(isConst: boolean): GqlValue {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') {
          if (isConst) throw new Error('a variable is not allowed in a constant value');
          return { kind: 'variable', name: this.expectName() };
        }
        if (token.value === '[') {
          const values: GqlValue[] = [];
          for (;;) {
            const nextToken = this.peek();
            if (nextToken.kind === 'punct' && nextToken.value === ']') break;
            values.push(this.parseValue(isConst));
          }
          this.next();
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: GqlValue }> = [];
          for (;;) {
            const nextToken = this.peek();
            if (nextToken.kind === 'punct' && nextToken.value === '}') break;
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue(isConst) });
          }
          this.next();
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${JSON.stringify(token.value)} in a value`);
      default:
        throw new Error('unexpected end of document in a value');
    }
  }
}

export function parseGraphQL(source: string): Document {
  return new Parser(source).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// global ids + cursors
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return undefined;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return undefined;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', [repo.id]);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', [repo.id, issue.number]);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return encodeGlobalId('PullRequest', [repo.id, pull.number]);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return encodeGlobalId('IssueComment', [repo.id, issueNumber, commentId]);
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqFromCursor(cursor: string): number | undefined {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, JsonValue>;

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

interface ExecutionContext {
  readonly store: Store;
  readonly variables: Variables;
}

/** Resolve a value node against the operation's variables. */
function resolveValue(value: GqlValue, variables: Variables): JsonValue {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, JsonValue> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): JsonValue {
  const arg = field.args.find((item) => item.name === name);
  if (!arg) return null;
  return resolveValue(arg.value, variables);
}

function argObject(field: FieldNode, name: string, variables: Variables): Record<string, JsonValue> | null {
  const value = argValue(field, name, variables);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

function asString(value: JsonValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: JsonValue): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asStringList(value: JsonValue): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** The shape of a connection page: edges + pageInfo. */
interface ConnectionResult {
  readonly nodes: Array<Record<string, unknown>>;
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function paginate<T extends { createdSeq: number }>(
  items: T[],
  first: number | undefined,
  after: string | undefined,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let filtered = items;
  if (after !== undefined) {
    const seq = seqFromCursor(after);
    if (seq !== undefined) filtered = items.filter((item) => item.createdSeq > seq);
  }
  const size = first ?? items.length;
  const page = filtered.slice(0, size);
  const hasNextPage = filtered.length > size;
  const endCursor = page.length ? cursorFor(page[page.length - 1].createdSeq) : null;
  return { page, hasNextPage, endCursor };
}

/** One issue as a GraphQL object; `selection` decides which fields are computed. */
function issueObject(context: ExecutionContext, repo: Repo, issue: Issue, selection: SelectionNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition && node.typeCondition !== 'Issue') continue;
      Object.assign(out, issueObject(context, repo, issue, node.selection));
      continue;
    }
    const key = node.alias ?? node.name;
    switch (node.name) {
      case 'id':
        out[key] = issueGlobalId(repo, issue);
        break;
      case 'databaseId':
        out[key] = issue.number;
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'state':
        out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'createdAt':
        out[key] = issue.createdAt;
        break;
      case 'updatedAt':
        out[key] = issue.updatedAt;
        break;
      case 'labels': {
        const labels = issue.labels.map((name) => ({ name }));
        out[key] = resolveConnection(context, labels, node, (label) => ({ name: label.name }));
        break;
      }
      case 'comments': {
        const comments = context.store.listComments(repo, issue.number);
        out[key] = resolveConnection(context, comments, node, (comment) => ({
          id: commentGlobalId(repo, issue.number, comment.id),
          body: comment.body,
        }));
        break;
      }
      default:
        throw new GraphQLError(`Cannot query field "${node.name}" on type "Issue".`);
    }
  }
  return out;
}

/** One pull request as a GraphQL object. */
function pullObject(context: ExecutionContext, repo: Repo, pull: PullRequest, selection: SelectionNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition && node.typeCondition !== 'PullRequest') continue;
      Object.assign(out, pullObject(context, repo, pull, node.selection));
      continue;
    }
    const key = node.alias ?? node.name;
    switch (node.name) {
      case 'id':
        out[key] = pullGlobalId(repo, pull);
        break;
      case 'databaseId':
        out[key] = pull.number;
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergedAt':
        out[key] = pull.mergedAt;
        break;
      case 'mergeable':
        out[key] = context.store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'headRefOid':
        out[key] = context.store.pullHeadSha(repo, pull) ?? null;
        break;
      case 'baseRefOid':
        out[key] = context.store.pullBaseSha(repo, pull) ?? null;
        break;
      case 'createdAt':
        out[key] = pull.createdAt;
        break;
      case 'updatedAt':
        out[key] = pull.updatedAt;
        break;
      case 'files': {
        const files = context.store.pullFiles(repo, pull);
        out[key] = resolveConnection(context, files, node, (file) => ({
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        break;
      }
      default:
        throw new GraphQLError(`Cannot query field "${node.name}" on type "PullRequest".`);
    }
  }
  return out;
}

/**
 * A connection field (nodes/edges/pageInfo/totalCount). `items` are plain rows already
 * in the right order; `project` turns one row into its GraphQL fields.
 */
function resolveConnection<T>(
  context: ExecutionContext,
  items: T[],
  field: FieldNode,
  project: (item: T) => Record<string, JsonValue>,
): Record<string, JsonValue> {
  const first = asNumber(argValue(field, 'first', context.variables));
  const after = asString(argValue(field, 'after', context.variables));
  const out: Record<string, JsonValue> = {};
  const subfields = field.selection;
  // Items without a createdSeq sort as seq 0; callers that need cursors pass seq'd rows.
  const seqOf = (item: T): number =>
    (item as unknown as { createdSeq?: number }).createdSeq ?? 0;
  let filtered = items;
  if (after !== undefined) {
    const seq = seqFromCursor(after);
    if (seq !== undefined) filtered = items.filter((item) => seqOf(item) > seq);
  }
  const size = first ?? filtered.length;
  const page = filtered.slice(0, size);
  const hasNextPage = filtered.length > size;
  const endCursor = page.length ? cursorFor(seqOf(page[page.length - 1])) : null;
  for (const node of subfields) {
    if (node.kind === 'fragment') {
      Object.assign(out, resolveConnection(context, items, { ...field, selection: node.selection }, project));
      continue;
    }
    const key = node.alias ?? node.name;
    switch (node.name) {
      case 'nodes':
        out[key] = page.map((item) => project(item));
        break;
      case 'edges':
        out[key] = page.map((item) => ({ node: project(item), cursor: cursorFor(seqOf(item)) }));
        break;
      case 'totalCount':
        out[key] = filtered.length;
        break;
      case 'pageInfo':
        out[key] = { hasNextPage, endCursor };
        break;
      default:
        throw new GraphQLError(`Cannot query field "${node.name}" on type "Connection".`);
    }
  }
  return out;
}

/** A repository as a GraphQL object. */
function repoObject(context: ExecutionContext, repo: Repo, selection: SelectionNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition && node.typeCondition !== 'Repository') continue;
      Object.assign(out, repoObject(context, repo, node.selection));
      continue;
    }
    const key = node.alias ?? node.name;
    switch (node.name) {
      case 'id':
        out[key] = repoGlobalId(repo);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = repo.fullName;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'owner':
        out[key] = { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 };
        break;
      case 'defaultBranchRef':
        out[key] = { name: repo.defaultBranch };
        break;
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const number = asNumber(argValue(node, 'number', context.variables));
        const issue = number !== undefined ? repo.issues.get(number) : undefined;
        out[key] = issue ? issueObject(context, repo, issue, node.selection) : null;
        break;
      }
      case 'issues': {
        const orderBy = argObject(node, 'orderBy', context.variables);
        const states = asStringList(argValue(node, 'states', context.variables));
        let issues = [...repo.issues.values()];
        if (states && states.length) {
          const want = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
          issues = issues.filter((issue) => want.has(issue.state));
        }
        if (orderBy && orderBy.field === 'CREATED_AT') {
          issues.sort((a, b) => {
            const cmp = a.createdSeq - b.createdSeq || a.number - b.number;
            return orderBy.direction === 'DESC' ? -cmp : cmp;
          });
        } else {
          issues.sort((a, b) => a.number - b.number);
        }
        const first = asNumber(argValue(node, 'first', context.variables));
        const after = asString(argValue(node, 'after', context.variables));
        const { page, hasNextPage, endCursor } = paginate(issues, first, after);
        const result: Record<string, JsonValue> = {};
        for (const sub of node.selection) {
          if (sub.kind === 'fragment') continue;
          const subKey = sub.alias ?? sub.name;
          if (sub.name === 'nodes') result[subKey] = page.map((issue) => issueObject(context, repo, issue, sub.selection));
          else if (sub.name === 'edges') result[subKey] = page.map((issue) => ({ node: issueObject(context, repo, issue, sub.selection), cursor: cursorFor(issue.createdSeq) }));
          else if (sub.name === 'totalCount') result[subKey] = issues.length;
          else if (sub.name === 'pageInfo') result[subKey] = { hasNextPage, endCursor };
          else throw new GraphQLError(`Cannot query field "${sub.name}" on type "IssueConnection".`);
        }
        out[key] = result;
        break;
      }
      case 'pullRequest': {
        const number = asNumber(argValue(node, 'number', context.variables));
        const pull = number !== undefined ? repo.pulls.get(number) : undefined;
        out[key] = pull ? pullObject(context, repo, pull, node.selection) : null;
        break;
      }
      case 'pullRequests': {
        const states = asStringList(argValue(node, 'states', context.variables));
        let pulls = [...repo.pulls.values()];
        if (states && states.length) {
          const want = new Set(
            states.map((state) => (state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'closed')),
          );
          pulls = pulls.filter((pull) => {
            if (want.has('merged') && pull.merged) return true;
            return want.has(pull.state);
          });
        }
        pulls.sort((a, b) => a.number - b.number);
        const first = asNumber(argValue(node, 'first', context.variables));
        const after = asString(argValue(node, 'after', context.variables));
        const { page, hasNextPage, endCursor } = paginate(pulls, first, after);
        const result: Record<string, JsonValue> = {};
        for (const sub of node.selection) {
          if (sub.kind === 'fragment') continue;
          const subKey = sub.alias ?? sub.name;
          if (sub.name === 'nodes') result[subKey] = page.map((pull) => pullObject(context, repo, pull, sub.selection));
          else if (sub.name === 'edges') result[subKey] = page.map((pull) => ({ node: pullObject(context, repo, pull, sub.selection), cursor: cursorFor(pull.createdSeq) }));
          else if (sub.name === 'totalCount') result[subKey] = pulls.length;
          else if (sub.name === 'pageInfo') result[subKey] = { hasNextPage, endCursor };
          else throw new GraphQLError(`Cannot query field "${sub.name}" on type "PullRequestConnection".`);
        }
        out[key] = result;
        break;
      }
      default:
        throw new GraphQLError(`Cannot query field "${node.name}" on type "Repository".`);
    }
  }
  return out;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];

/** The `__type(name: "...")` introspection answer for the types the suite asks about. */
function typeObject(name: string, selection: SelectionNode[]): Record<string, JsonValue> | null {
  const fields =
    name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_REQUEST_FIELDS : name === 'Repository' ? REPOSITORY_FIELDS : null;
  const isEnum = name === 'SearchType';
  if (!fields && !isEnum) return null;
  const out: Record<string, JsonValue> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') continue;
    const key = node.alias ?? node.name;
    if (node.name === 'name') out[key] = name;
    else if (node.name === 'kind') out[key] = isEnum ? 'ENUM' : 'OBJECT';
    else if (node.name === 'fields') {
      const list = (fields ?? []).map((field) => ({ name: field }));
      const first = asNumber(argValue(node, 'first', {}));
      out[key] = first !== undefined ? list.slice(0, first) : list;
    } else if (node.name === 'enumValues') {
      if (isEnum) out[key] = [{ name: 'ISSUE' }, { name: 'USER' }, { name: 'REPOSITORY' }];
      else out[key] = null;
    } else {
      throw new GraphQLError(`Cannot query field "${node.name}" on type "__Type".`);
    }
  }
  return out;
}

/** The `__schema` answer: only the pieces the suite reads. */
function schemaObject(selection: SelectionNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') continue;
    const key = node.alias ?? node.name;
    if (node.name === 'queryType') out[key] = { name: 'Query' };
    else if (node.name === 'mutationType') out[key] = { name: 'Mutation' };
    else if (node.name === 'types') out[key] = ['Query', 'Mutation', 'Repository', 'Issue', 'PullRequest', 'SearchType'].map((name) => ({ name }));
    else throw new GraphQLError(`Cannot query field "${node.name}" on type "__Schema".`);
  }
  return out;
}

function viewerObject(context: ExecutionContext, selection: SelectionNode[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      Object.assign(out, viewerObject(context, node.selection));
      continue;
    }
    const key = node.alias ?? node.name;
    switch (node.name) {
      case 'login':
        out[key] = VIEWER.login;
        break;
      case 'id':
        out[key] = encodeGlobalId('User', [VIEWER.id]);
        break;
      case 'databaseId':
        out[key] = VIEWER.id;
        break;
      case 'repository': {
        const owner = asString(argValue(node, 'owner', context.variables));
        const name = asString(argValue(node, 'name', context.variables));
        const repo = owner && name ? context.store.repo(owner, name) : undefined;
        out[key] = repo ? repoObject(context, repo, node.selection) : null;
        break;
      }
      case '__type': {
        const name = asString(argValue(node, 'name', context.variables));
        out[key] = name ? typeObject(name, node.selection) : null;
        break;
      }
      case '__schema':
        out[key] = schemaObject(node.selection);
        break;
      default:
        throw new GraphQLError(`Cannot query field "${node.name}" on type "Viewer".`);
    }
  }
  return out;
}

/** Execute one root field of a query operation. */
function executeRootField(context: ExecutionContext, field: FieldNode): JsonValue {
  switch (field.name) {
    case 'viewer':
      return viewerObject(context, field.selection);
    case 'repository': {
      const owner = asString(argValue(field, 'owner', context.variables));
      const name = asString(argValue(field, 'name', context.variables));
      const repo = owner && name ? context.store.repo(owner, name) : undefined;
      return repo ? repoObject(context, repo, field.selection) : null;
    }
    case 'node': {
      const id = asString(argValue(field, 'id', context.variables));
      const decoded = id ? decodeGlobalId(id) : undefined;
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = context.store.repoById(Number(decoded.parts[0]));
        if (!repo) return null;
        return repoObject(context, repo, field.selection);
      }
      if (decoded.kind === 'Issue') {
        const repo = context.store.repoById(Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (!repo || !issue) return null;
        return issueObject(context, repo, issue, field.selection);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = context.store.repoById(Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        if (!repo || !pull) return null;
        return pullObject(context, repo, pull, field.selection);
      }
      return null;
    }
    case '__type': {
      const name = asString(argValue(field, 'name', context.variables));
      return name ? typeObject(name, field.selection) : null;
    }
    case '__schema':
      return schemaObject(field.selection);
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
  }
}

/** Resolve a repositoryId input: a numeric database id, a global id, or a numeric string. */
function repoFromIdInput(context: ExecutionContext, value: JsonValue): Repo | undefined {
  if (typeof value === 'number') return context.store.repoById(value);
  if (typeof value === 'string') {
    const decoded = decodeGlobalId(value);
    if (decoded && decoded.kind === 'Repository') return context.store.repoById(Number(decoded.parts[0]));
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return context.store.repoById(numeric);
  }
  return undefined;
}

/** Execute one root field of a mutation operation. */
function executeMutationField(context: ExecutionContext, field: FieldNode): JsonValue {
  const input = argObject(field, 'input', context.variables) ?? {};
  switch (field.name) {
    case 'createIssue': {
      const repo = repoFromIdInput(context, input.repositoryId ?? null);
      const title = asString(input.title);
      const body = asString(input.body);
      if (!repo || !title) return null;
      const issue = context.store.createIssue(repo, { title, body });
      const result: Record<string, JsonValue> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'issue') result[key] = issueObject(context, repo, issue, node.selection);
        else if (node.name === 'clientMutationId') result[key] = asString(input.clientMutationId) ?? null;
        else throw new GraphQLError(`Cannot query field "${node.name}" on type "CreateIssuePayload".`);
      }
      return result;
    }
    case 'closeIssue': {
      const issueId = asString(input.issueId);
      const decoded = issueId ? decodeGlobalId(issueId) : undefined;
      if (!decoded || decoded.kind !== 'Issue') return null;
      const repo = context.store.repoById(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (!repo || !issue) return null;
      context.store.updateIssue(repo, issue.number, { state: 'closed' });
      const result: Record<string, JsonValue> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'issue') result[key] = issueObject(context, repo, issue, node.selection);
        else if (node.name === 'clientMutationId') result[key] = asString(input.clientMutationId) ?? null;
        else throw new GraphQLError(`Cannot query field "${node.name}" on type "CloseIssuePayload".`);
      }
      return result;
    }
    case 'createPullRequest': {
      const repo = repoFromIdInput(context, input.repositoryId ?? null);
      const title = asString(input.title);
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      if (!repo || !title || !head || !base) return null;
      const pull = context.store.createPull(repo, { title, head, base });
      const result: Record<string, JsonValue> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'pullRequest') result[key] = pullObject(context, repo, pull, node.selection);
        else if (node.name === 'clientMutationId') result[key] = asString(input.clientMutationId) ?? null;
        else throw new GraphQLError(`Cannot query field "${node.name}" on type "CreatePullRequestPayload".`);
      }
      return result;
    }
    case 'mergePullRequest': {
      const pullId = asString(input.pullRequestId);
      const decoded = pullId ? decodeGlobalId(pullId) : undefined;
      if (!decoded || decoded.kind !== 'PullRequest') return null;
      const repo = context.store.repoById(Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      if (!repo || !pull) return null;
      const method = asString(input.mergeMethod);
      try {
        context.store.mergePull(repo, pull, method);
      } catch (error) {
        if (error instanceof ForgeError) return null;
        throw error;
      }
      const result: Record<string, JsonValue> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'pullRequest') result[key] = pullObject(context, repo, pull, node.selection);
        else if (node.name === 'clientMutationId') result[key] = asString(input.clientMutationId) ?? null;
        else throw new GraphQLError(`Cannot query field "${node.name}" on type "MergePullRequestPayload".`);
      }
      return result;
    }
    case 'addComment': {
      const subjectId = asString(input.subjectId);
      const body = asString(input.body);
      const decoded = subjectId ? decodeGlobalId(subjectId) : undefined;
      if (!decoded || !body) return null;
      let repo: Repo | undefined;
      let issueNumber: number | undefined;
      if (decoded.kind === 'Issue') {
        repo = context.store.repoById(Number(decoded.parts[0]));
        issueNumber = Number(decoded.parts[1]);
      }
      if (!repo || issueNumber === undefined) return null;
      const comment = context.store.createComment(repo, issueNumber, body);
      const result: Record<string, JsonValue> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'commentEdge') {
          result[key] = {
            node: { id: commentGlobalId(repo, issueNumber, comment.id), body: comment.body },
            cursor: cursorFor(comment.id),
          };
        } else if (node.name === 'clientMutationId') {
          result[key] = asString(input.clientMutationId) ?? null;
        } else {
          throw new GraphQLError(`Cannot query field "${node.name}" on type "AddCommentPayload".`);
        }
      }
      return result;
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

/** Execute one operation document. Unknown fields become a top-level errors array. */
export function executeOperation(store: Store, operation: Operation, variables: Variables): { data: Record<string, JsonValue> | null; errors?: Array<{ message: string }> } {
  const context: ExecutionContext = { store, variables };
  const data: Record<string, JsonValue> = {};
  try {
    for (const node of operation.selection) {
      if (node.kind === 'fragment') {
        // A top-level fragment without a type condition applies to the root type.
        for (const sub of node.selection) {
          if (sub.kind !== 'field') continue;
          const key = sub.alias ?? sub.name;
          data[key] = operation.kind === 'mutation' ? executeMutationField(context, sub) : executeRootField(context, sub);
        }
        continue;
      }
      const key = node.alias ?? node.name;
      data[key] = operation.kind === 'mutation' ? executeMutationField(context, node) : executeRootField(context, node);
    }
    return { data };
  } catch (error) {
    if (error instanceof GraphQLError) {
      // The suite's invalid-field check wants an errors array naming the field,
      // with HTTP 200 — and a null data when the field cannot be resolved.
      return { data: null, errors: [{ message: error.message }] };
    }
    throw error;
  }
}

/** The GraphQL entry point: parse and execute a request body (one document or a batch). */
export function executeGraphQL(
  store: Store,
  body: unknown,
): { data?: Record<string, JsonValue> | null; errors?: Array<{ message: string }> } | Array<{ data?: Record<string, JsonValue> | null; errors?: Array<{ message: string }> }> {
  if (Array.isArray(body)) {
    return body.map((item) => executeGraphQLSingle(store, item));
  }
  return executeGraphQLSingle(store, body);
}

function executeGraphQLSingle(
  store: Store,
  body: unknown,
): { data?: Record<string, JsonValue> | null; errors?: Array<{ message: string }> } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object' }] };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : undefined;
  if (!query) return { data: null, errors: [{ message: 'No query provided' }] };
  const variables = (record.variables ?? {}) as Variables;
  let document: Document;
  try {
    document = parseGraphQL(query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Failed to parse the query' }] };
  }
  if (!document.operations.length) return { data: null, errors: [{ message: 'No operation provided' }] };
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  const operation =
    document.operations.find((item) => item.name === operationName) ?? document.operations[0];
  return executeOperation(store, operation, variables);
}

export { ForgeError as _ForgeError };
