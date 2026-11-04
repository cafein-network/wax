import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { project, BIN, createTestSymlink } from './chat-helpers.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { postNote } from '../src/chat/board.mjs';
import { assignTask, setPm, updateTask } from '../src/chat/team.mjs';
import { loadSqlite } from '../src/sqlite.mjs';
import { buildIndex, indexStatus, search, openIndex, syncIndex, plan, terms, bigrams, marksIn } from '../src/search.mjs';
import { sqlite, korean, skip, STORE, channelFile, line, refs, count, run, RECOVERY_RECORDS, bigChannel, ownerPid } from './search-helpers.mjs';

test('an interrupted write leaves no partial sync, and a killed rebuild recovers on the next run', { skip }, async (t) => {
  const root = await project(t);
  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  await writeFile(channelFile(root, 'general'), Array.from({ length: 20_000 }, (_, i) => line(i + 1, i % 50 ? `개발 메모 ${i}` : `디자인 인계 ${i}`)).join(''));
  const killed = spawn(process.execPath, [BIN, '--project', root, 'search', 'index']);
  await new Promise((done) => setTimeout(done, 150)); killed.kill('SIGKILL');
  await new Promise((done) => killed.on('close', done));
  const result = await buildIndex(root);
  assert.equal(result.documents, 20_000); assert.equal((await search(root, { query: '인계' })).total, 400);
  const { code } = await run(['--input-type=module', '-e', `
    import { openIndex } from ${JSON.stringify(new URL('../src/search.mjs', import.meta.url).href)};
    const { db } = await openIndex(${JSON.stringify(root)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO docs(ref, source, kind, body) VALUES ('ghost', 'x', 'message', 'ghost 인계')").run();
    db.prepare("UPDATE sources SET offset = 0").run();
    process.exit(3);`]);
  assert.equal(code, 3);
  assert.equal(await count(root), 20_000); assert.equal((await refs(root, 'ghost')).length, 0);
  assert.equal((await indexStatus(root)).pending, 0);
});

test('several processes writing while others search and rebuild end with every record exactly once', { skip }, async (t) => {
  const root = await project(t);
  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  await writeFile(channelFile(root, 'general'), '');
  await buildIndex(root);
  const writer = (name, n) => run(['--input-type=module', '-e', `
    import { appendRecord, makeId } from ${JSON.stringify(STORE)};
    for (let i = 0; i < ${n}; i++) await appendRecord(${JSON.stringify(channelFile(root, 'general'))}, (seq) => ({ schema: 1, id: makeId('m', seq), seq, channel: 'general', author: '${name}', kind: 'codex', type: 'message', body: '동시 인계 ${name} ' + i, at: new Date().toISOString() }));`]);
  const busy = /다시 시도하세요/;
  const again = async (work) => { for (let i = 0; ; i++) { try { return await work(); } catch (error) { if (error?.status !== 409 || !busy.test(error.message) || i >= 30) throw error; } } };
  const cli = async (args) => { for (let i = 0; ; i++) { const r = await run(args); if (r.code === 0 || !busy.test(r.stderr) || i >= 30) return r; } };
  const searcher = async () => { for (let i = 0; i < 15; i++) await again(() => search(root, { query: '인계' })); };
  const results = await Promise.all([writer('writer-a', 60), writer('writer-b', 60), writer('writer-c', 60), searcher(), searcher(),
    cli([BIN, '--project', root, 'search', 'index', '--rebuild']), cli([BIN, '--project', root, 'search', '인계', '--json'])]);
  for (const r of results.filter((r) => r && r.code !== undefined)) assert.equal(r.code, 0, r.stderr);
  const final = await search(root, { query: '인계', limit: 50 });
  assert.equal(final.total, 180);
  const { db } = await openIndex(root);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM docs').get().n, 180);
    assert.equal(db.prepare('SELECT count(DISTINCT ref) AS n FROM docs').get().n, 180);
  } finally { db.close(); }
});

test('projects keep separate indexes, symlinked records are skipped, and Korean paths with spaces work', { skip }, async (t) => {
  const first = await project(t), second = await project(t);
  await postMessage(first, 'general', { author: 'codex-app', kind: 'codex', body: '첫 프로젝트 인계' });
  await postMessage(second, 'general', { author: 'codex-app', kind: 'codex', body: '둘째 프로젝트 인계' });
  if (!await createTestSymlink(t, channelFile(first, 'general'), channelFile(second, 'linked'))) return;
  await buildIndex(first); await buildIndex(second);
  assert.deepEqual((await search(first, { query: '인계' })).results.map((r) => r.snippet.text), ['첫 프로젝트 인계']);
  assert.deepEqual((await search(second, { query: '인계' })).results.map((r) => r.snippet.text), ['둘째 프로젝트 인계'], 'a symlink to another project is not followed');
});

test('the CLI explains each state, and a Node without SQLite keeps every other command working', { skip }, async (t) => {
  const root = await korean(t);
  let r = await run([BIN, '--project', root, 'search', '인계']);
  assert.equal(r.code, 0); assert.match(r.stdout, /"인계" 2건/); assert.match(r.stdout, /디자인 «인계»를/); assert.match(r.stdout, /원문: \.wax\/chat\/channels\//);
  r = await run([BIN, '--project', root, 'search', 'status', '--json']);
  assert.equal(JSON.parse(r.stdout).state, 'ready');
  r = await run([BIN, '--project', root, 'search', '인계'], { node: ['--no-experimental-sqlite'] });
  assert.equal(r.code, 2); assert.match(r.stderr, /Node\.js 22\.16 이상 또는 24 이상/); assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  r = await run([BIN, '--project', root, 'status', 'lookbook-upload'], { node: ['--no-experimental-sqlite'] });
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).id, 'lookbook-upload');
});

test('dashboard search API: missing index guidance, token-protected background build, results and the search page', { skip }, async (t) => {
  const { createChatServer } = await import('../src/chat/server.mjs');
  const root = await project(t);
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '대시보드에서 찾는 인계 메모' });
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  let res = await fetch(`${base}/api/search?q=${encodeURIComponent('인계')}`);
  assert.equal(res.status, 409); assert.equal((await res.json()).state, 'missing');
  assert.equal((await fetch(`${base}/api/search/index`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': 'wrong' }, body: '{}' })).status, 403);
  res = await fetch(`${base}/api/search/index`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: '{}' });
  assert.equal(res.status, 202); assert.equal((await res.json()).running, true);
  let status = await (await fetch(`${base}/api/search/status`)).json();
  while (status.job.running) { await new Promise((done) => setTimeout(done, 50)); status = await (await fetch(`${base}/api/search/status`)).json(); }
  assert.equal(status.job.error, null); assert.equal(status.state, 'ready'); assert.equal(status.job.result.documents, 1);
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '방금 쓴 인계 메모' });
  const found = await (await fetch(`${base}/api/search?q=${encodeURIComponent('인계')}&kind=message&limit=1`)).json();
  assert.equal(found.total, 2); assert.equal(found.results.length, 1); assert.ok(found.next, 'a second page exists');
  assert.equal(found.results[0].snippet.text, '방금 쓴 인계 메모', 'records written after the build are found');
  const [, id] = found.results[0].link.split('#');
  assert.equal((await (await fetch(`${base}/api/channels/general/messages?id=${id}`)).json()).messages[0].body, '방금 쓴 인계 메모');
  const page = await fetch(`${base}/search`);
  assert.equal(page.status, 200); assert.match(await page.text(), /id="search-q"/);
});

test('a just-published index is already in WAL mode, so a reader opening it at the same time never makes the build fail', { skip }, async (t) => {
  const { createIndexFile } = await import('../src/search.mjs');
  const root = await project(t), dir = join(root, '.wax', 'search');
  await mkdir(dir, { recursive: true });
  await createIndexFile(sqlite, dir);
  const header = await readFile(join(dir, 'index.db'));
  assert.deepEqual([header[18], header[19]], [2, 2], 'the file is published in WAL mode');
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.new-')), [], 'no temporary files are left');
  const reader = new sqlite.DatabaseSync(join(dir, 'index.db'));
  t.after(() => reader.close());
  reader.exec('BEGIN'); reader.prepare('SELECT * FROM meta').all();
  const opened = await openIndex(root);
  assert.equal(opened.state, 'ready', opened.error);
  opened.db.close();
});


const reportRecord = (path, extra = {}) => `${JSON.stringify({ schema: 1, record: 'report', id: 'r-000001-abc123', seq: 1, board: 'example', author: 'codex-app', kind: 'codex', number: 1, path, at: '2026-10-18T00:00:00Z', ...extra })}\n`;
async function reportProject(t, path = 'docs/wax/example/report.md', content = 'originalkeyword 보고서 본문') {
  const root = await project(t);
  await mkdir(join(root, '.wax', 'chat', 'board'), { recursive: true });
  await mkdir(join(root, 'docs', 'wax', 'example'), { recursive: true });
  if (content !== null) await writeFile(join(root, path), content);
  await writeFile(join(root, '.wax', 'chat', 'board', 'example.jsonl'), reportRecord(path));
  return root;
}

test('R1: a symlink anywhere on a report path never brings in a file from outside the project', { skip }, async (t) => {
  const root = await reportProject(t), outside = await project(t);
  await writeFile(join(outside, 'private.md'), 'EXTERNAL_PRIVATE_REVIEW_FIXTURE');
  const before = await readFile(join(outside, 'private.md'), 'utf8');
  if (!await createTestSymlink(t, outside, join(root, 'docs', 'wax', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  if (!await createTestSymlink(t, join(outside, 'private.md'), join(root, 'docs', 'wax', 'example', 'linked.md'))) return;
  await writeFile(join(root, '.wax', 'chat', 'board', 'example.jsonl'), reportRecord('docs/wax/example/report.md')
    + reportRecord('docs/wax/outside/private.md', { id: 'r-000002-abc123', seq: 2, number: 2 })
    + reportRecord('docs/wax/example/linked.md', { id: 'r-000003-abc123', seq: 3, number: 3 }));
  await buildIndex(root);
  assert.equal((await search(root, { query: 'EXTERNAL_PRIVATE_REVIEW_FIXTURE' })).total, 0);
  assert.equal((await search(root, { query: 'originalkeyword' })).total, 1, 'a normal report inside the project is still found');
  const refused = (await search(root, { query: '화이트보드 보고서', kind: 'report' })).results.filter((r) => r.status === 'file-refused');
  assert.deepEqual(refused.map((r) => r.source).sort(), ['docs/wax/example/linked.md', 'docs/wax/outside/private.md']);
  const status = await indexStatus(root);
  assert.deepEqual(status.damaged.filter((d) => d.file).map((d) => [d.path, d.file]).sort(), [['docs/wax/example/linked.md', 'refused'], ['docs/wax/outside/private.md', 'refused']]);
  assert.equal(await readFile(join(outside, 'private.md'), 'utf8'), before, 'the outside file is untouched');
  const raw = await readFile(join(root, '.wax', 'search', 'index.db'));
  assert.equal(raw.includes('EXTERNAL_PRIVATE_REVIEW_FIXTURE'), false, 'nothing from outside is stored');
  await rm(join(root, '.wax', 'search', 'index.db-wal'), { force: true });
  await symlink(join(outside, 'private.md'), join(root, '.wax', 'search', 'index.db-wal'));
  assert.equal((await indexStatus(root)).state, 'corrupt');
  await buildIndex(root, { rebuild: true });
  assert.equal(await readFile(join(outside, 'private.md'), 'utf8'), before, 'recovery removes the link, not its target');
  assert.equal((await search(root, { query: 'originalkeyword' })).total, 1);
});

test('R3: 대표, Korean names and names with spaces keep their author for display and filters', { skip }, async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'checkout', title: '결제' });
  for (const author of ['대표', '클로드 앱', 'codex app', 'codex-app']) await postMessage(root, 'general', { author, kind: author === '대표' ? 'human' : 'codex', body: `${author}의 인계 메모` });
  await postNote(root, 'checkout', { author: '클로드 앱', kind: 'claude', type: 'decision', body: '노트 인계' });
  await setPm(root, { author: '대표', kind: 'human' });
  const task = await assignTask(root, { author: '대표', feature: 'checkout', to: '클로드 앱', phase: 'plan', body: '배정 인계' });
  await updateTask(root, task.id, 'block', { author: '클로드 앱', body: '막힌 인계' });
  await buildIndex(root);
  for (const author of ['대표', '클로드 앱', 'codex app', 'codex-app']) {
    const found = await search(root, { query: '인계', author, kind: 'message' });
    assert.deepEqual(found.results.map((r) => r.author), [author], author);
  }
  assert.deepEqual((await search(root, { query: '인계', author: '대표' })).results.map((r) => r.kind).sort(), ['message', 'task']);
  assert.deepEqual((await search(root, { query: '인계', author: '클로드 앱' })).results.map((r) => r.kind).sort(), ['message', 'note', 'task']);
  assert.match((await search(root, { query: '배정 인계' })).results[0].title, /→ 클로드 앱/);
  const r = await run([BIN, '--project', root, 'search', '인계', '--author', '대표', '--json']);
  assert.equal(JSON.parse(r.stdout).total, 2);
});

test('R4: editing, replacing or deleting only a referenced report updates search without a JSONL change', { skip }, async (t) => {
  const root = await reportProject(t), file = join(root, 'docs', 'wax', 'example', 'report.md');
  await buildIndex(root);
  const totals = async () => [(await search(root, { query: 'originalkeyword' })).total, (await search(root, { query: 'replacementkeyword' })).total];
  await writeFile(file, 'replacementkeyword 고친 본문');
  assert.deepEqual(await totals(), [0, 1], 'edited in place');
  await writeFile(`${file}.tmp`, 'originalkeyword 다시 바꾼 본문'); await rename(`${file}.tmp`, file);
  assert.deepEqual(await totals(), [1, 0], 'replaced by another file');
  await rm(file);
  assert.deepEqual(await totals(), [0, 0], 'deleted: the old text is not served');
  let status = await indexStatus(root);
  assert.deepEqual(status.damaged.filter((d) => d.file), [{ path: 'docs/wax/example/report.md', records: 1, lines: [], file: 'missing' }]);
  const [missing] = (await search(root, { query: '화이트보드 보고서' })).results;
  assert.equal(missing.status, 'file-missing');
  await writeFile(file, 'replacementkeyword 복구한 본문');
  assert.deepEqual(await totals(), [0, 1], 'restored');
  status = await indexStatus(root);
  assert.equal(status.damaged.length, 0); assert.equal(status.state, 'ready');
  await writeFile(file, 'originalkeyword 재시작 전에 고침');
  const r = await run([BIN, '--project', root, 'search', 'originalkeyword', '--json']);
  assert.equal(JSON.parse(r.stdout).total, 1);
  await buildIndex(root, { rebuild: true });
  assert.deepEqual(await totals(), [1, 0]);
  const { saveDailyReport } = await import('../src/chat/daily.mjs');
  const daily = await saveDailyReport(root, { author: '대표', kind: 'human', date: '2026-10-18', markdown: '# 일일 보고\n오늘의 dailykeyword' });
  assert.equal((await search(root, { query: 'dailykeyword' })).total, 1);
  await writeFile(join(root, daily.path), '# 일일 보고\n바꾼 dailyreplaced');
  assert.equal((await search(root, { query: 'dailykeyword' })).total, 0); assert.equal((await search(root, { query: 'dailyreplaced' })).total, 1);
  await writeFile(file, 'concurrentkeyword 동시 반영');
  await Promise.all([search(root, { query: 'concurrentkeyword' }), search(root, { query: 'concurrentkeyword' }), run([BIN, '--project', root, 'search', 'concurrentkeyword'])]);
  const { db } = await openIndex(root);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM docs WHERE kind = 'report' AND type = 'board'").get().n, 1); } finally { db.close(); }
});


const deadPid = () => new Promise((done) => { const child = spawn(process.execPath, ['-e', '']); child.on('close', () => done(child.pid)); });
const markBuilding = async (root, pid) => { const { db } = await openIndex(root); try { db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('building', ?)").run(JSON.stringify({ pid, at: new Date().toISOString() })); } finally { db.close(); } };

test('S1: searching an interrupted index without syncing says it is incomplete and how to resume', { skip }, async (t) => {
  const root = await project(t);
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '중단 전 기록 originalkeyword' });
  await buildIndex(root);
  await markBuilding(root, await deadPid());
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '중단 뒤 기록 replacementkeyword' });
  assert.equal((await indexStatus(root)).state, 'interrupted');
  const skipped = await search(root, { query: 'replacementkeyword' }, { sync: false });
  assert.equal(skipped.total, 0);
  assert.equal(skipped.index.complete, false, 'an unfinished index is not complete just because syncing was skipped');
  assert.equal(skipped.index.synced, false);
  assert.match(skipped.index.note, /중간에 멈췄습니다/);
  assert.equal((await indexStatus(root)).state, 'interrupted', '--no-sync changes nothing');
  const cli = JSON.parse((await run([BIN, '--project', root, 'search', 'replacementkeyword', '--no-sync', '--json'])).stdout);
  assert.equal(cli.index.complete, false); assert.match(cli.index.note, /이어서/);
  const resumed = await search(root, { query: 'replacementkeyword' });
  assert.equal(resumed.total, 1); assert.equal(resumed.index.complete, true); assert.equal(resumed.index.note, null);
  assert.equal((await indexStatus(root)).state, 'ready');
});

test('S2: every record that points at the same Markdown is updated, reading the file once', { skip }, async (t) => {
  const root = await reportProject(t), path = 'docs/wax/example/report.md', file = join(root, path);
  await appendFile(join(root, '.wax', 'chat', 'board', 'example.jsonl'), reportRecord(path, { id: 'r-000002-abc123', seq: 2, number: 2 }) + reportRecord(path, { id: 'r-000003-abc123', seq: 3, number: 3 }));
  await writeFile(join(root, 'docs', 'wax', 'example', 'other.md'), 'otherkeyword 다른 보고서');
  await appendFile(join(root, '.wax', 'chat', 'board', 'example.jsonl'), reportRecord('docs/wax/example/other.md', { id: 'r-000004-abc123', seq: 4, number: 4 }));
  await buildIndex(root);
  const totals = async () => [(await search(root, { query: 'originalkeyword' })).total, (await search(root, { query: 'replacementkeyword' })).total];
  assert.deepEqual(await totals(), [3, 0]);
  await writeFile(file, 'replacementkeyword 세 기록이 함께 보는 본문');
  assert.deepEqual(await totals(), [0, 3], 'no record keeps the old text');
  await writeFile(file, 'originalkeyword 한 번만 읽기');
  const { db } = await openIndex(root);
  try {
    const synced = await syncIndex(root, db);
    assert.deepEqual(synced.references, { files: 1, docs: 3 }, 'one changed file is read once and all three documents are rewritten; the unchanged one is left alone');
    assert.equal(synced.changed, 3);
    assert.deepEqual((await syncIndex(root, db)).references, { files: 0, docs: 0 }, 'nothing left to do');
  } finally { db.close(); }
  await writeFile(file, 'replacementkeyword 다시');
  assert.deepEqual(await totals(), [0, 3]);
  await rm(file);
  assert.deepEqual(await totals(), [0, 0], 'deleted: no record keeps the old text');
  const missing = (await search(root, { query: '화이트보드 보고서', kind: 'report' })).results.filter((r) => r.status === 'file-missing');
  assert.equal(missing.length, 3);
  await writeFile(file, 'originalkeyword 복구');
  assert.deepEqual(await totals(), [3, 0], 'restored for all three');
  assert.equal((await search(root, { query: 'otherkeyword' })).total, 1);
  await writeFile(join(root, '.wax', 'chat', 'board', 'example.jsonl'), reportRecord(path) + reportRecord(path, { id: 'r-000002-abc123', seq: 2, number: 2 }));
  await writeFile(file, 'replacementkeyword 두 기록');
  assert.deepEqual(await totals(), [0, 2]);
});

test('S3: a change to only a referenced Markdown makes a read-only status stale until search applies it', { skip }, async (t) => {
  const root = await reportProject(t), file = join(root, 'docs', 'wax', 'example', 'report.md');
  await buildIndex(root);
  assert.equal((await indexStatus(root)).state, 'ready');
  await writeFile(file, 'replacementkeyword 바뀐 본문');
  let status = await indexStatus(root);
  assert.equal(status.state, 'stale'); assert.equal(status.pending, 1); assert.match(status.next, /반영/);
  assert.equal((await indexStatus(root)).state, 'stale', 'status reads, it does not apply the change');
  assert.equal((await search(root, { query: 'replacementkeyword' })).total, 1);
  assert.equal((await indexStatus(root)).state, 'ready');
  await rm(file);
  status = await indexStatus(root);
  assert.equal(status.state, 'stale', 'a deleted reference counts too'); assert.equal(status.pending, 1);
  const cli = JSON.parse((await run([BIN, '--project', root, 'search', 'status', '--json'])).stdout);
  assert.equal(cli.state, 'stale'); assert.equal(cli.pending, 1);
  await search(root, { query: 'replacementkeyword' });
  status = await indexStatus(root);
  assert.equal(status.state, 'ready'); assert.equal(status.pending, 0);
});

test('a reused PID that started after the build marker is not mistaken for a live build', async () => {
  const { builderStartedAfter } = await import('../src/search.mjs');
  const at = '2026-10-27T05:00:00.000Z', marked = Date.parse(at);
  const lstart = (ms) => new Date(ms).toString().replace(/^(\w{3} \w{3} \d{2}) (\d{4}) (\d{2}:\d{2}:\d{2}).*$/, '$1 $3 $2');
  const ps = (ms) => ({ run: async () => ({ stdout: `${lstart(ms)}\n` }), platform: 'linux' });
  assert.equal(await builderStartedAfter(4242, at, ps(marked + 10_000)), true);
  assert.equal(await builderStartedAfter(4242, at, ps(marked - 10_000)), false);
  assert.equal(await builderStartedAfter(4242, at, ps(marked + 900)), false);
  assert.equal(await builderStartedAfter(4242, at, { run: async () => { throw new Error('no such process'); }, platform: 'darwin' }), false);
  assert.equal(await builderStartedAfter(4242, 'not a date', ps(marked + 10_000)), false);
  assert.equal(await builderStartedAfter(4242, at, { run: async () => { throw new Error('must not run'); }, platform: 'win32' }), false);
  if (process.platform !== 'win32') {
    assert.equal(await builderStartedAfter(process.pid, new Date(Date.now() + 60_000).toISOString()), false);
    assert.equal(await builderStartedAfter(process.pid, new Date(Date.now() - 3_600_000).toISOString()), true);
  }
});

test('the search CLI covers help, a missing index, building, empty results, paging and bad options', { skip }, async (t) => {
  const root = await project(t);
  const search = (...args) => run([BIN, '--project', root, 'search', ...args]);
  let r = await search('--help');
  assert.equal(r.code, 0); assert.match(r.stdout, /^wax search — 기록 검색/); assert.match(r.stdout, /wax search index \[--rebuild\]/);
  r = await search('status');
  assert.equal(r.code, 2); assert.match(r.stdout, /^검색 색인: missing/);
  for (let i = 0; i < 3; i++) await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: `배포 점검 ${i}` });
  r = await search('index');
  assert.equal(r.code, 0); assert.match(r.stdout, /^검색 색인 동기화 완료: 원본 \d+개 중 \d+개 반영/);
  r = await search('찾을수없는단어', '--no-sync');
  assert.equal(r.code, 0); assert.match(r.stdout, /"찾을수없는단어" 0건/); assert.match(r.stdout, /결과가 없습니다/);
  r = await search('배포', '--limit', '2');
  assert.equal(r.code, 0); assert.match(r.stdout, /"배포" 3건/);
  const next = /--cursor (\S+)/.exec(r.stdout)?.[1];
  assert.ok(next, r.stdout);
  r = await search('배포', '--limit', '2', '--cursor', next, '--json');
  assert.equal(JSON.parse(r.stdout).results.length, 1);
  r = await search('배포', '--unknown');
  assert.equal(r.code, 1); assert.match(r.stderr, /^wax search: .*--unknown/);
});
