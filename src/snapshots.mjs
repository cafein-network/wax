import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, constants, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { t } from '../web/messages-catalog.mjs';
import { TREE_LIMITS, gitEnv } from './freshness.mjs';
import { excludedPath, realTarget } from './goal-allow.mjs';
import { PREVIEW_LIMITS, hunks, lineDiff } from './approval-preview.mjs';
import { chatDir } from './chat/paths.mjs';
import { withLock } from './chat/lock.mjs';
import { appendRecord, makeId, readRecords } from './chat/store.mjs';
import { renameWithRetry } from './file-lock.mjs';
import { WaxError } from './workflow.mjs';
import { WORKTREE_ID, worktreeById } from './worktrees.mjs';

export const SNAPSHOT_LIMITS = { files: TREE_LIMITS.files, bytes: TREE_LIMITS.bytes, timeout: TREE_LIMITS.timeout, keepDays: 30, storeBytes: 1024 ** 3,
  listed: 200, gcTimeout: 120_000, lockMs: 30_000, outputLines: 400, lineChars: 400 };
export const SNAPSHOT_POINTS = ['before', 'after', 'pre-restore', 'post-restore', 'pre-import', 'post-import'];
export const RUN_ID = /^(?:pw|rs|im)-[a-f0-9]{8}$/;
const runKind = (run) => (run.startsWith('rs-') ? 'restore' : run.startsWith('im-') ? 'import' : 'worker');
const POINTS = { worker: ['before', 'after'], restore: ['pre-restore', 'post-restore'], import: ['pre-import', 'post-import'] };
const SHA = /^[a-f0-9]{40,64}$/;
const HIDDEN = /[\0\p{Cc}]/u;
const DAY = 24 * 60 * 60 * 1000;
const fail = (id, status = 400, ...values) => new WaxError(t(id, ...values), status);
const own = (path) => path !== '.wax' && !path.startsWith('.wax/');
const list = (text) => text.split('\0').filter(Boolean);
const time = (iso) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? ms : 0; };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const rawId = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
class Unknown extends Error { constructor(reason) { super(reason); this.reason = reason; } }


function git(cwd, args, { input = '', env = gitEnv(), timeout = SNAPSHOT_LIMITS.timeout, binary = false, maxBuffer = 1_000_000 } = {}) {
  return new Promise((done, reject) => {
    const child = execFile('git', ['--no-pager', ...args], { cwd, encoding: binary ? 'buffer' : 'utf8', timeout, maxBuffer, windowsHide: true, env },
      (error, stdout) => (error ? reject(error) : done(stdout)));
    child.stdin.on('error', () => {   });
    child.stdin.end(input);
  });
}
const project = (root, args, options) => git(root, ['-c', 'core.fsmonitor=false', ...args], options);
const repoPath = (dir) => join(dir, 'objects.git');
const store = (dir, args, options = {}) => git(dir, ['-c', 'core.fsmonitor=false', ...args], { ...options, env: gitEnv({ GIT_DIR: repoPath(dir) }) });

async function storeReady(dir) {
  try { const info = await lstat(join(repoPath(dir), 'HEAD')); return info.isFile(); } catch { return false; }
}
async function ensureStore(dir) {
  const repo = repoPath(dir);
  let info = null;
  try { info = await lstat(repo); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Unknown('store-failed');
  if (info && await storeReady(dir)) return;
  if (!info) await mkdir(repo, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  await store(dir, ['init', '--bare', '-q', '--template=', '--object-format=sha1']);
  await store(dir, ['config', 'gc.auto', '0']);
  await store(dir, ['config', 'core.logAllRefUpdates', 'false']);
}

function parseBatch(buffer) {
  const out = new Map();
  let at = 0;
  while (at < buffer.length) {
    const end = buffer.indexOf(10, at);
    if (end < 0) break;
    const [id, type, size] = buffer.subarray(at, end).toString('utf8').split(' ');
    at = end + 1;
    if (type === 'missing' || size === undefined) continue;
    const length = Number(size);
    out.set(id, buffer.subarray(at, at + length));
    at += length + 1;
  }
  return out;
}


async function workTree(root) {
  let top, prefix;
  try { [top, prefix = ''] = (await project(root, ['rev-parse', '--show-toplevel', '--show-prefix'])).split(/\r?\n/); } catch { throw new Unknown('not-git'); }
  if (!top) throw new Unknown('not-git');
  let head = null;
  try { head = (await project(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null; } catch {   }
  if (head !== null && !SHA.test(head)) throw new Unknown('git-failed');
  let tracked, untracked;
  try {
    tracked = list(await project(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no', '--', '.']))
      .filter((entry) => /^.. ./.test(entry)).map((entry) => entry.slice(3)).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    untracked = list(await project(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  } catch (error) { throw new Unknown(error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too-large' : 'git-failed'); }
  const paths = [...new Set([...tracked, ...untracked])].filter(own).sort();
  if (paths.length > SNAPSHOT_LIMITS.files || paths.some((path) => HIDDEN.test(path))) throw new Unknown('too-large');
  const files = {}, present = [], links = [];
  let bytes = 0;
  for (const path of paths) {
    let info;
    try { info = await lstat(join(root, path)); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { files[path] = null; continue; } throw new Unknown('git-failed'); }
    if (info.isDirectory()) continue;
    if (!info.isFile()) { links.push(path); continue; }
    if ((bytes += info.size) > SNAPSHOT_LIMITS.bytes) throw new Unknown('too-large');
    present.push(path);
  }
  return { head, files, present, links };
}

async function capture(root, dir) {
  const tree = await workTree(root);
  if (tree.present.length) {
    try {
      await ensureStore(dir);
      const ids = (await store(dir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: `${tree.present.map((path) => join(root, path)).join('\n')}\n` })).split(/\r?\n/).filter(Boolean);
      if (ids.length !== tree.present.length || !ids.every((id) => SHA.test(id))) throw new Error('hash');
      tree.present.forEach((path, index) => { tree.files[path] = ids[index]; });
    } catch (error) { throw error instanceof Unknown ? error : new Unknown(error.killed ? 'too-large' : 'store-failed'); }
  }
  return { head: tree.head, files: tree.files, ...(tree.links.length ? { links: tree.links } : {}) };
}

const snapshotsDir = (root, create = false) => chatDir(root, 'snapshots', { create });
async function runFolder(root, worktree) {
  if (worktree === undefined || worktree === null) return root;
  const entry = await worktreeById(root, worktree);
  if (!entry) throw new Unknown('worktree-missing');
  return entry.path;
}
const lockOf = (dir) => join(dir, 'snapshots.lock');

export async function takeSnapshot(root, meta, { now = Date.now } = {}) {
  try {
    if (!RUN_ID.test(meta?.run ?? '') || !SNAPSHOT_POINTS.includes(meta.point) || (meta.worktree !== undefined && meta.worktree !== null && !WORKTREE_ID.test(meta.worktree))) return null;
    const dir = await snapshotsDir(root, true);
    return await withLock(lockOf(dir), async () => {
      let state;
      try { state = { state: 'ok', reason: null, ...(await capture(await runFolder(root, meta.worktree), dir)) }; }
      catch (error) { state = { state: 'unknown', reason: error instanceof Unknown ? error.reason : 'git-failed', head: null }; }
      const fields = Object.fromEntries(['goal', 'worker', 'feature', 'phase', 'iteration', 'tool', 'by', 'target'].map((key) => [key, meta[key] ?? null]));
      return appendRecord(join(dir, 'runs.jsonl'), (seq) => ({ schema: 1, record: 'snapshot', id: makeId('snap', seq), seq, run: meta.run, point: meta.point, ...fields,
        ...(meta.worktree ? { worktree: meta.worktree } : {}), ...state, at: new Date(now()).toISOString() }));
    }, { timeoutMs: SNAPSHOT_LIMITS.lockMs });
  } catch { return null; }
}


function validRecord(record) {
  if (!record || record.schema !== 1 || typeof record.id !== 'string' || !RUN_ID.test(record.run ?? '') || !SNAPSHOT_POINTS.includes(record.point) || !Number.isFinite(Date.parse(record.at))) return false;
  if (record.worktree !== undefined && !WORKTREE_ID.test(record.worktree ?? '')) return false;
  if (record.state === 'unknown') return true;
  if (record.state !== 'ok' || (record.head !== null && !SHA.test(record.head ?? '')) || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) return false;
  const entries = Object.entries(record.files);
  if (entries.length > SNAPSHOT_LIMITS.files || !entries.every(([path, id]) => path && path.length <= 4096 && !HIDDEN.test(path) && own(path) && (id === null || (typeof id === 'string' && SHA.test(id))))) return false;
  return record.links === undefined || (Array.isArray(record.links) && record.links.length <= SNAPSHOT_LIMITS.files && record.links.every((path) => typeof path === 'string' && path && !HIDDEN.test(path)));
}

export async function readSnapshots(root) {
  const dir = await snapshotsDir(root);
  if (!dir) return [];
  return (await readRecords(join(dir, 'runs.jsonl'))).records.filter(validRecord).sort((a, b) => a.seq - b.seq);
}

export function groupRuns(records) {
  const runs = new Map();
  for (const record of records) {
    let item = runs.get(record.run);
    if (!item) {
      item = { run: record.run, kind: runKind(record.run), goal: record.goal ?? null, worker: record.worker ?? null, feature: record.feature ?? null,
        phase: record.phase ?? null, iteration: record.iteration ?? null, tool: record.tool ?? null, by: record.by ?? null, target: record.target ?? null, worktree: record.worktree ?? null, before: null, after: null };
      runs.set(record.run, item);
    }
    const [start, end] = POINTS[item.kind];
    if (record.point === start) item.before ??= record;
    else if (record.point === end) item.after ??= record;
  }
  for (const item of runs.values()) {
    const unknown = [item.before, item.after].find((snap) => snap?.state === 'unknown');
    item.state = !item.before ? 'missing' : unknown ? 'unknown' : !item.after ? 'running' : 'ok';
    item.reason = unknown?.reason ?? null;
  }
  return [...runs.values()];
}

export async function listRuns(root, { goal = null } = {}) {
  const runs = groupRuns(await readSnapshots(root));
  return goal ? runs.filter((item) => item.goal === goal) : runs;
}
async function findRun(root, run) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) throw fail('errors.snapshots.notFound', 404, String(run).slice(0, 20));
  const runs = await listRuns(root);
  const item = runs.find((entry) => entry.run === run);
  if (!item) throw fail('errors.snapshots.notFound', 404, run);
  return { item, runs };
}

export function concurrentRuns(item, runs, now = Date.now()) {
  if (!item.before) return 0;
  const span = (entry) => [time(entry.before?.at), entry.after ? time(entry.after.at) : now];
  const [from, to] = span(item);
  return runs.filter((other) => other.run !== item.run && other.kind === 'worker' && other.before && (other.worktree ?? null) === (item.worktree ?? null) && (([a, b]) => a <= to && b >= from)(span(other))).length;
}


function createReader(root, dir) {
  const blobs = new Map(), bytes = new Map(), clean = new Map(), commits = new Set();
  let emptyTree = null;
  return {
    async commits(heads) {
      const asking = [...new Set(heads.filter((head) => head && !commits.has(head)))];
      if (!asking.length) return;
      const lines = (await project(root, ['cat-file', '--batch-check=%(objecttype)'], { input: `${asking.map((head) => `${head}^{commit}`).join('\n')}\n` })).split(/\r?\n/);
      asking.forEach((head, index) => { if (lines[index] !== 'commit') throw new Unknown('head-missing'); commits.add(head); });
    },
    async heads(pairs) {
      await this.commits(pairs.map(([head]) => head));
      const plain = (path) => !path.startsWith('/') && !path.split('/').includes('..');
      for (const [head, path] of pairs) if (head && !plain(path)) blobs.set(`${head}:${path}`, null);
      const asked = [...new Set(pairs.filter(([head]) => head).map(([head, path]) => `${head}:${path}`))].filter((key) => !blobs.has(key));
      if (asked.length) {
        const lines = (await project(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${asked.map((key) => { const at = key.indexOf(':'); return `${key.slice(0, at)}:./${key.slice(at + 1)}`; }).join('\n')}\n`, maxBuffer: 4_000_000 })).split(/\r?\n/);
        asked.forEach((key, index) => { const [id, type, size] = (lines[index] ?? '').split(' '); blobs.set(key, SHA.test(id ?? '') && type === 'blob' ? { id, size: Number(size) } : null); });
      }
      return (head, path) => (head ? blobs.get(`${head}:${path}`) ?? null : null);
    },
    async content(ref) {
      const key = ref.wax ? `w:${ref.wax}` : `h:${ref.head}:${ref.path}`;
      if (bytes.has(key)) return bytes.get(key);
      let value;
      if (ref.wax) {
        const out = parseBatch(await store(dir, ['cat-file', '--batch'], { input: `${ref.wax}\n`, binary: true, maxBuffer: SNAPSHOT_LIMITS.bytes + 4096 }));
        value = out.get(ref.wax) ?? null;
      } else if (ref.size > SNAPSHOT_LIMITS.bytes) value = 'tooLarge';
      else value = await project(root, ['cat-file', '--filters', `${ref.head}:./${ref.path}`], { binary: true, maxBuffer: SNAPSHOT_LIMITS.bytes + 4096 });
      bytes.set(key, value);
      return value;
    },
    async cleanIds(paths) {
      const asked = paths.filter((path) => !clean.has(path));
      if (asked.length) {
        let top, prefix = '';
        [top, prefix = ''] = (await project(root, ['rev-parse', '--show-toplevel', '--show-prefix'])).split(/\r?\n/);
        const ids = (await project(top, ['hash-object', '--stdin-paths'], { input: `${asked.map((path) => prefix + path).join('\n')}\n` })).split(/\r?\n/).filter(Boolean);
        asked.forEach((path, index) => clean.set(path, SHA.test(ids[index] ?? '') ? ids[index] : null));
      }
      return (path) => clean.get(path) ?? null;
    },
    async emptyTree() { return (emptyTree ??= (await project(root, ['hash-object', '-t', 'tree', '--stdin'])).trim()); },
  };
}

function refOf(snap, path) {
  if (snap.links?.includes(path)) return { link: true };
  if (Object.hasOwn(snap.files, path)) return snap.files[path] === null ? { absent: true } : { wax: snap.files[path] };
  return snap.head ? { head: snap.head, path } : { absent: true };
}
function resolveRef(ref, lookup) {
  if (!ref.head) return ref;
  const blob = lookup(ref.head, ref.path);
  return blob ? { ...ref, blob: blob.id, size: blob.size } : { absent: true };
}
async function sameRef(a, b, reader) {
  if (a.absent || b.absent) return Boolean(a.absent && b.absent);
  if (a.link || b.link) return Boolean(a.link && b.link);
  if (a.wax && b.wax) return a.wax === b.wax;
  if (a.blob && b.blob) return a.blob === b.blob;
  const [x, y] = await Promise.all([reader.content(a), reader.content(b)]);
  return Buffer.isBuffer(x) && Buffer.isBuffer(y) && x.equals(y);
}

async function readNow(realRoot, path) {
  const target = join(realRoot, ...path.split('/'));
  let info;
  try { info = await lstat(target); } catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { absent: true } : { unreadable: true }; }
  if (info.isSymbolicLink()) return { link: true };
  if (!info.isFile()) return { notFile: true };
  if (info.size > SNAPSHOT_LIMITS.bytes) return { tooLarge: true };
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) return { unreadable: true };
    const bytes = await handle.readFile();
    return { bytes, id: rawId(bytes), mode: info.mode & 0o777 };
  } catch { return { unreadable: true }; }
  finally { await handle?.close().catch(() => {}); }
}


async function changesBetween(root, before, after, reader) {
  await reader.commits([before.head, after.head]);
  let committed = [];
  if (before.head !== after.head) {
    const from = before.head ?? await reader.emptyTree(), to = after.head ?? await reader.emptyTree();
    committed = list(await project(root, ['diff-tree', '-r', '--name-only', '--relative', '--no-renames', '-z', from, to, '--'], { maxBuffer: 8_000_000 }));
  }
  const all = [...new Set([...Object.keys(before.files), ...Object.keys(after.files), ...(before.links ?? []), ...(after.links ?? []), ...committed])].filter(own).sort();
  const paths = all.slice(0, SNAPSHOT_LIMITS.listed);
  const lookup = await reader.heads(paths.flatMap((path) => [[before.head, path], [after.head, path]]));
  const out = [];
  for (const path of paths) {
    const a = resolveRef(refOf(before, path), lookup), b = resolveRef(refOf(after, path), lookup);
    if (!(await sameRef(a, b, reader))) out.push({ path, before: a, after: b });
  }
  return { changes: out, more: all.length - paths.length };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
async function textOf(ref, reader) {
  if (ref.absent) return { text: '' };
  if (ref.link) return { none: 'link' };
  if (ref.size !== undefined && ref.size > PREVIEW_LIMITS.fileBytes) return { none: 'tooLarge' };
  const bytes = await reader.content(ref);
  if (!Buffer.isBuffer(bytes)) return { none: 'tooLarge' };
  if (bytes.length > PREVIEW_LIMITS.fileBytes) return { none: 'tooLarge' };
  if (bytes.includes(0)) return { none: 'binary' };
  try { return { text: utf8.decode(bytes) }; } catch { return { none: 'binary' }; }
}
const splitLines = (text) => { const lines = text === '' ? [] : text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
const stateOf = (change) => (change.before.absent ? 'new' : change.after.absent ? 'delete' : 'modify');

async function lineCounts(change, reader, { full = false } = {}) {
  const [a, b] = await Promise.all([textOf(change.before, reader), textOf(change.after, reader)]);
  const none = a.none ?? b.none;
  if (none) return { added: null, removed: null, none };
  const x = splitLines(a.text), y = splitLines(b.text);
  if (x.length > PREVIEW_LIMITS.lines || y.length > PREVIEW_LIMITS.lines) return { added: null, removed: null, none: 'tooLarge' };
  const result = hunks(lineDiff(x, y));
  if (a.text && b.text && a.text.endsWith('\n') !== b.text.endsWith('\n')) result.lines.push(['@', b.text.endsWith('\n') ? '\\ (newline added at end of file)' : '\\ No newline at end of file']);
  return full ? result : { added: result.added, removed: result.removed };
}

const unreadable = (run) => (error) => { throw error instanceof Unknown ? fail('errors.snapshots.unknown', 409, run) : error; };

export async function runSummary(root, item, { runs = [], now = Date.now(), files = 50 } = {}) {
  const base = { run: item.run, kind: item.kind, goal: item.goal, worker: item.worker, feature: item.feature, phase: item.phase, iteration: item.iteration, tool: item.tool,
    by: item.by, target: item.target, worktree: item.worktree ?? null, at: item.before?.at ?? null, endedAt: item.after?.at ?? null, state: item.state, reason: item.reason, concurrent: concurrentRuns(item, runs, now) };
  if (item.state !== 'ok') return { ...base, files: [], count: 0, more: 0, commits: 0 };
  try {
    const folder = await runFolder(root, item.worktree);
    const dir = await snapshotsDir(root);
    const reader = createReader(folder, dir);
    const { changes, more } = await changesBetween(folder, item.before, item.after, reader);
    const shown = [];
    for (const change of changes.slice(0, files)) shown.push({ path: change.path, state: stateOf(change), ...(await lineCounts(change, reader)) });
    return { ...base, files: shown, count: changes.length + more, more: Math.max(0, changes.length - shown.length) + more, commits: await commitCount(folder, item.before.head, item.after.head) };
  } catch (error) { return { ...base, state: 'unknown', reason: error instanceof Unknown ? error.reason : 'git-failed', files: [], count: 0, more: 0, commits: 0 }; }
}
async function commitCount(root, from, to) {
  if (!to || from === to) return 0;
  try { return Number((await project(root, ['rev-list', '--count', from ? `${from}..${to}` : to])).trim()) || 0; } catch { return 0; }
}

export async function runFileDiff(root, run, path) {
  const { item } = await findRun(root, run);
  if (item.state !== 'ok') throw fail('errors.snapshots.unknown', 409, run);
  if (typeof path !== 'string' || !path || HIDDEN.test(path)) throw fail('errors.snapshots.pathNotInRun', 404);
  const folder = await runFolder(root, item.worktree).catch(unreadable(run));
  const dir = await snapshotsDir(root);
  const reader = createReader(folder, dir);
  const { changes } = await changesBetween(folder, item.before, item.after, reader).catch(unreadable(run));
  const change = changes.find((entry) => entry.path === path);
  if (!change) throw fail('errors.snapshots.pathNotInRun', 404);
  const result = await lineCounts(change, reader, { full: true });
  if (result.none) return { run, path, state: stateOf(change), none: result.none };
  const take = result.lines.slice(0, SNAPSHOT_LIMITS.outputLines).map(([type, text]) => {
    const line = String(text).replace(/\r$/, '');
    return [type, line.length > SNAPSHOT_LIMITS.lineChars ? `${line.slice(0, SNAPSHOT_LIMITS.lineChars)}…` : line];
  });
  return { run, path, state: stateOf(change), added: result.added, removed: result.removed, lines: take, omitted: result.lines.length - take.length };
}


const inside = (parent, child) => child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
export async function restoreTarget(realRoot, path) {
  if (typeof path !== 'string' || !path || HIDDEN.test(path) || path.length > 4096 || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').some((part) => part === '..' || part === '.' || part === '')) return { reason: 'outside' };
  const target = resolve(realRoot, ...path.split('/'));
  if (!inside(realRoot, target)) return { reason: 'outside' };
  const rel = relative(realRoot, target);
  if (excludedPath(rel) || rel.split(sep)[0] === '.wax' || rel.split(sep).some((part) => part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.env'))) return { reason: 'sensitive' };
  const real = await realTarget(target);
  if (!real || real !== target) return { reason: 'symlink' };
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return { reason: 'symlink' };
    if (!info.isFile()) return { reason: 'notFile' };
  } catch (error) { if (error.code !== 'ENOENT') return { reason: 'unreadable' }; }
  return { target };
}

async function nowMatches(ref, current, path, reader) {
  if (current.link || current.notFile || current.tooLarge || current.unreadable) return false;
  if (ref.absent) return Boolean(current.absent);
  if (current.absent || ref.link) return false;
  if (ref.wax) return current.id === ref.wax;
  return (await reader.cleanIds([path]))(path) === ref.blob;
}
const nowKey = (current) => current.id ?? (current.absent ? 'absent' : current.link ? 'link' : current.notFile ? 'notFile' : current.tooLarge ? 'tooLarge' : 'unreadable');

async function planRestore(root, item) {
  if (item.state !== 'ok') throw fail('errors.snapshots.unknown', 409, item.run);
  const folder = await runFolder(root, item.worktree).catch(unreadable(item.run));
  const realRoot = await realpath(folder);
  const dir = await snapshotsDir(root);
  const reader = createReader(folder, dir);
  const { changes, more } = await changesBetween(folder, item.before, item.after, reader).catch(unreadable(item.run));
  if (more) throw fail('errors.snapshots.tooMany', 409, SNAPSHOT_LIMITS.listed);
  const restore = [], skip = [];
  for (const change of changes) {
    const place = await restoreTarget(realRoot, change.path);
    if (place.reason) { skip.push({ path: change.path, reason: place.reason }); continue; }
    if (change.before.link || change.after.link) { skip.push({ path: change.path, reason: 'symlink' }); continue; }
    const current = await readNow(realRoot, change.path);
    if (current.link) { skip.push({ path: change.path, reason: 'symlink', now: nowKey(current) }); continue; }
    if (current.notFile) { skip.push({ path: change.path, reason: 'notFile', now: nowKey(current) }); continue; }
    if (current.tooLarge || current.unreadable) { skip.push({ path: change.path, reason: current.tooLarge ? 'tooLarge' : 'unreadable', now: nowKey(current) }); continue; }
    if (!(await nowMatches(change.after, current, change.path, reader))) { skip.push({ path: change.path, reason: 'changed', now: nowKey(current) }); continue; }
    if (!change.before.absent && change.before.size !== undefined && change.before.size > SNAPSHOT_LIMITS.bytes) { skip.push({ path: change.path, reason: 'tooLarge', now: nowKey(current) }); continue; }
    restore.push({ path: change.path, action: change.before.absent ? 'delete' : 'write', change, now: nowKey(current), target: place.target, mode: current.mode });
  }
  return { realRoot, folder, reader, restore, skip };
}

export async function previewRestore(root, run, { now = Date.now() } = {}) {
  const { item, runs } = await findRun(root, run);
  const plan = await planRestore(root, item);
  const restore = [];
  for (const entry of plan.restore) {
    const counts = await lineCounts({ before: entry.change.after, after: entry.change.before }, plan.reader);
    restore.push({ path: entry.path, action: entry.action, ...counts });
  }
  const fingerprint = hash({ run, before: item.before.id, after: item.after.id, restore: plan.restore.map((entry) => [entry.path, entry.action, entry.now]), skip: plan.skip.map((entry) => [entry.path, entry.reason, entry.now ?? null]) });
  return { run, kind: item.kind, goal: item.goal, feature: item.feature, phase: item.phase, target: item.target, at: item.before.at, endedAt: item.after.at,
    restore, skip: plan.skip.map(({ path, reason }) => ({ path, reason })), commits: await commitCount(plan.folder, item.before.head, item.after.head), worktree: item.worktree ?? null,
    concurrent: concurrentRuns(item, runs, now), fingerprint };
}

async function writeRestored(entry, bytes) {
  const parent = dirname(entry.target);
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)) !== parent) throw new Error('parent moved');
  const temp = join(parent, `.${basename(entry.target)}.wax-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: entry.mode ?? 0o644 });
    if (entry.mode !== undefined) await chmod(temp, entry.mode).catch(() => {});
    await renameWithRetry(temp, entry.target);
  } finally { await rm(temp, { force: true }); }
}

export async function restoreSnapshot(root, run, { by, fingerprint, now = Date.now } = {}) {
  const preview = await previewRestore(root, run, { now: now() });
  if (typeof fingerprint !== 'string' || fingerprint !== preview.fingerprint) throw fail('errors.snapshots.changed', 409);
  if (!preview.restore.length) throw fail('errors.snapshots.nothing', 409);
  const { item } = await findRun(root, run);
  const restoreRun = `rs-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const meta = { run: restoreRun, goal: item.goal, feature: item.feature, phase: item.phase, iteration: item.iteration, by, target: run, ...(item.worktree ? { worktree: item.worktree } : {}) };
  const pre = await takeSnapshot(root, { ...meta, point: 'pre-restore' }, { now });
  if (!pre || pre.state !== 'ok') throw fail('errors.snapshots.preRestore', 409);
  const plan = await planRestore(root, item);
  const restored = [], skipped = plan.skip.map(({ path, reason }) => ({ path, reason })), failed = [];
  for (const entry of plan.restore) {
    try {
      const place = await restoreTarget(plan.realRoot, entry.path);
      const current = await readNow(plan.realRoot, entry.path);
      if (place.reason || !(await nowMatches(entry.change.after, current, entry.path, plan.reader))) { skipped.push({ path: entry.path, reason: place.reason ?? 'changed' }); continue; }
      if (entry.action === 'delete') { if (!current.absent) await rm(place.target); }
      else {
        const bytes = await plan.reader.content(entry.change.before);
        if (!Buffer.isBuffer(bytes)) { skipped.push({ path: entry.path, reason: 'tooLarge' }); continue; }
        await writeRestored({ ...entry, target: place.target, mode: current.mode }, bytes);
      }
      restored.push(entry.path);
    } catch { failed.push(entry.path); }
  }
  const post = await takeSnapshot(root, { ...meta, point: 'post-restore' }, { now });
  const dir = await snapshotsDir(root, true);
  const record = await appendRecord(join(dir, 'restores.jsonl'), (seq) => ({ schema: 1, record: 'restore', id: makeId('rst', seq), seq, run, restoreRun, goal: item.goal, by,
    restored, skipped, failed, preRestore: pre.id, postRestore: post?.id ?? null, at: new Date(now()).toISOString() }));
  return { run, restoreRun, goal: item.goal, feature: item.feature, phase: item.phase, iteration: item.iteration, restored, skipped, failed, preRestore: pre.id, postRestore: post?.id ?? null, id: record.id };
}

export async function readRestores(root) {
  const dir = await snapshotsDir(root);
  if (!dir) return [];
  return (await readRecords(join(dir, 'restores.jsonl'))).records.filter((record) => record?.record === 'restore' && RUN_ID.test(record.run ?? '')).sort((a, b) => a.seq - b.seq);
}


async function dirSize(path) {
  let total = 0;
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) { try { total += (await lstat(full)).size; } catch {   } }
  }
  return total;
}
const idsOf = (records) => new Set(records.flatMap((record) => (record.state === 'ok' ? Object.values(record.files).filter(Boolean) : [])));

export async function pruneSnapshots(root, { goals = new Map(), unsure = new Set(), now = Date.now(), keepMs = SNAPSHOT_LIMITS.keepDays * DAY, maxBytes = SNAPSHOT_LIMITS.storeBytes } = {}) {
  const dir = await snapshotsDir(root);
  if (!dir) return { dropped: 0, gc: false };
  return withLock(lockOf(dir), async () => {
    const file = join(dir, 'runs.jsonl');
    const { records } = await readRecords(file);
    if (!records.length) return { dropped: 0, gc: false };
    const last = new Map(), firstOfRun = new Map();
    for (const record of records) {
      last.set(record.goal, Math.max(last.get(record.goal) ?? 0, time(record.at)));
      if (!firstOfRun.has(record.run)) firstOfRun.set(record.run, time(record.at));
    }
    const endedAt = (goal) => {
      if (unsure.has(goal)) return null;
      const entry = goals.get(goal);
      if (!entry) return last.get(goal) ?? 0;
      return ['done', 'stopped'].includes(entry.state) ? (time(entry.updatedAt) || last.get(goal) || 0) : null;
    };
    const drop = new Set(records.filter((record) => { const end = endedAt(record.goal); return end !== null && now - end > keepMs; }).map((record) => record.run));
    if (await dirSize(repoPath(dir)) > maxBytes && await storeReady(dir)) {
      const ids = [...idsOf(records)];
      const sizes = new Map();
      if (ids.length) {
        const lines = (await store(dir, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${ids.join('\n')}\n`, maxBuffer: 8_000_000 })).split(/\r?\n/);
        for (const line of lines) { const [id, size] = line.split(' '); if (SHA.test(id ?? '')) sizes.set(id, Number(size) || 0); }
      }
      const estimate = () => [...idsOf(records.filter((record) => !drop.has(record.run)))].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
      const candidates = [...new Set(records.filter((record) => endedAt(record.goal) !== null && !drop.has(record.run)).map((record) => record.run))]
        .sort((a, b) => firstOfRun.get(a) - firstOfRun.get(b));
      for (const run of candidates) { if (estimate() <= maxBytes) break; drop.add(run); }
    }
    if (!drop.size) return { dropped: 0, gc: false };
    const kept = records.filter((record) => !drop.has(record.run));
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, kept.map((record) => `${JSON.stringify(record)}\n`).join(''), { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
    let gc = false;
    if (await storeReady(dir)) {
      const keep = [...idsOf(kept.filter(validRecord))];
      const tree = (await store(dir, ['mktree', '--missing'], { input: keep.map((id) => `100644 blob ${id}\t${id}\n`).join('') })).trim();
      await store(dir, ['update-ref', 'refs/wax/keep', tree]);
      await store(dir, ['gc', '--prune=now', '-q'], { timeout: SNAPSHOT_LIMITS.gcTimeout });
      gc = true;
    }
    return { dropped: drop.size, gc };
  }, { timeoutMs: SNAPSHOT_LIMITS.lockMs });
}
