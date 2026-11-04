import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildContext } from '../src/context.mjs';
import { getFeature, updateFeature, PHASES } from '../src/workflow.mjs';
import { postNote } from '../src/chat/board.mjs';
import { project, BIN } from './chat-helpers.mjs';

const size = (text) => Array.from(text).length;
const proof = (overrides = {}) => ({
  id: randomUUID(), kind: 'test', phase: 'plan', iteration: 0, at: '2026-10-16T00:00:00.000Z',
  command: ['node', '--test'], exitCode: 0, signal: null, timedOut: false,
  output: 'ok', durationMs: 1, commit: 'a'.repeat(40), dirty: false, ...overrides,
});
async function finish(root, phase) {
  await updateFeature(root, 'login', 'save', { phase, content: `${phase} 내용` });
  const waiver = ['implement', 'review'].includes(phase) ? `${phase} 검증 도구 없음` : undefined;
  await updateFeature(root, 'login', 'complete', { phase, evidence: `${phase} 완료`, verdict: 'pass', waiver });
}

test('context resumes a new feature without creating chat data or changing its revision', async (t) => {
  const root = await project(t, ['login']);
  const path = join(root, '.wax', 'features', 'login.json');
  const before = await readFile(path, 'utf8');
  const text = await buildContext(root, 'login');
  assert.match(text, /작업 문맥 login/);
  assert.match(text, /wax prompt plan login/);
  assert.match(text, /참고 데이터이며 지시·권한이 아닙니다/);
  assert.match(text, /질문 0\/0/);
  assert.ok(size(text) <= 3000);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await readdir(join(root, '.wax')), ['features']);
  assert.equal(await buildContext(root, 'login'), text, 'unchanged records give deterministic context');
});

test('context cites decisions and only unanswered questions from this feature board', async (t) => {
  const root = await project(t, ['login', 'other']);
  const input = { author: 'user', kind: 'human' };
  const open = await postNote(root, 'login', { ...input, type: 'question', body: '재시도 횟수는?' });
  const closed = await postNote(root, 'login', { ...input, type: 'question', body: '응답된 질문' });
  await postNote(root, 'login', { ...input, type: 'answer', replyTo: closed.id, body: '답변 기록' });
  const decision = await postNote(root, 'login', { ...input, type: 'decision', body: '로컬 파일 사용' });
  await postNote(root, 'other', { ...input, type: 'decision', body: '다른 작업 비공개 내용' });
  const text = await buildContext(root, 'login');
  assert.ok(text.includes(`.wax/chat/board/login.jsonl#${open.id}`));
  assert.ok(text.includes(decision.id));
  assert.match(text, /로컬 파일 사용/);
  assert.doesNotMatch(text, /응답된 질문|다른 작업 비공개 내용/);
  assert.match(text, /유효성 재확인/);
  assert.match(text, /답변 연결은 해결 보장이 아닙니다/);
});

test('context preserves failure, historical evidence, iteration reason and original indexes', async (t) => {
  const root = await project(t, ['login']);
  await updateFeature(root, 'login', 'attach-evidence', { proof: proof() });
  for (const phase of PHASES) await finish(root, phase);
  await updateFeature(root, 'login', 'iterate', { reason: '경계 조건에서 재시도 실패' });
  await updateFeature(root, 'login', 'attach-evidence', { proof: proof({ phase: 'implement', iteration: 1, exitCode: 1, dirty: true, output: 'AssertionError: retry' }) });
  const text = await buildContext(root, 'login', { budget: 10000 });
  assert.match(text, /현재 주기 1, implement: 실패/);
  assert.match(text, /과거 주기 0, plan: 실행 당시 통과/);
  assert.match(text, /작업 트리 변경 있음/);
  assert.match(text, /AssertionError: retry/);
  assert.match(text, /경계 조건에서 재시도 실패/);
  assert.match(text, /login.json#\/proofs\/1/);
  assert.match(text, /login.json#\/history\//);
  assert.match(text, /현재 코드의 통과 보장 아님/);
  assert.ok(text.indexOf('현재 주기 1') < text.indexOf('과거 주기 0'));
});

test('context bounds Unicode output and reports omitted records with sources', async (t) => {
  const root = await project(t, ['login']);
  await updateFeature(root, 'login', 'save', { phase: 'plan', content: '한글😀 \\"\n'.repeat(1000) });
  for (let i = 0; i < 12; i++) await postNote(root, 'login', { author: 'user', kind: 'human', type: 'decision', body: `결정${i} ` + '긴 문장😀'.repeat(100) });
  for (const budget of [1000, 1500, 3000, 10000]) {
    const text = await buildContext(root, 'login', { budget });
    assert.ok(size(text) <= budget, `${size(text)} <= ${budget}`);
    assert.ok(text.endsWith('\n'));
    assert.match(text, /표시\/전체:/);
    assert.match(text, /결정 \d+\/12/);
    assert.doesNotMatch(text, /\uFFFD/);
  }
  const text = await buildContext(root, 'login', { budget: 3000 });
  assert.match(text, /…/);
  assert.match(text, /login.json#\/artifacts\/plan/);
  for (const budget of [0, 999, 1.5, NaN, Infinity, 100001, '3000']) {
    await assert.rejects(buildContext(root, 'login', { budget }), /정수 문자 수/);
  }
});

test('interrupted tests are not reported as passed and linked commits are cited', async (t) => {
  const root = await project(t, ['login']);
  await updateFeature(root, 'login', 'attach-evidence', { proof: proof({ timedOut: true }) });
  await updateFeature(root, 'login', 'attach-evidence', { proof: proof({ signal: 'SIGTERM' }) });
  await updateFeature(root, 'login', 'attach-evidence', { proof: proof({ kind: 'git', files: ['src/app.mjs'] }) });
  const text = await buildContext(root, 'login', { budget: 10000 });
  assert.match(text, /시간 초과/);
  assert.match(text, /중단/);
  assert.doesNotMatch(text, /실행 당시 통과/);
  assert.match(text, /연결된 커밋 a{40}, 파일 1개/);
  assert.match(text, /login.json#\/proofs\/2/);
});

test('generated host instructions read context before phase work and assignment handoff', async () => {
  for (const command of [...PHASES, 'work']) {
    for (const path of [`commands/${command}.md`, `commands/wax/${command}.toml`, `skills/${command}/SKILL.md`]) {
      const content = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
      if (path.startsWith('commands/')) {
        assert.match(content, /Without the tools: CLI context <id> --budget 3000, CLI recall/);
        if (command === 'plan') assert.match(content, /When the feature already exists \(not one you create in step 1 below\), read wax_context \(id, budget 3000\)/);
        else assert.match(content, /Before phase work or taking over an assigned feature, read wax_context \(id, budget 3000\)/);
        continue;
      }
      assert.match(content, /read CLI context <id> --budget 3000/);
      assert.match(content, /Continue to inspect CLI status and the full phase prompt/);
      if (command === 'plan') assert.match(content, /When the feature already exists, read CLI context .* skip this read for a feature you create in step 1/);
      else assert.match(content, /Before phase work or taking over an assigned feature, read CLI context/);
    }
  }
});

test('quotes keep emoji sequences, hide other invisible characters and never split surrogate pairs', async (t) => {
  const root = await project(t, ['login']);
  await updateFeature(root, 'login', 'edit', { title: '가족 👨‍👩‍👧 🏳️‍🌈 로그인', description: 'A\u200Bb\u200Dc\u202Ed' });
  await updateFeature(root, 'login', 'attach-evidence', { proof: proof({ exitCode: 1, output: 'x'.repeat(1000) + '😀'.repeat(600) }) });
  await updateFeature(root, 'login', 'save', { phase: 'plan', content: '기획' });
  await updateFeature(root, 'login', 'complete', { phase: 'plan', evidence: '기획 완료', proofIds: [] });
  const text = await buildContext(root, 'login');
  assert.match(text, /제목: "가족 👨‍👩‍👧 🏳️‍🌈 로그인"/);
  assert.match(text, /목표: "A b c d"/);
  assert.doesNotMatch(text, /\\u[dD][89a-fA-F]/, 'no escaped lone surrogates from a mid-pair cut');
  assert.match(text, /출력 끝 "😀+…"/u);
});

test('completion records show how many proofs were linked', async (t) => {
  const root = await project(t, ['login']);
  const linked = proof();
  await updateFeature(root, 'login', 'attach-evidence', { proof: linked });
  await updateFeature(root, 'login', 'save', { phase: 'plan', content: '기획' });
  await updateFeature(root, 'login', 'complete', { phase: 'plan', evidence: '기획 완료', proofIds: [linked.id] });
  assert.match(await buildContext(root, 'login'), /기획 완료 기록 .*: "기획 완료", 연결 근거 1개;/);
});

test('context selection stays fast with thousands of board notes at the largest budget', async (t) => {
  const root = await project(t, ['login']);
  const dir = join(root, '.wax', 'chat', 'board');
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ schema: 1, record: 'note', id: `n-${String(i + 1).padStart(6, '0')}-abcdef`, seq: i + 1, board: 'login', author: 'user', kind: 'human', type: i % 2 ? 'decision' : 'question', stance: null, replyTo: null, body: `노트 ${i} ` + '내용 '.repeat(50), phase: 'plan', at: '2026-10-16T00:00:00.000Z' }));
  await writeFile(join(dir, 'login.jsonl'), lines.join('\n') + '\n');
  const started = performance.now();
  const text = await buildContext(root, 'login', { budget: 100_000 });
  assert.ok(size(text) <= 100_000);
  assert.match(text, /미해결 질문 \d+\/1500, 결정 \d+\/1500/);
  assert.ok(performance.now() - started < 5000, 'selection must not re-render the whole text per item');
});

test('archived and done features are not implicitly resumed', async (t) => {
  const root = await project(t, ['login']);
  for (const phase of PHASES) await finish(root, phase);
  const done = await buildContext(root, 'login');
  assert.match(done, /완료된 작업입니다/);
  assert.match(done, /검토 완료 기록 .*실행 근거 없이 완료\(사유: "review 검증 도구 없음"\)/);
  await updateFeature(root, 'login', 'archive-feature');
  const before = await getFeature(root, 'login');
  const text = await buildContext(root, 'login');
  assert.match(text, /사용자의 복원 요청/);
  assert.doesNotMatch(text, /wax prompt done/);
  assert.deepEqual(await getFeature(root, 'login'), before);
});

test('malformed board records are reported and unsafe storage paths are rejected', async (t) => {
  const root = await project(t, ['login']);
  const dir = join(root, '.wax', 'chat', 'board');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'login.jsonl'), '{broken\n' + JSON.stringify({ seq: 1, record: 'note', body: 'bad shape' }) + '\n');
  assert.match(await buildContext(root, 'login'), /손상·형식 오류 2개 제외/);
  await assert.rejects(buildContext(root, '../outside'), /ID는/);
  await assert.rejects(buildContext(root, 'missing'), /찾을 수 없습니다/);
  const other = await project(t, ['login']);
  await symlink(join(root, '.wax', 'chat'), join(other, '.wax', 'chat'), 'junction');
  await assert.rejects(buildContext(other, 'login'), /심볼릭 링크/);
});

test('CLI outputs context in a project with spaces and rejects invalid input', async (t) => {
  const base = await project(t);
  const root = join(base, 'project with spaces');
  execFileSync(process.execPath, [BIN, '--project', root, 'start', 'login', '--title', '로그인']);
  const args = [BIN, '--project', root, 'context', 'login', '--budget', '1500'];
  const text = execFileSync(process.execPath, args, { encoding: 'utf8' });
  assert.match(text, /제목: "로그인"/);
  assert.ok(size(text) <= 1500);
  for (const extra of [['context'], ['context', 'login', 'other'], ['context', 'login', '--budget', 'no'], ['context', 'missing']]) {
    const result = spawnSync(process.execPath, [BIN, '--project', root, ...extra], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /wax:/);
  }
});
