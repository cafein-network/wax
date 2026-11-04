import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BIN, project } from './chat-helpers.mjs';
import { createGoal, goalOverview, pmLoopOverview, readDecisions, reviewRepeat, workerRuns } from '../src/chat/pm-loop.mjs';
import { REVIEW_CRITERION, cleanReviewNote, reviewItems, reviewSubject, reviewSummary } from '../src/chat/pm-review.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { setPm } from '../src/chat/team.mjs';
const run = promisify(execFile);

const T0 = Date.parse('2026-11-03T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const COMMAND = ['node', '--test', 'test/sum.test.js'];
const repeat = { kind: 'test', key: 'k'.repeat(64), command: COMMAND.join(' '), exitCode: 1, count: 3, proofIds: ['p1', 'p2', 'p3'] };

async function seeded(t, { end = 'exited' } = {}) {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: '평가', features: ['f1'] }, { author: '대표' });
  const file = join(root, '.wax', 'chat', 'pm-loop', `${goal.id}.jsonl`);
  const add = (record) => appendRecord(file, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...record }));
  const base = { tool: 'claude', feature: 'f1', phase: 'implement', iteration: 0 };
  await add({ kind: 'worker', outcome: 'launched', worker: 'pw-0000000a', task: 't-1', to: 'wax-worker-claude', by: '대표', ...base, at: iso(T0) });
  const warned = await add({ kind: 'repeat', outcome: 'warned', worker: 'pw-0000000a', to: 'wax-worker-claude', by: 'pm-loop', repeat, reason: '경고', ...base, at: iso(T0 + 60_000) });
  if (end) await add({ kind: 'worker', outcome: end, worker: 'pw-0000000a', to: 'wax-worker-claude', ...base, at: iso(T0 + 120_000) });
  await add({ kind: 'worker', outcome: 'launched', worker: 'pw-0000000b', task: 't-2', to: 'wax-worker-claude', by: '대표', ...base, at: iso(T0 + 200_000) });
  const stuck = await add({ kind: 'worker', outcome: 'stuck', worker: 'pw-0000000b', to: 'wax-worker-claude', repeat, ...base, at: iso(T0 + 260_000) });
  const other = await add({ kind: 'goal', outcome: 'settings', by: '대표', reason: '설정', at: iso(T0 + 300_000) });
  return { root, goal, warned: warned.id, stuck: stuck.id, other: other.id };
}

test('only repeat warnings and stops for repeating can be reviewed, and notes are cleaned', () => {
  assert.equal(reviewSubject({ kind: 'repeat', outcome: 'warned', repeat }), 'repeat-warned');
  assert.equal(reviewSubject({ kind: 'worker', outcome: 'stuck', repeat }), 'repeat-stuck');
  assert.equal(reviewSubject({ kind: 'worker', outcome: 'timeout' }), null);
  assert.equal(reviewSubject({ kind: 'repeat', outcome: 'warned' }), null, 'a warning without repeat data');
  assert.equal(cleanReviewNote('  흔들리는\n테스트‮였음\u0007 '), '흔들리는 테스트였음');
  assert.equal(Array.from(cleanReviewNote('가'.repeat(400))).length, 300);
  assert.equal(cleanReviewNote('   '), null);
  assert.equal(cleanReviewNote(undefined), null);
});

test('a person reviews; machines, unknown targets and other records are refused', async (t) => {
  const { root, goal, warned, stuck, other } = await seeded(t);
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) await assert.rejects(reviewRepeat(root, goal.id, { author, target: warned, verdict: 'right' }), (error) => error.status === 403, author);
  await assert.rejects(reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'maybe' }), (error) => error.status === 400);
  await assert.rejects(reviewRepeat(root, goal.id, { author: '대표', target: 'pd-999999-ffffff', verdict: 'right' }), (error) => error.status === 404);
  await assert.rejects(reviewRepeat(root, goal.id, { author: '대표', target: '../x', verdict: 'right' }), (error) => error.status === 404);
  await assert.rejects(reviewRepeat(root, goal.id, { author: '대표', target: other, verdict: 'right' }), (error) => error.status === 409);
  await assert.rejects(reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'right', note: 5 }), (error) => error.status === 400);
  const saved = await reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'wrong', note: '흔들리는 테스트' });
  assert.deepEqual([saved.subject, saved.verdict, saved.by, saved.note], ['repeat-warned', 'wrong', '대표', '흔들리는 테스트']);
  await reviewRepeat(root, goal.id, { author: '대표', target: stuck, verdict: 'right' });
  await reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'right' });
  const decisions = await readDecisions(root, goal.id);
  assert.equal(decisions.filter((item) => item.kind === 'review').length, 3);
  assert.equal(workerRuns(decisions).length, 2, 'review records do not join the worker start and end pairs');
  const view = await goalOverview(root, goal.id, { now: T0 + 400_000 });
  const item = view.repeatReviews.find((entry) => entry.target === warned);
  assert.deepEqual([item.review.verdict, item.history.map((entry) => entry.verdict)], ['right', ['wrong', 'right']]);
  assert.deepEqual([view.repeatReview.right, view.repeatReview.wrong, view.repeatReview.unrated], [2, 0, 0]);
  assert.ok(!view.decisions.some((entry) => entry.kind === 'review'), 'review lines stay out of the decision list');
});

test('the summary counts only reviewed items; not reviewed never counts as agreement', async (t) => {
  const { root, goal, warned } = await seeded(t);
  const empty = await pmLoopOverview(root, { now: T0 + 400_000 });
  assert.deepEqual([empty.repeatReview.total, empty.repeatReview.rated, empty.repeatReview.unrated, empty.repeatReview.criterion.met], [2, 0, 2, false]);
  assert.deepEqual(empty.repeatUnrated.map((item) => item.goal), [goal.id, goal.id]);
  await reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'right' });
  const after = await pmLoopOverview(root, { now: T0 + 400_000 });
  assert.deepEqual([after.repeatReview.right, after.repeatReview.unrated, after.repeatUnrated.length], [1, 1, 1]);
  const make = (n, wrong = 0) => Array.from({ length: n }, (_, i) => ({ review: { verdict: i < wrong ? 'wrong' : 'right' } }));
  assert.deepEqual(REVIEW_CRITERION, { rated: 10, wrong: 0 });
  assert.equal(reviewSummary(make(9)).criterion.met, false);
  assert.equal(reviewSummary(make(10)).criterion.met, true);
  assert.equal(reviewSummary(make(10, 1)).criterion.met, false);
  assert.equal(reviewSummary([...make(10), { review: null }]).unrated, 1);
});

test('facts help the person but never fill in the verdict', () => {
  const decisions = [
    { id: 'pd-1', kind: 'worker', outcome: 'launched', worker: 'w1', to: 'wax-worker-claude', feature: 'f1', phase: 'implement', at: iso(T0) },
    { id: 'pd-2', kind: 'repeat', outcome: 'warned', worker: 'w1', feature: 'f1', phase: 'implement', repeat, at: iso(T0 + 60_000) },
    { id: 'pd-3', kind: 'worker', outcome: 'exited', worker: 'w1', feature: 'f1', phase: 'implement', at: iso(T0 + 120_000) },
  ];
  const proof = (extra) => ({ kind: 'test', command: COMMAND, exitCode: 0, author: 'wax-worker-claude', at: iso(T0 + 90_000), ...extra });
  const facts = (features) => reviewItems(decisions, { features, isEnd: (outcome) => outcome === 'exited' })[0];
  const passed = facts([{ id: 'f1', proofs: [proof()], completed: { implement: { at: iso(T0 + 110_000) } } }]);
  assert.deepEqual(passed.facts, { end: 'exited', completed: true, passedAfter: true });
  assert.equal(passed.review, null, 'no verdict is guessed');
  assert.equal(facts([{ id: 'f1', proofs: [proof({ author: '사람' })], completed: {} }]).facts.passedAfter, false, 'a person’s run is not this worker’s');
  assert.equal(facts([{ id: 'f1', proofs: [proof({ at: iso(T0 + 30_000) })], completed: {} }]).facts.passedAfter, false, 'before the warning');
  assert.equal(facts([{ id: 'f1', proofs: [proof({ at: iso(T0 + 200_000) })], completed: {} }]).facts.passedAfter, false, 'after the run ended');
  assert.equal(facts([{ id: 'f1', proofs: [proof({ command: ['npm', 'test'] })], completed: {} }]).facts.passedAfter, false, 'another command');
  assert.equal(facts([]).facts.passedAfter, null, 'without the task the fact is unknown');
});

test('dashboard API: reviews need the token and are written as the dashboard person', async (t) => {
  const { root, goal, warned } = await seeded(t);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000, requestTools: async () => [] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (body, headers = { 'x-chat-token': token }) => fetch(`${base}/api/pm-loop/${goal.id}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ target: warned, verdict: 'right' }, {})).status, 403, 'no token');
  assert.equal((await post({ target: warned, verdict: 'nope' })).status, 400);
  const saved = await post({ target: warned, verdict: 'wrong', note: '메모', by: 'auto' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).by, '대표', 'the author is the dashboard person, not a field in the body');
  const list = await (await fetch(`${base}/api/pm-loop`)).json();
  assert.deepEqual([list.repeatReview.wrong, list.repeatReview.unrated], [1, 1]);
});

test('CLI shows reviews read-only, in Korean and English', async (t) => {
  const { root, goal, warned } = await seeded(t);
  await reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'wrong', note: '흔들림' });
  const cli = async (args, env = {}) => (await run(process.execPath, [BIN, '--project', root, 'pm-loop', ...args], { env: { ...process.env, ...env } })).stdout;
  const show = await cli(['show', goal.id]);
  assert.match(show, /되풀이 경고 평가:/);
  assert.match(show, /경고 {2}f1 {2}node --test test\/sum\.test\.js {2}→ 틀림 · 대표 · 흔들림/);
  assert.match(show, /되풀이로 멈춤 {2}f1 .*→ 평가 안 함/);
  assert.match(await cli(['list']), /되풀이 경고 평가: 맞음 0 · 틀림 1 · 평가 안 함 1/);
  assert.match(await cli(['list'], { WAX_LANG: 'en' }), /Repeat warning reviews: right 0 · wrong 1 · not reviewed 1/);
  const json = JSON.parse(await cli(['show', goal.id, '--json']));
  assert.equal(json.repeatReviews.length, 2);
});
