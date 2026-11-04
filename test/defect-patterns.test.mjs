import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { collectSources, proposeRule, ruleCandidates } from '../src/chat/rules.mjs';
import { renderTraceMarkdown, traceVisits } from '../src/run-trace.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-defect-pattern-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function toReview(root, id, { create = true } = {}) {
  if (create) {
    await createFeature(root, { id, title: id, projectType: 'general' });
    for (const phase of ['plan', 'design']) {
      await updateFeature(root, id, 'save', { phase, content: `# ${phase}` });
      await updateFeature(root, id, 'complete', { phase, evidence: '확인' });
    }
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현', waiver: '단계 진행만 확인' });
  await updateFeature(root, id, 'save', { phase: 'review', content: '# 검토' });
  return (await runTestProof(root, id, [process.execPath, '-e', '0'])).proof.id;
}

test('defects become rule sources, and a defect repeated across tasks is listed first', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'pay');
  await updateFeature(root, 'pay', 'iterate', { reason: '결함', defects: [{ title: '금액이 반올림된다', detail: '1.005원' }, { title: '영수증 누락' }] });
  await toReview(root, 'refund');
  await updateFeature(root, 'refund', 'iterate', { reason: '결함', defects: [{ title: '금액이 반올림된다!' }] });

  const sources = (await collectSources(root)).filter((source) => source.kind === 'defect');
  assert.deepEqual(sources.map((source) => [source.ref, source.repeats]).sort(), [['defect:pay/D-1', 2], ['defect:pay/D-2', 1], ['defect:refund/D-1', 2]]);
  assert.match(sources.find((source) => source.ref === 'defect:pay/D-1').title, /반복된 결함 D-1 \(작업 2개\)/);
  assert.equal(sources.find((source) => source.ref === 'defect:pay/D-1').detail, '금액이 반올림된다 — 1.005원');
  assert.match(sources.find((source) => source.ref === 'defect:pay/D-2').title, /검토에서 찾은 결함 D-2/);

  const candidates = await ruleCandidates(root);
  assert.deepEqual(candidates.slice(0, 2).map((source) => source.ref).sort(), ['defect:pay/D-1', 'defect:refund/D-1'], 'repeated defects come first');

  const rule = await proposeRule(root, { author: 'codex-app', body: '금액은 정수 원 단위로 계산한다', why: '두 작업에서 같은 반올림 결함', sources: ['defect:pay/D-1', 'defect:refund/D-1'] });
  assert.deepEqual(rule.sources, ['defect:pay/D-1', 'defect:refund/D-1']);
  assert.ok(!(await ruleCandidates(root)).some((source) => source.ref === 'defect:pay/D-1'), 'a cited defect is no longer a candidate');
  await assert.rejects(proposeRule(root, { author: 'codex-app', body: '다른 규칙', why: '없는 결함', sources: ['defect:pay/D-9'] }), { status: 404 });
  await assert.rejects(proposeRule(root, { author: 'codex-app', body: '다른 규칙', why: '형식', sources: ['defect:pay/d-1'] }), /근거\(--source\)/);
});

test('the run trace shows defects logged by a review and their re-verification in the next review', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'pay');
  await updateFeature(root, 'pay', 'iterate', { reason: '반올림 결함', defects: [{ title: '금액이 반올림된다' }, { title: '영수증 누락' }] });
  const proofId = await toReview(root, 'pay', { create: false });

  let trace = traceVisits(await getFeature(root, 'pay'));
  let visits = trace.visits;
  const first = visits.find((visit) => visit.phase === 'review' && visit.outcome === 'iterate');
  assert.deepEqual(first.loggedDefects, [{ id: 'D-1', title: '금액이 반올림된다' }, { id: 'D-2', title: '영수증 누락' }]);
  assert.equal(first.defects, null, 'nothing was due in the first review');
  const open = visits.at(-1);
  assert.equal(open.open, true);
  assert.deepEqual(open.defects.map(({ id, status }) => [id, status]), [['D-1', 'pending'], ['D-2', 'pending']], 'an open review lists the defects to re-verify');

  await updateFeature(root, 'pay', 'complete', { phase: 'review', evidence: '검토', verdict: 'pass', proofIds: [proofId], defectWaiver: '프린터 없음',
    checks: [{ id: 'd-1', status: 'pass', detail: '정수 계산 확인', proofIds: [proofId] }, { id: 'd-2', status: 'unverified' }] });
  trace = traceVisits(await getFeature(root, 'pay'));
  visits = trace.visits;
  const second = visits.find((visit) => visit.phase === 'review' && visit.outcome === 'complete');
  assert.deepEqual(second.defects.map(({ id, status, title }) => [id, status, title]), [['D-1', 'resolved', '금액이 반올림된다'], ['D-2', 'open', '영수증 누락']]);
  assert.equal(second.defectWaiver, '프린터 없음');
  assert.ok(visits.filter((visit) => visit.phase !== 'review').every((visit) => visit.defects === null));

  const markdown = renderTraceMarkdown({ ...trace, freshness: null }, 'ko');
  assert.match(markdown, /### 이 검토에서 기록한 결함\n\n- D-1 금액이 반올림된다\n- D-2 영수증 누락/);
  assert.match(markdown, /### 결함 재검증[\s\S]*\| D-1 금액이 반올림된다 \| 해결\(재검증됨\) \| `[0-9a-f]{8}` — 정수 계산 확인 \|[\s\S]*\| D-2 영수증 누락 \| 열림 \| - \|[\s\S]*재검증하지 못한 결함 사유 — 프린터 없음/);
});
