import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitEnv } from './freshness.mjs';
import { renameWithRetry } from './file-lock.mjs';
import { chatDir } from './chat/paths.mjs';
import { WORKTREE_ID } from './worktrees.mjs';

export const BASELINE_LIMITS = { paths: 100_000, fileBytes: 32 * 1024 * 1024, timeout: 120_000 };
export const BASELINE_UNSAFE = new Set(['tooLarge', 'failed', 'missing', 'mismatch']);
const SHA = /^[a-f0-9]{40,64}$/;
const HIDDEN = /[\0\p{Cc}]/u;
const own = (path) => path !== '.wax' && !path.startsWith('.wax/');

function git(cwd, args, { input = '', timeout = BASELINE_LIMITS.timeout } = {}) {
  return new Promise((done, reject) => {
    const child = execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: gitEnv() },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : done(String(stdout))));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function blobIds(dir, paths, { timeout = BASELINE_LIMITS.timeout } = {}) {
  const files = [];
  for (const path of paths) {
    if (!path || HIDDEN.test(path)) continue;
    try { const info = await lstat(join(dir, path)); if (info.isFile() && !info.isSymbolicLink()) files.push(path); } catch {   }
  }
  const out = new Map();
  if (!files.length) return out;
  const ids = (await git(dir, ['hash-object', '--stdin-paths'], { input: `${files.join('\n')}\n`, timeout })).split(/\r?\n/).filter(Boolean);
  if (ids.length !== files.length) throw new Error('hash-object returned a different number of ids');
  files.forEach((path, index) => { if (SHA.test(ids[index])) out.set(path, ids[index]); });
  return out;
}

export async function untrackedState(dir, { limits = BASELINE_LIMITS } = {}) {
  try {
    const listed = (await git(dir, ['ls-files', '-z', '--others', '--exclude-standard'], { timeout: limits.timeout })).split('\0').filter((path) => path && !path.endsWith('/') && own(path));
    if (listed.length > limits.paths) return { state: 'tooLarge', count: listed.length };
    const ids = await blobIds(dir, listed, { timeout: limits.timeout });
    return { state: 'ok', paths: Object.fromEntries([...ids.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) };
  } catch { return { state: 'failed' }; }
}

const fileOf = async (root, id, create = false) => {
  if (!WORKTREE_ID.test(id ?? '')) return null;
  const dir = await chatDir(root, 'worktree-baselines', { create });
  return dir && join(dir, `${id}.json`);
};

async function readJson(file, limit) {
  let info;
  try { info = await lstat(file); } catch { return { missing: true }; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) return { bad: true };
  const bytes = await readFile(file);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; } catch { return { bad: true, bytes }; }
}

async function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await renameWithRetry(temp, file); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}

export async function startBaseline(root, id, { reuse = false, limits = BASELINE_LIMITS, dir } = {}) {
  const file = await fileOf(root, id, true);
  if (!file) return { problem: 'failed' };
  if (reuse) {
    const kept = await readJson(file, limits.fileBytes).catch(() => ({ bad: true }));
    if (kept.value?.schema === 1 && kept.value.worktree === id && kept.value.state === 'pending' && kept.value.before && typeof kept.value.before === 'object') return { before: kept.value.before };
  }
  const state = await untrackedState(dir, { limits });
  if (state.state !== 'ok') { await rm(file, { force: true }).catch(() => {}); return { problem: state.state, ...(state.count ? { count: state.count } : {}) }; }
  const text = JSON.stringify({ schema: 1, worktree: id, state: 'pending', before: state.paths });
  if (Buffer.byteLength(text) > limits.fileBytes) { await rm(file, { force: true }).catch(() => {}); return { problem: 'tooLarge', count: Object.keys(state.paths).length }; }
  try { await writeAtomic(file, text); } catch { return { before: state.paths }; }
  return { before: state.paths };
}

export async function finishBaseline(root, id, start, { hash = null, limits = BASELINE_LIMITS, dir, now = Date.now() } = {}) {
  const file = await fileOf(root, id, true);
  if (!file) return { state: 'failed' };
  if (start?.problem) { await rm(file, { force: true }).catch(() => {}); return { state: start.problem, ...(start.count ? { count: start.count } : {}) }; }
  const after = await untrackedState(dir, { limits });
  if (after.state !== 'ok') { await rm(file, { force: true }).catch(() => {}); return { state: after.state, ...(after.count ? { count: after.count } : {}) }; }
  const before = start?.before ?? {};
  const paths = Object.fromEntries(Object.entries(after.paths).filter(([path, blob]) => before[path] !== blob));
  const count = Object.keys(paths).length;
  if (count > limits.paths) { await rm(file, { force: true }).catch(() => {}); return { state: 'tooLarge', count }; }
  const text = JSON.stringify({ schema: 1, worktree: id, state: 'ok', hash, paths, at: new Date(now).toISOString() });
  if (Buffer.byteLength(text) > limits.fileBytes) { await rm(file, { force: true }).catch(() => {}); return { state: 'tooLarge', count }; }
  try { await writeAtomic(file, text); } catch { return { state: 'failed' }; }
  return { state: 'ok', count, digest: createHash('sha256').update(text).digest('hex') };
}

export async function readBaseline(root, entry, { limits = BASELINE_LIMITS } = {}) {
  const recorded = entry?.setup?.baseline;
  if (!recorded || typeof recorded !== 'object') return { state: 'none' };
  if (recorded.state !== 'ok') return { state: BASELINE_UNSAFE.has(recorded.state) ? recorded.state : 'failed', ...(Number.isInteger(recorded.count) ? { count: recorded.count } : {}) };
  const file = await fileOf(root, entry.id);
  if (!file) return { state: 'missing' };
  const read = await readJson(file, limits.fileBytes).catch(() => ({ bad: true }));
  if (read.missing) return { state: 'missing' };
  if (read.bad || createHash('sha256').update(read.bytes).digest('hex') !== recorded.digest) return { state: 'mismatch' };
  const value = read.value;
  if (value?.schema !== 1 || value.worktree !== entry.id || value.state !== 'ok' || !value.paths || typeof value.paths !== 'object' || Array.isArray(value.paths)) return { state: 'mismatch' };
  const paths = Object.fromEntries(Object.entries(value.paths).filter(([path, blob]) => typeof path === 'string' && own(path) && !HIDDEN.test(path) && typeof blob === 'string' && SHA.test(blob)));
  return { state: 'ok', paths, count: Object.keys(paths).length };
}
