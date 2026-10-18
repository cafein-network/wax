import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, TOOLS, assignmentCommand, commandFor, nextCommand } from '../web/commands.mjs';
import { listPresence, setPresence, touchPresence } from '../src/chat/presence.mjs';
import { project } from './chat-helpers.mjs';

test('도구별 명령 문법: 같은 명령을 각 도구의 방식으로 부른다', () => {
  assert.equal(commandFor('claude', 'plan', 'login'), '/wax:plan login');
  assert.equal(commandFor('gemini', 'plan', 'login'), '/wax:plan login');
  assert.equal(commandFor('codex', 'plan', 'login'), '$wax:plan login');
  assert.equal(commandFor('antigravity', 'plan', 'login'), '/plan login');
  assert.equal(commandFor('copilot', 'plan', 'login'), 'wax plan 스킬로 login 진행해줘');
  assert.equal(commandFor('copilot', 'status'), 'wax status 스킬로 진행해줘');
  assert.equal(commandFor('human', 'plan', 'login'), null, '사람은 명령을 실행하지 않는다');
  assert.equal(assignmentCommand('codex'), '$wax:work');
  assert.equal(commandFor('codex', 'work', 't-1'), '$wax:work t-1', 'Codex work is a skill invocation with $, not a file mention');
  assert.deepEqual(TOOLS.map((t) => t.kind), ['claude', 'codex', 'copilot', 'gemini', 'antigravity']);
  assert.equal(COMMANDS.length, 13, '플러그인 명령 13개와 같은 표');
});

test('다음 명령: 배정 업무 → 맡은 작업의 현재 단계 → 상태 확인 순', () => {
  const features = [{ id: 'login', phase: 'design' }, { id: 'old', phase: 'done' }];
  const codex = { author: 'codex-app', kind: 'codex', feature: 'login' };
  assert.deepEqual(nextCommand({ agent: codex, features, tasks: [] }), { command: 'design', args: 'login', text: '$wax:design login', reason: 'login의 현재 단계' });
  const tasks = [{ id: 't-1', to: 'codex-app', feature: 'login', phase: 'review', status: 'accepted' }, { id: 't-2', to: 'other', feature: 'login', phase: 'plan', status: 'open' }];
  assert.equal(nextCommand({ agent: codex, features, tasks }).text, '$wax:work t-1');
  assert.match(nextCommand({ agent: codex, features, tasks }).reason, /login review 업무/);
  assert.equal(nextCommand({ agent: codex, features, tasks: [{ ...tasks[0], status: 'done' }] }).command, 'design', '끝난 업무는 건너뛴다');
  assert.equal(nextCommand({ agent: { ...codex, feature: 'old' }, features }).text, '$wax:status old');
  assert.equal(nextCommand({ agent: { author: 'c', kind: 'copilot', feature: null }, features }).text, 'wax status 스킬로 진행해줘');
  assert.equal(nextCommand({ agent: { author: '사람', kind: 'human', feature: 'login' }, features }), null);
});

test('모델: 세션이 밝힌 모델을 기록·유지하고, 이상한 값은 거부한다', async (t) => {
  const root = await project(t, ['login']);
  await setPresence(root, { author: 'copilot-app', kind: 'copilot', model: 'claude-sonnet-4-5', state: 'working' });
  await touchPresence(root, { author: 'copilot-app', note: '다음 일' });
  await setPresence(root, { author: 'copilot-app', state: 'idle' });
  const [entry] = await listPresence(root);
  assert.equal(entry.model, 'claude-sonnet-4-5', '모델을 다시 밝히지 않아도 유지된다');
  await assert.rejects(setPresence(root, { author: 'x', state: 'idle', model: '<script>' }), /모델 이름/);
  await assert.rejects(setPresence(root, { author: 'x', state: 'idle', model: 'a'.repeat(61) }), /모델 이름/);
});
