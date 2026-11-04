import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { project } from './chat-helpers.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { startBeat } from '../src/chat/listeners.mjs';
import { recordHostEvent } from '../src/chat/host-state.mjs';
import { postRecipients, recipientLines, setPm } from '../src/chat/team.mjs';
import { run } from '../src/chat/cli.mjs';
import { cliText } from '../src/cli-locale.mjs';

async function team(t) {
  const root = await project(t, ['login', 'other']);
  await joinPresence(root, { author: 'alice', kind: 'claude' });
  await joinPresence(root, { author: 'bob', kind: 'claude', hostSession: 'host-bob' });
  await joinPresence(root, { author: 'dave', kind: 'codex' });
  await recordHostEvent(root, { session: 'host-bob', event: 'Stop' }, { now: Date.now(), env: {} });
  for (const [name, feature] of [['alice', null], ['dave', 'other']]) {
    const stop = await startBeat(root, name, feature, 60_000, () => {});
    t.after(stop);
  }
  return root;
}
const reach = async (root, input) => postRecipients(root, await postMessage(root, 'login', { author: 'me', ...input }));
async function chat(root, args, env = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let out = ''; stdout.on('data', (chunk) => { out += chunk; });
  const code = await run(['--project', root, ...args], { cwd: root, env: { WAX_LANG: 'ko', ...env }, stdout, stderr });
  return { code, out: out.trimEnd() };
}

test('listening, not listening, unknown and host state for each recipient', async (t) => {
  const root = await team(t);
  const result = await reach(root, { to: ['alice', 'ghost'], body: '@bob @dave 확인 부탁 @me' });
  assert.deepEqual(result, { storedOnly: false, recipients: [
    { name: 'alice', member: true, listening: true, host: null },
    { name: 'ghost', member: false, listening: false, host: null },
    { name: 'bob', member: true, listening: false, host: 'done-unseen' },
    { name: 'dave', member: true, listening: false, host: null },
  ] }, 'the author is never its own recipient');
  assert.deepEqual(await reach(root, { to: ['bob'], body: '초안 확인' }), { storedOnly: true, recipients: [{ name: 'bob', member: true, listening: false, host: 'done-unseen' }] });
  assert.deepEqual(await reach(root, { body: '받는 사람 없음 @codex' }), { storedOnly: false, recipients: [] }, 'no recipients, and an unjoined @name in the body is not guessed');
  await setPm(root, { author: 'pm-only', kind: 'codex' });
  assert.deepEqual((await reach(root, { to: ['pm-only'], body: '질문' })).recipients, [{ name: 'pm-only', member: true, listening: false, host: null }], 'the PM counts as a team member');
  await recordHostEvent(root, { session: 'host-bob', event: 'SessionEnd' }, { now: Date.now(), env: {} });
  assert.equal((await reach(root, { to: ['bob'], body: '끝난 세션' })).recipients[0].host, 'away');
});

test('recipient lines: one line plus the stored-only hint, nothing without recipients', () => {
  const ko = cliText('ko').say, en = cliText('en').say;
  const value = { storedOnly: true, recipients: [{ name: 'bob', member: true, listening: false, host: 'done-unseen' }, { name: 'ghost', member: false, listening: false, host: null }] };
  assert.deepEqual(recipientLines(value, ko), ['받는 사람: bob(지금 듣고 있지 않음 · 자동 상태 끝남(안 봄)), ghost(참여한 적 없는 이름)',
    '저장만 됨: 받는 세션이 지금 듣고 있지 않아 깨우지 않습니다. 사람에게 알리거나 `wax chat wait`를 쓰세요']);
  assert.deepEqual(recipientLines(value, en), ['Recipients: bob(Not listening now · Auto state Done (unseen)), ghost(Unknown name (never joined))',
    'Stored only: no recipient session is listening now, so none was woken. Tell a person or use `wax chat wait`.']);
  assert.deepEqual(recipientLines({ storedOnly: false, recipients: [{ name: 'alice', member: true, listening: true, host: 'working' }] }, ko), ['받는 사람: alice(듣는 중 · 자동 상태 작업 중)']);
  assert.deepEqual(recipientLines({ storedOnly: false, recipients: [{ name: 'bob', member: true, listening: false, host: 'away' }] }, en), ['Recipients: bob(Not listening now · Auto state Session ended)']);
  assert.deepEqual(recipientLines({ storedOnly: false, recipients: [] }, ko), []);
});

test('wax chat post prints recipient state in Korean and English, and --json carries it', async (t) => {
  const root = await team(t);
  const ko = await chat(root, ['post', 'login', '--author', 'me', '--to', 'bob', '--message', '초안 확인']);
  assert.equal(ko.code, 0);
  const [id, ...rest] = ko.out.split('\n');
  assert.match(id, /^m-\d{6}-[0-9a-f]{6}$/, 'the message ID stays on the first line');
  assert.deepEqual(rest, ['받는 사람: bob(지금 듣고 있지 않음 · 자동 상태 끝남(안 봄))', '저장만 됨: 받는 세션이 지금 듣고 있지 않아 깨우지 않습니다. 사람에게 알리거나 `wax chat wait`를 쓰세요']);
  const en = await chat(root, ['post', 'login', '--author', 'me', '--to', 'alice', '--message', 'check'], { WAX_LANG: 'en' });
  assert.deepEqual(en.out.split('\n').slice(1), ['Recipients: alice(Listening)']);
  const json = JSON.parse((await chat(root, ['post', 'login', '--author', 'me', '--to', 'ghost', '--message', 'x', '--json'])).out);
  assert.equal(json.body, 'x');
  assert.deepEqual([json.recipients, json.storedOnly], [[{ name: 'ghost', member: false, listening: false, host: null }], true]);
  const none = await chat(root, ['post', 'login', '--author', 'me', '--message', '모두에게']);
  assert.match(none.out, /^m-\d{6}-[0-9a-f]{6}$/, 'no recipients: only the ID, as before');
});
