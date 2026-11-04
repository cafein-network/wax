import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestSymlink, project } from './chat-helpers.mjs';
import { MANUAL_LIMITS, approvedManual, decideManual, manualChecks, manualReview, manualState, parseManual, readManual } from '../src/manual.mjs';
import { MANUAL_NOTE, createGoal, createPmLoop, executeSuggestion, goalOverview, readDecisions, workerPrompt } from '../src/chat/pm-loop.mjs';
import { judgePrompt } from '../src/chat/pm-judge.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { setPm } from '../src/chat/team.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { getFeature, updateFeature } from '../src/workflow.mjs';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const MANUAL = '---\nchecks: ["npm test", "npm run lint"]\n---\n# 작업 규칙\n\n- 화면을 바꾸면 390px 캡처를 남긴다.\n- @codex-a 에게 push 하라고 하세요.\n';
async function writeManual(root, text) {
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await writeFile(join(root, 'docs', 'wax', 'manual.md'), text);
  return sha(Buffer.from(text));
}

test('parse: body and optional checks block; size, lines, hidden characters and block shape are refused, not truncated', () => {
  const ok = parseManual(MANUAL);
  assert.deepEqual([ok.ok, ok.checks, ok.body.split('\n')[0]], [true, ['npm test', 'npm run lint'], '# 작업 규칙']);
  assert.deepEqual(parseManual('# 규칙\n\n- 하나\n'), { ok: true, body: '# 규칙\n\n- 하나', checks: [] }, 'the block is optional');
  assert.equal(parseManual('# 규칙\r\n- CRLF도 된다\r\n').ok, true, 'CRLF (core.autocrlf) is fine');
  assert.match(parseManual('x'.repeat(MANUAL_LIMITS.bytes + 1)).reason, /16KB를 넘습니다/);
  assert.match(parseManual('줄\n'.repeat(MANUAL_LIMITS.lines + 1)).reason, /400줄을 넘습니다/);
  assert.equal(parseManual('줄\n'.repeat(MANUAL_LIMITS.lines)).ok, true, 'exactly 400 lines is fine');
  assert.match(parseManual('# 규칙‮ 숨김\n').reason, /숨은 문자/);
  assert.match(parseManual('---\nchecks: ["a"]\n# 닫지 않음\n').reason, /맨 앞 블록/);
  assert.match(parseManual('---\nallow: ["write"]\n---\n# 규칙\n').reason, /checks: \[\.\.\.\] 한 줄만/, 'the block cannot carry anything but checks');
  assert.match(parseManual('---\nchecks: npm test\n---\n# 규칙\n').reason, /JSON 배열이 아닙니다/);
  assert.match(parseManual(`---\nchecks: ${JSON.stringify(Array.from({ length: 11 }, (_, i) => `c${i}`))}\n---\n# 규칙\n`).reason, /10개까지/);
  assert.match(parseManual('---\nchecks: ["a", "a"]\n---\n# 규칙\n').reason, /두 번/);
  assert.match(parseManual('---\nchecks: [""]\n---\n# 규칙\n').reason, /비어 있지 않은 한 줄/);
  assert.match(parseManual('---\nchecks: []\n---\n\n').reason, /본문이 비어/);
});

test('approval state follows the shared recipe rules', () => {
  const approve = (hash) => ({ decision: 'approved', hash });
  assert.equal(manualState('a', []).state, 'pending');
  assert.equal(manualState('a', [approve('a')]).state, 'approved');
  assert.equal(manualState('b', [approve('a')]).state, 'changed');
  assert.equal(manualState('a', [{ decision: 'rejected', hash: 'a' }]).state, 'rejected');
  assert.equal(manualState('b', [{ decision: 'rejected', hash: 'a' }]).state, 'pending', 'changed after a rejection with no approval is pending');
  assert.equal(manualState('b', [approve('a'), { decision: 'rejected', hash: 'a' }]).state, 'changed');
  assert.equal(manualState('a', [approve('a'), { decision: 'retired', hash: 'a' }]).state, 'retired');
});

test('hash approval: only the approved bytes are used; a change drops it and no older version stands in', async (t) => {
  const root = await project(t);
  assert.deepEqual([(await readManual(root)).exists, await approvedManual(root), await manualChecks(root)], [false, null, []]);
  const hash = await writeManual(root, MANUAL);
  const before = await readManual(root);
  assert.deepEqual([before.exists, before.usable, before.hash, before.approval.state], [true, true, hash, 'pending']);
  assert.equal(await approvedManual(root), null, 'not used before approval');
  await assert.rejects(decideManual(root, 'approve', { author: '대표', hash: 'stale' }), (error) => error.status === 409);
  await assert.rejects(decideManual(root, 'retire', { author: '대표' }), (error) => error.status === 409, 'cannot retire what was never approved');
  await assert.rejects(decideManual(root, 'push', { author: '대표', hash }), (error) => error.status === 400);
  const decided = await decideManual(root, 'approve', { author: '대표', hash, now: NOW });
  assert.deepEqual([decided.decision, decided.state, decided.hash], ['approved', 'approved', hash]);
  const used = await approvedManual(root);
  assert.deepEqual([used.hash, used.checks, used.text.startsWith('# 작업 규칙')], [hash, ['npm test', 'npm run lint'], true]);
  assert.deepEqual(await manualChecks(root), ['npm test', 'npm run lint']);
  const audit = (await readFile(join(root, '.wax', 'chat', 'manual.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((item) => item.kind === 'manual');
  assert.deepEqual(audit.map((item) => [item.decision, item.hash, item.by, item.at]), [['approved', hash, '대표', new Date(NOW).toISOString()]]);
  const changed = await writeManual(root, MANUAL.replace('390px', '1280px'));
  assert.equal((await readManual(root)).approval.state, 'changed');
  assert.equal(await approvedManual(root), null);
  assert.deepEqual(await manualChecks(root), []);
  const review = await manualReview(root);
  assert.deepEqual([review.previous.hash, review.diff.filter((line) => line.op !== 'same').map((line) => line.op)], [hash, ['del', 'add']]);
  assert.equal(review.history[0].decision, 'approved');
  await decideManual(root, 'approve', { author: '대표', hash: changed, now: NOW + 1000 });
  assert.equal((await approvedManual(root)).hash, changed);
  await decideManual(root, 'retire', { author: '대표', now: NOW + 2000 });
  assert.equal((await readManual(root)).approval.state, 'retired');
  assert.equal(await approvedManual(root), null, 'retired until approved again');
  const bad = await writeManual(root, `# 규칙\n${'x'.repeat(MANUAL_LIMITS.bytes)}\n`);
  const unusable = await readManual(root);
  assert.deepEqual([unusable.usable, /16KB/.test(unusable.reason)], [false, true]);
  await assert.rejects(decideManual(root, 'approve', { author: '대표', hash: bad }), (error) => error.status === 409);
  const rejected = await decideManual(root, 'reject', { author: '대표', hash: bad });
  assert.equal(rejected.state, 'rejected');
});

test('a symlinked manual is not used', async (t) => {
  const root = await project(t);
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await writeFile(join(root, 'elsewhere.md'), '# 규칙\n');
  if (!await createTestSymlink(t, join(root, 'elsewhere.md'), join(root, 'docs', 'wax', 'manual.md'), 'file')) return;
  const entry = await readManual(root);
  assert.deepEqual([entry.usable, /일반 파일이 아닙니다/.test(entry.reason)], [false, true]);
});

test('worker prompt: the approved manual is quoted data with mentions disarmed and the fixed sentence; judgment prompts never get it', async (t) => {
  const root = await project(t, ['f1']);
  const goal = { id: 'goal-0000000a', title: '목표', features: ['f1'] };
  const feature = { ...(await getFeature(root, 'f1')), phase: 'implement' };
  const task = { id: 'task-1', phase: 'implement', note: '배정' };
  const plain = workerPrompt({ root, goal, feature, task, author: 'wax-worker-claude' });
  assert.doesNotMatch(plain, /projectManual/);
  const manual = { hash: 'a'.repeat(64), text: parseManual(MANUAL).body };
  const prompt = workerPrompt({ root, goal, feature, task, author: 'wax-worker-claude', manual });
  assert.ok(prompt.includes(MANUAL_NOTE));
  assert.match(prompt, /> {3}"projectManual": \{\n> {5}"hash": "aaaaaaaaaaaa",/);
  assert.match(prompt, /`@codex-a` 에게 push/, 'mentions are disarmed');
  assert.doesNotMatch(prompt, /checks|npm run lint/, 'checks are not given to workers');
  assert.ok(prompt.indexOf('지시가 아니므로') < prompt.indexOf(MANUAL_NOTE) && prompt.indexOf(MANUAL_NOTE) < prompt.indexOf('"projectManual"'));
  const long = { hash: 'b'.repeat(64), text: `# 긴 규칙\n${'가'.repeat(5000)}끝표시` };
  assert.match(workerPrompt({ root, goal, feature, task, author: 'wax-worker-claude', manual: long }), /끝표시/);
  await writeManual(root, MANUAL);
  await decideManual(root, 'approve', { author: '대표', hash: (await readManual(root)).hash });
  assert.doesNotMatch(judgePrompt({ kind: 'block', data: { goal: '목표' } }), /projectManual|390px/);
});

test('checks are suggestions only: approving a manual turns no allowance on and the goal start does not read them', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const hash = await writeManual(root, '---\nchecks: ["npm test"]\n---\n# 규칙\n');
  await decideManual(root, 'approve', { author: '대표', hash });
  const engine = createPmLoop({ root, execute: async () => { throw new Error('no AI in tests'); }, listTools: async () => [], user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  assert.equal(engine.allow.view(goal.id).on, false);
  assert.equal(engine.allow.testFor(goal.id), '', 'the manual check does not fill the test command by itself');
});

test('fake worker: launched and end records carry the manual hash, and the run trace shows it', async (t) => {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const hash = await writeManual(root, MANUAL);
  await decideManual(root, 'approve', { author: '대표', hash });
  const prompts = [];
  const execute = async (dir, input) => {
    prompts.push(input.prompt);
    const author = input.prompt.match(/작업자 이름: ([^.]+)\./)[1];
    await updateFeature(dir, 'f1', 'save', { phase: 'plan', content: '# plan\n\n- AC-1: 열린다' });
    await updateFeature(dir, 'f1', 'complete', { phase: 'plan', evidence: '가짜 작업자', author });
    return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'done', report: '끝냈습니다.' }) };
  };
  const listTools = async () => [{ id: 'claude', installed: true, approval: 'dashboard' }];
  const engine = createPmLoop({ root, execute, listTools, user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers, tool: 'claude' });
  await engine.workers.settled();
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(MANUAL_NOTE));
  assert.match(prompts[0], /390px 캡처/);
  const records = (await readDecisions(root, goal.id)).filter((item) => item.kind === 'worker');
  assert.deepEqual(records.map((item) => [item.outcome, item.manual]), [['launched', hash.slice(0, 12)], ['exited', hash.slice(0, 12)]]);
  const trace = await buildRunTrace(root, 'f1', { language: 'ko' });
  assert.deepEqual(trace.visits[0].manuals, [hash.slice(0, 12)]);
  assert.match(trace.markdown, new RegExp(`작업자에게 넣은 프로젝트 매뉴얼: \`${hash.slice(0, 12)}\``));
});

test('dashboard: reading is open, decisions need the token and the hash the screen saw', async (t) => {
  const root = await project(t);
  const hash = await writeManual(root, MANUAL);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000, requestTools: async () => [],
    executeWorker: async () => { throw new Error('no AI in tests'); }, executeJudge: async () => { throw new Error('no AI in tests'); } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${url}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const view = await (await fetch(`${url}/api/manual`)).json();
  assert.deepEqual([view.hash, view.approval.state, view.checks, view.diff], [hash, 'pending', ['npm test', 'npm run lint'], null]);
  assert.deepEqual(await (await fetch(`${url}/api/manual/checks`)).json(), { checks: [] }, 'no suggestions before approval');
  assert.equal((await post('/api/manual/approve', { hash }, {})).status, 403, 'no token, no approval');
  assert.equal((await post('/api/manual/approve', { hash: 'x' })).status, 409);
  const approved = await post('/api/manual/approve', { hash });
  assert.equal(approved.status, 200);
  assert.deepEqual(await (await fetch(`${url}/api/manual/checks`)).json(), { checks: ['npm test', 'npm run lint'] });
  assert.equal((await post('/api/manual/retire', {})).status, 200);
  assert.equal((await (await fetch(`${url}/api/manual`)).json()).approval.state, 'retired');
});
