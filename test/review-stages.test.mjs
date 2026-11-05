import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { assessReviewStages, returnStages, reviewStagePrompt, reviewStagesMode, validReviewStages } from '../src/review-stages.mjs';
import { assessQuality } from '../src/quality.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildQualityReport, characteristicEvidence } from '../src/quality-report.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildRunTrace, renderTraceMarkdown } from '../src/run-trace.mjs';
import { reviewStagesStatus } from '../src/status.mjs';
import { reviewStagesLine } from '../web/review-stages-text.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-stages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const PLAN = '# 기획\n- AC-1: 합계에 할인이 들어간다 — 검증: 단위 테스트\n- S-1: 할인 적용 — files: src/a.mjs — check: `node --test test/a.test.mjs` — done: 통과 — AC: AC-1\n- S-2: 반올림 — files: src/b.mjs — check: none(문서) — AC: AC-1\n';
async function toReview(root, id, plan = PLAN) {
  await createFeature(root, { id, title: '할인' });
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
const complete = (root, id, proofId, checks, extra = {}) => completePhase(root, id, 'review', { evidence: '검토 확인', verdict: 'pass', proofIds: [proofId], checks, reviewSeparation: 'off', ...extra });
const spec = (proofId) => [{ id: 'ac-1', status: 'pass', detail: '합계 확인', proofIds: [proofId] }, { id: 's-1', stage: 'spec', status: 'pass', detail: 'S-1 확인', proofIds: [proofId] }, { id: 's-2', status: 'pass', detail: '문서' }];
const quality = [{ id: 'q-tests', stage: 'quality', status: 'pass', detail: '경계값 있음' }, { id: 'q-structure', stage: 'quality', status: 'pass', detail: '작은 함수' },
  { id: 'q-security', stage: 'quality', status: 'pass', detail: '입력 검사' }, { id: 'q-simplicity', stage: 'quality', status: 'unverified', detail: '시간 부족 @someone' }];

const fake = (redGreen) => ({ id: 'f', iteration: 0, artifacts: { plan: PLAN }, proofs: [{ id: 'p-1', kind: 'test', iteration: 0, exitCode: 0, timedOut: false }],
  completed: redGreen ? { implement: { redGreen: { state: redGreen } } } : {} });
const assess = (checks, mode = 'warn', redGreen = 'ok') => assessReviewStages(fake(redGreen), 'review', checks, { mode });
const codes = (result) => result.record.warnings.map((item) => item.code);

test('the mode follows WAX_REVIEW_STAGES and refuses other values', () => {
  assert.equal(reviewStagesMode(undefined), 'warn');
  assert.equal(reviewStagesMode(''), 'warn');
  assert.equal(reviewStagesMode('enforce'), 'enforce');
  assert.throws(() => reviewStagesMode('strict'), /WAX_REVIEW_STAGES/);
});

test('stage defaults: spec IDs are spec, q-<name> is quality, another stage or an unknown stage is refused', () => {
  const full = [{ id: 's-1', status: 'pass', proofIds: ['p-1'] }, { id: 'S-2', status: 'pass' }, { id: 'red-green', status: 'pass' }, { id: 'q-tests', status: 'pass' }, { id: 'q-docs', status: 'pass' }];
  const result = assess(full);
  assert.deepEqual(result.record.checks.map((item) => [item.id, item.stage]), [['S-1', 'spec'], ['S-2', 'spec'], ['red-green', 'spec'], ['q-tests', 'quality'], ['q-docs', 'quality']]);
  assert.throws(() => assess([{ id: 'ac-1', stage: 'quality', status: 'pass' }]), /AC-1.*spec 단계/);
  assert.throws(() => assess([{ id: 'd-1', stage: 'quality', status: 'pass' }]), /D-1.*spec 단계/);
  assert.throws(() => assess([{ id: 'red-green', stage: 'quality', status: 'pass' }]), /red-green.*spec 단계/);
  assert.throws(() => assess([{ id: 'q-tests', stage: 'spec', status: 'pass' }]), /q-tests.*quality 단계/);
  assert.throws(() => assess([{ id: 'q-tests', stage: 'later', status: 'pass' }]), /stage는 spec, quality/);
  assert.doesNotThrow(() => assess([{ id: 'ui-review', stage: 'quality', status: 'pass' }, { id: 'q-tests', status: 'pass' }]));
  assert.throws(() => assess([{ id: 's-1', status: 'pass' }, { id: 'S-1', status: 'pass' }]), /S-1이\(가\) 중복/);
  assert.throws(() => assess([{ id: 's-9', status: 'pass' }]), /기획에 없는 계획 단계 항목입니다: S-9/);
  assert.throws(() => assess([{ id: 'q-tests', status: 'done' }]), /q-tests: status/);
  assert.throws(() => assess([{ id: 'q-tests', status: 'unverified' }]), /미검증 품질 항목 q-tests에는/);
  assert.throws(() => assess(Array.from({ length: 21 }, (_, i) => ({ id: `q-x${i}`, status: 'pass' }))), /20개까지/);
});

test('outside review: q-<name>, red-green and stage are refused, s-N is ignored as before', () => {
  assert.throws(() => assessReviewStages(fake('ok'), 'implement', [{ id: 'q-tests', status: 'pass' }]), /검토 단계에서만.*q-tests/);
  assert.throws(() => assessReviewStages(fake('ok'), 'implement', [{ id: 'red-green', status: 'pass' }]), /red-green/);
  assert.throws(() => assessReviewStages(fake('ok'), 'implement', [{ id: 'e2e-smoke', stage: 'spec', status: 'pass' }]), /e2e-smoke/);
  assert.equal(assessReviewStages(fake('ok'), 'implement', [{ id: 's-1', status: 'pass' }]).record, null);
});

test('every case of the table in every mode', () => {
  const steps = [{ id: 's-1', status: 'pass', proofIds: ['p-1'] }, { id: 's-2', status: 'pass' }];
  for (const mode of ['warn', 'enforce', 'off']) {
    assert.throws(() => assess([{ id: 's-1', status: 'fail' }, { id: 'q-tests', status: 'fail' }], mode), /명세에서 멈춤: S-1 실패/, mode);
    assert.throws(() => assess([{ id: 'red-green', status: 'fail' }], mode), /명세에서 멈춤: red-green 실패/, mode);
    assert.equal(assess([{ id: 'ac-1', status: 'fail' }, { id: 'q-tests', status: 'fail' }], mode).record, null, mode);
    assert.throws(() => assess([...steps, { id: 'q-security', status: 'fail' }], mode), /품질에서 멈춤: q-security 실패/, mode);
  }
  assert.deepEqual(codes(assess(steps)), ['noQuality']);
  assert.throws(() => assess(steps, 'enforce'), (error) => error.status === 409 && /품질 검토 항목 없음.*WAX_REVIEW_STAGES=enforce/.test(error.message));
  assert.equal(assess(steps, 'off').record, null);
  assert.deepEqual(assess([{ id: 's-1', status: 'pass' }, { id: 'q-tests', status: 'pass' }]).record.warnings, [{ code: 'stepsMissing', ids: ['S-2'] }]);
  assert.throws(() => assess([{ id: 'q-tests', status: 'pass' }], 'enforce'), /S-1, S-2.*WAX_REVIEW_STAGES=enforce/);
  const quiet = [...steps, { id: 'q-tests', status: 'pass' }];
  for (const state of ['ok', 'skipped', null]) assert.deepEqual(codes(assess(quiet, 'enforce', state)), [], String(state));
  for (const state of ['missing', 'partial', 'waived']) {
    assert.deepEqual(codes(assess(quiet, 'warn', state)), ['redGreenMissing'], state);
    assert.throws(() => assess(quiet, 'enforce', state), /red-green 검토 항목이 없습니다.*enforce/, state);
  }
  assert.deepEqual(codes(assess([...quiet, { id: 'red-green', status: 'pass' }], 'enforce', 'missing')), ['redGreenMismatch']);
  const record = assess([...quiet, { id: 'q-simplicity', status: 'unverified', detail: '못 봄' }]).record;
  assert.deepEqual([record.spec, record.quality], [{ state: 'pass', items: 2, unverified: 0 }, { state: 'pass', items: 2, unverified: 1 }]);
  assert.equal(assess([{ id: 's-1', status: 'pass' }, { id: 's-2', status: 'pass' }, { id: 'q-tests', status: 'pass' }]).record.spec.unverified, 1, 'S-1 has a check: pass without proof is unverified');
  assert.equal(validReviewStages(record), true);
});

test('complete review records stages, returns the warning, and keeps old checks files working', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'disc');
  const old = await complete(root, 'disc', proofId, [{ id: 'ac-1', status: 'pass', proofIds: [proofId] }], { reviewStages: 'warn' }).catch((error) => error);
  assert.match(old.warning, /두 단계 검토 경고\(완료는 했습니다\): 검토 항목이 없는 계획 단계: S-1, S-2.*품질 검토 항목 없음\(경고\)/);
  assert.deepEqual(old.feature.completed.review.stages.spec, { state: 'pass', items: 1, unverified: 0 });
  assert.equal(old.feature.completed.review.stages.quality.state, 'none');
  validateStored(await getFeature(root, 'disc'));

  const root2 = await workspace(t);
  const proof2 = await toReview(root2, 'disc');
  await assert.rejects(complete(root2, 'disc', proof2, [spec(proof2)[0]], { reviewStages: 'enforce' }), (error) => error.status === 409 && /WAX_REVIEW_STAGES=enforce/.test(error.message));
  assert.equal((await getFeature(root2, 'disc')).phase, 'review', 'refused before writing');
  await assert.rejects(complete(root2, 'disc', proof2, [{ id: 'ac-1', status: 'fail', proofIds: [] }, { id: 'q-tests', status: 'fail', detail: 'x' }]), /AC-1이\(가\) 실패/);
  const done = await complete(root2, 'disc', proof2, [...spec(proof2), ...quality], { reviewStages: 'enforce' });
  assert.equal(done.warning, null);
  const stages = done.feature.completed.review.stages;
  assert.deepEqual([stages.mode, stages.spec, stages.quality], ['enforce', { state: 'pass', items: 3, unverified: 0 }, { state: 'pass', items: 4, unverified: 1 }]);
  assert.equal(stages.checks.find((item) => item.id === 'q-simplicity').detail, '시간 부족 `@someone`');
  assert.equal(reviewStagesLine(stages), '명세 통과(3) → 품질 통과(3, 미검증 1)');
  assert.equal(done.feature.completed.review.acceptance[0].status, 'pass', 'AC trace is unchanged');
  validateStored(await getFeature(root2, 'disc'));
  assert.equal(validReviewStages({ ...stages, checks: [{ id: 'q-tests', stage: 'quality', status: 'fail' }] }), false);
  assert.equal(validReviewStages({ ...stages, mode: 'off' }), false);
  const status = reviewStagesStatus(await getFeature(root2, 'disc'));
  assert.equal(status.line, '명세 통과(3) → 품질 통과(3, 미검증 1)');
});

test('required checks are not broken by stage items, and the review separation rule stays separate', async (t) => {
  const feature = { id: 'w', projectType: 'web', phase: 'review', iteration: 0, workMode: 'project', proofs: [], completed: {}, artifacts: {} };
  const root = await workspace(t);
  const without = await assessQuality(root, feature, []);
  const withItems = await assessQuality(root, feature, [{ id: 'q-tests', stage: 'quality', status: 'pass', detail: 'x' }, { id: 's-1', status: 'pass' }, { id: 'red-green', status: 'pass' }]);
  assert.deepEqual(withItems.missing, without.missing);
  const root2 = await workspace(t);
  const proofId = await toReview(root2, 'same');
  const done = await complete(root2, 'same', proofId, [...spec(proofId), ...quality], { author: 'claude-a', reviewStages: 'warn', reviewSeparation: 'warn' });
  assert.equal(done.warning, '구현 세션 기록이 없어 검토 세션과 다른지 확인하지 못했습니다.', 'only the separation warning: both stages are complete');
  assert.equal(done.feature.completed.review.stages.warnings.length, 0);
});

test('iterate defects carry the stage they were found at, and the cycles are counted', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'loop');
  await assert.rejects(updateFeature(root, 'loop', 'iterate', { reason: '틀림', defects: [{ title: 'x', stage: 'design' }] }), /결함/);
  await updateFeature(root, 'loop', 'iterate', { reason: 'AC-1 틀림', defects: [{ title: '할인 빠짐', stage: 'spec' }, { title: '이름', stage: 'quality' }] });
  let feature = await getFeature(root, 'loop');
  assert.deepEqual(feature.defects.map((item) => [item.id, item.stage]), [['D-1', 'spec'], ['D-2', 'quality']]);
  validateStored(feature);
  await updateFeature(root, 'loop', 'save', { phase: 'implement', content: '# 구현 2' });
  await updateFeature(root, 'loop', 'complete', { phase: 'implement', evidence: '고침', waiver: '확인' });
  await updateFeature(root, 'loop', 'save', { phase: 'review', content: '# 검토 2' });
  await updateFeature(root, 'loop', 'iterate', { reason: '구조', defects: [{ title: '중복 코드', stage: 'quality' }, { title: '옛 모양' }] });
  feature = await getFeature(root, 'loop');
  assert.deepEqual(returnStages(feature), [{ iteration: 0, stage: 'spec', defects: 2 }, { iteration: 1, stage: 'quality', defects: 2 }]);
  assert.deepEqual(reviewStagesStatus(feature).returned, ['주기 0: 명세에서 돌아감', '주기 1: 품질에서 돌아감']);
  const pr = await buildPrBody(root, 'loop', { language: 'en' });
  assert.match(pr.body, /### Two-stage review\n\n- Iteration 0: sent back at spec\n- Iteration 1: sent back at quality/);
});

test('quality report groups the two stages and adds q- items to the ISO/IEC 25010 characteristics; PR draft and run trace show the line', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'rep');
  await complete(root, 'rep', proofId, [...spec(proofId), ...quality.map((item) => (item.id === 'q-security' ? { ...item, status: 'unverified', detail: '못 봄' } : item))], { reviewStages: 'warn' });
  const feature = await getFeature(root, 'rep');
  const byId = Object.fromEntries(characteristicEvidence(feature).map((item) => [item.id, item]));
  assert.deepEqual(byId.maintainability.sources.filter((source) => source.kind === 'review').map((source) => [source.ref, source.status]), [['q-structure', 'pass'], ['q-simplicity', 'unverified']]);
  assert.deepEqual(byId.security.sources.filter((source) => source.kind === 'review').map((source) => source.ref), ['q-security']);
  assert.ok(byId.functional.sources.some((source) => source.kind === 'review' && source.ref === 'q-tests'));
  const report = await buildQualityReport(root, 'rep', { language: 'en', freshness: null, manual: null, impact: null, deps: null });
  assert.match(report.body, /## Two-stage review\n\n.*\n\nSpec passed \(3\) → Quality passed \(2, 2 unverified\)/);
  assert.match(report.body, /\| Spec \| `S-1` \| .* \|\n\| Spec \| `S-2` \|[\s\S]*\| Quality \| `q-tests` \|/);
  assert.match(report.body, /`@someone`/);
  const pr = await buildPrBody(root, 'rep', { language: 'en' });
  assert.match(pr.body, /### Two-stage review\n\n- Spec passed \(3\) → Quality passed \(2, 2 unverified\)/);
  const trace = await buildRunTrace(root, 'rep', { language: 'en' });
  const visit = trace.visits.find((item) => item.phase === 'review' && item.outcome === 'complete');
  assert.equal(visit.stages.quality.items, 4);
  assert.match(renderTraceMarkdown(trace, 'en'), /### Two-stage review\n\n- Spec passed \(3\) → Quality passed \(2, 2 unverified\)\n- Spec S-1 — /);
  const root2 = await workspace(t);
  await createFeature(root2, { id: 'none', title: '없음' });
  assert.match((await buildQualityReport(root2, 'none', { language: 'en', freshness: null, manual: null, impact: null, deps: null })).body, /No two-stage review record/);
});

test('the review prompt fixes the order and the report prompt carries the summary; off leaves them out', async (t) => {
  const root = await workspace(t);
  const proofId = await toReview(root, 'pr');
  const feature = await getFeature(root, 'pr');
  const prompt = buildPrompt(feature, 'review');
  assert.match(prompt, /검토는 두 단계로 하세요\. 두 단계 모두 이 검토 세션이 하고, 구현한 세션은 검토하지 않습니다\./);
  assert.match(prompt, /1단계 명세: 수용 기준\(ac-N\), 계획 단계\(s-1, s-2\), 빨강→초록\(red-green, 구현 완료 기록: skipped\)/);
  assert.match(prompt, /하나라도 fail이면 거기서 멈추세요\. 품질은 보지 말고/);
  assert.match(prompt, /2단계 품질\(명세가 모두 통과한 뒤에만\): q-tests, q-structure, q-security, q-simplicity/);
  assert.deepEqual(reviewStagePrompt(feature, 'review', { mode: 'off' }), []);
  assert.deepEqual(reviewStagePrompt(feature, 'implement'), []);
  await complete(root, 'pr', proofId, [...spec(proofId), ...quality]);
  const report = reviewStagePrompt(await getFeature(root, 'pr'), 'report');
  assert.deepEqual(report, ['두 단계 검토 기록: 명세 항목 3개(미검증 0), 품질 항목 4개(미검증 1): q-tests=pass, q-structure=pass, q-security=pass, q-simplicity=unverified. 보고서에 품질 미검증 항목을 숨기지 마세요.']);
  assert.doesNotMatch(report[0], /시간 부족/);
});
