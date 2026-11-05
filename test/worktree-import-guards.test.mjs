import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { readWorktrees } from '../src/worktrees.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { applyImport, mergeTreeSupported, previewImport } from '../src/worktree-import.mjs';
import { decideSetup, readSetup, setupDecisions, setupReview, setupState } from '../src/worktree-setup.mjs';
import { cleanupGoalWorktrees, createGoal, discardGoalWorktree, featureDecisions, goalOverview, importWorktree, previewRunRestore, previewWorktreeImport, readDecisions, readGoal, restoreRun } from '../src/chat/pm-loop.mjs';
import { listRuns } from '../src/snapshots.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const posix = process.platform !== 'win32';
const realGit = git(process.cwd(), '--version').match(/(\d+\.\d+)/)[1];
const modern = mergeTreeSupported(realGit);

async function repo(t, features = ['f1', 'f2']) {
  const root = await project(t, features);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'old.txt'), 'remove me\n');
  await writeFile(join(root, 'keep.txt'), 'keep\n');
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
const person = '대표';
async function setup(t) {
  const root = await repo(t);
  const goal = await createGoal(root, { title: '가져오기', features: ['f1', 'f2'], worktrees: true }, { author: person });
  const one = (await prepareWorktree(root, await readGoal(root, goal.id), 'f1')).entry;
  const two = (await prepareWorktree(root, await readGoal(root, goal.id), 'f2')).entry;
  return { root, goal, one, two };
}
async function runningWorker(root, goal, feature = 'f1') {
  await appendRecord(join(root, '.wax', 'chat', 'pm-loop', `${goal}.jsonl`), (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal, kind: 'worker', outcome: 'launched',
    worker: 'pw-0000aaaa', tool: 'claude', feature, phase: 'implement', iteration: 0, by: person, at: new Date().toISOString() }));
}

test('a dirty project (untracked or modified, .wax/ aside) is refused with 409; .wax/ changes do not count', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'changed\n');
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  await writeFile(join(root, '.wax', 'tmp', 'note.md'), 'wax files do not count\n');
  const ok = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(ok.dirtyCount, 0);
  await writeFile(join(root, 'scratch.txt'), 'mine\n');
  const preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.deepEqual([preview.dirty, preview.ready], [['scratch.txt'], false]);
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: ok.fingerprint }), (error) => error.status === 409 && /scratch\.txt/.test(error.message));
  await rm(join(root, 'scratch.txt'));
  await writeFile(join(root, 'keep.txt'), 'edited\n');
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: ok.fingerprint }), (error) => error.status === 409 && /keep\.txt/.test(error.message));
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('a running worker of the goal (or one in the project folder) refuses import with 409; a changed fingerprint refuses with 409', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'v1\n');
  const preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  await writeFile(join(one.path, 'shared.txt'), 'v2\n');
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: preview.fingerprint }), (error) => error.status === 409 && /preview/i.test(error.message) || /미리보기/.test(error.message));
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: 'x' }), (error) => error.status === 409);
  const fresh = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  await runningWorker(root, goal.id, 'f2');
  assert.equal((await previewWorktreeImport(root, goal.id, one.id, { author: person })).busy, goal.id);
  assert.equal((await previewWorktreeImport(root, goal.id, one.id, { author: person })).ready, false);
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: fresh.fingerprint }), (error) => error.status === 409 && error.message.includes(goal.id));
  await assert.rejects(discardGoalWorktree(root, goal.id, one.id, { author: person }), (error) => error.status === 409);
  await assert.rejects(cleanupGoalWorktrees(root, goal.id, { author: person }), (error) => error.status === 409);
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('another goal without isolated branches running a worker in the project folder also blocks import; one running in its own worktrees does not', { skip: !modern }, async (t) => {
  const root = await repo(t, ['f1', 'f2', 'f3']);
  const goal = await createGoal(root, { title: '가져오기', features: ['f1'], worktrees: true }, { author: person });
  const one = (await prepareWorktree(root, await readGoal(root, goal.id), 'f1')).entry;
  await writeFile(join(one.path, 'shared.txt'), 'v1\n');
  const plain = await createGoal(root, { title: '폴더', features: ['f2'] }, { author: person });
  const isolated = await createGoal(root, { title: '격리2', features: ['f3'], worktrees: true }, { author: person });
  await runningWorker(root, isolated.id, 'f3');
  assert.equal((await previewWorktreeImport(root, goal.id, one.id, { author: person })).busy, null);
  await runningWorker(root, plain.id, 'f2');
  assert.equal((await previewWorktreeImport(root, goal.id, one.id, { author: person })).busy, plain.id);
});

test('Git older than 2.38: the preview turns import off and lists the commands to run instead; confirming is refused', async (t) => {
  const { root, goal, one } = await setup(t);
  assert.equal(mergeTreeSupported('2.37.9'), false);
  assert.equal(mergeTreeSupported('2.38.0'), true);
  assert.equal(mergeTreeSupported('3.0'), true);
  assert.equal(mergeTreeSupported(null), false);
  await writeFile(join(one.path, 'shared.txt'), 'v1\n');
  const preview = await previewImport(root, goal.id, one.id, { version: '2.37.1' });
  assert.deepEqual([preview.supported, preview.ready, preview.version], [false, false, '2.37.1']);
  assert.ok(preview.commands.includes(`git merge --squash --no-commit ${one.branch}`));
  assert.ok(preview.commands.some((command) => command.includes(`.wax/worktrees/${one.id}`) && command.includes('commit')));
  await assert.rejects(applyImport(root, goal.id, one.id, { by: person, fingerprint: 'x', version: '2.37.1' }), (error) => error.status === 409 && /2\.38/.test(error.message));
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('discard and cleanup: only imported or discarded worktrees are removed (git worktree remove, hooks off), branches stay, the registry says removed; .git loses only worktrees/<id>/', { skip: !modern }, async (t) => {
  const root = await repo(t, ['f1', 'f2', 'f3']);
  const goal = await createGoal(root, { title: '정리', features: ['f1', 'f2', 'f3'], worktrees: true }, { author: person });
  const [one, two, three] = [];
  const entries = [];
  for (const feature of ['f1', 'f2', 'f3']) entries.push((await prepareWorktree(root, await readGoal(root, goal.id), feature)).entry);
  await writeFile(join(entries[0].path, 'shared.txt'), 'taken\n');
  await writeFile(join(entries[1].path, 'shared.txt'), 'dropped\n');
  await writeFile(join(entries[1].path, 'untracked.txt'), 'lost on cleanup\n');
  await assert.rejects(cleanupGoalWorktrees(root, goal.id, { author: person }), (error) => error.status === 409, 'nothing to clean yet');
  const preview = await previewWorktreeImport(root, goal.id, entries[0].id, { author: person });
  await importWorktree(root, goal.id, entries[0].id, { author: person, fingerprint: preview.fingerprint });
  const discarded = await discardGoalWorktree(root, goal.id, entries[1].id, { author: person });
  assert.deepEqual([discarded.state, discarded.by], ['discarded', person]);
  await assert.rejects(discardGoalWorktree(root, goal.id, entries[1].id, { author: person }), (error) => error.status === 409, 'already discarded');
  await assert.rejects(previewImport(root, goal.id, entries[1].id), (error) => error.status === 409, 'a discarded worktree cannot be imported');
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await writeFile(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch "$GIT_DIR/../hook-ran"\n', { mode: 0o755 });
  const branches = git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/wax/');
  const before = await gitFiles(root);
  const view = (await goalOverview(root, goal.id, { user: person })).worktrees;
  assert.equal(view.cleanable, true);
  assert.equal(view.entries.find((entry) => entry.id === entries[2].id).summary.files, 0);
  const result = await cleanupGoalWorktrees(root, goal.id, { author: person });
  assert.deepEqual(result.removed.sort(), [entries[0].id, entries[1].id].sort());
  assert.deepEqual(result.kept, [entries[2].id]);
  assert.equal(await exists(entries[0].path), false);
  assert.equal(await exists(entries[1].path), false);
  assert.equal(await exists(entries[2].path), true, 'the active worktree stays');
  assert.equal(git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/wax/'), branches, 'branches are kept');
  assert.equal(branches.split('\n').length, 3);
  const after = await gitFiles(root);
  const removed = Object.keys(before).filter((path) => !(path in after));
  assert.ok(removed.length > 0);
  for (const path of removed) assert.ok(path.startsWith(`worktrees/${entries[0].id}/`) || path.startsWith(`worktrees/${entries[1].id}/`), `unexpected removal ${path}`);
  assert.deepEqual(Object.keys(after).filter((path) => !(path in before)), [], 'nothing added to .git');
  assert.deepEqual(Object.keys(after).filter((path) => before[path] !== after[path]), [], 'nothing else in .git changed');
  assert.equal(await exists(join(root, 'hook-ran')), false);
  const states = Object.fromEntries((await readWorktrees(root)).map((entry) => [entry.id, [entry.state, entry.by]]));
  assert.deepEqual(states[entries[0].id], ['removed', person]);
  assert.deepEqual(states[entries[1].id], ['removed', person]);
  assert.equal(states[entries[2].id][0], 'active');
  assert.deepEqual((await readDecisions(root, goal.id)).filter((item) => item.kind === 'worktree').map((item) => item.outcome), ['discarded', 'cleaned']);
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'taken\n');
  assert.equal(one ?? two ?? three, undefined);
});

test('people only: import, preview, discard and cleanup refuse the engine, auto and worker session names (403); the dashboard API needs the token', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'v1\n');
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) {
    await assert.rejects(previewWorktreeImport(root, goal.id, one.id, { author }), (error) => error.status === 403, author);
    await assert.rejects(importWorktree(root, goal.id, one.id, { author, fingerprint: 'x' }), (error) => error.status === 403, author);
    await assert.rejects(discardGoalWorktree(root, goal.id, one.id, { author }), (error) => error.status === 403, author);
    await assert.rejects(cleanupGoalWorktrees(root, goal.id, { author }), (error) => error.status === 403, author);
  }
  const server = createChatServer({ root, env: { WAX_CHAT_USER: person, WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: async () => [] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const route = `/api/pm-loop/${goal.id}/worktrees/${one.id}`;
  for (const path of [`${route}/import-preview`, `${route}/import`, `${route}/discard`, `/api/pm-loop/${goal.id}/worktrees/cleanup`]) assert.equal((await post(path, {}, {})).status, 403, path);
  const preview = await (await post(`${route}/import-preview`, {})).json();
  assert.equal(preview.ready, true);
  assert.equal((await post(`${route}/import`, { fingerprint: 'stale' })).status, 409);
  const done = await (await post(`${route}/import`, { fingerprint: preview.fingerprint })).json();
  assert.match(done.run, /^im-[a-f0-9]{8}$/);
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'v1\n');
  const undo = await (await post(`/api/snapshots/${done.run}/preview`, {})).json();
  assert.deepEqual(undo.restore.map((entry) => entry.path), ['shared.txt']);
  const view = await (await fetch(`${base}/api/pm-loop/${goal.id}`)).json();
  assert.deepEqual(view.worktrees.entries.find((entry) => entry.id === one.id).state, 'imported');
  assert.equal(view.worktrees.git.importSupported, true);
});

test('setup hash: npm/pnpm/yarn/bun/npx setups also cover package.json and the lock files present; changing them needs approval again, other setups keep their hash', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: ['npm', 'ci'] }));
  await writeFile(join(root, 'package.json'), '{"name":"x","scripts":{"postinstall":"node a.js"}}\n');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const review = await setupReview(root);
  assert.equal(review.packageManager, true);
  assert.deepEqual(review.refs.map((ref) => [ref.path, Boolean(ref.package)]), [['package-lock.json', true], ['package.json', true]]);
  const approved = await decideSetup(root, { author: person, hash: review.hash });
  assert.deepEqual(approved.files, ['docs/wax/worktree.json', 'package-lock.json', 'package.json']);
  const real = await realpath(root);
  const state = async () => setupState(await readSetup(real), await setupDecisions(root));
  assert.equal(await state(), 'approved');
  await writeFile(join(root, 'package.json'), '{"name":"x","scripts":{"postinstall":"node evil.js"}}\n');
  assert.equal(await state(), 'changed', 'package.json change needs approval again');
  await writeFile(join(root, 'package.json'), '{"name":"x","scripts":{"postinstall":"node a.js"}}\n');
  assert.equal(await state(), 'approved');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.equal(await state(), 'changed', 'a new lock file is covered too');
  await rm(join(root, 'pnpm-lock.yaml'));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
  assert.equal(await state(), 'changed', 'a lock file change needs approval again');
  for (const argv0 of ['/usr/local/bin/pnpm', 'yarn', 'bun', 'npx', 'npm.cmd']) {
    await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: [argv0, 'install'] }));
    assert.ok((await readSetup(real)).refs.some((ref) => ref.path === 'package.json'), argv0);
  }
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: ['node', 'scripts/setup.mjs'] }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'setup.mjs'), 'console.log(1)\n');
  const other = await readSetup(real);
  assert.deepEqual(other.refs?.map((ref) => ref.path), ['scripts/setup.mjs'], JSON.stringify(other));
});
