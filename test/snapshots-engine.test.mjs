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

test('restore is for a person only, and is refused while any worker is running in the project', async (t) => {
  const root = await repo(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: '되돌리기', features: ['f1'] }, { author: '대표' });
  await snapRun(root, { ...META, goal: goal.id });
  const { fingerprint } = await previewRestore(root, 'pw-0000000a');
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) await assert.rejects(restoreRun(root, 'pw-0000000a', { author, fingerprint }), (error) => error.status === 403, author);
  const log = join(await chatDir(root, 'pm-loop'), `${goal.id}.jsonl`);
  await appendRecord(log, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, kind: 'worker', outcome: 'launched', worker: 'pw-000000bb', tool: 'claude', feature: 'f1', phase: 'implement', at: new Date().toISOString() }));
  await assert.rejects(restoreRun(root, 'pw-0000000a', { author: '대표', fingerprint }), (error) => error.status === 409 && /작업자가 실행 중/.test(error.message));
  await appendRecord(log, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, kind: 'worker', outcome: 'exited', worker: 'pw-000000bb', at: new Date().toISOString() }));
  const result = await restoreRun(root, 'pw-0000000a', { author: '대표', fingerprint });
  assert.equal(result.restored.length, 4);
  const record = (await readDecisions(root, goal.id)).at(-1);
  assert.deepEqual([record.kind, record.outcome, record.run, record.restoreRun, record.by, record.restored, record.skipped], ['restore', 'restored', 'pw-0000000a', result.restoreRun, '대표', 4, 0]);
  assert.match(record.reason, /실행 pw-0000000a 전으로 되돌림: 파일 4개 되돌림, 0개 건드리지 않음/);
  assert.ok((await goalOverview(root, goal.id, { user: '대표' })).decisions.some((item) => item.kind === 'restore'));
});

test('concurrent workers in the same folder are counted on each run', async (t) => {
  const root = await repo(t);
  const other = { ...META, run: 'pw-0000000b', worker: 'pw-0000000b' };
  await takeSnapshot(root, { ...META, point: 'before' });
  await takeSnapshot(root, { ...other, point: 'before' });
  await writeFile(join(root, 'new.txt'), 'x\n');
  await takeSnapshot(root, { ...other, point: 'after' });
  await takeSnapshot(root, { ...META, point: 'after' });
  const runs = await listRuns(root);
  assert.deepEqual(await Promise.all(runs.map(async (item) => (await runSummary(root, item, { runs })).concurrent)), [1, 1]);
  assert.equal((await previewRestore(root, 'pw-0000000a')).concurrent, 1);
});

test('retention: finished goals after 30 days or over the size cap lose their oldest runs; active and unreadable goals are kept; gc runs on the wax store only', async (t) => {
  const root = await repo(t);
  const old = { ...META, goal: 'goal-000000d0', run: 'pw-000000d0', worker: 'pw-000000d0' };
  const active = { ...META, goal: 'goal-000000a0', run: 'pw-000000a0', worker: 'pw-000000a0' };
  const broken = { ...META, goal: 'goal-000000b0', run: 'pw-000000b0', worker: 'pw-000000b0' };
  const recent = { ...META, goal: 'goal-000000c0', run: 'pw-000000c0', worker: 'pw-000000c0' };
  const write = (name, content) => async () => writeFile(join(root, name), content);
  const done = (name) => rm(join(root, name));
  await snapRun(root, old, write('old.txt', 'old content\n')); await done('old.txt');
  await snapRun(root, active, write('active.txt', 'active content\n')); await done('active.txt');
  await snapRun(root, broken, write('broken.txt', 'broken content\n')); await done('broken.txt');
  await snapRun(root, recent, write('recent.txt', 'recent content\n')); await done('recent.txt');
  const idOf = async (run, path) => (await readSnapshots(root)).find((item) => item.run === run && item.point === 'after').files[path];
  const oldBlob = await idOf('pw-000000d0', 'old.txt'), activeBlob = await idOf('pw-000000a0', 'active.txt'), recentBlob = await idOf('pw-000000c0', 'recent.txt');
  const now = Date.now();
  const goals = new Map([['goal-000000d0', { state: 'done', updatedAt: new Date(now - 31 * 86_400_000).toISOString() }],
    ['goal-000000a0', { state: 'running', updatedAt: new Date(now - 90 * 86_400_000).toISOString() }],
    ['goal-000000c0', { state: 'stopped', updatedAt: new Date(now - 86_400_000).toISOString() }]]);
  const baseline = await gitState(root);
  const first = await pruneSnapshots(root, { goals, unsure: new Set(['goal-000000b0']), now });
  assert.deepEqual(first, { dropped: 1, gc: true });
  assert.deepEqual([...new Set((await readSnapshots(root)).map((item) => item.run))], ['pw-000000a0', 'pw-000000b0', 'pw-000000c0']);
  assert.equal(inStore(root, oldBlob), false, 'the dropped run’s bytes are gone from the wax store');
  assert.ok(inStore(root, activeBlob) && inStore(root, recentBlob), 'kept runs keep their bytes');
  assert.deepEqual(await pruneSnapshots(root, { goals, unsure: new Set(['goal-000000b0']), now }), { dropped: 0, gc: false }, 'nothing to do');
  assert.deepEqual(await pruneSnapshots(root, { goals, unsure: new Set(['goal-000000b0']), now, maxBytes: 1 }), { dropped: 1, gc: true });
  assert.deepEqual([...new Set((await readSnapshots(root)).map((item) => item.run))], ['pw-000000a0', 'pw-000000b0']);
  assert.equal(inStore(root, recentBlob), false);
  assert.ok(inStore(root, activeBlob));
  assert.deepEqual(await gitState(root), baseline, 'gc never touches the project .git');
  assert.deepEqual(await pruneRunSnapshots(root, { now: now + 40 * 86_400_000 }), { dropped: 2, gc: true });
});

test('engine: a worker run records before and after snapshots, its end record points at them, and the run trace shows the real diff', async (t) => {
  const root = await repo(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const execute = async (cwd, input) => {
    const author = input.prompt.match(/작업자 이름: ([^.]+)\./)[1];
    await writeFile(join(cwd, 'a.txt'), 'one\r\nworker\r\n');
    await writeFile(join(cwd, 'feature.js'), 'export const ok = true;\n');
    await updateFeature(cwd, 'f1', 'save', { phase: 'plan', content: '# plan\n\n- AC-1: 된다' });
    await updateFeature(cwd, 'f1', 'complete', { phase: 'plan', evidence: '가짜 작업자', author });
    return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'done', report: '끝' }) };
  };
  const listTools = async () => [{ id: 'claude', installed: true, approval: 'dashboard' }];
  const engine = createPmLoop({ root, execute, listTools, user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '스냅숏', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  const end = (await readDecisions(root, goal.id)).find((item) => item.kind === 'worker' && item.outcome === 'exited');
  const snaps = await readSnapshots(root);
  assert.deepEqual(snaps.map((item) => [item.run, item.point, item.state]), [[end.worker, 'before', 'ok'], [end.worker, 'after', 'ok']]);
  assert.deepEqual(end.snapshots, { before: snaps[0].id, after: snaps[1].id, ok: true }, 'ok: both snapshots were kept (a condition of the retry rules)');
  assert.deepEqual([snaps[0].goal, snaps[0].feature, snaps[0].phase, snaps[0].tool], [goal.id, 'f1', 'plan', 'claude']);
  const trace = await buildRunTrace(root, 'f1', { language: 'ko' });
  const [runItem] = trace.visits[0].runs;
  assert.deepEqual([runItem.run, runItem.state, runItem.files.map((file) => [file.path, file.state])], [end.worker, 'ok', [['a.txt', 'modify'], ['feature.js', 'new']]]);
  assert.match(trace.markdown, new RegExp(`### 이 실행이 바꾼 파일\\(커밋 안 된 변경 포함\\) \`${end.worker}\``));
  assert.match(trace.markdown, /- `feature\.js` \(새 파일, \+1 −0\)/);
  const { fingerprint } = await previewRestore(root, end.worker);
  const result = await restoreRun(root, end.worker, { author: '대표', fingerprint });
  const after = await buildRunTrace(root, 'f1', { language: 'en' });
  assert.deepEqual(after.visits[0].runs.map((item) => [item.run, item.kind]), [[end.worker, 'worker'], [result.restoreRun, 'restore']]);
  assert.match(after.markdown, /Restore `rs-[a-f0-9]{8}`/);
});

test('engine: outside Git the worker still runs and its snapshots are unknown', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  let ran = false;
  const execute = async () => { ran = true; return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'blocked', report: '막힘' }) }; };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '깃 없음', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  assert.ok(ran);
  assert.deepEqual((await readSnapshots(root)).map((item) => [item.point, item.state, item.reason]), [['before', 'unknown', 'not-git'], ['after', 'unknown', 'not-git']]);
  const trace = await buildRunTrace(root, 'f1', { language: 'ko' });
  assert.equal(trace.visits[0].runs[0].state, 'unknown');
  assert.match(trace.markdown, /바뀐 파일 미확인\(`not-git`\)/);
});

test('dashboard API: diff is read-only, preview and restore need the token, restore checks the fingerprint and is written as the dashboard person', async (t) => {
  const root = await repo(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: 'API', features: ['f1'] }, { author: '대표' });
  await snapRun(root, { ...META, goal: goal.id });
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000, requestTools: async () => [] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const diff = await (await fetch(`${base}/api/snapshots/pw-0000000a/diff?path=a.txt`)).json();
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
  assert.equal((await fetch(`${base}/api/snapshots/pw-0000000a/diff?path=nope`)).status, 404);
  assert.equal((await post('/api/snapshots/pw-0000000a/preview', {}, {})).status, 403, 'no token');
  assert.equal((await post('/api/snapshots/pw-0000000a/restore', { fingerprint: 'x' }, {})).status, 403, 'no token');
  const preview = await (await post('/api/snapshots/pw-0000000a/preview', {})).json();
  assert.deepEqual([preview.restore.length, preview.busy], [4, null]);
  assert.equal((await post('/api/snapshots/pw-0000000a/restore', { fingerprint: 'stale' })).status, 409);
  const done = await post('/api/snapshots/pw-0000000a/restore', { fingerprint: preview.fingerprint, by: 'auto' });
  assert.equal(done.status, 200);
  const result = await done.json();
  assert.equal(result.restored.length, 4);
  assert.equal((await readRestores(root))[0].by, '대표', 'the author is the dashboard person, not a field in the body');
  assert.equal(await text(root, 'a.txt'), 'one\r\ntwo\r\n');
});

test('CLI: snapshot list and show are read-only, in Korean and English, with --json', async (t) => {
  const root = await repo(t);
  await snapRun(root);
  const cli = async (args, env = {}) => (await run(process.execPath, [BIN, '--project', root, 'snapshot', ...args], { env: { ...process.env, ...env } })).stdout;
  const list = await cli(['list']);
  assert.match(list, /pw-0000000a {2}\[ok\] {2}goal-0000000a {2}f1 {2}implement {2}claude/);
  assert.match(list, /읽기 전용\. 되돌리기는 대시보드 실행 기록에서 사람만/);
  assert.match(await cli(['list'], { WAX_LANG: 'en' }), /Read-only\. Only a person restores/);
  assert.equal(JSON.parse(await cli(['list', '--goal', 'goal-0000000a', '--json'])).runs.length, 1);
  assert.equal(JSON.parse(await cli(['list', '--goal', 'goal-00000099', '--json'])).runs.length, 0);
  const show = await cli(['show', 'pw-0000000a']);
  assert.match(show, /--- a\.txt \(고친 파일, \+2 −1\)\n@@ -1,2 \+1,3 @@\n one\n-two\n\+TWO\n\+three/);
  assert.match(show, /--- new\.txt \(새 파일, \+1 −0\)/);
  const json = JSON.parse(await cli(['show', 'pw-0000000a', '--json']));
  assert.deepEqual([json.count, json.diffs.length], [4, 4]);
  await assert.rejects(run(process.execPath, [BIN, '--project', root, 'snapshot', 'restore', 'pw-0000000a']), (error) => /사용법: wax snapshot list/.test(error.stderr), 'there is no restore command');
  assert.match(await cli(['--help']), /wax snapshot show <실행>/);
  assert.equal(await text(root, 'new.txt'), 'new\n');
});

test('a snapshot never throws even when its folder cannot be used', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, '.wax', 'chat'), { recursive: true });
  await writeFile(join(root, '.wax', 'chat', 'snapshots'), 'not a folder');
  assert.equal(await takeSnapshot(root, { ...META, point: 'before' }), null);
  await rm(join(root, '.wax', 'chat', 'snapshots'));
  await snapRun(root);
  await appendFile(join(root, '.wax', 'chat', 'snapshots', 'runs.jsonl'), '{broken\n{"seq":99,"schema":1,"run":"pw-0000000a","point":"after","state":"ok","files":{"x":"zz"},"at":"2026-01-01T00:00:00Z","id":"snap-x"}\n');
  assert.equal((await readSnapshots(root)).length, 2);
});
