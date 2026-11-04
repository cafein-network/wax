import test from 'node:test';
import assert from 'node:assert/strict';
import { seenByMessage, waitingSessions } from '../web/session-wait-model.mjs';

const agent = (author, state, at, extra = {}) => ({ author, kind: 'claude', feature: null, host: { state, at, event: state === 'blocked' ? 'Notification' : 'Stop', ended: false }, ...extra });

test('waiting sessions: blocked first, then unseen done, each oldest first; others are left out', () => {
  const list = waitingSessions([
    agent('done-new', 'done', '2026-11-02T10:05:00Z'),
    agent('blocked-new', 'blocked', '2026-11-02T10:04:00Z'),
    agent('done-old', 'done', '2026-11-02T10:01:00Z', { feature: 'login' }),
    { ...agent('blocked-approval', 'blocked', '2026-11-02T10:02:00Z'), host: { state: 'blocked', at: '2026-11-02T10:02:00Z', event: 'PermissionRequest', detail: 'Bash', ended: false } },
    agent('working', 'working', '2026-11-02T10:00:00Z'),
    agent('ended', 'done', '2026-11-02T10:00:00Z', { host: { state: 'done', at: '2026-11-02T10:00:00Z', ended: true } }),
    agent('대표', 'done', '2026-11-02T10:00:00Z'),
    { author: 'no-hook', kind: 'codex' },
  ], '대표');
  assert.deepEqual(list.map((item) => item.author), ['blocked-approval', 'blocked-new', 'done-old', 'done-new']);
  assert.deepEqual([list[0].approval, list[0].detail, list[1].approval], [true, 'Bash', false]);
  assert.equal(list[2].feature, 'login');
});

test('a message to a done session counts as seeing it', () => {
  const presence = [agent('a', 'done', '2026-11-02T10:00:00Z'), agent('b', 'working', '2026-11-02T10:00:00Z')];
  assert.deepEqual(seenByMessage(presence, ['a', 'b', 'a', 'z']), ['a']);
});
