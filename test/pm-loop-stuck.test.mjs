import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BIN, project } from './chat-helpers.mjs';
const run = promisify(execFile);
import {
  REPEAT_LIMITS, STUCK_CHECK, approvalRepeatKey, createRepeatCounter, createStuckWatch, failedTestRepeats, normalizeTestOutput, stuckCheckMode, testRepeatKey,
} from '../src/chat/stuck-check.mjs';
import {
  BUDGET_RANGE, DEFAULT_BUDGETS, WORKER_END, budgetUsage, createGoal, createPmLoop, evaluateGoals, executeSuggestion, featureDecisions, goalOverview, judgmentInput,
  normalizeBudgets, readDecisions,
} from '../src/chat/pm-loop.mjs';
import { listTasks, setPm } from '../src/chat/team.mjs';
import { createApproval, decideApproval, listApprovals } from '../src/approvals.mjs';
import { handleCodexApproval } from '../src/approval-hosts.mjs';
import { runAgentSession } from '../src/agent-session.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { getFeature } from '../src/workflow.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { FAILURE_SHAPES } from '../src/tool-failures.mjs';
import { healthFor } from '../src/chat/tool-health.mjs';
import { buildRunTrace, renderTraceMarkdown } from '../src/run-trace.mjs';

const HEAD = 'a'.repeat(40);
const tree = (blob = 'b'.repeat(40), extra = {}) => ({ head: HEAD, files: { 'src/sum.js': blob, ...extra } });
const proof = (output, extra = {}) => ({ id: extra.id ?? 'p1', kind: 'test', command: ['npm', 'test'], exitCode: 1, timedOut: false, output, tree: tree(), author: 'wax-worker-claude', at: '2026-11-03T10:00:00.000Z', ...extra });


test('test key: durations, temp paths and the project path are normalised; exit code, command and passing runs are not the same failure', () => {
  const root = '/work/my-app';
  const one = `FAIL test/a.test.js (512 ms)\n  at ${root}/src/sum.js:10:5\n  wrote ${tmpdir()}/wax-a1b2c3/out.txt\n  Expected 3, received 4\nTests: 1 failed, 4 passed\nTime: 1.234 s`;
  const two = `FAIL test/a.test.js (37 ms)\n  at ${root}/src/sum.js:12:9\n  wrote ${tmpdir()}/wax-zz99qq/out.txt\n  Expected 3, received 4\nTests: 1 failed, 4 passed\nTime: 0.2 s`;
  assert.equal(normalizeTestOutput(one, { roots: [root] }), normalizeTestOutput(two, { roots: [root] }));
  assert.doesNotMatch(normalizeTestOutput(one, { roots: [root] }), /my-app|wax-a1b2c3|\d{2,}/);
  assert.equal(normalizeTestOutput(`at /a/b/src/x.js:1`, { roots: ['/a/b'] }), normalizeTestOutput(`at /c/d/src/x.js:2`, { roots: ['/c/d'] }));
  assert.equal(normalizeTestOutput('/tmp/vitest-x1y2/a.js'), normalizeTestOutput('/tmp/vitest-q7r8/a.js'));
  assert.equal(normalizeTestOutput('/private/var/folders/ab/cd12/T/jest_x/a.js'), normalizeTestOutput('/var/folders/zz/yy34/T/jest_q/a.js'));
  assert.equal(normalizeTestOutput('C:\\Users\\me\\AppData\\Local\\Temp\\wax-1\\a.js'), normalizeTestOutput('C:\\Users\\you\\AppData\\Local\\Temp\\wax-2\\a.js'));
  assert.equal(normalizeTestOutput(`${'a'.repeat(5000)}END`).length, REPEAT_LIMITS.tail);
  assert.equal(normalizeTestOutput(`x${'b'.repeat(2500)}`), normalizeTestOutput(`y${'b'.repeat(2500)}`), 'what lies before the last 2000 characters is ignored');

  const key = testRepeatKey(proof(one), { roots: [root] });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(testRepeatKey(proof(two, { id: 'p2', at: '2026-11-03T11:00:00.000Z' }), { roots: [root] }), key, 'id and time are not part of the key');
  assert.notEqual(testRepeatKey(proof(one, { exitCode: 2 }), { roots: [root] }), key, 'a different exit code is a different failure');
  assert.notEqual(testRepeatKey(proof(one, { command: ['npm', 'run', 'e2e'] }), { roots: [root] }), key);
  assert.notEqual(testRepeatKey(proof(one, { timedOut: true, exitCode: null }), { roots: [root] }), key);
  assert.notEqual(testRepeatKey(proof('Expected sum to be three'), { roots: [root] }), testRepeatKey(proof('Expected sum to be four'), { roots: [root] }), 'different words are different');
  assert.notEqual(testRepeatKey(proof('Expected 3, received 4')), testRepeatKey(proof('Expected 3, received 5')), 'different assertion values are different');
  assert.equal(testRepeatKey(proof(one, { exitCode: 0 }), { roots: [root] }), null, 'a passing run is never counted');
  assert.equal(testRepeatKey({ kind: 'git', commit: 'x' }), null);
  assert.match(testRepeatKey(proof('hang', { exitCode: null, timedOut: true })), /^[a-f0-9]{64}$/);
});

const nodeTestFailure = (root, message, { ms = 168.42, total = 171.9, line = 23 } = {}) => [
  `✔ formats cents (1.02ms)`, `✖ totals an invoice (${ms}ms)`, 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 1', 'ℹ fail 1', `ℹ duration_ms ${total}`, '', '✖ failing tests:', '',
  'test at test/invoice.test.js:5:1', `✖ totals an invoice (${ms}ms)`, `  AssertionError [ERR_ASSERTION]: ${message}`,
  `      at TestContext.<anonymous> (file://${root}/test/invoice.test.js:${line}:10)`, '      at Test.runInAsyncScope (node:async_hooks:226:14)',
  '      at Test.run (node:internal/test_runner/test:1402:25)', "    code: 'ERR_ASSERTION',", `    actual: ${message.split(' !== ')[0]},`].join('\n');

test('test key: the measured invoice sequence (different assertion values on different code) is never one repeat', () => {
  const root = '/work/invoice';
  const steps = [['505 !== 6493', 'c'], ['5908 !== 6493', 'd'], ['6492 !== 6493', 'e']];
  const proofs = steps.map(([message, blob], index) => proof(nodeTestFailure(root, `Expected values to be strictly equal:\n\n${message}\n`, { ms: 160 + index, total: 170 + index }),
    { id: `p${index}`, tree: tree(blob.repeat(40)), command: ['node', '--test'] }));
  const keys = proofs.map((item) => testRepeatKey(item, { roots: [root] }));
  assert.equal(new Set(keys).size, 3, 'three real fixes are three different failures');
  assert.equal(failedTestRepeats(proofs, { author: 'wax-worker-claude', roots: [root] }).size, 3);
  assert.notEqual(testRepeatKey({ ...proofs[0], tree: tree('f'.repeat(40)) }, { roots: [root] }), keys[0]);
  assert.notEqual(testRepeatKey({ ...proofs[1], tree: proofs[0].tree }, { roots: [root] }), keys[0]);
});

test('test key: the same code and the same failure is one key whatever the durations, temp folders, project folder, stack positions, times, pids and ports', () => {
  const run = (root, n) => proof([nodeTestFailure(root, '505 !== 6493', { ms: 100 + n * 37.5, total: 900 + n * 11.25 }),
    `wrote ${tmpdir()}/wax-${n}x${n}/report.json at 2026-11-0${n + 1}T10:0${n}:00.${n}12Z (${1762160000000 + n * 987}) [10:0${n}:3${n}.4${n}]`,
    `server pid ${4000 + n} listening on http://127.0.0.1:${50000 + n} and [::1]:${51000 + n}`, `"durationMs": ${n * 3 + 1}, elapsed: ${n}.5`, `took ${n + 1}.2 s / ${n * 400 + 7}µs`].join('\n'),
  { id: `r${n}`, command: ['node', '--test'] });
  const a = testRepeatKey(run('/work/a', 1), { roots: ['/work/a'] });
  const b = testRepeatKey(run('/work/a', 2), { roots: ['/work/a'] });
  const c = testRepeatKey(run('/elsewhere/b', 3), { roots: ['/elsewhere/b'] });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(normalizeTestOutput('at file:///p/test/a.js:23:10', { roots: ['/p'] }), 'at file://<project>/test/a.js:<pos>');
  assert.equal(normalizeTestOutput('test at test/a.js:17:1'), 'test at test/a.js:17:1');
  assert.equal(normalizeTestOutput('ℹ duration_ms 818.953958\n✖ slow (361.648833ms)'), 'ℹ duration_ms <duration>\n✖ slow (<duration>)');
  assert.equal(normalizeTestOutput('Expected 200, received 503 · 24 rows · tests 2 · 6492 !== 6493'), 'Expected 200, received 503 · 24 rows · tests 2 · 6492 !== 6493');
});

test('test key: the measured perf sequence (faster each time on changed code) is not a repeat; the same slow code three times is', () => {
  const root = '/work/perf';
  const slow = (ms) => nodeTestFailure(root, `buildReport took ${ms} ms for 24 rows (budget 40 ms). Avoid repeated work per row.`, { ms: ms * 1.1, total: ms * 2.3 });
  const changed = [[5593.3, 'c'], [1078.2, 'd'], [361.4, 'e']].map(([ms, blob], index) => proof(slow(ms), { id: `c${index}`, tree: tree(blob.repeat(40)), command: ['node', '--test'] }));
  assert.equal(failedTestRepeats(changed, { author: 'wax-worker-claude', roots: [root] }).size, 3, 'each code change is a different failure');
  const same = [1078.2, 1088.9, 1101.4].map((ms, index) => proof(slow(ms), { id: `s${index}`, command: ['node', '--test'] }));
  const groups = [...failedTestRepeats(same, { author: 'wax-worker-claude', roots: [root] }).values()];
  assert.deepEqual(groups.map((item) => item.count), [3]);
});

test('test key: a proof without a usable tree fingerprint is never counted (no Git, unknown or malformed tree)', () => {
  for (const missing of [undefined, null, { head: HEAD, unknown: true }, { head: null, unknown: true }, { head: 'nope', files: {} }, { head: HEAD, files: [] }, { head: HEAD }, 'tree']) {
    assert.equal(testRepeatKey(proof('Expected 3, received 4', { tree: missing })), null, JSON.stringify(missing));
  }
  const proofs = ['a', 'b', 'c'].map((id) => proof('Expected 3, received 4', { id, tree: undefined }));
  assert.equal(failedTestRepeats(proofs, { author: 'wax-worker-claude' }).size, 0, 'three identical failures without a tree are not grouped');
  assert.match(testRepeatKey(proof('x', { tree: { head: null, files: { 'a.js': 'c'.repeat(40) } } })), /^[a-f0-9]{64}$/);
  assert.match(testRepeatKey(proof('x', { tree: { head: HEAD, files: {} } })), /^[a-f0-9]{64}$/);
  const ab = { head: HEAD, files: { 'a.js': 'c'.repeat(40), 'b.js': null } }, ba = { head: HEAD, files: { 'b.js': null, 'a.js': 'c'.repeat(40) } };
  assert.equal(testRepeatKey(proof('x', { tree: ab })), testRepeatKey(proof('x', { tree: ba })));
  assert.notEqual(testRepeatKey(proof('x', { tree: ab })), testRepeatKey(proof('x', { tree: { head: HEAD, files: { 'a.js': 'c'.repeat(40) } } })));
  assert.notEqual(testRepeatKey(proof('x', { tree: ab })), testRepeatKey(proof('x', { tree: { ...ab, head: 'd'.repeat(40) } })), 'a new commit is different code');
});

test('runTestProof records the tree the key reads: untracked and changed files move it, .wax/ does not', async (t) => {
  const root = await project(t, ['f1']);
  await run('git', ['init', '-q'], { cwd: root });
  const fail = [process.execPath, '-e', "console.error('Expected 3, received 4'); process.exit(1)"];
  const key = async () => testRepeatKey((await runTestProof(root, 'f1', fail, {})).proof, { roots: [root] });
  const first = await key();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await key(), first, 'a proof written under .wax/ is not a code change');
  await writeFile(join(root, 'sum.js'), 'module.exports = 1;\n');
  const untracked = await key();
  assert.notEqual(untracked, first, 'a new untracked file is a different tree');
  await writeFile(join(root, 'sum.js'), 'module.exports = 2;\n');
  assert.notEqual(await key(), untracked, 'an edited file is a different tree');
});

test('test repeats: only failed proofs by this worker after its run started are grouped', () => {
  const since = Date.parse('2026-11-03T10:00:00.000Z');
  const at = (minutes) => new Date(since + minutes * 60_000).toISOString();
  const proofs = [
    proof('same', { id: 'before', at: at(-1) }),
    proof('same', { id: 'person', at: at(1), author: '대표' }),
    proof('same', { id: 'other', at: at(1), author: 'wax-worker-codex' }),
    proof('same', { id: 'pass', at: at(1), exitCode: 0 }),
    proof('same', { id: 'a', at: at(1) }), proof('other text', { id: 'b', at: at(2) }), proof('same', { id: 'c', at: at(3) }),
  ];
  const groups = failedTestRepeats(proofs, { author: 'wax-worker-claude', since });
  assert.deepEqual([...groups.values()].map((item) => [item.count, item.proofIds]), [[2, ['a', 'c']], [1, ['b']]]);
  const [first] = groups.values();
  assert.deepEqual([first.kind, first.command, first.exitCode], ['test', 'npm test', 1]);
  assert.match(first.key, /^[a-f0-9]{64}$/);
});

test('mode: WAX_STUCK_CHECK is warn by default, accepts warn|stop|off and refuses other values', () => {
  assert.deepEqual(STUCK_CHECK, ['warn', 'stop', 'off']);
  assert.equal(stuckCheckMode(undefined), 'warn');
  assert.equal(stuckCheckMode(''), 'warn');
  for (const value of STUCK_CHECK) assert.equal(stuckCheckMode(value), value);
  assert.throws(() => stuckCheckMode('enforce'), /WAX_STUCK_CHECK/);
});

test('limit: repeats is a goal limit (default 3, 2-10); old goals without it read the default', () => {
  assert.equal(DEFAULT_BUDGETS.repeats, 3);
  assert.deepEqual(BUDGET_RANGE.repeats, [2, 10]);
  assert.equal(normalizeBudgets({}).repeats, 3);
  assert.equal(normalizeBudgets({ repeats: 2 }).repeats, 2);
  assert.equal(normalizeBudgets({ repeats: 10 }).repeats, 10);
  assert.throws(() => normalizeBudgets({ repeats: 1 }), /repeats/);
  assert.throws(() => normalizeBudgets({ repeats: 11 }), /repeats/);
  assert.equal(normalizeBudgets({}, { phaseRuns: 5 }).repeats, 3);
});

test('approval key: same tool, action and request content is the same request whatever the ids; content differences are not', () => {
  const claude = (callId, command) => ({ tool: 'claude', action: 'Bash', details: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: callId, input: { command } } });
  const key = approvalRepeatKey(claude('call-1', 'npm test'));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(approvalRepeatKey(claude('call-2', 'npm test')), key, 'a new call id is the same request');
  assert.notEqual(approvalRepeatKey(claude('call-1', 'npm run lint')), key);
  assert.notEqual(approvalRepeatKey({ ...claude('call-1', 'npm test'), action: 'Write' }), key);
  assert.notEqual(approvalRepeatKey({ ...claude('call-1', 'npm test'), tool: 'gemini' }), key);
  const codex = (itemId, command, cwd = '/p') => ({ tool: 'codex', action: '명령 실행', method: 'item/commandExecution/requestApproval', details: { threadId: `th-${itemId}`, turnId: `tu-${itemId}`, itemId, command, cwd } });
  assert.equal(approvalRepeatKey(codex('a', 'npm test')), approvalRepeatKey(codex('b', 'npm test')));
  assert.notEqual(approvalRepeatKey(codex('a', 'npm test')), approvalRepeatKey(codex('a', 'npm test', '/q')));
  const files = (itemId, diff) => ({ tool: 'codex', action: '파일 변경', method: 'item/fileChange/requestApproval', details: { threadId: 't', turnId: 'u', itemId }, item: { id: itemId, changes: [{ path: '/p/a.js', kind: { type: 'update' }, diff }] } });
  assert.equal(approvalRepeatKey(files('a', '+x')), approvalRepeatKey(files('b', '+x')));
  assert.notEqual(approvalRepeatKey(files('a', '+x')), approvalRepeatKey(files('a', '+y')));
  const acp = (sessionId, toolCallId, rawInput) => ({ tool: 'copilot', action: 'Run npm test', details: { sessionId, options: [], toolCall: { toolCallId, title: 'Run npm test', kind: 'execute', rawInput } } });
  assert.equal(approvalRepeatKey(acp('s1', 'c1', { command: 'npm test' })), approvalRepeatKey(acp('s2', 'c2', { command: 'npm test' })));
  assert.notEqual(approvalRepeatKey(acp('s1', 'c1', { command: 'npm test' })), approvalRepeatKey(acp('s1', 'c1', { command: 'ls' })));

  const counter = createRepeatCounter();
  assert.deepEqual([counter.add('a'), counter.add('a'), counter.add('b'), counter.add('a')], [1, 2, 1, 3]);
  const many = createRepeatCounter();
  let last = 0;
  for (let i = 0; i < 2100; i++) last = many.add('x');
  assert.equal(last, 2000, 'the count stays inside the record range');
});

test('approval record: validate() takes repeatKey (64 hex) and repeat (1-2000) and keeps them out of the decision fingerprint', async (t) => {
  const root = await project(t);
  const base = { tool: 'claude', session: 's', callId: 'c1', action: 'Bash', details: { input: { command: 'npm test' } } };
  const key = 'a'.repeat(64);
  const pending = await createApproval(root, { ...base, repeatKey: key, repeat: 3 }, { timeoutMs: 5000 });
  assert.deepEqual([pending.request.repeatKey, pending.request.repeat], [key, 3]);
  const plain = await createApproval(root, { ...base, callId: 'c2' }, { timeoutMs: 5000 });
  assert.equal(plain.request.repeatKey, undefined);
  assert.equal((await listApprovals(root)).issues.length, 0);
  await decideApproval(root, pending.request.id, { decision: 'deny', fingerprint: pending.request.fingerprint, actor: '대표' });
  for (const bad of [{ repeatKey: 'x' }, { repeatKey: key.toUpperCase() }, { repeatKey: key, repeat: 0 }, { repeatKey: key, repeat: 2001 }, { repeatKey: key, repeat: 1.5 }, { repeat: 2 }, { repeatKey: key }]) {
    await assert.rejects(createApproval(root, { ...base, callId: `bad-${JSON.stringify(bad).length}`, ...bad }, { timeoutMs: 5000 }), /승인 기록|approval record/i, JSON.stringify(bad));
  }
});

test('Codex worker requests carry the repeat key and count, including requests the goal allowance allowed without a person', async (t) => {
  const root = await project(t);
  const counter = createRepeatCounter();
  const goalAllow = { goal: 'goal-0000000e', check: async () => ({ allow: 'test' }), used() {}, repeat: (request) => { const repeatKey = approvalRepeatKey(request); return { repeatKey, repeat: counter.add(repeatKey) }; } };
  for (const itemId of ['i1', 'i2']) {
    const message = { id: itemId, method: 'item/commandExecution/requestApproval', params: { threadId: 'th', turnId: itemId, itemId, command: 'npm test', cwd: root } };
    assert.equal(await handleCodexApproval(root, message, { goalAllow, emit: async () => {} }), true);
  }
  const records = (await listApprovals(root)).requests.sort((a, b) => a.repeat - b.repeat);
  assert.deepEqual(records.map((item) => [item.allowKind, item.repeat]), [['test', 1], ['test', 2]]);
  assert.equal(records[0].repeatKey, records[1].repeatKey);
});


const TOOLS = ['codex', 'claude'];
const authorOf = (prompt) => prompt.match(/작업자 이름: ([^.]+)\./)[1];
const reply = (outcome, report) => ({ threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome, report }) });
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('stopped')); }, { once: true });
});
const failing = (root, text = 'Expected 3, received 4') => [process.execPath, '-e',
  `console.log('took', Date.now() % 1000, 'ms'); console.log(${JSON.stringify(root)} + '/src/sum.js:10'); console.log(require('os').tmpdir() + '/wax-' + Math.random().toString(36).slice(2) + '/x'); console.error(${JSON.stringify(text)}); process.exit(1)`];

async function setup(t, { execute, stuckCheck = 'warn', budgets, stuckPollMs = 0 } = {}) {
  const root = await project(t, ['f1']);
  await run('git', ['init', '-q'], { cwd: root });
  await setPm(root, { author: '대표', kind: 'human' });
  const listTools = async () => TOOLS.map((id) => ({ id, installed: true, approval: 'dashboard' }));
  const notes = [];
  const engine = createPmLoop({ root, execute, listTools, user: '대표', intervalMs: 10_000, stuckCheck, stuckPollMs, notify: (event, data) => notes.push([event, data]) });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '되풀이', features: ['f1'], ...(budgets ? { budgets } : {}) }, { author: '대표' });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const view = async () => goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() });
  const launch = async () => {
    const card = (await view()).suggestions.find((item) => item.kind === 'start-worker');
    assert.ok(card?.executable);
    return executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers, tool: 'claude' });
  };
  return { root, engine, goal, view, launch, notes };
}
const records = async (root, id, kind) => (await readDecisions(root, id)).filter((item) => item.kind === kind);

const repeater = (n, { text, after } = {}) => async (root, { prompt, signal, activity }) => {
  const author = authorOf(prompt);
  for (let i = 0; i < n; i++) {
    await runTestProof(root, 'f1', failing(root, typeof text === 'function' ? text(i) : text), { author });
    activity({ approvals: 0 });
    await pause(40, signal);
  }
  await after?.(root, { signal, activity });
  return reply('blocked', '검사를 통과시키지 못했습니다');
};

test('engine warn (default): the third identical failure writes one warning, shows it on the running worker, and the worker keeps going', async (t) => {
  let seen = null;
  const after = async (root, { signal }) => {
    await pause(80, signal);
    seen = (await view()).workers[0];
  };
  const { root, engine, goal, view, launch, notes } = await setup(t, { execute: repeater(4, { after }) });
  await launch();
  await engine.workers.settled();
  const [warned, ...more] = await records(root, goal.id, 'repeat');
  assert.equal(more.length, 0, 'one warning per repeated failure, not one per attempt after it');
  assert.deepEqual([warned.outcome, warned.repeat.kind, warned.repeat.count, warned.repeat.proofIds.length, warned.by], ['warned', 'test', 3, 3, 'pm-loop']);
  assert.match(warned.worker, /^pw-/);
  assert.match(warned.reason, /같은 테스트가 같은 출력으로 3번 실패했습니다/);
  assert.match(warned.reason, /node(?:\.exe)? -e/);
  assert.deepEqual(seen?.repeat && [seen.repeat.outcome, seen.repeat.count], ['warned', 3], 'the running worker row carries the warning');
  const end = (await records(root, goal.id, 'worker')).at(-1);
  assert.deepEqual([end.outcome, end.result, end.repeat], ['exited', 'blocked', undefined], 'warn never stops the worker');
  assert.ok(notes.some(([event, data]) => event === 'pm' && data.goal === goal.id));
  assert.equal((await view()).workers.length, 0);
  const pm = await featureDecisions(root, 'f1');
  assert.ok(pm.some((item) => item.kind === 'repeat' && item.outcome === 'warned'));
  const trace = await buildRunTrace(root, 'f1');
  const markdown = renderTraceMarkdown(trace);
  assert.match(markdown, /되풀이 경고/);
});

test('engine stop: the third identical failure stops the worker as stuck, blocks the task and counts once toward the failure streak', async (t) => {
  const { root, engine, goal, view, launch } = await setup(t, { execute: repeater(6), stuckCheck: 'stop' });
  await launch();
  await engine.workers.settled();
  assert.ok(WORKER_END.has('stuck'));
  const end = (await records(root, goal.id, 'worker')).at(-1);
  assert.equal(end.outcome, 'stuck');
  assert.deepEqual([end.repeat.kind, end.repeat.count, end.repeat.proofIds.length], ['test', 3, 3]);
  assert.match(end.repeat.key, /^[a-f0-9]{64}$/);
  assert.match(end.reason, /같은 테스트가 같은 출력으로 3번 실패해 멈췄습니다: .*node(?:\.exe)? -e/);
  assert.equal((await getFeature(root, 'f1')).proofs.length, 3, 'stopped right after the third failure');
  const task = (await listTasks(root, { all: true }))[0];
  assert.equal(task.status, 'blocked');
  assert.match(task.updates.at(-1).note, /3번 실패해 멈췄습니다/);
  const overview = await view();
  assert.equal(overview.budget.usage.failures, 1, 'one consecutive failure');
  assert.deepEqual(overview.suggestions.map((item) => item.kind).sort(), ['blocked', 'judge']);
  const judge = overview.suggestions.find((item) => item.kind === 'judge');
  const input = await judgmentInput(root, { goal: goal.id, judgment: 'block', feature: 'f1', task: task.id, judge: 'pj-x', tools: TOOLS });
  assert.deepEqual(input.data.blocks.at(-1).repeat.proofIds, end.repeat.proofIds, 'the block judgment input carries the repeated proof ids');
  assert.ok(judge);
  assert.equal((await records(root, goal.id, 'repeat')).length, 0, 'stop does not also write a warning');
  const markdown = renderTraceMarkdown(await buildRunTrace(root, 'f1'));
  assert.match(markdown, /되풀이로 멈춤/);
  const { stdout } = await run(process.execPath, [BIN, 'pm-loop', 'show', goal.id, '--project', root], { env: { ...process.env, WAX_LANG: 'ko' } });
  assert.match(stdout, /worker stuck .*3번 실패해 멈췄습니다/);
  assert.match(stdout, new RegExp(`되풀이: 같은 실패 3번 · 근거 ${end.repeat.proofIds.join(', ')}`));
  const english = await run(process.execPath, [BIN, 'pm-loop', 'show', goal.id, '--project', root], { env: { ...process.env, WAX_LANG: 'en' } });
  assert.match(english.stdout, /Repeat: same failure 3 times · proofs/);
  assert.match(english.stdout, /The same test failed 3 times with the same output, so the worker was stopped/);
});

test('engine off: nothing is counted or recorded', async (t) => {
  const { root, engine, goal, launch } = await setup(t, { execute: repeater(4), stuckCheck: 'off' });
  await launch();
  await engine.workers.settled();
  assert.equal((await records(root, goal.id, 'repeat')).length, 0);
  assert.equal((await records(root, goal.id, 'worker')).at(-1).outcome, 'exited');
});

test('engine: the goal limit sets the threshold, and different failures or earlier runs are not counted together', async (t) => {
  const two = await setup(t, { execute: repeater(2), budgets: { repeats: 2 } });
  await two.launch();
  await two.engine.workers.settled();
  assert.equal((await records(two.root, two.goal.id, 'repeat'))[0]?.repeat.count, 2);

  const varied = await setup(t, { execute: repeater(4, { text: (i) => `Expected ${['one', 'two', 'three', 'four'][i]}` }) });
  await varied.launch();
  await varied.engine.workers.settled();
  assert.equal((await records(varied.root, varied.goal.id, 'repeat')).length, 0, 'different failures are not one repeat');
});

test('engine: proofs left before the run started, by a person or by another author are outside the run', async (t) => {
  const execute = async (root, { prompt, signal, activity }) => {
    const author = authorOf(prompt);
    await runTestProof(root, 'f1', failing(root), { author });
    activity({ approvals: 0 });
    await pause(40, signal);
    activity({ approvals: 0 });
    await pause(40, signal);
    return reply('blocked', '하나만 실패');
  };
  const { root, engine, goal, launch } = await setup(t, { execute });
  for (const author of ['wax-worker-claude', 'wax-worker-claude', '대표', '대표']) await runTestProof(root, 'f1', failing(root), { author });
  await sleep(5);
  await launch();
  await engine.workers.settled();
  assert.equal((await records(root, goal.id, 'repeat')).length, 0);
});

test('watch: the proof check runs at most once per poll interval from the activity callback, and never while one is running', async () => {
  let clock = 1000, reads = 0;
  const found = [];
  const watch = createStuckWatch({ mode: 'warn', threshold: 3, author: 'wax-worker-claude', since: 0, pollMs: 5000, now: () => clock,
    read: async () => { reads++; return [proof('same', { id: `p${reads}`, at: new Date(clock).toISOString() })]; }, onWarn: (repeat) => found.push(repeat), onStuck() { throw new Error('warn only'); } });
  for (let i = 0; i < 20; i++) watch.poke();
  await watch.idle();
  assert.equal(reads, 1, 'twenty activity calls in the same moment read once');
  clock += 4999; watch.poke(); await watch.idle();
  assert.equal(reads, 1);
  clock += 1; watch.poke(); await watch.idle();
  assert.equal(reads, 2);
  assert.equal(found.length, 0);
  const same = createStuckWatch({ mode: 'stop', threshold: 3, author: 'wax-worker-claude', since: 0, pollMs: 0, now: () => clock,
    read: async () => ['a', 'b', 'c'].map((id) => proof('same', { id })), onWarn() { throw new Error('stop only'); }, onStuck: (repeat) => found.push(repeat) });
  same.poke(); await same.idle(); same.poke(); await same.idle();
  assert.deepEqual(found.map((item) => [item.count, item.proofIds]), [[3, ['a', 'b', 'c']]]);
  const broken = createStuckWatch({ mode: 'stop', threshold: 3, author: 'x', since: 0, pollMs: 0, now: () => clock, read: async () => { throw new Error('busy'); }, onWarn() {}, onStuck() { throw new Error('no'); } });
  broken.poke(); await broken.idle();
});


test('transient: the shape exists without rules, and blocks whose worker end was transient are skipped in the failure streak', () => {
  assert.ok(FAILURE_SHAPES.includes('transient'));
  assert.equal(healthFor([{ tool: 'codex', shape: 'transient', at: '2026-11-03T10:00:00.000Z' }], 'codex', 'implement'), null, 'a transient failure does not reorder tools');
  const at = (minutes) => new Date(Date.parse('2026-11-03T10:00:00.000Z') + minutes * 60_000).toISOString();
  const goal = { id: 'goal-0000000e', title: 'g', state: 'running', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: at(-60) };
  const blocked = (id, minutes) => ({ id, feature: 'f1', status: 'blocked', at: at(minutes), updates: [{ status: 'blocked', note: 'x', at: at(minutes + 1) }] });
  const tasks = [blocked('t1', 0), blocked('t2', 10), blocked('t3', 20)];
  const end = (task, shape) => ({ kind: 'worker', outcome: 'failed', worker: `pw-${task}`, task, feature: 'f1', ...(shape ? { health: { shape, rule: 'r' } } : {}), at: at(30) });
  assert.equal(budgetUsage({ goal, tasks, decisions: [end('t1'), end('t2'), end('t3')], now: Date.parse(at(40)) }).usage.failures, 3);
  const skipped = budgetUsage({ goal, tasks, decisions: [end('t1'), end('t2', 'transient'), end('t3')], now: Date.parse(at(40)) });
  assert.equal(skipped.usage.failures, 2, 'the transient block is neither counted nor breaks the streak');
  assert.equal(skipped.exceeded, null);
  assert.equal(budgetUsage({ goal, tasks, decisions: [end('t1', 'quota'), end('t2'), end('t3')], now: Date.parse(at(40)) }).usage.failures, 3, 'other shapes still count');
});


function fakeClaude(requests) {
  return () => {
    const child = new EventEmitter();
    for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
    const emit = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    let index = 0;
    const next = () => {
      if (index < requests.length) { emit({ type: 'control_request', request_id: `perm-${index}`, request: { subtype: 'can_use_tool', tool_use_id: `toolu-${index}`, ...requests[index] } }); return; }
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', structured_output: { outcome: 'blocked', report: '거부됨' } });
    };
    child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); };
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const m = JSON.parse(line);
        if (m.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        else if (m.type === 'user') { emit({ type: 'system', subtype: 'init', session_id: 'session-1' }); next(); }
        else if (m.type === 'control_response') { index++; next(); }
      }
    });
    return child;
  };
}

test('approval repeats: the same request three times in one worker run is marked on the record and the approval API adds the threshold and the previous decision; it never stops anything', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const requests = [{ tool_name: 'Bash', input: { command: 'npm test' } }, { tool_name: 'Bash', input: { command: 'npm test' } }, { tool_name: 'Bash', input: { command: 'ls' } }, { tool_name: 'Bash', input: { command: 'npm test' } }];
  const executeWorker = (dir, input) => runAgentSession(dir, { ...input, executable: 'fake.js', launch: fakeClaude(requests) });
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 30, executeWorker,
    executeJudge: async () => { throw new Error('no judgment'); }, requestTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify(body) });
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const goal = await (await post('/api/pm-loop', { title: 'A', features: ['f1'] })).json();
  assert.equal((await post(`/api/pm-loop/${goal.id}/execute`, { key: 'goal:confirm-plan' })).status, 200);
  const card = (await get(`/api/pm-loop/${goal.id}`)).suggestions.find((item) => item.kind === 'start-worker');
  assert.equal((await post(`/api/pm-loop/${goal.id}/execute`, { key: card.key, tool: 'claude' })).status, 200);
  const seen = [];
  for (let i = 0; i < requests.length; i++) {
    let pending;
    for (const started = Date.now(); !pending; await sleep(20)) {
      pending = (await get('/api/approvals')).requests.find((item) => item.status === 'pending');
      if (Date.now() - started > 10_000) throw new Error(`no approval ${i}`);
    }
    seen.push(pending);
    assert.equal((await post(`/api/approvals/${pending.id}/decision`, { decision: i === 0 ? 'allow' : 'deny', fingerprint: pending.fingerprint })).status, 200);
  }
  await server.pmLoop.workers.settled();
  assert.deepEqual(seen.map((item) => item.repeat), [1, 2, 1, 3]);
  assert.equal(new Set([seen[0].repeatKey, seen[1].repeatKey, seen[3].repeatKey]).size, 1);
  assert.notEqual(seen[2].repeatKey, seen[0].repeatKey);
  assert.equal(new Set(seen.map((item) => item.callId)).size, 4);
  assert.deepEqual([seen[0].repeatNote, seen[1].repeatNote], [undefined, undefined], 'below the threshold nothing is added');
  assert.equal(seen[3].repeatNote.threshold, 3);
  assert.deepEqual([seen[3].repeatNote.previous.decision, seen[3].repeatNote.previous.decidedBy], ['deny', '대표'], 'the latest earlier decision on the same request');
  const end = (await records(root, goal.id, 'worker')).at(-1);
  assert.equal(end.outcome, 'exited');
});

test('evaluateGoals still stops a goal on the failure streak with stuck ends', async (t) => {
  const { root, engine, goal, view, launch } = await setup(t, { execute: repeater(6), stuckCheck: 'stop', budgets: { failures: 1 } });
  await launch();
  await engine.workers.settled();
  await evaluateGoals(root, { tools: TOOLS });
  const stopped = await view();
  assert.deepEqual([stopped.storedState, stopped.stoppedBy], ['stopped', 'pm-loop']);
  assert.ok(root && goal);
});

test('the real temp directory of this machine is normalised too', async () => {
  const real = await realpath(tmpdir());
  assert.equal(normalizeTestOutput(join(real, 'abc-1', 'x.js')), normalizeTestOutput(join(real, 'zzz-9', 'x.js')));
});
