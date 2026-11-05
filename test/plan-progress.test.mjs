import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildPrompt, completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { assessStepProgress, checkText, matchesStep, proofStep, stepProgress, stepPrompt, withStepPairs } from '../src/plan-progress.mjs';
import { planSteps, validPlanSteps } from '../src/plan-steps.mjs';
import { validRedGreen } from '../src/red-green.mjs';
import { validProof } from '../src/proof-schema.mjs';
import { featureStatus } from '../src/status.mjs';
import { buildContext } from '../src/context.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildQualityReport } from '../src/quality-report.mjs';
import { buildRunTrace, renderTraceMarkdown } from '../src/run-trace.mjs';
import { planStepsLine, stepStateText } from '../web/plan-steps-text.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);
let clock = Date.parse('2026-11-05T00:00:00Z');
const at = () => new Date(clock += 1000).toISOString();
const PLAN = `# 기획
- AC-1: 합계
- AC-2: 문서
- S-1: 합계 고침 — files: src/sum.mjs — check: \`node --test test/sum.test.mjs\` — done: 통과 — AC: AC-1
- S-2: 검사 ID 단계 — check: checks=e2e-smoke — AC: AC-1
- S-3: README @someone 예 — files: README.md — check: 없음(문서만) — AC: AC-2
`;
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command: ['node', '--test', 'test/sum.test.mjs'], commit: HEAD, dirty: true,
  durationMs: 1, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: { head: HEAD, files: { 'src/sum.mjs': 'b'.repeat(40) } }, ...extra });
const feature = (proofs = [], extra = {}) => ({ id: 'sum', phase: 'implement', iteration: 0, artifacts: { plan: PLAN }, proofs, ...extra });

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-plan-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function toImplement(root, id, plan = PLAN) {
  await createFeature(root, { id, title: '합계', projectType: 'general' });
  await updateFeature(root, id, 'save', { phase: 'plan', content: plan });
  await completePhase(root, id, 'plan', { evidence: '기획 확인', planSteps: 'warn' });
  await updateFeature(root, id, 'save', { phase: 'design', content: '# 설계' });
  await updateFeature(root, id, 'complete', { phase: 'design', evidence: '설계 확인' });
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
}
const attach = (root, id, item) => getFeature(root, id).then((current) => updateFeature(root, id, 'attach-evidence', { proof: item, revision: current.revision }));

test('a proof matches a step by the whole command (Windows slashes too) or by all of its checks IDs', () => {
  const [s1, s2, s3] = planSteps(PLAN);
  assert.equal(matchesStep(proof(), s1), true);
  assert.equal(matchesStep(proof({ command: ['node', '--test'] }), s1), false);
  assert.equal(matchesStep(proof({ command: ['node', '--test', 'test\\sum.test.mjs'] }), s1, 'win32'), true);
  assert.equal(matchesStep(proof({ command: ['node', '--test', 'test\\sum.test.mjs'] }), s1, 'linux'), false);
  assert.equal(matchesStep(proof({ verification: 'runtime', checks: ['func-sum'] }), s1), true);
  assert.equal(matchesStep(proof({ verification: 'runtime', checks: ['e2e-smoke', 'x'] }), s2), true);
  assert.equal(matchesStep(proof(), s2), false);
  assert.equal(matchesStep(proof(), s3), false);
  assert.equal(checkText({ argv: ['node', 'a b.js'] }), 'node "a b.js"');
  assert.equal(checkText({ checks: ['a', 'b'] }), 'checks=a,b');
  assert.equal(checkText({ none: 'x' }), null);
});

test('proofStep tags matching implement runs, accepts only known S-N in implement, and flags --step with another command', (t) => {
  const command = ['node', '--test', 'test/sum.test.mjs'];
  assert.deepEqual(proofStep(feature(), { command }), { step: 'S-1', otherCommand: false });
  assert.deepEqual(proofStep(feature(), { command: ['node', 'x.js'], checks: ['e2e-smoke'] }), { step: 'S-2', otherCommand: false });
  assert.deepEqual(proofStep(feature(), { command: ['node', 'x.js'] }), { step: undefined, otherCommand: false });
  assert.deepEqual(proofStep(feature(), { command: ['node', 'x.js'] }, 'S-1'), { step: 'S-1', otherCommand: true });
  assert.deepEqual(proofStep(feature(), { command }, 'S-1'), { step: 'S-1', otherCommand: false });
  assert.deepEqual(proofStep(feature([], { phase: 'review' }), { command }), { step: undefined, otherCommand: false });
  for (const [given, current, pattern] of [['s-1', feature(), /S-1처럼/], ['S-0', feature(), /S-1처럼/], [1, feature(), /S-1처럼/], ['S-1', feature([], { phase: 'review' }), /구현 단계/], ['S-9', feature(), /S-9/]])
    assert.throws(() => proofStep(current, { command }, given), (error) => error.status === 400 && pattern.test(error.message));
  const saved = process.env.WAX_PLAN_STEPS;
  t.after(() => { if (saved === undefined) delete process.env.WAX_PLAN_STEPS; else process.env.WAX_PLAN_STEPS = saved; });
  process.env.WAX_PLAN_STEPS = 'off';
  assert.deepEqual(proofStep(feature(), { command }), { step: undefined, otherCommand: false });
  assert.equal(proofStep(feature(), { command }, 'S-1').step, 'S-1');
});

test('the proof schema takes step only on test proofs in the S-N shape', () => {
  assert.equal(validProof(proof({ step: 'S-1' })), true);
  assert.equal(validProof(proof({ step: 'S-100' })), false);
  assert.equal(validProof(proof({ step: 's-1' })), false);
  assert.equal(validProof({ id: randomUUID(), kind: 'git', phase: 'implement', iteration: 0, at: at(), commit: HEAD, files: [], step: 'S-1' }), false);
});

test('progress: passed, red→green, failed, pending, a different command and no check; old proofs count by command', () => {
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof();
  let progress = stepProgress(feature([red, green]));
  assert.deepEqual(progress.steps.map(({ id, state, redGreen, proof: id2 }) => [id, state, redGreen, id2]),
    [['S-1', 'passed', true, green.id], ['S-2', 'pending', false, null], ['S-3', 'noCheck', false, null]]);
  assert.deepEqual({ total: progress.total, checked: progress.checked, done: progress.done, redGreen: progress.redGreen, noCheck: progress.noCheck }, { total: 3, checked: 2, done: 1, redGreen: 1, noCheck: 1 });
  assert.equal(progress.steps[2].none, '문서만');
  assert.equal(planStepsLine(progress), '계획 단계 1/2 끝남(빨강→초록 1) · 검사 없음 1');
  assert.equal(stepStateText(progress.steps[0]), '검사 통과 · 빨강→초록');
  assert.equal(stepStateText(progress.steps[2], undefined, '문서만'), '검사 없음(문서만)');
  progress = stepProgress(feature([proof({ exitCode: 1 }), proof({ command: ['node', 'x.js'], step: 'S-2' }), proof({ step: 'S-2' })]));
  assert.deepEqual(progress.steps.map((row) => row.state), ['failed', 'otherCommand', 'noCheck']);
  assert.equal(stepProgress(feature([proof({ iteration: 1 })])).steps[0].state, 'pending');
  assert.equal(stepProgress(feature([proof({ iteration: 1 })], { iteration: 2 }), { iteration: 1 }).steps[0].state, 'passed');
  assert.equal(stepProgress(feature([proof({ phase: 'review' })])).steps[0].state, 'pending');
  assert.equal(stepProgress({ artifacts: { plan: '- AC-1: x' }, proofs: [] }), null);
});

test('implement completion warns or refuses for steps without a passing check, records the summary, and pairs carry their step', async (t) => {
  assert.deepEqual(assessStepProgress(feature(), 'review'), { record: null });
  assert.deepEqual(assessStepProgress(feature(), 'implement', { mode: 'off' }), { record: null });
  assert.deepEqual(assessStepProgress(feature([proof({ command: ['node', 'x.js'], step: 'S-1' })]), 'implement', { mode: 'warn' }).record,
    { count: 3, mode: 'warn', warnings: [{ code: 'unproven', ids: ['S-2'] }, { code: 'otherCommand', ids: ['S-1'] }] });
  assert.throws(() => assessStepProgress(feature(), 'implement', { mode: 'enforce' }), (error) => error.status === 409 && /S-1, S-2/.test(error.message) && /WAX_PLAN_STEPS=enforce/.test(error.message));

  const root = await workspace(t);
  await toImplement(root, 'sum');
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof({ step: 'S-1' }), smoke = proof({ command: ['node', 'smoke.js'], verification: 'runtime', checks: ['e2e-smoke'], step: 'S-2' });
  for (const item of [red, green]) await attach(root, 'sum', item);
  await assert.rejects(completePhase(root, 'sum', 'implement', { evidence: '통과', proofIds: [green.id], redGreen: 'warn', planSteps: 'enforce' }), (error) => error.status === 409 && /S-2/.test(error.message));
  assert.equal((await getFeature(root, 'sum')).completed.implement, undefined);
  const warned = await completePhase(root, 'sum', 'implement', { evidence: '통과', proofIds: [green.id], redGreen: 'warn', planSteps: 'warn' });
  assert.match(warned.warning, /계획 단계 경고\(완료는 했습니다\): 통과한 검사 근거가 없는 단계: S-2/);
  const done = warned.feature.completed.implement;
  assert.deepEqual(done.steps, { count: 3, mode: 'warn', warnings: [{ code: 'unproven', ids: ['S-2'] }] });
  assert.equal(done.redGreen.pairs[0].step, 'S-1');
  assert.deepEqual(done.redGreen.steps, [{ id: 'S-1', state: 'ok', linked: true }, { id: 'S-2', state: 'missing' }, { id: 'S-3', state: 'noCheck' }]);
  validateStored(await getFeature(root, 'sum'));

  await toImplement(root, 'all');
  for (const item of [proof(), proof({ ...smoke, id: randomUUID() })]) await attach(root, 'all', item);
  const clean = await completePhase(root, 'all', 'implement', { evidence: '통과', proofIds: [(await getFeature(root, 'all')).proofs[0].id], redGreen: 'off', planSteps: 'enforce' });
  assert.deepEqual(clean.feature.completed.implement.steps.warnings, []);
  assert.equal(clean.warning, null);
});

test('stored shapes: implement codes only in implement, red→green steps and pair steps validate', () => {
  assert.equal(validPlanSteps({ count: 2, mode: 'warn', warnings: [{ code: 'unproven', ids: ['S-1'] }] }, 'implement'), true);
  assert.equal(validPlanSteps({ count: 2, mode: 'warn', warnings: [{ code: 'unproven', ids: ['S-1'] }] }, 'plan'), false);
  assert.equal(validPlanSteps({ count: 2, mode: 'warn', warnings: [{ code: 'noSteps', ids: [] }] }, 'implement'), false);
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof();
  const record = { state: 'ok', mode: 'warn', pairs: [{ red: red.id, green: green.id, check: 'cmd:0123456789abcdef', folder: 'project', treeChanged: true, changed: 1, testsOnly: false,
    tests: { parse: 'none', failed: [], matched: null }, defect: null }], defects: [], warnings: [] };
  const stepped = withStepPairs(feature([red, green]), record);
  assert.equal(stepped.pairs[0].step, 'S-1');
  assert.equal(validRedGreen(stepped), true);
  assert.equal(validRedGreen({ ...stepped, steps: [{ id: 'S-1', state: 'done' }] }), false);
  assert.equal(validRedGreen({ ...stepped, steps: [{ id: 'S-1', state: 'ok' }, { id: 'S-1', state: 'ok' }] }), false);
  assert.equal(validRedGreen({ ...stepped, pairs: [{ ...stepped.pairs[0], step: 'step1' }] }), false);
  assert.equal(withStepPairs(feature([], { artifacts: { plan: '# 단계 없음' } }), record), record);
  assert.equal(withStepPairs(feature(), null), null);
});

test('the implement prompt quotes the remaining steps as data and the plan prompt asks for S-N lines', () => {
  const lines = stepPrompt(feature([proof()]), 'implement');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /검사 통과 1\/2개\(빨강→초록 0\)\. 다음 단계: S-2 — 검사: checks=e2e-smoke\./);
  assert.match(lines[0], /CLI test sum -- <명령>/);
  assert.match(lines[0], /> +"id": "S-3"/);
  assert.match(lines[0], /`@someone`/);
  assert.doesNotMatch(lines[0], /"id": "S-1"/);
  assert.deepEqual(stepPrompt(feature(), 'review'), []);
  const prompt = buildPrompt({ ...feature([proof()]), title: '합계', projectType: 'general', completed: {} }, 'implement');
  assert.match(prompt, /다음 단계: S-2/);
  const plan = buildPrompt({ id: 'x', title: 'x', projectType: 'general', artifacts: {}, completed: {}, phase: 'plan' }, 'plan');
  assert.match(plan, /- S-1: <무엇> — files: <바꿀 파일> — check: `<명령>` — done: <완료 기준> — AC: AC-1/);
  assert.match(plan, /"단계는 구현하면서 정하면 된다" → /);
});

test('status, context, quality report, PR draft and run trace show the steps', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'sum');
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof({ step: 'S-1' });
  for (const item of [red, green]) await attach(root, 'sum', item);
  const status = await featureStatus(root, 'sum');
  assert.equal(status.planSteps.line, '계획 단계 1/2 끝남(빨강→초록 1) · 검사 없음 1');
  assert.deepEqual(status.planSteps.steps.map((row) => row.line), ['S-1 합계 고침 — 검사 통과 · 빨강→초록', 'S-2 검사 ID 단계 — 아직 검사 안 함', 'S-3 README @someone 예 — 검사 없음(문서만)']);
  const context = await buildContext(root, 'sum');
  assert.match(context, /## 계획 단계 · /);
  assert.match(context, /- 검사 통과 1\/2개\(빨강→초록 1\), 검사 없음 1개, 남은 단계 2개/);
  assert.match(context, /- S-2 "검사 ID 단계": 아직 검사 안 함, 검사 "checks=e2e-smoke"/);
  await completePhase(root, 'sum', 'implement', { evidence: '통과', proofIds: [green.id], redGreen: 'warn', planSteps: 'warn' });
  const quality = (await buildQualityReport(root, 'sum', { language: 'en', impact: null, deps: null, manual: null })).body;
  assert.match(quality, /## Plan steps\n\nProgress computed from the plan's S-N lines/);
  assert.match(quality, /\| S-1 합계 고침 \| `node --test test\/sum\.test\.mjs` \| check passed · Red→green \(/);
  assert.match(quality, /\| S-3 README `@someone` 예 \| - \| No check \(문서만\) \|/);
  assert.match(quality, /step S-1/);
  const pr = (await buildPrBody(root, 'sum', { language: 'en' })).body;
  assert.match(pr, /- Plan steps 1\/2 done \(1 red→green\) · 1 without a check/);
  assert.match(pr, /\| Step \(S-N\) \| Check \| Progress \|/);
  const trace = await buildRunTrace(root, 'sum', { language: 'en' });
  const implement = trace.visits.find((visit) => visit.phase === 'implement');
  assert.deepEqual(implement.steps.steps.map((row) => row.state), ['passed', 'pending', 'noCheck']);
  assert.equal(trace.visits.find((visit) => visit.phase === 'plan').steps, null);
  assert.match(renderTraceMarkdown(trace, 'en'), /### Plan steps\n\n- Plan steps 1\/2 done \(1 red→green\) · 1 without a check\n- S-1 합계 고침 `node --test test\/sum\.test\.mjs` — check passed · Red→green/);
});

test('a real wax test run gets its step from the command; --step with another command warns; the CLI refuses unknown steps', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'ok.mjs'), "import { readFileSync } from 'node:fs'; process.exit(readFileSync(new URL('../value.txt', import.meta.url), 'utf8').trim() === 'ok' ? 0 : 1);\n");
  await writeFile(join(root, 'value.txt'), 'bad\n');
  await toImplement(root, 'run', `- AC-1: 값\n- S-1: 값 고침 — check: \`node test/ok.mjs\` — AC: AC-1\n`);
  const failed = await runTestProof(root, 'run', ['node', 'test/ok.mjs']);
  assert.equal(failed.proof.step, 'S-1');
  assert.notEqual(failed.proof.exitCode, 0);
  await writeFile(join(root, 'value.txt'), 'ok\n');
  const passed = await runTestProof(root, 'run', ['node', 'test/ok.mjs']);
  assert.equal(passed.proof.step, 'S-1');
  assert.equal(passed.proof.exitCode, 0, passed.proof.output);
  assert.equal(passed.warning, undefined);
  const other = await runTestProof(root, 'run', ['node', '-e', ''], { step: 'S-1' });
  assert.equal(other.proof.step, 'S-1');
  assert.match(other.warning, /S-1에 붙였지만 그 단계의 check와 다른 명령/);
  const untagged = await runTestProof(root, 'run', ['node', '-e', '']);
  assert.equal(untagged.proof.step, undefined);
  const progress = stepProgress(await getFeature(root, 'run'));
  assert.deepEqual(progress.steps.map((row) => [row.state, row.proof]), [['passed', passed.proof.id]]);

  const env = { ...process.env, WAX_LANG: 'ko' };
  const bad = spawnSync(process.execPath, [CLI, 'test', 'run', '--project', root, '--step', 'S-9', '--', 'node', '-e', ''], { encoding: 'utf8', env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /기획에 없는 계획 단계입니다: S-9/);
  const wrong = spawnSync(process.execPath, [CLI, 'status', 'run', '--project', root, '--step', 'S-1'], { encoding: 'utf8', env });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr + wrong.stdout, /--step은 test 명령에서만/);
  const ok = spawnSync(process.execPath, [CLI, 'test', 'run', '--project', root, '--step', 'S-1', '--', 'node', 'test/ok.mjs'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).proof.step, 'S-1');
});
