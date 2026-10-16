import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { postMessage } from '../src/chat/channels.mjs';
import { assignTask, setPm } from '../src/chat/team.mjs';
import { formatWatchEvent, isForMe, watchChat } from '../src/chat/watch.mjs';
import { BIN, project } from './chat-helpers.mjs';

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('시간 초과'); await new Promise((done) => setTimeout(done, 20)); }
};

test('isForMe: @이름·--to만 깨우고 내 메시지·이름 앞부분 일치·부르지 않은 사람 메시지는 무시', () => {
  const me = 'claude';
  assert.equal(isForMe({ author: '사람', kind: 'human', body: '@claude 확인해줘' }, me), true);
  assert.equal(isForMe({ author: '사람', kind: 'human', body: '확인 부탁(@claude)' }, me), true);
  assert.equal(isForMe({ author: 'codex', kind: 'codex', body: '질문', to: ['claude'] }, me), true);
  assert.equal(isForMe({ author: '사람', kind: 'human', body: '모두 확인해줘' }, me), false);
  assert.equal(isForMe({ author: '사람', kind: 'human', body: '@claude-app 확인' }, me), false);
  assert.equal(isForMe({ author: '사람', kind: 'human', body: 'mail@claude' }, me), false);
  assert.equal(isForMe({ author: 'claude', kind: 'claude', body: '@claude 메모' }, me), false);
});

test('watchChat: 시작 뒤 나를 부른 메시지와 새 배정만 알린다', async (t) => {
  const root = await project(t, ['login']);
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '@claude 이전 메시지' });
  const events = [];
  const stop = await watchChat(root, { author: 'claude', write: (e) => events.push(e), intervalMs: 20 });
  t.after(stop);
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '그냥 혼잣말' });
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '@claude 로그인 화면 확인해줘', type: 'question' });
  await setPm(root, { author: '사람', kind: 'human' });
  await assignTask(root, { author: '사람', feature: 'login', to: 'claude', phase: 'plan', body: '기획 부탁' });
  await assignTask(root, { author: '사람', feature: 'login', to: 'codex', phase: 'plan', body: '다른 사람 업무' });
  await until(() => events.some((e) => e.event === 'task'));
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(events.map((e) => e.event), ['message', 'task']);
  assert.match(formatWatchEvent(events[0]), /^\[메시지 m-\S+\] #login 사람\(human\) <question>: @claude 로그인 화면 확인해줘$/);
  assert.match(formatWatchEvent(events[1]), /^\[업무 t-\S+\] PM 사람의 배정: login\/plan 기획 부탁$/);
});

test('CLI chat watch: 한 줄씩 출력하고 --author가 없으면 사용법 오류', async (t) => {
  const root = await project(t, ['login']);
  const child = spawn(process.execPath, [BIN, '--project', root, 'chat', 'watch', '--author', 'claude', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await new Promise((done) => setTimeout(done, 500));
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '첫 줄\n둘째 줄 @claude' });
  await until(() => stdout.includes('\n'), 5000);
  const line = JSON.parse(stdout.trim().split('\n')[0]);
  assert.equal(line.event, 'message');
  assert.equal(line.channel, 'login');
  const missing = await new Promise((done) => {
    const bad = spawn(process.execPath, [BIN, '--project', root, 'chat', 'watch'], { stdio: 'ignore' });
    bad.on('close', done);
  });
  assert.equal(missing, 2);
});

test('watchChat: 다시 시작하면 놓친 메시지를 채널과 상관없이 대화 순서대로, 한 번씩만 내보낸다', async (t) => {
  const root = await project(t, ['login', 'signup']);
  const first = [];
  const stop = await watchChat(root, { author: 'claude', write: (e) => first.push(e), intervalMs: 20 });
  stop();
  await postMessage(root, 'signup', { author: '사람', kind: 'human', body: '@claude 첫째' }, { now: new Date(Date.now() + 1000) });
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '@claude 둘째' }, { now: new Date(Date.now() + 2000) });
  await postMessage(root, 'signup', { author: '사람', kind: 'human', body: '@claude 셋째' }, { now: new Date(Date.now() + 3000) });
  const again = [];
  const stop2 = await watchChat(root, { author: 'claude', write: (e) => again.push(e), intervalMs: 20 });
  t.after(stop2);
  assert.deepEqual(again.filter((e) => e.event === 'message').map((e) => e.message.body), ['@claude 첫째', '@claude 둘째', '@claude 셋째']);
  stop2();
  const third = [];
  const stop3 = await watchChat(root, { author: 'claude', write: (e) => third.push(e), intervalMs: 20 });
  t.after(stop3);
  assert.equal(third.filter((e) => e.event === 'message').length, 0, '이미 내보낸 메시지는 다시 나가지 않는다');
  assert.equal(first.length, 0);
});

test('watchChat: --feature로 좁힌 감시와 전체 감시는 읽음 위치가 따로라 서로의 메시지를 지우지 않는다', async (t) => {
  const root = await project(t, ['login', 'signup']);
  const stopA = await watchChat(root, { author: 'claude', feature: 'login', write: () => {}, intervalMs: 20 });
  const stopAll = await watchChat(root, { author: 'claude', write: () => {}, intervalMs: 20 });
  stopA(); stopAll();
  await postMessage(root, 'signup', { author: '사람', kind: 'human', body: '@claude 가입 쪽' }, { now: new Date(Date.now() + 1000) });
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '@claude 로그인 쪽' }, { now: new Date(Date.now() + 2000) });
  const onlyLogin = [];
  const stop1 = await watchChat(root, { author: 'claude', feature: 'login', write: (e) => onlyLogin.push(e), intervalMs: 20 });
  stop1();
  assert.deepEqual(onlyLogin.filter((e) => e.event === 'message').map((e) => e.message.body), ['@claude 로그인 쪽']);
  const all = [];
  const stop2 = await watchChat(root, { author: 'claude', write: (e) => all.push(e), intervalMs: 20 });
  stop2();
  assert.deepEqual(all.filter((e) => e.event === 'message').map((e) => e.message.body), ['@claude 가입 쪽', '@claude 로그인 쪽'], '로그인만 보던 감시가 전체 감시의 가입 쪽 메시지를 건너뛰게 하지 않는다');
});

test('watchChat: 시각이 거꾸로 적힌 메시지가 와도 읽음 위치를 되돌리지 않아 다시 시작할 때 중복이 없다', async (t) => {
  const root = await project(t, ['login']);
  const stop0 = await watchChat(root, { author: 'claude', write: () => {}, intervalMs: 20 });
  stop0();
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '@claude 나중' }, { now: new Date(Date.now() + 5000) });
  await postMessage(root, 'login', { author: 'codex', kind: 'codex', body: '@claude 시계가 늦은 세션' }, { now: new Date(Date.now() + 2000) });
  const first = [];
  const stop1 = await watchChat(root, { author: 'claude', write: (e) => first.push(e), intervalMs: 20 });
  stop1();
  assert.deepEqual(first.map((e) => e.message.body), ['@claude 시계가 늦은 세션', '@claude 나중']);
  const again = [];
  const stop2 = await watchChat(root, { author: 'claude', write: (e) => again.push(e), intervalMs: 20 });
  stop2();
  assert.equal(again.length, 0);
});
