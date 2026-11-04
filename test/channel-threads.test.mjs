import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreads, conversationThreads, foldProgress, isChannelProgress, isRequestProgress, requestThread, taskThread } from '../web/thread-model.mjs';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const msg = (id, author, body, extra = {}) => ({ id, author, kind: author === '대표' ? 'human' : 'codex', type: 'message', body, at: at(10), channel: 'general', ...extra });

test('conversations: reply chains share the root thread; lone messages stay in the full conversation', () => {
  const messages = [
    msg('m-000001-aaaaaa', '대표', '로그인 방식 정하자', { at: at(30) }),
    msg('m-000002-bbbbbb', 'codex-app', '이메일 링크 방식을 제안합니다', { replyTo: 'm-000001-aaaaaa', at: at(20) }),
    msg('m-000003-cccccc', '대표', '좋아요', { replyTo: 'm-000002-bbbbbb', type: 'decision', at: at(10) }),
    msg('m-000004-dddddd', 'codex-app', '빌드 시작합니다', { at: at(5) }),
    msg('m-000005-eeeeee', 'codex-app', '토큰 만료는 몇 분으로 할까요?', { type: 'question', at: at(2) }),
    msg('m-000006-ffffff', 'claude-1', '원글이 범위 밖인 답장', { replyTo: 'm-000000-999999', at: at(1) }),
  ];
  const threads = conversationThreads(messages, { user: '대표', now: NOW });
  assert.deepEqual(threads.map((t) => [t.key, t.state, t.items.length]), [['m:m-000001-aaaaaa', 'done', 3], ['m:m-000005-eeeeee', 'attention', 1]]);
  const [decided, question] = threads;
  assert.equal(decided.title, '로그인 방식 정하자'); assert.equal(decided.owner, 'codex-app');
  assert.equal(decided.replyTo, 'm-000003-cccccc'); assert.deepEqual(decided.recipients, ['codex-app']);
  assert.equal(question.preview, 'codex-app: 토큰 만료는 몇 분으로 할까요?');
});

test('conversations: an answered question is active, a question from the user waits on others, quiet ones are done', () => {
  const asked = msg('m-000001-aaaaaa', 'codex-app', '어떤 DB?', { type: 'question', at: at(60) });
  const answered = [asked, msg('m-000002-bbbbbb', '대표', 'SQLite', { type: 'answer', replyTo: asked.id, at: at(50) })];
  assert.equal(conversationThreads(answered, { user: '대표', now: NOW })[0].state, 'active');
  const mine = [msg('m-000003-cccccc', '대표', '진행 상황은?', { type: 'question', at: at(5) })];
  assert.equal(conversationThreads(mine, { user: '대표', now: NOW })[0].state, 'active');
  const quiet = answered.map((m) => ({ ...m, at: new Date(Date.parse(m.at) - 2 * 86_400_000).toISOString() }));
  assert.equal(conversationThreads(quiet, { user: '대표', now: NOW })[0].state, 'done');
  const cycle = [msg('m-000010-aaaaaa', 'a', 'x', { replyTo: 'm-000011-bbbbbb' }), msg('m-000011-bbbbbb', 'b', 'y', { replyTo: 'm-000010-aaaaaa' })];
  assert.ok(Array.isArray(conversationThreads(cycle, { user: '대표', now: NOW })));
});

test('requests and tasks map their statuses; linked pending approvals make a request need an answer', () => {
  const request = { id: 'request-1', title: '결제 붙이기', tool: 'codex', agent: 'wax-pm', status: 'running', phase: 'implement', detail: '구현 진행 중', createdAt: at(40), updatedAt: at(3), messages: [{ role: 'user', text: '결제', at: at(40) }], approvals: ['ap-1'] };
  const pending = { id: 'ap-1', tool: 'codex', status: 'pending', expiresAt: NOW + 60_000, createdAt: NOW - 60_000, action: 'command', details: { command: 'npm test' } };
  assert.equal(requestThread(request, [], { now: NOW }).state, 'active');
  const waiting = requestThread(request, [pending], { now: NOW });
  assert.equal(waiting.state, 'attention'); assert.deepEqual(waiting.approvals.map((a) => a.id), ['ap-1']);
  assert.equal(requestThread(request, [{ ...pending, expiresAt: NOW - 1 }], { now: NOW }).state, 'active');
  for (const [status, state] of [['queued', 'active'], ['blocked', 'attention'], ['workflow', 'attention'], ['paused', 'attention'], ['completed', 'done']]) assert.equal(requestThread({ ...request, status, approvals: [] }).state, state, status);

  const task = { id: 't-000001-aaaaaa', feature: 'login', to: 'codex-app', phase: 'implement', note: '로그인 API 구현\n세부', by: 'wax-pm', at: at(30), status: 'blocked', statusAt: at(5), updates: [{ author: 'codex-app', status: 'accepted', at: at(20) }, { author: 'codex-app', status: 'blocked', note: '키가 없습니다', at: at(5) }] };
  const thread = taskThread(task);
  assert.deepEqual([thread.state, thread.title, thread.channel, thread.preview], ['attention', '로그인 API 구현', 'login', 'codex-app: 키가 없습니다']);
  assert.deepEqual(thread.items.map((item) => item.status), ['open', 'accepted', 'blocked']);
  for (const [status, state] of [['open', 'active'], ['accepted', 'active'], ['done', 'done'], ['cancelled', 'done']]) assert.equal(taskThread({ ...task, status }).state, state, status);
});

test('the full list puts unlinked pending approvals on their own, sorts by recent activity and counts each state', () => {
  const request = { id: 'request-1', title: 'r', tool: 'codex', status: 'running', createdAt: at(40), updatedAt: at(30), messages: [], approvals: ['ap-1'] };
  const approvals = [
    { id: 'ap-1', tool: 'codex', status: 'pending', expiresAt: NOW + 1, createdAt: NOW - 5 * 60_000, action: 'command', details: { command: 'npm test' } },
    { id: 'ap-2', tool: 'claude', status: 'pending', expiresAt: NOW + 1, createdAt: NOW - 60_000, action: 'command', details: { command: 'rm -rf dist' } },
    { id: 'ap-3', tool: 'claude', status: 'delivered', expiresAt: NOW + 1, createdAt: NOW - 60_000, action: 'command', details: {} },
  ];
  const tasks = [{ id: 't-000001-aaaaaa', feature: 'f', to: 'a', note: 'done task', by: 'pm', at: at(100), status: 'done', statusAt: at(90), updates: [] }];
  const messages = [msg('m-000001-aaaaaa', 'codex-app', '질문?', { type: 'question', at: at(10) })];
  const { threads, counts } = buildThreads({ requests: [request], approvals, tasks, messages, user: '대표', now: NOW });
  assert.deepEqual(threads.map((t) => t.key), ['a:ap-2', 'm:m-000001-aaaaaa', 'r:request-1', 't:t-000001-aaaaaa']);
  assert.deepEqual(counts, { attention: 3, active: 0, done: 1 });
  assert.equal(threads[0].preview, 'rm -rf dist'); assert.equal(threads[0].title, 'Claude Code 실행 승인');
});

test('progress runs of two or more fold, but the latest item and conversation turns stay open', () => {
  const items = [
    { kind: 'human', type: 'message', body: '시작' },
    { kind: 'codex', type: 'message', body: '1' }, { kind: 'codex', type: 'message', body: '2' }, { kind: 'codex', type: 'message', body: '3' },
    { kind: 'codex', type: 'question', body: '?' },
    { kind: 'codex', type: 'message', body: 'solo' },
    { kind: 'human', type: 'answer', body: '!' },
    { kind: 'codex', type: 'message', body: 'a' }, { kind: 'codex', type: 'message', body: 'last' },
  ];
  const shape = foldProgress(items, isChannelProgress).map((entry) => entry.folded ? `fold:${entry.folded.map((i) => i.body).join('')}` : entry.item.body);
  assert.deepEqual(shape, ['시작', 'fold:123', '?', 'solo', '!', 'a', 'last']);
  const requestItems = [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'p1' }, { role: 'assistant', text: 'p2' }, { role: 'assistant', text: 'done' }];
  assert.deepEqual(foldProgress(requestItems, isRequestProgress).map((e) => e.folded ? e.folded.length : e.item.text), ['go', 2, 'done']);
  assert.deepEqual(foldProgress([], isRequestProgress), []);
});
