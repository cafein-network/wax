import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { APPROACH_EXCUSES, approachForScreen, approachPrompt, approachState, approachSummary, approachWorkerPrompt, validApproach } from '../src/approach.mjs';
import { DEFAULT_BUDGETS, EXECUTABLE, HUMAN_KINDS, autoRule, budgetUsage, createGoal, nextActions, workerPrompt } from '../src/chat/pm-loop.mjs';
import { featureStatus } from '../src/status.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildQualityReport } from '../src/quality-report.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const WORKER = 'wax-worker-claude';
const items = [
  { title: '서버에서 계산', summary: '합계를 API에서 계산', tradeoffs: '요청이 하나 늘어남', cost: 'S', risk: 'low' },
  { title: '브라우저에서 계산', summary: '화면에서 계산 @alice', tradeoffs: '두 곳에 같은 계산', cost: 'M', risk: 'medium' },
];

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-approach-card-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createFeature(dir, { id: 'calc', title: '금액 계산', projectType: 'general' });
  await updateFeature(dir, 'calc', 'save', { phase: 'plan', content: '# 기획\n범위: 합계' });
  await completePhase(dir, 'calc', 'plan', { evidence: '기획 확인' });
  await mkdir(join(dir, '.wax', 'tmp'), { recursive: true });
  return dir;
}
const propose = (root, value = items) => updateFeature(root, 'calc', 'approach-propose', { approach: value, author: WORKER });
const pick = (root, number, extra = {}) => updateFeature(root, 'calc', 'approach-pick', { approach: { number }, author: '대표', pickVia: 'dashboard', ...extra });
const again = (root, note = '저장 공간을 덜 쓰는 방법 @bob', extra = {}) => updateFeature(root, 'calc', 'approach-again', { approach: { note }, author: '대표', pickVia: 'dashboard', ...extra });


test('"propose again" is a person’s note: refused for workers, machines and worker runs; it lets a worker replace a picked round, up to 3 rounds', async (t) => {
  const root = await workspace(t);
  await assert.rejects(again(root), (error) => error.status === 409 && /고를 방법이 없습니다/.test(error.message));
  await propose(root);
  await pick(root, 1);
  await assert.rejects(propose(root), (error) => error.status === 409 && /이미 방법을 골랐습니다/.test(error.message), 'a worker cannot replace the pick on its own');
  for (const name of [WORKER, 'auto', 'pm-loop']) await assert.rejects(again(root, '메모', { author: name }), (error) => error.status === 403, name);
  process.env.WAX_WORKER = '1';
  try { await assert.rejects(again(root), (error) => error.status === 403); } finally { delete process.env.WAX_WORKER; }
  await assert.rejects(again(root, '  '), /메모/);
  await assert.rejects(again(root, '메모', { pickVia: 'phone' }), /cli, dashboard/);
  await updateFeature(root, 'calc', 'save', { phase: 'design', content: '# 설계\n고른 방법으로' });
  let feature = await again(root);
  assert.deepEqual({ ...feature.approach.again, at: undefined }, { round: 1, by: '대표', via: 'dashboard', note: '저장 공간을 덜 쓰는 방법 @bob', at: undefined });
  assert.equal(validateStored(feature), feature);
  assert.deepEqual(feature.history.filter((event) => event.action === 'approach-again').map((event) => [event.round, event.author]), [[1, '대표']]);
  assert.equal(approachState(feature).state, 'again');
  await assert.rejects(completePhase(root, 'calc', 'design', { evidence: '설계' }), (error) => error.status === 409 && /다시 내 달라고/.test(error.message));
  feature = await propose(root, [items[1], items[0]]);
  assert.equal(approachState(feature).state, 'waiting', 'the new round needs a new pick; the earlier pick and note stay in the record');
  assert.equal(feature.approach.pick.round, 1);
  await again(root, '하나 더');
  await propose(root);
  await assert.rejects(again(root, '또'), (error) => error.status === 409 && /3번까지/.test(error.message));
  await pick(root, 2);
  await completePhase(root, 'calc', 'design', { evidence: '설계' });
  assert.equal((await getFeature(root, 'calc')).completed.design.approach.state, 'picked');
  assert.equal(validApproach({ proposals: [], pick: null, single: null, again: { round: 1, by: '대표', via: 'dashboard', note: 'x', at: new Date().toISOString() } }), false, 'again must point at a round');
});


test('design prompt: propose first (with the excuse lines), wait while a person picks, propose again with the note, then design with the chosen one; off and other phases add nothing', async (t) => {
  const root = await workspace(t);
  let feature = await getFeature(root, 'calc');
  const prompt = () => buildPrompt(feature, 'design');
  assert.match(prompt(), /방법 2~3개를 CLI approach calc --propose --file/);
  assert.match(prompt(), /--single "<사유>"/);
  assert.ok(prompt().includes(APPROACH_EXCUSES));
  assert.doesNotMatch(buildPrompt(feature, 'plan'), /approach calc/);
  assert.doesNotMatch(approachPrompt({ ...feature, discipline: { approach: 'always' } }).join('\n'), /--single "/, 'always does not offer --single');
  assert.deepEqual(approachPrompt({ ...feature, discipline: { approach: 'off' } }), []);
  feature = await propose(root);
  assert.match(prompt(), /사람이 아직 고르지 않았습니다/);
  assert.match(prompt(), /--pick <번호>/);
  feature = await again(root);
  assert.match(prompt(), /다시 내 달라고 했습니다/);
  assert.match(prompt(), /"proposeAgain"[\s\S]*`@bob`/, 'the person’s note is quoted data with mentions defused');
  feature = await propose(root);
  feature = await pick(root, 2, { approach: { number: 2, reason: '배포가 막혀 있음' } });
  assert.match(prompt(), /chosen 방법으로 설계하세요/);
  assert.match(prompt(), /"chosen": \{\n> {5}"number": 2/);
  assert.match(prompt(), /> .*`@alice`/, 'worker text in the quote is unmentioned');
});

test('worker prompt: a design worker with nothing proposed proposes and ends with outcome=done without completing; after a pick it writes the design', async (t) => {
  const root = await workspace(t);
  let feature = await getFeature(root, 'calc');
  const goal = { id: 'goal-0000000a', title: '목표', features: ['calc'], budgets: { ...DEFAULT_BUDGETS } };
  const taskOf = { id: 't-000001-aaaaaa', phase: 'design', note: '' };
  const text = () => workerPrompt({ root, goal, feature, task: taskOf, author: WORKER });
  assert.match(text(), /approach calc --propose --file <그 파일> --author wax-worker-claude/);
  assert.match(text(), /단계를 완료하지 말고 바로 outcome=done/);
  assert.equal(approachWorkerPrompt(feature, 'implement', { author: WORKER }), '');
  feature = await propose(root);
  feature = await pick(root, 1);
  assert.equal(approachWorkerPrompt(feature, 'design', { author: WORKER }), '');
  assert.match(text(), /chosen 방법으로 설계하세요/);
});


const NOW = Date.parse('2026-11-05T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const loopGoal = (extra = {}) => ({ id: 'goal-0000000b', title: '목표', state: 'running', mode: 'auto', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 60 * MIN), ...extra });
const round = (at, n = 1) => ({ round: n, at: iso(at), author: WORKER, items });
const loopFeature = (approach, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase: 'design', iteration: 0, revision: 7, updatedAt: iso(NOW - 5 * MIN), completed: { plan: { at: iso(NOW - 50 * MIN) } },
  history: [{ action: 'complete', phase: 'plan', at: iso(NOW - 50 * MIN) }], artifacts: { plan: '# 기획' }, ...(approach ? { approach } : {}), ...extra });
const proposer = { id: 't-000001-aaaaaa', feature: 'f1', to: WORKER, phase: 'design', status: 'done', at: iso(NOW - 30 * MIN), statusAt: iso(NOW - 20 * MIN),
  updates: [{ status: 'done', at: iso(NOW - 20 * MIN), warning: '단계 완료 기록 없음' }] };
const launched = [
  { kind: 'start-worker', outcome: 'executed', key: 'f1:0:design:start-worker:none', feature: 'f1', phase: 'design', iteration: 0, by: 'auto', at: iso(NOW - 31 * MIN) },
  { kind: 'worker', outcome: 'launched', worker: 'pw-00000001', tool: 'claude', feature: 'f1', phase: 'design', iteration: 0, task: proposer.id, to: WORKER, at: iso(NOW - 30 * MIN) },
  { kind: 'worker', outcome: 'exited', result: 'done', warning: '단계 완료 기록 없음', worker: 'pw-00000001', tool: 'claude', feature: 'f1', phase: 'design', iteration: 0, task: proposer.id, to: WORKER,
    snapshots: { ok: true }, at: iso(NOW - 20 * MIN) },
];
const compute = (feature, extra = {}) => nextActions({ goal: loopGoal(), features: [feature], tasks: [proposer], decisions: launched, now: NOW, tools: ['claude', 'codex'], stuck: 'stop', ...extra });

test('approach-wait: proposals not yet picked are one person card (pick-approach) with no done warning, no retry and nothing auto runs', () => {
  const result = compute(loopFeature({ proposals: [round(NOW - 25 * MIN)], pick: null, single: null }));
  assert.deepEqual(result.suggestions.map((item) => item.kind), ['pick-approach']);
  const [card] = result.suggestions;
  assert.deepEqual([card.human, card.executable, card.round, card.count, card.revision, card.rounds, card.items.length, autoRule(card)], [true, false, 1, 2, 7, 1, 2, null]);
  assert.ok(HUMAN_KINDS.has('pick-approach') && !EXECUTABLE.has('pick-approach'));
  assert.equal(result.state, 'waiting-human');
  assert.doesNotMatch(card.reason, /서버에서 계산/, 'the reason does not carry worker text (it is logged)');
  assert.deepEqual(compute(loopFeature({ proposals: [round(NOW - 25 * MIN)], pick: null, single: null }), { now: NOW + 48 * 60 * MIN, goal: loopGoal({ budgets: { ...DEFAULT_BUDGETS, hours: 168 } }) }).suggestions.map((item) => item.kind), ['pick-approach']);
});

test('after a pick (or "propose again") the next card starts the design worker; the proposer’s unfinished done gives no renotify, escalate or retry-unfinished; both runs count as phase runs', () => {
  const picked = { proposals: [round(NOW - 25 * MIN)], pick: { round: 1, index: 0, by: '대표', via: 'dashboard', at: iso(NOW - 10 * MIN) }, single: null };
  const result = compute(loopFeature(picked));
  assert.deepEqual(result.suggestions.map((item) => item.kind), ['start-worker']);
  assert.equal(result.suggestions[0].after, proposer.id);
  const askedAgain = compute(loopFeature({ ...picked, again: { round: 1, by: '대표', via: 'dashboard', note: '다른 방법', at: iso(NOW - 5 * MIN) } }));
  assert.deepEqual(askedAgain.suggestions.map((item) => item.kind), ['start-worker']);
  const plain = compute(loopFeature(null));
  assert.ok(plain.suggestions.some((item) => ['auto-retry', 'escalate', 'renotify'].includes(item.kind)), plain.suggestions.map((item) => item.kind).join(','));
  const second = { kind: 'start-worker', outcome: 'executed', key: `f1:0:design:start-worker:${proposer.id}`, feature: 'f1', phase: 'design', iteration: 0, by: '대표', at: iso(NOW - MIN) };
  assert.equal(budgetUsage({ goal: loopGoal(), features: [loopFeature(picked)], tasks: [proposer], decisions: [...launched, second], now: NOW }).usage.phaseRuns, 2);
  assert.notDeepEqual(compute(loopFeature({ proposals: [round(NOW - 25 * MIN)], pick: null, single: null }, { discipline: { approach: 'off' } })).suggestions.map((item) => item.kind), ['pick-approach']);
});

test('goal start setting: approach ask|always|off goes on every task of the goal and on the goal; empty leaves WAX_APPROACH; other values are 400', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'other', title: '다른 작업' });
  await assert.rejects(createGoal(root, { title: '틀림', features: ['calc'], approach: 'sometimes' }, { author: '대표' }), (error) => error.status === 400 && /ask, always, off/.test(error.message));
  const goal = await createGoal(root, { title: '방법 고르기', features: ['calc'], approach: 'always', redGreen: true }, { author: '대표' });
  assert.deepEqual(goal.discipline, { redGreen: 'enforce', approach: 'always' });
  assert.deepEqual((await getFeature(root, 'calc')).discipline, { redGreen: 'enforce', approach: 'always' });
  assert.equal(approachState(await getFeature(root, 'calc')).mode, 'always');
  const plain = await createGoal(root, { title: '기본', features: ['other'], approach: '' }, { author: '대표' });
  assert.equal(plain.discipline, undefined);
  assert.equal((await getFeature(root, 'other')).discipline, undefined);
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

test('dashboard API: GET shows the record; pick and again need the token, a person and the seen revision, and record via dashboard', async (t) => {
  const root = await workspace(t);
  const { base, post } = await server(t, root);
  let shown = await (await fetch(`${base}/api/features/calc/approach`)).json();
  assert.deepEqual([shown.state, shown.mode, shown.proposal, shown.designSaved], ['none', 'warn', null, false]);
  await propose(root);
  shown = await (await fetch(`${base}/api/features/calc/approach`)).json();
  assert.deepEqual([shown.state, shown.proposal.items[1].summary, shown.rounds], ['waiting', '화면에서 계산 @alice', 1]);
  assert.equal((await post('/api/features/calc/approach/pick', { index: 0, revision: shown.revision }, {})).status, 403, 'no token');
  assert.equal((await post('/api/features/calc/approach/pick', { index: 0 })).status, 400, 'revision required');
  assert.equal((await post('/api/features/calc/approach/pick', { index: -1, revision: shown.revision })).status, 400);
  assert.equal((await post('/api/features/calc/approach/pick', { index: 5, revision: shown.revision })).status, 400);
  assert.equal((await post('/api/features/calc/approach/pick', { index: 0, revision: shown.revision + 3 })).status, 409);
  const ok = await post('/api/features/calc/approach/pick', { index: 1, reason: '배포가 막혀 있음', revision: shown.revision });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual([body.state, body.pick.index, body.pick.by, body.pick.via, body.pick.reason], ['picked', 1, '대표', 'dashboard', '배포가 막혀 있음']);
  assert.equal((await post('/api/features/calc/approach/again', { note: '', revision: body.revision })).status, 400);
  const asked = await (await post('/api/features/calc/approach/again', { note: '하나 더', revision: body.revision })).json();
  assert.deepEqual([asked.state, asked.again.note, asked.again.via], ['again', '하나 더', 'dashboard']);
});

test('dashboard API refuses a worker-named or machine dashboard user (403) and writes nothing', async (t) => {
  const root = await workspace(t);
  const { revision } = await propose(root);
  for (const user of [WORKER, 'auto']) {
    const { post } = await server(t, root, user);
    assert.equal((await post('/api/features/calc/approach/pick', { index: 0, revision })).status, 403, user);
    assert.equal((await post('/api/features/calc/approach/again', { note: '다시', revision })).status, 403, user);
  }
  assert.equal((await getFeature(root, 'calc')).approach.pick, null);
});


test('status, quality report and PR draft show the chosen approach, reason and the others; a --single shows the skip reason; text is inline-quoted', async (t) => {
  const root = await workspace(t);
  assert.equal((await featureStatus(root, 'calc')).approachSummary, undefined);
  await propose(root, [{ ...items[0], title: '서버 | <b>계산</b> @carol' }, items[1]]);
  await pick(root, 1, { approach: { number: 1, reason: '빠름' } });
  const status = await featureStatus(root, 'calc');
  assert.deepEqual([status.approachSummary.state, status.approachSummary.others], ['picked', ['브라우저에서 계산']]);
  assert.match(status.approachSummary.line, /고른 방법: 서버 \| <b>계산<\/b> @carol · 대표 · 이유: 빠름/);
  const report = (await buildQualityReport(root, 'calc', { language: 'ko' })).body;
  assert.match(report, /## 설계 방법\n\n고른 방법: 서버 \\\| &lt;b&gt;계산&lt;\/b&gt; `@carol` · 대표 · 이유: 빠름\n\n고르지 않은 방법: 브라우저에서 계산/);
  const pr = (await buildPrBody(root, 'calc', { language: 'en' })).body;
  assert.match(pr, /## Design approach\n\nChosen: .*`@carol` · 대표 · Reason: 빠름\n\nNot chosen: 브라우저에서 계산/);
  const single = await workspace(t);
  await updateFeature(single, 'calc', 'approach-single', { approach: '설정 한 줄 @dan' });
  assert.match((await buildPrBody(single, 'calc', { language: 'ko' })).body, /방법 고르기 건너뜀: 설정 한 줄 `@dan`/);
  assert.deepEqual(approachSummary(await getFeature(single, 'calc')), { state: 'single', mode: 'warn', reason: '설정 한 줄 @dan' });
  assert.equal(approachForScreen(await getFeature(single, 'calc')).state, 'single');
});
