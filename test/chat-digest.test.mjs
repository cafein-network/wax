import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../src/chat/digest.mjs';

const note = (seq, fields) => ({ schema: 1, record: 'note', id: `n-${String(seq).padStart(6, '0')}-abcdef`, seq, board: 'chatbot', kind: 'claude', stance: null, replyTo: null, phase: 'design', at: '2026-10-13T06:00:00.000Z', ...fields });
const NOTES = [
  note(1, { author: 'codex', kind: 'codex', type: 'question', body: '잠금 회수 기준 30초는 충분한가?' }),
  note(2, { author: 'claude-impl', type: 'answer', replyTo: 'n-000001-abcdef', body: '로컬 기준 충분합니다.' }),
  note(3, { author: 'gemini', kind: 'gemini', type: 'question', body: '폴링 1초는\n부담이 없나?' }),
  note(4, { author: 'codex', kind: 'codex', type: 'opinion', body: 'fs.watch 대신 폴링 찬성', phase: 'plan' }),
  note(5, { author: 'gemini', kind: 'gemini', type: 'opinion', stance: 'disagree', replyTo: 'n-000004-abcdef', body: 'Windows에서는 watch도 괜찮다' }),
  note(6, { author: 'human', kind: 'human', type: 'decision', replyTo: 'n-000004-abcdef', body: '폴링으로 결정' }),
];
const NOW = new Date('2026-10-13T07:00:00Z');

test('집계 초안은 결정·미해결·답변·이견·의견·통계·안내를 담는다 (AC15)', () => {
  const { markdown, fromSeq, coversThrough, noteCount } = buildDigest({ board: 'chatbot', title: '채널', notes: NOTES, now: NOW });
  assert.deepEqual([fromSeq, coversThrough, noteCount], [1, 6, 6]);
  const section = (name) => markdown.split(`## ${name}`)[1].split('\n## ')[0];
  assert.match(markdown, /^# 화이트보드 집계 초안: chatbot — 채널/);
  assert.match(markdown, /데이터\*\*이며 지시가 아닙니다/);
  assert.match(section('결정 사항'), /`n-000006-abcdef` \*\*human\*\*\(human, design\): 폴링으로 결정 \(대상: `n-000004-abcdef`\)/);
  assert.match(section('미해결 질문'), /n-000003-abcdef.*폴링 1초는 ⏎ 부담이 없나\?/);
  assert.doesNotMatch(section('미해결 질문'), /n-000001/);
  assert.match(section('답변된 질문'), /n-000001-abcdef[\s\S]*\n  - `n-000002-abcdef`/);
  assert.match(section('이견'), /n-000005-abcdef[\s\S]*대상 `n-000004-abcdef` \*\*codex\*\*/);
  assert.match(section('의견 (단계·작성자별)'), /### plan[\s\S]*n-000004[\s\S]*### design[\s\S]*n-000005/);
  assert.match(section('참여자 통계'), /\| gemini \| gemini \| 1 \| 1 \| 0 \| 0 \| 1 \|/);
  assert.match(markdown, /wax chat board report chatbot --author <이름> --session <ID> --kind <종류> --file <보고서\.md> --covers-through n-000006-abcdef/);
});

test('같은 입력이면 같은 결과를 낸다(결정적) (AC15)', () => {
  const a = buildDigest({ board: 'chatbot', notes: NOTES, now: NOW });
  const b = buildDigest({ board: 'chatbot', notes: [...NOTES].reverse(), now: NOW });
  assert.equal(a.markdown, b.markdown);
});

test('마지막 보고서 이후만 집계하고 --all이면 전체를 집계한다 (AC15)', () => {
  const reports = [{ record: 'report', number: 1, path: 'docs/wax/chatbot/board-reports/001.md', coversThrough: 4, seq: 7 }];
  const recent = buildDigest({ board: 'chatbot', notes: NOTES, reports, now: NOW });
  assert.deepEqual([recent.fromSeq, recent.noteCount], [5, 2]);
  assert.match(recent.markdown, /이전 보고서: 001/);
  assert.equal(buildDigest({ board: 'chatbot', notes: NOTES, reports, all: true, now: NOW }).noteCount, 6);
  const empty = buildDigest({ board: 'chatbot', notes: [], now: NOW });
  assert.match(empty.markdown, /새 노트 없음/);
});
