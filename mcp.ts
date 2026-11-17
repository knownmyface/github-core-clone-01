// mcp.ts — MCP over JSON-RPC 2.0 Streamable HTTP at /mcp.
// Revision 2026-07-28 via server/discover, with the legacy initialize handshake as a
// fallback. Tools act on the same store as REST, so ids never change across reads.

import { ForgeError, VIEWER, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
  readonly handler: (store: Store, args: Record<string, unknown>) => unknown;
}

function stringArg(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = args[name];
  if (typeof value === 'string' && value.length > 0) return value;
  if (required) throw new ForgeError(-32602, `Missing required argument: ${name}`);
  return undefined;
}

function numberArg(args: Record<string, unknown>, name: string, required: boolean): number | undefined {
  const value = args[name];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  if (required) throw new ForgeError(-32602, `Missing required argument: ${name}`);
  return undefined;
}

function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
}

function stringListArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** The argument mapping: normalized synonyms land on the canonical property names. */
function mapArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const synonyms: Record<string, string> = {
    owner_login: 'owner',
    repo_name: 'repo',
    repository: 'repo',
    repository_name: 'repo',
    issue_number: 'pull_number',
    number: 'pull_number',
  };
  for (const [from, to] of Object.entries(synonyms)) {
    if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
  }
  return out;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    handler: (store, args) => {
      const repo = store.createRepo(VIEWER.login, {
        name: stringArg(args, 'name', true)!,
        description: stringArg(args, 'description', false),
        privateFlag: booleanArg(args, 'private'),
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      return repoJson(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', description: 'Labels to attach to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      const issue = store.createIssue(repo, {
        title: stringArg(args, 'title', true)!,
        body: stringArg(args, 'body', false),
        labels: stringListArg(args, 'labels'),
      });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      const issues = store.listIssues(repo, { state: stringArg(args, 'state', false) });
      return { issues: issues.map((issue) => issueJson(repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      const pull = store.createPull(repo, {
        title: stringArg(args, 'title', true)!,
        head: stringArg(args, 'head', true)!,
        base: stringArg(args, 'base', true)!,
        body: stringArg(args, 'body', false),
      });
      return pullJson(store, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const pullNumber = numberArg(args, 'pull_number', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      const pull = store.getPull(repo, pullNumber);
      const result = store.mergePull(repo, pull, 'squash');
      return { sha: result.sha, merged: result.merged, message: result.message };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const number = numberArg(args, 'issue_number', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      return issueJson(repo, store.getIssue(repo, number));
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (store, args) => {
      const owner = stringArg(args, 'owner', true)!;
      const repoName = stringArg(args, 'repo', true)!;
      const repo = store.repo(owner, repoName);
      if (!repo) throw new ForgeError(404, 'Not Found');
      const pulls = store.listPulls(repo, stringArg(args, 'state', false));
      return { pull_requests: pulls.map((pull) => pullJson(store, repo, pull)) };
    },
  },
];

export function listTools(): Array<{ name: string; description: string; inputSchema: ToolDefinition['inputSchema'] }> {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

interface JsonRpcResult {
  readonly status: number;
  readonly body: unknown;
}

function rpcResult(id: unknown, result: unknown): JsonRpcResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): JsonRpcResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/**
 * Handle one parsed JSON-RPC request. Returns null for a notification (no id),
 * which the caller answers with 202 and an empty body.
 */
export function handleMcpRequest(store: Store, request: JsonRpcRequest): JsonRpcResult | null {
  const id = request.id;
  const isNotification = id === undefined || id === null;
  const method = typeof request.method === 'string' ? request.method : undefined;
  if (!method) {
    if (isNotification) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [MCP_REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_REVISION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: listTools() });
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : undefined;
    const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) return rpcError(id, -32602, 'Missing tool name');
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = mapArgs(rawArgs);
    try {
      const result = tool.handler(store, args);
      return rpcResult(id, toolResult(result));
    } catch (error) {
      if (error instanceof ForgeError) {
        if (error.status === -32602) return rpcError(id, -32602, error.message);
        return rpcResult(id, { content: [{ type: 'text', text: error.message }], isError: true });
      }
      return rpcResult(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool call failed' }], isError: true });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** The MCP entry point: parse the raw body, answer JSON-RPC (or a parse error). */
export function handleMcpBody(store: Store, raw: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') {
        results.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      const result = handleMcpRequest(store, item as JsonRpcRequest);
      if (result) results.push(result.body);
    }
    return { status: 200, body: results };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const result = handleMcpRequest(store, parsed as JsonRpcRequest);
  if (!result) return { status: 202, body: null };
  return result;
}
