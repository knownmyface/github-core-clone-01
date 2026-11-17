// rest.ts — the REST v3 handlers. Every reply is JSON with an X-GitHub-Request-Id.
// Shapes are loose (extra fields allowed); bodies carry a string `message` on errors.

import { decodePktLines, isObjectId, ZERO_OID } from './git.ts';
import {
  ForgeError,
  VIEWER,
  type Repo,
  type Store,
} from './store.ts';

/** The pieces a handler needs: path params, query, the parsed JSON body, and the request's origin (for absolute pagination links). */
export interface RestRequest {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly origin: string;
}

export type RestHandler = (store: Store, request: RestRequest) => Promise<RestReply> | RestReply;

export interface RestReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export function reply(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

/** The viewer account, as the API presents it. */
export function accountJson(account: typeof VIEWER): Record<string, unknown> {
  return { login: account.login, id: account.id, email: account.email, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function issueJson(repo: Repo, issue: Repo['issues'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Repo['pulls'] extends Map<number, infer V> ? V : never): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: store.pullHeadSha(repo, pull) ?? null },
    base: { ref: pull.baseRef, sha: store.pullBaseSha(repo, pull) ?? null },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** A repo lookup that 404s (never 403s) when the owner or name does not match. */
export function requireRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.repo(owner, name);
  if (!repo) throw new ForgeError(404, 'Not Found');
  return repo;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ForgeError(400, 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function bodyStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/**
 * The absolute same-origin Link header for pagination (GitHub's format).
 * `origin` is the request's own origin (from its Host header); the query keeps the other params.
 */
export function paginationLink(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | undefined {
  if (!hasNext) return undefined;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${origin}${path}?${next.toString()}>; rel="next"`;
}

export const restRoutes: ReadonlyArray<{ method: string; pattern: RegExp; keys: string[]; handler: RestHandler }> = [
  {
    method: 'GET',
    pattern: /^\/api\/v3\/$/,
    keys: [],
    handler: (_store, _request) => reply(200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/meta$/,
    keys: [],
    handler: () => reply(200, { installed_version: '1.0.0' }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/user$/,
    keys: [],
    handler: () => reply(200, accountJson(VIEWER)),
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/user\/repos$/,
    keys: [],
    handler: (store, request) => {
      const body = bodyObject(request.body);
      const name = bodyString(body, 'name');
      if (!name) throw new ForgeError(422, 'Name is required');
      const repo = store.createRepo(VIEWER.login, {
        name,
        description: bodyString(body, 'description'),
        privateFlag: bodyBoolean(body, 'private'),
      });
      return reply(201, repoJson(repo));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/user\/repos$/,
    keys: [],
    handler: (store, request) => {
      const { page, perPage } = pageOf(request.query);
      const repos = store.listRepos().filter((repo) => repo.owner === VIEWER.login);
      const start = (page - 1) * perPage;
      const slice = repos.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      const link = paginationLink(request.origin, '/api/v3/user/repos', request.query, page, perPage, start + perPage < repos.length);
      if (link) headers.Link = link;
      return reply(200, slice.map((repo) => repoJson(repo)), headers);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      return reply(200, repoJson(repo));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const body = bodyObject(request.body);
      const repo = store.updateRepo(request.params.owner, request.params.repo, {
        description: bodyString(body, 'description'),
        privateFlag: bodyBoolean(body, 'private'),
      });
      return reply(200, repoJson(repo));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      store.deleteRepo(request.params.owner, request.params.repo);
      return reply(204, null);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      return reply(
        200,
        store.branches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.oid } })),
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/,
    keys: ['owner', 'repo', 'branch'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const tip = store.branchTip(repo, request.params.branch);
      if (!tip) throw new ForgeError(404, 'Not Found');
      return reply(200, { name: request.params.branch, commit: { sha: tip } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const sha = request.query.get('sha');
      const tip = sha ? store.branchTip(repo, sha) ?? (isObjectId(sha) ? sha : undefined) : store.branchTip(repo, repo.defaultBranch);
      if (!tip) return reply(200, []);
      const history = store.commitHistory(tip);
      return reply(
        200,
        history.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })),
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const body = bodyObject(request.body);
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha');
      if (!ref || !sha || !isObjectId(sha)) throw new ForgeError(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) throw new ForgeError(422, 'ref must start with refs/');
      if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
      if (!store.hasObject(sha)) throw new ForgeError(422, 'Object does not exist');
      store.setRef(repo, ref, sha);
      return reply(201, { ref, object: { sha } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/([^/]+)$/,
    keys: ['owner', 'repo', 'branch'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const tip = store.branchTip(repo, request.params.branch);
      if (!tip) throw new ForgeError(404, 'Not Found');
      return reply(200, { ref: `refs/heads/${request.params.branch}`, object: { sha: tip } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
    keys: ['owner', 'repo', 'path'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const path = decodeURIComponent(request.params.path);
      const ref = request.query.get('ref');
      const tip = ref ? store.branchTip(repo, ref) ?? (isObjectId(ref) ? ref : undefined) : store.branchTip(repo, repo.defaultBranch);
      if (!tip) throw new ForgeError(404, 'Not Found');
      const commit = store.commitOf(tip);
      if (!commit) throw new ForgeError(404, 'Not Found');
      const file = store.fileAtCommit(tip, path);
      if (file) {
        return reply(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: path.split('/').pop() ?? path,
          path,
          sha: file.oid,
          content: file.data.toString('base64'),
        });
      }
      const entries = store.dirAtTree(commit.tree, path);
      if (!entries) throw new ForgeError(404, 'Not Found');
      return reply(
        200,
        entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path ? `${path}/${entry.name}` : entry.name,
          sha: entry.oid,
        })),
      );
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
    keys: ['owner', 'repo', 'path'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const path = decodeURIComponent(request.params.path);
      const body = bodyObject(request.body);
      const content = bodyString(body, 'content');
      const message = bodyString(body, 'message') ?? `Update ${path}`;
      const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
      const sha = bodyString(body, 'sha');
      if (typeof content !== 'string') throw new ForgeError(422, 'content is required');
      let decoded: Buffer;
      try {
        decoded = Buffer.from(content.replace(/\s+/g, ''), 'base64');
      } catch {
        throw new ForgeError(422, 'content is not valid base64');
      }
      let tip = store.branchTip(repo, branch);
      if (!tip) {
        // Auto-create a missing non-default branch from the default tip.
        const defaultTip = store.branchTip(repo, repo.defaultBranch);
        if (!defaultTip) {
          // Unborn repo: the first commit goes on the default branch.
          const blobOid = store.putObject('blob', decoded);
          const treeOid = store.putObject('tree', Buffer.from('', 'utf8'));
          const newTree = store.setFileInTree(treeOid, path, blobOid);
          const commitOid = store.createCommitOnBranch(repo, repo.defaultBranch, newTree, message);
          return reply(201, {
            content: { sha: blobOid, encoding: 'base64' },
            commit: { sha: commitOid },
          });
        }
        store.setRef(repo, store.branchRef(branch), defaultTip);
        tip = defaultTip;
      }
      const existing = store.fileAtCommit(tip, path);
      if (existing) {
        if (!sha) throw new ForgeError(422, 'sha is required to update an existing file');
        if (sha !== existing.oid) throw new ForgeError(409, 'sha does not match the current file');
      } else if (sha) {
        throw new ForgeError(422, 'sha does not match any existing file');
      }
      const blobOid = store.putObject('blob', decoded);
      const commit = store.commitOf(tip);
      if (!commit) throw new ForgeError(404, 'Not Found');
      const newTree = store.setFileInTree(commit.tree, path, blobOid);
      const status = existing ? 200 : 201;
      const commitOid = store.createCommitOnBranch(repo, branch, newTree, message);
      return reply(status, {
        content: { sha: blobOid, encoding: 'base64' },
        commit: { sha: commitOid },
      });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
    keys: ['owner', 'repo', 'path'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const path = decodeURIComponent(request.params.path);
      const body = bodyObject(request.body);
      const message = bodyString(body, 'message') ?? `Delete ${path}`;
      const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
      const sha = bodyString(body, 'sha');
      const tip = store.branchTip(repo, branch);
      if (!tip) throw new ForgeError(404, 'Not Found');
      const existing = store.fileAtCommit(tip, path);
      if (!existing) throw new ForgeError(404, 'Not Found');
      if (sha && sha !== existing.oid) throw new ForgeError(409, 'sha does not match the current file');
      const commit = store.commitOf(tip);
      if (!commit) throw new ForgeError(404, 'Not Found');
      const newTree = store.removeFileFromTree(commit.tree, path);
      if (newTree === undefined) throw new ForgeError(404, 'Not Found');
      const commitOid = store.createCommitOnBranch(repo, branch, newTree, message);
      return reply(200, { commit: { sha: commitOid } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      return reply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const body = bodyObject(request.body);
      const name = bodyString(body, 'name');
      if (!name) throw new ForgeError(422, 'Name is required');
      const label = store.createLabel(repo, name, bodyString(body, 'color'));
      return reply(201, { name: label.name, color: label.color });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const body = bodyObject(request.body);
      const title = bodyString(body, 'title');
      if (!title) throw new ForgeError(422, 'Title is required');
      const issue = store.createIssue(repo, {
        title,
        body: bodyString(body, 'body'),
        labels: bodyStringArray(body, 'labels'),
      });
      return reply(201, issueJson(repo, issue));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const issues = store.listIssues(repo, {
        state: request.query.get('state') ?? undefined,
        sort: request.query.get('sort') ?? undefined,
        direction: request.query.get('direction') ?? undefined,
      });
      const { page, perPage } = pageOf(request.query);
      const start = (page - 1) * perPage;
      const slice = issues.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      const link = paginationLink(request.origin, `/api/v3/repos/${request.params.owner}/${request.params.repo}/issues`, request.query, page, perPage, start + perPage < issues.length);
      if (link) headers.Link = link;
      return reply(200, slice.map((issue) => issueJson(repo, issue)), headers);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const issue = store.getIssue(repo, Number(request.params.number));
      return reply(200, issueJson(repo, issue));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const body = bodyObject(request.body);
      const issue = store.updateIssue(repo, Number(request.params.number), {
        state: bodyString(body, 'state'),
        title: bodyString(body, 'title'),
        body: bodyString(body, 'body'),
      });
      return reply(200, issueJson(repo, issue));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const body = bodyObject(request.body);
      const commentBody = bodyString(body, 'body');
      if (!commentBody) throw new ForgeError(422, 'Body is required');
      const comment = store.createComment(repo, Number(request.params.number), commentBody);
      return reply(201, { id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const comments = store.listComments(repo, Number(request.params.number));
      return reply(
        200,
        comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt })),
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const body = bodyObject(request.body);
      const title = bodyString(body, 'title');
      const head = bodyString(body, 'head');
      const base = bodyString(body, 'base');
      if (!title || !head || !base) throw new ForgeError(422, 'title, head and base are required');
      const pull = store.createPull(repo, { title, body: bodyString(body, 'body'), head, base });
      return reply(201, pullJson(store, repo, pull));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/,
    keys: ['owner', 'repo'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const pulls = store.listPulls(repo, request.query.get('state') ?? undefined);
      return reply(200, pulls.map((pull) => pullJson(store, repo, pull)));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const pull = store.getPull(repo, Number(request.params.number));
      return reply(200, pullJson(store, repo, pull));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const pull = store.getPull(repo, Number(request.params.number));
      return reply(200, store.pullFiles(repo, pull));
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/,
    keys: ['owner', 'repo', 'number'],
    handler: (store, request) => {
      const repo = requireRepo(store, request.params.owner, request.params.repo);
      const pull = store.getPull(repo, Number(request.params.number));
      const body = request.body === null || request.body === undefined ? {} : bodyObject(request.body);
      const result = store.mergePull(repo, pull, bodyString(body, 'merge_method'));
      return reply(200, { sha: result.sha, merged: result.merged, message: result.message });
    },
  },
];

/** Find the handler for a method + path, or undefined when no route matches. */
export function matchRest(method: string, path: string): { handler: RestHandler; params: Record<string, string> } | undefined {
  for (const route of restRoutes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = match[index + 1];
    });
    return { handler: route.handler, params };
  }
  return undefined;
}

/** Parse a request body as JSON; malformed JSON throws a 400 ForgeError. */
export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ForgeError(400, 'Request body is not valid JSON');
  }
}

export { decodePktLines as _decodePktLines, ZERO_OID as _ZERO_OID };
