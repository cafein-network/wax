import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { antigravityUsage, claudeUsage, cleanUsage, countedTokens, reportsUsage, sumUsage, usageLines, usagePrompt, USAGE_SOURCES } from '../src/tool-usage.mjs';
import {
  autoRule, budgetUsage, createGoal, createPmLoop, evaluateGoals, executeSuggestion, featureUsage, goalOverview, nextActions, normalizeBudgets, pmLoopOverview, readDecisions, resumeGoal, toolUsageToday, workerPrompt,
  DEFAULT_BUDGETS,
} from '../src/chat/pm-loop.mjs';
import { setPm, listTasks } from '../src/chat/team.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { chatDir } from '../src/chat/paths.mjs';
import { buildRunTrace, traceVisits } from '../src/run-trace.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { featureStatus } from '../src/status.mjs';
import { buildPrompt, getFeature, updateFeature } from '../src/workflow.mjs';
import { runCodexSession } from '../src/codex-session.mjs';
import { cliText } from '../src/cli-locale.mjs';

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const claudeLine = async () => JSON.parse((await fixture('usage/claude-result.json')).line);
const agyResult = async () => JSON.parse((await fixture('tool-failures/antigravity.json')).cases.find((item) => item.rule === null).text).result;
const { say } = cliText('ko');


test('claude: the real stream-json result line gives input, output, cache read/write, thinking, cost and turns; no total is invented', async () => {
  const frame = await claudeLine();
  assert.equal(frame.type, 'result');
  assert.doesNotMatch(JSON.stringify(frame), /340ac8ae|\/Users\//, 'no real session id or path in the fixture');
  assert.deepEqual(claudeUsage(frame), { source: 'claude', tokens: { input: 2, output: 4, cacheRead: 11384, cacheWrite: 10300, reasoning: 0, total: null }, costUsd: 0.0847648, turns: 1 });
  assert.deepEqual(Object.keys(claudeUsage(frame)), ['source', 'tokens', 'costUsd', 'turns']);
});

test('antigravity: the real result frame gives input, output, thinking, cache read, total and turns; cost is not reported', async () => {
  assert.deepEqual(antigravityUsage(await agyResult()), { source: 'antigravity', tokens: { input: 11131, output: 495, cacheRead: 0, cacheWrite: null, reasoning: 33, total: 11626 }, costUsd: null, turns: 1 });
});

test('junk values are dropped: negatives, strings, NaN, fractions, unsafe integers, negative or infinite cost; nothing reported gives null', () => {
  const frame = { usage: { input_tokens: -1, output_tokens: '12', cache_read_input_tokens: Number.NaN, cache_creation_input_tokens: 1.5, output_tokens_details: { thinking_tokens: 2 ** 60 } }, total_cost_usd: -0.1, num_turns: Infinity };
  assert.equal(claudeUsage(frame), null);
  assert.deepEqual(claudeUsage({ usage: { input_tokens: 10, output_tokens: 'x' }, total_cost_usd: Infinity, num_turns: 3 }),
    { source: 'claude', tokens: { input: 10, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd: null, turns: 3 });
  assert.equal(claudeUsage({}), null);
  assert.equal(claudeUsage(null), null);
  assert.equal(antigravityUsage({ usage: [1, 2], num_turns: -2 }), null);
  assert.deepEqual(claudeUsage({ usage: {}, total_cost_usd: 0 }).costUsd, 0, 'zero is a reported value');
  assert.equal(cleanUsage({ source: 'codex', tokens: { input: 5 } }), null, 'Codex does not report usage until a real fixture exists');
  assert.equal(cleanUsage({ source: 'claude', tokens: { input: -5 } }), null);
  assert.deepEqual(cleanUsage({ source: 'claude', tokens: { input: 5, secret: 'x' }, costUsd: '1', turns: 1, extra: true }),
    { source: 'claude', tokens: { input: 5, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd: null, turns: 1 });
});

test('which tools report: Claude Code and Antigravity CLI only; Codex and the ACP tools do not', () => {
  assert.deepEqual(USAGE_SOURCES, ['claude', 'antigravity']);
  assert.deepEqual(['claude', 'antigravity', 'codex', 'gemini', 'copilot', 'grok'].map(reportsUsage), [true, true, false, false, false, false]);
});

test('codex: a schema-shaped thread/tokenUsage/updated notification is not read; the run reports usage null', async (t) => {
  const root = await project(t), fake = join(root, 'fake.js');
  await writeFile(fake, `const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:{inputTokens:10,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1,totalTokens:13},last:{inputTokens:10,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1,totalTokens:13}}}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'i1',type:'agentMessage',text:'{"outcome":"done","report":"ok"}'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});`);
  const result = await runCodexSession(root, { executable: fake, prompt: 'test', output() {}, log() {} });
  assert.equal(result.status, 'completed');
  assert.equal(result.usage, null);
});


test('sums: per tool, unreported runs (usage null) and old records (no usage field) counted separately; the limit count uses total or else input+output+cache', async () => {
  const claude = claudeUsage(await claudeLine()), agy = antigravityUsage(await agyResult());
  assert.equal(countedTokens(claude), 2 + 4 + 11384 + 10300, 'Claude Code reports no total: input, output and both cache counts');
  assert.equal(countedTokens(agy), 11626, 'Antigravity CLI reports a total');
  assert.equal(countedTokens(null), 0);
  const summary = sumUsage([{ usage: claude }, { usage: claude }, { usage: agy }, { usage: null }, {}, { usage: { source: 'claude', tokens: { input: -1 } } }]);
  assert.deepEqual([summary.runs, summary.reported, summary.unreported, summary.missing], [6, 3, 2, 1]);
  assert.equal(summary.tokens, 2 * 21690 + 11626);
  assert.deepEqual(summary.tools.map((item) => [item.tool, item.label, item.runs, item.tokens.input, item.tokens.cacheRead, item.tokens.total, item.costUsd, item.turns, item.counted]), [
    ['claude', 'Claude Code', 2, 4, 22768, null, 0.1695296, 2, 43380],
    ['antigravity', 'Antigravity CLI', 1, 11131, 0, 11626, null, 1, 11626],
  ]);
  assert.deepEqual(usageLines(summary, say), [
    'Claude Code 입력 4 · 출력 8 · 캐시 읽기 22768 · 캐시 쓰기 20600 · 추론 0 · 비용 $0.1695296 · 차례 2 · 실행 2번',
    'Antigravity CLI 입력 11131 · 출력 495 · 캐시 읽기 0 · 추론 33 · 토큰 합계 11626 · 차례 1 · 실행 1번',
    '사용량을 알리지 않은 실행 2번', '사용량 기록 없음(옛 기록) 1번']);
  assert.deepEqual(usageLines(sumUsage([]), say), []);
  assert.match(usageLines(summary, cliText('en').say)[0], /^Claude Code Input 4 · Output 8 .*Cost \$0\.1695296 · Turns 2 · Runs 2$/);
});

test('report prompt: the usage summary goes in as quoted data with an instruction to quote it, not as free text; nothing when there were no runs', async () => {
  const summary = sumUsage([{ usage: claudeUsage(await claudeLine()) }, { usage: null }]);
  const text = usagePrompt(summary);
  const quoted = text.split('\n').filter((line) => line.startsWith('> '));
  assert.ok(quoted.length > 5);
  assert.deepEqual(JSON.parse(quoted.map((line) => line.slice(2)).join('\n')).tools[0], { tool: 'Claude Code', runs: 1, tokens: { input: 2, output: 4, cacheRead: 11384, cacheWrite: 10300, reasoning: 0, total: null }, costUsd: 0.0847648, turns: 1 });
  assert.match(text, /이 값만 그대로 인용하고 다른 숫자를 추정하거나 지어내지 마세요/);
  assert.equal(usagePrompt(sumUsage([])), '');
  const feature = { id: 'f1', title: 'f1', description: '', projectType: 'general', artifacts: {}, completed: {} };
  assert.match(buildPrompt(feature, 'report', { usage: text }), /"unreportedRuns": 1/);
  assert.doesNotMatch(buildPrompt(feature, 'implement', { usage: text }), /unreportedRuns/, 'only the report phase gets it');
});


const NOW = Date.parse('2026-11-03T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const goal = (extra = {}) => ({ id: 'goal-0000001b', title: '목표', state: 'running', mode: 'auto', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 10 * MIN), ...extra });
const feature = (phase, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }], artifacts: {}, ...extra });
const end = (usage, extra = {}) => ({ kind: 'worker', outcome: 'exited', worker: 'pw-1', tool: 'claude', feature: 'f1', phase: 'plan', iteration: 0, ...(usage === undefined ? {} : { usage }), at: iso(NOW - MIN), ...extra });

test('limit: tokens is optional (no default), set by a person, validated like the other limits; empty clears it, missing keeps it', () => {
  assert.equal(DEFAULT_BUDGETS.tokens, null);
  assert.equal(normalizeBudgets({}).tokens, null);
  assert.equal(normalizeBudgets({ tokens: 50_000 }).tokens, 50_000);
  assert.equal(normalizeBudgets({ tokens: '50000' }).tokens, 50_000);
  for (const bad of [999, 1.5, -1, 'many', 10_000_000_001, Number.NaN]) assert.throws(() => normalizeBudgets({ tokens: bad }), /tokens/, String(bad));
  assert.equal(normalizeBudgets({}, { ...DEFAULT_BUDGETS, tokens: 9000 }).tokens, 9000, 'an absent field keeps the current limit');
  assert.equal(normalizeBudgets({ tokens: null }, { ...DEFAULT_BUDGETS, tokens: 9000 }).tokens, null, 'an empty field removes it');
  assert.equal(normalizeBudgets({ tokens: '' }, { ...DEFAULT_BUDGETS, tokens: 9000 }).tokens, null);
});

test('limit: reaching the reported token sum stops the goal like the other limits; old records and unreported runs do not count', async () => {
  const claude = claudeUsage(await claudeLine());
  const decisions = [end(claude), end(null, { worker: 'pw-2' }), end(undefined, { worker: 'pw-3' }), { kind: 'judgment', outcome: 'proposed', judge: 'pj-1', tool: 'claude', usage: claude, at: iso(NOW) }];
  const under = budgetUsage({ goal: goal({ budgets: { ...DEFAULT_BUDGETS, tokens: 50_000 } }), decisions, now: NOW });
  assert.deepEqual([under.usage.tokens, under.usage.unreported, under.exceeded], [43380, 1, null]);
  const over = budgetUsage({ goal: goal({ budgets: { ...DEFAULT_BUDGETS, tokens: 40_000 } }), decisions, now: NOW });
  assert.match(over.exceeded, /토큰 한도 40000에 닿아 멈췄습니다.*실행 중인 작업자는 끝까지/);
  assert.equal(budgetUsage({ goal: goal(), decisions, now: NOW }).exceeded, null, 'no limit, no stop');
  const result = nextActions({ goal: goal({ budgets: { ...DEFAULT_BUDGETS, tokens: 40_000 } }), features: [feature('design')], decisions, now: NOW, tools: ['claude'] });
  assert.equal(result.state, 'stopped');
});

test('auto rule: with a token limit auto launches only a tool that reports usage, and leaves a non-reporting tool to a person with a warning', () => {
  const card = (tools, budgets) => nextActions({ goal: goal({ budgets }), features: [feature('design')], now: NOW, tools }).actions[0];
  const limited = { ...DEFAULT_BUDGETS, tokens: 100_000 };
  const codexOnly = card(['codex'], limited);
  assert.deepEqual([codexOnly.kind, codexOnly.tool, codexOnly.executable, codexOnly.autoTool, autoRule(codexOnly)], ['start-worker', 'codex', true, null, null]);
  assert.match(codexOnly.options[0].warning, /Codex은\(는\) 사용량을 알리지 않아 이 목표의 토큰 한도에 세지 않습니다/);
  const mixed = card(['codex', 'claude'], limited);
  assert.deepEqual([mixed.tool, mixed.autoTool, autoRule(mixed)], ['codex', 'claude', 'start-worker'], 'the card default stays; auto picks the reporting tool');
  assert.equal(mixed.options.find((item) => item.id === 'claude').warning, undefined);
  const free = card(['codex'], DEFAULT_BUDGETS);
  assert.deepEqual([free.autoTool, autoRule(free), free.options[0].warning], ['codex', 'start-worker', undefined], 'without a limit nothing changes');
  const blocked = (budgets, judgeTool) => nextActions({ goal: goal({ budgets, judgeTool }), features: [feature('design')], now: NOW, tools: ['codex', 'claude'],
    tasks: [{ id: 't-000001-aaaaaa', feature: 'f1', phase: 'design', to: 'wax-worker-codex', status: 'blocked', at: iso(NOW - 2 * MIN), statusAt: iso(NOW - MIN), updates: [{ status: 'blocked', note: '막힘', at: iso(NOW - MIN) }] }] })
    .suggestions.find((item) => item.kind === 'judge');
  const judge = blocked(limited, 'codex');
  assert.deepEqual([judge.tool, judge.unreported, autoRule(judge)], ['codex', true, null]);
  assert.match(judge.warning, /사용량을 알리지 않아/);
  assert.equal(autoRule(blocked(limited, 'claude')), 'judge-block');
  assert.equal(autoRule(blocked(DEFAULT_BUDGETS, 'codex')), 'judge-block');
});


const authorOf = (prompt) => prompt.match(/작업자 이름: ([^.]+)\./)[1];
async function setup(t, { execute, executeJudge, budgets, tools = ['claude', 'codex'] } = {}) {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const listTools = async () => tools.map((id) => ({ id, installed: true, approval: 'dashboard' }));
  const engine = createPmLoop({ root, execute, executeJudge, listTools, user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const g = await createGoal(root, { title: '사용량', features: ['f1'], ...(budgets ? { budgets } : {}) }, { author: '대표' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  const view = async () => goalOverview(root, g.id, { user: '대표', tools: await engine.tools() });
  const launch = async (tool) => {
    const card = (await view()).suggestions.find((item) => item.kind === 'start-worker');
    assert.ok(card?.executable);
    await executeSuggestion(root, g.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers, tool });
    await engine.workers.settled();
  };
  return { root, engine, goal: g, view, launch };
}

test('engine: each worker end record keeps the usage its tool reported (null when the tool reports none); goal, trace, status, pr-body and prompts show it', async (t) => {
  const claude = claudeUsage(await claudeLine());
  const prompts = [];
  const execute = async (root, input) => {
    prompts.push(input.prompt);
    const author = authorOf(input.prompt), f = await getFeature(root, 'f1');
    await updateFeature(root, 'f1', 'save', { phase: f.phase, content: `# ${f.phase}\n\n- AC-1: 열린다` });
    await updateFeature(root, 'f1', 'complete', { phase: f.phase, evidence: '가짜 작업자', author, ...(f.phase === 'implement' || f.phase === 'review' ? { noProof: '시험' } : {}) });
    return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'done', report: '끝' }), ...(input.tool === 'claude' ? { usage: claude } : {}) };
  };
  const { root, goal: g, view, launch } = await setup(t, { execute });
  await launch('claude');
  await launch('codex');
  const ends = (await readDecisions(root, g.id)).filter((item) => item.kind === 'worker' && item.outcome === 'exited');
  assert.deepEqual(ends.map((item) => [item.tool, item.usage]), [['claude', claude], ['codex', null]]);
  const overview = await view();
  assert.deepEqual([overview.usage.runs, overview.usage.reported, overview.usage.unreported, overview.usage.tools.map((item) => item.tool)], [2, 1, 1, ['claude']]);
  assert.deepEqual([overview.budget.usage.tokens, overview.budget.usage.unreported], [21690, 1]);
  const trace = await buildRunTrace(root, 'f1', { language: 'ko' });
  assert.deepEqual(trace.visits.slice(0, 2).map((visit) => [visit.phase, visit.usage?.reported, visit.usage?.unreported, visit.usage?.tools[0]?.tokens.cacheRead ?? null]),
    [['plan', 1, 0, 11384], ['design', 0, 1, null]]);
  assert.match(trace.markdown, /- 사용량\(도구가 알린 값\): Claude Code 입력 2 · 출력 4 · 캐시 읽기 11384 · 캐시 쓰기 10300 · 추론 0 · 비용 \$0\.0847648 · 차례 1 · 실행 1번/);
  assert.match(trace.markdown, /- 사용량\(도구가 알린 값\): 사용량을 알리지 않은 실행 1번/);
  assert.match(trace.markdown, /사용량은 headless 실행에서 도구가 알린 값만 넣었고/);
  const status = await featureStatus(root, 'f1');
  assert.deepEqual([status.usage.runs, status.usage.tokens, status.usage.tools[0].costUsd], [2, 21690, 0.0847648]);
  const pr = await buildPrBody(root, 'f1', { language: 'ko' });
  assert.match(pr.body, /## 사용량\(도구가 알린 값\)\n\n- Claude Code 입력 2 · 출력 4 · 캐시 읽기 11384 · 캐시 쓰기 10300 · 추론 0 · 비용 \$0\.0847648 · 차례 1 · 실행 1번\n- 사용량을 알리지 않은 실행 1번/);
  assert.doesNotMatch(prompts.join('\n'), /unreportedRuns/);
  const goalRecord = { id: g.id, title: '사용량', budgets: DEFAULT_BUDGETS };
  const report = workerPrompt({ root, goal: goalRecord, feature: await getFeature(root, 'f1'), task: { id: 't-1', phase: 'report', note: '' }, author: 'wax-worker-claude', usage: await featureUsage(root, 'f1') });
  assert.match(report, /> +"tool": "Claude Code"/);
  assert.match(report, /> +"unreportedRuns": 1/);
});

test('engine: a failed run keeps the last usage from the error; a PM judgment keeps its usage; an interrupted run records null', async (t) => {
  const claude = claudeUsage(await claudeLine());
  const execute = async () => { throw Object.assign(new Error('도구 실패'), { toolOutput: { error: 'x', stderr: '', result: '', usage: claude } }); };
  const { root, goal: g, launch } = await setup(t, { execute, tools: ['claude'] });
  await launch('claude');
  const failed = (await readDecisions(root, g.id)).find((item) => item.kind === 'worker' && item.outcome === 'failed');
  assert.deepEqual(failed.usage, claude);
  assert.equal((await listTasks(root, { all: true }))[0].status, 'blocked');
  const dir = await chatDir(root, 'pm-loop');
  await appendRecord(join(dir, `${g.id}.jsonl`), (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: g.id, kind: 'worker', outcome: 'launched', worker: 'pw-dead0001', tool: 'claude',
    feature: 'f1', phase: 'plan', iteration: 0, task: 't-000009-bbbbbb', to: 'wax-worker-claude', owner: { pid: 999_999_999, instance: 'gone' }, by: '대표', at: iso(Date.now() - MIN) }));
  await evaluateGoals(root, { tools: ['claude'] });
  const orphan = (await readDecisions(root, g.id)).find((item) => item.worker === 'pw-dead0001' && item.outcome === 'failed');
  assert.ok(Object.hasOwn(orphan, 'usage'));
  assert.equal(orphan.usage, null);
});

test('engine: the token limit stops a running goal at the next pass (running worker untouched) and only a person raises it by resuming', async (t) => {
  const claude = claudeUsage(await claudeLine());
  const execute = async (root, input) => {
    const author = authorOf(input.prompt);
    await updateFeature(root, 'f1', 'save', { phase: 'plan', content: '# plan\n\n- AC-1: 열린다' });
    await updateFeature(root, 'f1', 'complete', { phase: 'plan', evidence: '가짜', author });
    return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'done', report: '끝' }), usage: claude };
  };
  const { root, goal: g, view, launch } = await setup(t, { execute, budgets: { tokens: 20_000 } });
  assert.equal((await view()).budget.limits.tokens, 20_000);
  await launch('claude');
  await evaluateGoals(root, { tools: ['claude'] });
  const stopped = await view();
  assert.equal(stopped.state, 'stopped');
  assert.match(stopped.stoppedReason, /토큰 한도 20000/);
  const record = (await readDecisions(root, g.id)).filter((item) => item.kind === 'goal' && item.outcome === 'stopped').at(-1);
  assert.equal(record.by, 'pm-loop');
  await assert.rejects(resumeGoal(root, g.id, { author: 'auto', budgets: { tokens: 90_000 } }));
  await resumeGoal(root, g.id, { author: '대표', budgets: { tokens: 90_000 } });
  await evaluateGoals(root, { tools: ['claude'] });
  assert.equal((await view()).state === 'stopped', false);
});

test('old records: worker ends written before 1b have no usage field and count as "not recorded", never as zero', async () => {
  const summary = sumUsage([end(undefined), end(undefined, { worker: 'pw-2' })]);
  assert.deepEqual([summary.runs, summary.reported, summary.unreported, summary.missing, summary.tokens], [2, 0, 0, 2, 0]);
  assert.deepEqual(usageLines(summary, say), ['사용량 기록 없음(옛 기록) 2번']);
});

test('trace: a worker whose end record lands after its visit closed still counts once, in the visit it started in; totals stay the same', () => {
  const usage = { source: 'claude', tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40, reasoning: 0, total: null }, costUsd: 0.5, turns: 3 };
  const at = (min, sec = 0) => iso(NOW - 60 * MIN + min * MIN + sec * 1000);
  const f = feature('implement', { history: [{ action: 'create', phase: 'plan', at: at(0) }, { action: 'complete', phase: 'plan', at: at(10) }, { action: 'complete', phase: 'design', at: at(20) }] });
  const launched = (worker, phase, when) => ({ kind: 'worker', outcome: 'launched', worker, tool: 'claude', phase, iteration: 0, at: when });
  const ended = (worker, phase, when, extra = {}) => ({ ...end(usage, { worker, phase, at: when, ...extra }), end: true });
  const pm = [launched('pw-0000000a', 'plan', at(9)), ended('pw-0000000a', 'plan', at(10, 8)),
    launched('pw-0000000b', 'design', at(11)), ended('pw-0000000b', 'design', at(12), { outcome: 'failed' }),
    launched('pw-0000000c', 'design', at(13)), ended('pw-0000000c', 'design', at(20, 30)),
    ended('pw-0000000d', 'implement', at(25))];
  const { visits } = traceVisits(f, { pm, now: NOW });
  assert.deepEqual(visits.map((visit) => [visit.phase, visit.usage?.runs ?? 0, visit.usage?.tools[0]?.tokens.output ?? null]),
    [['plan', 1, 20], ['design', 2, 40], ['implement', 1, 20]]);
  const perVisit = visits.reduce((sum, visit) => sum + (visit.usage?.runs ?? 0), 0);
  const total = sumUsage(pm.filter((item) => item.end));
  assert.equal(perVisit, total.runs, 'every end record counted exactly once across visits');
  assert.equal(visits.reduce((sum, visit) => sum + (visit.usage?.tools[0]?.costUsd ?? 0), 0), total.tools[0].costUsd);
  assert.equal(visits[0].usage.reported, 1);
});

test('tools and cost: the last 24 hours of headless runs per tool across goals, with reported tokens and cost', async (t) => {
  const root = await project(t, ['f1', 'f2']);
  const now = Date.parse('2026-11-04T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const a = await createGoal(root, { title: 'a', features: ['f1'] }, { author: '대표' });
  const b = await createGoal(root, { title: 'b', features: ['f2'] }, { author: '대표' });
  const claude = (input, output, costUsd) => ({ source: 'claude', tokens: { input, output, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd, turns: 1 });
  const put = (goal, fields) => appendRecord(join(root, '.wax', 'chat', 'pm-loop', `${goal.id}.jsonl`), (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...fields }));
  await put(a, { kind: 'worker', outcome: 'exited', tool: 'claude', worker: 'pw-0000000a', usage: claude(100, 50, 0.5), at: iso(now - 60_000) });
  await put(a, { kind: 'worker', outcome: 'failed', tool: 'codex', worker: 'pw-0000000b', usage: null, at: iso(now - 120_000) });
  await put(b, { kind: 'judgment', outcome: 'proposed', tool: 'claude', judge: 'pj-0000000c', usage: claude(10, 5, 0.25), at: iso(now - 30_000) });
  await put(b, { kind: 'worker', outcome: 'exited', tool: 'claude', worker: 'pw-0000000d', usage: claude(999, 999, 9), at: iso(now - 25 * 3_600_000) });
  await put(b, { kind: 'worker', outcome: 'launched', tool: 'claude', worker: 'pw-0000000e', at: iso(now - 1000) });
  const goals = [a, b];
  assert.deepEqual(await toolUsageToday(root, goals, now), [
    { tool: 'codex', label: 'Codex', runs: 1, failed: 1, tokens: null, costUsd: null, unreported: 1 },
    { tool: 'claude', label: 'Claude Code', runs: 2, failed: 0, tokens: 165, costUsd: 0.75, unreported: 0 },
  ]);
  const view = await pmLoopOverview(root, { now, tools: ['codex', 'claude'] });
  assert.equal(view.toolUsage.length, 2);
  assert.deepEqual(await toolUsageToday(root, [], now), []);
});
