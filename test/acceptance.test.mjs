import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildPrompt, createFeature, getFeature, importFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { acceptanceIds, acceptanceTable } from '../src/acceptance.mjs';
import { assessQuality } from '../src/quality.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildContext } from '../src/context.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-ac-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const PLAN = '# 기획\n\n## 수용 기준\n- AC-1: 로그인하면 홈으로 간다 — 검증: e2e\n- **AC-2**: 잘못된 비밀번호는 거절 — 검증: 단위 테스트\n\nAC-1과 같은 흐름은 본문 언급이라 새 선언이 아니다.\n';
async function toReview(root, id, plan = PLAN) {
  await createFeature(root, { id, title: '로그인' });
  await updateFeature(root, id, 'save', { phase: 'plan', content: plan });
  await updateFeature(root, id, 'complete', { phase: 'plan', evidence: '기획 확인' });
  await updateFeature(root, id, 'save', { phase: 'design', content: '# 설계' });
  await updateFeature(root, id, 'complete', { phase: 'design', evidence: '설계 확인' });
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현 확인', waiver: '단계 진행만 확인' });
  await updateFeature(root, id, 'save', { phase: 'review', content: '# 검토' });
  const { proof } = await runTestProof(root, id, [process.execPath, '-e', '0']);
  return proof.id;
}
const review = (root, id, extra = {}) => updateFeature(root, id, 'complete', { phase: 'review', evidence: '수용 기준 확인', verdict: 'pass', ...extra });

test('plan AC IDs are read only from the start of a line', () => {
  assert.deepEqual(acceptanceIds(PLAN), ['AC-1', 'AC-2']);
  assert.deepEqual(acceptanceIds('| AC-3 | 표 칸 |\n> AC-10: 인용\n# AC-2 제목\n  * AC-3: 중복\n'), ['AC-2', 'AC-3', 'AC-10']);
  assert.deepEqual(acceptanceIds('본문의 AC-1 언급\nAC-0: 0번\nAC-1a: 접미사\nAC-12V 어댑터\nac-4: 소문자\nAC-1000: 범위 밖'), []);
  assert.deepEqual(acceptanceIds(undefined), []);
});

test('plans without AC IDs complete review as before and reject stray ac items', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'plain', '# 기획\n수용 기준: 로그인된다');
  await assert.rejects(review(root, 'plain', { proofIds: [proofId], checks: [{ id: 'ac-1', status: 'pass', proofIds: [proofId] }] }), /기획 문서에 없는 수용 기준/);
  await assert.rejects(review(root, 'plain', { proofIds: [proofId], acWaiver: '사유' }), /AC-N\)가 없어/);
  const done = await review(root, 'plain', { proofIds: [proofId] });
  assert.equal(done.completed.review.acceptance, undefined);
  assert.equal(acceptanceTable(done), '');
});

test('review must trace every plan AC to current-cycle proof or a recorded reason', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'login');
  const base = { proofIds: [proofId] };
  await assert.rejects(review(root, 'login', base), /AC-1\(항목 없음\), AC-2\(항목 없음\).*--ac-unverified/);
  const pass1 = { id: 'ac-1', status: 'pass', detail: '로그인 후 홈 확인', proofIds: [proofId] };
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1] }), /AC-2\(항목 없음\)/);
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1, { id: 'AC-2', status: 'pass', proofIds: [randomUUID()] }] }), /AC-2\(현재 주기 통과 근거 없음\)/);
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1, { id: 'ac-2', status: 'fail', proofIds: [] }], acWaiver: '사유' }), /AC-2이\(가\) 실패/);
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1, { id: 'ac-3', status: 'pass', proofIds: [proofId] }] }), /AC-3은\(는\) 기획 문서에 없는/);
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1, { ...pass1, id: 'AC-1' }] }), /중복/);
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1, { id: 'ac-2', status: 'done' }] }), /status\(pass\/fail\/unverified\)/);
  await assert.rejects(review(root, 'login', { ...base, checks: [pass1, { ...pass1, id: 'ac-2' }], acWaiver: '사유' }), /함께 쓰지 마세요/);

  const done = await review(root, 'login', { ...base, checks: [pass1, { id: 'ac-2', status: 'unverified', detail: '테스트 계정 없음' }], acWaiver: '테스트 계정 발급 대기' });
  assert.deepEqual(done.completed.review.acceptance, [
    { id: 'AC-1', status: 'pass', proofIds: [proofId], detail: '로그인 후 홈 확인' },
    { id: 'AC-2', status: 'unverified', proofIds: [], detail: '테스트 계정 없음' }]);
  assert.equal(done.completed.review.acWaiver, '테스트 계정 발급 대기');
  assert.equal(done.completed.review.checks, undefined, 'AC 항목은 필수 검증 목록에 섞이지 않는다');

  const table = acceptanceTable(done);
  assert.match(table, /\| AC-1 \| 통과 \| 테스트 .* \(exit=0, /);
  assert.match(table, /\| AC-2 \| 미검증 \| - \|/);
  assert.match(table, /미검증 사유: 테스트 계정 발급 대기/);
  assert.match(buildPrompt(done, 'report'), /수용 기준 추적표[\s\S]*\| AC-2 \| 미검증/);
  const context = await buildContext(root, 'login', { budget: 6000 });
  assert.match(context, /## 수용 기준 추적표[\s\S]*- AC-1: 통과, 근거 "테스트[\s\S]*- AC-2: 미검증[\s\S]*- 미검증 사유: "테스트 계정 발급 대기"/);

  const stored = await getFeature(root, 'login');
  await importFeature(root, stored, 'login-copy');
  assert.deepEqual((await getFeature(root, 'login-copy')).completed.review.acceptance, stored.completed.review.acceptance);
  const broken = structuredClone(stored); broken.completed.review.acceptance[0].status = 'ok';
  assert.throws(() => validateStored(broken), /데이터 형식/);
  const misplaced = structuredClone(stored); misplaced.completed.design.acWaiver = '사유';
  assert.throws(() => validateStored(misplaced), /데이터 형식/);
});

test('ac items are review-only and prompts list the plan AC IDs', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'early', title: '로그인' });
  await updateFeature(root, 'early', 'save', { phase: 'plan', content: PLAN });
  await assert.rejects(updateFeature(root, 'early', 'complete', { phase: 'plan', evidence: '기획', checks: [{ id: 'ac-1', status: 'pass', proofIds: [] }] }), /검토 단계에서만/);
  const feature = await getFeature(root, 'early');
  assert.match(buildPrompt(feature, 'plan'), /"- AC-1: <기준> — 검증: <방법>"/);
  assert.match(buildPrompt(feature, 'review'), /기획의 수용 기준 ID: AC-1, AC-2\. .*--checks-file.*--ac-unverified/);
  assert.match(buildPrompt(feature, 'report'), /\| AC-1 \| 검토 전 \| - \|/);
});

test('required quality checks ignore ac items in the same checks file', async () => {
  const proof = { id: randomUUID(), kind: 'test', phase: 'review', iteration: 0, exitCode: 0, timedOut: false, verification: 'runtime', checks: ['e2e-acceptance'] };
  const feature = { projectType: 'web', phase: 'review', workMode: 'project', iteration: 0, proofs: [proof] };
  const checks = [{ id: 'e2e-acceptance', status: 'pass', detail: '시나리오 통과', artifact: '', proofIds: [proof.id] }, { id: 'ac-1', status: 'pass', proofIds: [proof.id] }];
  const quality = await assessQuality(process.cwd(), feature, checks, [proof.id]);
  assert.equal(quality.checks.find((check) => check.id === 'e2e-acceptance').status, 'pass');
  assert.deepEqual(quality.missing, ['로딩·오류·빈 상태와 모바일 화면 검토']);
});

test('CLI review takes ac items from --checks-file, --ac-unverified, and status shows the trace', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'cli');
  const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' });
  const file = join(root, 'checks.json');
  await writeFile(file, JSON.stringify([{ id: 'ac-1', status: 'pass', detail: '확인', proofIds: [proofId] }]));
  const refused = run('complete', 'review', 'cli', '--evidence', '확인', '--verdict', 'pass', '--proofs', proofId, '--checks-file', file);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /AC-2\(항목 없음\)/);
  const done = run('complete', 'review', 'cli', '--evidence', '확인', '--verdict', 'pass', '--proofs', proofId, '--checks-file', file, '--ac-unverified', '외부 API 대기');
  assert.equal(done.status, 0, done.stderr);
  const status = JSON.parse(run('status', 'cli').stdout);
  assert.deepEqual(status.acceptanceTrace.map((item) => [item.id, item.status]), [['AC-1', 'pass'], ['AC-2', 'unverified']]);
  assert.equal(JSON.parse(run('status').stdout)[0].acceptanceTrace, undefined);
});

test('수용 기준: wax-service가 같은 ID·추적표를 쓰도록 @cafein-network/wax/acceptance로 내보낸다', async () => {
  const exported = await import('@cafein-network/wax/acceptance');
  assert.equal(exported.acceptanceIds, acceptanceIds, '플러그인 안과 같은 함수');
  assert.equal(exported.acceptanceTable, acceptanceTable);
  assert.deepEqual(exported.acceptanceIds('- AC-2: 둘\n- AC-1: 하나'), ['AC-1', 'AC-2']);
});
