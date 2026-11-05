import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { appendWorktree, readWorktrees } from '../src/worktrees.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { createGoal, readGoal } from '../src/chat/pm-loop.mjs';
import { finishBaseline, startBaseline } from '../src/worktree-baseline.mjs';
import { createGitReader, runGit, runPipe } from '../src/git-read.mjs';
import { BOARD_LIMITS, worktreeBoard, worktreeRow } from '../src/worktree-board.mjs';
import { integrationText } from '../web/worktree-board-text.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
const noPort = async () => false;

async function setup(t) {
  const root = await project(t, ['f1']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'other.txt'), 'other\n');
  commit(root);
  const goal = await createGoal(root, { title: '판정', features: ['f1'], worktrees: true }, { author: '대표' });
  const one = (await prepareWorktree(root, await readGoal(root, goal.id), 'f1')).entry;
  return { root, one, branch: one.branch };
}
async function agedObjects(root) {
  const old = new Date('2020-01-01T00:00:00Z');
  const read = async (touch) => {
    const out = {};
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else { if (touch) await utimes(path, old, old); const info = await lstat(path); out[relative(root, path).split(sep).join('/')] = `${info.size} ${info.mtimeMs}`; }
      }
    };
    await walk(join(root, '.git', 'objects'));
    return out;
  };
  await read(true);
  return () => read(false);
}
const judged = async (root, id, options = {}) => (await worktreeBoard(root, { probe: noPort, tiers: 3, ...options })).rows.find((row) => row.id === id).git.integration;

test('1-2: the same commit and an ancestor (fast-forwarded); a fresh worktree reads as no changes', async (t) => {
  const { root, one, branch } = await setup(t);
  const fresh = await worktreeBoard(root, { probe: noPort, tiers: 3 });
  const row = fresh.rows[0];
  assert.deepEqual(row.git.integration, { integrated: true, reason: 'same-commit' });
  assert.equal(integrationText(row.git.integration, { target: fresh.project.target, git: row.git }).kind, 'noChanges', 'nothing was done in it');
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  commit(one.path, 'worker');
  git(root, 'merge', '-q', '--ff-only', branch);
  const board = await worktreeBoard(root, { probe: noPort, tiers: 3 });
  assert.deepEqual(board.rows[0].git.integration, { integrated: true, reason: 'same-commit' });
  assert.equal(integrationText(board.rows[0].git.integration, { target: board.project.target, git: board.rows[0].git }).kind, 'integrated');
  await writeFile(join(root, 'other.txt'), 'main moves on\n');
  commit(root, 'main');
  assert.deepEqual(await judged(root, one.id), { integrated: true, reason: 'ancestor' });
});

test('3-4: no changes (a change and its revert), the same tree (main made the same change itself)', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  commit(one.path, 'change');
  await writeFile(join(one.path, 'shared.txt'), 'one\ntwo\nthree\n');
  commit(one.path, 'revert');
  await writeFile(join(root, 'other.txt'), 'main\n');
  commit(root, 'main');
  assert.deepEqual(await judged(root, one.id), { integrated: true, reason: 'no-changes' });
  const two = await setup(t);
  await writeFile(join(two.one.path, 'shared.txt'), 'one\nsame\nthree\n');
  commit(two.one.path, 'worker');
  await writeFile(join(two.root, 'shared.txt'), 'one\nsame\nthree\n');
  commit(two.root, 'main did the same');
  assert.deepEqual(await judged(two.root, two.one.id), { integrated: true, reason: 'same-tree' });
});

test('an uncommitted change main already has (same tree through C) and an untracked file: no project object is written or freshened, loose or packed', async (t) => {
  for (const packed of [false, true]) {
    const { root, one } = await setup(t);
    await writeFile(join(root, 'shared.txt'), 'one\nsame\nthree\n');
    await writeFile(join(root, 'empty.txt'), '');
    commit(root, 'main');
    if (packed) git(root, 'repack', '-a', '-d', '-q');
    await writeFile(join(one.path, 'shared.txt'), 'one\nsame\nthree\n');
    await writeFile(join(one.path, 'empty.txt'), '');
    const objects = await agedObjects(root);
    const before = await objects();
    const label = packed ? 'packed' : 'loose';
    assert.deepEqual(await judged(root, one.id), { integrated: true, reason: 'same-tree' }, label);
    assert.deepEqual(await objects(), before, `${label}: making C did not freshen existing blobs or trees`);
    assert.deepEqual((await worktreeRow(root, one.id, { tier: 2 })).lines, { added: 1, removed: 1, binary: 0 }, label);
    assert.deepEqual(await objects(), before, `${label}: lines did not freshen the empty blob`);
  }
});

test('5: a squash with main changing another file merges to main itself; with Git 2.37 step 5 is skipped and the patch-id finds it', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  commit(one.path, 'worker');
  await writeFile(join(root, 'shared.txt'), 'one\nworker\nthree\n');
  commit(root, 'squash');
  await writeFile(join(root, 'other.txt'), 'main more\n');
  commit(root, 'main more');
  assert.deepEqual(await judged(root, one.id), { integrated: true, reason: 'merge-adds-nothing' });
  const old = await judged(root, one.id, { version: '2.37.0' });
  assert.equal(old.reason, 'patch-id');
  assert.equal(old.commit, git(root, 'rev-parse', 'HEAD~1'));
});

test('6: main squashed the change and then edited the same line: merge-tree conflicts and the patch-id matches; committed and uncommitted', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  commit(one.path, 'worker');
  await writeFile(join(root, 'shared.txt'), 'one\nworker\nthree\n');
  commit(root, 'squash');
  const squash = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'shared.txt'), 'one\nworker edited again\nthree\n');
  commit(root, 'main edits the same line');
  assert.deepEqual(await judged(root, one.id), { integrated: true, reason: 'patch-id', commit: squash });
  const text = integrationText({ integrated: true, reason: 'patch-id', commit: squash }, { target: { name: 'main' } });
  assert.match(text.text, new RegExp(squash.slice(0, 7)));
  const dirty = await setup(t);
  await writeFile(join(dirty.one.path, 'shared.txt'), 'one\nworker\nthree\n');
  await writeFile(join(dirty.one.path, 'added.txt'), 'new file\n');
  await writeFile(join(dirty.root, 'shared.txt'), 'one\nworker\nthree\n');
  await writeFile(join(dirty.root, 'added.txt'), 'new file\n');
  commit(dirty.root, 'import squashed');
  const imported = git(dirty.root, 'rev-parse', 'HEAD');
  await writeFile(join(dirty.root, 'shared.txt'), 'one\nworker but better\nthree\n');
  commit(dirty.root, 'main again');
  assert.deepEqual(await judged(dirty.root, dirty.one.id), { integrated: true, reason: 'patch-id', commit: imported });
});

test('6 does not match: two cherry-picks, or a change that differs only in tabs and spaces', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  commit(one.path, 'a');
  await writeFile(join(one.path, 'other.txt'), 'other worker\n');
  commit(one.path, 'b');
  await writeFile(join(root, 'third.txt'), 'main first\n');
  commit(root, 'main moves first');
  git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'cherry-pick', `${one.branch}~1`, one.branch);
  await writeFile(join(root, 'shared.txt'), 'one\nworker later\nthree\n');
  commit(root, 'conflict');
  assert.deepEqual(await judged(root, one.id), { integrated: false });
  const ws = await setup(t);
  await writeFile(join(ws.one.path, 'shared.txt'), 'one\nx\ty\nthree\n');
  commit(ws.one.path, 'tab');
  await writeFile(join(ws.root, 'shared.txt'), 'one\nx y\nthree\n');
  commit(ws.root, 'space');
  await writeFile(join(ws.root, 'shared.txt'), 'one\nx y z\nthree\n');
  commit(ws.root, 'conflict');
  assert.deepEqual(await judged(ws.root, ws.one.id), { integrated: false });
});

test('an uncommitted new file means it is not the same commit; setup output in the baseline is left out of C', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'new.txt'), 'new\n');
  assert.deepEqual(await judged(root, one.id), { integrated: false });
  const two = await setup(t);
  const start = await startBaseline(two.root, two.one.id, { dir: two.one.path });
  await mkdir(join(two.one.path, 'vendor'));
  await writeFile(join(two.one.path, 'vendor', 'lib.js'), 'export default 1;\n');
  const baseline = await finishBaseline(two.root, two.one.id, start, { dir: two.one.path });
  assert.equal(baseline.state, 'ok');
  const [entry] = (await readWorktrees(two.root)).filter((item) => item.id === two.one.id);
  await appendWorktree(two.root, { ...entry, setup: { hash: null, outcome: 'ok', baseline }, by: '대표', at: undefined });
  assert.deepEqual(await judged(two.root, two.one.id), { integrated: true, reason: 'same-commit' });
  await writeFile(join(two.one.path, 'vendor', 'lib.js'), 'export default 2;\n');
  assert.deepEqual(await judged(two.root, two.one.id), { integrated: false });
});

test('the 500-commit cap says too old to check; a Git without patch-id --verbatim says unknown; a timed-out merge-tree is unknown', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  commit(one.path, 'worker');
  await writeFile(join(root, 'shared.txt'), 'one\nworker\nthree\n');
  commit(root, 'squash');
  await writeFile(join(root, 'shared.txt'), 'one\nworker again\nthree\n');
  commit(root, 'again');
  assert.deepEqual(await judged(root, one.id, { limits: { ...BOARD_LIMITS, patchCommits: 1 } }), { integrated: null, reason: 'tooDeep', commits: 2 });
  const noVerbatim = createGitReader({ pipeRun: async (cwd, first, second, options) => (second[0] === 'patch-id' ? { code: 129, firstCode: 0, stdout: '', stderr: 'usage' } : runPipe(cwd, first, second, options)) });
  assert.deepEqual(await judged(root, one.id, { reader: noVerbatim }), { integrated: null, reason: 'gitOld' });
  const slow = createGitReader({ run: async (cwd, args, options) => (args.includes('merge-tree') ? Promise.reject(Object.assign(new Error('timed out'), { timedOut: true })) : runGit(cwd, args, options)) });
  const board = await worktreeBoard(root, { probe: noPort, tiers: 3, reader: slow });
  assert.deepEqual(board.rows[0].git.integration, { integrated: null, reason: 'timeout' });
  assert.deepEqual(board.rows[0].partial, [{ cell: 'integration', reason: 'timeout' }]);
  assert.deepEqual((await worktreeRow(root, one.id, { tier: 3 })).integration, { integrated: true, reason: 'patch-id', commit: git(root, 'rev-parse', 'HEAD~1') });
  assert.equal(await worktreeRow(root, 'goal-00000000-1', { tier: 3 }), null);
});
