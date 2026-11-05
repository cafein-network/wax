import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { constants as FS, promises as fsp } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, posix, sep as nativeSep, win32 } from 'node:path';
import { GIT_BASE_ARGS, projectReader, runGit } from './git-read.mjs';

export const COPY_LIMITS = { entries: 20, path: 200, segments: 6, timeout: 5000, buffer: 4 * 1024 * 1024 };
export const COPY_STATES = ['ready', 'missing', 'notIgnored', 'tracked', 'blocked', 'link', 'unknown'];
const VCS = new Set(['.git', '.wax', '.hg', '.svn', '.jj', '.bzr', '.pijul', '.sl']);
const BAD = /[\0\p{Cc}\p{Cf}\\:*?[\]{}!]/u;

export function copyPathShape(path) {
  if (typeof path !== 'string' || !path || path.length > COPY_LIMITS.path || BAD.test(path) || path.startsWith('/')) return false;
  const parts = path.split('/');
  if (parts.length > COPY_LIMITS.segments) return false;
  return parts.every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^ /.test(part));
}

export function blockedCopyPath(path) {
  return String(path).split('/').some((part) => { const name = part.toLowerCase(); return VCS.has(name) || name.startsWith('.env'); });
}

const git = (root, args) => projectReader(root).text(root, args, { timeout: COPY_LIMITS.timeout, maxBuffer: COPY_LIMITS.buffer });
const lines = (text) => text.split('\0').filter(Boolean);

async function linkOrMissing(root, path) {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    let info;
    try { info = await lstat(join(root, ...parts.slice(0, i))); } catch { return 'missing'; }
    if (info.isSymbolicLink()) return 'link';
    if (i < parts.length && !info.isDirectory()) return 'missing';
  }
  return null;
}

export async function copyStatus(root, paths, { run = git } = {}) {
  const out = paths.map((path) => ({ path, state: blockedCopyPath(path) ? 'blocked' : null }));
  for (const item of out) if (!item.state) item.state = await linkOrMissing(root, item.path);
  const rest = out.filter((item) => !item.state);
  if (!rest.length) return out;
  let ignored, tracked;
  try {
    ignored = lines(await run(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).map((line) => line.replace(/\/$/, ''));
    tracked = lines(await run(root, ['ls-files', '-z', '--', ...rest.map((item) => item.path)]));
  } catch {
    for (const item of rest) item.state = 'unknown';
    return out;
  }
  const under = (path, top) => path === top || path.startsWith(`${top}/`);
  for (const item of rest) {
    if (tracked.some((file) => under(file, item.path))) item.state = 'tracked';
    else item.state = ignored.some((line) => under(item.path, line)) ? 'ready' : 'notIgnored';
  }
  return out;
}

export const FAST_COPY_LIMITS = { files: 300_000, plainBytes: 1024 ** 3, spaceFactor: 2, timeoutMs: 3 * 60_000, concurrency: 4 };
export const COPY_OUTCOMES = ['cloned', 'copied', 'missing', 'exists', 'notIgnored', 'tracked', 'blocked', 'unsafeLink', 'tooLarge', 'timeout', 'failed', 'stopped'];
export const COPY_RESULTS = ['ok', 'partial', 'none', 'stopped', 'unsupported'];
export const COPY_METHODS = ['clone', 'copy', 'mixed'];
export const COPIED_OUTCOMES = new Set(['cloned', 'copied']);
export const CLONE_REFUSED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EPERM', 'EINVAL', 'ENOTTY']);
const STATUS_OUTCOME = { missing: 'missing', notIgnored: 'notIgnored', tracked: 'tracked', blocked: 'blocked', link: 'unsafeLink', unknown: 'failed' };
const CHECK_IGNORE_BASE = GIT_BASE_ARGS.filter((arg) => arg !== '--literal-pathspecs');

export function insidePath(parent, child, pathApi = { relative: posix.relative, isAbsolute: posix.isAbsolute, sep: posix.sep }) {
  const rel = pathApi.relative(parent, child);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel) && !win32.isAbsolute(rel);
}
const nativePath = { relative: (a, b) => (nativeSep === '\\' ? win32 : posix).relative(a, b), isAbsolute: (p) => (nativeSep === '\\' ? win32 : posix).isAbsolute(p), sep: nativeSep };

export function linkTargetSafe(at, target, links = new Set()) {
  if (typeof target !== 'string' || !target || target.length > 4096 || /[\0\p{Cc}\\:]/u.test(target) || posix.isAbsolute(target) || win32.isAbsolute(target)) return false;
  const parts = posix.dirname(at) === '.' ? [] : posix.dirname(at).split('/');
  const segments = target.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!parts.length) return false; parts.pop(); continue; }
    parts.push(segment);
    const path = parts.join('/');
    if (blockedCopyPath(path)) return false;
    if (i < segments.length - 1 && links.has(path)) return false;
  }
  return true;
}

const fsPath = (base, rel) => (rel ? join(base, ...rel.split('/')) : base);
const realOf = async (path, fs) => { try { return await fs.realpath(path); } catch { return null; } };

async function walk(source, path, { fs, limits, signal, deadline, now, stat = true }) {
  const out = { dirs: [], files: [], links: [], specials: [], bytes: 0, unsafe: false, tooMany: false, stopped: false, timeout: false };
  let root;
  try { root = await fs.lstat(source); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return out; throw error; }
  const files = [];
  if (root.isSymbolicLink()) out.links.push({ rel: '', target: await fs.readlink(source) });
  else if (root.isDirectory()) {
    out.dirs.push({ rel: '', mode: root.mode & 0o7777 });
    const stack = [''];
    while (stack.length) {
      if (signal?.aborted) { out.stopped = true; return out; }
      if (now() > deadline) { out.timeout = true; return out; }
      const rel = stack.pop();
      let names;
      try { names = await fs.readdir(fsPath(source, rel), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      const subdirs = [];
      for (const dirent of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const child = rel ? `${rel}/${dirent.name}` : dirent.name;
        if (dirent.isSymbolicLink()) out.links.push({ rel: child, target: await fs.readlink(fsPath(source, child)) });
        else if (dirent.isDirectory()) subdirs.push(child);
        else if (dirent.isFile()) files.push(child);
        else out.specials.push(child);
        if (files.length > limits.files) { out.tooMany = true; return out; }
      }
      for (const dir of subdirs) {
        if (stat) { try { out.dirs.push({ rel: dir, mode: (await fs.lstat(fsPath(source, dir))).mode & 0o7777 }); } catch { continue; } }
        else out.dirs.push({ rel: dir, mode: 0o755 });
      }
      for (const dir of subdirs.reverse()) stack.push(dir);
    }
  } else if (root.isFile()) files.push('');
  else return out;
  for (let i = 0; i < files.length; i += 64) {
    if (signal?.aborted) { out.stopped = true; return out; }
    if (now() > deadline) { out.timeout = true; return out; }
    const batch = files.slice(i, i + 64);
    if (!stat) { for (const rel of batch) out.files.push({ rel }); continue; }
    const infos = await Promise.all(batch.map((rel) => (rel === '' ? Promise.resolve(root) : fs.lstat(fsPath(source, rel)).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error))))));
    infos.forEach((info, index) => {
      if (!info) return;
      if (!info.isFile()) { if (info.isSymbolicLink()) out.unsafe = true; else out.specials.push(batch[index]); return; }
      out.files.push({ rel: batch[index], size: info.size, mode: info.mode & 0o7777, atime: info.atime, mtime: info.mtime });
      out.bytes += info.size;
    });
  }
  const at = (rel) => (rel ? `${path}/${rel}` : path);
  const linkSet = new Set(out.links.map((link) => at(link.rel)));
  out.unsafe ||= out.links.some((link) => !linkTargetSafe(at(link.rel), link.target, linkSet));
  return out;
}

async function makeParents(worktree, path, fs, created) {
  const parts = path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const full = fsPath(worktree, parts.slice(0, i).join('/'));
    let info = null;
    try { info = await fs.lstat(full); } catch (error) { if (error.code !== 'ENOENT') return 'failed'; }
    if (info?.isSymbolicLink()) return 'unsafeLink';
    if (info && !info.isDirectory()) return 'failed';
    if (!info) { try { await fs.mkdir(full); created.push(full); } catch { return 'failed'; } }
  }
  const parent = fsPath(worktree, parts.join('/'));
  return (await realOf(parent, fs)) === parent ? 'ok' : 'unsafeLink';
}

async function removePartial(target, parents, fs) {
  if (target) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  for (const dir of [...parents].reverse()) await fs.rmdir(dir).catch(() => {});
}

async function worktreeIgnored(worktree, items, run) {
  const asked = items.map((item) => (item.dir ? `${item.path}/` : item.path));
  const result = await run(worktree, ['check-ignore', '-z', '--stdin'], { input: `${asked.join('\0')}\0` });
  if (result.code !== 0 && result.code !== 1) throw new Error(String(result.stderr).trim() || `git check-ignore exited ${result.code}`);
  const said = new Set(lines(result.stdout).map((line) => line.replace(/\/$/, '')));
  return new Set(items.filter((item) => said.has(item.path)).map((item) => item.path));
}
const checkIgnoreRun = (cwd, args, { input }) => runGit(cwd, ['-c', 'core.quotePath=false', ...args], { input, base: CHECK_IGNORE_BASE, timeout: COPY_LIMITS.timeout, maxBuffer: COPY_LIMITS.buffer });

export function parseMounts(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const match = /^.+? on (.+) \(([^,()]+)[,)]/.exec(line);
    if (match) out.push({ point: match[1], type: match[2].trim().toLowerCase() });
  }
  return out;
}
export function volumeType(mounts, path) {
  let best = null;
  for (const mount of mounts) {
    const point = mount.point.endsWith('/') ? mount.point : `${mount.point}/`;
    if ((`${path}/`.startsWith(point) || mount.point === '/') && (!best || mount.point.length > best.point.length)) best = mount;
  }
  return best?.type ?? null;
}
const readMounts = () => new Promise((done) => {
  execFile('/sbin/mount', [], { encoding: 'utf8', timeout: COPY_LIMITS.timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => done(error ? null : parseMounts(stdout)));
});

export function cloneTree(sources, target, { signal = null, timeoutMs, spawn = nodeSpawn } = {}) {
  return new Promise((done) => {
    let settled = false, child;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); done(value); };
    const kill = (value) => { try { child?.kill('SIGKILL'); } catch {   } finish(value); };
    const onAbort = () => kill('stopped');
    const timer = setTimeout(() => kill('timeout'), Math.max(0, timeoutMs));
    if (signal?.aborted) { finish('stopped'); return; }
    try { child = spawn('/bin/cp', ['-c', '-R', '-P', ...sources, target], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { finish('failed'); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.once('error', () => finish('failed'));
    child.once('close', (code) => finish(code === 0 ? 'ok' : 'failed'));
  });
}

const defaultFs = { lstat: fsp.lstat, readdir: fsp.readdir, readlink: fsp.readlink, realpath: fsp.realpath, mkdir: fsp.mkdir, chmod: fsp.chmod, symlink: fsp.symlink,
  copyFile: fsp.copyFile, utimes: fsp.utimes, rm: fsp.rm, rmdir: fsp.rmdir, statfs: fsp.statfs };

export async function copyFolders(root, worktree, paths, { signal = null, platform = process.platform, fs: injected = {}, status = copyStatus, ignoredRun = checkIgnoreRun,
  limits: given = {}, now = Date.now, mounts = readMounts, clone = cloneTree } = {}) {
  const started = now();
  const limits = { ...FAST_COPY_LIMITS, ...given };
  const fs = { ...defaultFs, ...injected };
  if (platform === 'win32') return { state: 'unsupported', method: null, ms: 0, entries: [] };
  const deadline = started + limits.timeoutMs;
  const entries = paths.map((path) => ({ path, outcome: null }));
  const pending = [];
  let checked;
  try { checked = await status(root, paths); } catch { checked = paths.map((path) => ({ path, state: 'unknown' })); }
  for (const [index, item] of entries.entries()) {
    const state = checked[index]?.path === item.path ? checked[index].state : 'unknown';
    if (!copyPathShape(item.path)) { item.outcome = 'blocked'; continue; }
    if (state !== 'ready') { item.outcome = STATUS_OUTCOME[state] ?? 'failed'; continue; }
    const source = fsPath(root, item.path);
    const real = await realOf(source, fs);
    if (!real) { item.outcome = 'missing'; continue; }
    if (real !== source || !insidePath(root, real, nativePath)) { item.outcome = 'unsafeLink'; continue; }
    let info;
    try { info = await fs.lstat(source); } catch { item.outcome = 'missing'; continue; }
    pending.push({ item, source, dir: info.isDirectory() });
  }
  if (pending.length) {
    let ignored;
    try { ignored = await worktreeIgnored(worktree, pending.map(({ item, dir }) => ({ path: item.path, dir })), ignoredRun); } catch { ignored = null; }
    for (const job of pending) if (!ignored) job.item.outcome = 'failed'; else if (!ignored.has(job.item.path)) job.item.outcome = 'notIgnored';
  }
  const shared = { mode: 'unknown', written: 0, cloned: 0, apfs: false, dev: null, clone };
  if (platform === 'darwin' && pending.some((job) => !job.item.outcome)) {
    const found = await Promise.resolve().then(mounts).catch(() => null);
    shared.apfs = Boolean(found) && volumeType(found, worktree) === 'apfs';
    if (shared.apfs) shared.dev = await fs.lstat(worktree).then((info) => info.dev, () => null);
  }
  for (const job of pending) {
    const { item } = job;
    if (item.outcome) continue;
    if (signal?.aborted) { item.outcome = 'stopped'; continue; }
    if (now() > deadline) { item.outcome = 'timeout'; continue; }
    item.outcome = await copyOne(job, { worktree, fs, limits, signal, deadline, now, shared });
  }
  for (const item of entries) item.outcome ??= 'failed';
  const copied = entries.filter((item) => COPIED_OUTCOMES.has(item.outcome));
  const state = entries.some((item) => item.outcome === 'stopped') ? 'stopped' : !copied.length ? 'none'
    : entries.some((item) => !COPIED_OUTCOMES.has(item.outcome) && item.outcome !== 'missing') || copied.some((item) => item.vanished) ? 'partial' : 'ok';
  const clonedFiles = copied.reduce((sum, item) => sum + (item.cloned ?? 0), 0), writtenFiles = copied.reduce((sum, item) => sum + (item.written ?? 0), 0);
  const method = !clonedFiles && !writtenFiles ? null : !writtenFiles ? 'clone' : !clonedFiles ? 'copy' : 'mixed';
  return { state, method, ms: Math.max(0, now() - started), entries };
}

async function copyOne({ item, source }, { worktree, fs, limits, signal, deadline, now, shared }) {
  const target = fsPath(worktree, item.path);
  const parents = [];
  let made = false;
  const fail = async (outcome) => { await removePartial(made ? target : null, parents, fs); return outcome; };
  try {
    const parent = await makeParents(worktree, item.path, fs, parents);
    if (parent !== 'ok') return await fail(parent);
    const there = await fs.lstat(target).then(() => true, (error) => (error.code === 'ENOENT' ? false : null));
    if (there === null) return await fail('failed');
    if (there) return await fail('exists');
    const tree = await walk(source, item.path, { fs, limits, signal, deadline, now });
    if (tree.stopped) return await fail('stopped');
    if (tree.timeout) return await fail('timeout');
    if (tree.tooMany) return await fail('tooLarge');
    if (tree.unsafe) return await fail('unsafeLink');
    item.files = tree.files.length; item.bytes = tree.bytes; item.cloned = 0; item.written = 0;
    if (shared.apfs && shared.dev !== null && (await fs.lstat(source)).dev === shared.dev) {
      let cloned;
      if (tree.dirs.length) {
        await fs.mkdir(target, { mode: tree.dirs[0].mode | 0o700 });
        made = true;
        cloned = await cloneChunks(source, target, tree, { signal, deadline, now, limits, clone: shared.clone });
        if (cloned === 'ok' && (tree.dirs[0].mode | 0o700) !== tree.dirs[0].mode) await fs.chmod(target, tree.dirs[0].mode).catch(() => {});
      } else {
        cloned = await shared.clone([source], target, { signal, timeoutMs: deadline - now() });
        made = true;
      }
      if (cloned !== 'ok') return await fail(cloned);
      const copiedTree = await walk(target, item.path, { fs, limits, signal, deadline, now, stat: false });
      if (copiedTree.stopped) return await fail('stopped');
      if (copiedTree.timeout) return await fail('timeout');
      if (copiedTree.tooMany) return await fail('tooLarge');
      if (copiedTree.unsafe) return await fail('unsafeLink');
      for (const rel of copiedTree.specials) await fs.rm(fsPath(target, rel), { force: true });
      item.files = copiedTree.files.length; item.cloned = copiedTree.files.length;
      if (copiedTree.files.length < tree.files.length) item.vanished = tree.files.length - copiedTree.files.length;
      return 'cloned';
    }
    if (shared.mode === 'copy' && !(await plainCopyFits(worktree, tree.bytes, fs, limits, shared))) return await fail('tooLarge');
    for (const dir of tree.dirs) { await fs.mkdir(fsPath(target, dir.rel), { mode: dir.mode | 0o700 }); made = true; }
    for (const link of tree.links) await fs.symlink(link.target, fsPath(target, link.rel));
    const files = tree.files;
    let vanished = 0, stop = null, next = 0;
    const one = async (file) => {
      const from = fsPath(source, file.rel), to = fsPath(target, file.rel);
      let how;
      try { how = await copyFileFast(from, to, fs, shared); }
      catch (error) { if (error.code === 'ENOENT') { vanished++; return; } throw error; }
      made = true;
      if (how === 'copy') {
        item.written++;
        shared.written += file.size;
        if (shared.written > limits.plainBytes) { stop ??= 'tooLarge'; return; }
      } else item.cloned++;
      await fs.utimes(to, file.atime, file.mtime);
    };
    if (files.length && shared.mode === 'unknown') {
      await one(files[next++]);
      if (shared.mode === 'copy' && !(await plainCopyFits(worktree, tree.bytes, fs, limits, { written: 0 }))) return await fail('tooLarge');
    }
    const worker = async () => {
      while (!stop && next < files.length) {
        if (signal?.aborted) { stop = 'stopped'; return; }
        if (now() > deadline) { stop = 'timeout'; return; }
        await one(files[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, files.length) }, worker));
    if (stop) return await fail(stop);
    if (signal?.aborted) return await fail('stopped');
    for (const dir of [...tree.dirs].reverse()) if ((dir.mode | 0o700) !== dir.mode) await fs.chmod(fsPath(target, dir.rel), dir.mode).catch(() => {});
    if (vanished) item.vanished = vanished;
    if (files.length && !item.cloned && !item.written) return await fail('missing');
    return item.written ? 'copied' : 'cloned';
  } catch {
    return await fail('failed');
  }
}

async function cloneChunks(source, target, tree, { signal, deadline, now, limits, clone }) {
  const weight = new Map();
  const top = (rel) => rel.split('/')[0];
  for (const item of [...tree.dirs, ...tree.links]) if (item.rel && !weight.has(top(item.rel))) weight.set(top(item.rel), 0);
  for (const item of tree.files) weight.set(top(item.rel), (weight.get(top(item.rel)) ?? 0) + 1);
  const names = [...weight.keys()].sort();
  if (!names.length) return 'ok';
  const share = Math.max(1, Math.ceil(tree.files.length / (limits.concurrency * 4)));
  const chunks = [];
  let chunk = [], files = 0, bytes = 0;
  for (const name of names) {
    const full = join(source, name);
    if (chunk.length && (files >= share || chunk.length >= 200 || bytes + full.length > 128 * 1024)) { chunks.push(chunk); chunk = []; files = 0; bytes = 0; }
    chunk.push(full); files += weight.get(name); bytes += full.length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  let next = 0, result = 'ok';
  const worker = async () => {
    while (result === 'ok' && next < chunks.length) {
      const outcome = await clone(chunks[next++], target, { signal, timeoutMs: deadline - now() });
      if (outcome !== 'ok' && result === 'ok') result = outcome;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, chunks.length) }, worker));
  return result;
}

async function copyFileFast(from, to, fs, shared) {
  if (shared.mode !== 'copy') {
    try {
      await fs.copyFile(from, to, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE_FORCE);
      if (shared.mode === 'unknown') shared.mode = 'clone';
      return 'clone';
    } catch (error) {
      if (!CLONE_REFUSED.has(error.code)) throw error;
      if (shared.mode === 'unknown') shared.mode = 'copy';
      await fs.rm(to, { force: true }).catch(() => {});
    }
  }
  await fs.copyFile(from, to, FS.COPYFILE_EXCL);
  return 'copy';
}

async function plainCopyFits(worktree, bytes, fs, limits, shared) {
  if (shared.written + bytes > limits.plainBytes) return false;
  try {
    const info = await fs.statfs(worktree);
    return Number(info.bavail) * Number(info.bsize) >= bytes * limits.spaceFactor;
  } catch { return false; }
}

export function copiedPaths(copy) {
  const entries = copy?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((item) => COPIED_OUTCOMES.has(item?.outcome) && copyPathShape(item.path)).map((item) => item.path);
}
