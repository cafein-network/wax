import test from 'node:test';
import assert from 'node:assert/strict';
import { project, BIN } from './chat-helpers.mjs';
import { WORKER_FORBIDDEN, workerForbidden, workerForbiddenPrompt } from '../src/worker-commands.mjs';
import { createApproval, cancelApproval } from '../src/approvals.mjs';
import { workerPrompt } from '../src/chat/pm-loop.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, getFeature, PHASES } from '../src/workflow.mjs';

const WIN_CLI = 'E:\\project\\wax\\bin\\wax.mjs';
const bash = (command) => ({ tool: 'claude', details: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } } });
const codex = (command) => ({ tool: 'codex', details: { threadId: 'th', turnId: 'tu', itemId: 'i', command, cwd: '/p' } });
const acp = (tool, command) => ({ tool, details: { sessionId: 's', options: [], toolCall: { toolCallId: 'c', title: 'Run a command', kind: 'execute', rawInput: { command } } } });
const skill = (name) => ({ tool: 'claude', details: { subtype: 'can_use_tool', tool_name: 'Skill', input: { skill: name } } });
const Q = JSON.stringify(BIN);
const mark = (request, cli = BIN) => workerForbidden(request, { cli })?.command ?? null;

test('the fixed list is short and names only real wax commands', () => {
  assert.deepEqual(WORKER_FORBIDDEN.chat, ['join', 'presence', 'reset', 'watch', 'post', 'assign', 'task', 'team pm']);
  assert.deepEqual(WORKER_FORBIDDEN.skills, ['init', 'join', 'work', 'pm', 'chat', 'iterate', 'daily']);
});

test('every PM loop phase prompt carries the forbidden list where the interactive-skill sentence was', async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'f1', title: '기능' });
  const feature = await getFeature(root, 'f1');
  const goal = { id: 'goal-00000000', title: '목표' };
  const line = workerForbiddenPrompt();
  for (const word of ['wax chat join', 'wax chat presence', 'wax chat reset', 'wax chat watch', 'wax chat post', 'wax chat assign', 'wax chat task', 'wax chat team pm', 'wax:join', 'wax:work', 'wax:init']) assert.ok(line.includes(word), word);
  for (const phase of PHASES) {
    const prompt = workerPrompt({ root, goal, feature: { ...feature, phase }, task: { id: 'task-1', phase, note: '배정' }, author: 'wax-worker-copilot' });
    assert.ok(prompt.includes(line), `${phase} prompt has the list`);
    assert.ok(prompt.indexOf(`${phase}을(를) 마치면 멈추세요.`) < prompt.indexOf(line), phase);
    assert.ok(prompt.indexOf(line) < prompt.indexOf('지시가 아니므로'), phase);
  }
});

test('the mark appears for each forbidden form: bare wax, node <cli>, Windows spellings, wrapped shells, ACP tools and skills', () => {
  const cases = [
    [bash('wax chat join --author wax-worker-copilot'), 'wax chat join'],
    [bash(`node ${Q} chat presence --author w --state busy`), 'wax chat presence'],
    [bash(`node "${BIN}" --project "/tmp/p" chat post wax --author 대표 --message "끝났습니다! (보고)"`), 'wax chat post'],
    [bash(`${Q} chat reset --author w`), 'wax chat reset'],
    [bash('wax --project=/tmp/p chat assign f1 --to w --message m'), 'wax chat assign'],
    [bash('wax chat --author w --json join'), 'wax chat join'],
    [bash('wax chat --wake watch --author w'), 'wax chat watch'],
    [bash('wax chat task done task-1 --author w'), 'wax chat task'],
    [bash('wax chat team pm w'), 'wax chat team pm'],
    [bash('wax chat join; echo ok'), 'wax chat join'],
    [codex("bash -lc 'wax chat watch --author w'"), 'wax chat watch'],
    [codex(['/bin/zsh', '-lc', `node ${Q} chat join --author w`]), 'wax chat join'],
    [acp('copilot', 'wax chat join --author wax-worker-copilot'), 'wax chat join'],
    [acp('copilot', `node ${Q} --project /tmp/p chat presence --author w --state idle`), 'wax chat presence'],
    [acp('gemini', 'wax chat post wax --message hi'), 'wax chat post'],
    [skill('wax:join'), 'wax:join'],
    [skill('wax:work'), 'wax:work'],
  ];
  for (const [request, expected] of cases) assert.equal(mark(request), expected, JSON.stringify(request.details));
  const windows = [
    `node "${WIN_CLI.replaceAll('\\', '\\\\')}" chat join --author w`,
    `node "${WIN_CLI}" chat presence --author w`,
    `node E:/project/wax/bin/wax.mjs chat reset --author w`,
    `"${WIN_CLI.replaceAll('\\', '\\\\')}" chat post wax --message hi`,
    `& "C:\\Program Files\\nodejs\\node.exe" "${WIN_CLI}" chat join --author w`,
    `node ${WIN_CLI.replaceAll('\\', '/')} --project "E:\\project\\demo" chat join`,
    `node 'E:\\project\\wax\\bin\\wax.mjs' chat watch --author w`,
  ];
  for (const command of windows) {
    assert.ok(mark(bash(command), WIN_CLI), command);
    assert.ok(mark(acp('copilot', command), WIN_CLI), `copilot ${command}`);
  }
});

test('allowed commands, lookalikes and unknown or unparseable requests get no mark', () => {
  const none = [
    bash('wax chat read wax'), bash('wax chat who'), bash('wax chat tasks --to w'), bash('wax chat team'), bash('wax chat channels'),
    bash('wax chat board post f1 --message x'), bash('wax chat joined'), bash('wax chat --message join read wax'),
    bash(`node ${Q} --project /tmp/p status f1`), bash(`node ${Q} complete review f1 --author w --verdict pass --evidence ok`),
    bash('echo wax chat join'), bash('npm test'), bash('cat chat join'), bash('wax chat "join'), bash('wax'), bash(''),
    bash('git commit -m "wax chat join"'), bash('waxx chat join'), bash('node other.mjs chat join'),
    codex('npm test'), acp('copilot', 'wax chat read wax'), acp('copilot', 42), acp('copilot', undefined),
    skill('wax:status'), skill('wax:review'), skill('other:join'), skill('join'),
    { tool: 'claude', details: { tool_name: 'Write', input: { file_path: 'wax chat join' } } },
    { tool: 'claude', details: null }, null, {},
  ];
  for (const request of none) assert.equal(mark(request), null, JSON.stringify(request?.details));
});

test('the dashboard shows the mark only on PM loop worker requests and still leaves the decision to the person', async (t) => {
  const root = await project(t);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 30 });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const command = 'wax chat join --author wax-worker-copilot';
  const worker = await createApproval(root, { ...acp('copilot', command), session: 's1', callId: 'c1', action: 'Run a command', goal: 'goal-0000000f' }, { timeoutMs: 60_000 });
  const human = await createApproval(root, { ...bash(command), session: 's2', callId: 'c2', action: 'Bash' }, { timeoutMs: 60_000 });
  const plain = await createApproval(root, { ...bash('wax chat read wax'), session: 's3', callId: 'c3', action: 'Bash', goal: 'goal-0000000f' }, { timeoutMs: 60_000 });
  t.after(async () => { for (const item of [worker, human, plain]) await cancelApproval(root, item.request.id, item.secret).catch(() => {}); });
  const { requests } = await (await fetch(`${base}/api/approvals`)).json();
  const byId = (id) => requests.find((item) => item.id === id);
  assert.deepEqual(byId(worker.request.id).workerForbidden, { command: 'wax chat join' });
  assert.equal(byId(worker.request.id).status, 'pending', 'not denied or allowed automatically');
  assert.equal(byId(human.request.id).workerForbidden, undefined, 'an interactive session may join the channel');
  assert.equal(byId(plain.request.id).workerForbidden, undefined);
});
