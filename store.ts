// store.ts — the forge's in-memory data model and business logic.
// Every surface (REST, GraphQL, MCP, git smart HTTP) reads and writes this one store,
// so the four surfaces always agree. Deterministic: no wall clock in request handling.
// Logical time: a fixed base epoch from MAKEFUN_TRIAL_NOW (or a fallback) plus a
// monotonic counter; one distinct timestamp per mutation, in creation order.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const DEFAULT_BRANCH = 'main';
/** The default label set a newly created repository carries. */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

/** The fixed base epoch (seconds) used when no trial timestamp is supplied. */
export const DEFAULT_EPOCH_SEC = 1700000000;
const MAX_TICKS = 10_000_000;

function parseTrialNow(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds);
  return undefined;
}

/**
 * Render a UTC ISO 8601 string from epoch seconds, computed from a civil calendar
 * (Howard Hinnant's algorithm) — never `new Date(...)` in a request path.
 */
export function isoFromEpoch(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const secondsOfDay = seconds - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const fullYear = month <= 2 ? year + 1 : year;
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(fullYear, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.000Z`;
}

/** Format epoch seconds as the git author/committer date (e.g. 2023-11-14 22:13:20 +0000). */
export function gitDate(seconds: number): string {
  const iso = isoFromEpoch(seconds);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`;
}

export interface Account {
  readonly id: number;
  readonly login: string;
  readonly email: string;
}

export interface RepoRef {
  readonly name: string;
  readonly oid: string;
}

export interface Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  readonly fullName: string;
  privateFlag: boolean;
  description: string;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** refs: full ref name (refs/heads/...) -> oid. */
  readonly refs: Map<string, string>;
  /** next issue/PR number. Issues and PRs share one counter, GitHub-style. */
  nextNumber: number;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly comments: Map<number, IssueComment>;
  nextCommentId: number;
  readonly filesCache: Map<string, Buffer>;
  /** true when filesCache is empty-but-valid (repo with no files yet). */
  filesCacheEmpty: boolean;
  /** Bumped on every ref change; git advertisement/ls-refs/fetch caches key on it. */
  refVersion: number;
  /** Bumped on every issue mutation; the issue-JSON cache keys on it. */
  issueVersion: number;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
  readonly closedBy?: undefined;
}

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export interface IssueComment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface CreateRepoParams {
  name: string;
  description?: string;
  privateFlag?: boolean;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
}

export interface CreatePullParams {
  title: string;
  body?: string;
  head: string;
  base: string;
}

/** The error a store operation raises; the HTTP layer turns it into a JSON error. */
export class ForgeError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
    this.detail = detail ?? message;
  }
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The forge's owner identity: the fixed scenario viewer. The token is opaque, so the
 * viewer is always this login.
 */
export const VIEWER: Account = { id: 1000, login: 'adaiversen', email: 'adaiversen@example.invalid' };

/**
 * The store. `owner` is always the viewer's login: the suite only ever acts as the
 * token owner, and the same repo name under another owner is 404, never 403.
 */
export class Store {
  readonly objects = new Map<string, GitObject>();
  private readonly repos = new Map<string, Repo>();
  private readonly repoKeys: string[] = [];
  private nextRepoId = 1;
  private tickCount = 0;
  readonly epochBase: number;
  readonly viewerLogin: string = VIEWER.login;
  private filesCacheVersion = 0;
  /** Parsed commits, cached by oid. A commit's bytes never change, so its parsed
   * form never changes; this turns every repeat `commitOf` (planFetch walks,
   * isDescendant checks, REST/GraphQL commit reads) from a re-parse into a Map
   * lookup. Bounded by the number of distinct commits in the trial. */
  private readonly parsedCommits = new Map<string, { tree: string; parents: string[]; message: string }>();

  constructor(options: { epochBase?: number } = {}) {
    this.epochBase = options.epochBase ?? parseTrialNow(process.env.MAKEFUN_TRIAL_NOW) ?? DEFAULT_EPOCH_SEC;
  }

  /** The next logical timestamp; each mutation gets its own, in creation order. */
  nextTime(): { iso: string; epoch: number } {
    const epoch = this.epochBase + this.tickCount;
    this.tickCount += 1;
    if (this.tickCount >= MAX_TICKS) throw new Error('logical clock exhausted');
    return { iso: isoFromEpoch(epoch), epoch };
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    const existing = this.objects.get(oid);
    if (!existing) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjectEntry(entry: GitObject): string {
    const oid = hashObject(entry.type, entry.data);
    if (!this.objects.has(oid)) this.objects.set(oid, entry);
    return oid;
  }

  /** Store an object whose oid is already known (e.g. it came out of `readPack`, which
   * computed the oid while parsing). Skips a redundant `hashObject` per object. */
  putObjectEntryWithOid(oid: string, entry: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, entry);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  listRepos(): Repo[] {
    return this.repoKeys.map((key) => this.repos.get(key)!).filter(Boolean);
  }

  createRepo(owner: string, params: CreateRepoParams): Repo {
    if (!params.name || !NAME_RE.test(params.name)) {
      throw new ForgeError(422, 'Invalid repository name');
    }
    const key = this.repoKey(owner, params.name);
    if (this.repos.has(key)) throw new ForgeError(422, 'Repository already exists');
    const now = this.nextTime();
    const repo: Repo = {
      owner,
      name: params.name,
      id: this.nextRepoId++,
      fullName: `${owner}/${params.name}`,
      privateFlag: Boolean(params.privateFlag),
      description: params.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now.iso,
      updatedAt: now.iso,
      refs: new Map(),
      nextNumber: 1,
      labels: new Map(DEFAULT_LABELS.map((label) => [label.name, { ...label }])),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextCommentId: 1,
      filesCache: new Map(),
      filesCacheEmpty: true,
      refVersion: 0,
      issueVersion: 0,
    };
    this.repos.set(key, repo);
    this.repoKeys.push(key);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const key = this.repoKey(owner, name);
    const repo = this.repos.get(key);
    if (!repo) throw new ForgeError(404, 'Not Found');
    this.repos.delete(key);
    const index = this.repoKeys.indexOf(key);
    if (index >= 0) this.repoKeys.splice(index, 1);
  }

  updateRepo(owner: string, name: string, patch: { description?: string; privateFlag?: boolean }): Repo {
    const repo = this.repo(owner, name);
    if (!repo) throw new ForgeError(404, 'Not Found');
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.privateFlag !== undefined) repo.privateFlag = patch.privateFlag;
    repo.updatedAt = this.nextTime().iso;
    return repo;
  }

  repoFilesVersion(): number {
    return this.filesCacheVersion;
  }

  /**
   * A read through an uncached path (for example an object written directly into the
   * store by a test setup) must not see stale per-repo files. We bump the version on
   * every mutation and clear the per-repo caches eagerly on mutation, so the version
   * is only used as a cheap sanity stamp.
   */
  private bumpFilesVersion(): void {
    this.filesCacheVersion += 1;
  }

  invalidateRepo(repo: Repo): void {
    repo.filesCache.clear();
    repo.filesCacheEmpty = false;
    this.bumpFilesVersion();
  }

  // -----------------------------------------------------------------------------------------
  // branches / refs
  // -----------------------------------------------------------------------------------------

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(this.branchRef(branch));
  }

  /** Every head, as {name, oid}. */
  branches(repo: Repo): RepoRef[] {
    const out: RepoRef[] = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), oid });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.refVersion += 1;
    this.invalidateRepo(repo);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const had = repo.refs.delete(ref);
    if (had) {
      repo.refVersion += 1;
      this.invalidateRepo(repo);
    }
    return had;
  }

  // -----------------------------------------------------------------------------------------
  // commits / trees
  // -----------------------------------------------------------------------------------------

  commitOf(oid: string): { tree: string; parents: string[]; message: string } | undefined {
    const hit = this.parsedCommits.get(oid);
    if (hit) return hit;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return undefined;
    const parsed = parseCommit(object.data);
    const out = { tree: parsed.tree, parents: parsed.parents, message: parsed.message };
    this.parsedCommits.set(oid, out);
    return out;
  }

  treeEntries(oid: string): TreeEntry[] | undefined {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return undefined;
    return parseTree(object.data);
  }

  /** Every file in a tree: path -> {oid, mode}. Recurses into subtrees. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, prefix: string): void => {
      for (const entry of this.treeEntries(tree) ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** true when `descendant` is `ancestor` or reachable from it by following parents. */
  isDescendant(descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(current);
      if (!commit) return false;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two commits (first match walking both histories). */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsOfB = new Set<string>();
    const queueB = [b];
    while (queueB.length) {
      const current = queueB.pop()!;
      if (ancestorsOfB.has(current)) continue;
      ancestorsOfB.add(current);
      const commit = this.commitOf(current);
      if (!commit) continue;
      queueB.push(...commit.parents);
    }
    const queueA = [a];
    const seen = new Set<string>();
    while (queueA.length) {
      const current = queueA.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsOfB.has(current)) return current;
      const commit = this.commitOf(current);
      if (!commit) continue;
      queueA.push(...commit.parents);
    }
    return undefined;
  }

  /** The commits reachable from `tip`, newest first (reverse topological by walk order). */
  commitHistory(tip: string): { sha: string; message: string; parents: string[] }[] {
    const out: { sha: string; message: string; parents: string[] }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    // Index pointer instead of shift(): shift() is O(n) per pop, which makes a
    // long history walk quadratic.
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head];
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (!commit) continue;
      out.push({ sha: oid, message: commit.message, parents: commit.parents });
      queue.push(...commit.parents);
    }
    return out;
  }

  /** A file's blob bytes at a commit's tree, or undefined when the path is absent. */
  fileAtCommit(commitOid: string, path: string): { oid: string; data: Buffer; mode: string } | undefined {
    const commit = this.commitOf(commitOid);
    if (!commit) return undefined;
    const parts = path.split('/').filter((part) => part.length > 0);
    let treeOid = commit.tree;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.treeEntries(treeOid);
      if (!entries) return undefined;
      const entry = entries.find((item) => item.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return undefined;
        const blob = this.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return undefined;
        return { oid: entry.oid, data: blob.data, mode: entry.mode };
      }
      if (entry.mode !== '40000') return undefined;
      treeOid = entry.oid;
    }
    return undefined;
  }

  /** The entries at a directory path in a tree ('' = the root), or undefined when absent. */
  dirAtTree(treeOid: string, dirPath: string): TreeEntry[] | undefined {
    const parts = dirPath.split('/').filter((part) => part.length > 0);
    let tree = treeOid;
    for (const part of parts) {
      const entries = this.treeEntries(tree);
      if (!entries) return undefined;
      const entry = entries.find((item) => item.name === part);
      if (!entry || entry.mode !== '40000') return undefined;
      tree = entry.oid;
    }
    return this.treeEntries(tree);
  }

  /** A tree with `path` set to `blobOid` (creating intermediate trees as needed). */
  setFileInTree(treeOid: string, path: string, blobOid: string): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    if (!parts.length) throw new ForgeError(422, 'Invalid file path');
    const setAt = (current: string | undefined, depth: number): string => {
      const entries = current ? [...(this.treeEntries(current) ?? [])] : [];
      const name = parts[depth];
      const isLeaf = depth === parts.length - 1;
      if (isLeaf) {
        const index = entries.findIndex((entry) => entry.name === name);
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
        return this.putObject('tree', buildTree(entries));
      }
      const existing = entries.find((entry) => entry.name === name);
      const child = existing && existing.mode === '40000' ? existing.oid : undefined;
      const childOid = setAt(child, depth + 1);
      const index = entries.findIndex((entry) => entry.name === name);
      const entry: TreeEntry = { mode: '40000', name, oid: childOid };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      return this.putObject('tree', buildTree(entries));
    };
    return setAt(treeOid, 0);
  }

  /** A tree with `path` removed (pruning directories left empty). */
  removeFileFromTree(treeOid: string, path: string): string | undefined {
    const parts = path.split('/').filter((part) => part.length > 0);
    if (!parts.length) return undefined;
    const removeAt = (current: string, depth: number): string | undefined => {
      const entries = [...(this.treeEntries(current) ?? [])];
      const name = parts[depth];
      const index = entries.findIndex((entry) => entry.name === name);
      if (index < 0) return undefined;
      if (depth === parts.length - 1) {
        entries.splice(index, 1);
        return this.putObject('tree', buildTree(entries));
      }
      const entry = entries[index];
      if (entry.mode !== '40000') return undefined;
      const child = removeAt(entry.oid, depth + 1);
      if (child === undefined) return undefined;
      if ((this.treeEntries(child) ?? []).length === 0) entries.splice(index, 1);
      else entries[index] = { mode: '40000', name, oid: child };
      return this.putObject('tree', buildTree(entries));
    };
    return removeAt(treeOid, 0);
  }

  /** Make a commit on a branch; the branch tip advances to it. */
  createCommitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const tip = this.branchTip(repo, branch);
    const now = this.nextTime();
    const author = `${this.viewerLogin} <${this.viewerLogin}@example.invalid>`;
    const commit = buildCommit({
      tree: treeOid,
      parents: tip ? [tip] : [],
      message,
      author,
      timestamp: now.epoch,
    });
    const oid = this.putObject('commit', commit);
    this.setRef(repo, this.branchRef(branch), oid);
    repo.updatedAt = now.iso;
    return oid;
  }

  /** Every object in a tree: the tree itself, its subtrees, and its blobs. No commits. */
  treeObjects(treeOid: string): Set<string> {
    const out = new Set<string>();
    const walk = (tree: string): void => {
      if (out.has(tree)) return;
      out.add(tree);
      for (const entry of this.treeEntries(tree) ?? []) {
        if (entry.mode === '40000') walk(entry.oid);
        else if (entry.mode !== '160000') out.add(entry.oid);
      }
    };
    walk(treeOid);
    return out;
  }

  /** The objects reachable from a tip that the server does not yet hold — none, by construction. */
  missingFromStore(tip: string): string[] {
    return [];
  }

  // -----------------------------------------------------------------------------------------
  // issues / labels / comments
  // -----------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color?: string): { name: string; color: string } {
    if (!name) throw new ForgeError(422, 'Label name is required');
    const label = { name, color: color ?? 'ededed' };
    repo.labels.set(name, label);
    repo.updatedAt = this.nextTime().iso;
    return label;
  }

  createIssue(repo: Repo, params: CreateIssueParams): Issue {
    if (!params.title) throw new ForgeError(422, 'Title is required');
    for (const label of params.labels ?? []) {
      if (!repo.labels.has(label)) throw new ForgeError(422, `Label '${label}' does not exist`);
    }
    const number = repo.nextNumber++;
    const now = this.nextTime();
    const issue: Issue = {
      number,
      title: params.title,
      body: params.body ?? '',
      state: 'open',
      labels: [...(params.labels ?? [])],
      createdAt: now.iso,
      updatedAt: now.iso,
      createdSeq: now.epoch,
    };
    repo.issues.set(number, issue);
    repo.issueVersion += 1;
    repo.updatedAt = now.iso;
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new ForgeError(404, 'Not Found');
    return issue;
  }

  listIssues(repo: Repo, options: { state?: string; sort?: string; direction?: string }): Issue[] {
    const state = options.state ?? 'open';
    const issues = [...repo.issues.values()].filter(
      (issue) => state === 'all' || issue.state === state,
    );
    const direction = options.direction ?? 'desc';
    issues.sort((a, b) => {
      const byCreated = a.createdSeq - b.createdSeq;
      const byNumber = a.number - b.number;
      const cmp = byCreated !== 0 ? byCreated : byNumber;
      return direction === 'asc' ? cmp : -cmp;
    });
    return issues;
  }

  updateIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = this.getIssue(repo, number);
    if (patch.state === 'closed') issue.state = 'closed';
    else if (patch.state === 'open') issue.state = 'open';
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = this.nextTime().iso;
    repo.issueVersion += 1;
    repo.updatedAt = issue.updatedAt;
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    if (!body) throw new ForgeError(422, 'Body is required');
    const issue = this.getIssue(repo, issueNumber);
    const id = repo.nextCommentId++;
    const now = this.nextTime();
    const comment: IssueComment = { id, issueNumber: issue.number, body, createdAt: now.iso, updatedAt: now.iso };
    repo.comments.set(id, comment);
    repo.updatedAt = now.iso;
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): IssueComment[] {
    this.getIssue(repo, issueNumber);
    return [...repo.comments.values()]
      .filter((comment) => comment.issueNumber === issueNumber)
      .sort((a, b) => a.id - b.id);
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  createPull(repo: Repo, params: CreatePullParams): PullRequest {
    if (!params.title) throw new ForgeError(422, 'Title is required');
    const headTip = this.branchTip(repo, params.head);
    if (!headTip) throw new ForgeError(422, `Head branch '${params.head}' does not exist`);
    const baseTip = this.branchTip(repo, params.base);
    if (!baseTip) throw new ForgeError(422, `Base branch '${params.base}' does not exist`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === params.head && pull.baseRef === params.base) {
        throw new ForgeError(422, 'A pull request already exists for these branches');
      }
    }
    const number = repo.nextNumber++;
    const now = this.nextTime();
    const pull: PullRequest = {
      number,
      title: params.title,
      body: params.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: params.head,
      baseRef: params.base,
      createdAt: now.iso,
      updatedAt: now.iso,
      createdSeq: now.epoch,
    };
    repo.pulls.set(number, pull);
    repo.updatedAt = now.iso;
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest {
    const pull = repo.pulls.get(number);
    if (!pull) throw new ForgeError(404, 'Not Found');
    return pull;
  }

  listPulls(repo: Repo, state: string | undefined): PullRequest[] {
    const want = state ?? 'open';
    return [...repo.pulls.values()]
      .filter((pull) => want === 'all' || pull.state === want)
      .sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  }

  /** The head branch's tip at this moment. */
  pullHeadSha(repo: Repo, pull: PullRequest): string | undefined {
    return this.branchTip(repo, pull.headRef);
  }

  /** The base branch's tip at this moment. */
  pullBaseSha(repo: Repo, pull: PullRequest): string | undefined {
    return this.branchTip(repo, pull.baseRef);
  }

  /** Paths changed between merge-base and head, vs the merge-base tree. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    if (!headTip || !baseTip) return [];
    const base = this.mergeBase(headTip, baseTip) ?? baseTip;
    const baseCommit = this.commitOf(base);
    const headCommit = this.commitOf(headTip);
    if (!baseCommit || !headCommit) return [];
    const before = this.flattenTree(baseCommit.tree);
    const after = this.flattenTree(headCommit.tree);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
      const oldText = oldEntry ? (this.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '') : '';
      const newText = newEntry ? (this.objects.get(newEntry.oid)?.data.toString('utf8') ?? '') : '';
      const { additions, deletions } = diffLineCounts(oldText, newText);
      const status = !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified';
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }

  /**
   * true when merging this pull would conflict: a path changed on both sides of the
   * merge-base to different contents. The check merges branch A first, then branch B
   * which edited the same file differently — that second merge conflicts.
   */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    if (!headTip || !baseTip) return false;
    const base = this.mergeBase(headTip, baseTip);
    if (!base) return false;
    const baseCommit = this.commitOf(base);
    const headCommit = this.commitOf(headTip);
    const baseTipCommit = this.commitOf(baseTip);
    if (!baseCommit || !headCommit || !baseTipCommit) return false;
    const before = this.flattenTree(baseCommit.tree);
    const head = this.flattenTree(headCommit.tree);
    const target = this.flattenTree(baseTipCommit.tree);
    const paths = new Set([...before.keys(), ...head.keys(), ...target.keys()]);
    for (const path of paths) {
      const baseOid = before.get(path)?.oid;
      const headOid = head.get(path)?.oid;
      const targetOid = target.get(path)?.oid;
      const headChanged = headOid !== baseOid;
      const targetChanged = targetOid !== baseOid;
      if (headChanged && targetChanged && headOid !== targetOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request. The base tip advances to one new squash commit. */
  mergePull(repo: Repo, pull: PullRequest, method: string | undefined): { sha: string; merged: boolean; message: string } {
    if (pull.state !== 'open') throw new ForgeError(405, 'Pull request is not open');
    if (this.pullConflicts(repo, pull)) throw new ForgeError(405, 'Merge conflict');
    if (method && method.toLowerCase() !== 'squash') throw new ForgeError(422, `Merge method '${method}' is not supported`);
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    if (!headTip || !baseTip) throw new ForgeError(404, 'Not Found');
    const base = this.mergeBase(headTip, baseTip) ?? baseTip;
    const baseCommit = this.commitOf(base);
    const headCommit = this.commitOf(headTip);
    const baseTipCommit = this.commitOf(baseTip);
    if (!baseCommit || !headCommit || !baseTipCommit) throw new ForgeError(404, 'Not Found');
    const before = this.flattenTree(baseCommit.tree);
    const head = this.flattenTree(headCommit.tree);
    const target = this.flattenTree(baseTipCommit.tree);
    let treeOid = baseTipCommit.tree;
    for (const path of new Set([...before.keys(), ...head.keys()])) {
      const baseOid = before.get(path)?.oid;
      const headOid = head.get(path)?.oid;
      if (headOid === baseOid) continue;
      if (!headOid) {
        const removed = this.removeFileFromTree(treeOid, path);
        if (removed !== undefined) treeOid = removed;
      } else {
        treeOid = this.setFileInTree(treeOid, path, headOid);
      }
    }
    void target;
    const now = this.nextTime();
    const author = `${this.viewerLogin} <${this.viewerLogin}@example.invalid>`;
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: pull.title,
      author,
      timestamp: now.epoch,
    });
    const sha = this.putObject('commit', commit);
    this.setRef(repo, this.branchRef(pull.baseRef), sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now.iso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = now.iso;
    repo.updatedAt = now.iso;
    return { sha, merged: true, message: 'Pull request successfully merged' };
  }

  // -----------------------------------------------------------------------------------------
  // git object graph helpers used by git-http
  // -----------------------------------------------------------------------------------------

  /** Objects reachable from `tip` that the client does not already hold (haves). */
  reachableFrom(tip: string): Set<string> {
    return collectReachable([tip], (oid) => this.objects.get(oid));
  }

  /** A commit's parent list, from the stored object. */
  commitParents(oid: string): string[] {
    return this.commitOf(oid)?.parents ?? [];
  }

  commitTree(oid: string): string | undefined {
    return this.commitOf(oid)?.tree;
  }

  resolveTag(oid: string): { type: GitObjectType; oid: string } | undefined {
    const object = this.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      return this.resolveTag(tag.object) ?? { type: tag.type, oid: tag.object };
    }
    return { type: object.type, oid };
  }
}

/** Line counts of a two-way text diff, by multiset of lines (added minus shared). */
export function diffLineCounts(before: string, after: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (!text) return counts;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const beforeCounts = countLines(before);
  const afterCounts = countLines(after);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of afterCounts) {
    const held = beforeCounts.get(line) ?? 0;
    if (count > held) additions += count - held;
  }
  for (const [line, count] of beforeCounts) {
    const held = afterCounts.get(line) ?? 0;
    if (count > held) deletions += count - held;
  }
  return { additions, deletions };
}
