// git-http.ts — git smart HTTP: upload-pack protocol v2 + receive-pack v0.
// Advertisement and pack responses are cached per repo state; any ref change clears
// the repo's caches. The wire format here is built from the protocol itself.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  pktLineFlush,
  readPack,
  writePack,
  writePackFromMap,
  type GitObject,
  type GitPacket,
  type GitObjectType,
} from './git.ts';
import { DEFAULT_BRANCH, ForgeError, type Repo, type Store } from './store.ts';

export interface GitHttpContext {
  readonly store: Store;
  /** True when the response content-type must be the advertisement variant. */
  readonly isAdvertisement: boolean;
}

const V2_CAPABILITIES: readonly string[] = [
  'version 2',
  'agent=forge/1.0.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'server-option',
  'object-format=sha1',
];

const UPLOAD_V0_CAPABILITIES: readonly string[] = [
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'no-progress',
  'include-tag',
  'multi_ack_detailed',
  'agent=forge/1.0.0',
];

const RECEIVE_V0_CAPABILITIES: readonly string[] = [
  'report-status',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'agent=forge/1.0.0',
];

/** A ref line in an advertisement: full ref name + the oid it points at. */
export interface AdvertisedRef {
  readonly name: string;
  readonly oid: string;
  /** Only for refs/heads/*: the oid of the commit it peels to (tags only). */
  readonly peeled?: string;
}

export interface RefFilter {
  readonly prefix?: string;
}

/** Every ref the server advertises for a repo: heads + tags, in git order. */
export function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The HEAD line's target: the default branch, always present even in an empty repo. */
export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch || DEFAULT_BRANCH}`;
}

/** A v0 advertisement: `# service=...` preamble, ref lines, flush. Cached per repo. */
export function buildV0Advertisement(
  service: 'git-upload-pack' | 'git-receive-pack',
  repo: Repo,
  store: Store,
): Buffer {
  const refs = advertisedRefs(repo);
  const capabilities = service === 'git-upload-pack' ? UPLOAD_V0_CAPABILITIES : RECEIVE_V0_CAPABILITIES;
  const lines: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  if (!refs.length) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${capabilities.join(' ')}\n`));
  } else {
    const first = refs[0];
    lines.push(encodePktLine(`${first.oid} ${first.name}\0${capabilities.join(' ')}\n`));
    for (const ref of refs.slice(1)) lines.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
    for (const ref of refs) {
      const peeled = peelRef(store, ref);
      if (peeled) lines.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(pktLineFlush());
  return Buffer.concat(lines);
}

/** A v2 advertisement: the capability block, then flush. No refs — it never changes per repo. */
export function buildV2Advertisement(): Buffer {
  const parts: Buffer[] = [];
  for (const capability of V2_CAPABILITIES) parts.push(encodePktLine(`${capability}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/**
 * The ls-refs answer for a v2 request: one line per matching ref.
 * `HEAD` is a symref line (the target is the default branch) and, per the protocol,
 * it is NOT included when a ref-prefix filter is given — 'HEAD' does not start with 'refs/'.
 * Every `ref-prefix` line the client sent is honored: a ref matches when it starts
 * with any of them.
 */
export function buildLsRefsResponse(
  store: Store,
  repo: Repo,
  options: { prefixes?: string[]; peel?: boolean; symrefs?: boolean; unborn?: boolean },
): Buffer {
  const refs = advertisedRefs(repo);
  const lines: Buffer[] = [];
  const includeHead = !(options.prefixes?.length ?? 0);
  if (includeHead) {
    const target = headTarget(repo);
    const tip = repo.refs.get(target);
    if (tip) {
      lines.push(encodePktLine(`${tip} HEAD${options.symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (options.unborn) {
      lines.push(encodePktLine(`unborn HEAD${options.symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (options.prefixes?.length && !options.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === headTarget(repo) && options.symrefs) line += ` symref-target:${ref.name}`;
    if (options.peel) {
      const peeled = peelRef(store, ref);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(encodePktLine(`${line}\n`));
  }
  lines.push(pktLineFlush());
  return Buffer.concat(lines);
}

/**
 * The commit an annotated tag peels to, or undefined when the ref does not point at
 * a tag object. Tag chains are followed to their final non-tag target.
 */
export function peelRef(store: Store, ref: AdvertisedRef): string | undefined {
  const object = store.object(ref.oid);
  if (!object || object.type !== 'tag') return undefined;
  let current: string;
  try {
    current = parseTag(object.data).object;
  } catch {
    return undefined;
  }
  const seen = new Set<string>([ref.oid]);
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const next = store.object(current);
    if (!next) return undefined;
    if (next.type !== 'tag') return current;
    try {
      current = parseTag(next.data).object;
    } catch {
      return undefined;
    }
  }
}

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly deepen?: number;
  readonly filter?: string;
  readonly thinPack: boolean;
  readonly noProgress: boolean;
  readonly ofsDelta: boolean;
  readonly includeTag: boolean;
  readonly waitForDone: boolean;
}

function parseFetchRequest(packets: GitPacket[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  let filter: string | undefined;
  let thinPack = false;
  let noProgress = false;
  let ofsDelta = false;
  let includeTag = false;
  let waitForDone = false;
  let seenCommand = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line === 'command=fetch') {
      seenCommand = true;
      continue;
    }
    if (!seenCommand) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
    else if (line.startsWith('depth ')) deepen = Number(line.slice(6).trim());
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
    else if (line === 'thin-pack') thinPack = true;
    else if (line === 'no-progress') noProgress = true;
    else if (line === 'ofs-delta') ofsDelta = true;
    else if (line === 'include-tag') includeTag = true;
    else if (line === 'wait-for-done') waitForDone = true;
  }
  if (!Number.isFinite(deepen)) deepen = undefined;
  return { wants, haves, shallow, deepen, filter, thinPack, noProgress, ofsDelta, includeTag, waitForDone };
}

/**
 * The fetch plan: which commits to include (BFS from wants, distance-limited by depth),
 * which objects to send, and the shallow/unshallow boundary sets.
 */
export interface FetchPlan {
  readonly includedCommits: string[];
  readonly objectsToSend: Map<string, GitObject>;
  readonly shallowBoundaries: string[];
  readonly unshallow: string[];
  readonly acks: string[];
  readonly wantedRefs: Array<{ oid: string; name: string }>;
}

/** Compute the fetch plan for a request against a repo. */
export function planFetch(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  const depth = request.deepen;
  const wantedRefs: Array<{ oid: string; name: string }> = [];
  for (const [name, oid] of repo.refs) {
    for (const want of request.wants) if (oid === want) wantedRefs.push({ oid, name });
  }
  // BFS from wants, tracking distance from the nearest want.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of request.wants) {
    if (!store.hasObject(want)) continue;
    if (!distance.has(want)) {
      distance.set(want, 0);
      queue.push(want);
    }
  }
  const includedCommits: string[] = [];
  const shallowBoundaries: string[] = [];
  while (queue.length) {
    const oid = queue.shift()!;
    const dist = distance.get(oid)!;
    const object = store.object(oid);
    if (!object || object.type !== 'commit') continue;
    includedCommits.push(oid);
    const atBoundary = depth !== undefined && dist === depth - 1;
    if (atBoundary) {
      shallowBoundaries.push(oid);
      continue;
    }
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  // Objects to send: for each included commit, the commit itself plus its tree's
  // objects — never its parents (a shallow fetch stops at the boundary). A non-commit
  // want (an annotated tag object) is sent whole with everything it points at — it
  // is not reachable from any commit, so the commit walk alone would never include it.
  // Finally, anything the client already holds is removed — but a `have` that is also
  // a shallow boundary holds only itself and its tree, not its history: a shallow
  // clone's tip does not carry its parents, so a deepen must still deliver them.
  const shallowSet = new Set(request.shallow);
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const have of request.haves) {
    if (store.hasObject(have)) heldQueue.push(have);
  }
  const heldSeen = new Set<string>();
  while (heldQueue.length) {
    const oid = heldQueue.shift()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = store.object(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const treeOid of store.treeObjects(commit.tree)) held.add(treeOid);
      if (shallowSet.has(oid)) continue;
      heldQueue.push(...commit.parents);
    } else if (object.type === 'tag') {
      try {
        heldQueue.push(parseTag(object.data).object);
      } catch {
        // A malformed tag holds nothing beyond itself.
      }
    } else if (object.type === 'tree') {
      for (const treeOid of store.treeObjects(oid)) held.add(treeOid);
    }
  }
  const toSend = new Set<string>();
  for (const commit of includedCommits) {
    const commitView = store.commitOf(commit);
    if (!commitView) continue;
    toSend.add(commit);
    for (const oid of store.treeObjects(commitView.tree)) toSend.add(oid);
  }
  for (const want of request.wants) {
    const object = store.object(want);
    if (!object || object.type === 'commit') continue;
    for (const oid of store.reachableFrom(want)) toSend.add(oid);
  }
  for (const oid of held) toSend.delete(oid);
  const objectsToSend = new Map<string, GitObject>();
  for (const oid of toSend) {
    const object = store.object(oid);
    if (object) objectsToSend.set(oid, object);
  }
  // Unshallow: old boundaries that are now included but are no longer boundaries.
  const unshallow: string[] = [];
  for (const old of request.shallow) {
    if (includedCommits.includes(old) && !shallowBoundaries.includes(old)) unshallow.push(old);
  }
  const acks = request.haves.filter((have) => store.hasObject(have));
  return { includedCommits, objectsToSend, shallowBoundaries, unshallow, acks, wantedRefs };
}

/** Wrap pack bytes in a sideband frame: band 1 data, split into ≤64 KiB chunks. */
export function sidebandPack(pack: Buffer): Buffer {
  const frames: Buffer[] = [];
  // One band byte rides with each chunk, so the chunk is 65515 bytes: the pkt-line
  // payload (band + chunk) stays within the 65516-byte limit.
  const CHUNK = 65515;
  if (pack.length === 0) {
    frames.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  } else {
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      frames.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  return Buffer.concat(frames);
}

/**
 * The v2 fetch response: acknowledgments, shallow-info, wanted-refs, packfile —
 * each section opens with its literal header line, and a flush separates sections,
 * so the client's section tracker advances.
 */
export function buildFetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineFlush());
  // shallow-info
  parts.push(encodePktLine('shallow-info\n'));
  for (const oid of plan.shallowBoundaries) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(pktLineFlush());
  // wanted-refs
  parts.push(encodePktLine('wanted-refs\n'));
  for (const ref of plan.wantedRefs) parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
  parts.push(pktLineFlush());
  // packfile
  parts.push(encodePktLine('packfile\n'));
  const pack = writePackFromMap(plan.objectsToSend);
  parts.push(sidebandPack(pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse the command list at the start of a receive-pack POST. */
function parsePushCommands(packets: GitPacket[]): { commands: PushCommand[]; packStart: number } {
  const commands: PushCommand[] = [];
  let packStart = -1;
  for (let i = 0; i < packets.length; i += 1) {
    const packet = packets[i];
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = line.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]) && isObjectId(parts[1]) && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      continue;
    }
    // Anything else ends the command list; the pack follows in `rest`.
    packStart = i;
    break;
  }
  return { commands, packStart };
}

export interface PushResult {
  readonly ok: boolean;
  readonly results: Array<{ ref: string; ok: boolean; reason?: string }>;
}

/**
 * Apply a receive-pack: store the pack's objects, then validate each ref command.
 * A refused ref never moves, but its objects are still stored.
 */
export function applyPush(store: Store, repo: Repo, commands: PushCommand[], packObjects: Map<string, GitObject>): PushResult {
  // `packObjects` is keyed by oid (readPack computed it), so store each object under
  // its known oid instead of re-hashing it.
  for (const [oid, object] of packObjects) store.putObjectEntryWithOid(oid, object);
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  let allOk = true;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        allOk = false;
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        allOk = false;
      } else {
        store.deleteRef(repo, command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (!store.hasObject(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      allOk = false;
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        allOk = false;
      } else {
        store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    // Update: must be a fast-forward from the stated old tip.
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      allOk = false;
      continue;
    }
    if (!store.isDescendant(command.newOid, command.oldOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      allOk = false;
      continue;
    }
    store.setRef(repo, command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  return { ok: allOk, results };
}

/** The push report, in sideband frames: `unpack ok`, then ok/ng per command, in order. */
export function buildPushReport(result: PushResult): Buffer {
  const lines: string[] = ['unpack ok\n'];
  for (const entry of result.results) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason ?? 'failed'}\n`);
  }
  const payload = Buffer.concat([Buffer.from([1]), Buffer.from(lines.join(''), 'utf8')]);
  return Buffer.concat([encodePktLine(payload), pktLineFlush()]);
}

/** Handle a receive-pack POST body: parse commands + pack, apply, return the report. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodePktLines(body);
  const { commands } = parsePushCommands(packets);
  let packObjects = new Map<string, GitObject>();
  if (rest.length >= 32) {
    try {
      packObjects = readPack(rest).objects;
    } catch {
      // A pack that cannot be read still gets an unpack-failure report, not a crash.
      const payload = Buffer.concat([Buffer.from([1]), Buffer.from('unpack failed\n', 'utf8')]);
      return Buffer.concat([encodePktLine(payload), pktLineFlush()]);
    }
  }
  const result = applyPush(store, repo, commands, packObjects);
  return buildPushReport(result);
}

/** The response caches handleUploadPack consults; keys carry the repo's refVersion. */
export interface GitResponseCaches {
  readonly lsRefs: Map<string, Buffer>;
  readonly fetch: Map<string, Buffer>;
}

/** Handle an upload-pack POST body: ls-refs or fetch (v2), or a v0 fetch request. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, caches?: GitResponseCaches): Buffer {
  const { packets } = decodePktLines(body);
  let command: string | undefined;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line.startsWith('command=')) {
      command = line.slice('command='.length).trim();
      continue;
    }
    if (command) args.push(line);
  }
  if (command === 'ls-refs') {
    const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const unborn = args.includes('unborn');
    const cacheKey = `${repo.fullName}@${repo.refVersion}|ls-refs|${prefixes.join(',')}|${peel}|${symrefs}|${unborn}`;
    const cached = caches?.lsRefs.get(cacheKey);
    if (cached) return cached;
    const result = buildLsRefsResponse(store, repo, { prefixes, peel, symrefs, unborn });
    caches?.lsRefs.set(cacheKey, result);
    return result;
  }
  if (command === 'fetch') {
    const request = parseFetchRequest(packets);
    const cacheKey = [
      `${repo.fullName}@${repo.refVersion}`,
      'fetch',
      [...request.wants].sort().join(','),
      [...request.haves].sort().join(','),
      [...request.shallow].sort().join(','),
      String(request.deepen ?? ''),
    ].join('|');
    const cached = caches?.fetch.get(cacheKey);
    if (cached) return cached;
    const plan = planFetch(store, repo, request);
    const result = buildFetchResponse(plan);
    caches?.fetch.set(cacheKey, result);
    return result;
  }
  // v0: the body is a want list; answer with a v2-style fetch of everything wanted.
  const wants: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
  }
  const request: FetchRequest = {
    wants,
    haves: [],
    shallow: [],
    thinPack: false,
    noProgress: false,
    ofsDelta: false,
    includeTag: false,
    waitForDone: false,
  };
  const plan = planFetch(store, repo, request);
  return buildFetchResponse(plan);
}

/** A repo lookup that throws a 404 ForgeError for a missing repo (never 403). */
export function requireRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.repo(owner, name);
  if (!repo) throw new ForgeError(404, 'Not Found');
  return repo;
}
