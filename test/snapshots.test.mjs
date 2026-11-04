import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BIN, project } from './chat-helpers.mjs';
import { SNAPSHOT_LIMITS, listRuns, previewRestore, pruneSnapshots, rawId, readRestores, readSnapshots, restoreSnapshot, runFileDiff, runSummary, takeSnapshot } from '../src/snapshots.mjs';
import { createGoal, createPmLoop, executeSuggestion, goalOverview, pruneRunSnapshots, readDecisions, restoreRun, stopGoal } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { chatDir } from '../src/chat/paths.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { updateFeature } from '../src/workflow.mjs';

const run = promisify(execFile);
const META = { run: 'pw-0000000a', goal: 'goal-0000000a', worker: 'pw-0000000a', feature: 'f1', phase: 'implement', iteration: 0, tool: 'claude' };
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const read = (root, path) => readFile(join(root, path));
const text = async (root, path) => (await read(root, path)).toString('utf8');
const exists = async (path) => lstat(path).then(() => true, () => false);

async function repo(t, features = []) {
  const root = await project(t, features);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), 'ignored.log\nnode_modules/\n');
  await writeFile(join(root, 'a.txt'), 'one\r\ntwo\r\n');
  await writeFile(join(root, 'b.txt'), 'b\n');
  commit(root);
  await writeFile(join(root, 'dirty.txt'), 'dirty before\r\n');
  await writeFile(join(root, 'ignored.log'), 'log\n');
  return root;
}
async function gitState(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const info = await lstat(path); out.push(`${relative(root, path)} ${info.size} ${info.mtimeMs}`); }
    }
  };
  await walk(join(root, '.git'));
  return out.sort();
}
async function work(root) {
  await writeFile(join(root, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  await rm(join(root, 'b.txt'));
  await writeFile(join(root, 'new.txt'), 'new\n');
  await writeFile(join(root, 'dirty.txt'), 'dirty after\n');
  await writeFile(join(root, 'ignored.log'), 'log changed\n');
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  await writeFile(join(root, '.wax', 'tmp', 'scratch.md'), 'scratch\n');
}
async function snapRun(root, meta = META, between = work) {
  const before = await takeSnapshot(root, { ...meta, point: 'before' });
  await between(root);
  const after = await takeSnapshot(root, { ...meta, point: 'after' });
  return { before, after };
}
const storeEnv = (root) => ({ ...process.env, GIT_DIR: join(root, '.wax', 'chat', 'snapshots', 'objects.git') });
const inStore = (root, id) => { try { execFileSync('git', ['cat-file', '-e', id], { env: storeEnv(root), stdio: 'ignore' }); return true; } catch { return false; } };

test('before and after record uncommitted changes, new and deleted files; .gitignore and .wax/ are left out; bytes go to the wax-only store', async (t) => {
  const root = await repo(t);
  const { before, after } = await snapRun(root);
  assert.equal(before.state, 'ok');
  assert.equal(before.head, git(root, 'rev-parse', 'HEAD').trim());
  assert.deepEqual(Object.keys(before.files).sort(), ['dirty.txt']);
  assert.deepEqual(Object.keys(after.files).sort(), ['a.txt', 'b.txt', 'dirty.txt', 'new.txt']);
  assert.equal(after.files['b.txt'], null, 'a deleted file is null');
  assert.ok(!Object.keys(after.files).some((path) => path.startsWith('.wax') || path === 'ignored.log'));
  assert.equal(after.files['a.txt'], rawId(await read(root, 'a.txt')));
  assert.ok(inStore(root, after.files['a.txt']));
  const runs = await listRuns(root);
  assert.deepEqual(runs.map((item) => [item.run, item.kind, item.state]), [['pw-0000000a', 'worker', 'ok']]);
  const summary = await runSummary(root, runs[0], { runs });
  assert.deepEqual(summary.files.map((file) => [file.path, file.state, file.added, file.removed]),
    [['a.txt', 'modify', 2, 1], ['b.txt', 'delete', 0, 1], ['dirty.txt', 'modify', 1, 1], ['new.txt', 'new', 1, 0]]);
  assert.deepEqual([summary.count, summary.commits, summary.concurrent], [4, 0, 0]);
  const diff = await runFileDiff(root, 'pw-0000000a', 'a.txt');
  assert.deepEqual(diff.lines, [['@', '@@ -1,2 +1,3 @@'], [' ', 'one'], ['-', 'two'], ['+', 'TWO'], ['+', 'three']]);
  await assert.rejects(runFileDiff(root, 'pw-0000000a', 'ignored.log'), (error) => error.status === 404);
  await assert.rejects(runFileDiff(root, 'pw-00000099', 'a.txt'), (error) => error.status === 404);
});

test('the project .git is never written: file list, sizes and modification times are the same after snapshots, diffs, restore and retention', async (t) => {
  const root = await repo(t);
  const baseline = await gitState(root);
  await snapRun(root);
  const runs = await listRuns(root);
  await runSummary(root, runs[0], { runs });
  await runFileDiff(root, 'pw-0000000a', 'a.txt');
  const preview = await previewRestore(root, 'pw-0000000a');
  const result = await restoreSnapshot(root, 'pw-0000000a', { by: '대표', fingerprint: preview.fingerprint });
  const undo = await previewRestore(root, result.restoreRun);
  await restoreSnapshot(root, result.restoreRun, { by: '대표', fingerprint: undo.fingerprint });
  await pruneSnapshots(root, { goals: new Map([['goal-0000000a', { state: 'done', updatedAt: '2000-01-01T00:00:00Z' }]]) });
  assert.deepEqual(await gitState(root), baseline);
});

test('a commit during the run: the diff covers committed and uncommitted changes, restore puts file contents back and leaves HEAD and the branch alone', async (t) => {
  const root = await repo(t);
  const branch = git(root, 'branch', '--show-current').trim();
  await snapRun(root, META, async () => {
    await writeFile(join(root, 'b.txt'), 'b committed\n');
    commit(root, 'worker commit');
    await writeFile(join(root, 'later.txt'), 'later\n');
  });
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const runs = await listRuns(root);
  const summary = await runSummary(root, runs[0], { runs });
  assert.equal(summary.commits, 1);
  assert.deepEqual(summary.files.map((file) => file.path), ['b.txt', 'later.txt'], 'dirty.txt was committed unchanged, so it is not a change');
  const preview = await previewRestore(root, 'pw-0000000a');
  assert.equal(preview.commits, 1);
  assert.deepEqual(preview.restore.map((item) => [item.path, item.action]), [['b.txt', 'write'], ['later.txt', 'delete']]);
  await restoreSnapshot(root, 'pw-0000000a', { by: '대표', fingerprint: preview.fingerprint });
  assert.equal(await text(root, 'b.txt'), 'b\n');
  assert.equal(await exists(join(root, 'later.txt')), false);
  assert.deepEqual([git(root, 'rev-parse', 'HEAD').trim(), git(root, 'branch', '--show-current').trim()], [head, branch], 'commits and refs are untouched');
});

test('outside Git, over the tree limits, or with a broken store a snapshot is unknown with a reason and never throws', async (t) => {
  const plain = await project(t);
  const unknown = await takeSnapshot(plain, { ...META, point: 'before' });
  assert.deepEqual([unknown.state, unknown.reason, unknown.files], ['unknown', 'not-git', undefined]);
  const root = await repo(t);
  await mkdir(join(root, 'many'));
  for (let i = 0; i <= SNAPSHOT_LIMITS.files; i++) await writeFile(join(root, 'many', `f${i}.txt`), `${i}\n`);
  assert.deepEqual([(await takeSnapshot(root, { ...META, point: 'before' })).state, (await readSnapshots(root)).at(-1).reason], ['unknown', 'too-large']);
  await rm(join(root, 'many'), { recursive: true });
  await takeSnapshot(root, { ...META, point: 'after' });
  const [item] = await listRuns(root);
  assert.deepEqual([item.state, item.reason], ['unknown', 'too-large']);
  assert.equal((await runSummary(root, item)).files.length, 0);
  await assert.rejects(previewRestore(root, 'pw-0000000a'), (error) => error.status === 409);
  assert.equal(await takeSnapshot(root, { ...META, run: '../x', point: 'before' }), null);
  assert.equal(await takeSnapshot(root, { ...META, point: 'middle' }), null);
});

test('restore writes only files whose content still equals the run’s after, keeps CRLF and binary bytes, and the pre-restore snapshot undoes it', async (t) => {
  const root = await repo(t);
  const binary = Buffer.from([0, 1, 2, 13, 10, 255, 0]);
  await writeFile(join(root, 'blob.bin'), binary);
  await snapRun(root, META, async () => { await work(root); await writeFile(join(root, 'blob.bin'), Buffer.from([9, 9, 0])); });
  await writeFile(join(root, 'new.txt'), 'human edit\n');
  const preview = await previewRestore(root, 'pw-0000000a');
  assert.deepEqual(preview.restore.map((item) => [item.path, item.action]), [['a.txt', 'write'], ['b.txt', 'write'], ['blob.bin', 'write'], ['dirty.txt', 'write']]);
  assert.deepEqual(preview.skip, [{ path: 'new.txt', reason: 'changed' }]);
  assert.deepEqual(preview.restore.find((item) => item.path === 'blob.bin'), { path: 'blob.bin', action: 'write', added: null, removed: null, none: 'binary' });
  await writeFile(join(root, 'a.txt'), 'changed again\n');
  await assert.rejects(restoreSnapshot(root, 'pw-0000000a', { by: '대표', fingerprint: preview.fingerprint }), (error) => error.status === 409);
  await assert.rejects(restoreSnapshot(root, 'pw-0000000a', { by: '대표', fingerprint: 'nope' }), (error) => error.status === 409);
  await writeFile(join(root, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  const again = await previewRestore(root, 'pw-0000000a');
  assert.equal(again.fingerprint, preview.fingerprint, 'the same state gives the same fingerprint');
  const result = await restoreSnapshot(root, 'pw-0000000a', { by: '대표', fingerprint: again.fingerprint });
  assert.deepEqual([result.restored, result.skipped, result.failed], [['a.txt', 'b.txt', 'blob.bin', 'dirty.txt'], [{ path: 'new.txt', reason: 'changed' }], []]);
  assert.deepEqual(await read(root, 'a.txt'), Buffer.from('one\r\ntwo\r\n'), 'HEAD content, CRLF kept');
  assert.deepEqual(await read(root, 'dirty.txt'), Buffer.from('dirty before\r\n'), 'uncommitted content from the wax store, CRLF kept');
  assert.deepEqual(await read(root, 'blob.bin'), binary);
  assert.equal(await text(root, 'b.txt'), 'b\n');
  assert.equal(await text(root, 'new.txt'), 'human edit\n', 'the file a person changed is left alone');
  assert.equal(await text(root, 'ignored.log'), 'log changed\n', 'ignored files are not protected');
  assert.equal(await text(root, join('.wax', 'tmp', 'scratch.md')), 'scratch\n');
  const [restore] = await readRestores(root);
  assert.deepEqual([restore.run, restore.restoreRun, restore.by, restore.preRestore, restore.restored.length], ['pw-0000000a', result.restoreRun, '대표', result.preRestore, 4]);
  const undo = await previewRestore(root, result.restoreRun);
  assert.deepEqual([undo.kind, undo.target], ['restore', 'pw-0000000a']);
  assert.deepEqual(undo.restore.map((item) => item.path), ['a.txt', 'b.txt', 'blob.bin', 'dirty.txt']);
  await restoreSnapshot(root, result.restoreRun, { by: '대표', fingerprint: undo.fingerprint });
  assert.deepEqual(await read(root, 'a.txt'), Buffer.from('one\r\nTWO\r\nthree\r\n'));
  assert.equal(await text(root, 'dirty.txt'), 'dirty after\n');
  assert.equal(await exists(join(root, 'b.txt')), false);
  assert.equal(await text(root, 'new.txt'), 'human edit\n');
  const nothing = await previewRestore(root, result.restoreRun);
  assert.deepEqual(nothing.restore, []);
  await assert.rejects(restoreSnapshot(root, result.restoreRun, { by: '대표', fingerprint: nothing.fingerprint }), (error) => error.status === 409);
});

test('restore never writes outside the project, through links, or into .git/, .wax/ and .env*', async (t) => {
  const root = await repo(t);
  const outside = await mkdtemp(join(tmpdir(), 'wax-snap-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await snapRun(root, META, async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'x.txt'), 'x\n');
    await symlink(join(outside, 'target.txt'), join(root, 'link.txt'));
  });
  await mkdir(join(outside, 'sub'));
  await writeFile(join(outside, 'sub', 'x.txt'), 'x\n');
  await rm(join(root, 'sub'), { recursive: true });
  await symlink(join(outside, 'sub'), join(root, 'sub'));
  const dir = await chatDir(root, 'snapshots');
  const forged = (point, files) => appendRecord(join(dir, 'runs.jsonl'), (seq) => ({ schema: 1, record: 'snapshot', id: makeId('snap', seq), seq, run: 'pw-0000000f', point, goal: META.goal,
    worker: 'pw-0000000f', state: 'ok', reason: null, head: git(root, 'rev-parse', 'HEAD').trim(), files, at: new Date().toISOString() }));
  await writeFile(join(root, '.env.local'), 'SECRET=1\n');
  const id = rawId(Buffer.from('SECRET=1\n'));
  await forged('before', {});
  await forged('after', { '../escape.txt': id, '.env.local': id, '.git/config': id });
  const preview = await previewRestore(root, 'pw-0000000a');
  assert.deepEqual(preview.restore, []);
  assert.deepEqual(preview.skip, [{ path: 'link.txt', reason: 'symlink' }, { path: 'sub/x.txt', reason: 'symlink' }]);
  const evil = await previewRestore(root, 'pw-0000000f');
  assert.deepEqual(evil.skip.map((item) => [item.path, item.reason]), [['../escape.txt', 'outside'], ['.env.local', 'sensitive'], ['.git/config', 'sensitive']]);
  assert.deepEqual(evil.restore, []);
  await assert.rejects(restoreSnapshot(root, 'pw-0000000f', { by: '대표', fingerprint: evil.fingerprint }), (error) => error.status === 409, 'nothing to restore');
  assert.equal(await text(root, '.env.local'), 'SECRET=1\n');
  assert.equal(await text(outside, join('sub', 'x.txt')), 'x\n', 'nothing was written through the link');
  const wax = { ...META, run: 'pw-0000000e', worker: 'pw-0000000e' };
  await takeSnapshot(root, { ...wax, point: 'before' });
  await appendRecord(join(dir, 'runs.jsonl'), (seq) => ({ schema: 1, record: 'snapshot', id: makeId('snap', seq), seq, run: wax.run, point: 'after', goal: META.goal, state: 'ok', reason: null,
    head: null, files: { '.wax/chat/team.json': null }, at: new Date().toISOString() }));
  assert.equal((await listRuns(root)).find((item) => item.run === wax.run).state, 'running');
  await assert.rejects(previewRestore(root, wax.run), (error) => error.status === 409);
});

test('when the run’s commit is gone from the project (history rewritten and cleaned up) the run is unknown and nothing is deleted', async (t) => {
  const root = await repo(t);
  const dir = await chatDir(root, 'snapshots', { create: true });
  const ghost = 'f'.repeat(40);
  for (const point of ['before', 'after']) {
    await appendRecord(join(dir, 'runs.jsonl'), (seq) => ({ schema: 1, record: 'snapshot', id: makeId('snap', seq), seq, ...META, point, state: 'ok', reason: null,
      head: point === 'before' ? ghost : git(root, 'rev-parse', 'HEAD').trim(), files: {}, at: new Date().toISOString() }));
  }
  const runs = await listRuns(root);
  const summary = await runSummary(root, runs[0], { runs });
  assert.deepEqual([summary.state, summary.reason, summary.files], ['unknown', 'head-missing', []]);
  await assert.rejects(previewRestore(root, 'pw-0000000a'), (error) => error.status === 409);
  await assert.rejects(runFileDiff(root, 'pw-0000000a', 'a.txt'), (error) => error.status === 409);
  assert.equal(await text(root, 'a.txt'), 'one\r\ntwo\r\n');
});
