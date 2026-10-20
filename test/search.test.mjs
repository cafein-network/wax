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

const sqlite = await loadSqlite();
const skip = sqlite.error ? `node:sqlite with FTS5 unavailable: ${sqlite.error}` : false;
const STORE = new URL('../src/chat/store.mjs', import.meta.url).href;
const channelFile = (root, name) => join(root, '.wax', 'chat', 'channels', `${name}.jsonl`);
const line = (seq, body, extra = {}) => `${JSON.stringify({ schema: 1, id: `m-${String(seq).padStart(6, '0')}-abc123`, seq, channel: 'general', author: 'codex-app', kind: 'codex', type: 'message', body, at: new Date(Date.UTC(2026, 9, 18, 0, 0, seq)).toISOString(), ...extra })}\n`;
const refs = async (root, query, input = {}) => (await search(root, { query, limit: 50, ...input })).results.map((r) => r.ref);
const count = async (root) => { const { db } = await openIndex(root); try { return db.prepare('SELECT count(*) AS n FROM docs').get().n; } finally { db.close(); } };
const run = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [...(options.node ?? []), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
});

async function korean(t) {
  const root = await project(t);
  await createFeature(root, { id: 'lookbook-upload', title: '룩북 업로드 화면', description: '디자인 인계를 확인하고 Claude Code로 구현합니다.' });
  await postMessage(root, 'lookbook-upload', { author: 'claude-app', kind: 'claude', body: '디자인 인계를 확인했습니다. docs/wax/design/handoff-v2.md 리뷰 부탁해요 (commit a1b2c3d9)' });
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '오류 원인: UI 버튼 리뷰 필요. 100% 확인, 이름_밑줄 "따옴표" 포함' });
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '계획과 다른 이야기입니다. reviewer handoff note' });
  await buildIndex(root);
  return root;
}

test('Korean, short words, tool names, paths and SHAs are found with the documented method', { skip }, async (t) => {
  const root = await korean(t);
  const cases = { 인계: 2, 인계를: 2, 리뷰: 2, 오류: 1, UI: 1, '"Claude Code"': 1, 'handoff-v2.md': 1, a1b2c3d9: 1, a1b2c3d: 1, 계: 3, '디자인 인계': 2, 'docs/wax/design': 1, '100%': 1, '이름_밑줄': 1, '"따옴표"': 1, '따옴표': 1, handoff: 2 };
  for (const [query, expected] of Object.entries(cases)) assert.equal((await refs(root, query)).length, expected, query);
  assert.deepEqual(['인계', '인계를', '계', 'UI', '1%'].map((term) => plan(term).via), ['bigram', 'trigram', 'scan', 'bigram', 'scan']);
  assert.equal((await refs(root, '인계 리뷰')).length, 1, 'terms are combined with AND');
  for (const hostile of ['"', "'); DROP TABLE docs; --", 'NEAR(a b)', '*', 'a OR b', '-x', '%', '_', '\\']) await assert.doesNotReject(search(root, { query: hostile }), hostile);
  assert.equal(await count(root) > 0, true, 'hostile input did not change the index');
  assert.deepEqual(terms('"Claude Code" 인계  인계'), ['Claude Code', '인계']);
  assert.equal(bigrams('인계를 UI'), '인계 계를 ui');
  assert.deepEqual(marksIn('디자인 인계를 인계', ['인계']), [[4, 6], [8, 10]]);
  const [hit] = (await search(root, { query: '인계', kind: 'message' })).results;
  assert.equal(hit.snippet.text.slice(hit.snippet.marks[0][0], hit.snippet.marks[0][1]), '인계');
  assert.match(hit.source, /^\.wax\/chat\/channels\/lookbook-upload\.jsonl#m-/); assert.match(hit.link, /^\/chat\?channel=lookbook-upload#m-/);
});

test('filters, stable pages and the records behind each result', { skip }, async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'checkout', title: '결제 개편' });
  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  await writeFile(channelFile(root, 'general'), Array.from({ length: 45 }, (_, i) => line(i + 1, `결제 인계 메모 ${i + 1}`)).join(''));
  await buildIndex(root);
  const seen = [];
  let cursor;
  for (let pageNo = 0; pageNo < 3; pageNo++) {
    const page = await search(root, { query: '인계', limit: 20, cursor });
    seen.push(...page.results.map((r) => r.ref));
    if (pageNo === 0) await appendFile(channelFile(root, 'general'), line(46, '새로 온 인계 메모'));
    cursor = page.next;
    if (!cursor) break;
  }
  assert.equal(seen.length, 45); assert.equal(new Set(seen).size, 45, 'no record twice across pages');
  assert.equal((await search(root, { query: '인계', from: '2026-10-18', to: '2026-10-18', author: 'codex-app', kind: 'message' })).total, 46);
  assert.equal((await search(root, { query: '인계', author: 'someone-else' })).total, 0);
  await assert.rejects(search(root, { query: '인계', from: '18-10-2026' }), /YYYY-MM-DD/);
  await assert.rejects(search(root, { query: '인계', kind: 'secret' }), /종류는/);
  await assert.rejects(search(root, { query: '인계', cursor: 'not-a-cursor' }), /페이지 위치/);
  const feature = await search(root, { query: '결제 개편', kind: 'feature' });
  assert.equal(feature.results[0].source, '.wax/features/checkout.json#/title');
});

test('incremental sync: appends, edits, replacements, truncation, deletions, half-written lines and damaged lines', { skip }, async (t) => {
  const root = await project(t);
  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  const file = channelFile(root, 'general');
  await writeFile(file, line(1, '첫 인계') + line(2, '둘째 메모'));
  await buildIndex(root);
  assert.equal(await count(root), 2);
  await appendFile(file, line(3, '셋째 인계') + '{"broken json\n' + line(5, '다섯째'));
  await appendFile(file, line(6, '쓰는 중인 인계').slice(0, 30));
  assert.deepEqual((await refs(root, '인계')).length, 2);
  let status = await indexStatus(root);
  assert.equal(status.state, 'ready'); assert.deepEqual(status.damaged, [{ path: '.wax/chat/channels/general.jsonl', records: 1, lines: [4] }]);
  await appendFile(file, line(6, '쓰는 중인 인계').slice(30));
  assert.equal((await refs(root, '인계')).length, 3, 'the line is indexed once it is complete');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('첫 인계', '첫 검토'));
  assert.deepEqual((await refs(root, '검토')).length, 1); assert.equal((await refs(root, '인계')).length, 2);
  await writeFile(file, line(1, '새로 시작한 인계'));
  assert.equal((await refs(root, '인계')).length, 1); assert.equal(await count(root), 1, 'nothing from the old file stays');
  await writeFile(`${file}.tmp`, line(1, '교체된 파일의 리뷰')); await rename(`${file}.tmp`, file);
  assert.equal((await refs(root, '리뷰')).length, 1); assert.equal((await refs(root, '인계')).length, 0);
  await createFeature(root, { id: 'search', title: '검색 기능', description: '첫 설명' });
  assert.equal((await refs(root, '첫 설명')).length, 1);
  const feature = JSON.parse(await readFile(join(root, '.wax', 'features', 'search.json'), 'utf8'));
  await updateFeature(root, 'search', 'edit', { title: '검색 기능', description: '바뀐 설명', revision: feature.revision });
  assert.equal((await refs(root, '첫 설명')).length, 0); assert.equal((await refs(root, '바뀐 설명')).length, 1);
  await rm(file);
  assert.equal((await refs(root, '리뷰')).length, 0);
  status = await indexStatus(root);
  assert.equal(status.pending, 0); assert.equal(status.damaged.length, 0);
  const before = await count(root);
  const { db } = await openIndex(root); try { await syncIndex(root, db); await syncIndex(root, db); } finally { db.close(); }
  assert.equal(await count(root), before, 'repeated syncs never duplicate');
});

test('records written by other wax commands are indexed: notes, assignments with status, stage documents and evidence', { skip }, async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'checkout', title: '결제' });
  await postNote(root, 'checkout', { author: 'claude-pm', kind: 'claude', type: 'decision', body: 'A안으로 인계 결정' });
  await setPm(root, { author: 'claude-pm', kind: 'claude' });
  const task = await assignTask(root, { author: 'claude-pm', feature: 'checkout', to: 'codex-ui', phase: 'plan', body: '재시도 오류 문구 정리' });
  await updateTask(root, task.id, 'block', { author: 'codex-ui', body: '오류 코드 목록이 없습니다' });
  let feature = JSON.parse(await readFile(join(root, '.wax', 'features', 'checkout.json'), 'utf8'));
  await updateFeature(root, 'checkout', 'save', { phase: 'plan', content: '# 기획\n재시도 버튼과 오류 안내', revision: feature.revision });
  await buildIndex(root);
  const kinds = async (query) => (await search(root, { query })).results.map((r) => `${r.kind}:${r.feature}`).sort();
  assert.deepEqual(await kinds('인계 결정'), ['note:checkout']);
  assert.deepEqual(await kinds('오류'), ['document:checkout', 'task:checkout', 'task:checkout']);
  const blocked = (await search(root, { query: '오류 코드', kind: 'task' })).results[0];
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.feature, 'checkout', 'a status line knows its task');
});

test('secrets, session tokens and approval records never reach the index', { skip }, async (t) => {
  const root = await project(t);
  const id = 'request-00000000-0000-4000-8000-000000000001';
  await mkdir(join(root, '.wax', 'chat', 'requests'), { recursive: true });
  await writeFile(join(root, '.wax', 'chat', 'requests', `${id}.json`), JSON.stringify({ id, title: '로그인 수정', author: '대표', tool: 'codex', status: 'completed', owner: { pid: 1, instance: 'owner-instance-secret' }, thread: 'thread-secret-123', messages: [{ role: 'user', text: '로그인 오류를 고쳐 주세요', at: '2026-10-18T00:00:00Z' }] }));
  await mkdir(join(root, '.wax', 'approvals'), { recursive: true });
  await writeFile(join(root, '.wax', 'approvals', 'x.json'), JSON.stringify({ secretHash: 'approval-secret-hash', details: { command: 'rm -rf secret' } }));
  await buildIndex(root);
  assert.equal((await refs(root, '로그인 오류')).length, 1);
  for (const secret of ['owner-instance-secret', 'thread-secret-123', 'approval-secret-hash', 'rm -rf secret']) assert.equal((await refs(root, secret)).length, 0, secret);
  const raw = await readFile(join(root, '.wax', 'search', 'index.db'));
  for (const secret of ['owner-instance-secret', 'thread-secret-123', 'approval-secret-hash']) assert.equal(raw.includes(secret), false, `${secret} is not stored`);
});

test('missing, corrupt and outdated indexes are reported and rebuilt without touching the records', { skip }, async (t) => {
  const root = await korean(t);
  const records = async () => createHash('sha256').update(await readFile(channelFile(root, 'general'))).digest('hex');
  const before = await records();
  const empty = await project(t);
  assert.equal((await indexStatus(empty)).state, 'missing');
  await assert.rejects(search(empty, { query: '인계' }), (error) => error.state === 'missing' && /wax search index/.test(error.message));
  await rm(join(root, '.wax', 'search', 'index.db-wal'), { force: true });
  await writeFile(join(root, '.wax', 'search', 'index.db'), 'not a database at all '.repeat(100));
  assert.equal((await indexStatus(root)).state, 'corrupt');
  await assert.rejects(search(root, { query: '인계' }), (error) => error.state === 'corrupt' && /--rebuild/.test(error.message));
  const rebuilt = await buildIndex(root, { rebuild: true });
  assert.equal(rebuilt.documents, 4); assert.equal((await refs(root, '인계')).length, 2);
  const { db } = await openIndex(root); db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema'").run(); db.close();
  assert.equal((await indexStatus(root)).state, 'outdated');
  await buildIndex(root, { rebuild: true });
  assert.equal((await indexStatus(root)).state, 'ready');
  assert.equal(await records(), before, 'project records are never changed');
});

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
  let status;
  for (let i = 0; i < 100; i++) { status = await (await fetch(`${base}/api/search/status`)).json(); if (!status.job.running) break; await new Promise((done) => setTimeout(done, 50)); }
  assert.equal(status.state, 'ready'); assert.equal(status.job.result.documents, 1);
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '방금 쓴 인계 메모' });
  const found = await (await fetch(`${base}/api/search?q=${encodeURIComponent('인계')}&kind=message&limit=1`)).json();
  assert.equal(found.total, 2); assert.equal(found.results.length, 1); assert.ok(found.next, 'a second page exists');
  assert.equal(found.results[0].snippet.text, '방금 쓴 인계 메모', 'records written after the build are found');
  const [, id] = found.results[0].link.split('#');
  assert.equal((await (await fetch(`${base}/api/channels/general/messages?id=${id}`)).json()).messages[0].body, '방금 쓴 인계 메모');
  const page = await fetch(`${base}/search`);
  assert.equal(page.status, 200); assert.match(await page.text(), /id="search-q"/);
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

const RECOVERY_RECORDS = 16_000;
async function bigChannel(root, lines = RECOVERY_RECORDS) {
  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  for (let c = 0; c < 4; c++) await writeFile(channelFile(root, `c-${c}`), Array.from({ length: lines / 4 }, (_, i) => line(i + 1, `개발 메모 ${c}-${i}`)).join(''));
}
const ownerPid = async (root) => { for (let i = 0; i < 400; i++) { const owner = await readFile(join(root, '.wax', 'search', 'rebuild.lock', 'owner.json'), 'utf8').then(JSON.parse, () => null); if (owner?.pid) return owner.pid; await new Promise((done) => setTimeout(done, 10)); } throw new Error('no builder'); };

test('R2: a killed build is reported as interrupted, not building, and search finishes it', { skip }, async (t) => {
  const root = await project(t);
  await bigChannel(root);
  await buildIndex(root);
  const child = spawn(process.execPath, [BIN, '--project', root, 'search', 'index', '--rebuild']);
  const closed = new Promise((done) => child.on('close', done));
  const pid = await ownerPid(root);
  let status;
  for (let i = 0; i < 400 && (status = await indexStatus(root)).state !== 'building'; i++) await new Promise((done) => setTimeout(done, 5));
  assert.equal(status.state, 'building', 'a live build is not interrupted'); assert.equal(status.building.live, true);
  const partial = await search(root, { query: '개발' });
  assert.equal(partial.index.complete, false); assert.equal(partial.index.synced, false, 'a live build is left alone');
  process.kill(pid, 'SIGKILL'); await closed;
  status = await indexStatus(root);
  assert.equal(status.state, 'interrupted'); assert.equal(status.building.live, false); assert.match(status.next, /이어서/);
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: 'replacementkeyword 중단 뒤 새 기록' });
  const found = await search(root, { query: 'replacementkeyword' });
  assert.equal(found.total, 1); assert.equal(found.index.complete, true); assert.equal(found.index.synced, true);
  assert.equal((await search(root, { query: '개발' })).total, '1000+');
  status = await indexStatus(root);
  assert.equal(status.state, 'ready'); assert.equal(status.documents, RECOVERY_RECORDS + 1); assert.equal(status.building, null);
});

test('R2: two builds at once both finish and leave a complete index', { skip }, async (t) => {
  const root = await project(t);
  await bigChannel(root, 8000);
  const results = await Promise.all([run([BIN, '--project', root, 'search', 'index']), run([BIN, '--project', root, 'search', 'index', '--rebuild']), buildIndex(root)]);
  for (const r of results.slice(0, 2)) assert.equal(r.code, 0, r.stderr);
  const status = await indexStatus(root);
  assert.equal(status.state, 'ready'); assert.equal(status.documents, 8000);
});

test('R2: after a dashboard restart an interrupted build is shown with a resume action that completes it', { skip }, async (t) => {
  const { createChatServer } = await import('../src/chat/server.mjs');
  const root = await project(t);
  await bigChannel(root);
  const start = async () => {
    const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => server.listening ? server.shutdown() : undefined);
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, base, token: (await (await fetch(`${base}/api/config`)).json()).token };
  };
  const dir = join(root, '.wax', 'search');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.db.new-2147483646-1'), 'left by a killed build');
  await buildIndex(root);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('index.db.new-')), []);
  let { server, base, token } = await start();
  await fetch(`${base}/api/search/index`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify({ rebuild: true }) });
  const pid = await ownerPid(root);
  for (let i = 0; i < 400 && (await indexStatus(root)).state !== 'building'; i++) await new Promise((done) => setTimeout(done, 5));
  process.kill(pid, 'SIGKILL');
  let stopped;
  for (let i = 0; i < 400; i++) {
    stopped = await (await fetch(`${base}/api/search/status`)).json();
    if (!stopped.job?.running) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(stopped.job?.running, false, JSON.stringify(stopped));
  assert.equal(stopped.state, 'interrupted', JSON.stringify(stopped));
  await server.shutdown();
  ({ server, base, token } = await start());
  let status = await (await fetch(`${base}/api/search/status`)).json();
  assert.equal(status.state, 'interrupted'); assert.equal(status.job, null);
  await postMessage(root, 'general', { author: '대표', kind: 'human', body: '재시작 뒤 인계' });
  await fetch(`${base}/api/search/index`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: '{}' });
  for (let i = 0; i < 200; i++) { status = await (await fetch(`${base}/api/search/status`)).json(); if (!status.job?.running) break; await new Promise((done) => setTimeout(done, 50)); }
  assert.equal(status.state, 'ready', JSON.stringify(status.job)); assert.equal(status.documents, RECOVERY_RECORDS + 1);
  const found = await (await fetch(`${base}/api/search?q=${encodeURIComponent('인계')}&author=${encodeURIComponent('대표')}`)).json();
  assert.equal(found.total, 1);
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
