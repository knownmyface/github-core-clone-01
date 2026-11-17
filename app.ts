// app.ts — the HTTP server: routing, auth, request ids, and the response caches.
// One process, stdlib only. main.ts owns the entry <-> env lifecycle (bind port 0,
// register, poll /done); this file builds the server it serves.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ForgeError, Store } from './store.ts';
import {
  buildLsRefsResponse,
  buildV0Advertisement,
  buildV2Advertisement,
  handleReceivePack,
  handleUploadPack,
  requireRepo as requireGitRepo,
} from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';
import { issueJson, matchRest, parseJsonBody } from './rest.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** A monotonically increasing request counter; ids are `req-<n>`, never a wall clock. */
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** The bearer token the entry enforces, from the trial environment. */
export function shopToken(): string | undefined {
  return process.env.MAKEFUN_SHOP_TOKEN;
}

function isAuthorized(request: IncomingMessage): boolean {
  const token = shopToken();
  if (!token) return true;
  const header = request.headers.authorization;
  return header === `Bearer ${token}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(payload),
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendBuffer(response: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { message });
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** The per-repo git response caches. Keys carry the repo's refVersion, so any ref
 * change invalidates them without an explicit clear. */
interface GitCaches {
  readonly v0Advertisements: Map<string, { version: number; upload: Buffer; receive: Buffer }>;
  readonly lsRefs: Map<string, Buffer>;
  readonly fetch: Map<string, Buffer>;
}

export function createGitCaches(): GitCaches {
  return { v0Advertisements: new Map(), lsRefs: new Map(), fetch: new Map() };
}

/** The fast path for GET /api/v3/repos/{owner}/{repo}/issues/{number}: a pre-serialized
 * JSON string, cached per (repo, number, issueVersion). */
interface IssueCache {
  readonly entries: Map<string, { version: number; json: string }>;
}

export function createIssueCache(): IssueCache {
  return { entries: new Map() };
}

const V2_ADVERTISEMENT = buildV2Advertisement();

interface RouteContext {
  readonly store: Store;
  readonly gitCaches: GitCaches;
  readonly issueCache: IssueCache;
}

function gitPathMatch(path: string): { owner: string; repo: string; suffix: string } | undefined {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2], suffix: match[3] ?? '' };
}

async function handleRequest(context: RouteContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  try {
    // Health: no auth, always available.
    if (method === 'GET' && path === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    // Git smart HTTP.
    const gitPath = gitPathMatch(path);
    if (gitPath) {
      if (!isAuthorized(request)) {
        sendError(response, 401, 'Requires authentication');
        return;
      }
      const repo = requireGitRepo(context.store, gitPath.owner, gitPath.repo);
      const cacheKey = `${repo.fullName}@${repo.refVersion}`;
      if (method === 'GET' && gitPath.suffix === '/info/refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendError(response, 400, 'service is required');
          return;
        }
        const wantsV2 = request.headers['git-protocol'] === 'version=2';
        if (service === 'git-upload-pack' && wantsV2) {
          sendBuffer(response, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
          return;
        }
        const cached = context.gitCaches.v0Advertisements.get(cacheKey);
        if (cached) {
          sendBuffer(response, 200, service === 'git-upload-pack' ? cached.upload : cached.receive, `application/x-${service}-advertisement`);
          return;
        }
        const upload = buildV0Advertisement('git-upload-pack', repo, context.store);
        const receive = buildV0Advertisement('git-receive-pack', repo, context.store);
        context.gitCaches.v0Advertisements.set(cacheKey, { version: repo.refVersion, upload, receive });
        sendBuffer(response, 200, service === 'git-upload-pack' ? upload : receive, `application/x-${service}-advertisement`);
        return;
      }
      if (method === 'POST' && gitPath.suffix === '/git-upload-pack') {
        const body = await readBody(request);
        const result = handleUploadPack(context.store, repo, body, context.gitCaches);
        sendBuffer(response, 200, result, 'application/x-git-upload-pack-result');
        return;
      }
      if (method === 'POST' && gitPath.suffix === '/git-receive-pack') {
        const body = await readBody(request);
        const result = handleReceivePack(context.store, repo, body);
        sendBuffer(response, 200, result, 'application/x-git-receive-pack-result');
        return;
      }
      sendError(response, 404, 'Not Found');
      return;
    }

    // GraphQL.
    if (method === 'POST' && path === '/api/graphql') {
      if (!isAuthorized(request)) {
        sendError(response, 401, 'Requires authentication');
        return;
      }
      const body = await readBody(request);
      let parsed: unknown;
      try {
        parsed = parseJsonBody(body);
      } catch (error) {
        if (error instanceof ForgeError) {
          sendError(response, error.status, error.message);
          return;
        }
        throw error;
      }
      const result = executeGraphQL(context.store, parsed);
      sendJson(response, 200, result);
      return;
    }

    // MCP.
    if (method === 'POST' && path === '/mcp') {
      if (!isAuthorized(request)) {
        sendError(response, 401, 'Requires authentication');
        return;
      }
      const body = await readBody(request);
      const result = handleMcpBody(context.store, body);
      if (result.body === null) {
        response.writeHead(result.status, { 'X-GitHub-Request-Id': nextRequestId() });
        response.end();
        return;
      }
      sendJson(response, result.status, result.body);
      return;
    }

    // REST v3.
    if (path === '/api/v3/' || path.startsWith('/api/v3/')) {
      const needsAuth = !(method === 'GET' && (path === '/api/v3/' || path === '/api/v3/meta'));
      if (needsAuth && !isAuthorized(request)) {
        sendError(response, 401, 'Requires authentication');
        return;
      }
      // Fast path: GET one issue — a cached pre-serialized JSON string.
      const issueMatch = method === 'GET' && /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
      if (issueMatch) {
        const repo = context.store.repo(issueMatch[1], issueMatch[2]);
        if (!repo) {
          sendError(response, 404, 'Not Found');
          return;
        }
        const number = Number(issueMatch[3]);
        const issue = repo.issues.get(number);
        if (!issue) {
          sendError(response, 404, 'Not Found');
          return;
        }
        const key = `${repo.fullName}#${number}`;
        const cached = context.issueCache.entries.get(key);
        if (cached && cached.version === repo.issueVersion) {
          const payload = cached.json;
          response.writeHead(200, {
            'Content-Type': JSON_CONTENT_TYPE,
            'Content-Length': Buffer.byteLength(payload),
            'X-GitHub-Request-Id': nextRequestId(),
          });
          response.end(payload);
          return;
        }
        const json = JSON.stringify(issueJson(repo, issue));
        context.issueCache.entries.set(key, { version: repo.issueVersion, json });
        response.writeHead(200, {
          'Content-Type': JSON_CONTENT_TYPE,
          'Content-Length': Buffer.byteLength(json),
          'X-GitHub-Request-Id': nextRequestId(),
        });
        response.end(json);
        return;
      }
      const matched = matchRest(method, path);
      if (!matched) {
        sendError(response, 404, 'Not Found');
        return;
      }
      const rawBody = await readBody(request);
      let parsedBody: unknown = null;
      if (rawBody.length > 0) {
        try {
          parsedBody = parseJsonBody(rawBody);
        } catch (error) {
          if (error instanceof ForgeError) {
            sendError(response, error.status, error.message);
            return;
          }
          throw error;
        }
      }
      const result = await matched.handler(context.store, {
        params: matched.params,
        query: url.searchParams,
        body: parsedBody,
        origin: `http://${request.headers.host ?? '127.0.0.1'}`,
      });
      if (result.status === 204) {
        response.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId(), ...result.headers });
        response.end();
        return;
      }
      sendJson(response, result.status, result.body, result.headers);
      return;
    }

    sendError(response, 404, 'Not Found');
  } catch (error) {
    if (error instanceof ForgeError) {
      sendError(response, error.status, error.message);
      return;
    }
    // Never crash on a malformed request: answer 400 and stay healthy.
    if (error instanceof Error && /pkt-line|pack|delta|zlib|tree|commit|tag/.test(error.message)) {
      sendError(response, 400, error.message);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('unhandled request error', error);
    sendError(response, 500, 'Internal Server Error');
  }
}

export function createApp(): ReturnType<typeof createServer> {
  const context: RouteContext = {
    store: new Store(),
    gitCaches: createGitCaches(),
    issueCache: createIssueCache(),
  };
  const server = createServer((request, response) => {
    void handleRequest(context, request, response);
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
