import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { listChannels, postMessage, readMessages } from '../src/chat/channels.mjs';
import { project } from './chat-helpers.mjs';

test('작업 채널은 현재 wax 단계를 붙이고, 없는 작업은 거부한다 (AC2)', async (t) => {
  const root = await project(t, ['login']);
  const message = await postMessage(root, 'login', { author: 'claude-impl', kind: 'claude', body: '설계 의견' });
  assert.equal(message.phase, 'plan');
  assert.equal(message.channel, 'login');
  assert.match(message.id, /^m-000001-[0-9a-f]{6}$/);
  const explicit = await postMessage(root, 'login', { author: 'codex', body: '검토', phase: 'review' });
  assert.equal(explicit.phase, 'review');
  await assert.rejects(postMessage(root, 'nope', { author: 'a', body: 'x' }), (error) => error.status === 404);
  const general = await postMessage(root, 'general', { author: 'a', body: '전체 공지' });
  assert.equal(general.phase, undefined);
});

test('since 이후 메시지만 시간순으로 반환한다 (AC3)', async (t) => {
  const root = await project(t, ['login']);
  const ids = [];
  for (const body of ['하나', '둘', '셋']) ids.push((await postMessage(root, 'login', { author: 'a', body })).id);
  const { messages } = await readMessages(root, 'login', { since: ids[0] });
  assert.deepEqual(messages.map((m) => m.body), ['둘', '셋']);
  assert.deepEqual((await readMessages(root, 'login', { limit: 2 })).messages.map((m) => m.body), ['둘', '셋']);
  const file = await readFile(join(root, '.wax', 'chat', 'channels', 'login.jsonl'), 'utf8');
  assert.equal(file.trim().split('\n').length, 3);
});

test('답글 대상은 같은 채널에 있어야 하고, 보관된 작업에는 쓸 수 없다', async (t) => {
  const root = await project(t, ['login', 'other']);
  const first = await postMessage(root, 'login', { author: 'a', body: '질문', type: 'question' });
  const reply = await postMessage(root, 'login', { author: 'b', body: '답', type: 'answer', replyTo: first.id });
  assert.equal(reply.replyTo, first.id);
  await assert.rejects(postMessage(root, 'other', { author: 'b', body: '답', replyTo: first.id }), /없습니다/);
  await updateFeature(root, 'other', 'archive-feature', { revision: 1 });
  await assert.rejects(postMessage(root, 'other', { author: 'b', body: 'x' }), (error) => error.status === 409);
});

test('채널 목록은 general과 wax 작업을 메시지 수와 함께 보여 준다', async (t) => {
  const root = await project(t, ['login']);
  await postMessage(root, 'login', { author: 'a', body: 'x' });
  const channels = await listChannels(root);
  assert.deepEqual(channels.map((c) => [c.id, c.count]), [['general', 0], ['login', 1]]);
  assert.equal(channels[1].title, 'login 작업');
});

test('깨진 줄은 건너뛰고 skipped로 알린다', async (t) => {
  const root = await project(t, ['login']);
  await postMessage(root, 'login', { author: 'a', body: 'x' });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(root, '.wax', 'chat', 'channels', 'login.jsonl'), '{깨진 줄\n');
  const second = await postMessage(root, 'login', { author: 'a', body: 'y' });
  assert.equal(second.seq, 2);
  const result = await readMessages(root, 'login');
  assert.equal(result.skipped, 1);
  assert.equal(result.messages.length, 2);
});

test('프로젝트 이름으로 전체 채널(general)에 쓰고 읽는다', async (t) => {
  const parent = await project(t);
  const root = join(parent, 'shop-app');
  await mkdir(root);
  const message = await postMessage(root, 'shop-app', { author: 'a', body: '이름으로 보냄' });
  assert.equal(message.channel, 'general');
  assert.deepEqual((await readMessages(root, 'general')).messages.map((m) => m.body), ['이름으로 보냄']);
  assert.deepEqual((await readMessages(root, 'shop-app')).messages.map((m) => m.id), [message.id]);
  const [general] = await listChannels(root);
  assert.deepEqual([general.id, general.name, general.count], ['general', 'shop-app', 1]);
  const korean = await postMessage(parent, basename(parent), { author: 'a', body: '한글 이름' });
  assert.equal(korean.channel, 'general');
});

test('프로젝트 이름과 같은 wax 작업이 있으면 그 작업 채널이 우선이다', async (t) => {
  const parent = await project(t);
  const root = join(parent, 'login');
  await mkdir(root);
  await createFeature(root, { id: 'login', title: '로그인' });
  assert.equal((await postMessage(root, 'login', { author: 'a', body: '작업 채널' })).channel, 'login');
});
