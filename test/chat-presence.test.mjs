import test from 'node:test';
import assert from 'node:assert/strict';
import { joinPresence, listPresence, setPresence } from '../src/chat/presence.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { at, project } from './chat-helpers.mjs';

test('상태를 기록하고 10분이 지나면 away로 판정한다 (AC10)', async (t) => {
  const root = await project(t, ['chatbot']);
  await setPresence(root, { author: 'claude-impl', kind: 'claude', state: 'working', feature: 'chatbot', note: '구현' }, at('2026-10-13T06:00:00Z'));
  const [fresh] = await listPresence(root, at('2026-10-13T06:10:00Z'));
  assert.deepEqual([fresh.state, fresh.effectiveState, fresh.kind, fresh.feature], ['working', 'working', 'claude', 'chatbot']);
  const [stale] = await listPresence(root, at('2026-10-13T06:10:01Z'));
  assert.equal(stale.effectiveState, 'away');
});

test('게시하면 lastActive가 갱신되고 idle이면 discussing이 된다 (AC10)', async (t) => {
  const root = await project(t, ['chatbot']);
  await setPresence(root, { author: 'codex', kind: 'codex', state: 'idle' }, at('2026-10-13T06:00:00Z'));
  await postMessage(root, 'chatbot', { author: 'codex', kind: 'codex', body: '복귀' }, at('2026-10-13T06:20:00Z'));
  const [entry] = await listPresence(root, at('2026-10-13T06:21:00Z'));
  assert.deepEqual([entry.state, entry.effectiveState, entry.lastActive, entry.feature], ['discussing', 'discussing', '2026-10-13T06:20:00.000Z', 'chatbot']);

  await setPresence(root, { author: 'codex', state: 'reviewing' }, at('2026-10-13T06:22:00Z'));
  await postMessage(root, 'chatbot', { author: 'codex', body: '검토 의견' }, at('2026-10-13T06:23:00Z'));
  const [kept] = await listPresence(root, at('2026-10-13T06:23:00Z'));
  assert.equal(kept.state, 'reviewing', '작업·검토 상태는 게시로 바뀌지 않는다');
  assert.equal(kept.kind, 'codex', 'kind를 생략하면 이전 값을 유지한다');

  await setPresence(root, { author: 'codex', state: 'reviewing', feature: 'login' }, at('2026-10-13T06:24:00Z'));
  await postMessage(root, 'chatbot', { author: 'codex', body: '다른 채널 의견' }, at('2026-10-13T06:25:00Z'));
  const [same] = await listPresence(root, at('2026-10-13T06:25:00Z'));
  assert.equal(same.feature, 'login', '명시한 담당 작업은 다른 채널에 게시해도 유지된다');
});

test('잘못된 상태는 거부한다', async (t) => {
  const root = await project(t);
  await assert.rejects(setPresence(root, { author: 'a', state: 'sleeping' }), /상태/);
  await assert.rejects(setPresence(root, { author: 'a', state: 'working', feature: 'Bad' }), /채널 ID/);
});

test('첫 참여(join): 같은 이름이 활동 중이면 -2, -3으로 들어오고, 자리 비움이거나 없으면 그 이름을 쓴다', async (t) => {
  const root = await project(t, ['chatbot']);
  const first = await joinPresence(root, { author: 'claude-app', kind: 'claude', model: 'claude-opus-5-5' }, at('2026-10-15T06:00:00Z'));
  assert.deepEqual([first.author, first.renamed, first.state, first.kind], ['claude-app', false, 'idle', 'claude']);
  const second = await joinPresence(root, { author: 'claude-app', kind: 'claude', feature: 'chatbot', state: 'working' }, at('2026-10-15T06:01:00Z'));
  assert.deepEqual([second.author, second.requested, second.renamed, second.feature], ['claude-app-2', 'claude-app', true, 'chatbot']);
  const third = await joinPresence(root, { author: 'claude-app', kind: 'claude' }, at('2026-10-15T06:02:00Z'));
  assert.equal(third.author, 'claude-app-3');
  const back = await joinPresence(root, { author: 'claude-app', kind: 'claude' }, at('2026-10-15T06:10:30Z'));
  assert.deepEqual([back.author, back.renamed, back.model], ['claude-app-4', true, null]);
  assert.deepEqual((await listPresence(root, at('2026-10-15T06:10:30Z'))).map((e) => e.author), ['claude-app', 'claude-app-2', 'claude-app-3', 'claude-app-4']);
});

test('첫 참여(join): 번호를 붙여도 이름은 40자를 넘지 않고, 잘못된 이름은 거부한다', async (t) => {
  const root = await project(t);
  const long = 'c'.repeat(40);
  await joinPresence(root, { author: long, kind: 'codex' }, at('2026-10-15T06:00:00Z'));
  const next = await joinPresence(root, { author: long, kind: 'codex' }, at('2026-10-15T06:00:01Z'));
  assert.equal(next.author, `${'c'.repeat(38)}-2`);
  await assert.rejects(joinPresence(root, { author: '-bad' }), /작성자/);
});
