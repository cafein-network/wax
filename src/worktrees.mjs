import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withFileLock } from './file-lock.mjs';

export const WORKTREE_STATES = ['active', 'imported', 'discarded', 'removed'];
export const WORKTREE_LIMITS = { entries: 1000, fileBytes: 4 * 1024 * 1024, env: 10 };
export const WORKTREE_ID = /^goal-[a-f0-9]{8}-[1-9][0-9]{0,3}$/;
const ID = WORKTREE_ID;
const GOAL = /^goal-[a-f0-9]{8}$/;
const FEATURE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BRANCH = /^wax\/goal-[a-f0-9]{8}\/[a-z0-9][a-z0-9-]{0,63}-[1-9][0-9]{0,3}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const ENV = /^\.env[A-Za-z0-9._-]{0,60}$/;
export const ENV_NAME = ENV;
export const PORT_ENV = /^(?:[A-Z][A-Z0-9_]{0,58})?PORT$/;
export function portEnv(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  return Object.fromEntries(Object.entries(extra).filter(([name, value]) => PORT_ENV.test(name) && /^[1-9][0-9]{3,4}$/.test(String(value)) && Number(value) >= 1024 && Number(value) <= 65535)
    .map(([name, value]) => [name, String(value)]));
}
export const worktreeNumber = (id) => (ID.test(id ?? '') ? Number(id.split('-').at(-1)) : null);
const HIDDEN = /[\0\p{Cc}\p{Cf}]/u;
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

const validBaseline = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && ['ok', 'tooLarge', 'failed'].includes(value.state) &&
  (value.count === undefined || (Number.isSafeInteger(value.count) && value.count >= 0)) &&
  (value.state === 'ok' ? /^[a-f0-9]{64}$/.test(value.digest ?? '') && Number.isSafeInteger(value.count) : value.digest === undefined) &&
  Object.keys(value).every((key) => ['state', 'count', 'digest'].includes(key)));

const COPY_STATE = ['ok', 'partial', 'none', 'stopped', 'unsupported'];
const COPY_OUTCOME = ['cloned', 'copied', 'missing', 'exists', 'notIgnored', 'tracked', 'blocked', 'unsafeLink', 'tooLarge', 'timeout', 'failed', 'stopped'];
const count = (value) => value === undefined || (Number.isSafeInteger(value) && value >= 0);
const copyPath = (path) => typeof path === 'string' && path.length > 0 && path.length <= 200 && !HIDDEN.test(path) && !/[\\:]/.test(path) && !path.startsWith('/') &&
  path.split('/').length <= 6 && path.split('/').every((part) => part && part !== '.' && part !== '..');
const validCopy = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && COPY_STATE.includes(value.state) &&
  (value.method === null || value.method === undefined || ['clone', 'copy', 'mixed'].includes(value.method)) && count(value.ms) &&
  Array.isArray(value.entries) && value.entries.length <= 20 && Object.keys(value).every((key) => ['state', 'method', 'ms', 'entries'].includes(key)) &&
  value.entries.every((item) => item && typeof item === 'object' && !Array.isArray(item) && copyPath(item.path) && COPY_OUTCOME.includes(item.outcome) &&
    ['files', 'bytes', 'cloned', 'written', 'vanished'].every((key) => count(item[key])) &&
    Object.keys(item).every((key) => ['path', 'outcome', 'files', 'bytes', 'cloned', 'written', 'vanished'].includes(key))));

export const REVIEW_KIND = 'review';
const validPr = (pr) => Boolean(pr && typeof pr === 'object' && !Array.isArray(pr) && Number.isSafeInteger(pr.number) && pr.number >= 1 && pr.number <= 1_000_000_000 &&
  SHA.test(pr.head ?? '') && typeof pr.cross === 'boolean' && typeof pr.url === 'string' && pr.url.length <= 300 && (pr.url === '' || /^https:\/\/[^\s"'<>`]+$/.test(pr.url)) &&
  Object.keys(pr).every((key) => ['number', 'head', 'cross', 'url'].includes(key)));
export const isReview = (entry) => entry?.kind === REVIEW_KIND;
export const reviewRef = (number) => `refs/wax/review/pr-${number}`;

export function validWorktreeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema !== 1 || !Number.isSafeInteger(record.seq)) return false;
  if (!ID.test(record.id ?? '') || !GOAL.test(record.goal ?? '') || !FEATURE.test(record.feature ?? '')) return false;
  if (!record.id.startsWith(`${record.goal}-`)) return false;
  if (record.kind !== undefined || record.pr !== undefined) {
    if (record.kind !== REVIEW_KIND || record.branch !== null || !validPr(record.pr)) return false;
    if ((record.env !== undefined && !(Array.isArray(record.env) && record.env.length === 0)) || (record.setup !== undefined && record.setup !== null)) return false;
    if (record.reason !== undefined) return false;
  } else {
    if (!BRANCH.test(record.branch ?? '') || record.branch !== `wax/${record.goal}/${record.feature}-${record.id.slice(record.goal.length + 1)}`) return false;
  }
  if (typeof record.path !== 'string' || !record.path || record.path.length > 4096 || HIDDEN.test(record.path) || !isAbsolute(record.path)) return false;
  if (!WORKTREE_STATES.includes(record.state) || !time(record.at)) return false;
  if (record.base !== undefined && record.base !== null && !SHA.test(record.base)) return false;
  if (record.port !== undefined && record.port !== null && !(Number.isInteger(record.port) && record.port >= 1024 && record.port <= 65535)) return false;
  if (record.env !== undefined && !(Array.isArray(record.env) && record.env.length <= WORKTREE_LIMITS.env && record.env.every((name) => typeof name === 'string' && ENV.test(name)))) return false;
  if (record.setup !== undefined && record.setup !== null && (typeof record.setup !== 'object' || Array.isArray(record.setup) ||
    (record.setup.hash !== undefined && record.setup.hash !== null && !/^[a-f0-9]{64}$/.test(record.setup.hash)) ||
    (record.setup.outcome !== undefined && record.setup.outcome !== null && !(typeof record.setup.outcome === 'string' && /^[a-z][a-z-]{0,39}$/.test(record.setup.outcome))) ||
    (record.setup.baseline !== undefined && !validBaseline(record.setup.baseline)) || (record.setup.copy !== undefined && !validCopy(record.setup.copy)))) return false;
  if (record.by !== undefined && record.by !== null && !(typeof record.by === 'string' && record.by.length <= 80 && !HIDDEN.test(record.by))) return false;
  if (record.reason !== undefined && !(record.state === 'removed' && record.reason === 'integrated')) return false;
  return true;
}

export async function appendWorktree(root, entry, { now = Date.now() } = {}) {
  const realRoot = await realpath(root);
  const wax = join(realRoot, '.wax'), chat = join(wax, 'chat'), file = join(chat, 'worktrees.jsonl');
  for (const dir of [wax, chat]) {
    await mkdir(dir, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await plainDir(dir))) throw new Error('worktree list folder is not a plain folder');
  }
  return withFileLock(`${file}.lock`, async () => {
    let info = null;
    try { info = await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('worktree list is not a plain file');
    const seq = (await readList(realRoot)).reduce((max, record) => (Number.isSafeInteger(record?.seq) && record.seq > max ? record.seq : max), 0) + 1;
    const { schema, seq: ignored, ...rest } = entry;
    const record = { schema: 1, seq, ...rest, at: rest.at ?? new Date(now).toISOString() };
    if (!validWorktreeRecord(record)) throw new Error('invalid worktree record');
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  });
}

async function plainDir(path) {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

async function readList(root) {
  const wax = join(root, '.wax'), chat = join(wax, 'chat'), file = join(chat, 'worktrees.jsonl');
  if (!(await plainDir(wax)) || !(await plainDir(chat))) return [];
  let info;
  try { info = await lstat(file); } catch { return []; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > WORKTREE_LIMITS.fileBytes) return [];
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {   }
  }
  return records;
}

export async function readWorktrees(root) {
  let realRoot;
  try { realRoot = await realpath(root); } catch { return []; }
  const latest = new Map();
  for (const record of await readList(realRoot)) {
    if (!validWorktreeRecord(record)) continue;
    const seen = latest.get(record.id);
    if (!seen || record.seq > seen.seq) latest.set(record.id, record);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq).slice(-WORKTREE_LIMITS.entries);
}

async function worktreesDir(realRoot) {
  const dir = join(realRoot, '.wax', 'worktrees');
  if (!(await plainDir(join(realRoot, '.wax'))) || !(await plainDir(dir))) return null;
  try { return (await realpath(dir)) === dir ? dir : null; } catch { return null; }
}

export async function checkWorktree(root, entry) {
  if (!validWorktreeRecord(entry) || entry.state !== 'active') return null;
  return checkWorktreePath(root, entry);
}

export async function checkWorktreePath(root, entry) {
  if (!validWorktreeRecord(entry)) return null;
  let realRoot;
  try { realRoot = await realpath(root); } catch { return null; }
  const dir = await worktreesDir(realRoot);
  if (!dir) return null;
  const expected = join(dir, entry.id);
  if (resolve(entry.path) !== expected || entry.path !== expected) return null;
  if (!(await plainDir(expected))) return null;
  try { if ((await realpath(expected)) !== expected) return null; } catch { return null; }
  return { ...entry, path: expected };
}

export async function activeWorktrees(root, { goal = null, feature = null } = {}) {
  const out = [];
  for (const entry of await readWorktrees(root)) {
    if (entry.state !== 'active' || (goal && entry.goal !== goal) || (feature && entry.feature !== feature)) continue;
    const checked = await checkWorktree(root, entry);
    if (checked) out.push(checked);
  }
  return out;
}

export async function worktreeById(root, id, filter = {}) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  return (await activeWorktrees(root, filter)).find((entry) => entry.id === id) ?? null;
}

export async function worktreeAt(root, path, filter = {}) {
  if (typeof path !== 'string' || !path || HIDDEN.test(path) || !isAbsolute(path)) return null;
  let real;
  try { real = await realpath(path); } catch { return null; }
  return (await activeWorktrees(root, filter)).find((entry) => entry.path === real) ?? null;
}

export async function worktreeContaining(root, dir, filter = {}) {
  if (typeof dir !== 'string' || !dir) return null;
  let real;
  try { real = await realpath(dir); } catch { return null; }
  for (const entry of await activeWorktrees(root, filter)) {
    const rel = relative(entry.path, real);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return entry;
  }
  return null;
}

export async function runFolder(root, cwd, filter = {}) {
  let realRoot;
  try { realRoot = await realpath(root); } catch { return null; }
  if (cwd === undefined || cwd === null) return { root: realRoot, cwd: realRoot, worktree: null };
  if (typeof cwd !== 'string' || !cwd) return null;
  let real;
  try { real = await realpath(cwd); } catch { return null; }
  if (real === realRoot) return { root: realRoot, cwd: realRoot, worktree: null };
  const worktree = await worktreeAt(root, real, filter);
  return worktree ? { root: realRoot, cwd: worktree.path, worktree } : null;
}

export const worktreeTag = (entry) => (entry ? isReview(entry) ? { id: entry.id, pr: entry.pr.number } : { id: entry.id, branch: entry.branch } : null);
export const validWorktreeTag = (tag) => Boolean(tag && typeof tag === 'object' && !Array.isArray(tag) && Object.keys(tag).length === 2 && ID.test(tag.id ?? '') &&
  (tag.pr !== undefined ? Number.isSafeInteger(tag.pr) && tag.pr >= 1
    : BRANCH.test(tag.branch ?? '') && tag.branch.endsWith(`-${tag.id.split('-').at(-1)}`) && tag.branch.startsWith(`wax/${tag.id.slice(0, 13)}/`)));
export const sameWorktree = (entry, tag) => Boolean(entry && tag && entry.id === tag.id && (isReview(entry) ? tag.pr === entry.pr.number && tag.branch === undefined : tag.branch === entry.branch));
