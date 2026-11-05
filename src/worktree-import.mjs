import { t } from '../web/messages-catalog.mjs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative } from 'node:path';
import { WaxError } from './workflow.mjs';
import { gitEnv } from './freshness.mjs';
import { renameWithRetry } from './file-lock.mjs';
import { SNAPSHOT_LIMITS, restoreTarget, takeSnapshot } from './snapshots.mjs';
import { appendWorktree, checkWorktreePath, isReview, readWorktrees } from './worktrees.mjs';
import { deleteReviewRef } from './worktree-review.mjs';
import { pickFreePort } from './worktree-make.mjs';
import { BASELINE_UNSAFE, blobIds, readBaseline } from './worktree-baseline.mjs';
import { copiedPaths } from './worktree-copy.mjs';
import { scratchTree } from './git-read.mjs';

export const IMPORT_LIMITS = { files: SNAPSHOT_LIMITS.files, bytes: SNAPSHOT_LIMITS.bytes, timeout: 60_000, shown: 200, dirty: 20 };
export const MERGE_TREE_VERSION = [2, 38];
const BASELINE_ERRORS = { missing: 'errors.worktreeImport.baseline.missing', mismatch: 'errors.worktreeImport.baseline.mismatch', tooLarge: 'errors.worktreeImport.baseline.tooLarge',
  failed: 'errors.worktreeImport.baseline.failed' };
const SHA = /^[a-f0-9]{40,64}$/;
const HIDDEN = /[\0\p{Cc}]/u;
const own = (path) => path !== '.wax' && !path.startsWith('.wax/');
const list = (text) => String(text).split('\0').filter(Boolean);
const fail = (id, status = 409, ...values) => new WaxError(t(id, ...values), status);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const STATE_IDENTITY = { GIT_AUTHOR_NAME: 'wax', GIT_AUTHOR_EMAIL: 'wax@localhost.invalid', GIT_COMMITTER_NAME: 'wax', GIT_COMMITTER_EMAIL: 'wax@localhost.invalid',
  GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' };


function run(cwd, args, { env = {}, input = '', binary = false, timeout = IMPORT_LIMITS.timeout, maxBuffer = 8_000_000 } = {}) {
  return new Promise((done, reject) => {
    const child = execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: binary ? 'buffer' : 'utf8', timeout, maxBuffer, windowsHide: true, env: gitEnv(env) },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(Object.assign(error, { stderr: String(stderr ?? '') })); return; }
        done({ code: error ? error.code : 0, stdout, stderr: String(stderr ?? '') });
      });
    child.stdin?.on('error', () => {   });
    child.stdin?.end(input);
  });
}
async function git(cwd, args, options) {
  const result = await run(cwd, args, options);
  if (result.code !== 0) throw Object.assign(new Error(result.stderr.trim() || `git ${args[0]} exited ${result.code}`), { stderr: result.stderr });
  return result.stdout;
}
const line = async (cwd, args, options) => { try { return String(await git(cwd, args, options)).trim() || null; } catch { return null; } };

let cachedVersion = null;
export function gitVersion() {
  cachedVersion ??= line(process.cwd(), ['--version']).then((text) => text?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null);
  return cachedVersion;
}
export function mergeTreeSupported(version) {
  const [major, minor] = String(version ?? '').split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major > MERGE_TREE_VERSION[0] || (major === MERGE_TREE_VERSION[0] && minor >= MERGE_TREE_VERSION[1]);
}
const versionOf = async (injected) => (injected === undefined || injected === null ? gitVersion() : String(injected));

export function manualCommands(entry) {
  const where = `.wax/worktrees/${entry.id}`;
  return [`git -C ${where} status`, `git -C ${where} add -A`, `git -C ${where} commit -m "${entry.feature}"`, `git status`, `git merge --squash --no-commit ${entry.branch}`];
}

const underAny = (path, folders) => folders.some((folder) => path === folder || path.startsWith(`${folder}/`));

function statusPaths(text, copied = []) {
  const paths = [], folders = [], untracked = new Set(), copiedHits = [];
  for (const entry of list(text)) {
    if (!/^.. ./.test(entry)) continue;
    const path = entry.slice(3);
    if (!own(path)) continue;
    if (copied.length && underAny(path.replace(/\/$/, ''), copied)) { copiedHits.push(path.replace(/\/$/, '')); continue; }
    (path.endsWith('/') ? folders : paths).push(path.replace(/\/$/, ''));
    if (entry.startsWith('??') && !path.endsWith('/')) untracked.add(path);
  }
  return { paths: [...new Set(paths)].sort(), folders: [...new Set(folders)].sort(), untracked, copiedHits };
}

export function excludedSummary(paths) {
  const sorted = [...new Set(paths)].sort();
  const groups = new Map();
  for (const path of sorted) { const top = path.split('/')[0]; groups.set(top, (groups.get(top) ?? 0) + 1); }
  return { count: sorted.length, groups: [...groups.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1)).slice(0, 20),
    paths: sorted.slice(0, 50) };
}


async function entryOf(root, goal, id) {
  const entry = (await readWorktrees(root)).find((item) => item.id === id && item.goal === goal);
  if (!entry) throw fail('errors.worktreeImport.notFound', 404, String(id).slice(0, 40));
  return entry;
}
async function importable(root, goal, id) {
  const entry = await entryOf(root, goal, id);
  if (isReview(entry)) throw fail('errors.worktreeReview.noImport', 409, entry.id);
  return entry;
}

export async function worktreeSummary(root, entry) {
  try {
    const checked = await checkWorktreePath(root, entry);
    if (!checked || entry.state !== 'active') return null;
    const copied = copiedPaths(entry.setup?.copy);
    const status = statusPaths(await git(checked.path, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { timeout: 5000 }), copied);
    const baseline = await readBaseline(root, entry).catch(() => ({ state: 'failed' }));
    const paths = baseline.state === 'ok' ? status.paths.filter((path) => !(status.untracked.has(path) && baseline.paths[path])) : status.paths;
    const head = await line(checked.path, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    let committed = [], commits = 0;
    if (head && entry.base && head !== entry.base) {
      committed = list(await git(checked.path, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', entry.base, head, '--'], { timeout: 5000 })).filter((path) => own(path) && !underAny(path, copied));
      commits = Number(await line(checked.path, ['rev-list', '--count', `${entry.base}..${head}`])) || 0;
    }
    return { files: new Set([...paths, ...committed]).size, commits, uncommitted: paths.length };
  } catch { return null; }
}


export async function withScratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-import-'));
  try {
    await mkdir(join(dir, 'objects'));
    return await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

function parseRaw(text) {
  const parts = list(text), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, oldBlob, newBlob, status] = parts[i].replace(/^:/, '').split(' ');
    out.push({ path: parts[i + 1], oldMode, newMode, oldBlob, newBlob, status });
  }
  return out;
}
function parseNumstat(text) {
  const out = new Map();
  for (const part of list(text)) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(part);
    if (match) out.set(match[3], match[1] === '-' ? null : { added: Number(match[1]), removed: Number(match[2]) });
  }
  return out;
}
const linkMode = (mode) => mode === '120000';
const fileMode = (mode) => mode === '100644' || mode === '100755';
const zero = (blob) => !blob || /^0+$/.test(blob);

async function stateCommit(folder, base, paths, env, index, message) {
  if (!paths.length) return base;
  const exec = (args, { index: file = null, input = '', binary = false } = {}) => git(folder, args, { env: file ? { ...env, GIT_INDEX_FILE: file } : env, input, binary });
  const tree = await scratchTree(exec, { base, paths, index, objects: env.GIT_OBJECT_DIRECTORY });
  if (!SHA.test(tree ?? '')) throw fail('errors.worktreeImport.gitFailed', 409, 'write-tree');
  const commit = await line(folder, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', base, '-m', message], { env: { ...env, ...STATE_IDENTITY } });
  if (!SHA.test(commit ?? '')) throw fail('errors.worktreeImport.gitFailed', 409, 'commit-tree');
  return commit;
}

async function stateBasics(root, entry) {
  const realRoot = await realpath(root);
  if (entry.state !== 'active') throw fail('errors.worktreeImport.notActive', 409, entry.id, entry.state);
  const checked = await checkWorktreePath(root, entry);
  if (!checked) throw fail('errors.worktreeImport.folderMissing', 409, entry.id);
  const folder = checked.path;
  const head = await line(realRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!SHA.test(head ?? '')) throw fail('errors.worktreeImport.noHead', 409);
  if ((await line(folder, ['symbolic-ref', '-q', 'HEAD'])) !== `refs/heads/${entry.branch}`) throw fail('errors.worktreeImport.branchMoved', 409, entry.id, entry.branch);
  const tip = await line(folder, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!SHA.test(tip ?? '')) throw fail('errors.worktreeImport.noHead', 409);
  return { realRoot, folder, head, tip };
}

async function scratchEnv(realRoot, scratch) {
  const common = await line(realRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common || common.includes(delimiter) || HIDDEN.test(common)) throw fail('errors.worktreeImport.gitFailed', 409, 'git-common-dir');
  return { GIT_OBJECT_DIRECTORY: join(scratch, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, 'objects') };
}

async function worktreeCommit(entry, folder, tip, baseline, env, scratch) {
  const copiedFolders = copiedPaths(entry.setup?.copy);
  const status = statusPaths(await git(folder, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']), copiedFolders);
  const copiedHits = [...status.copiedHits];
  const skip = status.folders.map((path) => ({ path, reason: 'notFile' }));
  const excluded = [];
  let uncommittedPaths = status.paths;
  if (baseline.state === 'ok' && baseline.count) {
    const candidates = status.paths.filter((path) => status.untracked.has(path) && baseline.paths[path]);
    const now = candidates.length ? await blobIds(folder, candidates, { timeout: IMPORT_LIMITS.timeout }) : new Map();
    const same = new Set(candidates.filter((path) => now.get(path) === baseline.paths[path]));
    excluded.push(...same);
    uncommittedPaths = status.paths.filter((path) => !same.has(path));
  }
  const commit = await stateCommit(folder, tip, uncommittedPaths, env, join(scratch, 'worktree.index'), `wax import ${entry.id}`);
  return { commit, copiedFolders, copiedHits, skip, excluded, uncommittedPaths };
}

export async function worktreeState(root, entry, scratch) {
  const { realRoot, folder, head, tip } = await stateBasics(root, entry);
  const baseline = await readBaseline(root, entry).catch(() => ({ state: 'failed' }));
  const env = await scratchEnv(realRoot, scratch);
  const { commit } = await worktreeCommit(entry, folder, tip, baseline, env, scratch);
  const behind = Number(await line(realRoot, ['rev-list', '--count', `${tip}..${head}`]));
  return { folder, head, tip, commit, baseline: baseline.state, behind: Number.isSafeInteger(behind) ? behind : null };
}

export async function diffStates(root, scratch, before, after, { limit = IMPORT_LIMITS.shown } = {}) {
  if (before === after) return [];
  const realRoot = await realpath(root);
  const env = await scratchEnv(realRoot, scratch);
  return list(await git(realRoot, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', before, after, '--'], { env })).slice(0, limit);
}

async function inspect(root, entry, scratch, { version }) {
  const base = { worktree: entry.id, goal: entry.goal, feature: entry.feature, branch: entry.branch, state: entry.state, version: version ?? null };
  if (!mergeTreeSupported(version)) return { ...base, supported: false, commands: manualCommands(entry), ready: false };
  const { realRoot, folder, head, tip } = await stateBasics(root, entry);
  const baseline = await readBaseline(root, entry);
  if (BASELINE_UNSAFE.has(baseline.state)) {
    return { ...base, supported: true, head, tip, baseline: { state: baseline.state, ...(baseline.count ? { count: baseline.count } : {}) }, commands: manualCommands(entry),
      merged: null, conflicts: [], files: [], count: 0, skip: [], excluded: excludedSummary([]), copied: excludedSummary([]), exists: [], changed: [], over: null, dirty: [], dirtyCount: 0, uncommitted: 0, ready: false,
      fingerprint: hash({ worktree: entry.id, head, tip, baseline: baseline.state }), plan: [] };
  }
  const env = await scratchEnv(realRoot, scratch);
  const { commit, copiedFolders, copiedHits, skip, excluded, uncommittedPaths } = await worktreeCommit(entry, folder, tip, baseline, env, scratch);
  const project = statusPaths(await git(realRoot, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']));
  const dirty = [...project.paths, ...project.folders.map((path) => `${path}/`)].sort();
  const ours = dirty.length ? await stateCommit(realRoot, head, project.paths, env, join(scratch, 'project.index'), 'wax project state') : head;
  const mergeBase = await line(realRoot, ['merge-base', head, tip]);
  const merged = await run(realRoot, ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, commit], { env });
  if (merged.code !== 0 && merged.code !== 1) throw fail('errors.worktreeImport.gitFailed', 409, String(merged.stderr).trim().slice(0, 200) || 'merge-tree');
  const [tree, ...rest] = list(merged.stdout);
  if (!SHA.test(tree ?? '')) throw fail('errors.worktreeImport.gitFailed', 409, 'merge-tree');
  const facts = { ...base, supported: true, head, tip, base: mergeBase, commit, uncommitted: uncommittedPaths.length, dirty: dirty.slice(0, IMPORT_LIMITS.dirty), dirtyCount: dirty.length,
    baseline: { state: baseline.state, ...(baseline.state === 'ok' ? { count: baseline.count } : {}) } };
  const conflicts = merged.code === 1 ? [...new Set(rest)].sort() : [];
  if (conflicts.length || dirty.length) {
    return { ...facts, merged: null, conflicts, files: [], count: 0, skip, excluded: excludedSummary(excluded), copied: excludedSummary(copiedHits), exists: [], changed: [], over: null, ready: false,
      fingerprint: hash({ worktree: entry.id, head, tip, commit, ours, conflicts, copied: [...new Set(copiedHits)].sort() }), plan: [] };
  }
  const raw = parseRaw(await git(realRoot, ['diff-tree', '-r', '-z', '--no-renames', head, tree, '--'], { env }));
  const counts = parseNumstat(await git(realRoot, ['diff-tree', '-r', '-z', '--numstat', '--no-renames', head, tree, '--'], { env }));
  const plan = [], exists = [], changed = [];
  for (const change of raw) {
    const { path } = change;
    if (!own(path)) { skip.push({ path, reason: 'sensitive' }); continue; }
    if (HIDDEN.test(path)) { skip.push({ path, reason: 'outside' }); continue; }
    if (underAny(path, copiedFolders)) { copiedHits.push(path); continue; }
    const action = zero(change.oldBlob) || change.status === 'A' ? 'new' : zero(change.newBlob) || change.status === 'D' ? 'delete' : 'modify';
    if (action === 'new' && baseline.state === 'ok' && baseline.paths[path] && baseline.paths[path] === change.newBlob && !linkMode(change.newMode)) { excluded.push(path); continue; }
    const modes = [action === 'new' ? null : change.oldMode, action === 'delete' ? null : change.newMode].filter(Boolean);
    if (modes.some(linkMode)) { skip.push({ path, reason: 'symlink' }); continue; }
    if (!modes.every(fileMode)) { skip.push({ path, reason: 'notFile' }); continue; }
    const place = await restoreTarget(realRoot, path);
    if (place.reason === 'notFile') { (action === 'new' ? exists : changed).push(path); continue; }
    if (place.reason) { skip.push({ path, reason: place.reason }); continue; }
    plan.push({ path, action, target: place.target, oldBlob: action === 'new' ? null : change.oldBlob, newBlob: action === 'delete' ? null : change.newBlob,
      oldMode: action === 'new' ? null : change.oldMode, newMode: action === 'delete' ? null : change.newMode, counts: counts.has(path) ? counts.get(path) : null });
  }
  await currentIds(realRoot, plan);
  for (const item of plan) {
    if (item.action === 'new' ? item.current !== 'absent' : item.current !== item.oldBlob) (item.action === 'new' ? exists : changed).push(item.path);
  }
  const sizes = await blobSizes(realRoot, plan.filter((item) => item.newBlob).map((item) => item.newBlob), env);
  const bytes = plan.reduce((sum, item) => sum + (item.newBlob ? sizes.get(item.newBlob) ?? 0 : 0), 0);
  const over = plan.length > IMPORT_LIMITS.files ? { files: plan.length, limit: IMPORT_LIMITS.files } : bytes > IMPORT_LIMITS.bytes ? { bytes, limit: IMPORT_LIMITS.bytes } : null;
  const files = plan.slice(0, IMPORT_LIMITS.shown).map((item) => ({ path: item.path, action: item.action, ...(item.counts ? item.counts : { binary: true }),
    ...(item.newMode && item.oldMode && item.newMode !== item.oldMode ? { mode: item.newMode } : item.action === 'new' && item.newMode === '100755' ? { mode: item.newMode } : {}) }));
  const fingerprint = hash({ worktree: entry.id, head, tip, commit, merged: tree, plan: plan.map((item) => [item.path, item.action, item.oldBlob, item.newBlob, item.newMode, item.current]),
    skip: skip.map((item) => [item.path, item.reason]), exists, changed, excluded: [...excluded].sort(), copied: [...new Set(copiedHits)].sort() });
  const ready = !exists.length && !changed.length && !over && plan.length > 0;
  return { ...facts, merged: tree, conflicts: [], files, count: plan.length, skip, excluded: excludedSummary(excluded), copied: excludedSummary(copiedHits), exists, changed, over, ready, fingerprint, plan, env };
}

async function currentIds(realRoot, plan) {
  const present = [];
  for (const item of plan) {
    let info;
    try { info = await lstat(item.target); } catch (error) { item.current = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'absent' : 'other'; continue; }
    if (!info.isFile() || info.isSymbolicLink()) { item.current = 'other'; continue; }
    present.push(item);
  }
  if (!present.length) return;
  const ids = String(await git(realRoot, ['hash-object', '--stdin-paths'], { input: `${present.map((item) => item.path).join('\n')}\n` })).split(/\r?\n/).filter(Boolean);
  present.forEach((item, index) => { item.current = SHA.test(ids[index] ?? '') ? ids[index] : 'other'; });
}

async function blobSizes(realRoot, ids, env) {
  const out = new Map();
  if (!ids.length) return out;
  const lines = String(await git(realRoot, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { env, input: `${[...new Set(ids)].join('\n')}\n` })).split(/\r?\n/);
  for (const text of lines) { const [id, size] = text.split(' '); if (SHA.test(id ?? '')) out.set(id, Number(size) || 0); }
  return out;
}

const shown = ({ plan, env, checksGate, ...rest }) => rest;

export async function previewImport(root, goal, id, { version, gate = null } = {}) {
  const entry = await importable(root, goal, id);
  const found = await versionOf(version);
  return withScratch(async (scratch) => shown(await gated(entry, await inspect(root, entry, scratch, { version: found }), gate)));
}

async function gated(entry, preview, gate) {
  if (!gate || !preview.supported) return preview;
  const checks = await gate(entry, preview);
  return { ...preview, checks: checks.view, checksGate: checks, ready: Boolean(preview.ready && !checks.blocked),
    fingerprint: checks.fingerprint ? hash({ import: preview.fingerprint, checks: checks.fingerprint }) : preview.fingerprint };
}

async function writeImported(target, bytes, mode) {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)) !== parent) throw new Error('parent moved');
  const temp = join(parent, `.${basename(target)}.wax-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode });
    if (process.platform !== 'win32') await chmod(temp, mode).catch(() => {});
    await renameWithRetry(temp, target);
  } finally { await rm(temp, { force: true }); }
}
async function pruneEmpty(realRoot, target) {
  let dir = dirname(target);
  while (dir !== realRoot && relative(realRoot, dir) && !relative(realRoot, dir).startsWith('..')) {
    try { await rmdir(dir); } catch { return; }
    dir = dirname(dir);
  }
}

export async function applyImport(root, goal, id, { by, fingerprint, phase = null, version, now = Date.now, gate = null } = {}) {
  const entry = await importable(root, goal, id);
  const found = await versionOf(version);
  return withScratch(async (scratch) => {
    const preview = await gated(entry, await inspect(root, entry, scratch, { version: found }), gate);
    if (!preview.supported) throw fail('errors.worktreeImport.oldGit', 409, found ?? '-', MERGE_TREE_VERSION.join('.'));
    if (BASELINE_UNSAFE.has(preview.baseline?.state)) throw fail(BASELINE_ERRORS[preview.baseline.state], 409, entry.id);
    if (preview.conflicts.length) throw fail('errors.worktreeImport.conflicts', 409, preview.conflicts.length, preview.conflicts.slice(0, 10).join(', '));
    if (preview.dirtyCount) throw fail('errors.worktreeImport.dirty', 409, preview.dirtyCount, preview.dirty.slice(0, 10).join(', '));
    if (preview.checksGate?.blocked) throw fail(preview.checksGate.blocked, 409);
    if (typeof fingerprint !== 'string' || fingerprint !== preview.fingerprint) throw fail('errors.worktreeImport.changed', 409);
    if (preview.exists.length) throw fail('errors.worktreeImport.exists', 409, preview.exists.slice(0, 10).join(', '));
    if (preview.changed.length) throw fail('errors.worktreeImport.projectChanged', 409, preview.changed.slice(0, 10).join(', '));
    if (preview.over) throw fail('errors.worktreeImport.tooMany', 409, IMPORT_LIMITS.files, IMPORT_LIMITS.bytes / 1024 / 1024);
    if (!preview.plan.length) throw fail('errors.worktreeImport.nothing', 409, entry.id);
    const realRoot = await realpath(root);
    const run = `im-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const meta = { run, goal: entry.goal, feature: entry.feature, phase, by, target: entry.id };
    const pre = await takeSnapshot(root, { ...meta, point: 'pre-import' }, { now });
    if (!pre || pre.state !== 'ok') throw fail('errors.worktreeImport.preImport', 409);
    const imported = [], failed = [], skipped = preview.skip.map(({ path, reason }) => ({ path, reason }));
    const again = preview.plan.map((item) => ({ ...item }));
    await currentIds(realRoot, again);
    const ordered = [...again.filter((item) => item.action === 'delete'), ...again.filter((item) => item.action !== 'delete')];
    for (const item of ordered) {
      try {
        const before = preview.plan.find((planned) => planned.path === item.path);
        const place = await restoreTarget(realRoot, item.path);
        if (place.reason || item.current !== before.current) { failed.push(item.path); continue; }
        if (item.action === 'delete') { await rm(place.target); await pruneEmpty(realRoot, place.target); }
        else {
          const bytes = await git(realRoot, ['cat-file', '--filters', `${preview.merged}:${item.path}`], { env: preview.env, binary: true, maxBuffer: IMPORT_LIMITS.bytes + 4096 });
          let mode = item.newMode === '100755' ? 0o755 : 0o644;
          if (item.action === 'modify' && item.oldMode === item.newMode) { try { mode = (await lstat(place.target)).mode & 0o777; } catch {   } }
          await writeImported(place.target, bytes, mode);
        }
        imported.push(item.path);
      } catch { failed.push(item.path); }
    }
    const post = await takeSnapshot(root, { ...meta, point: 'post-import' }, { now });
    const record = await appendWorktree(root, { ...entry, state: 'imported', by, at: undefined }, { now: now() });
    return { run, worktree: entry.id, branch: entry.branch, feature: entry.feature, goal: entry.goal, head: preview.head, tip: preview.tip, uncommitted: preview.uncommitted,
      imported, skipped, failed, ...(preview.checksGate?.record ? { checks: { ...preview.checksGate.record, commands: preview.checksGate.commands.length } } : {}), excluded: preview.excluded?.count ?? 0, copied: preview.copied?.count ?? 0, count: preview.plan.length, preImport: pre.id, postImport: post?.id ?? null, state: record.state, at: record.at };
  });
}


export async function discardWorktree(root, goal, id, { by, now = Date.now } = {}) {
  const entry = await entryOf(root, goal, id);
  if (entry.state !== 'active') throw fail('errors.worktreeImport.notActive', 409, entry.id, entry.state);
  const record = await appendWorktree(root, { ...entry, state: 'discarded', by, at: undefined }, { now: now() });
  return { worktree: entry.id, branch: entry.branch, state: record.state, by, at: record.at };
}

export async function reactivateImported(root, id, { by, now = Date.now, portProbe } = {}) {
  const all = await readWorktrees(root);
  const entry = all.find((item) => item.id === id);
  if (!entry || entry.state !== 'imported' || !(await checkWorktreePath(root, entry))) return null;
  const taken = all.some((item) => item.id !== id && item.state === 'active' && item.port === entry.port);
  const port = taken ? (await pickFreePort(all, { ...(portProbe ? { probe: portProbe } : {}) })).port : entry.port;
  return appendWorktree(root, { ...entry, ...(port !== null && port !== undefined ? { port } : {}), state: 'active', by, at: undefined }, { now: now() });
}

async function removeEntry(root, realRoot, entry, { by, now, reason = undefined }) {
  const checked = await checkWorktreePath(root, entry);
  const record = { ...entry, state: 'removed', by, at: undefined, ...(reason ? { reason } : {}) };
  const withRef = async (out) => (isReview(entry) ? { ...out, ref: await deleteReviewRef(root, entry).catch(() => 'failed') } : out);
  if (!checked) {
    const there = await lstat(entry.path).then(() => true, () => false);
    if (there) return { outcome: 'unsafe' };
    await appendWorktree(root, record, { now: now() });
    return withRef({ outcome: 'missing' });
  }
  const hooks = await mkdtemp(join(tmpdir(), 'wax-no-hooks-'));
  try {
    await git(realRoot, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'remove', '--force', checked.path]);
    await appendWorktree(root, record, { now: now() });
  } catch (error) { return { outcome: 'failed', reason: String(error.stderr || error.message).trim().slice(0, 300) }; }
  finally { await rm(hooks, { recursive: true, force: true }).catch(() => {}); }
  return withRef({ outcome: 'removed' });
}

export async function cleanupWorktrees(root, goal, { by, now = Date.now, reviewDone = new Set() } = {}) {
  const realRoot = await realpath(root);
  const mine = (await readWorktrees(root)).filter((item) => item.goal === goal && item.state !== 'removed');
  const done = (item) => item.state === 'imported' || item.state === 'discarded' || (item.state === 'active' && isReview(item) && reviewDone.has(item.id));
  const out = { removed: [], missing: [], unsafe: [], failed: [], kept: mine.filter((item) => !done(item)).map((item) => item.id), refs: {} };
  for (const entry of mine.filter(done)) {
    const result = await removeEntry(root, realRoot, entry, { by, now });
    if (result.outcome === 'failed') out.failed.push({ id: entry.id, reason: result.reason });
    else out[result.outcome].push(entry.id);
    if (result.ref) out.refs[entry.id] = result.ref;
  }
  return out;
}

export async function removeIntegratedWorktree(root, goal, id, { by, now = Date.now } = {}) {
  const realRoot = await realpath(root);
  const entry = await importable(root, goal, id);
  if (entry.state !== 'active') throw fail('errors.worktreeCleanup.notActive', 409, entry.id, entry.state);
  const done = await removeEntry(root, realRoot, entry, { by, now, reason: 'integrated' });
  if (done.outcome === 'unsafe') throw fail('errors.worktreeImport.folderMissing', 409, entry.id);
  if (done.outcome === 'failed') throw fail('errors.worktreeCleanup.failed', 500, entry.id, done.reason);
  return { worktree: entry.id, branch: entry.branch, outcome: done.outcome };
}
