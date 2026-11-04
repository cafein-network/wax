import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

test('import brings the branch diff (commits and uncommitted, new/deleted/binary/CRLF/exec bit) into the project as uncommitted changes, byte for byte; the project .git is unchanged', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  const w = one.path;
  await writeFile(join(w, 'shared.txt'), 'one\ntwo\nthree\nfour\n');
  await mkdir(join(w, 'src', 'deep'), { recursive: true });
  await writeFile(join(w, 'src', 'deep', 'new.txt'), 'brand new\n');
  await rm(join(w, 'old.txt'));
  commit(w, 'worker commit');
  const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 10]);
  await writeFile(join(w, 'image.bin'), binary);
  await writeFile(join(w, 'crlf.txt'), 'a\r\nb\r\n');
  await writeFile(join(w, 'keep.txt'), 'keep\nchanged in worktree\n');
  await writeFile(join(w, 'run.sh'), '#!/bin/sh\necho hi\n');
  if (posix) await chmod(join(w, 'run.sh'), 0o755);
  await writeFile(join(w, '.env'), 'SECRET=1\n');
  const head = git(root, 'rev-parse', 'HEAD');
  const before = await gitFiles(root);
  const worktreeIndex = await stat(join(root, '.git', 'worktrees', one.id, 'index'));
  const preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(preview.supported, true);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.ready, true);
  assert.equal(preview.uncommitted, 4);
  assert.deepEqual(preview.files.map((file) => [file.path, file.action]).sort(), [['crlf.txt', 'new'], ['image.bin', 'new'], ['keep.txt', 'modify'], ['old.txt', 'delete'], ['run.sh', 'new'], ['shared.txt', 'modify'], ['src/deep/new.txt', 'new']]);
  assert.equal(preview.files.find((file) => file.path === 'image.bin').binary, true);
  assert.deepEqual([preview.files.find((file) => file.path === 'shared.txt').added, preview.files.find((file) => file.path === 'shared.txt').removed], [1, 0]);
  assert.equal(preview.plan, undefined, 'internal plan is not sent');
  assert.deepEqual(await gitFiles(root), before, 'the preview wrote nothing to the project .git');
  const result = await importWorktree(root, goal.id, one.id, { author: person, fingerprint: preview.fingerprint });
  const after = await gitFiles(root);
  assert.deepEqual(result.imported.sort(), preview.files.map((file) => file.path).sort());
  assert.deepEqual(result.failed, []);
  for (const path of ['shared.txt', 'src/deep/new.txt', 'image.bin', 'crlf.txt', 'keep.txt', 'run.sh']) assert.deepEqual(await readFile(join(root, path)), await readFile(join(w, path)), path);
  assert.equal(await exists(join(root, 'old.txt')), false);
  assert.equal(await exists(join(root, '.env')), false, '.env is not imported');
  if (posix) assert.equal((await stat(join(root, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).map((line) => line.slice(3)).sort(), ['crlf.txt', 'image.bin', 'keep.txt', 'old.txt', 'run.sh', 'shared.txt', 'src/deep/new.txt']);
  assert.deepEqual(after, before, 'import wrote nothing to the project .git (no index, MERGE_MSG, SQUASH_MSG, objects or refs)');
  assert.equal((await stat(join(root, '.git', 'worktrees', one.id, 'index'))).mtimeMs, worktreeIndex.mtimeMs, 'the worktree index was not rewritten');
  const entry = (await readWorktrees(root)).find((item) => item.id === one.id);
  assert.deepEqual([entry.state, entry.by], ['imported', person]);
  const record = (await readDecisions(root, goal.id)).find((item) => item.kind === 'worktree-import');
  assert.deepEqual([record.outcome, record.worktree, record.branch, record.run, record.files, record.by], ['imported', one.id, one.branch, result.run, 7, person]);
  assert.ok((await featureDecisions(root, 'f1')).some((item) => item.kind === 'worktree-import' && item.run === result.run));
  const trace = await buildRunTrace(root, 'f1');
  const runs = trace.visits.flatMap((visit) => visit.runs ?? []);
  const run = runs.find((item) => item.run === result.run);
  assert.equal(run?.kind, 'import');
  assert.equal(run.count, 7);
  await assert.rejects(previewImport(root, goal.id, one.id), (error) => error.status === 409);
});

test('the pre-import snapshot lets the existing restore flow undo the import, and the worktree becomes active again', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\ntwo\nthree\nimported\n');
  await writeFile(join(one.path, 'added.txt'), 'added\n');
  const preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  const result = await importWorktree(root, goal.id, one.id, { author: person, fingerprint: preview.fingerprint });
  assert.equal(await readFile(join(root, 'added.txt'), 'utf8'), 'added\n');
  const item = (await listRuns(root)).find((entry) => entry.run === result.run);
  assert.deepEqual([item.kind, item.state, item.before.point, item.after.point, item.target], ['import', 'ok', 'pre-import', 'post-import', one.id]);
  const undo = await previewRunRestore(root, result.run);
  assert.deepEqual(undo.restore.map((entry) => [entry.path, entry.action]).sort(), [['added.txt', 'delete'], ['shared.txt', 'write']]);
  const restored = await restoreRun(root, result.run, { author: person, fingerprint: undo.fingerprint });
  assert.deepEqual(restored.restored.sort(), ['added.txt', 'shared.txt']);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the project is back to HEAD');
  assert.equal(restored.reactivated, one.id);
  assert.equal((await readWorktrees(root)).find((entry) => entry.id === one.id).state, 'active', 'so cleanup does not delete the uncommitted worktree changes');
  const again = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(again.ready, true);
});

test('conflicts: the preview lists only the conflicting files and the import is refused; a dirty project is refused (409) and still shows conflicts with its uncommitted changes', { skip: !modern }, async (t) => {
  const { root, goal, one, two } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'one\nTWO by f1\nthree\n');
  await writeFile(join(two.path, 'shared.txt'), 'one\nTWO by f2\nthree\n');
  await writeFile(join(two.path, 'f2-only.txt'), 'f2\n');
  const first = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  await importWorktree(root, goal.id, one.id, { author: person, fingerprint: first.fingerprint });
  const before = await gitFiles(root);
  const dirty = await previewWorktreeImport(root, goal.id, two.id, { author: person });
  assert.deepEqual(dirty.conflicts, ['shared.txt']);
  assert.deepEqual([dirty.dirtyCount, dirty.dirty, dirty.ready, dirty.files], [1, ['shared.txt'], false, []]);
  await assert.rejects(importWorktree(root, goal.id, two.id, { author: person, fingerprint: dirty.fingerprint }), (error) => error.status === 409);
  commit(root, 'took f1');
  const clean = await previewWorktreeImport(root, goal.id, two.id, { author: person });
  assert.deepEqual([clean.conflicts, clean.dirtyCount, clean.ready, clean.files], [['shared.txt'], 0, false, []]);
  await assert.rejects(importWorktree(root, goal.id, two.id, { author: person, fingerprint: clean.fingerprint }), (error) => error.status === 409 && /shared\.txt/.test(error.message));
  assert.equal(await exists(join(root, 'f2-only.txt')), false, 'nothing from the conflicting worktree was written');
  assert.equal((await readWorktrees(root)).find((entry) => entry.id === two.id).state, 'active');
  const committed = await gitFiles(root);
  await previewWorktreeImport(root, goal.id, two.id, { author: person });
  assert.deepEqual(await gitFiles(root), committed);
  assert.ok(Object.keys(before).length);
});

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
