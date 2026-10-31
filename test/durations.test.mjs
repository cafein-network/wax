import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { phaseDurations } from '../src/durations.mjs';
import { createFeature } from '../src/workflow.mjs';
import { collectDay } from '../src/chat/daily.mjs';
import { durationItems, formatDuration } from '../web/dashboard-model.mjs';
import { message, translate } from '../web/locale-core.mjs';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const ev = (action, phase, ms, extra = {}) => ({ action, phase, at: at(ms), ...extra });

test('phase durations add each phase from entry to completion and count the open phase up to now', () => {
  const feature = { history: [
    ev('create', 'plan', 0), ev('save', 'plan', 10 * MIN), ev('complete', 'plan', 30 * MIN),
    ev('complete', 'design', HOUR), ev('attach-evidence', 'implement', 2 * HOUR),
  ] };
  const result = phaseDurations(feature, T0 + 3 * HOUR + 30 * MIN);
  assert.deepEqual(result, {
    phases: { plan: { ms: 30 * MIN, visits: 1 }, design: { ms: 30 * MIN, visits: 1 }, implement: { ms: 2.5 * HOUR, visits: 1 } },
    inProgress: 'implement', totalMs: 3.5 * HOUR,
  });
});

test('iterations add every visit to the same phase and a finished task has no open phase', () => {
  const feature = { history: [
    ev('create', 'plan', 0), ev('complete', 'plan', HOUR), ev('complete', 'design', 2 * HOUR),
    ev('complete', 'implement', 4 * HOUR),
    ev('archive', 'review', 5 * HOUR, { iteration: 0 }), ev('iterate', 'review', 5 * HOUR),
    ev('complete', 'implement', 6 * HOUR),
    ev('complete', 'review', 6.5 * HOUR), ev('complete', 'report', 7 * HOUR),
  ] };
  const result = phaseDurations(feature, T0 + 100 * HOUR);
  assert.equal(result.inProgress, null);
  assert.deepEqual(result.phases.implement, { ms: 3 * HOUR, visits: 2 });
  assert.deepEqual(result.phases.review, { ms: 1.5 * HOUR, visits: 2 });
  assert.deepEqual(result.phases.report, { ms: 0.5 * HOUR, visits: 1 });
  assert.equal(result.totalMs, 7 * HOUR);
});

test('archived time is not counted and restoring resumes the open phase', () => {
  const feature = { history: [
    ev('create', 'plan', 0), ev('archive-feature', 'plan', HOUR), ev('restore', 'plan', 10 * HOUR), ev('complete', 'plan', 11 * HOUR),
  ] };
  assert.equal(phaseDurations(feature, T0 + 12 * HOUR).phases.plan.ms, 2 * HOUR);
  const archived = { history: feature.history.slice(0, 2) };
  assert.deepEqual(phaseDurations(archived, T0 + 50 * HOUR), { phases: { plan: { ms: HOUR, visits: 1 } }, inProgress: null, totalMs: HOUR });
});

test('imports skip the gap between the last source event and the import', () => {
  const feature = { history: [
    ev('create', 'plan', 0), ev('save', 'plan', HOUR), ev('import', 'plan', 30 * 24 * HOUR, { sourceId: 'old' }),
  ] };
  const result = phaseDurations(feature, T0 + 30 * 24 * HOUR + 2 * HOUR);
  assert.deepEqual(result.phases.plan, { ms: 3 * HOUR, visits: 1 });
  assert.equal(result.inProgress, 'plan');
});

test('legacy and damaged histories never throw and skip unusable spans', () => {
  for (const feature of [undefined, null, {}, { history: 'x' }, { history: [null, 1, 'a'] }]) {
    assert.deepEqual(phaseDurations(feature, T0), { phases: {}, inProgress: null, totalMs: 0 });
  }
  const feature = { history: [
    { action: 'save', phase: 'design', at: 'not a date' }, ev('save', 'design', HOUR), { action: 'complete', phase: 'design' },
    ev('complete', 'design', 0), ev('complete', 'design', 2 * HOUR), ev('complete', 'bogus', 3 * HOUR), ev('unknown', 'done', 4 * HOUR),
  ] };
  const result = phaseDurations(feature, T0 + 5 * HOUR);
  assert.deepEqual(result.phases.design, { ms: HOUR, visits: 1 });
  assert.deepEqual(result.phases.implement, { ms: 3 * HOUR, visits: 1 });
  assert.equal(result.inProgress, 'implement');
  assert.equal(result.totalMs, 4 * HOUR);
  assert.deepEqual(phaseDurations({ history: [ev('create', 'plan', HOUR)] }, T0), { phases: { plan: { ms: 0, visits: 1 } }, inProgress: null, totalMs: 0 });
});

test('durations format compactly in Korean and English', () => {
  assert.equal(formatDuration(0), '1분 미만');
  assert.equal(formatDuration(NaN), '1분 미만');
  assert.equal(formatDuration(5 * MIN + 59_000), '5분');
  assert.equal(formatDuration(2 * HOUR), '2시간 0분');
  assert.equal(formatDuration(2 * HOUR + 10 * MIN), '2시간 10분');
  assert.equal(formatDuration(26 * HOUR), '1일 2시간');
  assert.equal(formatDuration(48 * HOUR), '2일 0시간');
  assert.equal(message('en', 'dashboard.durationHoursMinutes', 2, 10), '2h 10m');
  assert.equal(translate('20분째'), '20 min so far');
  assert.equal(translate('합계 1일 2시간'), 'Total 1d 2h');
  const items = durationItems({ phases: { plan: { ms: HOUR, visits: 1 }, design: { ms: 0, visits: 1 }, implement: { ms: 20 * MIN, visits: 2 } }, inProgress: 'implement', totalMs: HOUR + 20 * MIN });
  assert.deepEqual(items, [
    { phase: 'plan', inProgress: false, text: '1시간 0분' },
    { phase: 'implement', inProgress: true, text: '20분째' },
    { phase: 'total', text: '합계 1시간 20분' },
  ]);
  assert.deepEqual(durationItems({ phases: { plan: { ms: 5_000, visits: 1 } }, inProgress: 'plan', totalMs: 5_000 }).map((item) => item.text), ['방금 시작', '합계 1분 미만']);
  assert.deepEqual(durationItems(undefined), []);
});

test('status <id> and the dashboard day include durations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wax-durations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createFeature(root, { id: 'timed', title: '시간 측정', projectType: 'general' });
  const status = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '../bin/wax.mjs'), 'status', 'timed', '--project', root], { encoding: 'utf8' }));
  assert.equal(status.durations.inProgress, 'plan');
  assert.equal(status.durations.phases.plan.visits, 1);
  assert.ok(status.durations.totalMs >= 0);
  const day = await collectDay(root, undefined);
  assert.equal(day.features[0].durations.inProgress, 'plan');
  const stored = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '../bin/wax.mjs'), 'status', '--project', root], { encoding: 'utf8' }));
  assert.equal(stored[0].durations, undefined);
});

test('a completion recorded on done does not reopen the plan phase', () => {
  const result = phaseDurations({ history: [ev('create', 'plan', 0), ev('complete', 'done', HOUR)] }, T0 + 2 * HOUR);
  assert.deepEqual(result, { phases: { plan: { ms: 0, visits: 1 } }, inProgress: null, totalMs: 0 });
});
