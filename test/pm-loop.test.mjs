import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, project } from './chat-helpers.mjs';
import {
  createGoal, createPmLoop, dismissSuggestion, evaluateGoals, executeSuggestion, featureDecisions, goalOverview, nextActions, pickAssignee, pmLoopOverview,
  readDecisions, resumeGoal, stopGoal, DEFAULT_BUDGETS,
} from '../src/chat/pm-loop.mjs';
import { assignTask, listTasks, setPm, updateTask } from '../src/chat/team.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { startBeat } from '../src/chat/listeners.mjs';
import { readMessages } from '../src/chat/channels.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { updateFeature } from '../src/workflow.mjs';

const NOW = Date.parse('2026-10-31T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const goal = (extra = {}) => ({ id: 'goal-0000000a', title: '목표', state: 'running', features: ['f1'], budgets: { ...DEFAULT_BUDGETS }, baseline: { f1: 0 }, startedAt: iso(NOW - 10 * MIN), ...extra });
const feature = (phase, extra = {}) => ({ id: 'f1', title: 'f1 작업', phase, iteration: 0, updatedAt: iso(NOW - 5 * MIN), completed: {}, history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }, ...(phase !== 'plan' ? [{ action: 'complete', phase: 'plan', at: iso(NOW - 20 * MIN) }] : [])], artifacts: {}, ...extra });
const session = (author, kind, extra = {}) => ({ author, kind, effectiveState: 'idle', listening: false, listeningFeatures: null, lastActive: iso(NOW - MIN), ...extra });
const task = (id, extra = {}) => ({ id, feature: 'f1', to: 'codex-a', phase: 'design', status: 'open', at: iso(NOW - 10 * MIN), statusAt: iso(NOW - 10 * MIN), updates: [], ...extra });
const run = (input) => nextActions({ goal: goal(), now: NOW, presence: [session('codex-a', 'codex', { listening: true })], ...input });
const only = (result) => { assert.equal(result.actions.length, 1); return result.actions[0]; };
const noTools = async () => [];
const mustNotRun = async () => { throw new Error('a real tool must not run in tests'); };

test('rule: a goal whose plan is not confirmed only asks a person to confirm it, never assigns', () => {
  const result = nextActions({ goal: goal({ state: 'planning', startedAt: null }), features: [feature('plan')], presence: [session('codex-a', 'codex', { listening: true })], now: NOW });
  assert.equal(result.state, 'planning');
  assert.deepEqual(result.suggestions.map((item) => [item.kind, item.human, item.executable]), [['confirm-plan', true, true]]);
  assert.equal(result.actions[0].kind, 'planned');
});

test('rule: with no open assignment only the current phase is suggested, never a future one', () => {
  for (const phase of ['plan', 'design', 'implement', 'report']) {
    const action = only(run({ features: [feature(phase)], tasks: [task('t-000001-aaaaaa', { phase: 'review' })] }));
    assert.equal(action.kind, 'assign');
    assert.equal(action.phase, phase);
  }
  const result = run({ features: [feature('implement')] });
  assert.ok(result.suggestions.every((item) => item.phase === 'implement'));
});

test('rule: listening sessions are preferred, then present sessions; with nobody a person starts a worker', () => {
  const presence = [session('aaa', 'codex'), session('zzz', 'claude', { listening: true }), session('mid', 'gemini', { listening: true, listeningFeatures: ['other'] }), session('대표', 'human', { listening: true })];
  const action = only(run({ features: [feature('design')], presence }));
  assert.deepEqual([action.kind, action.to, action.listening], ['assign', 'zzz', true]);
  assert.match(action.reason, /듣고 있는 세션 zzz/);
  const idle = only(run({ features: [feature('design')], presence: [session('aaa', 'codex'), session('gone', 'codex', { effectiveState: 'away' })] }));
  assert.deepEqual([idle.to, idle.listening], ['aaa', false]);
  assert.match(idle.reason, /\/wax:work/);
  const none = only(run({ features: [feature('design')], presence: [session('gone', 'codex', { effectiveState: 'away' }), session('대표', 'human')] }));
  assert.deepEqual([none.kind, none.human, none.executable], ['start-worker', true, false]);
});

test('rule: review goes to a different tool than the implementer; without one a person is asked', () => {
  const implemented = feature('review', { completed: { implement: { at: iso(NOW - 3 * MIN), evidence: 'x', author: 'codex-a' } },
    history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }, { action: 'complete', phase: 'implement', at: iso(NOW - 3 * MIN), author: 'codex-a', tool: 'codex' }] });
  const presence = [session('codex-a', 'codex', { listening: true }), session('codex-b', 'codex', { listening: true }), session('claude-a', 'claude')];
  const action = only(run({ features: [implemented], presence }));
  assert.deepEqual([action.kind, action.phase, action.to, action.toKind], ['assign', 'review', 'claude-a', 'claude'], 'a different tool beats a listening session of the same tool');
  assert.match(action.reason, /구현 도구\(codex\)와 다른 도구/);
  const ask = only(run({ features: [implemented], presence: presence.slice(0, 2) }));
  assert.deepEqual([ask.kind, ask.human, ask.sameTool], ['ask-reviewer', true, ['codex-b']]);
  const noTool = { ...implemented, history: implemented.history.map(({ tool, ...event }) => event) };
  assert.equal(only(run({ features: [noTool], presence })).to, 'claude-a');
  assert.equal(pickAssignee({ feature: noTool, phase: 'review', presence: [session('codex-a', 'codex'), session('codex-b', 'codex')] }).none, 'reviewer');
  const unknown = { ...noTool, completed: { implement: { at: iso(NOW), evidence: 'x', author: 'ghost' } } };
  const fallback = only(run({ features: [unknown], presence: [session('ghost', 'other'), session('codex-b', 'codex')] }));
  assert.deepEqual([fallback.kind, fallback.to], ['assign', 'codex-b']);
  assert.match(fallback.reason, /구현 도구 기록이 없어/);
});

test('rule: a done assignment with a completed phase moves on to the next phase', () => {
  const advanced = feature('implement', { history: [{ action: 'create', phase: 'plan', at: iso(NOW - 60 * MIN) }, { action: 'complete', phase: 'design', at: iso(NOW - 2 * MIN) }] });
  const done = task('t-000001-aaaaaa', { phase: 'design', status: 'done', updates: [{ status: 'done', at: iso(NOW - 2 * MIN) }] });
  const action = only(run({ features: [advanced], tasks: [done] }));
  assert.deepEqual([action.kind, action.phase], ['assign', 'implement']);
});

test('rule: done with a warning re-notifies once, waits, then hands to a person; a second warning goes straight to a person', () => {
  const warned = task('t-000001-aaaaaa', { status: 'done', at: iso(NOW - 9 * MIN), updates: [{ status: 'done', at: iso(NOW - 8 * MIN), warning: '단계가 완료되지 않았습니다' }] });
  const features = [feature('design')];
  const first = only(run({ features, tasks: [warned] }));
  assert.deepEqual([first.kind, first.to, first.task, first.executable], ['renotify', 'codex-a', warned.id, true]);
  const sent = [{ key: first.key, kind: 'renotify', outcome: 'executed', feature: 'f1', iteration: 0, phase: 'design', task: warned.id, at: iso(NOW - MIN) }];
  assert.equal(only(run({ features, tasks: [warned], decisions: sent })).kind, 'wait', 'waits for the session after the reminder');
  const later = only(nextActions({ goal: goal(), features, tasks: [warned], decisions: sent, now: NOW + 40 * MIN, presence: [session('codex-a', 'codex', { listening: true })] }));
  assert.deepEqual([later.kind, later.human, later.executable], ['escalate', true, false]);
  const handed = [...sent, { key: later.key, kind: 'escalate', outcome: 'dismissed', at: iso(NOW) }];
  const back = only(nextActions({ goal: goal(), features, tasks: [warned], decisions: handed, now: NOW + 40 * MIN, presence: [session('codex-a', 'codex', { listening: true })] }));
  assert.deepEqual([back.kind, back.phase], ['assign', 'design'], 'after the person takes over, the phase can be assigned again');
  const second = task('t-000002-bbbbbb', { status: 'done', at: iso(NOW - 2 * MIN), updates: [{ status: 'done', at: iso(NOW - MIN), warning: '또 미완료' }] });
  assert.equal(only(run({ features, tasks: [warned, second], decisions: sent })).kind, 'escalate');
});

test('rule: a blocked assignment goes to a person, who can reclaim it', () => {
  const blocked = task('t-000001-aaaaaa', { status: 'blocked', statusAt: iso(NOW - MIN), updates: [{ status: 'blocked', at: iso(NOW - MIN), note: 'API 키가 없음' }] });
  const action = only(run({ features: [feature('design')], tasks: [blocked] }));
  assert.deepEqual([action.kind, action.human, action.executable, action.note], ['blocked', true, true, 'API 키가 없음']);
});

test('rule: an assignment without activity for 30 minutes is suggested for reclaim; recent activity waits', () => {
  const quiet = task('t-000001-aaaaaa', { at: iso(NOW - 45 * MIN), statusAt: iso(NOW - 45 * MIN) });
  const old = feature('design', { updatedAt: iso(NOW - 50 * MIN) });
  const presence = [session('codex-a', 'codex', { listening: true, lastActive: iso(NOW - 40 * MIN) })];
  const action = only(run({ features: [old], tasks: [quiet], presence }));
  assert.deepEqual([action.kind, action.task, action.to], ['reclaim', quiet.id, 'codex-a']);
  assert.match(action.reason, /30분/);
  assert.equal(only(run({ features: [old], tasks: [quiet], presence: [{ ...presence[0], lastActive: iso(NOW - MIN) }] })).kind, 'wait');
  assert.equal(only(nextActions({ goal: goal(), features: [old], tasks: [quiet], presence, now: NOW, staleMs: 60 * MIN })).kind, 'wait', 'staleMs is configurable');
  const cancelled = { ...quiet, status: 'cancelled' };
  const next = only(run({ features: [old], tasks: [cancelled], presence }));
  assert.equal(next.kind, 'assign');
  assert.match(next.key, new RegExp(`${quiet.id}$`));
});

test('rule: after report the loop drafts a PR body and waits for a person; then the goal is done', () => {
  const done = feature('done');
  const draft = only(run({ features: [done] }));
  assert.deepEqual([draft.kind, draft.human, draft.executable], ['pr-body', true, true]);
  const made = [{ key: draft.key, kind: 'pr-body', outcome: 'executed', file: '.wax/chat/pm-loop/x.md', at: iso(NOW) }];
  const wait = run({ features: [done], decisions: made });
  assert.deepEqual([wait.actions[0].kind, wait.actions[0].file, wait.state], ['await-pr', '.wax/chat/pm-loop/x.md', 'waiting-human']);
  const finished = run({ features: [done], decisions: [...made, { key: wait.actions[0].key, outcome: 'executed', at: iso(NOW) }] });
  assert.deepEqual([finished.actions[0].kind, finished.state, finished.suggestions.length], ['finished', 'done', 0]);
});

test('rule: budgets stop the goal, workers cap new assignments, and stopped goals suggest nothing', () => {
  const runs = Array.from({ length: 15 }, (_, n) => ({ key: `k${n}`, kind: 'assign', outcome: 'executed', at: iso(NOW) }));
  const stopped = run({ features: [feature('design')], decisions: runs });
  assert.equal(stopped.state, 'stopped');
  assert.match(stopped.budget.exceeded, /단계 실행 한도 15번/);
  assert.deepEqual([stopped.actions[0].kind, stopped.suggestions.length], ['stopped', 0]);
  assert.match(run({ goal: goal({ startedAt: iso(NOW - 9 * 60 * MIN) }), features: [feature('design')] }).budget.exceeded, /시간 한도 8시간/);
  assert.match(run({ features: [feature('implement', { iteration: 4 })] }).budget.exceeded, /되돌리기 한도 3번/);
  const blocks = [1, 2, 3].map((n) => task(`t-00000${n}-aaaaaa`, { status: 'cancelled', at: iso(NOW - (10 - n) * MIN), updates: [{ status: 'blocked', at: iso(NOW) }, { status: 'cancelled', at: iso(NOW) }] }));
  assert.match(run({ features: [feature('design')], tasks: blocks }).budget.exceeded, /연속 3번 막혀/);
  const two = { ...goal({ features: ['f1', 'f2'], budgets: { ...DEFAULT_BUDGETS, workers: 1 } }) };
  const result = nextActions({ goal: two, features: [feature('design'), { ...feature('plan'), id: 'f2' }], presence: [session('codex-a', 'codex', { listening: true })], now: NOW });
  assert.deepEqual(result.actions.map((item) => item.kind), ['assign', 'wait-capacity']);
  const manual = nextActions({ goal: goal({ state: 'stopped', stoppedReason: '사람이 정지했습니다.' }), features: [feature('design')], now: NOW });
  assert.deepEqual([manual.state, manual.suggestions.length, manual.actions[0].reason], ['stopped', 0, '사람이 정지했습니다.']);
});

test('dedupe: an open assignment for the phase blocks a new one and decided keys are not suggested again', () => {
  const open = task('t-000001-aaaaaa', { phase: 'any', at: iso(NOW - MIN), statusAt: iso(NOW - MIN) });
  assert.equal(only(run({ features: [feature('design')], tasks: [open] })).kind, 'wait');
  const first = only(run({ features: [feature('design')] }));
  assert.equal(only(run({ features: [feature('design')] })).key, first.key, 'the key is stable');
  const dismissed = [{ key: first.key, outcome: 'dismissed', at: iso(NOW) }];
  const blocked = task('t-000001-aaaaaa', { status: 'blocked', updates: [{ status: 'blocked', at: iso(NOW), note: 'x' }] });
  const card = only(run({ features: [feature('design')], tasks: [blocked] }));
  assert.equal(only(run({ features: [feature('design')], tasks: [blocked], decisions: [...dismissed, { key: card.key, outcome: 'dismissed', at: iso(NOW) }] })).kind, 'wait');
});


async function setup(t, features = ['f1']) {
  const root = await project(t, features);
  await setPm(root, { author: '대표', kind: 'human' });
  const codex = await joinPresence(root, { author: 'codex-a', kind: 'codex' });
  const claude = await joinPresence(root, { author: 'claude-a', kind: 'claude' });
  return { root, codex, claude, sessions: { 'codex-a': codex.session, 'claude-a': claude.session } };
}
const dirSnapshot = async (dir) => {
  const out = {};
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const info = await stat(join(dir, name));
    if (info.isFile()) out[name] = await readFile(join(dir, name), 'utf8');
  }
  return out;
};
function wax(root, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--project', root, ...args], { cwd: root, env: { ...process.env, WAX_LANG: 'ko', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('goals: created in planning, confirmed by a person, executed and dismissed cards are logged with reasons', async (t) => {
  const { root } = await setup(t, ['f1', 'f2']);
  await assert.rejects(createGoal(root, { title: '빈 목표', features: [] }, { author: '대표' }), /하나 이상/);
  const created = await createGoal(root, { title: '로그인 마무리', features: ['f1'], create: [{ id: 'f3', title: '새 작업' }] }, { author: '대표' });
  assert.deepEqual([created.state, created.mode, created.features], ['planning', 'suggest', ['f1', 'f3']]);
  await assert.rejects(createGoal(root, { title: '겹침', features: ['f1'] }, { author: '대표' }), (error) => error.status === 409 && /이미 진행 중인 목표/.test(error.message));
  await assert.rejects(executeSuggestion(root, created.id, 'f1:0:plan:assign:none', { author: '대표' }), /이미 처리됐거나/, 'nothing but the plan confirmation exists while planning');
  await executeSuggestion(root, created.id, 'goal:confirm-plan', { author: '대표' });
  let view = await goalOverview(root, created.id, { user: '대표' });
  assert.equal(view.storedState, 'running');
  assert.ok(view.startedAt);
  const [first, second] = view.suggestions;
  assert.deepEqual([first.kind, second.kind], ['assign', 'assign']);
  const done = await executeSuggestion(root, created.id, first.key, { author: '대표' });
  const tasks = await listTasks(root);
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0].feature, tasks[0].phase, tasks[0].to, tasks[0].by], [first.feature, 'plan', first.to, '대표']);
  assert.match(tasks[0].note, new RegExp(`PM 루프 목표 ${created.id}`));
  assert.equal(done.decision.task, tasks[0].id);
  await assert.rejects(executeSuggestion(root, created.id, first.key, { author: '대표' }), (error) => error.status === 409, 'executing twice is refused');
  await dismissSuggestion(root, created.id, second.key, { author: '대표', reason: '나중에 직접' });
  view = await goalOverview(root, created.id, { user: '대표' });
  assert.equal(view.suggestions.length, 0);
  const log = await readDecisions(root, created.id);
  assert.deepEqual(log.filter((item) => ['executed', 'dismissed'].includes(item.outcome)).map((item) => [item.kind, item.outcome, item.by, Boolean(item.reason)]),
    [['confirm-plan', 'executed', '대표', true], ['assign', 'executed', '대표', true], ['assign', 'dismissed', '대표', true]]);
  assert.equal(log.find((item) => item.outcome === 'dismissed').reason, '나중에 직접');
  const trace = await buildRunTrace(root, first.feature, { language: 'ko' });
  assert.equal(trace.visits[0].pm[0].kind, 'assign');
  assert.match(trace.markdown, /PM 루프 .*assign 실행함/);
  assert.equal((await featureDecisions(root, first.feature)).length, 1);
});

test('executing follows the PM rules: a viewer who is not the PM cannot assign, and the failure is logged', async (t) => {
  const { root } = await setup(t);
  const goalRecord = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goalRecord.id, 'goal:confirm-plan', { author: '대표' });
  await setPm(root, { author: 'codex-a', kind: 'codex', replace: true });
  const [card] = (await goalOverview(root, goalRecord.id)).suggestions;
  await assert.rejects(executeSuggestion(root, goalRecord.id, card.key, { author: '대표' }), (error) => error.status === 403);
  assert.equal((await readDecisions(root, goalRecord.id)).at(-1).outcome, 'failed');
  assert.equal((await listTasks(root)).length, 0);
});

test('re-notify posts to the session and reclaim cancels the assignment', async (t) => {
  const { root, sessions } = await setup(t);
  const goalRecord = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goalRecord.id, 'goal:confirm-plan', { author: '대표' });
  const assigned = (await goalOverview(root, goalRecord.id)).suggestions[0];
  const { decision } = await executeSuggestion(root, goalRecord.id, assigned.key, { author: '대표' });
  await updateTask(root, decision.task, 'done', { author: decision.to, session: sessions[decision.to] });
  const renotify = (await goalOverview(root, goalRecord.id)).suggestions[0];
  assert.equal(renotify.kind, 'renotify');
  await executeSuggestion(root, goalRecord.id, renotify.key, { author: '대표' });
  const { messages } = await readMessages(root, 'f1');
  assert.deepEqual(messages.at(-1).to, [decision.to]);
  assert.match(messages.at(-1).body, new RegExp(`wax complete plan f1 --author ${decision.to}`));
  const later = Date.now() + 40 * MIN;
  const touch = async (at) => { for (const [author, session] of Object.entries(sessions)) await joinPresence(root, { author, session }, { now: new Date(at) }); };
  await touch(later);
  const reassign = (await goalOverview(root, goalRecord.id, { now: later })).suggestions[0];
  assert.equal(reassign.kind, 'escalate');
  await dismissSuggestion(root, goalRecord.id, reassign.key, { author: '대표', now: later });
  const again = (await goalOverview(root, goalRecord.id, { now: later })).suggestions[0];
  const second = await executeSuggestion(root, goalRecord.id, again.key, { author: '대표', now: later });
  const stale = (await goalOverview(root, goalRecord.id, { now: later + 31 * MIN })).suggestions[0];
  assert.deepEqual([stale.kind, stale.task], ['reclaim', second.decision.task]);
  await executeSuggestion(root, goalRecord.id, stale.key, { author: '대표', now: later + 31 * MIN });
  assert.equal((await listTasks(root, { all: true })).find((item) => item.id === second.decision.task).status, 'cancelled');
});

test('engine: suggestions are recorded once even from two engines, budgets stop the goal, and stop/resume are logged', async (t) => {
  const { root } = await setup(t);
  assert.deepEqual(await evaluateGoals(root), [], 'no goals, no lock files');
  const goalRecord = await createGoal(root, { title: '목표', features: ['f1'], budgets: { phaseRuns: 1 } }, { author: '대표' });
  const events = [[], []];
  const engines = events.map((list) => createPmLoop({ root, intervalMs: 20, listTools: noTools, notify: (type, data) => list.push([type, data]) }));
  t.after(() => Promise.all(engines.map((engine) => engine.close())));
  await Promise.all(engines.map((engine) => engine.start()));
  await executeSuggestion(root, goalRecord.id, 'goal:confirm-plan', { author: '대표' });
  for (const engine of engines) engine.poke();
  await Promise.all([engines[0].tick(), engines[1].tick(), engines[0].tick()]);
  const suggested = (await readDecisions(root, goalRecord.id)).filter((item) => item.outcome === 'suggested');
  assert.deepEqual(suggested.map((item) => item.kind), ['confirm-plan', 'assign'], 'one record per key');
  for (const list of events) assert.ok(list.some(([type, data]) => type === 'pm' && data.suggestion?.kind === 'assign'), 'each dashboard announces the new card');
  const { decision } = await executeSuggestion(root, goalRecord.id, suggested[1].key, { author: '대표' });
  engines[0].poke();
  await engines[0].tick();
  assert.equal((await goalOverview(root, goalRecord.id)).storedState, 'running', 'the last allowed assignment is still in progress');
  await updateTask(root, decision.task, 'cancel', { author: '대표', kind: 'human', body: '회수' });
  engines[0].poke();
  await engines[0].tick();
  let view = await goalOverview(root, goalRecord.id);
  assert.deepEqual([view.storedState, view.stoppedBy], ['stopped', 'pm-loop']);
  assert.match(view.stoppedReason, /단계 실행 한도 1번/);
  await resumeGoal(root, goalRecord.id, { author: '대표', budgets: { phaseRuns: 5 } });
  view = await goalOverview(root, goalRecord.id);
  assert.deepEqual([view.storedState, view.budgets.phaseRuns], ['running', 5]);
  await stopGoal(root, goalRecord.id, { author: '대표' });
  view = await goalOverview(root, goalRecord.id);
  assert.deepEqual([view.state, view.suggestions.length], ['stopped', 0]);
  assert.deepEqual((await readDecisions(root, goalRecord.id)).filter((item) => item.kind === 'goal').map((item) => item.outcome), ['created', 'stopped', 'resumed', 'stopped']);
  await assert.rejects(resumeGoal(root, goalRecord.id, { author: '대표', budgets: { workers: 99 } }), /1~10/);
});

test('CLI: list, show and next are read-only and next writes nothing', async (t) => {
  const { root } = await setup(t);
  const stop = await startBeat(root, 'codex-a', null, 60_000, () => {});
  t.after(stop);
  assert.match((await wax(root, ['pm-loop', 'list'])).stdout, /목표가 없습니다/);
  const goalRecord = await createGoal(root, { title: 'CLI 목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goalRecord.id, 'goal:confirm-plan', { author: '대표' });
  const dir = join(root, '.wax', 'chat');
  const before = await dirSnapshot(dir);
  const next = await wax(root, ['pm-loop', 'next', goalRecord.id]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /f1 {2}plan {2}assign → codex-a/);
  assert.match(next.stdout, /아무것도 기록하지 않았습니다/);
  const json = JSON.parse((await wax(root, ['pm-loop', 'next', goalRecord.id, '--json'])).stdout);
  assert.equal(json.suggestions[0].kind, 'assign');
  assert.match((await wax(root, ['pm-loop', 'show', goalRecord.id])).stdout, /CLI 목표[\s\S]*단계 실행 0\/15/);
  assert.match((await wax(root, ['pm-loop', 'list'])).stdout, new RegExp(`${goalRecord.id} {2}\\[running\\]`));
  assert.match((await wax(root, ['pm-loop', 'next', goalRecord.id], { WAX_LANG: 'en' })).stdout, /Computed only; nothing was recorded/);
  const after = await dirSnapshot(dir);
  delete before[Object.keys(before).find((name) => name.startsWith('listeners/'))];
  delete after[Object.keys(after).find((name) => name.startsWith('listeners/'))];
  assert.deepEqual(after, before, 'the CLI wrote nothing under .wax/chat');
  const bad = await wax(root, ['pm-loop', 'next']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /사용법: wax pm-loop/);
});

test('dashboard API: goals and decisions need the token, the server runs one engine and closes it', async (t) => {
  const root = await project(t, ['f1']);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: noTools, executeWorker: mustNotRun });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/pm-loop', { title: 'x', features: ['f1'] }, {})).status, 403);
  const created = await (await post('/api/pm-loop', { title: '대시보드 목표', features: ['f1'] })).json();
  assert.equal(created.state, 'planning');
  assert.equal((await post(`/api/pm-loop/${created.id}/execute`, { key: 'goal:confirm-plan' })).status, 200);
  const overview = await (await fetch(`${base}/api/pm-loop`)).json();
  assert.deepEqual([overview.goals[0].storedState, overview.user, overview.goals[0].canAssign], ['running', '대표', false]);
  assert.equal(overview.goals[0].suggestions[0].kind, 'start-worker', 'nobody has joined yet');
  assert.equal((await post(`/api/pm-loop/${created.id}/execute`, { key: overview.goals[0].suggestions[0].key })).status, 409, 'start-worker cards cannot run');
  assert.equal((await post(`/api/pm-loop/${created.id}/dismiss`, { key: overview.goals[0].suggestions[0].key, reason: '세션을 직접 띄움' })).status, 200);
  assert.equal((await post(`/api/pm-loop/${created.id}/stop`, {})).status, 200);
  assert.equal((await (await fetch(`${base}/api/pm-loop/${created.id}`)).json()).state, 'stopped');
  assert.equal((await post(`/api/pm-loop/${created.id}/resume`, {})).status, 200);
  assert.equal((await fetch(`${base}/api/pm-loop/goal-zzz`)).status, 404);
  assert.ok(server.pmLoop, 'one engine per dashboard');
  await server.pmLoop.close();
  await server.pmLoop.close();
});

test('engine: a new assignment wakes the engine and the stale timer is cleaned up on close', async (t) => {
  const { root } = await setup(t);
  const goalRecord = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goalRecord.id, 'goal:confirm-plan', { author: '대표' });
  await assignTask(root, { author: '대표', kind: 'human', feature: 'f1', to: 'codex-a', phase: 'plan', body: '직접 배정' });
  let clock = Date.now();
  const engine = createPmLoop({ root, intervalMs: 10, slowMs: 1000, now: () => clock, listTools: noTools });
  await engine.start();
  await engine.tick();
  assert.equal((await readDecisions(root, goalRecord.id)).filter((item) => item.kind === 'reclaim').length, 0);
  clock += 31 * MIN;
  await engine.tick();
  await engine.close();
  assert.equal((await readDecisions(root, goalRecord.id)).filter((item) => item.kind === 'reclaim' && item.outcome === 'suggested').length, 1);
});

async function completePhase(root, id, phase, author) {
  await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n\n- AC-1: 화면이 열린다` });
  await updateFeature(root, id, 'complete', { phase, evidence: `${phase} 완료`, author, ...(['implement', 'review'].includes(phase) ? { waiver: '테스트 픽스처' } : {}), ...(phase === 'review' ? { verdict: 'pass', acWaiver: '테스트 픽스처' } : {}) });
}

test('report complete: the PR draft is written to a file, then a person decides and the goal is done', async (t) => {
  const { root } = await setup(t);
  for (const phase of ['plan', 'design', 'implement', 'review', 'report']) await completePhase(root, 'f1', phase, phase === 'review' ? 'claude-a' : 'codex-a');
  const goalRecord = await createGoal(root, { title: '보고까지', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goalRecord.id, 'goal:confirm-plan', { author: '대표' });
  const [draft] = (await goalOverview(root, goalRecord.id)).suggestions;
  assert.equal(draft.kind, 'pr-body');
  const { decision } = await executeSuggestion(root, goalRecord.id, draft.key, { author: '대표' });
  assert.equal(decision.file, `.wax/chat/pm-loop/${goalRecord.id}.f1.pr-body.md`);
  assert.match(await readFile(join(root, decision.file), 'utf8'), /f1 작업/);
  const view = await goalOverview(root, goalRecord.id);
  assert.deepEqual([view.state, view.suggestions[0].kind], ['waiting-human', 'await-pr']);
  await executeSuggestion(root, goalRecord.id, view.suggestions[0].key, { author: '대표' });
  assert.equal((await goalOverview(root, goalRecord.id)).state, 'done');
  await evaluateGoals(root);
  assert.equal((await goalOverview(root, goalRecord.id)).storedState, 'done', 'the engine records the finished goal');
  assert.ok(await createGoal(root, { title: '다시', features: ['f1'] }, { author: '대표' }), 'a finished goal no longer holds its tasks');
});

test('one computation spreads suggested assignments over sessions instead of piling them on one', () => {
  const two = goal({ features: ['f1', 'f2'] });
  const result = nextActions({ goal: two, features: [feature('design'), { ...feature('plan'), id: 'f2' }], now: NOW,
    presence: [session('codex-a', 'codex', { listening: true }), session('claude-a', 'claude', { listening: true })] });
  assert.deepEqual(result.actions.map((item) => [item.kind, item.to]), [['assign', 'claude-a'], ['assign', 'codex-a']]);
});

test('a damaged goal file is reported, not fatal', async (t) => {
  const { root } = await setup(t);
  const goalRecord = await createGoal(root, { title: '목표', features: ['f1'] }, { author: '대표' });
  await writeFile(join(root, '.wax', 'chat', 'pm-loop', 'goal-deadbeef.json'), JSON.stringify({ id: 'goal-deadbeef', features: 'f1' }));
  const overview = await pmLoopOverview(root);
  assert.deepEqual([overview.goals.map((item) => item.id), overview.issues], [[goalRecord.id], ['goal-deadbeef.json']]);
  assert.equal((await evaluateGoals(root)).length, 1, 'the engine still runs the readable goal');
});
