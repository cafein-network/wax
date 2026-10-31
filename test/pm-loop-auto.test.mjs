import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BIN, project } from './chat-helpers.mjs';
import {
  autoRule, autoUsed, createGoal, createPmLoop, evaluateGoals, executeSuggestion, featureDecisions, goalOverview, nextActions, readDecisions, resumeGoal,
  setJudgeTool, setMode, DEFAULT_BUDGETS, PM_LIMITS,
} from '../src/chat/pm-loop.mjs';
import { assignTask, listTasks, setPm, updateTask } from '../src/chat/team.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { startBeat } from '../src/chat/listeners.mjs';
import { readMessages } from '../src/chat/channels.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { completePhase, PHASES, updateFeature } from '../src/workflow.mjs';

const NOW = Date.parse('2026-10-31T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const TOOLS = ['codex', 'claude'];
const goal = (extra = {}) => ({ id: 'goal-0000000d', title: '목표', state: 'running', mode: 'auto', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 10 * MIN), ...extra });
const feature = (phase, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }], artifacts: {}, ...extra });
const session = (author, kind, extra = {}) => ({ author, kind, effectiveState: 'idle', listening: false, listeningFeatures: null, lastActive: iso(NOW - MIN), ...extra });
const run = (input) => nextActions({ goal: goal(), now: NOW, tools: TOOLS, ...input });
const rules = (result) => result.suggestions.map((card) => [card.kind, autoRule(card)]);
const mustNotRun = async () => { throw new Error('a real tool must not run in tests'); };
const reply = (value) => ({ threadId: 'fake', status: 'completed', message: JSON.stringify(value) });


test('rule: auto takes only the allowed non-human actions', () => {
  const listening = [session('codex-a', 'codex', { listening: true })];
  assert.deepEqual(rules(run({ features: [feature('design')], presence: listening })), [['assign', 'assign-listening']]);
  assert.deepEqual(rules(run({ features: [feature('design')], presence: [session('codex-a', 'codex')], tools: [] })), [['assign', null]], 'a session that is not listening would not wake up: a person decides');
  assert.deepEqual(rules(run({ features: [feature('design')] })), [['start-worker', 'start-worker']]);
  const implemented = feature('review', { completed: { implement: { author: 'codex-a' } }, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }, { action: 'complete', phase: 'implement', at: iso(NOW - 3 * MIN), author: 'codex-a', tool: 'codex' }] });
  const review = run({ features: [implemented] }).suggestions[0];
  assert.deepEqual([review.kind, review.tool, autoRule(review)], ['start-worker', 'claude', 'start-worker-review'], 'review keeps reviewer separation');
  const done = { id: 't-000001-aaaaaa', feature: 'f1', to: 'codex-a', phase: 'design', status: 'done', at: iso(NOW - 4 * MIN), statusAt: iso(NOW - 2 * MIN), updates: [{ status: 'done', at: iso(NOW - 2 * MIN), warning: '단계 완료 기록 없음' }] };
  assert.deepEqual(rules(run({ features: [feature('design')], tasks: [done], presence: listening })), [['renotify', 'renotify-once']]);
  const open = { ...done, status: 'open', updates: [], statusAt: iso(NOW - 40 * MIN), at: iso(NOW - 40 * MIN) };
  assert.deepEqual(rules(run({ features: [feature('design', { updatedAt: iso(NOW - 40 * MIN) })], tasks: [open] })), [['reclaim', 'reclaim-stale']]);
  const blocked = { ...done, status: 'blocked', updates: [{ status: 'blocked', note: '빌드 실패', at: iso(NOW - MIN) }] };
  assert.deepEqual(rules(run({ features: [feature('design')], tasks: [blocked] })), [['blocked', null], ['judge', 'judge-block']]);
  const site = run({ features: [feature('design')], tasks: [blocked] }).suggestions[1].key;
  const proposal = (value) => run({ features: [feature('design')], tasks: [blocked], decisions: [
    { kind: 'judgment', outcome: 'requested', judge: 'pj-0000000a', judgment: 'block', site, tool: 'codex', at: iso(NOW - MIN) },
    { kind: 'judgment', outcome: 'proposed', judge: 'pj-0000000a', proposal: { tool: null, question: null, reason: 'r', ...value }, at: iso(NOW) }] });
  assert.deepEqual(rules(proposal({ action: 'retry' })), [['blocked', null], ['judge-proposal', 'apply-retry']]);
  assert.deepEqual(rules(proposal({ action: 'reassign' })), [['blocked', null], ['judge-proposal', 'apply-reassign']]);
  assert.deepEqual(rules(proposal({ action: 'ask', question: '키는?' })), [['blocked', null], ['judge-proposal', null]], 'ask stays with a person');
  assert.deepEqual(rules(proposal({ action: 'iterate' })), [['blocked', null], ['judge-proposal', null]], 'iterate stays with a person');
});

test('rule: every human decision point stays a card in auto', () => {
  const planning = nextActions({ goal: goal({ state: 'planning', startedAt: null }), features: [feature('plan')], now: NOW, tools: TOOLS });
  assert.deepEqual(rules(planning), [['confirm-plan', null], ['judge', null]], 'plan confirmation and the plan-draft judgment');
  const report = run({ features: [feature('done')] });
  assert.deepEqual(rules(report), [['pr-body', null], ['judge', null]], 'the report PR draft and the CEO report');
  const awaitPr = run({ features: [feature('done')], decisions: [{ key: report.suggestions[0].key, outcome: 'executed', at: iso(NOW) }] });
  assert.deepEqual(rules(awaitPr).map(([kind, rule]) => [kind, rule]), [['await-pr', null], ['judge', null]], 'PR creation, push and merge');
  const sameTool = feature('review', { completed: { implement: { author: 'codex-a' } }, history: [{ action: 'complete', phase: 'implement', at: iso(NOW - MIN), author: 'codex-a', tool: 'codex' }] });
  assert.deepEqual(rules(run({ tools: ['codex'], features: [sameTool], presence: [session('codex-a', 'codex')] })), [['ask-reviewer', null]]);
  const warned = (id) => ({ id, feature: 'f1', to: 'codex-a', phase: 'design', status: 'done', at: iso(NOW - 4 * MIN), statusAt: iso(NOW - 2 * MIN), updates: [{ status: 'done', at: iso(NOW - 2 * MIN), warning: 'x' }] });
  const escalate = run({ features: [feature('design')], tasks: [warned('t-000002-aaaaaa')], decisions: [{ kind: 'renotify', outcome: 'executed', feature: 'f1', iteration: 0, phase: 'design', task: 't-000001-aaaaaa', at: iso(NOW - 3 * MIN) }] });
  assert.deepEqual(rules(escalate), [['escalate', null]], 'the second done warning goes to a person');
  const failed = run({ features: [feature('done')], decisions: [{ kind: 'judgment', outcome: 'requested', judge: 'pj-0000000b', judgment: 'report', site: report.suggestions[1].key, tool: 'codex', at: iso(NOW) },
    { kind: 'judgment', outcome: 'rejected', judge: 'pj-0000000b', reason: '스키마 밖', at: iso(NOW) }] });
  assert.ok(rules(failed).some(([kind, rule]) => kind === 'judge-failed' && rule === null));
  assert.deepEqual(rules(run({ features: [feature('design')], workersToday: PM_LIMITS.dailyWorkers })), [['start-worker', null]]);
  assert.equal(autoRule({ kind: 'confirm-plan', executable: true }), null);
});

test('hourly auto count: only auto executions in the last hour since resume', () => {
  const at = (ms, extra = {}) => ({ by: 'auto', outcome: 'executed', at: iso(ms), ...extra });
  const decisions = [at(NOW - 61 * MIN), at(NOW - 30 * MIN), at(NOW - MIN), at(NOW - MIN, { by: '대표' }), at(NOW - MIN, { outcome: 'suggested' })];
  assert.equal(autoUsed(decisions, { now: NOW }), 2);
  assert.equal(autoUsed(decisions, { now: NOW, since: NOW - 10 * MIN }), 1, 'a resume (a person checked the limits) starts a new window');
  assert.equal(DEFAULT_BUDGETS.autoPerHour, 12);
});


const authorOf = (prompt) => prompt.match(/작업자 이름: ([^.]+)\./)[1];
const phaseOf = (prompt) => prompt.match(/단계: ([a-z]+), 업무/)[1];
async function finishPhase(root, id, phase, author) {
  await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n\n- AC-1: 화면이 열린다` });
  await updateFeature(root, id, 'complete', { phase, evidence: `${phase} 완료(가짜 작업자)`, author, ...(['implement', 'review'].includes(phase) ? { waiver: '테스트 픽스처' } : {}), ...(phase === 'review' ? { verdict: 'pass', acWaiver: '테스트 픽스처' } : {}) });
}

async function setup(t, { features = ['f1'], execute = mustNotRun, executeJudge = mustNotRun, tools = TOOLS, budgets = {}, confirm = true, mode = 'auto' } = {}) {
  const root = await project(t, features);
  await setPm(root, { author: '대표', kind: 'human' });
  const calls = { workers: [], judges: [] };
  const listTools = async () => tools.map((id) => ({ id, installed: true, approval: 'dashboard' }));
  const engine = createPmLoop({ root, listTools, user: '대표', intervalMs: 10_000,
    execute: async (dir, input) => { calls.workers.push(input); return execute(dir, input); },
    executeJudge: async (dir, input) => { calls.judges.push(input); return executeJudge(dir, input); } });
  t.after(() => engine.close());
  const g = await createGoal(root, { title: 'auto 목표', features, budgets }, { author: '대표' });
  if (mode === 'auto') await setMode(root, g.id, { author: '대표', mode: 'auto' });
  if (confirm) await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  const auto = { workers: engine.workers, judges: engine.judges, user: '대표' };
  const step = async (options = {}) => {
    const written = await evaluateGoals(root, { tools, auto, ...options });
    await engine.workers.settled();
    await engine.judges.settled();
    return written;
  };
  const view = async (options = {}) => goalOverview(root, g.id, { user: '대표', tools, ...options });
  const records = async () => readDecisions(root, g.id);
  return { root, engine, goal: g, calls, auto, step, view, records };
}
const autoRecords = async (records) => (await records()).filter((item) => item.by === 'auto');

test('auto: fake workers move a goal through every phase without cards, review uses another tool, and the report PR draft waits for a person', async (t) => {
  const execute = async (root, { prompt }) => { await finishPhase(root, 'f1', phaseOf(prompt), authorOf(prompt)); return reply({ outcome: 'done', report: '끝냈습니다.' }); };
  const { root, calls, step, view, records } = await setup(t, { execute });
  for (let n = 0; n < 8 && !(await view()).suggestions.some((card) => card.kind === 'pr-body'); n++) await step();
  await step();
  assert.deepEqual(calls.workers.map((call) => [call.tool, phaseOf(call.prompt)]),
    [['codex', 'plan'], ['codex', 'design'], ['codex', 'implement'], ['claude', 'review'], ['codex', 'report']], 'review goes to a different tool than implement');
  const final = await view();
  assert.deepEqual([final.state, final.suggestions.map((card) => card.kind)], ['waiting-human', ['pr-body', 'judge']], 'the PR draft and the CEO report wait for a person');
  assert.equal(calls.judges.length, 0, 'the CEO report judgment is not run by auto');
  const autos = await autoRecords(records);
  const executed = autos.filter((item) => item.outcome === 'executed');
  assert.deepEqual(executed.map((item) => [item.kind, item.rule, item.actor]), [
    ['start-worker', 'start-worker', '대표'], ['start-worker', 'start-worker', '대표'], ['start-worker', 'start-worker', '대표'], ['start-worker', 'start-worker-review', '대표'], ['start-worker', 'start-worker', '대표']]);
  assert.ok(executed.every((item) => item.reason), 'every auto action has a reason');
  assert.deepEqual(autos.filter((item) => item.kind === 'worker').map((item) => [item.outcome, item.rule]), Array(5).fill(['launched', 'start-worker']).map(([o], n) => [o, n === 3 ? 'start-worker-review' : 'start-worker']));
  assert.deepEqual((await records()).filter((item) => item.outcome === 'suggested').map((item) => item.kind), ['pr-body', 'judge']);
  const tasks = await listTasks(root, { all: true });
  assert.deepEqual(tasks.map((task) => [task.status, task.by, task.updates.at(-1).warning ?? null]), Array(5).fill(['done', '대표', null]));
  const trace = await buildRunTrace(root, 'f1', { language: 'ko' });
  const pm = trace.visits.flatMap((visit) => visit.pm);
  assert.ok(pm.some((item) => item.by === 'auto' && item.kind === 'start-worker'));
  assert.match(trace.markdown, /start-worker 실행함 · `auto`.*auto 규칙: start-worker/);
  assert.ok((await featureDecisions(root, 'f1')).some((item) => item.rule === 'start-worker-review'));
  assert.deepEqual([final.auto.mode, final.auto.by, final.auto.used, final.auto.cap, final.auto.recent.length], ['auto', '대표', 5, 12, 5]);
});

test('auto: assigns to a listening session, reminds a done warning once, hands the second to a person, and reclaims a stalled assignment', async (t) => {
  const { root, step, view, records } = await setup(t, { features: ['f1', 'f2'], tools: [] });
  const codex = await joinPresence(root, { author: 'codex-a', kind: 'codex' });
  t.after(await startBeat(root, 'codex-a', null, 60_000, () => {}));
  await step();
  const tasks = await listTasks(root);
  assert.deepEqual(tasks.map((task) => [task.feature, task.to, task.phase, task.by]).sort(), [['f1', 'codex-a', 'plan', '대표'], ['f2', 'codex-a', 'plan', '대표']]);
  const f1 = tasks.find((task) => task.feature === 'f1');
  await updateTask(root, f1.id, 'done', { author: 'codex-a', session: codex.session });
  await step();
  const { messages } = await readMessages(root, 'f1');
  assert.match(messages.at(-1).body, /wax complete plan f1 --author codex-a/);
  const later = Date.now() + 40 * MIN;
  await step({ now: later });
  const autos = (await autoRecords(records)).filter((item) => item.outcome === 'executed');
  assert.deepEqual(autos.map((item) => [item.kind, item.rule, item.feature]), [['assign', 'assign-listening', 'f1'], ['assign', 'assign-listening', 'f2'], ['renotify', 'renotify-once', 'f1'], ['reclaim', 'reclaim-stale', 'f2']]);
  assert.equal((await listTasks(root, { all: true })).find((task) => task.feature === 'f2').status, 'cancelled');
  const cards = (await view({ now: later })).suggestions.map((card) => [card.feature, card.kind]);
  assert.ok(cards.some(([id, kind]) => id === 'f1' && kind === 'escalate'), JSON.stringify(cards));
});

test('auto: a block runs a PM judgment, retry is applied with the judged tool, and three blocks in a row stop the goal', async (t) => {
  const { root, calls, goal: g, step, view, records } = await setup(t, {
    execute: async () => reply({ outcome: 'blocked', report: '테스트 DB가 없습니다' }),
    executeJudge: async () => reply({ action: 'retry', tool: 'claude', question: null, reason: '도구를 바꿔 다시 시도' }) });
  for (let n = 0; n < 8 && (await view()).storedState === 'running'; n++) await step();
  assert.deepEqual(calls.workers.map((call) => call.tool), ['codex', 'claude', 'claude'], 'retry uses the judged tool');
  assert.equal(calls.judges.length, 2);
  assert.match(calls.judges[0].prompt, /읽기 전용입니다/);
  const executed = (await autoRecords(records)).filter((item) => item.outcome === 'executed').map((item) => item.rule);
  assert.deepEqual(executed, ['start-worker', 'judge-block', 'apply-retry', 'start-worker', 'judge-block', 'apply-retry', 'start-worker']);
  assert.deepEqual((await records()).filter((item) => item.kind === 'judgment').map((item) => [item.outcome, item.by]), [['requested', 'auto'], ['proposed', 'pm-loop'], ['requested', 'auto'], ['proposed', 'pm-loop']]);
  const stopped = await view();
  assert.deepEqual([stopped.storedState, stopped.stoppedBy], ['stopped', 'pm-loop']);
  assert.match(stopped.stoppedReason, /연속 3번 막혀/);
  assert.equal(stopped.mode, 'auto', 'a stop never changes the mode');
  await step();
  assert.equal(calls.workers.length, 3, 'a stopped goal does nothing in auto');
  assert.equal(g.id, stopped.id);
});

test('auto: an ask from a block judgment stays a card for a person (iterate likewise, see the rule test)', async (t) => {
  const answer = { action: 'ask', tool: null, question: '테스트 DB 주소는?', reason: '설정 누락' };
  const { root, calls, step, view, records } = await setup(t, { execute: async () => reply({ outcome: 'blocked', report: 'DB 없음' }), executeJudge: async () => reply(answer) });
  await step();
  await step();
  await step();
  const cards = (await view()).suggestions.map((card) => [card.kind, card.proposal?.action ?? null]);
  assert.deepEqual(cards, [['blocked', null], ['judge-proposal', 'ask']]);
  assert.equal((await view()).state, 'waiting-human');
  assert.equal(calls.workers.length, 1);
  assert.deepEqual((await records()).filter((item) => item.outcome === 'suggested').map((item) => item.kind), ['blocked', 'judge-proposal'], 'a person is notified of the cards');
  assert.equal((await listTasks(root, { all: true }))[0].status, 'blocked', 'the assignment is left blocked');
});

test('auto: plan confirmation, the plan draft and the CEO report are never run in auto', async (t) => {
  const { root, goal: g, calls, step, view, records } = await setup(t, { confirm: false });
  await step();
  assert.deepEqual([(await view()).storedState, (await view()).suggestions.map((card) => card.kind)], ['planning', ['confirm-plan', 'judge']]);
  assert.equal(calls.judges.length, 0);
  assert.deepEqual(await autoRecords(records), []);
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  for (const phase of PHASES) {
    await updateFeature(root, 'f1', 'save', { phase, content: `# ${phase}\n` });
    await completePhase(root, 'f1', phase, { evidence: `${phase} 완료`, ...(['implement', 'review'].includes(phase) ? { waiver: '테스트' } : {}), ...(phase === 'review' ? { verdict: 'pass' } : {}) });
  }
  await step();
  await step();
  assert.deepEqual((await view()).suggestions.map((card) => card.kind), ['pr-body', 'judge']);
  assert.deepEqual([calls.judges.length, calls.workers.length, (await autoRecords(records)).length], [0, 0, 0]);
});

test('limits: the hourly auto cap stops the goal and notifies the person', async (t) => {
  const execute = (dir, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  const root = await project(t, ['f1', 'f2']);
  await setPm(root, { author: '대표', kind: 'human' });
  const events = [];
  const engine = createPmLoop({ root, execute, executeJudge: mustNotRun, user: '대표', intervalMs: 10_000, notify: (type, data) => events.push([type, data]),
    listTools: async () => TOOLS.map((id) => ({ id, installed: true, approval: 'dashboard' })) });
  t.after(() => engine.close());
  const g = await createGoal(root, { title: '시간당 한도', features: ['f1', 'f2'], budgets: { autoPerHour: 1 } }, { author: '대표' });
  await setMode(root, g.id, { author: '대표', mode: 'auto' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  await engine.start();
  const view = await goalOverview(root, g.id, { tools: TOOLS });
  assert.deepEqual([view.storedState, view.stoppedBy, view.workers.length], ['stopped', 'auto', 1], 'one action ran, the second hit the cap');
  assert.match(view.stoppedReason, /auto 시간당 한도 1번/);
  const stop = (await readDecisions(root, g.id)).at(-1);
  assert.deepEqual([stop.kind, stop.outcome, stop.by, stop.rule], ['goal', 'stopped', 'auto', 'start-worker']);
  assert.ok(events.some(([type, data]) => type === 'pm' && data.suggestion?.kind === 'stopped' && /시간당 한도/.test(data.suggestion.text)), 'the person is notified');
  await engine.workers.stopGoal(g.id, '대표');
  await resumeGoal(root, g.id, { author: '대표', budgets: { autoPerHour: 5 } });
  await engine.tick();
  assert.equal((await goalOverview(root, g.id, { tools: TOOLS })).storedState, 'running');
});

test('limits: the shared daily headless limit and the phase-run limit stop an auto goal', async (t) => {
  const { root, step, view } = await setup(t);
  const file = join(root, '.wax', 'chat', 'pm-loop', 'goal-ffffffff.jsonl');
  for (let n = 0; n < PM_LIMITS.dailyWorkers; n++) await appendRecord(file, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: 'goal-ffffffff', kind: 'judgment', outcome: 'requested', judge: `pj-${String(n).padStart(8, '0')}`, at: iso(Date.now()) }));
  await step();
  const daily = await view();
  assert.deepEqual([daily.storedState, daily.stoppedBy], ['stopped', 'auto']);
  assert.match(daily.stoppedReason, /하루 headless 실행 한도 20번/);

  const execute = async (dir, { prompt }) => { await finishPhase(dir, 'f1', phaseOf(prompt), authorOf(prompt)); return reply({ outcome: 'done', report: '끝' }); };
  const other = await setup(t, { execute, budgets: { phaseRuns: 1 } });
  await other.step();
  await other.step();
  const runs = await other.view();
  assert.deepEqual([runs.storedState, runs.stoppedBy, other.calls.workers.length], ['stopped', 'pm-loop', 1]);
  assert.match(runs.stoppedReason, /단계 실행 한도 1번/);
});

test('an auto action that fails a check (the person is no longer the PM) stops the goal instead of repeating', async (t) => {
  const { root, calls, step, view } = await setup(t, { execute: async () => reply({ outcome: 'done', report: 'x' }) });
  await setPm(root, { author: 'codex-a', kind: 'codex', replace: true });
  await step();
  const stopped = await view();
  assert.deepEqual([stopped.storedState, stopped.stoppedBy, calls.workers.length], ['stopped', 'auto', 0]);
  assert.match(stopped.stoppedReason, /auto 행동\(start-worker\)이 실패해/);
  assert.equal((await readDecisions(root, stopped.id)).filter((item) => item.outcome === 'failed' && item.by === 'auto').length, 1);
});

test('two loop instances act once: only the engine holding the lock runs the action', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const launched = [];
  const listTools = async () => TOOLS.map((id) => ({ id, installed: true, approval: 'dashboard' }));
  const hold = (name) => (dir, { signal }) => { launched.push(name); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); };
  const engines = ['a', 'b'].map((name) => createPmLoop({ root, listTools, execute: hold(name), executeJudge: mustNotRun, user: '대표', intervalMs: 10_000 }));
  t.after(() => Promise.all(engines.map((engine) => engine.close())));
  const g = await createGoal(root, { title: '둘', features: ['f1'] }, { author: '대표' });
  await setMode(root, g.id, { author: '대표', mode: 'auto' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  await Promise.all([engines[0].tick(), engines[1].tick(), engines[0].tick(), engines[1].tick()]);
  const records = await readDecisions(root, g.id);
  assert.equal(records.filter((item) => item.kind === 'worker' && item.outcome === 'launched').length, 1);
  assert.equal(records.filter((item) => item.kind === 'start-worker' && item.by === 'auto').length, 1);
  assert.equal(engines[0].workers.list().length + engines[1].workers.list().length, 1);
  await Promise.all(engines.map((engine) => engine.workers.stopGoal(g.id, '대표')));
  assert.equal(launched.length, 1);
});

test('mode: only a person switches it (the PM, through the dashboard), the switch is logged, and the CLI only shows it', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const g = await createGoal(root, { title: '모드', features: ['f1'] }, { author: '대표' });
  assert.equal(g.mode, 'suggest', 'suggest is the default');
  for (const author of ['auto', 'pm-loop', 'wax-worker-codex']) await assert.rejects(setMode(root, g.id, { author, mode: 'auto' }), (error) => error.status === 403, author);
  await assert.rejects(setMode(root, g.id, { mode: 'auto' }), (error) => error.status === 400);
  await assert.rejects(setMode(root, g.id, { author: '대표', mode: 'turbo' }), (error) => error.status === 400);
  await assert.rejects(setMode(root, g.id, { author: '손님', mode: 'auto' }), (error) => error.status === 409 && /PM만/.test(error.message));
  await assert.rejects(resumeGoal(root, g.id, { author: 'auto' }), (error) => error.status === 403, 'raising limits is a person');
  await setJudgeTool(root, g.id, { author: '대표', tool: 'claude' });
  const on = await setMode(root, g.id, { author: '대표', mode: 'auto' });
  assert.deepEqual([on.mode, on.modeBy, on.judgeTool], ['auto', '대표', 'claude']);
  const log = (await readDecisions(root, g.id)).filter((item) => item.outcome === 'mode');
  assert.deepEqual(log.map((item) => [item.mode, item.by]), [['auto', '대표']]);
  assert.match(log[0].reason, /auto 모드를 켰습니다/);
  const show = await wax(root, ['pm-loop', 'show', g.id]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /모드: auto \(켠 사람 대표 · 지난 1시간 auto 0\/12\)/);
  assert.match((await wax(root, ['pm-loop', 'list'])).stdout, /\[planning\] {2}\[auto\]/);
  assert.match((await wax(root, ['pm-loop', 'show', g.id], { WAX_LANG: 'en' })).stdout, /Mode: auto/);
  await setMode(root, g.id, { author: '대표', mode: 'suggest' });
  assert.equal((await goalOverview(root, g.id)).mode, 'suggest');
  assert.match((await readDecisions(root, g.id)).at(-1).reason, /suggest 모드로 바꿨습니다/);
});

test('dashboard API: the mode needs the token and the dashboard person; the stop button halts auto workers and judgments at once', async (t) => {
  const root = await project(t, ['f1', 'f2']);
  const hold = (dir, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  const calls = { workers: 0, judges: 0 };
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000,
    executeWorker: (...args) => { calls.workers += 1; return hold(...args); }, executeJudge: (...args) => { calls.judges += 1; return hold(...args); },
    requestTools: async () => TOOLS.map((id) => ({ id, installed: true, approval: 'dashboard' })) });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  await setPm(root, { author: '대표', kind: 'human' });
  const a = await (await post('/api/pm-loop', { title: '작업자', features: ['f1'] })).json();
  const b = await (await post('/api/pm-loop', { title: '판단', features: ['f2'] })).json();
  assert.equal((await post(`/api/pm-loop/${a.id}/settings`, { mode: 'auto' }, {})).status, 403, 'no token, no mode switch');
  assert.equal((await post(`/api/pm-loop/${a.id}/settings`, { mode: 'turbo' })).status, 400);
  for (const goalRecord of [a, b]) {
    assert.equal((await post(`/api/pm-loop/${goalRecord.id}/execute`, { key: 'goal:confirm-plan' })).status, 200);
    assert.equal((await post(`/api/pm-loop/${goalRecord.id}/settings`, { mode: 'auto' })).status, 200);
  }
  const task = await assignTask(root, { author: '대표', kind: 'human', feature: 'f2', to: 'codex-a', phase: 'plan', body: '기획' });
  await updateTask(root, task.id, 'block', { author: 'codex-a', body: '막힘' });
  await server.pmLoop.tick();
  const running = await get(`/api/pm-loop/${a.id}`);
  const judging = await get(`/api/pm-loop/${b.id}`);
  assert.deepEqual([running.mode, running.workers.length, judging.judgments.length], ['auto', 1, 1]);
  assert.equal(running.decisions.find((item) => item.kind === 'start-worker').by, 'auto');
  assert.equal(judging.decisions.find((item) => item.kind === 'judge').rule, 'judge-block');
  for (const goalRecord of [a, b]) assert.equal((await post(`/api/pm-loop/${goalRecord.id}/stop`, {})).status, 200);
  await server.pmLoop.workers.settled();
  await server.pmLoop.judges.settled();
  const stoppedA = await get(`/api/pm-loop/${a.id}`), stoppedB = await get(`/api/pm-loop/${b.id}`);
  assert.deepEqual([stoppedA.state, stoppedA.workers.length, stoppedA.decisions[0].kind, stoppedA.decisions[0].outcome, stoppedA.decisions[0].by], ['stopped', 0, 'worker', 'stopped', '대표']);
  assert.deepEqual([stoppedB.state, stoppedB.judgments.length, stoppedB.decisions[0].kind, stoppedB.decisions[0].outcome], ['stopped', 0, 'judgment', 'stopped']);
  server.pmLoop.poke();
  await server.pmLoop.tick();
  assert.deepEqual(calls, { workers: 1, judges: 1 }, 'nothing new starts after the stop');
});

function wax(root, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--project', root, ...args], { cwd: root, env: { ...process.env, WAX_LANG: 'ko', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
