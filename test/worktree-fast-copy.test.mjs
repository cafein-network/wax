import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants as FS, promises as fsp } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, utimes, writeFile, chmod } from 'node:fs/promises';
import { join, posix, relative, sep, win32 } from 'node:path';
import { createTestSymlink, project } from './chat-helpers.mjs';
import { EventEmitter } from 'node:events';
import { CLONE_REFUSED, COPY_OUTCOMES, cloneTree, copiedPaths, copyFolders, insidePath, linkTargetSafe, parseMounts, volumeType } from '../src/worktree-copy.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const windows = process.platform === 'win32';
const real = windows ? { platform: 'linux' } : {};
const posixish = { platform: 'linux' };

async function setup(t, ignore = '.wax/\nnode_modules/\ndist\n') {
  const root = await realpath(await project(t));
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), ignore);
  await writeFile(join(root, 'shared.txt'), 'line\n');
  commit(root);
  const tree = join(root, '.wax', 'worktrees', 'goal-00000000-1');
  await mkdir(join(root, '.wax', 'worktrees'), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', 'wax/goal-00000000/f1-1', tree, 'HEAD');
  return { root, tree: await realpath(tree) };
}
async function gitFiles(root) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const info = await lstat(path); out[relative(join(root, '.git'), path).split(sep).join('/')] = `${info.size} ${info.mtimeMs}`; }
    }
  };
  await walk(join(root, '.git'));
  return out;
}
async function modules(root, files = 3) {
  await mkdir(join(root, 'node_modules', 'dep', 'lib'), { recursive: true });
  for (let i = 0; i < files; i++) await writeFile(join(root, 'node_modules', 'dep', 'lib', `f${i}.js`), `export default ${i};\n`);
  await writeFile(join(root, 'node_modules', 'dep', 'package.json'), '{"name":"dep"}\n');
}
const refusing = (code = 'ENOTSUP') => ({ copyFile: async (from, to, mode) => {
  if (mode & FS.COPYFILE_FICLONE_FORCE) throw Object.assign(new Error('no clone'), { code });
  return fsp.copyFile(from, to, mode);
} });

test('path helpers: insidePath uses the given path rules (win32: other drives and case-folded parents are not inside); link targets must stay in the worktree', () => {
  assert.equal(insidePath('/p', '/p/node_modules'), true);
  assert.equal(insidePath('/p', '/p'), false);
  assert.equal(insidePath('/p', '/p2/x'), false);
  assert.equal(insidePath('/p', '/x/../p/y'), true);
  const w = { relative: win32.relative, isAbsolute: win32.isAbsolute, sep: win32.sep };
  assert.equal(insidePath('C:\\proj', 'C:\\proj\\node_modules', w), true);
  assert.equal(insidePath('C:\\proj', 'D:\\proj\\node_modules', w), false, 'another drive: relative is an absolute path');
  assert.equal(insidePath('C:\\proj', 'C:\\other', w), false);
  assert.equal(insidePath('C:\\proj', '\\\\server\\share\\x', w), false);
  assert.equal(linkTargetSafe('node_modules/foo', '.pnpm/foo@1/node_modules/foo'), true);
  assert.equal(linkTargetSafe('node_modules/.pnpm/a@1/node_modules/b', '../../b@2/node_modules/b'), true);
  assert.equal(linkTargetSafe('node_modules/x', '../src/index.js'), true, 'another worktree file');
  assert.equal(linkTargetSafe('node_modules/x', '../../outside'), false);
  assert.equal(linkTargetSafe('node_modules/x', '/etc/passwd'), false);
  assert.equal(linkTargetSafe('node_modules/x', 'C:\\Windows'), false);
  assert.equal(linkTargetSafe('node_modules/x', 'C:foo'), false);
  assert.equal(linkTargetSafe('node_modules/x', '..\\..\\x'), false);
  assert.equal(linkTargetSafe('node_modules/x', '\\\\server\\share'), false);
  assert.equal(linkTargetSafe('node_modules/x', '../.git/config'), false);
  assert.equal(linkTargetSafe('node_modules/x', '../.env'), false);
  assert.equal(linkTargetSafe('node_modules/x', '../.wax/chat'), false);
  assert.equal(linkTargetSafe('node_modules/x', 'a/../../.GIT'), false);
  assert.equal(linkTargetSafe('node_modules/l', 'c/..', new Set(['node_modules/c'])), false);
  assert.equal(linkTargetSafe('node_modules/l', 'c', new Set(['node_modules/c'])), true, 'a link to a link is fine (each is checked)');
  for (const bad of ['', null, 'a\0b', 'a\nb']) assert.equal(linkTargetSafe('node_modules/x', bad), false, JSON.stringify(bad));
  assert.ok(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EPERM'].every((code) => CLONE_REFUSED.has(code)));
  assert.deepEqual(copiedPaths({ entries: [{ path: 'node_modules', outcome: 'cloned' }, { path: 'dist', outcome: 'copied' }, { path: 'x', outcome: 'missing' }, { path: '../up', outcome: 'cloned' }, { path: 7, outcome: 'copied' }] }),
    ['node_modules', 'dist']);
  assert.deepEqual(copiedPaths(null), []);
});

test('copy: an ignored folder is copied into the worktree (clone when the volume can, a plain copy otherwise) with the source times and modes; the project .git is unchanged', async (t) => {
  const { root, tree } = await setup(t);
  await modules(root);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'app.js'), 'built\n');
  const old = new Date('2024-01-02T03:04:05Z');
  await utimes(join(root, 'node_modules', 'dep', 'lib', 'f0.js'), old, old);
  if (!windows) await chmod(join(root, 'node_modules', 'dep', 'lib', 'f1.js'), 0o755);
  const before = await gitFiles(root);
  const result = await copyFolders(root, tree, ['node_modules', 'dist', 'packages/web/node_modules'], real);
  assert.equal(result.state, 'ok', 'a missing line is not a failure');
  if (process.platform === 'darwin') assert.equal(result.method, 'clone', 'APFS clones with cp -c');
  assert.ok(['clone', 'copy', 'mixed'].includes(result.method));
  const [mods, dist, missing] = result.entries;
  assert.equal(mods.path, 'node_modules');
  assert.ok(['cloned', 'copied'].includes(mods.outcome), mods.outcome);
  assert.equal(mods.files, 4);
  assert.equal(mods.cloned + mods.written, 4);
  assert.equal(mods.bytes, (await Promise.all(['lib/f0.js', 'lib/f1.js', 'lib/f2.js', 'package.json'].map((file) => stat(join(root, 'node_modules', 'dep', file))))).reduce((sum, info) => sum + info.size, 0));
  assert.ok(['cloned', 'copied'].includes(dist.outcome));
  assert.deepEqual(missing, { path: 'packages/web/node_modules', outcome: 'missing' });
  assert.equal(await readFile(join(tree, 'node_modules', 'dep', 'lib', 'f2.js'), 'utf8'), 'export default 2;\n');
  assert.equal(await readFile(join(tree, 'dist', 'app.js'), 'utf8'), 'built\n');
  assert.equal((await stat(join(tree, 'node_modules', 'dep', 'lib', 'f0.js'))).mtime.getTime(), old.getTime(), 'the source modification time is kept');
  if (!windows) assert.equal((await stat(join(tree, 'node_modules', 'dep', 'lib', 'f1.js'))).mode & 0o777, 0o755);
  assert.deepEqual(await gitFiles(root), before, 'the project .git (and the worktree index) is unchanged');
  assert.equal(git(tree, 'status', '--porcelain'), '', 'copied folders are ignored in the worktree');
  assert.equal(await readFile(join(root, 'node_modules', 'dep', 'lib', 'f2.js'), 'utf8'), 'export default 2;\n', 'the source is untouched');
  for (const entry of result.entries) assert.ok(COPY_OUTCOMES.includes(entry.outcome));
});

test('copy: a refused clone (ENOTSUP, EPERM) switches to a plain copy and counts written files; the 1 GB budget and twice the free space are checked', async (t) => {
  const { root, tree } = await setup(t);
  await modules(root);
  for (const code of ['ENOTSUP', 'EPERM']) {
    const into = join(tree, `try-${code}`);
    await mkdir(into);
    const result = await copyFolders(root, await realpath(into), ['node_modules'], { ...posixish, fs: refusing(code), ignoredRun: async () => ({ code: 0, stdout: 'node_modules/\0', stderr: '' }) });
    assert.equal(result.method, 'copy', code);
    assert.deepEqual(result.entries.map((item) => [item.outcome, item.cloned, item.written]), [['copied', 0, 4]], code);
    assert.equal(await readFile(join(into, 'node_modules', 'dep', 'lib', 'f1.js'), 'utf8'), 'export default 1;\n');
  }
  const broken = await copyFolders(root, tree, ['node_modules'], { ...posixish, fs: { copyFile: async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); } } });
  assert.equal(broken.entries[0].outcome, 'failed');
  assert.equal(await exists(join(tree, 'node_modules')), false, 'the partial copy is removed');
  for (const fs of [{ ...refusing() }, { ...refusing(), statfs: async () => ({ bavail: 1, bsize: 10 }) }, { ...refusing(), statfs: async () => { throw new Error('no statfs'); } }]) {
    const limits = fs.statfs ? {} : { plainBytes: 10 };
    const result = await copyFolders(root, tree, ['node_modules'], { ...posixish, fs, limits });
    assert.equal(result.entries[0].outcome, 'tooLarge');
    assert.equal(result.state, 'none');
    assert.equal(await exists(join(tree, 'node_modules')), false);
  }
  const cloning = { copyFile: async (from, to, mode) => fsp.copyFile(from, to, mode & ~FS.COPYFILE_FICLONE_FORCE) };
  const cloned = await copyFolders(root, tree, ['node_modules'], { ...posixish, fs: cloning, limits: { plainBytes: 1 } });
  assert.deepEqual(cloned.entries.map((item) => [item.outcome, item.cloned, item.written]), [['cloned', 4, 0]]);
  assert.equal(cloned.method, 'clone');
});

test('copy: the file count limit, a stop signal and the time limit remove the partial line; a stopped copy says stopped for every later line', async (t) => {
  const { root, tree } = await setup(t);
  await modules(root, 10);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'a.js'), 'x\n');
  const many = await copyFolders(root, tree, ['node_modules', 'dist'], { ...posixish, limits: { files: 5 } });
  assert.deepEqual(many.entries.map((item) => item.outcome), ['tooLarge', many.entries[1].outcome]);
  assert.ok(['cloned', 'copied'].includes(many.entries[1].outcome));
  assert.equal(many.state, 'partial');
  assert.equal(await exists(join(tree, 'node_modules')), false);
  await fsp.rm(join(tree, 'dist'), { recursive: true });
  const controller = new AbortController();
  let calls = 0;
  const stopping = { copyFile: async (from, to, mode) => { if (++calls === 3) controller.abort(); return fsp.copyFile(from, to, mode); } };
  const stopped = await copyFolders(root, tree, ['node_modules', 'dist'], { ...posixish, fs: stopping, signal: controller.signal });
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.entries.map((item) => item.outcome), ['stopped', 'stopped']);
  assert.equal(await exists(join(tree, 'node_modules')), false, 'the partial node_modules is removed');
  assert.equal(await exists(join(tree, 'dist')), false);
  const already = new AbortController(); already.abort();
  assert.equal((await copyFolders(root, tree, ['node_modules'], { ...posixish, signal: already.signal })).state, 'stopped');
  assert.equal(await exists(join(tree, 'node_modules')), false);
  let clock = 0;
  const now = () => clock;
  const slow = { copyFile: async (from, to, mode) => { clock += 60_000; return fsp.copyFile(from, to, mode); } };
  const late = await copyFolders(root, tree, ['node_modules', 'dist'], { ...posixish, fs: slow, now });
  assert.deepEqual(late.entries.map((item) => item.outcome), ['timeout', 'timeout']);
  assert.equal(await exists(join(tree, 'node_modules')), false);
});

test('copy: lines that are not ignored (project or worktree), contain tracked files, are blocked, already exist or are missing are skipped; nothing is overwritten', async (t) => {
  const { root, tree } = await setup(t, '.wax/\nnode_modules/\nvendor/\n');
  await writeFile(join(root, '.gitignore'), '.wax/\nnode_modules/\nvendor/\nbuild/\n');
  await mkdir(join(root, 'build'));
  await writeFile(join(root, 'build', 'out.js'), 'x\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.js'), 'x\n');
  await modules(root);
  await mkdir(join(tree, 'node_modules'));
  await writeFile(join(tree, 'node_modules', 'mine.js'), 'worker\n');
  const result = await copyFolders(root, tree, ['build', 'src', 'node_modules', 'gone', '.env.cache', 'a/.git'], real);
  assert.deepEqual(result.entries.map((item) => [item.path, item.outcome]), [['build', 'notIgnored'], ['src', 'notIgnored'], ['node_modules', 'exists'], ['gone', 'missing'],
    ['.env.cache', 'blocked'], ['a/.git', 'blocked']]);
  assert.equal(result.state, 'none');
  assert.equal(await exists(join(tree, 'build')), false);
  assert.deepEqual(await readdir(join(tree, 'node_modules')), ['mine.js'], 'an existing folder is not overwritten or merged');
  const second = await setup(t, '.wax/\nvendor/\n');
  await mkdir(join(second.root, 'vendor'));
  await writeFile(join(second.root, 'vendor', 'kept.js'), 'x\n');
  git(second.root, 'add', '-f', 'vendor/kept.js'); commit(second.root, 'tracked vendor');
  await writeFile(join(second.root, 'vendor', 'new.js'), 'x\n');
  assert.deepEqual((await copyFolders(second.root, second.tree, ['vendor'], posixish)).entries.map((item) => item.outcome), ['tracked']);
  const nogit = await copyFolders(root, tree, ['build'], { ...posixish, status: async () => { throw new Error('no git'); } });
  assert.deepEqual(nogit.entries.map((item) => item.outcome), ['failed']);
  const noWorktreeGit = await copyFolders(second.root, second.tree, ['vendor'], { ...posixish, status: async (r, paths) => paths.map((path) => ({ path, state: 'ready' })), ignoredRun: async () => { throw new Error('no git'); } });
  assert.deepEqual(noWorktreeGit.entries.map((item) => item.outcome), ['failed']);
});

test('copy on Windows (simulated): unsupported, nothing is copied', async (t) => {
  const { root, tree } = await setup(t);
  await modules(root);
  const result = await copyFolders(root, tree, ['node_modules'], { platform: 'win32' });
  assert.deepEqual(result, { state: 'unsupported', method: null, ms: 0, entries: [] });
  assert.equal(await exists(join(tree, 'node_modules')), false);
});

test('copy: a file that vanishes while copying is skipped and counted (partial); special files are skipped', async (t) => {
  const { root, tree } = await setup(t);
  await modules(root);
  let first = true;
  const vanishing = { copyFile: async (from, to, mode) => { if (from.endsWith('f1.js') && first) { first = false; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } return fsp.copyFile(from, to, mode); } };
  const result = await copyFolders(root, tree, ['node_modules'], { ...posixish, fs: vanishing });
  assert.ok(['cloned', 'copied'].includes(result.entries[0].outcome));
  assert.equal(result.entries[0].vanished, 1);
  assert.equal(result.state, 'partial');
  assert.equal(await exists(join(tree, 'node_modules', 'dep', 'lib', 'f1.js')), false);
  assert.equal(await exists(join(tree, 'node_modules', 'dep', 'lib', 'f2.js')), true);
  if (windows) return;
  const fifo = join(root, 'dist');
  await mkdir(fifo);
  await writeFile(join(fifo, 'a.js'), 'x\n');
  try { execFileSync('mkfifo', [join(fifo, 'pipe')]); } catch { return; }
  const special = await copyFolders(root, tree, ['dist'], posixish);
  assert.equal(special.entries[0].files, 1);
  assert.deepEqual(await readdir(join(tree, 'dist')), ['a.js']);
});

test('copy links: relative links inside the worktree are made as is (pnpm layout); an absolute, outside or chained link refuses the whole line; a link in the path is refused', async (t) => {
  if (windows) { t.skip('Windows writes relative link text with backslashes, and wax does not fast-copy on Windows'); return; }
  const { root, tree } = await setup(t);
  await mkdir(join(root, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'), 'x\n');
  if (!(await createTestSymlink(t, '.pnpm/dep@1/node_modules/dep', join(root, 'node_modules', 'dep'), 'dir'))) return;
  for (const way of [real, posixish]) {
    await fsp.rm(join(tree, 'node_modules'), { recursive: true, force: true });
    const ok = await copyFolders(root, tree, ['node_modules'], way);
    assert.ok(['cloned', 'copied'].includes(ok.entries[0].outcome), ok.entries[0].outcome);
  }
  assert.equal(await readlink(join(tree, 'node_modules', 'dep')), '.pnpm/dep@1/node_modules/dep', 'the link text is kept');
  assert.equal(await readFile(join(tree, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x\n');
  const outside = await realpath(await project(t));
  for (const [name, target] of [['abs', join(outside, 'x')], ['up', '../../../../../outside'], ['git', '../.git'], ['chain', 'c/..']]) {
    await fsp.rm(join(tree, 'dist'), { recursive: true, force: true });
    await fsp.rm(join(root, 'dist'), { recursive: true, force: true });
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'a.js'), 'x\n');
    if (name === 'chain') await createTestSymlink(t, '..', join(root, 'dist', 'c'), 'dir');
    await createTestSymlink(t, target, join(root, 'dist', 'l'), 'dir');
    for (const way of [real, posixish]) assert.equal((await copyFolders(root, tree, ['dist'], way)).entries[0].outcome, 'unsafeLink', name);
    assert.equal(await exists(join(tree, 'dist')), false, `${name}: nothing is left`);
  }
  await mkdir(join(outside, 'mods', 'x'), { recursive: true });
  await createTestSymlink(t, join(outside, 'mods'), join(root, 'linked'), 'dir');
  await writeFile(join(root, '.gitignore'), '.wax/\nnode_modules/\ndist\nlinked\npkg/\n');
  const linked = await copyFolders(root, tree, ['linked', 'linked/x'], posixish);
  assert.deepEqual(linked.entries.map((item) => item.outcome), ['unsafeLink', 'unsafeLink']);
  await mkdir(join(root, 'pkg', 'node_modules'), { recursive: true });
  await writeFile(join(root, 'pkg', 'node_modules', 'a.js'), 'x\n');
  await createTestSymlink(t, outside, join(tree, 'pkg'), 'dir');
  const parent = await copyFolders(root, tree, ['pkg/node_modules'], { ...posixish, ignoredRun: async () => ({ code: 0, stdout: 'pkg/node_modules/\0', stderr: '' }) });
  assert.deepEqual(parent.entries.map((item) => item.outcome), ['unsafeLink']);
  assert.equal(await exists(join(outside, 'node_modules')), false, 'nothing is written through the link');
  assert.equal(posix.join('a', 'b'), 'a/b');
});

const apfs = async () => [{ point: '/', type: 'apfs' }];
const fakeClone = (calls, after = async () => {}) => async (sources, target, options) => {
  calls.push({ sources, target, timeoutMs: options.timeoutMs });
  if (options.signal?.aborted) return 'stopped';
  const into = await lstat(target).then((info) => info.isDirectory(), () => false);
  for (const source of sources) await fsp.cp(source, into ? join(target, source.split(sep).at(-1)) : target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  await after(target);
  return 'ok';
};

test('macOS path (simulated): an APFS worktree copies each line with cp -c in up to 4 balanced chunks, then walks the copy again (links, file count, special files)', async (t) => {
  const { root, tree } = await setup(t);
  await mkdir(join(root, 'node_modules'));
  for (let i = 0; i < 40; i++) { await mkdir(join(root, 'node_modules', `p${i}`)); await writeFile(join(root, 'node_modules', `p${i}`, 'i.js'), `${i}\n`); }
  await writeFile(join(root, 'node_modules', '.package-lock.json'), '{}\n');
  const calls = [];
  const result = await copyFolders(root, tree, ['node_modules'], { platform: 'darwin', mounts: apfs, clone: fakeClone(calls) });
  assert.deepEqual(result.entries.map((item) => [item.outcome, item.files, item.cloned, item.written]), [['cloned', 41, 41, 0]]);
  assert.equal(result.method, 'clone');
  assert.ok(calls.length > 1 && calls.length <= 16, `chunks: ${calls.length}`);
  assert.ok(calls.every((call) => call.target === join(tree, 'node_modules') && call.timeoutMs > 0));
  assert.equal(new Set(calls.flatMap((call) => call.sources)).size, 41, 'every top entry once');
  assert.equal(await readFile(join(tree, 'node_modules', 'p39', 'i.js'), 'utf8'), '39\n');
  await fsp.rm(join(tree, 'node_modules'), { recursive: true });
  let planted = false;
  const sneaky = fakeClone([], async (target) => { if (await exists(join(target, 'p0')) && !planted) { planted = true; await createTestSymlink(t, '/etc', join(target, 'p0', 'evil'), 'dir'); } });
  if (!windows) {
    const refused = await copyFolders(root, tree, ['node_modules'], { platform: 'darwin', mounts: apfs, clone: sneaky });
    assert.equal(refused.entries[0].outcome, 'unsafeLink');
    assert.equal(await exists(join(tree, 'node_modules')), false);
  }
  for (const outcome of ['failed', 'stopped', 'timeout']) {
    const bad = await copyFolders(root, tree, ['node_modules'], { platform: 'darwin', mounts: apfs, clone: async () => outcome });
    assert.equal(bad.entries[0].outcome, outcome);
    assert.equal(await exists(join(tree, 'node_modules')), false, outcome);
  }
  const other = [];
  const plain = await copyFolders(root, tree, ['node_modules'], { platform: 'darwin', mounts: async () => [{ point: '/', type: 'hfs' }], clone: fakeClone(other), fs: refusing() });
  assert.deepEqual(other, []);
  assert.deepEqual(plain.entries.map((item) => item.outcome), ['copied']);
  await fsp.rm(join(tree, 'node_modules'), { recursive: true });
  assert.deepEqual((await copyFolders(root, tree, ['node_modules'], { platform: 'darwin', mounts: async () => null, clone: fakeClone(other), fs: refusing() })).entries.map((item) => item.outcome), ['copied']);
  assert.deepEqual(other, []);
});

test('mount table: the longest mount point that holds the path gives the volume type; cp -c is ended on stop and timeout', async () => {
  const mounts = parseMounts('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\ndevfs on /dev (devfs, local, nobrowse)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)\n/dev/disk5s1 on /Volumes/My Disk (hfs, local, nodev, nosuid)\nnonsense\n');
  assert.deepEqual(mounts.map((item) => [item.point, item.type]), [['/', 'apfs'], ['/dev', 'devfs'], ['/System/Volumes/Data', 'apfs'], ['/Volumes/My Disk', 'hfs']]);
  assert.equal(volumeType(mounts, '/private/tmp/p/.wax/worktrees/x'), 'apfs');
  assert.equal(volumeType(mounts, '/Volumes/My Disk/p/.wax/worktrees/x'), 'hfs');
  assert.equal(volumeType(mounts, '/Volumes/My Disk2/p'), 'apfs', 'a longer name is not inside');
  assert.equal(volumeType([], '/x'), null);
  const children = [];
  const spawn = (file, args, options) => { const child = Object.assign(new EventEmitter(), { killed: null, kill(sig) { this.killed = sig; setImmediate(() => this.emit('close', null, sig)); } }); children.push({ file, args, options, child }); return child; };
  const controller = new AbortController();
  const stopping = cloneTree(['/p/node_modules/a', '/p/node_modules/b'], '/w/node_modules', { signal: controller.signal, timeoutMs: 60_000, spawn });
  controller.abort();
  assert.equal(await stopping, 'stopped');
  assert.deepEqual([children[0].file, children[0].args, children[0].options.shell, children[0].child.killed], ['/bin/cp', ['-c', '-R', '-P', '/p/node_modules/a', '/p/node_modules/b', '/w/node_modules'], false, 'SIGKILL']);
  assert.equal(await cloneTree(['/a'], '/b', { timeoutMs: 1, spawn }), 'timeout');
  assert.equal(children[1].child.killed, 'SIGKILL');
  const ok = cloneTree(['/a'], '/b', { timeoutMs: 60_000, spawn });
  children[2].child.emit('close', 0);
  assert.equal(await ok, 'ok');
  const failed = cloneTree(['/a'], '/b', { timeoutMs: 60_000, spawn });
  children[3].child.emit('close', 1);
  assert.equal(await failed, 'failed');
  const already = new AbortController(); already.abort();
  assert.equal(await cloneTree(['/a'], '/b', { signal: already.signal, timeoutMs: 60_000, spawn }), 'stopped');
  assert.equal(children.length, 4, 'a stopped signal does not start cp');
});
