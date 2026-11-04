import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAttention, deriveDecisions, paginateTimeline, deriveTimelineFlow } from '../web/dashboard-model.mjs';
import { createLatestRefresh } from '../web/dashboard-refresh.mjs';

const proof = (id, feature, phase, passed, at) => ({ id, feature, phase, passed, at, type: 'proof', proof: 'test', detail: `command ${id}` });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('attention prioritizes current blocked tasks, historical failures, then oldest unresolved questions without mutation', () => {
  const day = {
    tasks: [
      { id: 'old', feature: 'a', to: 'Claude', status: 'done', at: '2026-01-01', note: 'done' },
      { id: 'task', feature: 'a', to: 'Claude', status: 'blocked', at: '2026-10-15', note: 'original', updates: [{ at: '2026-10-16', note: 'missing fixture' }] },
    ],
    events: [proof('failure', 'a', 'test', false, '2026-10-15T10:00Z')],
    openQuestions: [
      { id: 'q2', feature: 'a', author: 'Codex', at: '2026-10-15', body: 'new' },
      { id: 'q1', feature: 'a', author: 'Codex', at: '2025-01-01', body: 'older than selected day' },
    ],
  };
  const before = structuredClone(day);
  const attention = deriveAttention(day);
  assert.deepEqual(attention.map((item) => item.recordId), ['task', 'failure', 'q1', 'q2']);
  assert.deepEqual(attention.map((item) => item.target), ['tasks', 'timeline', 'questions', 'questions']);
  assert.equal(attention[0].detail, 'missing fixture');
  assert.equal(attention[1].title, '테스트 실패 기록 · test');
  assert.equal(attention[2].detail, 'older than selected day');
  assert.equal(deriveAttention(day, { limit: 2 }).length, 2);
  assert.deepEqual(deriveAttention(day, { feature: 'absent' }), []);
  assert.deepEqual(day, before);
});

test('later passing evidence suppresses only failures for the same feature and phase', () => {
  const day = { events: [
    proof('fixed', 'a', 'test', false, '2026-10-15T10:00Z'),
    proof('pass', 'a', 'test', true, '2026-10-15T11:00Z'),
    proof('regressed', 'a', 'test', false, '2026-10-15T12:00Z'),
    proof('other-phase', 'a', 'review', false, '2026-10-15T10:00Z'),
    proof('other-feature', 'b', 'test', false, '2026-10-15T10:00Z'),
  ] };
  assert.deepEqual(deriveAttention(day).map((item) => item.recordId).sort(), ['other-feature', 'other-phase', 'regressed']);
  assert.deepEqual(deriveAttention(day, { feature: 'a' }).map((item) => item.recordId).sort(), ['other-phase', 'regressed']);
  assert.equal(day.events.length, 5, 'all attempts remain in timeline');
});

test('attention deduplicates only matching kind, feature and source record', () => {
  const a = { id: 'same', feature: 'a', author: 'Claude', at: '2026-01-01', body: 'question' };
  const b = { ...a, feature: 'b' };
  const day = { openQuestions: [a, a, b], events: [proof('same', 'a', 'test', false, '2026-10-15')] };
  assert.equal(deriveAttention(day).length, 3);
  assert.equal(new Set(deriveAttention(day).map((item) => item.id)).size, 3);
});

test('decision extraction returns original source events newest first with stable feature filtering', () => {
  const older = { id: '1', type: 'message', feature: 'a', messageType: 'decision', at: '2026-10-14' };
  const recent = { id: '2', type: 'note', feature: 'a', noteType: 'decision', at: '2026-10-15' };
  const foreign = { ...recent, feature: 'b' };
  const events = [recent, older, foreign, { id: '3', type: 'note', noteType: 'opinion', feature: 'a', at: '2026-10-16' }];
  const day = { events };
  const decisions = deriveDecisions(day, { feature: 'a' });
  assert.deepEqual(decisions, [recent, older]);
  assert.equal(decisions[0], recent);
  assert.deepEqual(day.events, events);
  assert.deepEqual(deriveDecisions(day, { limit: 1 }), [recent]);
});

test('refresh coalesces same date and ignores delayed older responses', async () => {
  const a = deferred(), b = deferred(), calls = [], applied = [], pending = [];
  const refresh = createLatestRefresh({ load: (date) => { calls.push(date); return date === 'a' ? a.promise : b.promise; }, apply: (value, date) => applied.push([value, date]), onPending: (...args) => pending.push(args) });
  const first = refresh.refresh('a');
  assert.equal(refresh.refresh('a'), first);
  const latest = refresh.refresh('b');
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b']);
  b.resolve('new');
  assert.equal((await latest).status, 'applied');
  a.resolve('old');
  assert.equal((await first).status, 'stale');
  assert.deepEqual(applied, [['new', 'b']]);
  assert.deepEqual(pending.at(-1), [false, 'b']);
});

test('current refresh errors preserve caller state and stale errors stay silent', async () => {
  const old = deferred(), current = deferred(), errors = [];
  let value = 'last good';
  const refresh = createLatestRefresh({ load: (date) => date === 'old' ? old.promise : current.promise, apply: (next) => { value = next; }, onError: (error, date) => errors.push([error.message, date]) });
  const first = refresh.refresh('old'), latest = refresh.refresh('current');
  current.reject(new Error('current failure'));
  assert.equal((await latest).status, 'error');
  old.reject(new Error('stale failure'));
  assert.equal((await first).status, 'stale');
  assert.equal(value, 'last good');
  assert.deepEqual(errors, [['current failure', 'current']]);
});

test('returning to an in-flight date reuses its load and makes it latest again; stop ignores pending results', async () => {
  const a = deferred(), b = deferred(), calls = [], applied = [];
  const refresh = createLatestRefresh({ load: (date) => { calls.push(date); return date === 'a' ? a.promise : b.promise; }, apply: (value) => applied.push(value) });
  const first = refresh.refresh('a'), other = refresh.refresh('b');
  assert.equal(refresh.refresh('a'), first);
  a.resolve('a');
  assert.equal((await first).status, 'applied');
  assert.deepEqual(calls, ['a', 'b']);
  refresh.stop();
  b.resolve('b');
  assert.equal((await other).status, 'stale');
  assert.deepEqual(applied, ['a']);
  assert.equal((await refresh.refresh('c')).status, 'stale');
});


test('timeline pages cover every filtered record once and clamp after records disappear', () => {
  const events = Array.from({ length: 45 }, (_, i) => ({ id: String(45 - i) }));
  const pages = [1, 2, 3].map((page) => paginateTimeline(events, { page }));
  assert.deepEqual(pages.map((p) => p.items.length), [20, 20, 5]);
  assert.deepEqual(pages.flatMap((p) => p.items), events);
  assert.deepEqual([pages[1].start, pages[1].end, pages[1].pages], [21, 40, 3]);
  assert.equal(paginateTimeline(events.slice(0, 3), { page: 3 }).page, 1);
  assert.equal(paginateTimeline(events, { page: -1 }).page, 1);
  assert.equal(paginateTimeline([], { page: 9 }).start, 0);
  assert.equal(paginateTimeline([], { page: 9 }).pages, 1);
});

test('linked evidence opens the page containing the record, including the last page', () => {
  const events = Array.from({ length: 45 }, (_, i) => ({ id: String(i) }));
  assert.equal(paginateTimeline(events, { recordId: '40' }).page, 3);
  assert.equal(paginateTimeline(events, { recordId: '20' }).items[0], events[20]);
  assert.equal(paginateTimeline(events, { page: 2, recordId: 'absent' }).page, 2);
});


test('flow preserves every source event, separates projects and puts unknown phases in other', () => {
  const events = [{ id: 'a', feature: 'one', phase: 'implement', passed: false },
    { id: 'b', feature: 'two', phase: 'implement' }, { id: 'c', phase: 'any' },
    { id: 'd', feature: 'one', phase: 'done' }];
  const before = structuredClone(events), groups = deriveTimelineFlow(events);
  assert.deepEqual(groups.map((group) => group.feature), ['one', 'two', null]);
  assert.equal(groups[0].stages.find((stage) => stage.phase === 'implement').events[0], events[0]);
  assert.deepEqual(groups[0].stages.find((stage) => stage.phase === 'other').events, [events[3]]);
  assert.equal(groups.flatMap((group) => group.stages.flatMap((stage) => stage.events)).length, events.length);
  assert.deepEqual(events, before);
  assert.deepEqual(deriveTimelineFlow([]), []);
});
