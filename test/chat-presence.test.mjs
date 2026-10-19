import test from 'node:test';
import assert from 'node:assert/strict';
import { joinPresence, listPresence, reserveDashboardUser, resetPresence, setPresence } from '../src/chat/presence.mjs';
import { getTeam, setPm } from '../src/chat/team.mjs';
import { startBeat } from '../src/chat/listeners.mjs';
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

test('세션 초기화(reset): 지난 init이 남긴 세션을 지워 같은 이름과 PM을 새 세션이 이어받고, 듣는 중·작업 중 세션은 남긴다', async (t) => {
  const root = await project(t, ['chatbot']);
  const joins = [];
  for (let i = 0; i < 3; i++) joins.push(await joinPresence(root, { author: 'claude-app', kind: 'claude', state: 'idle' }));
  assert.deepEqual(joins.map((j) => j.author), ['claude-app', 'claude-app-2', 'claude-app-3']);
  await setPm(root, { author: 'claude-app', kind: 'claude' });
  const busy = await joinPresence(root, { author: 'codex-app', kind: 'codex', state: 'working', feature: 'chatbot' });
  const listening = await joinPresence(root, { author: 'gemini-app', kind: 'gemini' });
  const stop = await startBeat(root, 'gemini-app', null, 60_000, () => {});
  t.after(stop);
  await reserveDashboardUser(root, '대표');
  await setPresence(root, { author: '대표', kind: 'human', state: 'idle' });

  const fresh = await joinPresence(root, { author: 'claude-app', kind: 'claude' });
  assert.equal(fresh.author, 'claude-app-4');

  const result = await resetPresence(root);
  assert.deepEqual(result, { removed: ['claude-app', 'claude-app-2', 'claude-app-3', 'claude-app-4'], kept: ['codex-app', 'gemini-app'] });
  const again = await joinPresence(root, { author: 'claude-app', kind: 'claude', session: fresh.session });
  assert.equal(again.author, 'claude-app', '세션 ID를 지켜 다시 참여하면 기본 이름을 되찾는다');
  await postMessage(root, 'chatbot', { author: 'claude-app', session: fresh.session, kind: 'claude', body: 'PM으로 이어서 진행' });
  assert.equal((await getTeam(root)).pm.author, 'claude-app', 'PM 역할은 이름에 남는다');
  await assert.rejects(postMessage(root, 'chatbot', { author: 'claude-app', session: joins[0].session, body: '지난 세션' }), { status: 409 });

  assert.deepEqual(await resetPresence(root, { author: 'gemini-app' }), { removed: ['gemini-app'], kept: [] });
  await assert.rejects(resetPresence(root, { author: 'gemini-app' }), { status: 404 });
  assert.deepEqual((await listPresence(root)).map((e) => e.author), ['claude-app', 'codex-app', '대표']);
  assert.equal(busy.author, 'codex-app'); assert.equal(listening.author, 'gemini-app');
});
