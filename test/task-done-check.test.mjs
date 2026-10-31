import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { updateFeature } from '../src/workflow.mjs';
import { assignTask, listTasks, setPm, taskDoneCheckMode, updateTask } from '../src/chat/team.mjs';
import { collectDay } from '../src/chat/daily.mjs';
import { collectWorkNotes } from '../src/chat/work-notes.mjs';
import { run } from '../src/chat/cli.mjs';
import { taskThread } from '../web/thread-model.mjs';
import { translate } from '../web/locale-core.mjs';
import { project } from './chat-helpers.mjs';

const past = { now: new Date(Date.now() - 60_000) };
async function finish(root, id, phase) {
  await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n작업 내역` });
  return updateFeature(root, id, 'complete', { phase, evidence: '확인 결과', ...(['implement', 'review'].includes(phase) ? { waiver: '단계 진행만 확인' } : {}), ...(phase === 'review' ? { verdict: 'pass' } : {}) });
}
async function team(t, features = ['login']) {
  const root = await project(t, features);
  await setPm(root, { author: 'pm', kind: 'human' });
  return root;
}
const assign = (root, phase, feature = 'login') => assignTask(root, { author: 'pm', feature, to: 'codex', phase, body: '맡은 단계 수행' }, past);

test('mode comes from WAX_TASK_DONE_CHECK: warn by default, enforce, off, anything else is refused', () => {
  assert.equal(taskDoneCheckMode(undefined), 'warn');
  assert.equal(taskDoneCheckMode(''), 'warn');
  assert.equal(taskDoneCheckMode('enforce'), 'enforce');
  assert.equal(taskDoneCheckMode('off'), 'off');
  assert.throws(() => taskDoneCheckMode('strict'), /warn·enforce·off/);
});

test('done before the phase completed is warned by default and refused under enforce', async (t) => {
  const root = await team(t);
  const task = await assign(root, 'plan');
  await updateTask(root, task.id, 'accept', { author: 'codex' });
  await assert.rejects(updateTask(root, task.id, 'done', { author: 'codex', body: '기획 끝', taskDoneCheck: 'enforce' }),
    (error) => error.status === 409 && /plan 단계가 배정 이후 현재 주기에 완료되지 않았습니다.*block.*WAX_TASK_DONE_CHECK=enforce/.test(error.message));
  assert.equal((await listTasks(root))[0].status, 'accepted', '거절된 완료는 기록되지 않는다');
  const warned = await updateTask(root, task.id, 'done', { author: 'codex', body: '기획 끝', taskDoneCheck: 'warn' });
  assert.equal(warned.status, 'done');
  assert.match(warned.updates.at(-1).warning, /업무 t-\S+의 plan 단계.*wax complete plan login/);
  const event = (await collectDay(root)).events.find((e) => e.type === 'task' && e.status === 'done');
  assert.match(event.detail, /^\[경고\] 업무 .* \/ 기획 끝$/);
  assert.equal(event.warning, warned.updates.at(-1).warning);
  const notes = await collectWorkNotes(root, 'codex');
  assert.match(JSON.stringify(notes), /\[경고\] 업무/);
  assert.match(taskThread(warned).items.at(-1).text, /^\[경고\] 업무 .* \/ 기획 끝$/);
  assert.doesNotMatch(translate(warned.updates.at(-1).warning), /[가-힣]/);
});

test('done after the phase completed in the current cycle carries no warning, even under enforce', async (t) => {
  const root = await team(t);
  const task = await assign(root, 'plan');
  await finish(root, 'login', 'plan');
  const done = await updateTask(root, task.id, 'done', { author: 'codex', taskDoneCheck: 'enforce' });
  assert.equal(done.status, 'done');
  assert.equal(done.updates.at(-1).warning, undefined);
});

test('a completion recorded before the assignment, or dropped by iterate, does not count', async (t) => {
  const root = await team(t);
  for (const phase of ['plan', 'design', 'implement']) await finish(root, 'login', phase);
  const late = await assignTask(root, { author: 'pm', feature: 'login', to: 'codex', phase: 'plan', body: '기획 다시' }, { now: new Date(Date.now() + 60_000) });
  await assert.rejects(updateTask(root, late.id, 'done', { author: 'codex', taskDoneCheck: 'enforce' }), /plan 단계가 배정 이후/);
  const reviewTask = await assign(root, 'review');
  await finish(root, 'login', 'review');
  await updateFeature(root, 'login', 'iterate', { reason: '회귀 발견' });
  await assert.rejects(updateTask(root, reviewTask.id, 'done', { author: 'codex', taskDoneCheck: 'enforce' }), /review 단계가 배정 이후 현재 주기에 완료되지 않았습니다\(작업 login 현재 단계 implement\)/);
});

test('an any task needs at least one phase completed since the assignment', async (t) => {
  const root = await team(t);
  await finish(root, 'login', 'plan');
  const task = await assignTask(root, { author: 'pm', feature: 'login', to: 'codex', phase: 'any', body: '다음 단계' }, { now: new Date(Date.now() + 1) });
  await assert.rejects(updateTask(root, task.id, 'done', { author: 'codex', taskDoneCheck: 'enforce' }), /완료한 단계가 없습니다\(현재 단계 design\).*WAX_TASK_DONE_CHECK=enforce/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await finish(root, 'login', 'design');
  assert.equal((await updateTask(root, task.id, 'done', { author: 'codex', taskDoneCheck: 'enforce' })).updates.at(-1).warning, undefined);
});

test('off, other status changes and tasks whose feature is gone are not checked', async (t) => {
  const root = await team(t, ['login', 'gone']);
  const off = await assign(root, 'plan');
  assert.equal((await updateTask(root, off.id, 'done', { author: 'codex', taskDoneCheck: 'off' })).updates.at(-1).warning, undefined);
  const blocked = await assign(root, 'plan');
  assert.equal((await updateTask(root, blocked.id, 'block', { author: 'codex', body: '요구사항 미정', taskDoneCheck: 'enforce' })).status, 'blocked');
  assert.equal((await updateTask(root, blocked.id, 'cancel', { author: 'pm', taskDoneCheck: 'enforce' })).status, 'cancelled');
  const orphan = await assign(root, 'plan', 'gone');
  await rm(join(root, '.wax', 'features', 'gone.json'));
  const done = await updateTask(root, orphan.id, 'done', { author: 'codex', taskDoneCheck: 'enforce' });
  assert.equal(done.status, 'done');
  assert.equal(done.updates.at(-1).warning, undefined);
});

test('CLI task done prints the warning to stderr and honors WAX_TASK_DONE_CHECK', async (t) => {
  const root = await team(t);
  const task = await assign(root, 'plan');
  const call = async (env, extra = []) => {
    let stdout = '', stderr = '';
    const code = await run(['--project', root, 'task', 'done', task.id, '--author', 'codex', ...extra], { env, cwd: root, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } });
    return { code, stdout, stderr };
  };
  await assert.rejects(call({ WAX_TASK_DONE_CHECK: 'enforce' }), /WAX_TASK_DONE_CHECK=enforce/);
  await assert.rejects(call({ WAX_TASK_DONE_CHECK: 'loose' }), /warn·enforce·off/);
  const warned = await call({}, ['--json']);
  assert.equal(warned.code, 0);
  assert.match(warned.stderr, /^wax chat: 경고: 업무 .*plan 단계/);
  assert.match(JSON.parse(warned.stdout).updates.at(-1).warning, /plan 단계/);
  let listing = '';
  await run(['--project', root, 'tasks', '--all'], { env: {}, cwd: root, stdout: { write: (s) => { listing += s; } } });
  assert.match(listing, /\n {2}경고: 업무 /);
});
