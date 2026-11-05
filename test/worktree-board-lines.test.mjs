import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { createGoal, readGoal } from '../src/chat/pm-loop.mjs';
import { createGitReader, runGit, runPipe } from '../src/git-read.mjs';
import { createBoardCache, worktreeBoard, worktreeRow } from '../src/worktree-board.mjs';
import { linesText } from '../web/worktree-board-text.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
const noPort = async () => false;

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

async function setup(t, features = ['f1']) {
  const root = await project(t, features);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'one\ntwo\nthree\n');
  commit(root);
  const goal = await createGoal(root, { title: '줄 수', features, worktrees: true }, { author: '대표' });
  const entries = [];
  for (const feature of features) entries.push((await prepareWorktree(root, await readGoal(root, goal.id), feature)).entry);
  return { root, entries };
}

test('lines: committed + uncommitted + untracked (intent-to-add on a temporary index), binary files counted apart; .git and the worktree index unchanged', async (t) => {
  const { root, entries: [one] } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  commit(one.path, 'worker adds two lines');
  await writeFile(join(one.path, 'shared.txt'), 'one\nTWO\nthree\nfour\nfive\n');
  await writeFile(join(one.path, 'new.txt'), 'a\nb\nc\n');
  await writeFile(join(one.path, 'image.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  const before = await gitFiles(root);
  const index = await stat(join(root, '.git', 'worktrees', one.id, 'index'));
  const board = await worktreeBoard(root, { probe: noPort, tiers: 3 });
  assert.deepEqual(await gitFiles(root), before, 'the project .git did not change (no objects, no index refresh)');
  assert.equal((await stat(join(root, '.git', 'worktrees', one.id, 'index'))).mtimeMs, index.mtimeMs, 'the worktree index was not rewritten');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: one.path, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  assert.equal(status.split('\n').filter((line) => line.startsWith('??')).length, 2, 'untracked files are still untracked');
  const row = board.rows[0];
  assert.deepEqual(row.git.lines, { added: 2 + 1 + 3, removed: 1, binary: 1 });
  assert.equal(row.tier, 3);
  assert.equal(linesText(row.git.lines, (id, ...values) => `${id}:${values.join(',')}`), 'worktreeBoard.lines:6,1 · worktreeBoard.linesBinary:1');
  assert.deepEqual((await worktreeRow(root, one.id, { tier: 2 })).lines, row.git.lines);
  assert.deepEqual(await gitFiles(root), before);
  const fast = await worktreeBoard(root, { probe: noPort, tiers: 1 });
  assert.deepEqual([fast.rows[0].git.lines, fast.rows[0].git.integration, fast.rows[0].tier], [null, null, 1]);
});

test('cache: commit-pair results are reused; more edits to the same uncommitted file make a new key and a new result', async (t) => {
  const { root, entries: [one] } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  await writeFile(join(root, 'shared.txt'), 'one\nworker\nthree\n');
  commit(root, 'import squashed');
  await writeFile(join(root, 'shared.txt'), 'one\nworker again\nthree\n');
  commit(root, 'main again');
  const cache = createBoardCache();
  let calls = 0;
  const reader = () => createGitReader({ run: (cwd, args, options) => { calls++; return runGit(cwd, args, options); }, pipeRun: (...args) => { calls++; return runPipe(...args); } });
  const first = await worktreeRow(root, one.id, { tier: 3, cache, reader: reader() });
  assert.equal(first.integration.reason, 'patch-id');
  const cold = calls;
  calls = 0;
  const second = await worktreeRow(root, one.id, { tier: 3, cache, reader: reader() });
  assert.deepEqual(second.integration, first.integration);
  assert.ok(calls < cold, `the cached check runs fewer git commands (${calls} < ${cold})`);
  assert.ok(cache.stats().hits >= 1);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker plus more\nthree\n');
  const third = await worktreeRow(root, one.id, { tier: 3, cache, reader: reader() });
  assert.deepEqual(third.integration, { integrated: false });
  const size = cache.stats().size;
  await worktreeBoard(root, { probe: noPort, tiers: 3, cache });
  await worktreeBoard(root, { probe: noPort, tiers: 3, cache });
  assert.ok(cache.stats().size >= size);
  const small = createBoardCache({ size: 2 });
  small.set('a', 1); small.set('b', 2); small.get('a'); small.set('c', 3);
  assert.deepEqual([small.get('a'), small.get('b'), small.get('c')], [1, undefined, 3], 'least recently used goes first');
});

test('at most 4 git processes at once with tiers 2-3 (a pipe takes two slots), counted with injected runners', async (t) => {
  const { root, entries } = await setup(t, ['f1', 'f2', 'f3']);
  for (const [index, entry] of entries.entries()) {
    await writeFile(join(entry.path, 'shared.txt'), `one\nworker ${index}\nthree\n`);
    await writeFile(join(entry.path, `new-${index}.txt`), 'x\n');
  }
  await writeFile(join(root, 'shared.txt'), 'one\nmain\nthree\n');
  commit(root, 'main conflicts with all of them');
  let active = 0, peak = 0, pipes = 0;
  const hold = async (weight, fn) => {
    active += weight; peak = Math.max(peak, active);
    try { await new Promise((done) => setTimeout(done, 5)); return await fn(); } finally { active -= weight; }
  };
  const reader = createGitReader({ run: (cwd, args, options) => hold(1, () => runGit(cwd, args, options)), pipeRun: (...args) => { pipes++; return hold(2, () => runPipe(...args)); } });
  const board = await worktreeBoard(root, { probe: noPort, tiers: 3, reader });
  assert.equal(board.rows.length, 3);
  assert.ok(pipes >= 2, `patch-id pipes ran (${pipes})`);
  assert.ok(peak <= 4, `peak ${peak}`);
  for (const row of board.rows) assert.deepEqual(row.git.integration, { integrated: false }, row.id);
});

test('more than 2000 uncommitted paths skip lines and the check (too many changes)', async (t) => {
  const { root, entries: [one] } = await setup(t);
  for (let i = 0; i < 6; i++) await writeFile(join(one.path, `f${i}.txt`), 'x\n');
  const board = await worktreeBoard(root, { probe: noPort, tiers: 3, limits: { gitRows: 50, rowMs: 15_000, tableMs: 60_000, uncommitted: 5, portMs: 50, patchCommits: 500, bytes: 64 * 1024 * 1024 } });
  const row = board.rows[0];
  assert.equal(row.git.tooMany, true);
  assert.equal(row.git.lines.tooMany, true);
  assert.deepEqual(row.git.integration, { integrated: null, reason: 'tooMany' });
});
