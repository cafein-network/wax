import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPrompt, completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { RULING_LIMITS, overrideEffect } from '../src/rulings.mjs';
import { dueDefects } from '../src/defects.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildQualityReport } from '../src/quality-report.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { DEFAULT_BUDGETS, nextActions } from '../src/chat/pm-loop.mjs';

const AUTHOR = 'wax-worker-claude';
const sample = { what: '날짜 계산을 src/date.js로 뺌', why: '두 곳에서 같은 계산', cost: '되돌리면 파일 하나 합치기' };

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-ruling-mark-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createFeature(dir, { id: 'calc', title: '금액 계산', projectType: 'general' });
  return dir;
}
const record = (root, input = sample) => updateFeature(root, 'calc', 'ruling', { ruling: input, author: AUTHOR });
const mark = (root, ruling, action, extra = {}) => updateFeature(root, 'calc', 'ruling-mark', { ruling, mark: action, author: '대표', ...extra });
const proof = (feature, extra = {}) => ({ id: randomUUID(), kind: 'test', phase: feature.phase, iteration: feature.iteration, at: new Date().toISOString(), command: ['node', '--test'],
  commit: null, dirty: null, durationMs: 1, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, ...extra });
async function advance(root, phases) {
  for (const phase of phases) {
    await updateFeature(root, 'calc', 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, 'calc', 'complete', { phase, evidence: '확인', ...(['implement', 'review'].includes(phase) ? { waiver: '진행만 확인' } : {}), ...(phase === 'review' ? { verdict: 'pass' } : {}), redGreen: 'off' });
  }
}

test('acknowledge marks the ruling (who, when, optional note), can be pressed again, and leaves a ruling-mark history entry', async (t) => {
  const root = await workspace(t);
  await record(root);
  const first = await mark(root, 'R-1', 'acknowledge');
  assert.equal(first.rulings[0].status, 'acknowledged');
  assert.equal(first.rulings[0].marked.by, '대표');
  assert.equal(first.rulings[0].marked.note, undefined);
  const again = await mark(root, 'R-1', 'acknowledge', { note: '괜찮음' });
  assert.equal(again.rulings[0].marked.note, '괜찮음');
  assert.deepEqual(again.history.filter((event) => event.action === 'ruling-mark').map((event) => [event.ruling, event.mark, event.author, event.phase]),
    [['R-1', 'acknowledge', '대표', 'plan'], ['R-1', 'acknowledge', '대표', 'plan']]);
  assert.equal(again.defects, undefined, 'acknowledging opens no defect');
  assert.equal(again.phase, 'plan');
  assert.equal(validateStored(again), again);
});

test('only a person can mark: engine, auto and worker names are 403, and so is any call inside a headless worker (WAX_WORKER=1)', async (t) => {
  const root = await workspace(t);
  await record(root);
  for (const author of ['auto', 'pm-loop', AUTHOR, 'wax-worker-codex', undefined, 'bad;name']) {
    await assert.rejects(mark(root, 'R-1', 'acknowledge', { author }), (error) => error.status === 403, String(author));
  }
  const previous = process.env.WAX_WORKER;
  process.env.WAX_WORKER = '1';
  t.after(() => { if (previous === undefined) delete process.env.WAX_WORKER; else process.env.WAX_WORKER = previous; });
  await assert.rejects(mark(root, 'R-1', 'acknowledge'), (error) => error.status === 403);
  delete process.env.WAX_WORKER;
  assert.equal((await getFeature(root, 'calc')).rulings[0].status, 'open', 'nothing was written');
});

test('decide again while implementing opens a defect in this cycle (source.ruling) that this cycle’s review must recheck; the stage stays', async (t) => {
  const root = await workspace(t);
  await advance(root, ['plan', 'design']);
  await record(root, { ...sample, what: '반올림은 0.5에서 올림' });
  assert.equal(overrideEffect(await getFeature(root, 'calc')), 'defect');
  await assert.rejects(mark(root, 'R-1', 'override'), (error) => error.status === 400 && /메모/.test(error.message));
  await assert.rejects(mark(root, 'R-1', 'override', { note: 'x'.repeat(RULING_LIMITS.note + 1) }), (error) => error.status === 400);
  const feature = await mark(root, 'R-1', 'override', { note: '반올림은 내림으로 하세요' });
  assert.deepEqual([feature.phase, feature.iteration], ['implement', 0]);
  const [defect] = feature.defects;
  assert.deepEqual({ ...defect, foundAt: undefined }, { id: 'D-1', title: '결정 다시 정함: 반올림은 0.5에서 올림', detail: '반올림은 내림으로 하세요', status: 'open', foundIteration: 0, foundAt: undefined, author: '대표', source: { ruling: 'R-1' } });
  assert.deepEqual([feature.rulings[0].status, feature.rulings[0].marked.defect, feature.rulings[0].marked.note], ['overridden', 'D-1', '반올림은 내림으로 하세요']);
  assert.deepEqual(dueDefects(feature).map((item) => item.id), ['D-1'], 'due in this cycle');
  assert.match(buildPrompt(feature, 'implement'), /D-1: 결정 다시 정함/);
  await assert.rejects(mark(root, 'R-1', 'acknowledge'), (error) => error.status === 409 && /D-1/.test(error.message));
  await assert.rejects(mark(root, 'R-9', 'acknowledge'), (error) => error.status === 404);
  await updateFeature(root, 'calc', 'save', { phase: 'implement', content: '# implement' });
  await completePhase(root, 'calc', 'implement', { evidence: '고침', waiver: '진행만 확인', redGreen: 'off' });
  await updateFeature(root, 'calc', 'save', { phase: 'review', content: '# review' });
  const review = await getFeature(root, 'calc');
  const passed = proof(review);
  await updateFeature(root, 'calc', 'attach-evidence', { proof: passed });
  await assert.rejects(completePhase(root, 'calc', 'review', { evidence: '봄', verdict: 'pass', proofIds: [passed.id] }), /D-1/);
  const done = await completePhase(root, 'calc', 'review', { evidence: '봄', verdict: 'pass', proofIds: [passed.id], checks: [{ id: 'd-1', status: 'pass', proofIds: [passed.id] }] });
  assert.deepEqual([done.feature.defects[0].status, done.feature.defects[0].resolvedIteration], ['resolved', 0]);
  assert.equal(validateStored(done.feature), done.feature);
});

test('decide again after review goes back to implement like a person’s iterate, with the defect from the cycle before', async (t) => {
  const root = await workspace(t);
  await advance(root, ['plan', 'design', 'implement']);
  await record(root);
  assert.equal(overrideEffect(await getFeature(root, 'calc')), 'iterate');
  const before = await getFeature(root, 'calc');
  const feature = await mark(root, 'R-1', 'override', { note: '한 파일에 두세요', revision: before.revision });
  assert.deepEqual([feature.phase, feature.iteration], ['implement', 1]);
  assert.deepEqual([feature.defects[0].id, feature.defects[0].foundIteration, feature.defects[0].source], ['D-1', 0, { ruling: 'R-1' }]);
  assert.equal(feature.completed.implement, undefined, 'the cycle was archived');
  const tail = feature.history.slice(-3).map((event) => event.action);
  assert.deepEqual(tail, ['ruling-mark', 'archive', 'iterate']);
  const iterate = feature.history.at(-1);
  assert.deepEqual([iterate.reason, iterate.author, iterate.defects, iterate.ruling], ['결정 다시 정함(R-1): 날짜 계산을 src/date.js로 뺌', '대표', ['D-1'], 'R-1']);
  assert.deepEqual(dueDefects(feature).map((item) => item.id), ['D-1']);
  assert.equal(validateStored(feature), feature);
  const finished = await workspace(t);
  await updateFeature(finished, 'calc', 'ruling', { ruling: sample, author: AUTHOR });
  await advance(finished, ['plan', 'design', 'implement', 'review', 'report']);
  const back = await updateFeature(finished, 'calc', 'ruling-mark', { ruling: 'R-1', mark: 'override', note: '다시', author: '대표' });
  assert.deepEqual([back.phase, back.iteration], ['implement', 1]);
});

test('decide again during plan opens a same-cycle defect; stale revision and archived tasks are 409', async (t) => {
  const root = await workspace(t);
  await record(root);
  await assert.rejects(mark(root, 'R-1', 'override', { note: '다시', revision: 99 }), (error) => error.status === 409);
  const feature = await mark(root, 'R-1', 'override', { note: '다시' });
  assert.deepEqual([feature.phase, feature.defects[0].foundIteration], ['plan', 0]);
  await record(root);
  await updateFeature(root, 'calc', 'archive-feature', {});
  await assert.rejects(mark(root, 'R-2', 'acknowledge'), (error) => error.status === 409);
});

async function server(t, root, user = '대표') {
  const app = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off', WAX_CHAT_USER: user } });
  await new Promise((done) => app.listen(0, '127.0.0.1', done));
  t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post };
}

test('dashboard API: GET lists rulings (unacknowledged and flagged first) with the override effect; POST marks only with the token, a person and the seen revision', async (t) => {
  const root = await workspace(t);
  await record(root);
  await record(root, { ...sample, what: '오래된 행 delete' });
  const { base, post } = await server(t, root);
  const listed = await (await fetch(`${base}/api/features/calc/rulings`)).json();
  assert.deepEqual([listed.phase, listed.effect, listed.summary], ['plan', 'defect', { total: 2, unacknowledged: 2, flagged: 1 }]);
  assert.deepEqual(listed.rulings.map((item) => item.id), ['R-2', 'R-1']);
  assert.equal((await post('/api/features/calc/rulings/R-1', { action: 'acknowledge', revision: listed.revision }, {})).status, 403, 'no token');
  assert.equal((await post('/api/features/calc/rulings/R-1', { action: 'approve', revision: listed.revision })).status, 400);
  assert.equal((await post('/api/features/calc/rulings/R-1', { action: 'acknowledge' })).status, 400, 'revision required');
  assert.equal((await post('/api/features/calc/rulings/R-1', { action: 'acknowledge', revision: listed.revision + 5 })).status, 409);
  const ok = await post('/api/features/calc/rulings/R-1', { action: 'acknowledge', revision: listed.revision });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual([body.ruling.status, body.ruling.marked.by, body.revision], ['acknowledged', '대표', listed.revision + 1]);
  const over = await (await post('/api/features/calc/rulings/R-2', { action: 'override', note: '지우지 말고 보관', revision: body.revision })).json();
  assert.deepEqual([over.ruling.status, over.defect.id, over.defect.source], ['overridden', 'D-1', { ruling: 'R-2' }]);
});

test('dashboard API refuses a worker-named dashboard user (403) and writes nothing', async (t) => {
  const root = await workspace(t);
  await record(root);
  const { post } = await server(t, root, AUTHOR);
  const { revision } = await getFeature(root, 'calc');
  const refused = await post('/api/features/calc/rulings/R-1', { action: 'acknowledge', revision });
  assert.equal(refused.status, 403);
  assert.equal((await getFeature(root, 'calc')).rulings[0].status, 'open');
});

test('PR draft and quality report quote "What the worker decided": mentions neutralized, table cells escaped, PR draft up to 10 then a count', async (t) => {
  const root = await workspace(t);
  assert.doesNotMatch((await buildPrBody(root, 'calc', { language: 'ko' })).body, /작업자가 정한 것/);
  assert.match((await buildQualityReport(root, 'calc', { language: 'ko' })).body, /## 작업자가 정한 것\n\n작업자가 남긴 결정 기록이 없습니다\./);
  await record(root, { what: '알림은 @octocat 팀에만 | 표 <b>굵게</b>', why: '요청 글에 그렇게 적힘', cost: '다른 팀이 알림을 못 받음', area: 'behavior' });
  for (let index = 2; index <= 12; index += 1) await record(root, { ...sample, what: `결정 ${index}` });
  await mark(root, 'R-3', 'acknowledge');
  await mark(root, 'R-4', 'override', { note: '@someone 말고 다르게' });
  const pr = (await buildPrBody(root, 'calc', { language: 'en' })).body;
  const section = pr.slice(pr.indexOf('## What the worker decided'), pr.indexOf('\n## ', pr.indexOf('## What the worker decided') + 5));
  assert.match(section, /12 rulings, 10 unacknowledged/);
  const rows = section.split('\n').filter((line) => /^> \| R-/.test(line));
  assert.equal(rows.length, 10);
  assert.match(section, /2 more rulings/);
  const first = rows.find((line) => line.startsWith('> | R-1 '));
  assert.ok(first.includes('`@octocat`'), 'mention neutralized');
  assert.ok(first.includes('\\|') && first.includes('&lt;b&gt;'), 'table cell and HTML escaped');
  assert.ok(!/(^|[^`])@octocat/.test(section.replaceAll('`@octocat`', '')), 'no live mention');
  const report = (await buildQualityReport(root, 'calc', { language: 'ko' })).body;
  const all = report.split('\n').filter((line) => /^> \| R-/.test(line));
  assert.equal(all.length, 12, 'the quality report has all of them');
  assert.ok(all.some((line) => line.startsWith('> | R-4 ') && line.includes('다시 정함 (D-1)') && line.includes('`@someone`')), 'override status, defect and note');
  assert.ok(all.some((line) => line.startsWith('> | R-3 ') && line.includes('사람이 확인함')));
});

test('goal screen counts and the PR draft card note unacknowledged rulings; they do not become a person card', () => {
  const NOW = Date.parse('2026-11-05T10:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const at = iso(NOW - 60_000);
  const ruling = (id, status) => ({ id, phase: 'implement', iteration: 0, at, area: 'other', what: 'a', why: 'b', cost: 'c', flag: false, status, ...(status === 'open' ? {} : { marked: { by: '대표', at } }) });
  const goal = { id: 'goal-0000000e', title: '목표', state: 'running', mode: 'suggest', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 600_000) };
  const feature = (phase, rulings) => ({ id: 'f1', title: 'f1', phase, iteration: 0, updatedAt: at, completed: {}, history: [{ action: 'create', phase: 'plan', at }], artifacts: {}, rulings });
  const done = nextActions({ goal, features: [feature('done', [ruling('R-1', 'open'), ruling('R-2', 'open'), ruling('R-3', 'acknowledged')])], now: NOW, tools: ['claude'] });
  const card = done.suggestions.find((item) => item.kind === 'pr-body');
  assert.match(card.reason, /확인 안 한 결정 2개/);
  const clean = nextActions({ goal, features: [feature('done', [ruling('R-1', 'acknowledged')])], now: NOW, tools: ['claude'] });
  assert.doesNotMatch(clean.suggestions.find((item) => item.kind === 'pr-body').reason, /확인 안 한 결정/);
  const working = nextActions({ goal, features: [feature('implement', [ruling('R-1', 'open')])], now: NOW, tools: ['claude'] });
  assert.ok(working.suggestions.every((item) => !/결정/.test(item.reason ?? '')), 'an open ruling is not a person card');
});
