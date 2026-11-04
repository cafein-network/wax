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
