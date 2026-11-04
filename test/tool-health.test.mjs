import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, createTestSymlink } from './chat-helpers.mjs';
import { DEFAULT_FAILURE_DIR, FAILURE_LIMITS, classifyFailure, loadFailureRules, parseResetTime, validateFailureRules } from '../src/tool-failures.mjs';
import { activeToolHealth, healthFor, noteToolRun, readToolHealth, retryTool, toolHealthLines } from '../src/chat/tool-health.mjs';
import { autoRule, acceptanceLines, createGoal, createPmLoop, executeSuggestion, goalOverview, judgmentInput, nextActions, pickWorkerTool, pmLoopOverview, readDecisions, DEFAULT_BUDGETS } from '../src/chat/pm-loop.mjs';
import { requestTools, commandVersion } from '../src/agent-tools.mjs';
import { runCodexSession } from '../src/codex-session.mjs';
import { diagnoseProject } from '../src/diagnostics.mjs';
import { setPm } from '../src/chat/team.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { updateFeature } from '../src/workflow.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/tool-failures/', import.meta.url));
const NOW = Date.parse('2026-11-01T10:00:00Z');
const MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const fixtures = async () => Object.fromEntries(await Promise.all((await readdir(FIXTURES)).filter((name) => name.endsWith('.json'))
  .map(async (name) => [name.slice(0, -5), JSON.parse(await readFile(join(FIXTURES, name), 'utf8'))])));


test('shipped failure shapes: every file validates strictly and every rule has a real-output fixture that it matches', async () => {
  const rules = await loadFailureRules({ fresh: true });
  assert.deepEqual(rules.issues, []);
  assert.deepEqual([...rules.byTool.keys()].sort(), ['antigravity', 'codex']);
  const cases = await fixtures();
  assert.deepEqual(Object.keys(cases).sort(), [...rules.byTool.keys()].sort(), 'one fixture file per data file');
  for (const [tool, set] of rules.byTool) {
    for (const rule of set.rules) assert.ok(cases[tool].cases.some((item) => item.rule === rule.id), `${tool}/${rule.id} has a fixture`);
    for (const item of cases[tool].cases) {
      const hit = classifyFailure(tool, { [item.stream]: item.text }, { rules, now: NOW });
      if (!item.rule) { assert.equal(hit, null, `${tool}: ${item.text.slice(0, 40)} is not a tool failure`); continue; }
      assert.deepEqual([hit?.rule, hit?.shape, hit?.version], [item.rule, item.shape, set.version], `${tool}/${item.rule}`);
      assert.deepEqual(hit.phases ?? null, item.phases ?? null);
      if (item.until) assert.equal(hit.until, new Date(item.until[0], item.until[1] - 1, item.until[2], item.until[3], item.until[4]).toISOString(), 'reset time read in local time');
      else assert.equal(hit.until, undefined);
      const other = item.stream === 'error' ? 'stderr' : 'error';
      assert.equal(classifyFailure(tool, { [other]: item.text }, { rules, now: NOW })?.rule ?? null, null);
    }
  }
  assert.equal(classifyFailure('claude', { error: cases.codex.cases[0].text }, { rules }), null);
});

test('failure shape files: unknown keys, bad regexes, misplaced until/phases, size and links are refused', async (t) => {
  const base = () => ({ schema: 1, tool: 'codex', version: '2026.11.01', rules: [{ id: 'r', shape: 'config', match: { contains: ['x'] } }] });
  assert.equal(validateFailureRules(base(), { tool: 'codex' }).ok, true);
  const refuse = (mutate, why, tool = 'codex') => {
    const value = base(); mutate(value);
    const checked = validateFailureRules(value, { tool });
    assert.equal(checked.ok, false, why);
    return checked.reason;
  };
  assert.match(refuse((v) => { v.extra = 1; }, 'top-level key'), /unknown key "extra"/);
  assert.match(refuse((v) => { v.rules[0].note = 'x'; }, 'rule key'), /unknown key/);
  assert.match(refuse((v) => { v.rules[0].match.flags = 'g'; }, 'match key'), /unknown key/);
  refuse((v) => { v.schema = 2; }, 'schema');
  refuse((v) => { v.tool = 'grok'; }, 'tool that cannot run headless');
  assert.match(refuse(() => {}, 'name mismatch', 'claude'), /file name/);
  refuse((v) => { v.version = 'latest'; }, 'version');
  refuse((v) => { v.rules = []; }, 'no rules');
  refuse((v) => { v.rules.push({ ...v.rules[0] }); }, 'duplicate id');
  refuse((v) => { v.rules[0].shape = 'timeout'; }, 'timeouts are not a tool shape');
  refuse((v) => { v.rules[0].match = { stream: 'error' }; }, 'needs contains or regex');
  refuse((v) => { v.rules[0].match.stream = 'stdout'; }, 'stream');
  assert.match(refuse((v) => { v.rules[0].match.regex = '('; }, 'regex compile'), /does not compile/);
  refuse((v) => { v.rules[0].match.regex = 'a'.repeat(FAILURE_LIMITS.regex + 1); }, 'regex size');
  refuse((v) => { v.rules[0].match.contains = ['a‮b']; }, 'hidden characters');
  refuse((v) => { v.rules[0].until = { regex: 'at (.+)' }; }, 'until only for quota');
  refuse((v) => { Object.assign(v.rules[0], { shape: 'quota', until: { regex: 'at .+' } }); }, 'until needs a capture group');
  refuse((v) => { v.rules[0].phases = ['implement']; }, 'phases only for permission');
  refuse((v) => { Object.assign(v.rules[0], { shape: 'permission', phases: ['deploy'] }); }, 'unknown phase');
  assert.equal(validateFailureRules({ ...base(), rules: [{ id: 'q', shape: 'quota', match: { regex: 'limit' }, until: { regex: 'at (.+)' } }] }).ok, true);

  const dir = join(await project(t), 'rules');
  await mkdir(dir);
  await writeFile(join(dir, 'codex.json'), JSON.stringify({ ...base(), padding: 'x'.repeat(FAILURE_LIMITS.fileBytes) }));
  await writeFile(join(dir, 'gemini.json'), '{');
  await writeFile(join(dir, 'real.json'), JSON.stringify(base()));
  const linked = await createTestSymlink(t, join(dir, 'real.json'), join(dir, 'claude.json'), 'file');
  const loaded = await loadFailureRules({ dir, fresh: true });
  assert.equal(loaded.byTool.size, 0, 'nothing unusable is used');
  assert.deepEqual(loaded.issues.map((item) => item.tool).sort(), [...(linked ? ['claude'] : []), 'codex', 'gemini'].sort());
  assert.ok(DEFAULT_FAILURE_DIR.endsWith('tool-failures/') || DEFAULT_FAILURE_DIR.endsWith('tool-failures\\'));
});

test('reset times: the Codex date form in local time and ISO; nonsense and far-future times fall back to 24 hours', async () => {
  assert.equal(parseResetTime('Nov 22nd, 2026 2:36 PM'), new Date(2026, 10, 22, 14, 36).getTime());
  assert.equal(parseResetTime('November 3, 2026, 12:05 AM'), new Date(2026, 10, 3, 0, 5).getTime());
  assert.equal(parseResetTime('2026-11-02T03:00:00Z'), Date.parse('2026-11-02T03:00:00Z'));
  assert.equal(parseResetTime('Foo 3, 2026 1:00 PM'), null);
  assert.equal(parseResetTime('tomorrow'), null);
  const rules = await loadFailureRules();
  const quota = (when) => classifyFailure('codex', { error: `You’ve hit your usage limit. Try again at ${when}.` }, { rules, now: NOW });
  assert.equal(quota('Oct 1st, 2026 1:00 PM').until, undefined, 'a past time is not used');
  assert.equal(quota('Mar 1st, 2027 1:00 PM').until, undefined, 'more than 60 days ahead is not used');
  assert.equal(quota('Nov 2nd, 2026 1:00 PM').shape, 'quota');
});


const realError = async (tool, rule) => { const item = (await fixtures())[tool].cases.find((entry) => entry.rule === rule); return Object.assign(new Error('표시용 문장'), { toolOutput: { [item.stream]: item.text } }); };

test('tool health: only matching shapes are recorded; quota clears at its time, config on success or retry, everything after 24 hours without a time', async (t) => {
  const root = await project(t);
  assert.equal(await noteToolRun(root, { tool: 'codex', phase: 'implement', ok: false, error: new Error('not ok 3 - sumTo includes n'), source: 'worker', now: NOW }), null);
  assert.equal(await noteToolRun(root, { tool: 'codex', phase: 'implement', ok: true, source: 'worker', now: NOW }), null, 'a success with nothing to clear writes nothing');
  assert.deepEqual(await readToolHealth(root), []);
  const quota = await noteToolRun(root, { tool: 'codex', phase: 'implement', ok: false, error: await realError('codex', 'usage-limit'), source: 'worker', goal: 'goal-00000001', now: NOW });
  assert.deepEqual([quota.shape, quota.rule], ['quota', 'usage-limit']);
  const until = new Date(2026, 10, 22, 14, 36).getTime();
  const now = (ms) => activeToolHealth(readBack, ms);
  let readBack = await readToolHealth(root);
  assert.equal(readBack[0].excerpt.includes('usage limit'), true);
  assert.equal(now(until - MIN).length, 1, 'still limited before the reset time (not cleared by 24 hours)');
  assert.equal(now(until + MIN).length, 0, 'cleared at the reset time');
  const config = await noteToolRun(root, { tool: 'codex', phase: 'design', ok: false, error: await realError('codex', 'model-not-found'), source: 'judge', now: NOW + MIN });
  assert.equal(config.shape, 'config');
  readBack = await readToolHealth(root);
  assert.deepEqual(now(NOW + 2 * MIN).map((item) => item.shape).sort(), ['config', 'quota']);
  assert.equal(now(NOW + 25 * HOUR).some((item) => item.shape === 'config'), false, 'no time: cleared after 24 hours');
  await noteToolRun(root, { tool: 'codex', phase: 'plan', ok: true, source: 'worker', now: NOW + 3 * MIN });
  readBack = await readToolHealth(root);
  assert.deepEqual(now(NOW + 4 * MIN), [], 'a success clears config and quota');
  assert.equal(readBack.at(-1).kind, 'success');
  await noteToolRun(root, { tool: 'codex', phase: 'design', ok: false, error: await realError('codex', 'model-not-found'), source: 'worker', now: NOW + 5 * MIN });
  assert.deepEqual((await retryTool(root, 'codex', { author: '대표', now: NOW + 6 * MIN })).released, 1);
  assert.deepEqual(activeToolHealth(await readToolHealth(root), NOW + 7 * MIN), []);
  assert.deepEqual((await retryTool(root, 'codex', { author: '대표', now: NOW + 8 * MIN })).released, 0, 'nothing to clear writes nothing');
  await assert.rejects(retryTool(root, 'grok', { author: '대표' }), /알 수 없는 도구/);
});

test('tool health: a headless permission denial applies only to its phases and clears only on a success in one of them', async (t) => {
  const root = await project(t);
  const hit = await noteToolRun(root, { tool: 'antigravity', phase: 'review', ok: false, error: await realError('antigravity', 'headless-command-denied'), source: 'worker', now: NOW });
  assert.deepEqual([hit.shape, hit.phases], ['permission', ['implement', 'review']]);
  let health = activeToolHealth(await readToolHealth(root), NOW + MIN);
  assert.ok(healthFor(health, 'antigravity', 'implement'));
  assert.equal(healthFor(health, 'antigravity', 'plan'), null, 'phases without commands are not affected');
  assert.equal(healthFor(health, 'antigravity', null), null, 'nor the read-only judgment');
  await noteToolRun(root, { tool: 'antigravity', phase: 'plan', ok: true, source: 'worker', now: NOW + 2 * MIN });
  health = activeToolHealth(await readToolHealth(root), NOW + 3 * MIN);
  assert.ok(healthFor(health, 'antigravity', 'review'), 'a plan success says nothing about commands');
  await noteToolRun(root, { tool: 'antigravity', phase: 'implement', ok: true, source: 'worker', now: NOW + 4 * MIN });
  assert.deepEqual(activeToolHealth(await readToolHealth(root), NOW + 5 * MIN), []);
});


const goal = (extra = {}) => ({ id: 'goal-0000000b', title: '목표', state: 'running', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 10 * MIN), ...extra });
const feature = (phase, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }], artifacts: {}, ...extra });
const implemented = (tool = 'claude', extra = {}) => feature('review', { completed: { implement: { at: iso(NOW - 3 * MIN), evidence: 'x', author: `${tool}-a` } },
  history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }, { action: 'complete', phase: 'implement', at: iso(NOW - 3 * MIN), author: `${tool}-a`, tool }], ...extra });
const failure = (tool, shape, extra = {}) => ({ tool, shape, rule: 'r', until: null, phases: null, at: iso(NOW - 5 * MIN), excerpt: 'x', ...extra });
const run = (input) => nextActions({ goal: goal(), now: NOW, tools: ['codex', 'claude', 'antigravity'], ...input });
const card = (result) => result.suggestions[0];

test('worker tool: an unhealthy tool goes to the end of the default order, even a recipe tool; the card says why; a person can still pick it; auto does not', () => {
  const health = [failure('codex', 'config')];
  const choice = pickWorkerTool({ feature: feature('design'), phase: 'design', tools: ['codex', 'claude'], health, recipeTool: 'codex' });
  assert.deepEqual([choice.tool, choice.tools, choice.recipe, choice.demoted], ['claude', ['claude', 'codex'], undefined, ['codex']]);
  const start = card(run({ features: [feature('design')], health, goal: goal({ recipe: { id: 'r', title: '레시피', workers: { design: 'codex' } } }) }));
  assert.deepEqual([start.kind, start.tool, start.tools, start.autoTool, start.recipeTool], ['start-worker', 'claude', ['claude', 'antigravity', 'codex'], 'claude', undefined]);
  assert.match(start.healthNote, /기본 순서 맨 뒤로 보냄: 최근 실패: Codex 모델·인증 거부/);
  assert.match(start.options.find((item) => item.id === 'codex').warning, /최근 실패: Codex/);
  assert.deepEqual(start.options.find((item) => item.id === 'codex').health, { shape: 'config', until: null });
  const all = card(run({ tools: ['codex'], features: [feature('design')], health }));
  assert.deepEqual([all.tool, all.autoTool, autoRule(all)], ['codex', null, null]);
  assert.match(all.reason, /모두 최근에 고정 실패.*최근 실패: Codex 모델·인증 거부/);
  const denied = [failure('antigravity', 'permission', { phases: ['implement', 'review'] })];
  assert.deepEqual(card(run({ tools: ['antigravity', 'claude'], features: [feature('plan')], health: denied })).tools, ['claude', 'antigravity']);
  assert.equal(pickWorkerTool({ feature: feature('plan'), phase: 'plan', tools: ['antigravity'], health: denied }).demoted, undefined);
  const prefer = [{ kind: 'judge-proposal', outcome: 'executed', judgment: 'block', feature: 'f1', phase: 'plan', iteration: 0, decision: { action: 'retry', task: 't-1', tool: 'codex', prefer: { tool: 'codex', avoid: null } }, at: iso(NOW - 30 * MIN) }];
  assert.equal(card(run({ features: [feature('design')], health, decisions: prefer })).tool, 'claude');
});

test('review fallback: with no installed, healthy headless tool other than the implementer the default is "review it yourself" with the ACs and exact commands', () => {
  const plan = '# 계획\n\n- AC-1: 재현 테스트가 고치기 전에 실패한다\n- AC-2: 기존 테스트가 통과한다\n';
  const bugfix = goal({ recipe: { id: 'bugfix', title: '버그 수정', notes: { review: '고치기 전 코드에서 재현 테스트가 실패하는지 확인한다(예: `git stash`).' } } });
  const self = card(nextActions({ goal: bugfix, now: NOW, tools: ['claude'], features: [implemented('claude', { artifacts: { plan } })], user: '대표' }));
  assert.deepEqual([self.kind, self.human, self.executable, self.tool, autoRule(self)], ['self-review', true, false, null, null]);
  assert.match(self.reason, /구현 도구 Claude Code.*직접 검토/);
  assert.deepEqual(self.ac, [{ id: 'AC-1', text: '재현 테스트가 고치기 전에 실패한다' }, { id: 'AC-2', text: '기존 테스트가 통과한다' }]);
  assert.deepEqual(self.commands, ['wax status f1', 'wax test f1 -- <test-command>', 'wax save review f1 --file .wax/tmp/review-f1.md',
    'wax complete review f1 --verdict pass --evidence "<what-you-checked>" --proofs <proof-id> --checks-file .wax/tmp/review-checks-f1.json --author 대표']);
  assert.match(self.recipeNote, /git stash/);
  const unhealthy = card(nextActions({ goal: goal(), now: NOW, tools: ['claude', 'codex'], features: [implemented('claude')], health: [failure('codex', 'quota', { until: iso(NOW + HOUR) })] }));
  assert.deepEqual([unhealthy.kind, unhealthy.executable, unhealthy.tool, unhealthy.tools], ['self-review', true, null, ['codex']]);
  assert.match(unhealthy.options[0].warning, /사용 한도/);
  assert.deepEqual(unhealthy.ac, []);
  assert.doesNotMatch(unhealthy.commands.at(-1), /--checks-file|--author/, 'no ACs and no dashboard user');
  assert.equal(card(nextActions({ goal: goal(), now: NOW, tools: ['claude', 'codex'], features: [implemented('claude')] })).kind, 'start-worker');
  assert.deepEqual(acceptanceLines('- ac-3:  소문자도 \n본문'), [{ id: 'AC-3', text: '소문자도' }]);
});

test('judgment cards: proposal tool options list installed tools only, healthy first; a broken or missing pick is warned and auto leaves it to a person', () => {
  const blockedTask = { id: 't-000001-aaaaaa', feature: 'f1', to: 'wax-worker-claude', phase: 'design', status: 'blocked', at: iso(NOW - 4 * MIN), statusAt: iso(NOW - 3 * MIN), updates: [{ status: 'blocked', at: iso(NOW - 3 * MIN), note: '막힘' }] };
  const base = { features: [feature('design')], tasks: [blockedTask], tools: ['codex', 'claude'] };
  const site = run(base).suggestions.find((item) => item.kind === 'judge');
  const proposed = (tool) => [{ kind: 'judgment', outcome: 'requested', judge: 'pj-00000001', site: site.site, judgment: 'block', tool: 'claude', at: iso(NOW - 2 * MIN) },
    { kind: 'judgment', outcome: 'proposed', judge: 'pj-00000001', proposal: { action: 'retry', tool, question: null, reason: 'x' }, at: iso(NOW - MIN) }];
  const health = [failure('codex', 'config')];
  const broken = run({ ...base, health, decisions: proposed('codex') }).suggestions.find((item) => item.kind === 'judge-proposal');
  assert.deepEqual(broken.toolOptions.map((item) => [item.id, Boolean(item.warning)]), [['claude', false], ['codex', true]]);
  assert.match(broken.toolWarning, /판단이 고른 도구가 최근 고정 실패/);
  assert.equal(autoRule(broken), null, 'auto does not apply a judgment that picked a broken tool');
  const missing = run({ ...base, decisions: proposed('gemini') }).suggestions.find((item) => item.kind === 'judge-proposal');
  assert.deepEqual(missing.toolOptions.map((item) => item.id), ['codex', 'claude', 'gemini']);
  assert.match(missing.toolWarning, /Gemini CLI은\(는\) 이 컴퓨터에 설치되어 있지 않습니다/);
  const fine = run({ ...base, decisions: proposed('claude') }).suggestions.find((item) => item.kind === 'judge-proposal');
  assert.deepEqual([fine.toolWarning, autoRule(fine)], [undefined, 'apply-retry']);
  const judge = run({ ...base, goal: goal({ judgeTool: 'codex' }), health: [failure('codex', 'quota')] }).suggestions.find((item) => item.kind === 'judge');
  assert.deepEqual([judge.tool, judge.unhealthy, autoRule(judge)], ['codex', true, null]);
  assert.match(judge.warning, /사용 한도/);
});

test('judge tool default: with no judge tool set, a tool with a recent fixed failure goes to the end like the worker order; all bad keeps the first with a warning', () => {
  const blockedTask = { id: 't-000001-aaaaaa', feature: 'f1', to: 'wax-worker-claude', phase: 'design', status: 'blocked', at: iso(NOW - 4 * MIN), statusAt: iso(NOW - 3 * MIN), updates: [{ status: 'blocked', at: iso(NOW - 3 * MIN), note: '막힘' }] };
  const base = { features: [feature('design')], tasks: [blockedTask], tools: ['codex', 'claude'] };
  const judgeCard = (input) => run({ ...base, ...input }).suggestions.find((item) => item.kind === 'judge');
  const demoted = judgeCard({ health: [failure('codex', 'config')] });
  assert.deepEqual([demoted.tool, demoted.unhealthy, demoted.warning, autoRule(demoted)], ['claude', undefined, undefined, 'judge-block']);
  const report = run({ features: [feature('done')], tools: ['codex', 'claude'], health: [failure('codex', 'config')] }).suggestions.find((item) => item.kind === 'judge');
  assert.equal(report.tool, 'claude', 'the report judgment too');
  assert.equal(judgeCard({ tools: ['codex', 'antigravity'], health: [failure('codex', 'config'), failure('antigravity', 'permission', { phases: ['implement', 'review'] })] }).tool, 'antigravity');
  const allBad = judgeCard({ health: [failure('codex', 'config'), failure('claude', 'quota')] });
  assert.deepEqual([allBad.tool, allBad.unhealthy], ['codex', true]);
  assert.equal(judgeCard({ goal: goal({ judgeTool: 'codex' }), health: [failure('codex', 'config')] }).tool, 'codex');
});


async function setup(t, { execute, tools = ['codex', 'claude'] } = {}) {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const engine = createPmLoop({ root, execute, listTools: async () => tools.map((id) => ({ id, installed: true, approval: 'dashboard' })), user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const g = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  const view = async () => goalOverview(root, g.id, { user: '대표', tools: await engine.tools() });
  return { root, engine, goal: g, view };
}

test('engine: a worker that fails with a real Codex model_not_found output is remembered, demoted on the next card, and cleared by Retry', async (t) => {
  const error = await realError('codex', 'model-not-found');
  const { root, engine, goal: g, view } = await setup(t, { execute: async () => { throw error; } });
  const first = (await view()).suggestions[0];
  assert.equal(first.tool, 'codex');
  await executeSuggestion(root, g.id, first.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  const end = (await readDecisions(root, g.id)).filter((item) => item.kind === 'worker').at(-1);
  assert.deepEqual([end.outcome, end.health.shape, end.health.rule], ['failed', 'config', 'model-not-found']);
  assert.match(end.reason, /도구 상태로 기억함 — 최근 실패: Codex 모델·인증 거부\(한 번 성공하거나 다시 시도를 누르면 풀림/);
  const [record] = await readToolHealth(root);
  assert.deepEqual([record.kind, record.tool, record.source, record.goal, record.phase], ['failure', 'codex', 'worker', g.id, 'plan']);
  const blocked = (await view()).suggestions.find((item) => item.kind === 'blocked');
  await executeSuggestion(root, g.id, blocked.key, { author: '대표' });
  const next = (await view()).suggestions.find((item) => item.kind === 'start-worker');
  assert.deepEqual([next.tool, next.tools], ['claude', ['claude', 'codex']]);
  const overview = await pmLoopOverview(root, { user: '대표', tools: await engine.tools() });
  assert.deepEqual(overview.toolHealth.map((item) => [item.tool, item.shape, item.label]), [['codex', 'config', 'Codex']]);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000, requestTools: async () => [], executeWorker: async () => { throw new Error('no AI'); } });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post('/api/tool-health/codex/retry')).status, 403);
  const retried = await post('/api/tool-health/codex/retry', { 'x-chat-token': token });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).released, 1);
  assert.equal((await post('/api/tool-health/grok/retry', { 'x-chat-token': token })).status, 400);
  assert.equal((await view()).suggestions.find((item) => item.kind === 'start-worker').tool, 'codex', 'back to the default order');
});

test('engine: a failure outside the fixed shapes (a failing test, a timeout) is not remembered; a later success writes nothing', async (t) => {
  let calls = 0;
  const { root, engine, goal: g, view } = await setup(t, { execute: async () => { calls += 1; throw new Error('not ok 1 - expected 6, got 3'); } });
  const first = (await view()).suggestions[0];
  await executeSuggestion(root, g.id, first.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  assert.equal(calls, 1);
  assert.equal((await readDecisions(root, g.id)).filter((item) => item.kind === 'worker').at(-1).health, undefined);
  assert.deepEqual(await readToolHealth(root), []);
});

test('judgment input: block and report get unavailableTools and the computed goal state, not the stored one', async (t) => {
  const { root, goal: g } = await setup(t);
  await noteToolRun(root, { tool: 'codex', phase: 'implement', ok: false, error: await realError('codex', 'model-not-found'), source: 'worker', now: Date.now() });
  const report = await judgmentInput(root, { goal: g.id, judgment: 'report', tools: ['codex', 'claude'] });
  assert.equal(report.data.goal.state, 'waiting-human', 'the start-worker card waits for a person while the stored state is running');
  assert.deepEqual(report.data.unavailableTools.map((item) => [item.tool, item.shape]), [['codex', 'config']]);
  assert.match(report.data.unavailableTools[0].note, /Codex 모델·인증 거부/);
  const plan = await judgmentInput(root, { goal: g.id, judgment: 'plan', tools: ['codex'] });
  assert.equal(plan.data.unavailableTools, undefined, 'only block and report');
});

test('self-review card: launching an unhealthy tool needs an explicit pick and is recorded as a person\'s choice', async (t) => {
  const execute = async () => ({ threadId: 'x', status: 'completed', message: JSON.stringify({ outcome: 'blocked', report: '검토 못 함' }) });
  const { root, engine, goal: g, view } = await setup(t, { execute, tools: ['claude', 'codex'] });
  await noteToolRun(root, { tool: 'codex', phase: 'review', ok: false, error: await realError('codex', 'model-not-found'), source: 'worker', now: Date.now() });
  for (const [phase, content] of [['plan', '- AC-1: 된다'], ['design', 'design'], ['implement', 'impl']]) {
    await updateFeature(root, 'f1', 'save', { phase, content });
    await updateFeature(root, 'f1', 'complete', { phase, evidence: 'x', author: 'claude-a', tool: 'claude', ...(phase === 'implement' ? { waiver: '테스트용' } : {}) });
  }
  assert.equal((await view()).features[0].phase, 'review');
  const self = (await view()).suggestions.find((item) => item.kind === 'self-review');
  assert.ok(self, 'review it yourself is the default');
  await assert.rejects(executeSuggestion(root, g.id, self.key, { author: '대표', tools: await engine.tools(), workers: engine.workers }), /고를 수 없습니다/);
  const done = await executeSuggestion(root, g.id, self.key, { author: '대표', tools: await engine.tools(), workers: engine.workers, tool: 'codex' });
  assert.deepEqual([done.decision.kind, done.decision.tool], ['self-review', 'codex']);
  assert.match(done.decision.reason, /직접 검토 카드에서 사람이 경고를 보고 Codex/);
  await engine.workers.settled();
});


test('Copilot CLI: an executable that is only the VS Code shim is not installed; the real CLI must print a version', async (t) => {
  const resolve = async (id) => { if (id === 'copilot') return ['/vscode/copilot-shim/copilot', []]; if (id === 'codex') return ['/bin/codex', []]; throw new Error('missing'); };
  const asked = [];
  const shim = await requestTools({ resolve, version: async (command, args) => { asked.push([command, ...args]); return null; }, now: NOW });
  assert.deepEqual(shim.filter((item) => item.installed).map((item) => item.id), ['codex']);
  assert.deepEqual(asked, [['/vscode/copilot-shim/copilot', '--version']], 'only Copilot is checked with --version');
  const real = await requestTools({ resolve: async (id) => (id === 'copilot' ? ['/real/copilot', []] : Promise.reject(new Error('x'))), version: async () => '0.0.354', now: NOW });
  assert.equal(real.find((item) => item.id === 'copilot').installed, true);
  const dir = await project(t);
  const node = process.execPath;
  const script = async (name, body) => { const file = join(dir, name); await writeFile(file, body); return file; };
  assert.equal(await commandVersion(node, [await script('shim.mjs', "process.stdout.write('GitHub Copilot CLI was not found. Run copilot in a terminal to install it'); process.exit(127);")]), null);
  assert.equal(await commandVersion(node, [await script('real.mjs', "process.stdout.write('GitHub Copilot CLI 0.0.354.\\n');")]), '0.0.354');
});

test('wax doctor: one line per tool from this computer\'s tool health, without creating anything', async (t) => {
  const root = await project(t);
  const empty = await diagnoseProject(root, { readVersion: async () => null });
  assert.equal(empty.toolHealth.tools.length, 5);
  assert.match(empty.toolHealth.tools[0].line, /Codex: 최근 고정 실패 없음/);
  assert.deepEqual(empty.toolHealth.issues, []);
  assert.deepEqual(await readdir(root), [], 'read-only');
  await noteToolRun(root, { tool: 'antigravity', phase: 'review', ok: false, error: await realError('antigravity', 'headless-command-denied-stderr'), source: 'worker', now: Date.now() });
  const lines = (await toolHealthLines(root)).tools;
  const agy = lines.find((item) => item.tool === 'antigravity');
  assert.deepEqual([agy.state, agy.rules], ['permission', 2]);
  assert.match(agy.line, /최근 실패: Antigravity CLI headless 권한 거부\(implement, review 단계, 한 번 성공하거나/);
  assert.equal(lines.find((item) => item.tool === 'claude').rules, 0);
});


test('Codex session: a failed turn keeps the raw error for the failure shapes (real model_not_found output)', async (t) => {
  const root = await project(t), fake = join(root, 'fake.js');
  const { text } = (await fixtures()).codex.cases.find((item) => item.rule === 'model-not-found');
  await writeFile(fake, `const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  process.stderr.write('codex: request failed\\n');
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'failed',error:{message:${JSON.stringify(text)}}}}});
 }
});`);
  const error = await runCodexSession(root, { executable: fake, prompt: 'test', output() {}, log() {} }).then(() => null, (failure) => failure);
  assert.ok(error);
  assert.equal(error.toolOutput.error, text);
  assert.match(error.toolOutput.stderr, /request failed/);
  assert.equal(classifyFailure('codex', error.toolOutput, { rules: await loadFailureRules() }).rule, 'model-not-found');
});
