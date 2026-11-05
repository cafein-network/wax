import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from './chat-helpers.mjs';
import { COST_SOURCES, costLimitText, reportsCost, sumUsage, usageLines, usagePrompt } from '../src/tool-usage.mjs';
import {
  DEFAULT_BUDGETS, autoRule, budgetUsage, createGoal, createPmLoop, evaluateGoals, executeSuggestion, goalOverview, nextActions, normalizeBudgets, readDecisions, resumeGoal, retryGuard, workerPrompt,
} from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { getFeature, updateFeature } from '../src/workflow.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { cliText } from '../src/cli-locale.mjs';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const ko = cliText('ko').say, en = cliText('en').say;
const goal = (extra = {}) => ({ id: 'goal-0000c057', title: '목표', state: 'running', mode: 'auto', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 10 * MIN), ...extra });
const feature = (phase, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }], artifacts: {}, ...extra });
const claude = (costUsd) => ({ source: 'claude', tokens: { input: 10, output: 20, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd, turns: 1 });
const agy = { source: 'antigravity', tokens: { input: 100, output: 5, cacheRead: 0, cacheWrite: null, reasoning: null, total: 105 }, costUsd: null, turns: 1 };
let seq = 0;
const end = (usage, extra = {}) => ({ kind: 'worker', outcome: 'exited', worker: `pw-c${++seq}`, tool: usage?.source ?? 'codex', feature: 'f1', phase: 'plan', iteration: 0, ...(usage === undefined ? {} : { usage }), at: iso(NOW - MIN), ...extra });
const limited = (costUsd, extra = {}) => goal({ budgets: { ...DEFAULT_BUDGETS, costUsd }, ...extra });


test('limit: costUsd is an optional dollar amount, two decimals at most, 0.01 to 10000; empty clears it, missing keeps it; a comma decimal is refused with a hint', () => {
  assert.equal(DEFAULT_BUDGETS.costUsd, null);
  assert.equal(normalizeBudgets({}).costUsd, null);
  for (const [input, want] of [[5, 5], [0.01, 0.01], [10_000, 10_000], ['5.50', 5.5], [' 2.5 ', 2.5], [1.13, 1.13], [0.1 + 0.2, 0.3], ['7', 7]]) assert.equal(normalizeBudgets({ costUsd: input }).costUsd, want, String(input));
  for (const bad of [0, 0.001, 1.005, 10_000.01, -1, '1,5', '1e2', '$5', 'abc', '.5', Number.NaN, Infinity, true, {}]) {
    assert.throws(() => normalizeBudgets({ costUsd: bad }), (error) => error.status === 400 && /소수점은 \. 예: 5\.50/.test(error.message), String(bad));
  }
  assert.equal(normalizeBudgets({}, { ...DEFAULT_BUDGETS, costUsd: 3 }).costUsd, 3, 'an absent field keeps the current limit');
  assert.equal(normalizeBudgets({ costUsd: null }, { ...DEFAULT_BUDGETS, costUsd: 3 }).costUsd, null, 'an empty field removes it');
  assert.equal(normalizeBudgets({ costUsd: '' }, { ...DEFAULT_BUDGETS, costUsd: 3 }).costUsd, null);
  assert.throws(() => normalizeBudgets({}, { ...DEFAULT_BUDGETS, costUsd: -2 }), /비용 한도/, 'a stored value is checked again');
  assert.throws(() => normalizeBudgets({ tokens: 1500.5 }), /tokens/);
});

test('reporting tools: only Claude Code reports cost; Antigravity CLI reports tokens but not cost', () => {
  assert.deepEqual(COST_SOURCES, ['claude']);
  assert.deepEqual(['claude', 'antigravity', 'codex', 'gemini', 'copilot'].map(reportsCost), [true, false, false, false, false]);
});


test('sum: reported cost adds up; unreported, old and token-only runs count as unknown, never as zero', () => {
  const summary = sumUsage([end(claude(0.25)), end(claude(1.5)), end(agy), end(null), end(undefined), end(claude(null))]);
  assert.deepEqual([summary.costUsd, summary.costUnknown], [1.75, 4]);
  assert.deepEqual([sumUsage([]).costUsd, sumUsage([]).costUnknown], [null, 0]);
  const unknown = sumUsage([end(null), end(agy)]);
  assert.deepEqual([unknown.costUsd, unknown.costUnknown], [null, 2], 'no reported cost is null, not $0');
  assert.equal(usageLines(unknown, ko).some((line) => /도구가 알린 비용/.test(line)), false, 'no "$0.00" total when nothing reported cost');
  assert.ok(usageLines(summary, ko).includes('도구가 알린 비용 $1.75(4번은 알 수 없음, 실제 청구와 다를 수 있음)'));
  assert.ok(usageLines(sumUsage([end(claude(0.5))]), en).includes('Cost reported by the tools $0.50 (may differ from your bill)'));
});

test('usage line: $used / $limit · unknown for N runs, always with the note; all unknown shows only the unknown count', () => {
  assert.equal(costLimitText({ costUsd: 1.234, costUnknown: 2 }, 5, ko), '비용 한도: $1.23 / $5.00 · 알 수 없음 2번 · 도구가 알린 비용(실제 청구와 다를 수 있음)');
  assert.equal(costLimitText({ costUsd: 1.234, costUnknown: 2 }, 5, en), 'Cost limit: $1.23 / $5.00 · unknown for 2 runs · Cost reported by the tool, may differ from your bill');
  assert.equal(costLimitText({ costUsd: null, costUnknown: 3 }, 5, ko), '비용 한도: 알 수 없음 3번 / $5.00 · 도구가 알린 비용(실제 청구와 다를 수 있음)');
  assert.equal(costLimitText({ costUsd: null, costUnknown: 0 }, 0.5, ko), '비용 한도: $0.00 / $0.50 · 도구가 알린 비용(실제 청구와 다를 수 있음)', 'no runs yet');
  assert.equal(costLimitText({ costUsd: 12.4, costUnknown: 0 }, 5, ko), '비용 한도: $12.40 / $5.00 · 도구가 알린 비용(실제 청구와 다를 수 있음)', 'an overshoot is shown as it is');
});


test('stop: reaching or passing the reported sum stops the goal after that run; unknown runs never stop it; no limit, no stop', () => {
  const decisions = [end(claude(2)), end(claude(3)), end(null)];
  const at = budgetUsage({ goal: limited(5), decisions, now: NOW });
  assert.deepEqual([at.usage.costUsd, at.usage.costUnknown, at.limits.costUsd], [5, 1, 5]);
  assert.equal(at.exceeded, '비용 한도 $5.00에 닿았습니다(도구가 알린 비용). 실행 중인 작업자는 끝까지 둡니다. 한도를 늘리는 것은 사람만 합니다.');
  assert.equal(budgetUsage({ goal: limited(5.01), decisions, now: NOW }).exceeded, null);
  assert.equal(budgetUsage({ goal: goal(), decisions, now: NOW }).exceeded, null);
  const over = budgetUsage({ goal: limited(0.05), decisions: [end(claude(12.4))], now: NOW });
  assert.equal(over.usage.costUsd, 12.4);
  assert.match(over.exceeded, /\$0\.05/);
  const dark = budgetUsage({ goal: limited(0.01), decisions: [end(null), end(null), end(agy), end(undefined)], now: NOW });
  assert.deepEqual([dark.usage.costUsd, dark.usage.costUnknown, dark.exceeded], [null, 4, null]);
  const resumed = budgetUsage({ goal: limited(5, { resumedAt: iso(NOW - 30_000) }), decisions, now: NOW });
  assert.equal(resumed.usage.costUsd, 5);
  const result = nextActions({ goal: limited(5), features: [feature('design')], decisions, now: NOW, tools: ['claude'] });
  assert.equal(result.state, 'stopped');
  assert.equal(result.suggestions.some((card) => card.kind === 'start-worker'), false);
  assert.match(result.actions[0].reason, /비용 한도 \$5\.00/);
  assert.equal(en('pmLoop.budget.costUsd', '5.00'), 'Reached the $5.00 cost limit (cost reported by tools). Running workers are left to finish. Only a person raises a limit.');
});


test('worker card: under a cost limit a tool that does not report cost has a warning and auto does not launch it; tokens-only Antigravity CLI is not enough', () => {
  const card = (tools, budgets) => nextActions({ goal: goal({ budgets }), features: [feature('design')], now: NOW, tools }).actions[0];
  const cost = { ...DEFAULT_BUDGETS, costUsd: 5 };
  const codexOnly = card(['codex'], cost);
  assert.deepEqual([codexOnly.kind, codexOnly.executable, codexOnly.autoTool, autoRule(codexOnly)], ['start-worker', true, null, null], 'a person can still pick it');
  assert.match(codexOnly.options[0].warning, /Codex: 이 도구는 비용을 알리지 않습니다/);
  const agyCard = card(['antigravity'], cost);
  assert.deepEqual([agyCard.autoTool, autoRule(agyCard)], [null, null]);
  assert.match(agyCard.options[0].warning, /Antigravity CLI: 이 도구는 비용을 알리지 않습니다/);
  assert.doesNotMatch(agyCard.options[0].warning, /사용량을 알리지 않아/, 'it reports tokens');
  assert.equal(card(['antigravity'], { ...DEFAULT_BUDGETS, tokens: 100_000 }).autoTool, 'antigravity', 'a token limit alone accepts Antigravity CLI');
  const mixed = card(['codex', 'antigravity', 'claude'], cost);
  assert.deepEqual([mixed.tool, mixed.autoTool, autoRule(mixed)], ['codex', 'claude', 'start-worker'], 'the card default stays; auto picks the tool that reports cost');
  assert.equal(mixed.options.find((item) => item.id === 'claude').warning, undefined);
  const free = card(['codex'], DEFAULT_BUDGETS);
  assert.deepEqual([free.autoTool, free.options[0].warning], ['codex', undefined], 'without a limit nothing changes');
});

test('judge card: under a cost limit a judge tool that does not report cost is left to a person', () => {
  const blocked = (budgets, judgeTool) => nextActions({ goal: goal({ budgets, judgeTool }), features: [feature('design')], now: NOW, tools: ['antigravity', 'claude'],
    tasks: [{ id: 't-000001-aaaaaa', feature: 'f1', phase: 'design', to: 'wax-worker-antigravity', status: 'blocked', at: iso(NOW - 2 * MIN), statusAt: iso(NOW - MIN), updates: [{ status: 'blocked', note: '막힘', at: iso(NOW - MIN) }] }] })
    .suggestions.find((item) => item.kind === 'judge');
  const judge = blocked({ ...DEFAULT_BUDGETS, costUsd: 5 }, 'antigravity');
  assert.deepEqual([judge.unreported, autoRule(judge)], [true, null]);
  assert.match(judge.warning, /이 도구는 비용을 알리지 않습니다/);
  assert.equal(autoRule(blocked({ ...DEFAULT_BUDGETS, costUsd: 5 }, 'claude')), 'judge-block');
  assert.equal(autoRule(blocked(DEFAULT_BUDGETS, 'antigravity')), 'judge-block');
});

test('retry rules: the cost condition skips a tool that does not report cost, with the reason on the person card', () => {
  const ok = { outcome: 'failed', snapshots: { ok: true } };
  assert.equal(retryGuard({ stuck: 'stop', end: ok, tool: 'antigravity', costLimit: true }), 'cost');
  assert.equal(retryGuard({ stuck: 'stop', end: ok, tool: 'antigravity', tokenLimit: true }), null, 'Antigravity CLI reports tokens');
  assert.equal(retryGuard({ stuck: 'stop', end: ok, tool: 'codex', tokenLimit: true, costLimit: true }), 'tokens');
  assert.equal(retryGuard({ stuck: 'stop', end: ok, tool: 'claude', tokenLimit: true, costLimit: true }), null);
  const task = 't-000001-aaaaaa';
  const decisions = [
    { kind: 'worker', outcome: 'launched', worker: 'pw-0000000a', tool: 'antigravity', feature: 'f1', phase: 'design', iteration: 0, task, to: 'wax-worker-antigravity', at: iso(NOW - 8 * MIN) },
    { kind: 'worker', outcome: 'failed', worker: 'pw-0000000a', tool: 'antigravity', feature: 'f1', phase: 'design', iteration: 0, task, to: 'wax-worker-antigravity', health: { shape: 'transient', rule: 'x' },
      snapshots: { before: 'sn-1', after: 'sn-2', ok: true }, usage: agy, at: iso(NOW - 3 * MIN) }];
  const tasks = [{ id: task, feature: 'f1', to: 'wax-worker-antigravity', phase: 'design', status: 'blocked', at: iso(NOW - 10 * MIN), statusAt: iso(NOW - 3 * MIN), updates: [{ status: 'blocked', note: '실패', at: iso(NOW - 3 * MIN) }] }];
  const first = (budgets) => nextActions({ goal: goal({ budgets }), features: [feature('design')], tasks, decisions, now: NOW, tools: ['antigravity', 'claude'], stuck: 'stop' }).suggestions[0];
  const skipped = first({ ...DEFAULT_BUDGETS, costUsd: 5 });
  assert.equal(skipped.kind, 'blocked');
  assert.match(skipped.reason, /비용 한도가 있는 목표인데 띄울 도구가 비용을 알리지 않아 auto 규칙 retry-transient/);
  assert.equal(first({ ...DEFAULT_BUDGETS, tokens: 100_000 }).kind, 'auto-retry', 'a token limit alone keeps the rule');
});


test('report prompt: the reported cost total, unknown count and the goal limit go in as quoted data', () => {
  const summary = sumUsage([end(claude(0.4)), end(null)]);
  const text = usagePrompt(summary, { costLimitUsd: 5 });
  const data = JSON.parse(text.split('\n').filter((line) => line.startsWith('> ')).map((line) => line.slice(2)).join('\n'));
  assert.deepEqual([data.costUsd, data.costUnknownRuns, data.goalCostLimitUsd], [0.4, 1, 5]);
  assert.match(text, /실제 청구와 다를 수 있습니다/);
  assert.equal(Object.hasOwn(JSON.parse(usagePrompt(summary).split('\n').filter((line) => line.startsWith('> ')).map((line) => line.slice(2)).join('\n')), 'goalCostLimitUsd'), false);
  const report = workerPrompt({ root: '/tmp/x', goal: limited(5), feature: { id: 'f1', title: 'f1', description: '', projectType: 'general', artifacts: {}, completed: {} },
    task: { id: 't-1', phase: 'report', note: '' }, author: 'wax-worker-claude', usage: summary });
  assert.match(report, /> +"goalCostLimitUsd": 5/);
});


const authorOf = (prompt) => prompt.match(/작업자 이름: ([^.]+)\./)[1];

test('engine: the cost limit stops the goal after the run that reached it; only a person raises it by resuming; the PR draft shows the reported cost', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const execute = async (dir, input) => {
    const author = authorOf(input.prompt), f = await getFeature(dir, 'f1');
    await updateFeature(dir, 'f1', 'save', { phase: f.phase, content: `# ${f.phase}\n\n- AC-1: 열린다` });
    await updateFeature(dir, 'f1', 'complete', { phase: f.phase, evidence: '가짜', author });
    return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'done', report: '끝' }), usage: claude(0.08) };
  };
  const listTools = async () => [{ id: 'claude', installed: true, approval: 'dashboard' }];
  const engine = createPmLoop({ root, execute, listTools, user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  await assert.rejects(createGoal(root, { title: '비용', features: ['f1'], budgets: { costUsd: '0,05' } }, { author: '대표' }), /소수점은 \./);
  const g = await createGoal(root, { title: '비용', features: ['f1'], budgets: { costUsd: '0.05' } }, { author: '대표' });
  assert.equal(g.budgets.costUsd, 0.05);
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  const view = async () => goalOverview(root, g.id, { user: '대표', tools: await engine.tools() });
  const card = (await view()).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, g.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers, tool: 'claude' });
  await engine.workers.settled();
  await evaluateGoals(root, { tools: ['claude'] });
  const stopped = await view();
  assert.equal(stopped.state, 'stopped');
  assert.match(stopped.stoppedReason, /비용 한도 \$0\.05/);
  assert.deepEqual([stopped.budget.usage.costUsd, stopped.budget.usage.costUnknown], [0.08, 0]);
  assert.equal(costLimitText(stopped.budget.usage, stopped.budget.limits.costUsd, ko), '비용 한도: $0.08 / $0.05 · 도구가 알린 비용(실제 청구와 다를 수 있음)');
  assert.equal(stopped.suggestions.some((item) => item.kind === 'start-worker'), false);
  assert.equal((await readDecisions(root, g.id)).filter((item) => item.kind === 'goal' && item.outcome === 'stopped').at(-1).by, 'pm-loop');
  await assert.rejects(resumeGoal(root, g.id, { author: 'auto', budgets: { costUsd: 1 } }));
  await resumeGoal(root, g.id, { author: '대표' });
  await evaluateGoals(root, { tools: ['claude'] });
  assert.equal((await view()).state, 'stopped');
  await resumeGoal(root, g.id, { author: '대표', budgets: { costUsd: '1.00' } });
  await evaluateGoals(root, { tools: ['claude'] });
  const running = await view();
  assert.notEqual(running.state, 'stopped');
  assert.equal(running.budget.limits.costUsd, 1);
  const pr = await buildPrBody(root, 'f1', { language: 'ko' });
  assert.match(pr.body, /- 도구가 알린 비용 \$0\.08\(실제 청구와 다를 수 있음\)/);
});
