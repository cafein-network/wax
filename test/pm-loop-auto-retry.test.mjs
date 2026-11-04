import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from './chat-helpers.mjs';
import {
  AUTO_RETRY_RULES, DEFAULT_BUDGETS, HUMAN_KINDS, RETRY_TRANSIENT_DELAY_MS, RETRY_UNFINISHED_NOTE, autoRule, createGoal, createPmLoop, evaluateGoals, executeSuggestion,
  goalOverview, nextActions, readDecisions, retryGuard, setMode,
} from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { updateFeature } from '../src/workflow.mjs';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const TOOLS = ['codex', 'claude'];
const TASK = 't-000001-aaaaaa';
const goal = (extra = {}) => ({ id: 'goal-0000000e', title: '목표', state: 'running', mode: 'auto', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 30 * MIN), ...extra });
const feature = (phase = 'implement', extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }], artifacts: {}, ...extra });
const blockedTask = (id = TASK, extra = {}) => ({ id, feature: 'f1', to: 'wax-worker-codex', phase: 'implement', status: 'blocked', at: iso(NOW - 10 * MIN), statusAt: iso(NOW - 4 * MIN),
  updates: [{ status: 'blocked', note: '실패', at: iso(NOW - 4 * MIN) }], ...extra });
const warnedTask = (id = TASK) => ({ id, feature: 'f1', to: 'wax-worker-codex', phase: 'implement', status: 'done', at: iso(NOW - 10 * MIN), statusAt: iso(NOW - 4 * MIN),
  updates: [{ status: 'done', at: iso(NOW - 4 * MIN), warning: '단계 완료 기록 없음' }] });
const workerRun = ({ task = TASK, tool = 'codex', worker = 'pw-0000000a', outcome = 'failed', health = null, ok = true, at = NOW - 4 * MIN, result } = {}) => [
  { kind: 'worker', outcome: 'launched', worker, tool, feature: 'f1', phase: 'implement', iteration: 0, task, to: `wax-worker-${tool}`, at: iso(at - 5 * MIN) },
  { kind: 'worker', outcome, worker, tool, feature: 'f1', phase: 'implement', iteration: 0, task, to: `wax-worker-${tool}`, ...(result ? { result } : {}), ...(health ? { health } : {}),
    snapshots: { before: 'sn-1', after: 'sn-2', ok }, at: iso(at) }];
const run = (input) => nextActions({ goal: goal(), features: [feature()], now: NOW, tools: TOOLS, stuck: 'stop', ...input });
const rules = (result) => result.suggestions.map((card) => [card.kind, autoRule(card)]);
const quota = { tool: 'codex', shape: 'quota', rule: 'usage-limit', at: iso(NOW - 4 * MIN) };


test('retry-transient: a temporary failure is launched again with the same tool after two minutes, once per phase, without a judgment', () => {
  const decisions = workerRun({ health: { shape: 'transient', rule: 'x' }, at: NOW - 3 * MIN });
  const card = run({ tasks: [blockedTask()], decisions }).suggestions[0];
  assert.deepEqual([card.kind, card.rule, card.tool, autoRule(card)], ['auto-retry', 'retry-transient', 'codex', 'retry-transient']);
  assert.match(card.reason, /일시 실패.*같은 도구로 한 번/);
  const early = run({ tasks: [blockedTask()], decisions: workerRun({ health: { shape: 'transient' }, at: NOW - RETRY_TRANSIENT_DELAY_MS + 30_000 }) });
  assert.deepEqual([early.suggestions.length, early.actions[0].kind], [0, 'wait']);
  assert.match(early.actions[0].reason, /남은 30초/);
  const done = [...decisions, { key: card.key, kind: 'auto-retry', outcome: 'executed', feature: 'f1', phase: 'implement', iteration: 0, task: TASK, retryRule: 'retry-transient', tool: 'codex', by: 'auto', at: iso(NOW) }];
  const next = run({ tasks: [{ ...blockedTask(), status: 'cancelled' }], decisions: done }).suggestions[0];
  assert.deepEqual([next.kind, next.tool, next.autoTool, next.retry], ['start-worker', 'codex', 'codex', 'retry-transient']);
  const second = [...done, ...workerRun({ task: 't-000002-bbbbbb', worker: 'pw-0000000b', health: { shape: 'transient' }, at: NOW - 3 * MIN })];
  assert.deepEqual(rules(run({ tasks: [{ ...blockedTask(), status: 'cancelled' }, blockedTask('t-000002-bbbbbb')], decisions: second })), [['blocked', null], ['judge', 'judge-block']]);
});

test('switch-unhealthy: a fixed failure goes to the next healthy tool without a judgment; with no such tool a person decides', () => {
  const decisions = workerRun({ health: { shape: 'quota', rule: 'usage-limit' } });
  const card = run({ tasks: [blockedTask()], decisions, health: [quota] }).suggestions[0];
  assert.deepEqual([card.kind, card.rule, card.tool, card.avoid, autoRule(card)], ['auto-retry', 'switch-unhealthy', 'claude', 'codex', 'switch-unhealthy']);
  const done = [...decisions, { key: card.key, kind: 'auto-retry', outcome: 'executed', feature: 'f1', phase: 'implement', iteration: 0, task: TASK, retryRule: 'switch-unhealthy', tool: 'claude', avoid: 'codex', at: iso(NOW) }];
  const next = run({ tasks: [{ ...blockedTask(), status: 'cancelled' }], decisions: done, health: [quota] }).suggestions[0];
  assert.deepEqual([next.kind, next.tool, next.autoTool], ['start-worker', 'claude', 'claude']);
  assert.match(next.reason, /switch-unhealthy/);
  const alone = run({ tools: ['codex'], tasks: [blockedTask()], decisions, health: [quota] });
  assert.deepEqual(rules(alone), [['blocked', null], ['judge', null]]);
  assert.match(alone.suggestions[0].reason, /바꿀 상태 괜찮은 도구가 없어 auto 규칙 switch-unhealthy/);
  assert.equal(run({ tools: ['codex', 'antigravity'], tasks: [blockedTask()], decisions, health: [quota] }).suggestions[0].kind, 'blocked');
  const review = feature('review', { history: [{ action: 'complete', phase: 'implement', at: iso(NOW - 20 * MIN), author: 'wax-worker-claude', tool: 'claude' }] });
  const reviewRun = workerRun({ health: { shape: 'quota' } }).map((item) => ({ ...item, phase: 'review' }));
  assert.equal(run({ features: [review], tasks: [{ ...blockedTask(), phase: 'review' }], decisions: reviewRun, health: [quota] }).suggestions[0].kind, 'blocked');
});

test('retry-unfinished: the first done without completing the phase is launched once more with a fixed sentence first; the second goes to a person', () => {
  const decisions = workerRun({ outcome: 'exited', result: 'done' });
  const card = run({ tasks: [warnedTask()], decisions }).suggestions[0];
  assert.deepEqual([card.kind, card.rule, card.tool, autoRule(card)], ['auto-retry', 'retry-unfinished', 'codex', 'retry-unfinished']);
  const done = [...decisions, { key: card.key, kind: 'auto-retry', outcome: 'executed', feature: 'f1', phase: 'implement', iteration: 0, task: TASK, retryRule: 'retry-unfinished', tool: 'codex', at: iso(NOW) }];
  const next = run({ tasks: [warnedTask()], decisions: done }).suggestions[0];
  assert.deepEqual([next.kind, next.tool, next.retry, autoRule(next)], ['start-worker', 'codex', 'retry-unfinished', 'start-worker']);
  const again = [...done, ...workerRun({ task: 't-000002-bbbbbb', worker: 'pw-0000000b', outcome: 'exited', result: 'done', at: NOW - MIN })];
  assert.deepEqual(rules(run({ tasks: [warnedTask(), warnedTask('t-000002-bbbbbb')].map((task, n) => ({ ...task, at: iso(NOW - (10 - n) * MIN) })), decisions: again })), [['escalate', null]]);
  assert.deepEqual(rules(run({ tasks: [warnedTask()], decisions: [...decisions, { key: card.key, outcome: 'dismissed', at: iso(NOW) }] })), [['escalate', null]]);
});

test('retry-judge: a failed blocker judgment is asked once more with another healthy judgment tool; the second failure goes to a person', () => {
  const site = run({ tasks: [blockedTask()] }).suggestions[1].key;
  const judged = (id, tool, outcome) => [{ kind: 'judgment', outcome: 'requested', judge: id, judgment: 'block', site, tool, at: iso(NOW - 2 * MIN) },
    { kind: 'judgment', outcome, judge: id, reason: '스키마 밖', at: iso(NOW - MIN) }];
  const first = run({ tasks: [blockedTask()], decisions: judged('pj-0000000a', 'codex', 'rejected') });
  const card = first.suggestions[1];
  assert.deepEqual([card.kind, card.tool, card.failedTool, autoRule(card)], ['judge-retry', 'claude', 'codex', 'retry-judge']);
  const second = run({ tasks: [blockedTask()], decisions: [...judged('pj-0000000a', 'codex', 'rejected'), ...judged('pj-0000000b', 'claude', 'timeout')] });
  assert.deepEqual(rules(second), [['blocked', null], ['judge-failed', null]]);
  assert.deepEqual(rules(run({ tasks: [blockedTask()], decisions: judged('pj-0000000a', 'codex', 'stopped') })), [['blocked', null], ['judge-failed', null]]);
  assert.deepEqual(rules(run({ tools: ['codex'], tasks: [blockedTask()], decisions: judged('pj-0000000a', 'codex', 'failed') })), [['blocked', null], ['judge-failed', null]]);
  assert.deepEqual(rules(run({ stuck: 'warn', tasks: [blockedTask()], decisions: judged('pj-0000000a', 'codex', 'failed') })), [['blocked', null], ['judge-failed', null]]);
  assert.deepEqual(rules(run({ tasks: [blockedTask()], decisions: [...judged('pj-0000000a', 'codex', 'failed'), { key: card.key, outcome: 'dismissed', at: iso(NOW) }] })), [['blocked', null], ['judge-failed', null]]);
  const daily = run({ tasks: [blockedTask()], decisions: judged('pj-0000000a', 'codex', 'failed'), workersToday: 20 }).suggestions[1];
  assert.deepEqual([daily.kind, daily.executable, daily.limit, autoRule(daily)], ['judge-retry', false, 'daily', null]);
});

test('conditions: repeat detection stop, both snapshots ok, a usage-reporting tool under a token limit; any miss leaves the person card with the reason', () => {
  const transient = (extra = {}) => workerRun({ health: { shape: 'transient' }, at: NOW - 3 * MIN, ...extra });
  const blocked = (input) => run({ tasks: [blockedTask()], ...input }).suggestions[0];
  assert.match(blocked({ stuck: 'warn', decisions: transient() }).reason, /되풀이 감지가 stop일 때만/);
  assert.equal(blocked({ stuck: 'off', decisions: transient() }).kind, 'blocked');
  assert.match(blocked({ decisions: transient({ ok: false }) }).reason, /스냅숏이 모두 남지 않아/);
  assert.match(blocked({ decisions: transient().map((item) => { const { snapshots, ...rest } = item; return rest; }) }).reason, /스냅숏/, 'old records without the flag do not qualify');
  assert.match(blocked({ goal: goal({ budgets: { ...DEFAULT_BUDGETS, tokens: 100_000 } }), decisions: transient() }).reason, /사용량을 알리지 않아/, 'Codex does not report usage');
  assert.equal(blocked({ goal: goal({ budgets: { ...DEFAULT_BUDGETS, tokens: 100_000 } }), decisions: transient({ tool: 'claude' }) }).kind, 'auto-retry');
  assert.doesNotMatch(blocked({ goal: goal({ mode: 'suggest' }), stuck: 'warn', decisions: transient() }).reason, /stop일 때만/);
  assert.equal(retryGuard({ stuck: 'stop', end: { outcome: 'stuck', snapshots: { ok: true } }, tool: 'codex' }), 'stuck');
  assert.equal(retryGuard({ stuck: 'stop', end: null, tool: 'codex' }), 'stuck');
  assert.equal(retryGuard({ stuck: 'stop', end: { outcome: 'failed', snapshots: { ok: true } }, tool: 'codex' }), null);
});

test('human decision points stay cards: autoRule is null for every human kind, and only the four new rule names are added', () => {
  for (const kind of HUMAN_KINDS) assert.equal(autoRule({ kind, executable: true, judgment: 'plan' }), null, kind);
  assert.equal(autoRule({ kind: 'auto-retry', executable: true, rule: 'push' }), null, 'only known rules');
  assert.equal(autoRule({ kind: 'auto-retry', executable: false, rule: 'retry-transient' }), null);
  assert.deepEqual(AUTO_RETRY_RULES, ['retry-transient', 'switch-unhealthy', 'retry-unfinished']);
  assert.equal(autoRule({ kind: 'judge-retry', executable: true }), 'retry-judge');
});


const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FIXTURES = fileURLToPath(new URL('./fixtures/tool-failures/', import.meta.url));
const realError = async (tool, rule) => {
  const item = JSON.parse(await readFile(join(FIXTURES, `${tool}.json`), 'utf8')).cases.find((entry) => entry.rule === rule);
  return Object.assign(new Error('표시용 문장'), { toolOutput: { [item.stream]: item.text } });
};
const reply = (value) => ({ threadId: 'fake', status: 'completed', message: JSON.stringify(value) });
const authorOf = (prompt) => prompt.match(/작업자 이름: ([^.]+)\./)[1];
const mustNotRun = async () => { throw new Error('a real tool must not run in tests'); };

async function setup(t, { execute = mustNotRun, executeJudge = mustNotRun, repo = true } = {}) {
  const root = await project(t, ['f1']);
  if (repo) {
    git(root, 'init', '-q');
    await writeFile(join(root, '.gitignore'), '.wax/\n');
    await writeFile(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  }
  await setPm(root, { author: '대표', kind: 'human' });
  const calls = { workers: [], judges: [] };
  const listTools = async () => TOOLS.map((id) => ({ id, installed: true, approval: 'dashboard' }));
  const engine = createPmLoop({ root, listTools, user: '대표', intervalMs: 10_000, stuckCheck: 'stop',
    execute: async (dir, input) => { calls.workers.push(input); return execute(dir, input, calls.workers.length); },
    executeJudge: async (dir, input) => { calls.judges.push(input); return executeJudge(dir, input, calls.judges.length); } });
  t.after(() => engine.close());
  const g = await createGoal(root, { title: 'auto 목표', features: ['f1'] }, { author: '대표' });
  await setMode(root, g.id, { author: '대표', mode: 'auto' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  const auto = { workers: engine.workers, judges: engine.judges, user: '대표' };
  const step = async () => {
    const written = await evaluateGoals(root, { tools: TOOLS, auto, stuck: 'stop' });
    await engine.workers.settled();
    await engine.judges.settled();
    return written;
  };
  const records = async () => readDecisions(root, g.id);
  const autoRules = async () => (await records()).filter((item) => item.by === 'auto' && item.outcome === 'executed').map((item) => item.rule);
  const view = async () => goalOverview(root, g.id, { user: '대표', tools: TOOLS, stuck: 'stop' });
  return { root, calls, step, records, autoRules, view, goal: g };
}
const finish = async (root, prompt) => {
  const phase = prompt.match(/단계: ([a-z]+), 업무/)[1];
  await updateFeature(root, 'f1', 'save', { phase, content: `# ${phase}\n\n- AC-1: 열린다` });
  await updateFeature(root, 'f1', 'complete', { phase, evidence: `${phase} 완료(가짜)`, author: authorOf(prompt) });
};

test('engine: a Codex usage limit switches the plan phase to Claude Code with no judgment, and the end record has both snapshots ok', async (t) => {
  const { root, calls, step, records, autoRules } = await setup(t, {
    execute: async (dir, input) => { if (input.tool === 'codex') throw await realError('codex', 'usage-limit'); await finish(dir, input.prompt); return reply({ outcome: 'done', report: '끝' }); } });
  for (let n = 0; n < 4 && calls.workers.length < 2; n++) await step();
  assert.deepEqual(calls.workers.map((call) => call.tool), ['codex', 'claude']);
  assert.deepEqual(calls.judges.length, 0, 'no judgment');
  assert.deepEqual((await autoRules()).slice(0, 3), ['start-worker', 'switch-unhealthy', 'start-worker']);
  const ends = (await records()).filter((item) => item.kind === 'worker' && item.outcome !== 'launched');
  assert.deepEqual([ends[0].outcome, ends[0].health?.shape, ends[0].snapshots?.ok], ['failed', 'quota', true]);
  assert.ok(root);
});

test('engine: without both snapshots (not a Git project) the same failure goes through the judgment as before', async (t) => {
  const { calls, step, autoRules } = await setup(t, { repo: false,
    execute: async (dir, input) => { if (input.tool === 'codex') throw await realError('codex', 'usage-limit'); await finish(dir, input.prompt); return reply({ outcome: 'done', report: '끝' }); },
    executeJudge: async () => reply({ action: 'reassign', tool: 'claude', question: null, reason: '한도' }) });
  for (let n = 0; n < 5 && calls.workers.length < 2; n++) await step();
  assert.equal(calls.judges.length, 1);
  assert.deepEqual((await autoRules()).slice(0, 4), ['start-worker', 'judge-block', 'apply-reassign', 'start-worker']);
});

test('engine: a done without completing the phase is launched once more with the same tool and the fixed sentence first', async (t) => {
  const { calls, step, autoRules, records } = await setup(t, {
    execute: async (dir, input, n) => { if (n > 1) await finish(dir, input.prompt); return reply({ outcome: 'done', report: n > 1 ? '끝' : '했습니다(완료 안 함)' }); } });
  for (let n = 0; n < 4 && calls.workers.length < 2; n++) await step();
  assert.deepEqual(calls.workers.map((call) => call.tool), ['codex', 'codex']);
  assert.ok(!calls.workers[0].prompt.startsWith(RETRY_UNFINISHED_NOTE));
  assert.ok(calls.workers[1].prompt.startsWith(RETRY_UNFINISHED_NOTE));
  assert.deepEqual((await autoRules()).slice(0, 3), ['start-worker', 'retry-unfinished', 'start-worker']);
  assert.equal((await records()).filter((item) => item.kind === 'worker' && item.outcome === 'launched')[1].retry, 'unfinished');
});

test('engine: a failed blocker judgment is asked again with the other tool, then its retry is applied', async (t) => {
  const { calls, step, autoRules } = await setup(t, {
    execute: async (dir, input, n) => { if (n === 1) return reply({ outcome: 'blocked', report: 'DB 없음' }); await finish(dir, input.prompt); return reply({ outcome: 'done', report: '끝' }); },
    executeJudge: async (dir, input, n) => (n === 1 ? reply({ nonsense: true }) : reply({ action: 'retry', tool: null, question: null, reason: '다시' })) });
  for (let n = 0; n < 6 && calls.workers.length < 2; n++) await step();
  assert.equal(calls.judges.length, 2);
  assert.notEqual(calls.judges[0].tool, calls.judges[1].tool, 'another judgment tool');
  assert.deepEqual((await autoRules()).slice(0, 5), ['start-worker', 'judge-block', 'retry-judge', 'apply-retry', 'start-worker']);
});
