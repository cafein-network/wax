import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from './chat-helpers.mjs';
import { appendWorktree, readWorktrees } from '../src/worktrees.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { createGoal, readGoal } from '../src/chat/pm-loop.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createApproval } from '../src/approvals.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { createGitReader, runGit } from '../src/git-read.mjs';
import { BOARD_LIMITS, parseWorktreeList, portLink, probePort, worktreeBoard } from '../src/worktree-board.mjs';

const BIN = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
const person = '대표';
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
const log = (root, goal, record) => appendRecord(join(root, '.wax', 'chat', 'pm-loop', `${goal}.jsonl`), (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal, by: 'pm-loop', at: new Date().toISOString(), ...record }));

async function setup(t) {
  const root = await project(t, ['f1', 'f2']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'one\n');
  commit(root);
  const goal = await createGoal(root, { title: '현황판', features: ['f1', 'f2'], worktrees: true }, { author: person });
  const one = (await prepareWorktree(root, await readGoal(root, goal.id), 'f1')).entry;
  const two = (await prepareWorktree(root, await readGoal(root, goal.id), 'f2')).entry;
  await log(root, goal.id, { kind: 'worker', outcome: 'launched', worker: 'pw-0000aaa1', tool: 'claude', feature: 'f1', phase: 'implement', iteration: 0 });
  await log(root, goal.id, { kind: 'worktree', outcome: 'created', worker: 'pw-0000aaa1', feature: 'f1', phase: 'implement', worktree: one.id, branch: one.branch });
  await log(root, goal.id, { kind: 'worker', outcome: 'exited', result: 'done', worker: 'pw-0000aaa1', tool: 'claude', feature: 'f1', phase: 'implement', iteration: 0 });
  await log(root, goal.id, { kind: 'worker', outcome: 'launched', worker: 'pw-0000aaa2', tool: 'codex', feature: 'f2', phase: 'implement', iteration: 0 });
  await log(root, goal.id, { kind: 'worktree', outcome: 'created', worker: 'pw-0000aaa2', feature: 'f2', phase: 'implement', worktree: two.id, branch: two.branch });
  return { root, goal, one, two };
}
const row = (board, id) => board.rows.find((item) => item.id === id);

test('tiers 0 and 1: activity, last run, proof, setup, port; uncommitted, ahead/behind, base moved, last commit; the project .git and worktree index are unchanged', async (t) => {
  const { root, goal, one, two } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\n');
  commit(one.path, 'worker commit');
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nmore\n');
  await writeFile(join(one.path, 'new.txt'), 'new\n');
  const proof = await runTestProof(root, 'f1', [process.execPath, '-e', ''], { worktree: one.path });
  assert.equal(proof.recorded, true);
  await writeFile(join(one.path, 'later.txt'), 'after the test\n');
  await writeFile(join(root, 'main.txt'), 'main moves\n');
  commit(root, 'main commit');
  const before = await gitFiles(root);
  const index = await stat(join(root, '.git', 'worktrees', one.id, 'index'));
  const board = await worktreeBoard(root, { probe: async (port) => port === one.port });
  assert.deepEqual(await gitFiles(root), before, 'the project .git did not change');
  assert.equal((await stat(join(root, '.git', 'worktrees', one.id, 'index'))).mtimeMs, index.mtimeMs, 'the worktree index was not rewritten');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.deepEqual(board.project.target, { name: git(root, 'symbolic-ref', '--short', 'HEAD'), commit: head, detached: false });
  assert.equal(board.project.git.aheadBehind, 'for-each-ref');
  assert.deepEqual(board.rows.map((item) => item.id), [two.id, one.id], 'newest first');
  const a = row(board, one.id), b = row(board, two.id);
  assert.equal(a.goalTitle, '현황판');
  assert.deepEqual(a.activity, { kind: 'idle' });
  assert.equal(b.activity.kind, 'running');
  assert.equal(b.activity.tool, 'codex');
  assert.equal(b.lastRun.outcome, 'running');
  assert.deepEqual({ ...a.lastRun, at: undefined }, { phase: 'implement', tool: 'claude', outcome: 'done', at: undefined });
  assert.equal(a.git.tip, git(one.path, 'rev-parse', 'HEAD'));
  assert.equal(a.git.uncommitted, 3, 'shared.txt, new.txt, later.txt');
  assert.deepEqual([a.git.ahead, a.git.behind, a.git.baseMoved], [1, 1, 1]);
  assert.deepEqual([b.git.ahead, b.git.behind, b.git.uncommitted], [0, 1, 0]);
  assert.equal(a.git.lastCommit.subject, 'worker commit');
  assert.equal(a.git.lastCommit.tree, git(one.path, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(a.proof.outcome, 'passed');
  assert.equal(a.proof.changedSince, 1, 'later.txt changed after the test');
  assert.equal(a.proof.tree, undefined, 'the fingerprint is not sent');
  assert.equal(b.proof, null);
  assert.equal(a.createdAt !== null, true);
  assert.equal(a.link, `http://127.0.0.1:${one.port}`);
  assert.deepEqual([a.portUp, b.portUp], [true, false]);
  assert.equal(a.setup.outcome, 'none');
  assert.deepEqual([a.tier, a.issue, a.partial], [1, null, []]);
  assert.equal(goal.id, a.goal);
  const fast = await worktreeBoard(root, { tiers: 0 });
  assert.equal(row(fast, one.id).git, null);
  assert.equal(row(fast, one.id).proof.outcome, 'passed');
  assert.equal(row(fast, two.id).activity.kind, 'running');
});

test('Git before 2.41: rev-list --left-right --count per row gives the same ahead/behind as for-each-ref', async (t) => {
  const { root, one } = await setup(t);
  await writeFile(join(one.path, 'x.txt'), 'x\n');
  commit(one.path, 'one');
  await writeFile(join(one.path, 'y.txt'), 'y\n');
  commit(one.path, 'two');
  await writeFile(join(root, 'main.txt'), 'm\n');
  commit(root, 'main');
  const modern = await worktreeBoard(root, { probe: noPort });
  const old = await worktreeBoard(root, { probe: noPort, version: '2.37.0' });
  assert.equal(old.project.git.aheadBehind, 'rev-list');
  for (const item of modern.rows) {
    const other = row(old, item.id);
    assert.deepEqual([other.git.ahead, other.git.behind, other.git.baseMoved], [item.git.ahead, item.git.behind, item.git.baseMoved], item.id);
  }
  assert.deepEqual([row(modern, one.id).git.ahead, row(modern, one.id).git.behind], [2, 1]);
});

test('at most 4 git processes at once across rows (counted with an injected runner)', async (t) => {
  const { root } = await setup(t);
  let active = 0, peak = 0, calls = 0;
  const run = async (cwd, args, options) => {
    active++; calls++; peak = Math.max(peak, active);
    try { await new Promise((done) => setTimeout(done, 15)); return await runGit(cwd, args, options); } finally { active--; }
  };
  const board = await worktreeBoard(root, { reader: createGitReader({ run }), probe: noPort, version: '2.37.0' });
  assert.equal(board.rows.length, 2);
  assert.ok(calls >= 8, `enough git calls to queue (${calls})`);
  assert.equal(peak, 4);
});

test('a timed-out command empties only its cell; a row over its limit marks the rest timed out; other rows still fill', async (t) => {
  const { root, one, two } = await setup(t);
  const slowStatus = async (cwd, args, options) => {
    if (args[0] === 'status' && cwd === one.path) throw Object.assign(new Error('timed out'), { timedOut: true });
    return runGit(cwd, args, options);
  };
  const board = await worktreeBoard(root, { reader: createGitReader({ run: slowStatus }), probe: noPort });
  assert.deepEqual(row(board, one.id).partial, [{ cell: 'uncommitted', reason: 'timeout' }]);
  assert.equal(row(board, one.id).git.uncommitted, null);
  assert.equal(row(board, one.id).git.ahead, 0, 'other cells of that row are filled');
  assert.equal(row(board, two.id).git.uncommitted, 0);
  const hang = (cwd, args, options) => (args[0] === 'status' && cwd === two.path
    ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { aborted: true }))))
    : runGit(cwd, args, options));
  const limited = await worktreeBoard(root, { reader: createGitReader({ run: hang }), probe: noPort, limits: { ...BOARD_LIMITS, rowMs: 300 } });
  assert.deepEqual(row(limited, two.id).partial, [{ cell: 'uncommitted', reason: 'timeout' }]);
  assert.equal(row(limited, one.id).partial.length, 0);
});

test('waiting for you: a pending approval for the goal, or a last run that did not finish; engine memory overrides the records', async (t) => {
  const { root, goal, one, two } = await setup(t);
  const approval = await createApproval(root, { tool: 'claude', session: 's1', callId: 'c1', action: 'Bash: npm test', details: { command: 'npm test' }, goal: goal.id }, { timeoutMs: 60_000 });
  let board = await worktreeBoard(root, { tiers: 0 });
  assert.deepEqual(row(board, two.id).activity, { kind: 'waiting', reason: 'approval', approval: approval.request.id, action: 'Bash: npm test' });
  assert.deepEqual(row(board, one.id).activity, { kind: 'idle' }, 'the approval belongs to the running worker of that goal');
  await log(root, goal.id, { kind: 'worker', outcome: 'exited', result: 'blocked', worker: 'pw-0000aaa2', tool: 'codex', feature: 'f2', phase: 'implement', iteration: 0 });
  await rm(join(root, '.wax', 'approvals'), { recursive: true, force: true });
  board = await worktreeBoard(root, { tiers: 0 });
  assert.deepEqual(row(board, two.id).activity, { kind: 'waiting', reason: 'blocked', outcome: 'blocked' });
  assert.equal(row(board, two.id).lastRun.outcome, 'blocked');
  board = await worktreeBoard(root, { tiers: 0, running: [{ worker: 'pw-0000aaa9', goal: goal.id, feature: 'f1', tool: 'gemini', phase: 'review', worktree: one.id }], waiting: [] });
  assert.equal(row(board, one.id).activity.kind, 'running');
  assert.equal(row(board, one.id).activity.tool, 'gemini');
  assert.deepEqual(row(board, two.id).activity, { kind: 'idle' }, 'with engine cards given, the end record is not used');
  board = await worktreeBoard(root, { tiers: 0, running: [], waiting: [{ goal: goal.id, feature: 'f2', reason: '결정 필요' }] });
  assert.deepEqual(row(board, two.id).activity, { kind: 'waiting', reason: 'card', detail: '결정 필요' });
});

test('folder missing, removed rows only with all, the 50-row limit, goal filter', async (t) => {
  const { root, goal, one, two } = await setup(t);
  await rm(one.path, { recursive: true, force: true });
  let board = await worktreeBoard(root, { probe: noPort });
  assert.equal(row(board, one.id).issue, 'folderMissing');
  assert.equal(row(board, one.id).git.uncommitted, null);
  assert.equal(row(board, two.id).issue, null);
  const [entry] = (await readWorktrees(root)).filter((item) => item.id === one.id);
  await appendWorktree(root, { ...entry, state: 'removed', by: person });
  board = await worktreeBoard(root, { probe: noPort });
  assert.deepEqual([board.rows.map((item) => item.id), board.removedHidden], [[two.id], 1]);
  board = await worktreeBoard(root, { probe: noPort, all: true });
  assert.deepEqual(board.rows.map((item) => [item.id, item.state, item.tier]), [[one.id, 'removed', 0], [two.id, 'active', 1]]);
  const [second] = (await readWorktrees(root)).filter((item) => item.id === two.id);
  await appendWorktree(root, { ...second, state: 'imported', by: person });
  const limited = await worktreeBoard(root, { probe: noPort, all: true, limits: { ...BOARD_LIMITS, gitRows: 0 } });
  assert.deepEqual([limited.gitRows, limited.more, limited.rows.every((item) => item.git === null)], [0, 1, true]);
  assert.equal((await worktreeBoard(root, { goal: 'goal-00000000', tiers: 0 })).rows.length, 0);
  assert.equal((await worktreeBoard(root, { goal: goal.id, tiers: 0 })).rows.length, 1);
});

test('dev server link and check: only 1024-65535, connect check sees a listening port and a closed one', async (t) => {
  assert.equal(portLink(41001), 'http://127.0.0.1:41001', 'a numeric loopback address only');
  for (const bad of [80, 70000, 41001.5, '41001', null]) assert.equal(portLink(bad), null, String(bad));
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const { port } = server.address();
  if (port >= 1024) assert.equal(await probePort(port, { timeoutMs: 500 }), true);
  const closed = createServer(() => {});
  await new Promise((done) => closed.listen(0, '127.0.0.1', done));
  const free = closed.address().port;
  await new Promise((done) => closed.close(done));
  if (free >= 1024) assert.equal(await probePort(free, { timeoutMs: 500 }), false);
  assert.equal(await probePort(80), false, 'out-of-range ports are not checked');
  assert.deepEqual(parseWorktreeList('worktree /p\0HEAD abc\0branch refs/heads/main\0\0worktree /p/.wax/worktrees/goal-1\0HEAD abc\0detached\0prunable gone\0\0'),
    [{ path: '/p', head: 'abc', branch: 'refs/heads/main', prunable: false, detached: false }, { path: '/p/.wax/worktrees/goal-1', head: 'abc', branch: null, prunable: true, detached: true }]);
});

function wax(root, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'worktree', ...args, '--project', root], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: wax worktree list --json has the board shape; the text table is read-only and in the chosen language; bad usage exits 1', async (t) => {
  const { root, one, two } = await setup(t);
  await writeFile(join(one.path, 'new.txt'), 'n\n');
  const json = await wax(root, ['list', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const board = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(board).sort(), ['gitRows', 'more', 'partial', 'project', 'removedHidden', 'rows']);
  const first = board.rows.find((item) => item.id === one.id);
  assert.deepEqual(Object.keys(first).sort(), ['activity', 'branch', 'createdAt', 'feature', 'git', 'goal', 'goalTitle', 'id', 'issue', 'lastRun', 'link', 'partial', 'path', 'port', 'portUp', 'proof', 'setup', 'state', 'tier']);
  assert.deepEqual(Object.keys(first.git).sort(), ['ahead', 'base', 'baseMoved', 'behind', 'integration', 'lastCommit', 'lines', 'target', 'tip', 'tooMany', 'uncommitted']);
  assert.equal(first.git.uncommitted, 1);
  assert.deepEqual([first.tier, first.git.lines, first.git.integration], [3, { added: 1, removed: 0, binary: 0 }, { integrated: false }], 'the CLI fills tiers 2 and 3 by default');
  const fast = JSON.parse((await wax(root, ['list', '--json', '--fast'])).stdout);
  assert.deepEqual([fast.rows[0].tier, fast.rows[0].git.lines, fast.rows[0].git.integration], [1, null, null], '--fast leaves tiers 2 and 3 out');
  const text = await wax(root, ['list'], { WAX_LANG: 'en' });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`${two.id}  \\[active\\]  Worker running \\(Codex · implement\\)`));
  assert.match(text.stdout, /1 uncommitted files · 0 commits ahead · .+ moved 0 commits since/);
  assert.match(text.stdout, /Last run: implement · Claude Code · Worker finished/);
  assert.match(text.stdout, /Lines \+1 −0/);
  assert.match(text.stdout, /Not in .+ yet/);
  assert.match(text.stdout, /No changes/, 'the untouched worktree');
  assert.match(text.stdout, /Read-only/);
  assert.doesNotMatch(text.stdout.replaceAll('현황판', ''), /\p{Script=Hangul}/u, 'no Korean except the goal title the person wrote');
  const korean = await wax(root, ['list']);
  assert.match(korean.stdout, /쓰는 중/);
  const bad = await wax(root, ['remove']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /wax worktree: 사용법/);
  const help = await wax(root, ['--help'], { WAX_LANG: 'en' });
  assert.match(help.stdout, /wax worktree list/);
});
