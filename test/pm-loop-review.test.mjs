import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BIN, project } from './chat-helpers.mjs';
import { createGoal, goalOverview, pmLoopOverview, readDecisions, reviewRepeat, workerRuns } from '../src/chat/pm-loop.mjs';
import { REPEAT_DEFAULT_AGAIN, REVIEW_CRITERION, REVIEW_TAIL, cleanReviewNote, repeatDefaultCard, reviewEvidence, reviewItems, reviewSubject, reviewSummary } from '../src/chat/pm-review.mjs';
import { decideRepeatDefault, readRepeatDefault, repeatDefaultView, repeatReviewDetail } from '../src/chat/pm-review-list.mjs';
import { normalizeTestOutput, stuckCheckMode, testRepeatKey } from '../src/chat/stuck-check.mjs';
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


test('not sure is a third verdict: it counts as looked at, never toward the bar', async (t) => {
  const { root, goal, warned, stuck } = await seeded(t);
  const saved = await reviewRepeat(root, goal.id, { author: '대표', target: warned, verdict: 'unsure', note: '출력만으로는 모르겠음' });
  assert.deepEqual([saved.verdict, saved.note], ['unsure', '출력만으로는 모르겠음']);
  const view = await pmLoopOverview(root, { now: T0 + 400_000 });
  assert.deepEqual([view.repeatReview.unsure, view.repeatReview.rated, view.repeatReview.unrated, view.repeatReview.total], [1, 0, 1, 2]);
  assert.deepEqual(view.repeatUnrated.map((item) => item.target), [stuck], 'a not-sure item leaves the not-reviewed list');
  const make = (right, unsure) => [...Array.from({ length: right }, () => ({ review: { verdict: 'right' } })), ...Array.from({ length: unsure }, () => ({ review: { verdict: 'unsure' } }))];
  assert.equal(reviewSummary(make(9, 3)).criterion.met, false, 'not sure does not fill the bar');
  assert.deepEqual([reviewSummary(make(10, 3)).criterion.met, reviewSummary(make(10, 3)).unrated], [true, 0]);
  const cli = (await run(process.execPath, [BIN, '--project', root, 'pm-loop', 'list'], { env: { ...process.env, WAX_LANG: 'en' } })).stdout;
  assert.match(cli, /Repeat warning reviews: right 0 · wrong 0 · not sure 1 · not reviewed 1/);
});

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const failProof = (root, n, { tree = { head: SHA_A, files: { 'src/sum.js': SHA_B } }, crlf = false } = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind: 'test', phase: 'implement', iteration: 0, author: 'wax-worker-claude', command: COMMAND, exitCode: 1, durationMs: 5,
  at: iso(T0 + 10_000 * n), tree, output: `${'x'.repeat(600)}\nat ${root}/src/sum.js:${n}:5 took ${n}ms at 10:00:0${n}${crlf ? '\r\n' : '\n'}Expected sum to be three${crlf ? '\r\n' : '\n'}` });

test('evidence rows show the normalized tail that went into the key next to the original tail', (t) => {
  const root = '/work/project';
  const proofs = [failProof(root, 1), failProof(root, 2, { crlf: true })];
  const options = { roots: [root] };
  const key = testRepeatKey(proofs[0], options);
  assert.equal(testRepeatKey(failProof(root, 2), options), key, 'the two runs share one key once normalized');
  const ev = reviewEvidence({ key, command: COMMAND.join(' '), exitCode: 1, count: 3, proofIds: [proofs[0].id, proofs[1].id, 'gone'] }, proofs, { rootsFor: () => [root] });
  assert.deepEqual([ev.command, ev.exitCode, ev.count, ev.sameKey, ev.proofs.length, ev.sameCode], [COMMAND.join(' '), 1, 3, 1, 3, true]);
  const [first, second, gone] = ev.proofs;
  assert.equal(first.normalized, normalizeTestOutput(proofs[0].output, options).slice(-REVIEW_TAIL), 'exactly the characters that went into the key');
  assert.match(first.normalized, /<project>\/src\/sum\.js:<pos> took <duration> at <time>/);
  assert.equal(first.raw, proofs[0].output.slice(-REVIEW_TAIL));
  assert.equal(first.raw.length, REVIEW_TAIL);
  assert.deepEqual(first.tree, { head: 'aaaaaaa', files: 1 });
  assert.equal(first.sameKey, true);
  assert.ok(!second.raw.includes('\r') && !second.normalized.includes('\r'), 'Windows line ends show as \\n');
  assert.equal(second.sameKey, false, 'CRLF output was a different key for the engine too');
  assert.deepEqual(gone, { id: 'gone', missing: true }, 'removed evidence (100 limit) shows as no evidence');
  const changed = reviewEvidence({ key, proofIds: [proofs[0].id, 'p3'] }, [proofs[0], { ...failProof(root, 3, { tree: { head: SHA_A, files: {} } }), id: 'p3' }], { rootsFor: () => [root] });
  assert.equal(changed.sameCode, false, 'different trees are not the same code');
  assert.equal(reviewEvidence({ proofIds: ['x'] }, []).sameCode, null);
});

test('the threshold card: met asks, a wrong review asks to fix first, not yet waits for five more', () => {
  const summary = (right, wrong = 0, unsure = 0) => reviewSummary([...Array(right).fill('right'), ...Array(wrong).fill('wrong'), ...Array(unsure).fill('unsure')].map((verdict) => ({ review: { verdict } })));
  assert.equal(repeatDefaultCard(summary(9)), null, 'below the bar nothing is shown');
  assert.deepEqual(repeatDefaultCard(summary(10)), { state: 'ask', right: 10, wrong: 0 });
  const items = [{ goal: 'goal-1', target: 'pd-1', review: { verdict: 'right' } }, { goal: 'goal-2', target: 'pd-2', review: { verdict: 'wrong' } }];
  assert.deepEqual(repeatDefaultCard(summary(12, 1), [], items), { state: 'wrong', wrong: 1, first: { goal: 'goal-2', target: 'pd-2' } });
  assert.equal(repeatDefaultCard(summary(1, 1), [], items).state, 'wrong', 'any wrong review shows the fix-first note instead of the card');
  const later = { outcome: 'later', by: '대표', at: iso(T0), note: '더 보자', summary: { right: 10, wrong: 0, unsure: 0, unrated: 0 } };
  assert.deepEqual(repeatDefaultCard(summary(10, 0, 4), [later]), { state: 'later', by: '대표', at: iso(T0), note: '더 보자', again: REPEAT_DEFAULT_AGAIN }, 'not sure does not bring the card back');
  assert.equal(repeatDefaultCard(summary(14), [later]).again, 1);
  assert.equal(repeatDefaultCard(summary(15), [later]).state, 'ask', 'five more reviews ask again');
  assert.deepEqual(repeatDefaultCard(summary(15), [later, { ...later, outcome: 'decided', to: 'stop' }]), { state: 'decided', by: '대표', at: iso(T0), to: 'stop' });
});

async function manyWarnings(t, n) {
  const root = await project(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: '많은 경고', features: ['f1'] }, { author: '대표' });
  const file = join(root, '.wax', 'chat', 'pm-loop', `${goal.id}.jsonl`);
  const add = (record) => appendRecord(file, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...record }));
  const base = { tool: 'claude', feature: 'f1', phase: 'implement', iteration: 0, to: 'wax-worker-claude' };
  const warned = [];
  for (let i = 0; i < n; i++) {
    const worker = `pw-${String(i).padStart(8, '0')}`;
    await add({ kind: 'worker', outcome: 'launched', worker, task: `t-${i}`, by: '대표', ...base, at: iso(T0 + i * 10_000) });
    warned.push((await add({ kind: 'repeat', outcome: 'warned', worker, by: 'pm-loop', repeat, ...base, at: iso(T0 + i * 10_000 + 1000) })).id);
    await add({ kind: 'worker', outcome: 'exited', worker, ...base, at: iso(T0 + i * 10_000 + 2000) });
  }
  return { root, goal, warned };
}

test('the threshold decision is a person’s record only; wax changes no setting and the engine never reads it', async (t) => {
  const { root, goal, warned } = await manyWarnings(t, 16);
  await assert.rejects(decideRepeatDefault(root, { author: '대표', outcome: 'decided' }), (error) => error.status === 409, 'below the bar the card is not asking');
  for (const target of warned.slice(0, 10)) await reviewRepeat(root, goal.id, { author: '대표', target, verdict: 'right' });
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) await assert.rejects(decideRepeatDefault(root, { author, outcome: 'decided' }), (error) => error.status === 403, author);
  await assert.rejects(decideRepeatDefault(root, { author: '대표', outcome: 'stop' }), (error) => error.status === 400);
  assert.equal((await repeatDefaultView(root, await pmLoopOverview(root, { now: T0 + 400_000 }))).state, 'ask');
  const later = await decideRepeatDefault(root, { author: '대표', outcome: 'later', note: '조금 더\n보자', now: T0 + 500_000 });
  assert.deepEqual([later.outcome, later.note, later.summary], ['later', '조금 더 보자', { right: 10, wrong: 0, unsure: 0, unrated: 6 }]);
  await assert.rejects(decideRepeatDefault(root, { author: '대표', outcome: 'decided' }), (error) => error.status === 409, 'not yet hides the card');
  for (const target of warned.slice(10, 15)) await reviewRepeat(root, goal.id, { author: '대표', target, verdict: 'right' });
  const decided = await decideRepeatDefault(root, { author: '대표', outcome: 'decided', now: T0 + 600_000 });
  assert.deepEqual([decided.outcome, decided.to, decided.by], ['decided', 'stop', '대표']);
  await assert.rejects(decideRepeatDefault(root, { author: '대표', outcome: 'later' }), (error) => error.status === 409, 'already decided');
  const lines = (await readFile(join(root, '.wax', 'chat', 'repeat-default.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.schema, line.record, line.outcome, line.seq, /^rd-/.test(line.id), line.at]),
    [[1, 'repeat-default', 'later', 1, true, iso(T0 + 500_000)], [1, 'repeat-default', 'decided', 2, true, iso(T0 + 600_000)]]);
  await appendRecord(join(root, '.wax', 'chat', 'repeat-default.jsonl'), (seq) => ({ schema: 1, record: 'repeat-default', id: makeId('rd', seq), seq, outcome: 'later', by: 'wax-worker-claude', at: iso(T0), summary: lines[0].summary }));
  assert.deepEqual((await readRepeatDefault(root)).map((item) => item.outcome), ['later', 'decided']);
  assert.equal(stuckCheckMode(undefined), 'warn');
  for (const file of ['../src/chat/pm-loop.mjs', '../src/chat/stuck-check.mjs', '../src/chat/pm-judge.mjs']) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /repeat-default|pm-review-list/, file);
  }
  await reviewRepeat(root, goal.id, { author: '대표', target: warned[15], verdict: 'wrong' });
  assert.deepEqual(await repeatDefaultView(root, await pmLoopOverview(root, { now: T0 + 700_000 })), { state: 'wrong', wrong: 1, first: { goal: goal.id, target: warned[15] } });
});

test('a list row opens with the evidence computed on request; unknown targets are refused', async (t) => {
  const { root, goal, warned, stuck, other } = await seeded(t);
  const featureFile = join(root, '.wax', 'features', 'f1.json');
  const feature = JSON.parse(await readFile(featureFile, 'utf8'));
  const proofs = [failProof(root, 1), failProof(root, 2)];
  feature.proofs = [...(feature.proofs ?? []), ...proofs];
  await writeFile(featureFile, `${JSON.stringify(feature, null, 2)}\n`);
  const file = join(root, '.wax', 'chat', 'pm-loop', `${goal.id}.jsonl`);
  const key = testRepeatKey(proofs[0], { roots: [root] });
  const real = await appendRecord(file, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, kind: 'repeat', outcome: 'warned', worker: 'pw-0000000a', tool: 'claude', feature: 'f1',
    phase: 'implement', to: 'wax-worker-claude', by: 'pm-loop', repeat: { ...repeat, key, count: 2, proofIds: proofs.map((proof) => proof.id) }, at: iso(T0 + 70_000) }));
  const detail = await repeatReviewDetail(root, goal.id, real.id);
  assert.deepEqual([detail.goal, detail.title, detail.subject, detail.evidence.sameKey, detail.evidence.sameCode], [goal.id, '평가', 'repeat-warned', 2, true]);
  assert.match(detail.evidence.proofs[0].normalized, /<project>\/src\/sum\.js:<pos>/);
  const seededDetail = await repeatReviewDetail(root, goal.id, warned);
  assert.deepEqual(seededDetail.evidence.proofs.map((proof) => proof.missing), [true, true, true], 'evidence that is gone shows as missing; the row can still be reviewed');
  assert.equal((await repeatReviewDetail(root, goal.id, stuck)).subject, 'repeat-stuck');
  await assert.rejects(repeatReviewDetail(root, goal.id, other), (error) => error.status === 409);
  await assert.rejects(repeatReviewDetail(root, goal.id, 'pd-999999-ffffff'), (error) => error.status === 404);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 10_000, requestTools: async () => [] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const got = await (await fetch(`${base}/api/pm-loop/${goal.id}/reviews/${real.id}`)).json();
  assert.equal(got.evidence.proofs.length, 2);
  assert.equal((await fetch(`${base}/api/pm-loop/${goal.id}/reviews/pd-999999-ffffff`)).status, 404);
  const list = await (await fetch(`${base}/api/pm-loop`)).json();
  assert.equal(list.repeatDefault, null, 'below the bar there is no card');
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (body, headers = { 'x-chat-token': token }) => fetch(`${base}/api/pm-loop/repeat-default`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ outcome: 'decided' }, {})).status, 403, 'no token');
  assert.equal((await post({ outcome: 'decided' })).status, 409, 'not asking yet');
  assert.equal((await fetch(`${base}/api/pm-loop/${goal.id}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify({ target: warned, verdict: 'unsure' }) })).status, 200);
});
