import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeInbox } from '../web/office/inbox.mjs';

test('office inbox counts incoming messages once, scopes IDs by channel and excludes the dashboard user', () => {
  const inbox = new OfficeInbox();
  const message = { id: 'm-000001-123abc', author: 'claude' };
  assert.equal(inbox.receive('general', message, '사용자'), true);
  assert.equal(inbox.receive('general', message, '사용자'), false);
  inbox.receive('feature', message, '사용자');
  inbox.receive('general', { id: 'human-message', author: '사용자' }, '사용자');
  inbox.receive('general', { id: 'codex-message', author: 'codex' }, '사용자');
  assert.equal(inbox.count(), 3);
  assert.equal(inbox.count('claude'), 2);
  assert.equal(inbox.count('codex'), 1);
  assert.equal(inbox.count('사용자'), 0);
  assert.equal(inbox.channelFor('claude'), 'feature');
});

test('reading one channel clears only that channel and a replay does not restore the badge', () => {
  const inbox = new OfficeInbox();
  const message = { id: 'm-000001-123abc', author: 'claude' };
  inbox.receive('general', message, '사용자');
  inbox.receive('feature', message, '사용자');
  inbox.read('general');
  assert.equal(inbox.count(), 1);
  assert.equal(inbox.channelFor(), 'feature', '토스트를 놓쳐도 상단 메시지 버튼에서 안 읽은 채널을 찾는다');
  assert.equal(inbox.receive('general', message, '사용자'), false);
  inbox.read('feature');
  assert.equal(inbox.count(), 0);
  assert.equal(inbox.channelFor('claude'), undefined);
  inbox.receive('feature', { ...message, id: 'new-message' }, '사용자');
  assert.equal(inbox.count('claude'), 1);
});


test('iframe이 먼저 읽은 메시지는 늦게 도착한 사무실 SSE에서도 토스트·안 읽음으로 돌아오지 않는다', () => {
  const inbox = new OfficeInbox();
  inbox.read('checkout', ['first']);
  assert.equal(inbox.receive('checkout', { id: 'first', author: 'claude' }, '사용자'), false);
  assert.equal(inbox.count(), 0);
  assert.equal(inbox.receive('checkout', { id: 'later', author: 'claude' }, '사용자'), true);
  inbox.read('checkout', ['first']);
  assert.equal(inbox.count('claude'), 1, '아직 화면에 표시하지 않은 새 메시지는 읽음 처리하지 않는다');
  inbox.read('checkout', ['later']);
  assert.equal(inbox.count(), 0);
});


test('같은 작성자의 다른 채널이 안 읽음이어도 열람한 토스트 메시지는 읽음으로 구분한다', () => {
  const inbox = new OfficeInbox();
  inbox.receive('checkout', { id: 'a', author: 'claude' }, '사용자');
  inbox.receive('review', { id: 'b', author: 'claude' }, '사용자');
  inbox.read('checkout', ['a']);
  assert.equal(inbox.count('claude'), 1);
  assert.equal(inbox.isUnread('checkout', 'a'), false);
  assert.equal(inbox.isUnread('review', 'b'), true);
});
