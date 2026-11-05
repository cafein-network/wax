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

test('preview: uncommitted content that already exists as project blobs does not freshen them (the temporary commit reuses existing objects), loose or packed', { skip: !modern }, async (t) => {
  for (const packed of [false, true]) {
    const { root, goal, one } = await setup(t);
    if (packed) git(root, 'repack', '-a', '-d', '-q');
    await writeFile(join(one.path, 'keep.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(one.path, 'copy.txt'), 'keep\n');
    const old = new Date('2020-01-01T00:00:00Z');
    for (const path of Object.keys(await gitFiles(root)).filter((path) => path.startsWith('objects/'))) await utimes(join(root, '.git', path), old, old);
    const before = await gitFiles(root);
    const preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
    assert.deepEqual(preview.files.map((file) => file.path).sort(), ['copy.txt', 'keep.txt']);
    assert.deepEqual(await gitFiles(root), before, `${packed ? 'packed' : 'loose'}: the preview wrote or freshened nothing in the project .git`);
  }
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
