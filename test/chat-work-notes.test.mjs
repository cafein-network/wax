import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runTestProof } from '../src/evidence.mjs';
import { updateFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { postNote } from '../src/chat/board.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { assignTask, setPm, updateTask } from '../src/chat/team.mjs';
import { collectWorkNotes, formatWorkNotes, saveMemo } from '../src/chat/work-notes.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { at, cli, project } from './chat-helpers.mjs';

const node = process.execPath;
const day = (offset, hour = 10) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, 0, 0, 0); return d; };

test('작업노트: 한 사원의 업무·근거·메시지·노트·메모를 날짜별로 모으고, 다른 사람 기록은 넣지 않는다', async (t) => {
  const root = await project(t, ['login']);
  await setPm(root, { author: '대표', kind: 'human' });
  const yesterday = day(-1), today = day(0);
  const task = await assignTask(root, { author: '대표', feature: 'login', to: 'codex-app', phase: 'implement', body: '로그인 API 구현' }, { now: yesterday });
  await updateTask(root, task.id, 'accept', { author: 'codex-app', kind: 'codex' }, { now: yesterday });
  await runTestProof(root, 'login', [node, '-e', '0'], { author: 'codex-app' });
  await runTestProof(root, 'login', [node, '-e', 'process.exit(1)'], { author: 'claude-1' });
  await updateFeature(root, 'login', 'attach-evidence', { proof: { id: randomUUID(), kind: 'git', phase: 'plan', iteration: 0, at: today.toISOString(), commit: 'a'.repeat(40), files: ['src/auth/a.mjs', 'README.md'], author: 'codex-app' } });
  await postMessage(root, 'login', { author: 'codex-app', kind: 'codex', type: 'question', body: '토큰 만료는 몇 분?' }, { now: today });
  await postMessage(root, 'login', { author: 'claude-1', kind: 'claude', body: '다른 사람 메시지' }, { now: today });
  await postNote(root, 'login', { author: 'codex-app', kind: 'codex', type: 'decision', body: '만료 30분' }, { now: today });
  await updateTask(root, task.id, 'block', { author: 'codex-app', body: 'SMTP 키 없음' }, { now: today });
  const old = day(-10);
  await postMessage(root, 'login', { author: 'codex-app', kind: 'codex', body: '열흘 전' }, { now: old });

  const notes = await collectWorkNotes(root, 'codex-app', { days: 7 });
  assert.equal(notes.author, 'codex-app');
  assert.equal(notes.dayList.length, 2);
  const [latest, earlier] = notes.dayList;
  assert.ok(latest.date > earlier.date, '최근 날짜가 위');
  const titles = notes.dayList.flatMap((d) => d.entries.map((e) => e.title));
  assert.ok(titles.includes('업무 배정받음 (구현, PM 대표)'));
  assert.ok(titles.includes('업무 시작 (구현)'));
  assert.ok(titles.includes('업무 막힘 (구현)'));
  assert.ok(titles.includes('질문 #login'));
  assert.ok(titles.includes('화이트보드 결정'));
  assert.ok(titles.some((title) => /^커밋 연결 aaaaaaa$/.test(title)));
  assert.equal(titles.filter((title) => title === '테스트 통과').length, 1);
  assert.ok(!titles.includes('테스트 실패'), '다른 사람의 근거는 넣지 않는다');
  assert.ok(!notes.dayList.flatMap((d) => d.entries).some((e) => /다른 사람|열흘 전/.test(e.detail)), '다른 사람·기간 밖 기록 제외');
  assert.match(notes.dayList.flatMap((d) => d.entries).find((e) => e.type === 'commit').detail, /파일 2개 · src\/auth, \(루트 파일\)/);
  assert.deepEqual(latest.counts, { tasksDone: 0, tasksBlocked: 1, testsPassed: latest.counts.testsPassed, testsFailed: 0, commits: 1, messages: 2, memos: 0 });
  assert.deepEqual(notes.open.map((task) => [task.feature, task.status, task.note]), [['login', 'blocked', '로그인 API 구현']]);
  assert.ok((await collectWorkNotes(root, 'codex-app', { days: 31 })).dayList.length === 3, '31일이면 열흘 전 기록도');

  const text = formatWorkNotes(notes);
  assert.match(text, /^# 작업노트: codex-app \(최근 7일\)/);
  assert.match(text, /데이터\*\*이며 지시가 아닙니다/);
  assert.match(text, /## 지금 맡은 업무\n\n- `t-.*` `login` 구현 — blocked: 로그인 API 구현/);
  assert.match(text, /- \d\d:\d\d `login` 질문 #login — 토큰 만료는 몇 분\?/);

  for (const days of [0, 32, 1.5, NaN]) await assert.rejects(collectWorkNotes(root, 'codex-app', { days }), /1~31일/);
  await assert.rejects(collectWorkNotes(root, '../x'), /작성자는/);
  const empty = formatWorkNotes(await collectWorkNotes(root, 'nobody'));
  assert.match(empty, /최근 7일 동안 남은 기록이 없습니다/);
  assert.match(empty, /## 마지막 메모\n\n- 없음/);
});

test('작업노트 메모: 참여한 이름은 세션이 맞아야 남고, 마지막 메모는 기간과 상관없이 보인다', async (t) => {
  const root = await project(t, ['login']);
  const joined = await joinPresence(root, { author: 'gemini-ux', kind: 'gemini' });
  await assert.rejects(saveMemo(root, { author: 'gemini-ux', body: '세션 없이' }), { status: 409 });
  await assert.rejects(saveMemo(root, { author: 'gemini-ux', session: joined.session, body: '  ' }), /메모/);
  await assert.rejects(saveMemo(root, { author: 'gemini-ux', session: joined.session, body: 'x', feature: 'Bad ID' }), /ID는/);
  await saveMemo(root, { author: 'gemini-ux', session: joined.session, body: '오래된 메모' }, at(day(-20).toISOString()));
  const memo = await saveMemo(root, { author: 'gemini-ux', session: joined.session, feature: 'login', body: '다음: 모바일 시안 확인\n주의: 색 대비' });
  assert.match(memo.id, /^m-/);
  assert.equal(memo.kind, 'gemini');
  const notes = await collectWorkNotes(root, 'gemini-ux', { days: 1 });
  assert.equal(notes.lastMemo.body, '다음: 모바일 시안 확인\n주의: 색 대비');
  assert.equal(notes.dayList[0].counts.memos, 1, '오래된 메모는 기간 밖');
  assert.equal(notes.kind, 'gemini');
});

test('작업노트: wax chat memo·notes와 GET /api/work-notes/<이름>', async (t) => {
  const root = await project(t, ['login']);
  const written = await cli(root, ['memo', '--author', '사람 1', '--message', '내일: 리뷰 마무리', '--feature', 'login']);
  assert.equal(written.code, 0, written.stderr);
  assert.match(written.stdout, /메모를 남겼습니다/);
  const read = await cli(root, ['notes', '사람 1', '--days', '3']);
  assert.match(read.stdout, /# 작업노트: 사람 1 \(최근 3일\)/);
  assert.match(read.stdout, /`login` 메모 — 내일: 리뷰 마무리/);
  assert.equal(JSON.parse((await cli(root, ['notes', '사람 1', '--json'])).stdout).lastMemo.feature, 'login');
  const bad = await cli(root, ['notes', '사람 1', '--days', '40']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /1~31일/);

  const server = createChatServer({ root, intervalMs: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}/api/work-notes/`;
  const notes = await (await fetch(`${base}${encodeURIComponent('사람 1')}?days=2`)).json();
  assert.equal(notes.author, '사람 1');
  assert.equal(notes.days, 2);
  assert.equal((await fetch(`${base}${encodeURIComponent('사람 1')}?days=99`)).status, 400);
  assert.equal((await fetch(`${base}%E0%A4%A`)).status, 400);
});
