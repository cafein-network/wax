import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { GIT_BASE_ARGS, SCRATCH_PREFIX, createGitReader, defaultTimeout, emptyBlobId, gitAtLeast, gitEnv, runGit, runPipe, scratchTree, withScratch } from '../src/git-read.mjs';
import { gitEnv as freshnessEnv } from '../src/freshness.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, message = 'fixture') => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-git-read-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'a.txt'), 'one\n');
  await writeFile(join(root, 'b.txt'), 'two\n');
  commit(root);
  return root;
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
async function agedObjects(root) {
  const old = new Date('2020-01-01T00:00:00Z');
  const out = {};
  const walk = async (dir, touch) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, touch);
      else { if (touch) await utimes(path, old, old); const info = await lstat(path); out[relative(root, path).split(sep).join('/')] = `${info.size} ${info.mtimeMs}`; }
    }
  };
  await walk(join(root, '.git', 'objects'), true);
  return async () => { for (const key of Object.keys(out)) delete out[key]; await walk(join(root, '.git', 'objects'), false); return { ...out }; };
}
const scratchFolders = async () => (await readdir(tmpdir())).filter((name) => name.startsWith(SCRATCH_PREFIX));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('environment: location variables are dropped, optional locks and prompts are off; freshness uses the same function', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: '/elsewhere', GIT_INDEX_FILE: '/elsewhere/index', GIT_OBJECT_DIRECTORY: '/elsewhere/objects', GIT_WORK_TREE: '/x', GIT_OPTIONAL_LOCKS: '1' });
    const env = gitEnv();
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_WORK_TREE']) assert.equal(env[key], undefined, key);
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(freshnessEnv, gitEnv);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
  assert.deepEqual(GIT_BASE_ARGS.slice(0, 4), ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false']);
  assert.equal(defaultTimeout(['status', '--porcelain']), 10_000);
  assert.equal(defaultTimeout(['rev-parse', 'HEAD']), 5000);
  assert.ok(gitAtLeast('2.41.0', [2, 41]) && gitAtLeast('3.0', [2, 41]) && !gitAtLeast('2.40.9', [2, 41]) && !gitAtLeast(null, [2, 41]));
});

test('at most 4 git processes at once; local before network, lower priority (upper rows) first, then arrival order', async () => {
  const gates = [], order = [];
  let active = 0, peak = 0;
  const run = async (cwd, args) => {
    active++; peak = Math.max(peak, active); order.push(args[0]);
    const gate = deferred(); gates.push(gate);
    await gate.promise;
    active--;
    return { code: 0, stdout: args[0], stderr: '' };
  };
  const reader = createGitReader({ run });
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push(reader.git('/', [`first-${i}`]));
  jobs.push(reader.git('/', ['net'], { network: true }));
  jobs.push(reader.git('/', ['row-5'], { priority: 5 }));
  jobs.push(reader.git('/', ['row-1'], { priority: 1 }));
  jobs.push(reader.git('/', ['row-1b'], { priority: 1 }));
  await new Promise((done) => setImmediate(done));
  assert.equal(active, 4, 'four start at once');
  assert.equal(reader.stats().queued, 4);
  for (let i = 0; i < 8; i++) {
    gates[i].resolve();
    await new Promise((done) => setImmediate(done));
    await new Promise((done) => setImmediate(done));
  }
  await Promise.all(jobs);
  assert.equal(peak, 4);
  assert.deepEqual(order.slice(4), ['row-1', 'row-1b', 'row-5', 'net']);
});

test('time limits: a command over its limit rejects as timed out; status gets the longer default; an abort signal ends a queued or running command', async (t) => {
  const sleeper = ['-e', 'setTimeout(() => {}, 10000)'];
  await assert.rejects(runGit(process.cwd(), sleeper, { timeout: 400, file: process.execPath, base: [] }), (error) => error.timedOut === true);
  const seen = [];
  const reader = createGitReader({ run: async (cwd, args, options) => { seen.push([args[0], options.timeout]); return { code: 0, stdout: '', stderr: '' }; } });
  await reader.git('/', ['status']); await reader.git('/', ['rev-parse']); await reader.git('/', ['log'], { timeout: 1234 });
  assert.deepEqual(seen, [['status', 10_000], ['rev-parse', 5000], ['log', 1234]]);
  const stop = new AbortController();
  const running = runGit(process.cwd(), sleeper, { timeout: 20_000, file: process.execPath, base: [], signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(running, (error) => error.aborted === true);
  const gate = deferred();
  const busy = createGitReader({ concurrency: 1, run: async () => { await gate.promise; return { code: 0, stdout: '', stderr: '' }; } });
  const first = busy.git('/', ['one']);
  const queued = new AbortController();
  const second = busy.git('/', ['two'], { signal: queued.signal });
  queued.abort();
  gate.resolve();
  await first;
  await assert.rejects(second, (error) => error.aborted === true);
  assert.equal(busy.stats().started, 1);
  const root = await repo(t);
  const real = createGitReader();
  assert.match(await real.text(root, ['rev-parse', 'HEAD']), /^[a-f0-9]{40,64}\s*$/);
  await assert.rejects(real.text(root, ['rev-parse', '--verify', 'no-such-ref']), (error) => error.code === 128);
});

test('scratch: new objects and the temporary index stay in the OS temp folder, the project .git and index are untouched, and the folder is removed', async (t) => {
  const root = await repo(t);
  await writeFile(join(root, 'new.txt'), 'untracked\n');
  await writeFile(join(root, 'a.txt'), 'one\nchanged\n');
  const before = await gitFiles(root);
  const index = await stat(join(root, '.git', 'index'));
  const reader = createGitReader();
  let seenDir;
  const tree = await withScratch(root, async (scratch) => {
    seenDir = scratch.dir;
    const temp = await scratch.index(join(root, '.git', 'index'));
    const options = { scratch, index: temp };
    await reader.text(root, ['add', '-N', '--', 'new.txt'], options);
    const blob = (await reader.text(root, ['hash-object', '-w', '--', 'a.txt'], options)).trim();
    await reader.text(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},a.txt`], options);
    const written = (await reader.text(root, ['write-tree', '--missing-ok'], options)).trim();
    const made = (await reader.text(root, ['commit-tree', written, '-p', 'HEAD', '-m', 'scratch'], { ...options, env: { GIT_AUTHOR_NAME: 'wax', GIT_AUTHOR_EMAIL: 'wax@localhost.invalid',
      GIT_COMMITTER_NAME: 'wax', GIT_COMMITTER_EMAIL: 'wax@localhost.invalid', GIT_INDEX_FILE: join(root, '.git', 'index') } })).trim();
    assert.match(made, /^[a-f0-9]{40,64}$/);
    assert.ok((await readdir(scratch.objects)).some((name) => /^[a-f0-9]{2}$/.test(name)), 'objects were written to the scratch folder');
    assert.equal((await reader.text(root, ['cat-file', '-t', 'HEAD'], { scratch })).trim(), 'commit');
    assert.equal((await reader.text(root, ['cat-file', '-t', made], { scratch })).trim(), 'commit');
    return written;
  }, { reader });
  assert.match(tree, /^[a-f0-9]{40,64}$/);
  assert.throws(() => git(root, 'cat-file', '-e', tree));
  assert.deepEqual(await gitFiles(root), before, 'the project .git did not change');
  assert.equal((await stat(join(root, '.git', 'index'))).mtimeMs, index.mtimeMs);
  await assert.rejects(stat(seenDir), { code: 'ENOENT' });
  assert.ok((await scratchFolders()).every((name) => join(tmpdir(), name) !== seenDir), 'no wax-git-* folder of this call is left');
  git(root, 'hash-object', '-w', '--', 'new.txt');
  assert.notDeepEqual(await gitFiles(root), before);
});

test('a temporary index must be inside the scratch folder; without a scratch folder no index can be given', async (t) => {
  const root = await repo(t);
  const reader = createGitReader();
  assert.throws(() => reader.git(root, ['status'], { index: join(root, '.git', 'index') }), /scratch/);
  await withScratch(root, async (scratch) => {
    assert.throws(() => reader.git(root, ['status'], { scratch, index: join(root, '.git', 'index') }), /inside the scratch/);
    const empty = await scratch.index();
    assert.equal((await reader.text(root, ['ls-files'], { scratch, index: empty })).trim(), '', 'a new temporary index starts empty');
  }, { reader });
});

test('GIT_OPTIONAL_LOCKS=0: status through the reader does not rewrite a stale index, while plain git status does', { skip: process.platform === 'win32' && 'index refresh timing differs on Windows; the reader side is still checked by the board test' }, async (t) => {
  const root = await repo(t);
  const file = join(root, 'a.txt');
  const stale = async () => { const later = new Date(Date.now() + 5000 + Math.random() * 1000); await utimes(file, later, later); };
  await stale();
  const before = await gitFiles(root);
  const reader = createGitReader();
  await reader.text(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  await reader.text(root, ['diff-index', '--numstat', 'HEAD', '--']);
  assert.deepEqual(await gitFiles(root), before, 'reader status and diff-index leave .git/index alone');
  execFileSync('git', ['status', '--porcelain'], { cwd: root, env: { ...gitEnv(), GIT_OPTIONAL_LOCKS: '1' } });
  assert.notDeepEqual(await gitFiles(root), before, 'plain git status rewrites the index (so the check above can see a write)');
});

test('pipe: two git processes joined in Node (first stdout → second stdin); a failed first command is reported; a pipe takes two of the four slots', async (t) => {
  const root = await repo(t);
  await writeFile(join(root, 'a.txt'), 'one\nmore\n');
  commit(root, 'second');
  const reader = createGitReader();
  const piped = await reader.pipe(root, ['diff-tree', '-p', 'HEAD~1', 'HEAD', '--'], ['patch-id', '--verbatim']);
  assert.deepEqual([piped.code, piped.firstCode], [0, 0]);
  const expected = execFileSync('git', ['patch-id', '--verbatim'], { cwd: root, encoding: 'utf8', input: git(root, 'diff-tree', '-p', 'HEAD~1', 'HEAD', '--') + '\n' }).split(' ')[0];
  assert.equal(piped.stdout.split(' ')[0], expected, 'the same patch id as running the two by hand');
  const broken = await runPipe(root, ['diff-tree', '-p', 'no-such-commit', 'HEAD', '--'], ['patch-id', '--verbatim']);
  assert.notEqual(broken.firstCode, 0, 'the caller can tell the input was cut short');
  await assert.rejects(runPipe(root, ['diff-tree', '-p', 'HEAD~1', 'HEAD', '--'], ['patch-id'], { timeout: 1, file: process.execPath, base: ['-e', 'setTimeout(() => {}, 5000)'] }), (error) => error.timedOut === true);
  let active = 0, peak = 0;
  const hold = (weight) => async () => { active += weight; peak = Math.max(peak, active); await new Promise((done) => setTimeout(done, 10)); active -= weight; return { code: 0, stdout: '', stderr: '', firstCode: 0 }; };
  const counted = createGitReader({ run: hold(1), pipeRun: hold(2) });
  await Promise.all([...Array(5)].flatMap(() => [counted.pipe(root, ['a'], ['b']), counted.git(root, ['status']), counted.git(root, ['log'])]));
  assert.equal(peak <= 4, true, `peak ${peak}`);
  assert.equal(counted.stats().peak <= 4, true);
});

test('a temporary index copy keeps the source modification time, so git still re-reads files changed in the same second (racily clean entries)', async (t) => {
  const root = await repo(t);
  const source = join(root, '.git', 'index');
  const old = new Date(Date.now() - 60_000);
  await utimes(source, old, old);
  await withScratch(root, async (scratch) => {
    const copy = await scratch.index(source);
    assert.equal(Math.floor((await stat(copy)).mtimeMs / 1000), Math.floor(old.getTime() / 1000));
  });
});

test('scratchTree: the same tree as read-tree + update-index --add + write-tree, without rewriting (freshening) any existing loose or packed project object', async (t) => {
  for (const packed of [false, true]) {
    const root = await repo(t);
    git(root, 'config', 'maintenance.auto', 'false');
    git(root, 'config', 'gc.auto', '0');
    await mkdir(join(root, 'd', 'e'), { recursive: true });
    await mkdir(join(root, 'keep'));
    for (const [path, text] of [['d/x.txt', 'x\n'], ['d/e/y.txt', 'y\n'], ['d/e/z.txt', 'z\n'], ['keep/k.txt', 'k\n'], ['f', 'file\n'], ['run.sh', 'echo\n']]) await writeFile(join(root, path), text);
    commit(root, 'tree');
    if (packed) git(root, 'repack', '-a', '-d', '-q');
    await writeFile(join(root, 'a.txt'), 'two\n');
    await rm(join(root, 'd', 'e'), { recursive: true });
    await rm(join(root, 'keep'), { recursive: true });
    await rm(join(root, 'f'));
    await mkdir(join(root, 'f'));
    await writeFile(join(root, 'f', 'g.txt'), 'x\n');
    await mkdir(join(root, 'new', 'deep'), { recursive: true });
    await writeFile(join(root, 'new', 'deep', 'n.txt'), 'one\n');
    const paths = ['a.txt', 'd/e/y.txt', 'd/e/z.txt', 'keep/k.txt', 'f', 'f/g.txt', 'new/deep/n.txt'];
    if (process.platform !== 'win32') {
      await chmod(join(root, 'run.sh'), 0o755);
      await symlink('a.txt', join(root, 'link'));
      paths.push('run.sh', 'link');
    }
    const reader = createGitReader();
    const objects = await agedObjects(root);
    const before = await objects();
    const made = await withScratch(root, async (scratch) => {
      const run = (args, { index = null, input = '', binary = false } = {}) => reader.text(root, args, { scratch, index, input, ...(binary ? { encoding: 'buffer' } : {}) });
      const tree = await scratchTree(run, { base: 'HEAD', paths, index: await scratch.index(), objects: scratch.objects });
      assert.equal((await run(['cat-file', '-t', tree])).trim(), 'tree');
      await run(['-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', 'HEAD', '-m', 'C'], {});
      assert.equal(await scratchTree(run, { base: 'HEAD', paths: ['b.txt'], index: await scratch.index(), objects: scratch.objects }), git(root, 'rev-parse', 'HEAD^{tree}'));
      return tree;
    }, { reader });
    assert.deepEqual(await objects(), before, `${packed ? 'packed' : 'loose'}: no project object file was written or freshened`);
    const expected = await withScratch(root, async (scratch) => {
      const index = await scratch.index();
      await reader.text(root, ['read-tree', 'HEAD'], { scratch, index });
      await reader.text(root, ['update-index', '--add', '--remove', '-z', '--stdin'], { scratch, index, input: `${paths.join('\0')}\0` });
      return (await reader.text(root, ['write-tree'], { scratch, index })).trim();
    }, { reader });
    assert.equal(made, expected, `${packed ? 'packed' : 'loose'}: the same tree as write-tree`);
    assert.notDeepEqual(await objects(), before, 'the old way freshens existing objects');
  }
  assert.equal(emptyBlobId('a'.repeat(40)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(emptyBlobId('a'.repeat(64)), '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813');
});
