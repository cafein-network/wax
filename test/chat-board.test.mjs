import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listBoard, postNote, readReport, saveReport } from '../src/chat/board.mjs';
import { listPresence } from '../src/chat/presence.mjs';
import { buildDigest } from '../src/chat/digest.mjs';
import { project } from './chat-helpers.mjs';

test('노트를 저장하고 유형·stance·replyTo 규칙을 지킨다 (AC14)', async (t) => {
  const root = await project(t, ['chatbot']);
  const question = await postNote(root, 'chatbot', { author: 'codex', kind: 'codex', type: 'question', body: '잠금 30초 충분?' });
  assert.match(question.id, /^n-000001-/);
  assert.equal(question.phase, 'plan');
  const answer = await postNote(root, 'chatbot', { author: 'claude-impl', kind: 'claude', type: 'answer', replyTo: question.id, body: '충분' });
  assert.equal(answer.replyTo, question.id);
  await assert.rejects(postNote(root, 'chatbot', { author: 'a', type: 'answer', body: 'x' }), /reply-to/);
  await assert.rejects(postNote(root, 'chatbot', { author: 'a', type: 'opinion', stance: 'disagree', body: 'x' }), /stance/);
  await assert.rejects(postNote(root, 'chatbot', { author: 'a', type: 'opinion', replyTo: 'n-000099-abcdef', body: 'x' }), /없습니다/);
  await assert.rejects(postNote(root, 'chatbot', { author: 'a', type: 'message', body: 'x' }), /노트 유형/);
  const decision = await postNote(root, 'chatbot', { author: 'human', kind: 'human', type: 'decision', body: '단독 결정' });
  assert.equal(decision.replyTo, null);
  const { notes } = await listBoard(root, 'chatbot');
  assert.equal(notes.length, 3);
  assert.ok(await readFile(join(root, '.wax', 'chat', 'board', 'chatbot.jsonl'), 'utf8'));
  const authors = (await listPresence(root)).map((p) => p.author);
  assert.deepEqual(authors, ['claude-impl', 'codex', 'human']);
});

test('보고서는 새 번호로 만들고 덮어쓰지 않으며 다음 집계는 그 이후부터 한다 (AC16)', async (t) => {
  const root = await project(t, ['chatbot']);
  await assert.rejects(saveReport(root, 'chatbot', { author: 'a', markdown: '# 빈' }), /노트가 없어/);
  const first = await postNote(root, 'chatbot', { author: 'a', type: 'opinion', body: '하나' });
  await postNote(root, 'chatbot', { author: 'b', type: 'opinion', body: '둘' });
  const report = await saveReport(root, 'chatbot', { author: 'claude-impl', kind: 'claude', markdown: '# 보고서 1' });
  assert.deepEqual([report.number, report.path, report.coversThrough, report.noteCount], [1, 'docs/wax/chatbot/board-reports/001.md', 2, 2]);
  assert.equal(await readFile(join(root, report.path), 'utf8'), '# 보고서 1\n');
  assert.equal(await readReport(root, 'chatbot', 1), '# 보고서 1\n');

  await postNote(root, 'chatbot', { author: 'c', type: 'question', body: '셋?' });
  const { notes, reports } = await listBoard(root, 'chatbot');
  const digest = buildDigest({ board: 'chatbot', notes, reports, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(digest.fromSeq, 3, 'coversThrough(2) + 1');
  assert.equal(digest.noteCount, 1);
  assert.match(digest.markdown, /셋\?/);
  assert.doesNotMatch(digest.markdown, /하나/);

  await mkdir(join(root, 'docs', 'wax', 'chatbot', 'board-reports'), { recursive: true });
  await writeFile(join(root, 'docs', 'wax', 'chatbot', 'board-reports', '002.md'), '사용자 파일');
  await assert.rejects(saveReport(root, 'chatbot', { author: 'a', markdown: '# 2' }), (error) => error.status === 409);
  assert.equal(await readFile(join(root, 'docs', 'wax', 'chatbot', 'board-reports', '002.md'), 'utf8'), '사용자 파일');
  await assert.rejects(saveReport(root, 'chatbot', { author: 'a', markdown: '# 2', coversThrough: first.id.replace('n-000001', 'n-000099') }), /노트 ID/);
});

test('동시에 보고서 5개를 등록해도 번호가 겹치지 않는다 (AC16)', async (t) => {
  const root = await project(t, ['chatbot']);
  await postNote(root, 'chatbot', { author: 'a', type: 'opinion', body: '의견' });
  const reports = await Promise.all(Array.from({ length: 5 }, (_, i) => saveReport(root, 'chatbot', { author: `agent-${i}`, markdown: `# 보고서 ${i}` })));
  assert.deepEqual(reports.map((r) => r.number).sort(), [1, 2, 3, 4, 5]);
  for (const report of reports) assert.match(await readFile(join(root, report.path), 'utf8'), /^# 보고서 \d\n$/);
});
