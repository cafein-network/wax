import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { joinPresence, listPresence, setPresence } from '../src/chat/presence.mjs';
import { postMessage, readMessages } from '../src/chat/channels.mjs';
import { listListeners } from '../src/chat/listeners.mjs';
import { watchChat } from '../src/chat/watch.mjs';
import { addressed, deliveryHint, recipientOptions } from '../web/recipients-model.mjs';
import { at, project, createTestSymlink } from './chat-helpers.mjs';

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('시간 초과'); await new Promise((done) => setTimeout(done, 20)); }
};

test('peer: join이 세션 간 통신 이름을 남기고 presence·게시가 지우지 않는다', async (t) => {
  const root = await project(t, ['login']);
  const joined = await joinPresence(root, { author: 'claude-app', kind: 'claude', peer: 'wax-0f' }, at('2026-10-16T06:00:00Z'));
  assert.equal(joined.peer, 'wax-0f');
  await setPresence(root, { author: 'claude-app', session: joined.session, state: 'working', feature: 'login' }, at('2026-10-16T06:01:00Z'));
  await postMessage(root, 'login', { author: 'claude-app', session: joined.session, body: '질문', type: 'question' }, at('2026-10-16T06:02:00Z'));
  const [entry] = await listPresence(root, at('2026-10-16T06:03:00Z'));
  assert.deepEqual([entry.peer, entry.listening], ['wax-0f', false]);
  await assert.rejects(joinPresence(root, { author: 'claude-x', kind: 'claude', peer: 'bad name!' }), /세션 간 통신 이름/);
});

test('듣는 중: watch가 살아 있는 동안 표시되고 멈추면 사라진다', async (t) => {
  const root = await project(t, ['login']);
  await setPresence(root, { author: 'codex-app', kind: 'codex', state: 'idle' });
  const stop = await watchChat(root, { author: 'codex-app', write: () => {}, intervalMs: 20, wake: true });
  let stopped = false;
  t.after(() => stopped || stop());
  const [listening] = await listPresence(root);
  assert.equal(listening.listening, true);
  await stop(); stopped = true;
  await until(async () => !(await listListeners(root)).has('codex-app'));
  assert.equal((await listPresence(root))[0].listening, false);
});

test('듣는 중: 오래된 표시는 무시한다', async (t) => {
  const root = await project(t, ['login']);
  const stop = await watchChat(root, { author: 'claude-app', write: () => {}, intervalMs: 20, wake: true });
  t.after(stop);
  assert.equal((await listListeners(root, { now: new Date(Date.now() + 60_000) })).has('claude-app'), true);
  assert.equal((await listListeners(root, { now: new Date(Date.now() + 10 * 60_000) })).has('claude-app'), false);
});

test('받는 사람: 사람·나를 빼고 바로 답하는 세션부터, 보낸 뒤 전달 안내', () => {
  const presence = [
    { author: 'codex-app', kind: 'codex', effectiveState: 'idle', listening: false },
    { author: '대표', kind: 'human', effectiveState: 'idle', listening: false },
    { author: 'claude-app', kind: 'claude', effectiveState: 'working', listening: true, peer: 'wax-0f' },
    { author: 'gemini-app', kind: 'gemini', effectiveState: 'away', listening: false },
  ];
  const options = recipientOptions(presence, '대표');
  assert.deepEqual(options.map((o) => [o.author, o.reach]), [['claude-app', 'now'], ['codex-app', 'later'], ['gemini-app', 'away']]);
  assert.equal(options[0].peer, 'wax-0f');
  assert.match(deliveryHint([], options), /깨우지 않습니다/);
  assert.equal(deliveryHint(['claude-app', 'codex-app'], options), 'claude-app: 듣는 중이라 곧 답합니다. codex-app: 다음 wax 명령 때 확인합니다.');
});

test('명령: 모든 도구가 참여 후 듣기를 켜고, Claude만 세션 간 직접 알림을 쓴다', async () => {
  const claude = await readFile(new URL('../commands/plan.md', import.meta.url), 'utf8');
  const codex = await readFile(new URL('../skills/plan/SKILL.md', import.meta.url), 'utf8');
  for (const text of [claude, codex]) assert.match(text, /Listening: .*CLI chat watch --author <name> --wake/);
  assert.match(claude, /Peer messages: .*pass its "This session is <name>" as peer.*"wax: #<channel> <message ID> from <your agent name>"/);
  assert.match(claude, /Tools missing .*CLI chat join --json --author <name> --kind <kind> \(plus --model, --peer/);
  const cli = await readFile(new URL('../skills/plan/SKILL.md', import.meta.url), 'utf8');
  assert.doesNotMatch(codex, /Peer messages:/);
  assert.doesNotMatch(cli, /wax_join/, 'Codex keeps the CLI guidance');
});

test('리뷰 반영: 같은 이름의 감시 둘 중 하나가 끝나도 나머지는 계속 듣고, 작업별 감시는 그 채널에서만 바로 답함', async (t) => {
  const root = await project(t, ['login']);
  const all = await watchChat(root, { author: 'claude-app', write: () => {}, intervalMs: 20, wake: true });
  t.after(all);
  const scoped = await watchChat(root, { author: 'claude-app', feature: 'login', write: () => {}, intervalMs: 20, wake: true });
  await scoped();
  assert.deepEqual((await listListeners(root)).get('claude-app'), { features: null });
  await all();
  const only = await watchChat(root, { author: 'codex-app', feature: 'login', write: () => {}, intervalMs: 20, wake: true });
  t.after(only);
  await setPresence(root, { author: 'codex-app', kind: 'codex', state: 'idle' });
  const presence = await listPresence(root);
  assert.equal(recipientOptions(presence, '대표', 'login').find((o) => o.author === 'codex-app').reach, 'now');
  assert.equal(recipientOptions(presence, '대표', 'general').find((o) => o.author === 'codex-app').reach, 'later');
});

test('리뷰 반영: 전달 안내의 @이름 판정이 watch와 같다', () => {
  const options = [{ author: 'claude', reach: 'now' }, { author: 'claude-app', reach: 'later' }];
  assert.deepEqual(addressed({ body: '@claude-app 확인', to: [] }, options), ['claude-app']);
  assert.deepEqual(addressed({ body: 'mail@claude', to: [] }, options), []);
  assert.deepEqual(addressed({ body: '(@claude) 확인', to: ['claude-app'] }, options), ['claude-app', 'claude']);
});

test('리뷰 반영: 답변·결정에는 다시 답하지 않고, 처리한 ID는 watch·peer 공통으로 건너뛴다', async () => {
  const claude = await readFile(new URL('../commands/chat.md', import.meta.url), 'utf8');
  const codex = await readFile(new URL('../skills/chat/SKILL.md', import.meta.url), 'utf8');
  assert.match(codex, /Never reply to an answer, a decision or an acknowledgement/);
  assert.match(codex, /skip a line, from the watch or a peer message, whose ID you already handled/);
  assert.match(claude, /never reply to answers, decisions or acknowledgements/);
  assert.match(claude, /skipping IDs already handled from the watch or a peer message/);
  for (const text of [claude, codex]) assert.doesNotMatch(text, /\$\{kind/);
  assert.doesNotMatch(codex, /Peer messages|peer name/);
});

test('2차 리뷰: 터미널용 감시(--wake 없음)는 바로 답함으로 표시하지 않는다', async (t) => {
  const root = await project(t, ['login']);
  const stop = await watchChat(root, { author: 'codex-app', write: () => {}, intervalMs: 20 });
  t.after(stop);
  assert.equal((await listListeners(root)).has('codex-app'), false);
});

test('2차 리뷰: --feature는 경로가 될 수 없고, read --id는 그 메시지 하나만 돌려준다', async (t) => {
  const root = await project(t, ['login']);
  await assert.rejects(watchChat(root, { author: 'claude-app', feature: '../../victim', write: () => {} }), /채널 ID/);
  const first = await postMessage(root, 'login', { author: '사람', kind: 'human', body: '첫 질문', type: 'question' });
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '나중 메시지' });
  assert.deepEqual((await readMessages(root, 'login', { id: first.id })).messages.map((m) => m.body), ['첫 질문']);
  await assert.rejects(readMessages(root, 'login', { id: '../x' }), /메시지 ID/);
});

test('2차 리뷰: 긴 한글 이름도 표시를 남기고, 링크·큰 파일은 읽지 않으며, 멈춘 뒤 표시가 되살아나지 않는다', async (t) => {
  const root = await project(t, ['login']);
  const name = '가'.repeat(40);
  const stop = await watchChat(root, { author: name, write: () => {}, intervalMs: 20, wake: true, beatMs: 1 });
  assert.equal((await listListeners(root)).has(name), true);
  await new Promise((done) => setTimeout(done, 20));
  await stop();
  await new Promise((done) => setTimeout(done, 30));
  assert.equal((await listListeners(root)).has(name), false);
  const dir = join(root, '.wax', 'chat', 'listeners');
  await mkdir(dir, { recursive: true });
  const outside = join(root, 'outside.json');
  await writeFile(outside, JSON.stringify({ author: 'x', at: new Date().toISOString() }));
  if (!await createTestSymlink(t, outside, join(dir, `${'a'.repeat(32)}.link.json`))) return;
  await writeFile(join(dir, `${'b'.repeat(32)}.big.json`), JSON.stringify({ author: 'y', at: new Date().toISOString(), pad: 'z'.repeat(5000) }));
  const listeners = await listListeners(root);
  assert.equal(listeners.has('x') || listeners.has('y'), false);
  assert.ok((await readdir(dir)).every((file) => file.length < 100));
});

test('2차 리뷰: 0.12.0 이름의 읽음 위치를 이어받아 그 뒤 메시지를 먼저 전달한다', async (t) => {
  const root = await project(t, ['login']);
  const before = new Date(Date.now() - 1000).toISOString();
  const dir = join(root, '.wax', 'chat', 'watch');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Buffer.from('claude-app').toString('hex')}.json`), JSON.stringify({ schema: 1, author: 'claude-app', at: before, ids: [] }));
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: '@claude-app 놓친 질문', type: 'question' });
  const events = [];
  const stop = await watchChat(root, { author: 'claude-app', write: (e) => events.push(e), intervalMs: 20 });
  t.after(stop);
  assert.deepEqual(events.map((e) => e.message?.body), ['@claude-app 놓친 질문']);
});

test('3차 리뷰: 한글 34자 이름의 0.12.0 읽음 위치도 이어받는다', async (t) => {
  const root = await project(t, ['login']);
  const name = '가'.repeat(34);
  const dir = join(root, '.wax', 'chat', 'watch');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Buffer.from(name).toString('hex')}.json`), JSON.stringify({ schema: 1, author: name, at: new Date(Date.now() - 1000).toISOString(), ids: [] }));
  await postMessage(root, 'login', { author: '사람', kind: 'human', body: `@${name} 놓친 질문`, type: 'question' });
  const events = [];
  const stop = await watchChat(root, { author: name, write: (e) => events.push(e), intervalMs: 20 });
  t.after(stop);
  assert.equal(events.length, 1);
});

test('3차 리뷰: 듣는 중 표시는 쓰기가 한 번 실패해도 다음 주기에 회복한다', async (t) => {
  const root = await project(t, ['login']);
  const errors = [];
  const stop = await watchChat(root, { author: 'claude-app', write: () => {}, intervalMs: 20, wake: true, beatMs: 10, onError: (e) => errors.push(e) });
  let stopped = false;
  t.after(() => stopped || stop());
  const dir = join(root, '.wax', 'chat', 'listeners');
  await rename(dir, `${dir}.gone`);
  await until(async () => errors.length > 0);
  await mkdir(dir, { mode: 0o700 });
  await until(async () => (await listListeners(root)).has('claude-app'));
  await stop(); stopped = true;
});

test('실제 세션 테스트 반영: Claude 명령은 참여 전에 ListAgents로 자기 이름을 확인해 --peer로 남긴다', async () => {
  const claude = await readFile(new URL('../commands/join.md', import.meta.url), 'utf8');
  const codex = await readFile(new URL('../skills/join/SKILL.md', import.meta.url), 'utf8');
  assert.match(claude, /Peer messages: before joining, call ListAgents and pass its "This session is <name>" as peer/);
  assert.match(claude, /CLI chat join --json --author <name> --kind <kind> \(plus --model, --peer/);
  assert.doesNotMatch(codex, /ListAgents/);
});
