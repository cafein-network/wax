import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from './chat-helpers.mjs';
import { disabledTools, healthFor, noteToolRun, readToolSwitches, retryTool, setToolDisabled, toolHealthLines } from '../src/chat/tool-health.mjs';
import { autoRule, completedBy, createGoal, createPmLoop, executeSuggestion, goalOverview, judgeToolFor, judgmentInput, nextActions, pickWorkerTool, pmLoopOverview, DEFAULT_BUDGETS } from '../src/chat/pm-loop.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { diagnoseProject } from '../src/diagnostics.mjs';
import { fillRecipe, getRecipe } from '../src/recipes.mjs';
import { setPm } from '../src/chat/team.mjs';
import { updateFeature } from '../src/workflow.mjs';
import { AC_CHECK } from '../src/acceptance.mjs';

const BIN = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const NOW = Date.parse('2026-11-02T10:00:00Z');
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const goal = (extra = {}) => ({ id: 'goal-0000000c', title: '목표', state: 'running', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 10 * MIN), ...extra });
const feature = (phase, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }], artifacts: {}, ...extra });
const implemented = (tool = 'claude', extra = {}) => feature('review', { completed: { implement: { at: iso(NOW - 3 * MIN), evidence: 'x', author: `${tool}-a` } },
  history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }, { action: 'complete', phase: 'implement', at: iso(NOW - 3 * MIN), author: `${tool}-a`, tool }], ...extra });
const off = (tool, extra = {}) => ({ tool, shape: 'disabled', rule: null, until: null, phases: null, at: iso(NOW - 30 * DAY), by: '대표', excerpt: '', ...extra });
const card = (result) => result.suggestions[0];

async function startServer(t, root, extra = {}) {
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000, executeWorker: async () => { throw new Error('no AI'); },
    executeJudge: async () => { throw new Error('no AI'); }, ...extra });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body = {}, headers = { 'x-chat-token': token }) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, port, token, post, get: async (path) => (await fetch(base + path)).json() };
}


test('disabled tool: demoted to last even as the recipe or judged tool, never auto-launched, skipped by the judge default, counted as unavailable for review', () => {
  const health = [off('codex')];
  const choice = pickWorkerTool({ feature: feature('design'), phase: 'design', tools: ['codex', 'claude'], health, recipeTool: 'codex' });
  assert.deepEqual([choice.tool, choice.tools, choice.recipe, choice.demoted], ['claude', ['claude', 'codex'], undefined, ['codex']]);
  const start = card(nextActions({ goal: goal({ recipe: { id: 'r', title: '레시피', workers: { design: 'codex' } } }), now: NOW, tools: ['codex', 'claude'], features: [feature('design')], health }));
  assert.deepEqual([start.kind, start.tool, start.autoTool], ['start-worker', 'claude', 'claude']);
  assert.match(start.healthNote, /쓰지 않기: Codex\(대표이\(가\) .*에 켬, 사람이 끌 때까지\)/);
  assert.match(start.options.find((item) => item.id === 'codex').warning, /쓰지 않기: Codex/);
  const prefer = [{ kind: 'judge-proposal', outcome: 'executed', judgment: 'block', feature: 'f1', phase: 'plan', iteration: 0, decision: { action: 'retry', task: 't-1', tool: 'codex', prefer: { tool: 'codex', avoid: null } }, at: iso(NOW - 30 * MIN) }];
  assert.equal(card(nextActions({ goal: goal(), now: NOW, tools: ['codex', 'claude'], features: [feature('design')], health, decisions: prefer })).tool, 'claude');
  const alone = card(nextActions({ goal: goal(), now: NOW, tools: ['codex'], features: [feature('design')], health }));
  assert.deepEqual([alone.tool, alone.autoTool, autoRule(alone)], ['codex', null, null]);
  assert.match(alone.reason, /쓰지 않기로 되어 있습니다/);
  assert.equal(judgeToolFor(goal(), ['codex', 'claude'], health).tool, 'claude');
  const blockedTask = { id: 't-000001-aaaaaa', feature: 'f1', to: 'wax-worker-claude', phase: 'design', status: 'blocked', at: iso(NOW - 4 * MIN), statusAt: iso(NOW - 3 * MIN), updates: [{ status: 'blocked', at: iso(NOW - 3 * MIN), note: '막힘' }] };
  const judge = nextActions({ goal: goal({ judgeTool: 'codex' }), now: NOW, tools: ['codex', 'claude'], features: [feature('design')], tasks: [blockedTask], health }).suggestions.find((item) => item.kind === 'judge');
  assert.deepEqual([judge.tool, judge.unhealthy, autoRule(judge)], ['codex', true, null]);
  const self = card(nextActions({ goal: goal(), now: NOW, tools: ['claude', 'codex'], features: [implemented('claude')], health }));
  assert.deepEqual([self.kind, self.tool, self.tools, self.executable], ['self-review', null, ['codex'], true]);
  assert.equal(healthFor([{ tool: 'codex', shape: 'quota', at: iso(NOW) }, off('codex')], 'codex', 'design').shape, 'disabled');
});

test('disabled tool: no success, retry, until or 24 hours clears it; only a person turning it off does; every change records who and when', async (t) => {
  const root = await project(t);
  assert.deepEqual(disabledTools(await readToolSwitches(root)), []);
  await assert.rejects(setToolDisabled(root, 'grok', true, { author: '대표' }), (error) => error.status === 400);
  await assert.rejects(setToolDisabled(root, 'codex', 'yes', { author: '대표' }), (error) => error.status === 400);
  await assert.rejects(setToolDisabled(root, 'codex', true, {}), /작성자|author/i);
  const on = await setToolDisabled(root, 'codex', true, { author: '대표', now: NOW });
  assert.deepEqual([on.changed, on.disabled], [true, true]);
  assert.deepEqual((await setToolDisabled(root, 'codex', true, { author: '대표', now: NOW + MIN })).changed, false, 'already on: nothing written');
  await noteToolRun(root, { tool: 'codex', phase: 'implement', ok: true, source: 'worker', now: NOW + HOUR });
  assert.equal((await retryTool(root, 'codex', { author: '대표', now: NOW + HOUR })).released, 0);
  const later = await pmLoopOverview(root, { user: '대표', tools: ['codex', 'claude'], now: NOW + 40 * DAY });
  assert.deepEqual(later.toolSwitches.map((item) => [item.tool, item.disabled, item.by]), [['codex', true, '대표'], ['claude', false, undefined]]);
  assert.deepEqual(later.toolHealth, [], 'a switch is not a failure (no Retry for it)');
  const offed = await setToolDisabled(root, 'codex', false, { author: '부대표', now: NOW + 41 * DAY });
  assert.equal(offed.changed, true);
  assert.deepEqual(disabledTools(await readToolSwitches(root)), []);
  const records = await readToolSwitches(root);
  assert.deepEqual(records.map((item) => [item.tool, item.disabled, item.by, item.at]), [['codex', true, '대표', iso(NOW)], ['codex', false, '부대표', iso(NOW + 41 * DAY)]]);
  assert.ok((await readdir(join(root, '.wax', 'chat'))).includes('tool-disabled.jsonl'));
});

test('disabled tool: the dashboard endpoint needs the token, the same Host and Origin; wax doctor shows it; judgment input lists it as unavailable', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const tools = async () => [{ id: 'codex', label: 'Codex', installed: true, approval: 'dashboard' }, { id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }];
  const { post, port, token, get } = await startServer(t, root, { requestTools: tools });
  assert.equal((await post('/api/tool-health/codex/disabled', { disabled: true }, {})).status, 403, 'no token');
  assert.equal((await post('/api/tool-health/codex/disabled', { disabled: true }, { 'x-chat-token': token, origin: 'http://evil.example' })).status, 403, 'other origin');
  const otherHost = await new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/tool-health/codex/disabled', method: 'POST', headers: { host: `evil.example:${port}`, 'content-type': 'application/json', 'x-chat-token': token } }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ disabled: true }));
  });
  assert.equal(otherHost, 403, 'other host');
  assert.equal((await post('/api/tool-health/codex/disabled', { disabled: true }, { 'x-chat-token': token, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
  assert.deepEqual(await readToolSwitches(root), [], 'nothing written by refused requests');
  assert.equal((await post('/api/tool-health/codex/disabled', { disabled: 'on' })).status, 400);
  assert.equal((await post('/api/tool-health/grok/disabled', { disabled: true })).status, 400);
  const done = await post('/api/tool-health/codex/disabled', { disabled: true });
  assert.equal(done.status, 200);
  assert.deepEqual([(await done.json()).changed, (await readToolSwitches(root))[0].by], [true, '대표']);
  const view = await get('/api/pm-loop');
  assert.deepEqual(view.toolSwitches.map((item) => [item.tool, item.disabled]), [['codex', true], ['claude', false]]);
  const doctor = (await diagnoseProject(root, { readVersion: async () => null })).toolHealth.tools.find((item) => item.tool === 'codex');
  assert.deepEqual([doctor.state, doctor.by], ['disabled', '대표']);
  assert.match(doctor.line, /쓰지 않기: Codex\(대표이\(가\)/);
  assert.match((await toolHealthLines(root)).tools.find((item) => item.tool === 'claude').line, /최근 고정 실패 없음/);
  const g = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  const report = await judgmentInput(root, { goal: g.id, judgment: 'report', tools: ['codex', 'claude'] });
  assert.deepEqual(report.data.unavailableTools.map((item) => [item.tool, item.shape]), [['codex', 'disabled']]);
  assert.match(report.data.unavailableTools[0].note, /쓰지 않기/);
  assert.equal((await (await post('/api/tool-health/codex/disabled', { disabled: false })).json()).changed, true);
  assert.deepEqual((await get('/api/pm-loop')).toolSwitches.map((item) => item.disabled), [false, false]);
});

test('disabled tool: a worker cannot flip it from the CLI; only the dashboard server writes the switch', async (t) => {
  const root = await project(t);
  const run = (args) => new Promise((done) => {
    const child = spawn(process.execPath, [BIN, '--project', root, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WAX_LANG: 'ko' } });
    child.on('close', (code) => done(code));
  });
  for (const args of [['tool-health', 'disable', 'codex'], ['tool', 'disable', 'codex'], ['doctor', '--disable', 'codex']]) assert.notEqual(await run(args), 0, args.join(' '));
  assert.deepEqual(await readToolSwitches(root), []);
  const callers = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.mjs') && /setToolDisabled/.test(await readFile(path, 'utf8')) && !path.endsWith('tool-health.mjs')) callers.push(path.slice(SRC.length).split(sep).join('/'));
    }
  };
  await walk(SRC);
  for (const file of ['../bin/wax.mjs', '../bin/wax-approval-hook.mjs']) {
    const text = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8').catch(() => '');
    assert.doesNotMatch(text, /setToolDisabled|tool-disabled/, file);
  }
  assert.deepEqual(callers, ['chat/server.mjs']);
});


test('review default: on a fresh .wax, with only Antigravity CLI (command-risk warning) besides the implementer, the first review card is self-review', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const engine = createPmLoop({ root, execute: async () => { throw new Error('no AI'); }, listTools: async () => ['claude', 'antigravity'].map((id) => ({ id, installed: true, approval: 'dashboard' })), user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const g = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  for (const [phase, content] of [['plan', '- AC-1: 된다'], ['design', 'design'], ['implement', 'impl']]) {
    await updateFeature(root, 'f1', 'save', { phase, content });
    await updateFeature(root, 'f1', 'complete', { phase, evidence: 'x', author: 'wax-worker-claude', tool: 'claude', ...(phase === 'implement' ? { waiver: '테스트용' } : {}) });
  }
  assert.ok(!(await readdir(join(root, '.wax', 'chat'))).includes('tool-health.jsonl'), 'no remembered failure');
  const view = await goalOverview(root, g.id, { user: '대표', tools: await engine.tools() });
  const self = view.suggestions.find((item) => item.phase === 'review');
  assert.deepEqual([self.kind, self.tool, self.tools, autoRule(self)], ['self-review', null, ['antigravity'], null]);
  assert.match(self.reason, /headless에서 명령 실행을 거부할 수 있습니다/);
  assert.match(self.options[0].warning, /permissions\.allow/);
  await assert.rejects(executeSuggestion(root, g.id, self.key, { author: '대표', tools: await engine.tools(), workers: engine.workers }), /고를 수 없습니다/);
  assert.equal(card(nextActions({ goal: goal(), now: NOW, tools: ['claude', 'antigravity', 'codex'], features: [implemented('claude')] })).kind, 'start-worker');
  assert.equal(card(nextActions({ goal: goal(), now: NOW, tools: ['claude', 'antigravity'], features: [feature('design')] })).kind, 'start-worker');
});


test('builtin recipes suggest the wax, test and write allowances; starting from one still turns nothing on', async (t) => {
  const root = await project(t);
  for (const id of ['bugfix', 'feature', 'refactor']) {
    const entry = await getRecipe(root, id);
    assert.deepEqual(entry.recipe.allow, ['wax', 'test', 'write'], id);
    assert.deepEqual(fillRecipe(entry.recipe, { input: '로그인 끊김', slug: 'login' }).allow, ['wax', 'test', 'write'], `${id} hands the suggestion to the start screen`);
  }
  const { post, get } = await startServer(t, root, { requestTools: async () => [] });
  const filled = await get('/api/recipes/bugfix/fill?input=session%20drops');
  assert.deepEqual(filled.allow, ['wax', 'test', 'write']);
  const created = await post('/api/pm-loop', { recipe: { id: 'bugfix', hash: filled.hash, input: filled.input, slug: filled.slug }, title: filled.title, tasks: filled.tasks, workers: {}, judgeTool: null, budgets: filled.budgets });
  assert.equal(created.status, 201);
  const goalView = await created.json();
  assert.deepEqual([goalView.allow.on, goalView.allow.kinds], [false, []], 'the suggestion is never a switch');
});


test('self-review card: the person\'s test command fills the wax test line, and the checks file shape is shown per AC', async (t) => {
  const plan = '- AC-1: 재현 테스트가 고치기 전에 실패한다\n- AC-2: 기존 테스트가 통과한다\n';
  const self = card(nextActions({ goal: goal(), now: NOW, tools: ['claude'], features: [implemented('claude', { artifacts: { plan } })], user: '대표', testCommand: 'node --test' }));
  assert.equal(self.commands[1], 'wax test f1 -- node --test');
  assert.equal(self.checksFile, '.wax/tmp/review-checks-f1.json');
  const example = JSON.parse(self.checksExample);
  assert.deepEqual(example.map((item) => [item.id, item.status]), [['ac-1', 'pass'], ['ac-2', 'pass']]);
  for (const item of example) { assert.match(item.id, AC_CHECK); assert.deepEqual(Object.keys(item), ['id', 'status', 'detail', 'proofIds']); }
  const plain = card(nextActions({ goal: goal(), now: NOW, tools: ['claude'], features: [implemented('claude')] }));
  assert.deepEqual([plain.commands[1], plain.checksExample, plain.checksFile], ['wax test f1 -- <test-command>', undefined, undefined]);
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const { post, get } = await startServer(t, root, { requestTools: async () => [{ id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }] });
  const created = await (await post('/api/pm-loop', { title: '목표', features: ['f1'], allow: { kinds: [], test: 'npm test -- --grep sum' } })).json();
  assert.equal(created.allow.on, false);
  await executeSuggestion(root, created.id, 'goal:confirm-plan', { author: '대표' });
  for (const [phase, content] of [['plan', plan], ['design', 'design'], ['implement', 'impl']]) {
    await updateFeature(root, 'f1', 'save', { phase, content });
    await updateFeature(root, 'f1', 'complete', { phase, evidence: 'x', author: 'wax-worker-claude', tool: 'claude', ...(phase === 'implement' ? { waiver: '테스트용' } : {}) });
  }
  const view = await get(`/api/pm-loop/${created.id}`);
  const dashboardCard = view.suggestions.find((item) => item.kind === 'self-review');
  assert.equal(dashboardCard.commands[1], 'wax test f1 -- npm test -- --grep sum');
  assert.ok(dashboardCard.checksExample);
  const stored = await readFile(join(root, '.wax', 'chat', 'pm-loop', `${created.id}.json`), 'utf8');
  assert.doesNotMatch(stored, /--grep sum/);
});

test('report judgment input: each context says who completed each phase (completed.review.author) and whether it was a wax worker', async (t) => {
  assert.deepEqual(completedBy({ completed: { implement: { at: 'a', author: 'wax-worker-claude' }, review: { at: 'b', author: '대표', verdict: 'pass' } } }),
    { implement: { author: 'wax-worker-claude', at: 'a', worker: true }, review: { author: '대표', at: 'b', verdict: 'pass', worker: false } });
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const g = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, g.id, 'goal:confirm-plan', { author: '대표' });
  for (const [phase, author] of [['plan', 'wax-worker-claude'], ['design', 'wax-worker-claude'], ['implement', 'wax-worker-claude'], ['review', '대표']]) {
    await updateFeature(root, 'f1', 'save', { phase, content: phase });
    await updateFeature(root, 'f1', 'complete', { phase, evidence: 'x', author, ...(author === '대표' ? {} : { tool: 'claude' }), ...(['implement', 'review'].includes(phase) ? { waiver: '테스트용' } : {}), ...(phase === 'review' ? { verdict: 'pass' } : {}) });
  }
  const input = await judgmentInput(root, { goal: g.id, judgment: 'report', tools: ['claude'] });
  const context = input.data.contexts.find((item) => item.feature === 'f1');
  assert.deepEqual([context.completed.review.author, context.completed.review.worker, context.completed.implement.worker], ['대표', false, true]);
});
