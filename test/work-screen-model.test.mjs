import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeThreads, dateGroup, matchThread, phaseName, phaseSections, proofSummary, requestThread } from '../web/thread-model.mjs';
import { applyCompletion, completionAt, completions } from '../web/composer-complete.mjs';

const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();
const day = (days, hours = 0) => new Date(new Date(2026, 9, 28 - days, 12 - hours).getTime()).toISOString();
const thread = (key, state, lastAt, extra = {}) => ({ key, state, lastAt, title: key, ...extra });

test('date groups follow the local calendar day', () => {
  assert.equal(dateGroup(day(0, 11), NOW), 'today');
  assert.equal(dateGroup(day(1), NOW), 'yesterday');
  assert.equal(dateGroup(day(3), NOW), 'week');
  assert.equal(dateGroup(day(20), NOW), 'month');
  assert.equal(dateGroup(day(90), NOW), 'older');
  assert.equal(dateGroup('not a date', NOW), 'older');
});

test('work list: pinned threads first from every state, then date groups of the chosen state', () => {
  const threads = [
    thread('r:today', 'attention', day(0)), thread('t:yesterday', 'attention', day(1)), thread('m:old', 'attention', day(40)),
    thread('r:done', 'done', day(0)), thread('t:pinned-done', 'done', day(5)),
  ];
  const { pinned, groups } = arrangeThreads(threads, { state: 'attention', pinned: new Set(['t:pinned-done']), now: NOW });
  assert.deepEqual(pinned.map((t) => t.key), ['t:pinned-done']);
  assert.deepEqual(groups.map((g) => [g.key, g.label, g.threads.map((t) => t.key)]), [['today', '오늘', ['r:today']], ['yesterday', '어제', ['t:yesterday']], ['older', '이전', ['m:old']]]);
});

test('finding work searches every state by title, preview, owner and id with all words', () => {
  const threads = [
    thread('r:1', 'done', day(0), { title: '로그인 재시도 수정', owner: 'claude-app', id: 'request-1' }),
    thread('t:2', 'attention', day(0), { title: '결제 화면', preview: 'codex: 로그인 버튼 위치' }),
    thread('m:3', 'active', day(0), { title: '점심' }),
  ];
  assert.equal(matchThread(threads[0], 'LOGIN'), false);
  assert.equal(matchThread(threads[0], '로그인 CLAUDE'), true);
  assert.equal(matchThread(threads[0], '로그인 codex'), false);
  const { groups } = arrangeThreads(threads, { state: 'attention', query: '로그인', now: NOW });
  assert.deepEqual(groups.flatMap((g) => g.threads.map((t) => t.key)), ['r:1', 't:2']);
  assert.deepEqual(arrangeThreads(threads, { query: '없는말', now: NOW }), { pinned: [], groups: [] });
});

test('a request waiting on an AI question needs an answer', () => {
  assert.equal(requestThread({ id: 'request-1', title: 'x', status: 'question', createdAt: day(0), mode: 'sm' }).state, 'attention');
  assert.equal(requestThread({ id: 'request-1', title: 'x', status: 'question', createdAt: day(0), mode: 'sm' }).mode, 'sm');
});

test('request messages are split into phase sections with their evidence', () => {
  const t = (minute) => new Date(Date.UTC(2026, 9, 28, 1, minute)).toISOString();
  const messages = [
    { role: 'user', text: '로그인 고쳐줘', at: t(0) },
    { role: 'assistant', text: '기획 보고', phase: 'plan', at: t(5) },
    { role: 'assistant', text: '설계 보고', phase: 'design', at: t(10) },
    { role: 'user', text: '버튼도 바꿔줘', at: t(11) },
    { role: 'assistant', text: '구현 보고', phase: 'implement', at: t(20) },
    { role: 'assistant', text: '검토 실패', phase: 'review', at: t(25) },
    { role: 'assistant', text: '다시 구현', phase: 'implement', at: t(40) },
  ];
  const proofs = [
    { id: 'p1', kind: 'test', phase: 'implement', at: t(18), exitCode: 0 },
    { id: 'p2', kind: 'git', phase: 'implement', at: t(19) },
    { id: 'p3', kind: 'test', phase: 'review', at: t(24), exitCode: 1 },
    { id: 'p4', kind: 'test', phase: 'implement', at: t(38), exitCode: 0, timedOut: true },
    { id: 'p5', kind: 'test', phase: 'implement', at: t(50), exitCode: 0 },
  ];
  const sections = phaseSections(messages, { proofs });
  assert.deepEqual(sections.map((s) => [s.phase, s.items.length, s.proofs.map((p) => p.id), s.current]), [
    ['plan', 2, [], false], ['design', 2, [], false], ['implement', 1, ['p1', 'p2'], false], ['review', 1, ['p3'], false], ['implement', 1, ['p4', 'p5'], true],
  ]);
  assert.equal(phaseSections(messages, { done: true }).at(-1).current, false);
  assert.deepEqual(proofSummary(sections[4].proofs), { tests: 2, passed: 1, commits: 0 });
  assert.deepEqual(proofSummary(sections[2].proofs), { tests: 1, passed: 1, commits: 1 });
  assert.deepEqual(phaseSections([]), []);
  assert.equal(phaseName('plan', 'sm'), '접수·분석');
  assert.equal(phaseName('review', 'project'), '검토');
});

test('completion starts only at @, / or # that begins a word', () => {
  assert.deepEqual(completionAt('안녕 @cla', 7), { trigger: '@', query: 'cla', start: 3, end: 7 });
  assert.deepEqual(completionAt('/rev'), { trigger: '/', query: 'rev', start: 0, end: 4 });
  assert.deepEqual(completionAt('작업 #'), { trigger: '#', query: '', start: 3, end: 4 });
  for (const text of ['docs/wax', 'me@example', 'url#hash', '@claude ', 'plain']) assert.equal(completionAt(text), null, text);
  assert.equal(completionAt('@claude 다음', 7)?.query, 'claude', 'the caret decides which word is completed');
});

test('completion items: sessions, commands in the recipient tool syntax, and tasks', () => {
  const sessions = [{ author: 'codex-app', kind: 'codex' }, { author: 'claude-app', kind: 'claude' }, { author: 'my-claude', kind: 'claude' }];
  assert.deepEqual(completions(completionAt('@cl'), { sessions }).map((item) => [item.label, item.insert, item.author]), [['@claude-app', '@claude-app ', 'claude-app'], ['@my-claude', '@my-claude ', 'my-claude']]);
  const review = (kind, feature) => completions(completionAt('/review'), { kind, feature })[0].insert;
  assert.equal(review('claude', 'login'), '/wax:review login ');
  assert.equal(review('codex', 'login'), '$wax:review login ');
  assert.equal(review('antigravity', null), '/review ');
  assert.equal(review(null, 'login'), 'wax review login ', 'without one recipient the generic wax command is used');
  assert.equal(completions(completionAt('/status'), { kind: 'claude', feature: 'login' })[0].insert, '/wax:status ', 'optional ids are not filled in');
  assert.ok(completions(completionAt('/검토'), {}).some((item) => item.label === '/review'), 'commands are found by their label too');
  const features = [{ id: 'login-retry', title: '로그인 재시도' }, { id: 'checkout', title: '결제' }];
  assert.deepEqual(completions(completionAt('#결제'), { features }).map((item) => item.insert), ['#checkout ']);
  assert.deepEqual(completions(null, { sessions }), []);
  const at = completionAt('안녕 @cl 반가워', 6);
  assert.deepEqual(applyCompletion('안녕 @cl 반가워', at, { insert: '@claude-app ' }), { text: '안녕 @claude-app  반가워', caret: 15 });
});
