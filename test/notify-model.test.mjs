import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeModel, noticeUrl, titleWithCount, REPLAY_SLACK_MS } from '../web/notify-model.mjs';

function setup({ offset = 0 } = {}) {
  let clock = Date.parse('2026-10-31T10:00:00Z');
  const model = createNoticeModel({ user: '대표', offset, now: () => clock });
  return { model, tick: (ms) => { clock += ms; }, at: (ms = 0) => new Date(clock + offset + ms).toISOString() };
}
const question = (id, at, extra = {}) => ({ channel: 'general', message: { id, at, author: 'claude-1', kind: 'claude', type: 'question', body: '어느 쪽으로 할까요?', ...extra } });
const approval = (id, status = 'pending', expiresAt = Date.parse('2026-10-31T11:00:00Z')) => ({ id, status, expiresAt, tool: 'codex', action: 'Bash', details: { command: 'npm test' } });
const live = (model, data = {}) => { const at = model.connected(); model.baseline(data, at); };

test('only questions from someone else notify, and only while the tab is hidden', () => {
  const { model, at } = setup();
  live(model);
  assert.equal(model.message(question('m-000001-aaaaaa', at()), true).kind, 'question');
  assert.equal(model.message(question('m-000002-aaaaaa', at(), { type: 'message' }), true), null, 'plain message');
  assert.equal(model.message(question('m-000003-aaaaaa', at(), { type: 'answer' }), true), null, 'answer');
  assert.equal(model.message(question('m-000004-aaaaaa', at(), { author: '대표', kind: 'human' }), true), null, 'the viewer wrote it');
  assert.equal(model.message(question('m-000005-aaaaaa', at(), { author: '대표' }), true), null, 'own name');
  assert.equal(model.message(question('m-000006-aaaaaa', at()), false), null, 'tab visible');
  assert.equal(model.message(question('m-000006-aaaaaa', at()), true), null, 'seen while visible stays seen');
  assert.equal(model.pending, 1);
  model.viewed();
  assert.equal(model.pending, 0);
});

test('the same message, approval or phase is notified once even when the stream repeats it', () => {
  const { model, at } = setup();
  live(model, { features: [{ id: 'login', phase: 'plan', updatedAt: '1' }] });
  assert.ok(model.message(question('m-000001-bbbbbb', at()), true));
  assert.equal(model.message(question('m-000001-bbbbbb', at()), true), null);
  assert.equal(model.approvals([approval('ap-1')], true).length, 1);
  assert.equal(model.approvals([approval('ap-1'), approval('ap-2', 'decided')], true).length, 0, 'still pending, or already decided');
  const advanced = [{ id: 'login', title: '로그인', phase: 'design', updatedAt: '2' }];
  assert.deepEqual(model.features(advanced, true).map((n) => [n.kind, n.feature, n.phase, n.next]), [['phase', 'login', 'plan', 'design']]);
  assert.equal(model.features(advanced, true).length, 0);
  assert.equal(model.pending, 3);
});

test('phases notify only when they move forward; iterate and new work stay quiet', () => {
  const { model } = setup();
  live(model, { features: [{ id: 'a', phase: 'review', updatedAt: '1' }] });
  assert.equal(model.features([{ id: 'a', phase: 'implement', updatedAt: '2' }], true).length, 0, 'iterate goes back');
  assert.equal(model.features([{ id: 'b', phase: 'design', updatedAt: '1' }], true).length, 0, 'first sight of a feature');
  assert.equal(model.features([{ id: 'b', phase: 'design', updatedAt: '2' }], true).length, 0, 'same phase, new record');
  assert.equal(model.features([{ id: 'a', phase: 'review', updatedAt: '3' }], true)[0].phase, 'implement');
  assert.equal(model.features([{ id: 'a', phase: 'done', updatedAt: '4' }, { id: 'b', phase: 'implement', updatedAt: '3' }], true).length, 2, 'report → done counts');
});

test('approvals already waiting at load, expired ones and baseline items do not notify', () => {
  const { model, tick } = setup();
  live(model, { approvals: [approval('old')] });
  assert.equal(model.approvals([approval('old')], true).length, 0);
  assert.equal(model.approvals([approval('gone', 'pending', Date.parse('2026-10-31T09:00:00Z'))], true).length, 0, 'expired');
  tick(1000);
  assert.equal(model.approvals([approval('old'), approval('new')], true)[0].id, 'new');
});

test('nothing notifies until the baseline is in, and replayed history after a reconnect is skipped', () => {
  const { model, tick, at } = setup();
  const first = model.connected();
  assert.equal(model.message(question('m-000001-cccccc', at()), true), null);
  assert.equal(model.approvals([approval('during')], true).length, 0);
  model.baseline({}, first);
  assert.equal(model.message(question('m-000001-cccccc', at()), true), null, 'remembered from the replay');
  assert.equal(model.approvals([approval('during')], true).length, 0);
  tick(60_000);
  const second = model.connected();
  assert.equal(model.baseline({}, first), false, 'a stale baseline is ignored');
  assert.equal(model.settling, true);
  model.baseline({}, second);
  assert.equal(model.message(question('m-000002-cccccc', at(-REPLAY_SLACK_MS - 10_000)), true), null);
  assert.ok(model.message(question('m-000003-cccccc', at(-500)), true), 'written just before the stream opened is still live');
  assert.equal(model.pending, 1);
});

test('server clock offset is used for replay and expiry checks', () => {
  const { model, at } = setup({ offset: -3_600_000 });
  live(model);
  assert.ok(model.message(question('m-000001-dddddd', at()), true), 'server clock an hour behind the browser');
});

test('notification targets and the tab title count', () => {
  assert.equal(noticeUrl({ kind: 'question', channel: 'login', id: 'm-000001-aaaaaa' }), '/?channel=login#m-000001-aaaaaa');
  assert.equal(noticeUrl({ kind: 'approval', id: 'ap-1' }), '/?thread=a%3Aap-1');
  assert.equal(noticeUrl({ kind: 'approval', id: 'ap-1' }, { requestId: 'req-1' }), '/?thread=r%3Areq-1');
  assert.equal(noticeUrl({ kind: 'phase', feature: 'login' }), '/manage?feature=login');
  assert.equal(titleWithCount('wax 채널', 2), '(2) wax 채널');
  assert.equal(titleWithCount('(2) wax 채널', 3), '(3) wax 채널');
  assert.equal(titleWithCount('(3) wax 채널', 0), 'wax 채널');
});

test('a new trigger proposal or trigger notice notifies once; state-only updates and replayed ones stay quiet', () => {
  const { model, at, tick } = setup();
  live(model);
  const proposal = (id, when) => ({ proposal: { id, trigger: 'trg-a', name: '평일 점검', text: '오류 확인', at: when } });
  const first = model.proposal(proposal('proposal-1', at()), true);
  assert.deepEqual([first.kind, first.key, first.name, first.body], ['proposal', 'pr:proposal-1', '평일 점검', '오류 확인']);
  assert.equal(model.proposal(proposal('proposal-1', at()), true), null, 'same proposal');
  assert.equal(model.proposal({}, true), null, 'accepted, dismissed or expired: no proposal in the event');
  assert.equal(model.proposal(proposal('proposal-2', at()), false), null, 'tab visible');
  assert.equal(model.triggerNotice({ id: 'te-000001-aaaaaa', trigger: 'trg-b', name: '알림', text: '배포 확인', at: at() }, true).kind, 'trigger');
  tick(60_000);
  model.connected();
  model.baseline({});
  assert.equal(model.proposal(proposal('proposal-3', new Date(Date.parse(at()) - REPLAY_SLACK_MS - 1000).toISOString()), true), null, 'replayed after reconnect');
  assert.equal(noticeUrl({ kind: 'proposal', id: 'proposal-1' }), '/start#proposal-1');
  assert.equal(noticeUrl({ kind: 'trigger', id: 'te-1' }), '/manage#triggers-heading');
});

test('a new PM loop suggestion notifies once and opens its goal; state-only updates and replayed ones stay quiet', () => {
  const { model, at, tick } = setup();
  live(model);
  const event = (id, when) => ({ goal: 'goal-0000000a', suggestion: { id, key: 'f1:0:plan:assign:none', kind: 'assign', feature: 'f1', text: 'codex-a에게 배정합니다', at: when } });
  const first = model.pm(event('pd-000002-aaaaaa', at()), true);
  assert.deepEqual([first.kind, first.key, first.goal, first.feature, first.body], ['pm', 'pm:pd-000002-aaaaaa', 'goal-0000000a', 'f1', 'codex-a에게 배정합니다']);
  assert.equal(model.pm(event('pd-000002-aaaaaa', at()), true), null, 'same suggestion');
  assert.equal(model.pm({ goal: 'goal-0000000a' }, true), null, 'executed, dismissed or stopped: no suggestion in the event');
  assert.equal(model.pm(event('pd-000003-aaaaaa', at()), false), null, 'tab visible');
  tick(60_000);
  model.connected();
  model.baseline({});
  assert.equal(model.pm(event('pd-000004-aaaaaa', new Date(Date.parse(at()) - REPLAY_SLACK_MS - 1000).toISOString()), true), null, 'replayed after reconnect');
  assert.equal(noticeUrl({ kind: 'pm', goal: 'goal-0000000a' }), '/manage#goal-0000000a');
  assert.equal(noticeUrl({ kind: 'pm', goal: '"><x' }), '/manage#pm-loop-heading');
});
