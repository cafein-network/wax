import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPrompt, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { defectTable, dueDefects, isDefectCheck, newDefects } from '../src/defects.mjs';
import { assessQuality } from '../src/quality.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildQualityReport, characteristicEvidence } from '../src/quality-report.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-defect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const pass = () => [process.execPath, '-e', '0'];
async function toReview(root, id, { create = true } = {}) {
  if (create) {
    await createFeature(root, { id, title: '결제', projectType: 'general' });
    await updateFeature(root, id, 'save', { phase: 'plan', content: '# 기획\n- AC-1: 결제가 된다 — 검증: 단위 테스트' });
    await updateFeature(root, id, 'complete', { phase: 'plan', evidence: '기획 확인' });
    await updateFeature(root, id, 'save', { phase: 'design', content: '# 설계' });
    await updateFeature(root, id, 'complete', { phase: 'design', evidence: '설계 확인' });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현 확인', waiver: '단계 진행만 확인' });
  await updateFeature(root, id, 'save', { phase: 'review', content: '# 검토' });
  const { proof } = await runTestProof(root, id, pass(), { checks: ['func-payment', 'sec-input'], verification: 'runtime' });
  return proof.id;
}
const ac = (proofId) => ({ id: 'ac-1', status: 'pass', detail: '결제 확인', proofIds: [proofId] });
const review = (root, id, proofId, extra = {}) => updateFeature(root, id, 'complete', { phase: 'review', evidence: '검토', verdict: 'pass', proofIds: [proofId], ...extra,
  checks: [ac(proofId), ...(extra.checks ?? [])] });

test('iterate records defects with sequential IDs and the cycle they were found in', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'pay');
  await assert.rejects(updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [] }), /결함 1~20개/);
  await assert.rejects(updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [{ title: ' ' }] }), /1번째 항목/);
  await assert.rejects(updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [{ title: '금액', ac: 'AC-x' }] }), /1번째 항목/);
  const back = await updateFeature(root, 'pay', 'iterate', { reason: '금액 반올림 오류', author: 'reviewer', defects: [
    { title: '금액이 반올림된다', detail: '1.005원이 1원으로', ac: 'ac-1' }, { title: '영수증 누락' }] });
  assert.equal(back.phase, 'implement');
  assert.equal(back.iteration, 1);
  assert.deepEqual(back.defects.map(({ id, status, foundIteration, ac: linked, author }) => ({ id, status, foundIteration, ac: linked, author })), [
    { id: 'D-1', status: 'open', foundIteration: 0, ac: 'AC-1', author: 'reviewer' },
    { id: 'D-2', status: 'open', foundIteration: 0, ac: undefined, author: 'reviewer' }]);
  assert.deepEqual(back.history.at(-1).defects, ['D-1', 'D-2']);
  assert.match(buildPrompt(back, 'implement'), /열린 결함[\s\S]*- D-1: 금액이 반올림된다 \(AC-1\) — 1\.005원이 1원으로/);
  assert.deepEqual(newDefects(back, [{ title: '새 결함' }], { at: back.updatedAt }).map((item) => item.id), ['D-3']);
});

test('review must re-verify each open defect with a passing test from the current cycle', async (t) => {
  const root = await workspace(t);
  const oldProof = await toReview(root, 'pay');
  await updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [{ title: '금액 반올림' }, { title: '영수증 누락' }] });
  const proofId = await toReview(root, 'pay', { create: false });
  const feature = await getFeature(root, 'pay');
  assert.deepEqual(dueDefects(feature).map((item) => item.id), ['D-1', 'D-2']);
  assert.match(buildPrompt(feature, 'review'), /재검증할 결함 ID: D-1, D-2/);

  await assert.rejects(review(root, 'pay', proofId), /D-1\(항목 없음\), D-2\(항목 없음\).*--defect-unverified/);
  const d1 = { id: 'd-1', status: 'pass', detail: '반올림 테스트 통과', proofIds: [proofId] };
  await assert.rejects(review(root, 'pay', proofId, { checks: [d1, { id: 'd-2', status: 'fail' }], defectWaiver: '사유' }), /재검증에 실패한 결함이 있습니다: D-2/);
  await assert.rejects(review(root, 'pay', proofId, { checks: [d1, { id: 'd-2', status: 'pass', proofIds: [oldProof] }] }), /D-2\(현재 주기 통과 테스트 근거 없음\)/);
  await assert.rejects(review(root, 'pay', proofId, { checks: [d1, { id: 'd-3', status: 'pass', proofIds: [proofId] }] }), /D-3은 이번 주기에 재검증할/);
  await assert.rejects(review(root, 'pay', proofId, { checks: [d1, { ...d1, id: 'D-1' }] }), /두 번/);
  await assert.rejects(review(root, 'pay', proofId, { checks: [d1, { ...d1, id: 'd-2' }], defectWaiver: '사유' }), /함께 쓰지 마세요/);
  await assert.rejects(updateFeature(root, 'pay', 'complete', { phase: 'review', evidence: '검토', verdict: 'pass', proofIds: [proofId], checks: [ac(proofId), d1, { id: 'd-2', status: 'done' }] }), /status는 pass·fail·unverified/);

  const done = await review(root, 'pay', proofId, { checks: [d1, { id: 'd-2', status: 'unverified', detail: '출력 장치 없음' }], defectWaiver: '영수증 프린터 대기' });
  assert.deepEqual(done.completed.review.defects, [
    { id: 'D-1', status: 'resolved', proofIds: [proofId], detail: '반올림 테스트 통과' },
    { id: 'D-2', status: 'open', proofIds: [], detail: '출력 장치 없음' }]);
  assert.equal(done.completed.review.defectWaiver, '영수증 프린터 대기');
  assert.equal(done.completed.review.checks, undefined, '결함 항목은 필수 검증 목록에 섞이지 않는다');
  const [first, second] = done.defects;
  assert.equal(first.status, 'resolved');
  assert.equal(first.resolvedIteration, 1);
  assert.deepEqual(first.proofIds, [proofId]);
  assert.equal(second.status, 'open');
  assert.match(defectTable(done), /\| D-1 \| 금액 반올림 \| 해결\(재검증됨\) \| 0 \| 1 \| 테스트 /);
  assert.match(defectTable(done), /\| D-2 \| 영수증 누락 \| 열림 \| 0 \| - \| - \|/);
  assert.match(buildPrompt(done, 'report'), /결함 기록:[\s\S]*\| D-2 \| 영수증 누락 \| 열림/);
});

test('defects found in the current cycle are not due, and d-N items outside review are refused', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'pay');
  await assert.rejects(review(root, 'pay', proofId, { checks: [{ id: 'd-1', status: 'pass', proofIds: [proofId] }] }), /D-1은 이번 주기에 재검증할/);
  await assert.rejects(review(root, 'pay', proofId, { defectWaiver: '사유' }), /재검증할 열린 결함이 없어/);
  await assert.rejects(updateFeature(root, 'pay', 'complete', { phase: 'implement', evidence: 'x', checks: [{ id: 'd-1', status: 'pass' }] }), /단계만 완료|검토 단계에서만/);
  const done = await review(root, 'pay', proofId);
  assert.equal(done.completed.review.defects, undefined);
});

test('stored defect records are validated', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'pay');
  const back = await updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [{ title: '금액' }] });
  assert.doesNotThrow(() => validateStored(back));
  for (const broken of [
    { ...back.defects[0], id: 'D-0' },
    { ...back.defects[0], status: 'closed' },
    { ...back.defects[0], status: 'resolved' },
    { ...back.defects[0], resolvedAt: back.updatedAt },
    { ...back.defects[0], title: '' }]) {
    assert.throws(() => validateStored({ ...back, defects: [broken] }), /데이터 형식/);
  }
  assert.throws(() => validateStored({ ...back, defects: [back.defects[0], back.defects[0]] }), /데이터 형식/);
});

test('required-check validation ignores d-N items', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'web', title: '웹', projectType: 'web' });
  const feature = { ...(await getFeature(root, 'web')), phase: 'implement' };
  const result = await assessQuality(root, feature, [{ id: 'd-1', status: 'pass' }, { id: 'e2e-smoke', status: 'unverified', detail: '도구 없음', artifact: '', proofIds: [] }], []);
  assert.deepEqual(result.missing.length, 1);
  assert.equal(result.checks[0].detail, '도구 없음', 'd-N 항목이 있어도 필수 검증 항목은 그대로 읽는다');
  assert.equal(isDefectCheck({ id: 'D-12' }), true);
  assert.equal(isDefectCheck({ id: 'd-0' }), false);
});

test('quality report groups evidence by characteristic and lists defects and waivers', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'pay');
  await updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [{ title: '금액 | 반올림', detail: '@someone 확인' }] });
  const proofId = await toReview(root, 'pay', { create: false });
  await runTestProof(root, 'pay', [process.execPath, '-e', 'process.exit(1)'], { checks: ['perf-checkout'], verification: 'runtime' });
  await review(root, 'pay', proofId, { checks: [{ id: 'd-1', status: 'unverified' }], defectWaiver: '재현 환경 없음' });

  const evidence = characteristicEvidence(await getFeature(root, 'pay'));
  const by = Object.fromEntries(evidence.map((item) => [item.id, item]));
  assert.equal(by.functional.pass, 2, '수용 기준 1건 + func- 테스트 1건');
  assert.equal(by.security.pass, 1);
  assert.equal(by.performance.fail, 1);
  assert.equal(by.portability.pass + by.portability.fail, 0);

  const report = await buildQualityReport(root, 'pay', { language: 'ko', freshness: null });
  assert.match(report.body, /^# 품질 보고서: 결제/);
  assert.match(report.body, /공인 시험기관의 시험성적서가 아니며/);
  assert.match(report.body, /\| 기능 적합성 \| 근거 2건 \|/);
  assert.match(report.body, /\| 성능 효율성 \| 실패 1건 \|/);
  assert.match(report.body, /\| 이식성 \| 근거 없음 \| - \|/);
  assert.match(report.body, /결함 1건 · 해결\(재검증됨\) 0건 · 열림 1건/);
  assert.match(report.body, /금액 \\\| 반올림/, '표 칸 구분자는 이스케이프한다');
  assert.match(report.body, /`@someone`/, '@이름은 알림이 가지 않게 코드 표기로 바꾼다');
  assert.match(report.body, /재검증하지 못한 결함 사유 — 재현 환경 없음/);
  assert.match(report.body, /\| 0 \| 1 \| 1 \| 0 \|\n\| 1 \| 2 \| 1 \| 1 \|/);
  assert.deepEqual(report.summary.defects, { total: 1, open: 1 });
  assert.deepEqual(report.summary.acceptance, { total: 1, pass: 1 });

  const english = await buildQualityReport(root, 'pay', { language: 'en', freshness: null });
  assert.match(english.body, /^# Quality report: /);
  assert.match(english.body, /\| Functional suitability \| 2 with evidence \|/);
});

test('CLI records defects from --defects-file and writes the quality report', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'pay');
  const file = join(root, 'defects.json');
  await writeFile(file, JSON.stringify([{ title: '금액 반올림' }]));
  const run = (...args) => spawnSync(process.execPath, [CLI, '--project', root, ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });
  const iterated = run('iterate', 'pay', '--reason', '결함', '--defects-file', file);
  assert.equal(iterated.status, 0, iterated.stderr);
  assert.equal(JSON.parse(iterated.stdout).defects[0].id, 'D-1');

  const out = join(root, 'quality.md');
  const saved = run('quality-report', 'pay', '--out', out);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /품질 보고서를 저장했습니다/);
  assert.match(await readFile(out, 'utf8'), /\| D-1 \| 금액 반올림 \| 열림 \| 0 \| - \| - \|/);
  const json = run('quality-report', 'pay', '--json');
  assert.equal(JSON.parse(json.stdout).summary.defects.open, 1);
  assert.match(run('quality-report').stderr, /사용법: quality-report/);
});
