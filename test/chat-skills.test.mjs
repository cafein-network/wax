import test from 'node:test';
import assert from 'node:assert/strict';
import { runTestProof } from '../src/evidence.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { postNote } from '../src/chat/board.mjs';
import { assignTask, setPm, updateTask } from '../src/chat/team.mjs';
import { listProfiles, scoreAxes, summarize } from '../src/chat/skills.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { at, project } from './chat-helpers.mjs';

test('능력치: 업무 완료·근거 귀속·대화로 축 점수·지표·배지를 계산', async (t) => {
  const root = await project(t, ['login']);
  await setPm(root, { author: '사람', kind: 'human' });
  const task = await assignTask(root, { author: '사람', feature: 'login', to: 'claude', phase: 'plan', body: '기획' }, at('2026-10-01T09:00:00Z'));
  await updateTask(root, task.id, 'accept', { author: 'claude', kind: 'claude' }, at('2026-10-01T09:00:00Z'));
  const node = process.execPath;
  assert.equal((await runTestProof(root, 'login', [node, '-e', 'process.exit(0)'])).recorded, true);
  assert.equal((await runTestProof(root, 'login', [node, '-e', 'process.exit(1)'])).recorded, true);
  await updateTask(root, task.id, 'done', { author: 'claude', body: '완료' }, { now: new Date(Date.now() + 3_600_000) });
  await postMessage(root, 'login', { author: 'claude', kind: 'claude', type: 'answer', body: '답' });
  await postNote(root, 'login', { author: 'codex', kind: 'codex', type: 'decision', body: '결정' });
  const profiles = await listProfiles(root);
  const claude = profiles.find((p) => p.author === 'claude');
  assert.equal(claude.kind, 'claude');
  assert.equal(claude.level, 2);
  assert.equal('rank' in claude, false, '직급은 없다: 부서 팀장·팀원은 화면이 PM으로 정한다');
  assert.equal(claude.counts.tasksDone, 1);
  assert.equal(claude.counts.testsPassed, 1);
  assert.equal(claude.counts.testsFailed, 1);
  assert.equal(claude.metrics.bugRate, 0.5);
  assert.ok(claude.metrics.workMs > 0);
  assert.equal(claude.axes.find((a) => a.key === 'plan').score, 64);
  assert.equal(claude.axes.find((a) => a.key === 'plan').grade, '보통');
  assert.ok(claude.axes.find((a) => a.key === 'test').score < 50);
  assert.equal(claude.axes.find((a) => a.key === 'review').score, 50);
  assert.ok(claude.axes.find((a) => a.key === 'talk').score > 50);
  assert.equal(claude.badges.find((b) => b.id === 'first-task').earned, true);
  assert.equal(claude.badges.find((b) => b.id === 'task-10').progress, 1);
  assert.match(claude.summary, /강점 .*기획·설계/);
  assert.match(claude.summary, /버그 발생률 50%/);
  const pm = profiles.find((p) => p.author === '사람');
  assert.equal(pm.counts.assigned, 1);
  assert.equal(profiles.find((p) => p.author === 'codex').counts.decisions, 1);
  assert.equal(profiles.find((p) => p.author === 'codex').counts.testsPassed, 0);
});

test('능력치: 기록이 없으면 모두 보통(50), 성공은 100 쪽·실패는 0 쪽으로', () => {
  const empty = { tasks: { plan: 0, design: 0, implement: 0, review: 0, report: 0, any: 0 }, commits: 0, opinions: 0, bugsFound: 0, testsPassed: 0, answers: 0, decisions: 0, questions: 0, dailyReports: 0, boardReports: 0 };
  const axes = scoreAxes(empty);
  assert.ok(axes.every((a) => a.score === 50 && a.grade === '보통'));
  assert.match(summarize(axes, { bugRate: null }), /모든 능력치가 보통/);
  assert.equal(scoreAxes({ ...empty, testsFailed: 20 }).find((a) => a.key === 'test').score, 0);
  assert.equal(scoreAxes({ ...empty, tasksBlocked: 1 }).find((a) => a.key === 'build').grade, '미흡');
  assert.equal(scoreAxes({ ...empty, testsPassed: 100 }).find((a) => a.key === 'test').score, 100);
});

test('GET /api/profiles', async (t) => {
  const root = await project(t, ['login']);
  await postMessage(root, 'login', { author: 'gemini', kind: 'gemini', type: 'question', body: '질문' });
  const server = createChatServer({ root, intervalMs: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const { profiles } = await (await fetch(`http://127.0.0.1:${server.address().port}/api/profiles`)).json();
  assert.equal(profiles[0].author, 'gemini');
  assert.equal(profiles[0].axes.length, 6);
});
