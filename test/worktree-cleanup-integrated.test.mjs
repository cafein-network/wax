import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { readWorktrees, validWorktreeRecord } from '../src/worktrees.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { mergeTreeSupported } from '../src/worktree-import.mjs';
import { cleanupIntegratedWorktree, createGoal, discardGoalWorktree, readDecisions, readGoal } from '../src/chat/pm-loop.mjs';
import { createBoardCache, integrationFingerprint, worktreeRow } from '../src/worktree-board.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const modern = mergeTreeSupported(git(process.cwd(), '--version').match(/(\d+\.\d+)/)[1]);
const person = '대표';

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

async function setup(t) {
  const root = await project(t, ['f1', 'f2', 'f3']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\nnode_modules/\n');
  await writeFile(join(root, 'shared.txt'), 'one\ntwo\nthree\n');
  commit(root);
  const goal = await createGoal(root, { title: '정리 제안', features: ['f1', 'f2'], worktrees: true }, { author: person });
  const one = (await prepareWorktree(root, await readGoal(root, goal.id), 'f1')).entry;
  const two = (await prepareWorktree(root, await readGoal(root, goal.id), 'f2')).entry;
  await writeFile(join(one.path, 'shared.txt'), 'one\nworker\nthree\n');
  await writeFile(join(root, 'shared.txt'), 'one\nworker\nthree\n');
  commit(root, 'Import f1');
  await writeFile(join(two.path, 'new.txt'), 'not yet\n');
  return { root, goal, one, two };
}
async function runningWorker(root, goal, feature = 'f2') {
  await appendRecord(join(root, '.wax', 'chat', 'pm-loop', `${goal}.jsonl`), (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal, kind: 'worker', outcome: 'launched',
    worker: 'pw-0000aaaa', tool: 'claude', feature, phase: 'implement', iteration: 0, by: person, at: new Date().toISOString() }));
}

test('the check gives a fingerprint only to an active worktree already in main; the fingerprint is the same with and without the memory cache', async (t) => {
  const { root, one, two } = await setup(t);
  const first = await worktreeRow(root, one.id, { tier: 3 });
  assert.equal(first.integration.integrated, true);
  assert.match(first.cleanup.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await worktreeRow(root, one.id, { tier: 3 })).cleanup.fingerprint, first.cleanup.fingerprint, 'the same state gives the same fingerprint (C is fixed)');
  const cache = createBoardCache();
  assert.equal((await worktreeRow(root, one.id, { tier: 3, cache })).cleanup.fingerprint, first.cleanup.fingerprint);
  assert.equal((await worktreeRow(root, one.id, { tier: 3, cache })).cleanup.fingerprint, first.cleanup.fingerprint, 'a cache hit keeps C');
  assert.ok(cache.stats().hits >= 1);
  const tip = git(root, 'rev-parse', one.branch), T = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(integrationFingerprint({ id: one.id, tip, T, C: null, reason: first.integration.reason }), first.cleanup.fingerprint, 'C (the uncommitted change) is part of it');
  const notYet = await worktreeRow(root, two.id, { tier: 3 });
  assert.equal(notYet.integration.integrated, false);
  assert.equal(notYet.cleanup, undefined);
  assert.equal((await worktreeRow(root, two.id, { tier: 2 })).cleanup, undefined, 'tier 2 has no cleanup');
});

test('clean up recomputes without cache: same fingerprint removes the folder (hooks off), the branch stays, the list says removed (integrated), .git loses only worktrees/<id>/', { skip: !modern }, async (t) => {
  const { root, goal, one, two } = await setup(t);
  const seen = (await worktreeRow(root, one.id, { tier: 3 })).cleanup.fingerprint;
  await mkdir(join(one.path, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(one.path, 'node_modules', 'pkg', 'index.js'), 'ignored\n');
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await writeFile(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch "$GIT_DIR/../hook-ran"\n', { mode: 0o755 });
  const branches = git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/wax/');
  const before = await gitFiles(root);
  let rechecks = 0;
  const recheck = async (dir, id) => { rechecks++; return worktreeRow(dir, id, { tier: 3 }); };
  const result = await cleanupIntegratedWorktree(root, goal.id, one.id, { author: person, fingerprint: seen, recheck });
  assert.equal(rechecks, 1);
  assert.deepEqual([result.worktree, result.branch, result.outcome, result.integration.integrated], [one.id, one.branch, 'removed', true]);
  assert.equal(result.branchCommand, `git branch -D ${one.branch}`);
  assert.equal(await exists(one.path), false, 'the folder (ignored files too) is gone');
  assert.equal(await exists(two.path), true, 'the other worktree stays');
  assert.equal(git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/wax/'), branches, 'branches are kept');
  assert.equal(await exists(join(root, 'hook-ran')), false);
  const after = await gitFiles(root);
  for (const path of Object.keys(before).filter((path) => !(path in after))) assert.ok(path.startsWith(`worktrees/${one.id}/`), `unexpected removal ${path}`);
  assert.deepEqual(Object.keys(after).filter((path) => !(path in before)), [], 'nothing added to .git');
  const same = (path) => (path.startsWith('objects/') ? before[path].split(' ')[0] === after[path].split(' ')[0] : before[path] === after[path]);
  assert.deepEqual(Object.keys(after).filter((path) => !same(path)), [], 'nothing else in .git changed');
  const entry = (await readWorktrees(root)).find((item) => item.id === one.id);
  assert.deepEqual([entry.state, entry.reason, entry.by], ['removed', 'integrated', person]);
  const logged = (await readDecisions(root, goal.id)).filter((item) => item.kind === 'worktree' && item.outcome === 'cleaned').at(-1);
  assert.deepEqual([logged.removed, logged.integration, logged.by], [[one.id], result.integration.reason, person]);
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author: person, fingerprint: seen }), (error) => error.status === 409);
});

test('409 and nothing deleted: the worktree changed after the look, a stale fingerprint, not in main, a running worker, not active; 404 for another goal', { skip: !modern }, async (t) => {
  const { root, goal, one, two } = await setup(t);
  const seen = (await worktreeRow(root, one.id, { tier: 3 })).cleanup.fingerprint;
  await writeFile(join(one.path, 'extra.txt'), 'new work\n');
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author: person, fingerprint: seen }), (error) => error.status === 409 && error.message.includes(one.id));
  assert.equal(await exists(one.path), true);
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author: person, fingerprint: 'x'.repeat(64) }), (error) => error.status === 409);
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author: person }), (error) => error.status === 409, 'no fingerprint');
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, two.id, { author: person, fingerprint: seen }), (error) => error.status === 409, 'not in main');
  assert.equal(await exists(two.path), true);
  await rm(join(one.path, 'extra.txt'));
  const fresh = (await worktreeRow(root, one.id, { tier: 3 })).cleanup.fingerprint;
  assert.equal(fresh, seen, 'back to the same state, the same fingerprint');
  const other = await createGoal(root, { title: '다른 목표', features: ['f3'] }, { author: person });
  await assert.rejects(cleanupIntegratedWorktree(root, other.id, one.id, { author: person, fingerprint: fresh }), (error) => error.status === 404);
  await runningWorker(root, goal.id);
  let rechecks = 0;
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author: person, fingerprint: fresh, recheck: async () => { rechecks++; return null; } }),
    (error) => error.status === 409 && error.message.includes(goal.id));
  assert.equal(rechecks, 0);
  assert.equal(await exists(one.path), true);
  assert.equal((await readWorktrees(root)).find((item) => item.id === one.id).state, 'active');
});

test('a discarded worktree is not removed this way (409, use the goal cleanup); the list accepts reason only on a removed line as integrated', async (t) => {
  const { root, goal, one } = await setup(t);
  const seen = (await worktreeRow(root, one.id, { tier: 3 })).cleanup.fingerprint;
  await discardGoalWorktree(root, goal.id, one.id, { author: person });
  assert.equal((await worktreeRow(root, one.id, { tier: 3 })).cleanup, undefined, 'no fingerprint for a worktree that is not active');
  await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author: person, fingerprint: seen }), (error) => error.status === 409);
  assert.equal(await exists(one.path), true);
  const line = (await readWorktrees(root)).find((item) => item.id === one.id);
  assert.equal(validWorktreeRecord({ ...line, state: 'removed', reason: 'integrated' }), true);
  assert.equal(validWorktreeRecord({ ...line, state: 'active', reason: 'integrated' }), false);
  assert.equal(validWorktreeRecord({ ...line, state: 'removed', reason: 'other' }), false);
});

test('people only: the engine, auto and worker names get 403; the dashboard API needs the token, refuses a stale fingerprint (409) and removes on the right one', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) {
    await assert.rejects(cleanupIntegratedWorktree(root, goal.id, one.id, { author, fingerprint: 'x' }), (error) => error.status === 403, author);
  }
  const server = createChatServer({ root, env: { WAX_CHAT_USER: person, WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: async () => [] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const path = `/api/pm-loop/${goal.id}/worktrees/${one.id}/cleanup-integrated`;
  assert.equal((await post(path, {}, {})).status, 403, 'no token');
  const row = await (await fetch(`${base}/api/worktree-board/${one.id}?tier=3`)).json();
  assert.match(row.cleanup.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await post(path, { fingerprint: 'stale' })).status, 409);
  assert.equal(await exists(one.path), true);
  const response = await post(path, { fingerprint: row.cleanup.fingerprint });
  assert.equal(response.status, 200);
  const done = await response.json();
  assert.deepEqual([done.worktree, done.outcome, done.branchCommand], [one.id, 'removed', `git branch -D ${one.branch}`]);
  assert.equal(await exists(one.path), false);
  const board = await (await fetch(`${base}/api/worktree-board`)).json();
  assert.equal(board.rows.some((item) => item.id === one.id), false, 'the row is gone from the board');
});
