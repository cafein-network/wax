import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { proofStep, stepProgress } from '../src/plan-progress.mjs';
import { assessPlanSteps, planStepsWarningText, readPlanSteps, validPlanSteps } from '../src/plan-steps.mjs';
import { planStepsStatus } from '../src/status.mjs';
import { diagnose } from '../src/diagnose.mjs';

const HEAD = 'a'.repeat(40);
let clock = Date.parse('2026-11-05T00:00:00Z');
const at = () => new Date(clock += 1000).toISOString();
const SHARED = `# 기획
- AC-1: 기준선
- AC-2: 기능
- S-1: 기준선 — check: \`node --test\` — AC: AC-1
- S-2: 기능 테스트 — check: \`node --test\` — AC: AC-2
- S-3: 구현 — check: \`node --test\` — AC: AC-2
- S-4: 범위 — check: \`git diff --stat\` — AC: AC-1
`;
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command: ['node', '--test'], commit: HEAD, dirty: true,
  durationMs: 1, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: { head: HEAD, files: {} }, ...extra });
const feature = (proofs = [], extra = {}) => ({ id: 'slug', phase: 'implement', iteration: 0, artifacts: { plan: SHARED }, proofs, ...extra });
const command = ['node', '--test'];

test('shared check: proofs go to the first step in plan order without a pass, a step keeps its own red→green, then the last step', () => {
  assert.equal(proofStep(feature(), { command }).step, 'S-1');
  const s1 = proof({ step: 'S-1' });
  assert.equal(proofStep(feature([s1]), { command }).step, 'S-2');
  const red = proof({ step: 'S-2', exitCode: 1, tree: { head: HEAD, files: { 'src/a.mjs': 'b'.repeat(40) } } });
  assert.equal(proofStep(feature([s1, red]), { command }).step, 'S-2');
  const green = proof({ step: 'S-2' });
  assert.equal(proofStep(feature([s1, red, green]), { command }).step, 'S-3');
  const s3 = proof({ step: 'S-3' });
  assert.equal(proofStep(feature([s1, red, green, s3]), { command }).step, 'S-3', 'all passed → last matching step');
  assert.deepEqual(proofStep(feature([s1]), { command }, 'S-3'), { step: 'S-3', otherCommand: false });
  assert.equal(proofStep(feature([proof({ step: 'S-1', iteration: 1 }), proof({ step: 'S-1', phase: 'review' })]), { command }).step, 'S-1');
  assert.equal(proofStep(feature([proof({ step: 'S-1', command: ['node', '-e', ''] })]), { command }).step, 'S-1');
  assert.equal(proofStep(feature([s1, red, green, s3]), { command: ['git', 'diff', '--stat'] }).step, 'S-4');
  const progress = stepProgress(feature([s1, red, green, s3, proof({ command: ['git', 'diff', '--stat'], step: 'S-4' })]));
  assert.deepEqual(progress.steps.map((row) => [row.id, row.state, row.redGreen]), [['S-1', 'passed', false], ['S-2', 'passed', true], ['S-3', 'passed', true], ['S-4', 'passed', false]]);
});

test('complete plan warns about steps sharing a check, never refuses for it, and the record validates', () => {
  const plan = (text) => ({ artifacts: { plan: text } });
  for (const mode of ['warn', 'enforce']) {
    const { record } = assessPlanSteps(plan(SHARED), 'plan', { mode });
    assert.deepEqual(record.warnings, [{ code: 'sharedCheck', ids: ['S-1', 'S-2', 'S-3'] }]);
    assert.equal(validPlanSteps(record), true);
  }
  assert.match(planStepsWarningText({ code: 'sharedCheck', ids: ['S-1', 'S-2'] }), /같은 check 명령을 쓰는 단계: S-1, S-2/);
  const ids = `- AC-1: x\n- S-1: a — check: checks=b,a — AC: AC-1\n- S-2: b — check: checks=a,b — AC: AC-1\n- S-3: c — check: \`node a.js\` — AC: AC-1\n`;
  assert.deepEqual(assessPlanSteps(plan(ids), 'plan', { mode: 'warn' }).record.warnings, [{ code: 'sharedCheck', ids: ['S-1', 'S-2'] }]);
  const drives = '- AC-1: x\n- S-1: a — check: `node C:/t.js` — AC: AC-1\n- S-2: b — check: `node c:/t.js` — AC: AC-1\n';
  assert.deepEqual(assessPlanSteps(plan(drives), 'plan', { mode: 'warn', platform: 'win32' }).record.warnings, [{ code: 'sharedCheck', ids: ['S-1', 'S-2'] }]);
  assert.deepEqual(assessPlanSteps(plan(drives), 'plan', { mode: 'warn', platform: 'linux' }).record.warnings, []);
});

test('an unnamed description right after the title joins the title; unnamed fields after named ones and misspelled names still warn', () => {
  const read = readPlanSteps(`- AC-1: x
- S-1: 기준선 확인 — 기존 테스트가 통과하는지 본다 — files: 없음 — check: \`node --test\` — done: 통과 — AC: AC-1
- S-2: 구현 — files: src/a.mjs — 설명을 뒤에 둠 — check: \`node --test\` — AC: AC-1
- S-3: 철자 — chek: \`node a\` — AC: AC-1
- S-4: 이름 없는 검사 — \`node a\` — AC: AC-1
`);
  assert.equal(read.steps[0].title, '기준선 확인 — 기존 테스트가 통과하는지 본다');
  assert.deepEqual(read.steps[0].check, { argv: ['node', '--test'] });
  assert.deepEqual(read.unknownFields, ['S-2', 'S-3', 'S-4']);
  assert.equal(read.steps[3].title, '이름 없는 검사');
});

async function shared(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-plan-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'ok.mjs'), "import { readFileSync } from 'node:fs'; process.exit(readFileSync(new URL('../value.txt', import.meta.url), 'utf8').trim() === 'ok' ? 0 : 1);\n");
  await writeFile(join(root, 'value.txt'), 'ok\n');
  const plan = `- AC-1: 값\n- S-1: 기준선 — check: \`node test/ok.mjs\` — AC: AC-1\n- S-2: 고침 — check: \`node test/ok.mjs\` — AC: AC-1\n- S-3: 마무리 — check: \`node test/ok.mjs\` — AC: AC-1\n`;
  await createFeature(root, { id: 'run', title: '값', projectType: 'general' });
  await updateFeature(root, 'run', 'save', { phase: 'plan', content: plan });
  const planned = await completePhase(root, 'run', 'plan', { evidence: '기획 확인', planSteps: 'enforce' });
  assert.deepEqual(planned.feature.completed.plan.steps.warnings, [{ code: 'sharedCheck', ids: ['S-1', 'S-2', 'S-3'] }]);
  await updateFeature(root, 'run', 'save', { phase: 'design', content: '# 설계' });
  await updateFeature(root, 'run', 'complete', { phase: 'design', evidence: '설계 확인' });
  await updateFeature(root, 'run', 'save', { phase: 'implement', content: '# 구현' });
  return root;
}

test('real wax test runs of one shared check fill S-1..S-3 in order, enforce completes, and diagnose agrees with status', async (t) => {
  const root = await shared(t);
  const run = () => runTestProof(root, 'run', ['node', 'test/ok.mjs']);
  assert.equal((await run()).proof.step, 'S-1');
  await writeFile(join(root, 'value.txt'), 'bad\n');
  const red = await run();
  assert.deepEqual([red.proof.step, red.proof.exitCode !== 0], ['S-2', true]);
  await writeFile(join(root, 'value.txt'), 'ok\n');
  const green = await run();
  assert.equal(green.proof.step, 'S-2');
  const pending = await diagnose(root, 'run');
  const finding = pending.dimensions.flatMap((item) => item.findings).find((item) => item.code === 'diagnose.plan.stepsPending');
  assert.deepEqual(finding.args, ['run', 1, 3, 'S-3']);
  const status = planStepsStatus(await getFeature(root, 'run'));
  assert.deepEqual(status.steps.filter((row) => row.state !== 'passed').map((row) => row.id), ['S-3']);
  assert.equal((await run()).proof.step, 'S-3');
  const done = await completePhase(root, 'run', 'implement', { evidence: '통과', proofIds: [green.proof.id], redGreen: 'warn', planSteps: 'enforce' });
  assert.deepEqual(done.feature.completed.implement.steps.warnings, []);
  assert.equal(done.feature.completed.implement.redGreen.pairs[0].step, 'S-2');
  const all = await diagnose(root, 'run');
  assert.ok(all.dimensions.flatMap((item) => item.findings).some((item) => item.code === 'diagnose.plan.stepsAllGreen'));
});

test('diagnose follows proof.step like status: a pass tagged to another step does not count for this one', async (t) => {
  const root = await shared(t);
  await runTestProof(root, 'run', ['node', 'test/ok.mjs']);
  const report = await diagnose(root, 'run');
  const finding = report.dimensions.flatMap((item) => item.findings).find((item) => item.code === 'diagnose.plan.stepsPending');
  assert.deepEqual(finding.args, ['run', 2, 3, 'S-2, S-3']);
  const status = planStepsStatus(await getFeature(root, 'run'));
  assert.deepEqual(status.steps.map((row) => row.state), ['passed', 'pending', 'pending']);
});

test('red→green per step with only the last green linked: redGreen.steps agrees with status, the verdict still uses linked proofs only', async (t) => {
  const root = await shared(t);
  const run = () => runTestProof(root, 'run', ['node', 'test/ok.mjs']);
  const greens = [];
  for (const step of ['S-1', 'S-2', 'S-3']) {
    await writeFile(join(root, 'value.txt'), 'bad\n');
    const red = await run();
    assert.deepEqual([red.proof.step, red.proof.exitCode !== 0], [step, true]);
    await writeFile(join(root, 'value.txt'), 'ok\n');
    const green = await run();
    assert.equal(green.proof.step, step);
    greens.push(green.proof.id);
  }
  const status = planStepsStatus(await getFeature(root, 'run'));
  assert.deepEqual([status.done, status.redGreen], [3, 3]);
  const done = await completePhase(root, 'run', 'implement', { evidence: '통과', proofIds: [greens[2]], redGreen: 'warn', planSteps: 'enforce' });
  const record = done.feature.completed.implement.redGreen;
  assert.deepEqual(record.steps, [{ id: 'S-1', state: 'ok', linked: false }, { id: 'S-2', state: 'ok', linked: false }, { id: 'S-3', state: 'ok', linked: true }]);
  assert.equal(record.state, 'ok');
  assert.deepEqual(record.pairs.map((pair) => [pair.green, pair.step]), [[greens[2], 'S-3']]);
  assert.deepEqual(done.feature.completed.implement.steps.warnings, []);
  validateStored(await getFeature(root, 'run'));
});

test('redGreen.steps is missing for a step that passed without a red, and the linked flag validates only on ok steps', async () => {
  const { withStepPairs } = await import('../src/plan-progress.mjs');
  const { validRedGreen } = await import('../src/red-green.mjs');
  const s1 = proof({ step: 'S-1' });
  const red = proof({ step: 'S-2', exitCode: 1, tree: { head: HEAD, files: { 'src/a.mjs': 'b'.repeat(40) } } }), green = proof({ step: 'S-2' });
  const record = { state: 'missing', mode: 'warn', pairs: [], defects: [], warnings: [] };
  const stepped = withStepPairs(feature([s1, red, green]), record);
  assert.deepEqual(stepped.steps, [{ id: 'S-1', state: 'missing' }, { id: 'S-2', state: 'ok', linked: false }, { id: 'S-3', state: 'missing' }, { id: 'S-4', state: 'missing' }]);
  assert.equal(stepped.state, 'missing', 'the verdict is untouched');
  assert.equal(validRedGreen(stepped), true);
  assert.equal(validRedGreen({ ...stepped, steps: [{ id: 'S-1', state: 'missing', linked: false }] }), false);
  assert.equal(validRedGreen({ ...stepped, steps: [{ id: 'S-1', state: 'ok', linked: 'yes' }] }), false);
});
