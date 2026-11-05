import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { assessPlanSteps, parseCheck, planSteps, planStepsMode, planStepsWarning, readPlanSteps, validPlanSteps } from '../src/plan-steps.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const feature = (plan) => ({ artifacts: { plan } });
const ACS = '- AC-1: 할인\n- AC-2: 반올림\n';
const GOOD = `${ACS}- S-1: 할인 — files: src/a.js — check: \`node --test test/a.test.js\` — done: 통과 — AC: AC-1
- S-2: 반올림 — files: src/b.js — check: \`node --test test/b.test.js\` — done: 통과 — AC: AC-2
`;

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-plan-steps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function planTask(root, id, plan) {
  await createFeature(root, { id, title: '계획', projectType: 'general' });
  await updateFeature(root, id, 'save', { phase: 'plan', content: plan });
}

test('the design format parses with both separators, Korean field names, tables and the three check kinds', () => {
  const plan = `${ACS}- AC-3: 문서
- S-1: 합계에 할인 적용 — files: src/invoice.js, test/invoice.test.js — check: \`node --test test/invoice.test.js\` — done: 할인 테스트 통과 — AC: AC-1
- S-2: 반올림 -- 파일: src\\money.js -- 검사: \`wax test x -- node "a b.js"\` -- 완료: 3경우 통과 -- AC: AC-1, AC-2
- S-3: README 사용 예 — files: README.md — check: 없음(문서만) — done: 예시가 같음 — AC: AC-3

| ID | 무엇 | files | check | done | AC |
|---|---|---|---|---|---|
| S-4 | 표 단계 | a.js | \`node t.js\` | ok | AC-1 |
| S-5: 표 둘 | check: checks=unit,e2e | AC: AC-2 |
`;
  const steps = planSteps(plan);
  assert.deepEqual(steps.map((step) => step.id), ['S-1', 'S-2', 'S-3', 'S-4', 'S-5']);
  assert.deepEqual(steps[0], { id: 'S-1', title: '합계에 할인 적용', files: ['src/invoice.js', 'test/invoice.test.js'], fileCount: 2,
    check: { argv: ['node', '--test', 'test/invoice.test.js'] }, done: '할인 테스트 통과', ac: ['AC-1'] });
  assert.deepEqual(steps[1].check, { argv: ['wax', 'test', 'x', '--', 'node', 'a b.js'] });
  assert.deepEqual(steps[1].files, ['src/money.js']);
  assert.deepEqual(steps[1].ac, ['AC-1', 'AC-2']);
  assert.deepEqual(steps[2].check, { none: '문서만' });
  assert.deepEqual(steps[3], { id: 'S-4', title: '표 단계', files: ['a.js'], fileCount: 1, check: { argv: ['node', 't.js'] }, done: 'ok', ac: ['AC-1'] });
  assert.deepEqual(steps[4].check, { checks: ['unit', 'e2e'] });
  assert.equal(steps[4].title, '표 둘');
});

test('check commands with shell characters, nested backticks or no reason are out of format', () => {
  for (const bad of ['`a | b`', '`a && b`', '`a; b`', '`a > out`', '`echo $HOME`', '`a ``b`` c`', 'node --test', '없음', '없음()', 'checks=Bad_ID', '`node "unclosed`', '`node test\\a.js`'])
    assert.equal(parseCheck(bad), 'bad', bad);
  assert.equal(parseCheck(''), null);
  assert.deepEqual(parseCheck('none(docs only)'), { none: 'docs only' });
  assert.deepEqual(parseCheck("`node 'a b'`"), { argv: ['node', 'a b'] });
  const read = readPlanSteps(`${ACS}- S-1: x — check: \`a | b\` — chek: y — AC: AC-1\n- S-2: y — AC: AC-2\n`);
  assert.deepEqual(read.badChecks, ['S-1']);
  assert.deepEqual(read.unknownFields, ['S-1']);
  assert.equal(read.steps[1].check, null);
});

test('reading skips code fences, keeps the first of duplicate IDs and stops at 30 steps', () => {
  const fenced = readPlanSteps('```\n- S-1: 예시 — check: `node a`\n```\n- S-1: 진짜 — check: `node b`\n- S-1: 또 — check: `node c`\n');
  assert.deepEqual(fenced.steps.map((step) => step.title), ['진짜']);
  assert.deepEqual(fenced.duplicates, ['S-1']);
  const many = readPlanSteps(Array.from({ length: 32 }, (_, i) => `- S-${i + 1}: 단계 — check: \`node t${i}.js\``).join('\n'));
  assert.equal(many.steps.length, 30);
  assert.equal(many.more, 2);
  assert.deepEqual(planSteps(undefined), []);
  assert.deepEqual(planSteps('먼저 S-1을 본다'), []);
});

test('plans without AC, other phases and off check nothing', () => {
  assert.deepEqual(assessPlanSteps(feature('# 옛 기획\n- S-1: x — AC: AC-9'), 'plan', { mode: 'enforce' }), { record: null });
  assert.deepEqual(assessPlanSteps(feature(ACS), 'design', { mode: 'enforce' }), { record: null });
  assert.deepEqual(assessPlanSteps(feature(`${ACS}- S-1: x — AC: AC-9\n- S-1: y`), 'plan', { mode: 'off' }), { record: null });
});

test('the complete plan table: warn warns, enforce refuses, unknown AC and duplicate IDs are always refused', () => {
  const both = (plan) => ['warn', 'enforce'].map((mode) => {
    try { return assessPlanSteps(feature(plan), 'plan', { mode, platform: 'linux' }).record; } catch (error) { return error; }
  });
  let [warn, enforce] = both(ACS);
  assert.deepEqual(warn, { count: 0, mode: 'warn', warnings: [{ code: 'noSteps', ids: [] }] });
  assert.equal(enforce.status, 409);
  assert.match(enforce.message, /계획 단계\(S-N 줄\)가 없습니다.*WAX_PLAN_STEPS=enforce/);
  [warn, enforce] = both(`${ACS}- S-1: x — AC: AC-1\n- S-2: y — check: \`a|b\` — AC: AC-2\n`);
  assert.deepEqual(warn.warnings, [{ code: 'noCheck', ids: ['S-1'] }, { code: 'badCheck', ids: ['S-2'] }]);
  assert.match(enforce.message, /검사\(check\) 칸이 없는 단계: S-1.*형식 밖인 단계: S-2/);
  [warn, enforce] = both(`${ACS}- S-1: x — check: 없음(문서만) — AC: AC-1, AC-2\n`);
  assert.deepEqual(warn, { count: 1, mode: 'warn', warnings: [] });
  assert.deepEqual(enforce, { count: 1, mode: 'enforce', warnings: [] });
  for (const plan of [`${GOOD}- S-3: z — check: \`node z\` — AC: AC-7\n`, `${GOOD}- S-2: 또 — check: \`node z\` — AC: AC-2\n`]) {
    for (const error of both(plan)) assert.equal(error.status, 409);
  }
  assert.match(both(`${GOOD}- S-3: z — check: \`node z\` — AC: AC-7\n`)[0].message, /S-3 → AC-7/);
  assert.match(both(`${GOOD}- S-2: 또 — check: \`node z\` — AC: AC-2\n`)[0].message, /같은 계획 단계 ID.*S-2/);
  const files = Array.from({ length: 9 }, (_, i) => `f${i}.js`).join(', ');
  [warn, enforce] = both(`${ACS}- S-1: x — files: ${files} — check: \`node a\` — AC: AC-1\n- S-3: y — check: \`node b\` — AC: AC-1\n`);
  for (const record of [warn, enforce]) assert.deepEqual(record.warnings, [{ code: 'uncovered', ids: ['AC-2'] }, { code: 'large', ids: ['S-1'] }, { code: 'gap', ids: ['S-2'] }]);
  [warn] = both(`${ACS}- S-1: x — check: \`node a\` — chek: y — AC: AC-1, AC-2\n`);
  assert.deepEqual(warn.warnings, [{ code: 'unknownField', ids: ['S-1'] }]);
  assert.deepEqual(both(GOOD), [{ count: 2, mode: 'warn', warnings: [] }, { count: 2, mode: 'enforce', warnings: [] }]);
});

test('Windows warns about npx/npm/yarn/pnpm checks; other platforms do not', () => {
  const plan = `${ACS}- S-1: x — check: \`npx vitest run\` — AC: AC-1\n- S-2: y — check: \`node a\` — AC: AC-2\n`;
  assert.deepEqual(assessPlanSteps(feature(plan), 'plan', { mode: 'warn', platform: 'win32' }).record.warnings, [{ code: 'windowsShell', ids: ['S-1'] }]);
  assert.deepEqual(assessPlanSteps(feature(plan), 'plan', { mode: 'warn', platform: 'darwin' }).record.warnings, []);
});

test('the mode follows WAX_PLAN_STEPS and refuses other values', () => {
  assert.equal(planStepsMode(undefined), 'warn');
  assert.equal(planStepsMode(''), 'warn');
  assert.equal(planStepsMode('enforce'), 'enforce');
  assert.throws(() => planStepsMode('strict'), /WAX_PLAN_STEPS/);
});

test('the stored summary validates and the warning text is rebuilt from it', () => {
  assert.equal(validPlanSteps({ count: 2, mode: 'warn', warnings: [{ code: 'uncovered', ids: ['AC-2'] }] }), true);
  for (const bad of [null, { count: 2, mode: 'off', warnings: [] }, { count: 31, mode: 'warn', warnings: [] }, { count: 1, mode: 'warn', warnings: [{ code: 'nope', ids: [] }] },
    { count: 1, mode: 'warn', warnings: [{ code: 'gap', ids: ['x'] }] }, { count: 1, mode: 'warn', warnings: [{ code: 'gap', ids: [] }, { code: 'gap', ids: [] }] }])
    assert.equal(validPlanSteps(bad), false, JSON.stringify(bad));
  assert.equal(planStepsWarning(null), null);
  assert.equal(planStepsWarning({ count: 2, mode: 'warn', warnings: [] }), null);
  assert.match(planStepsWarning({ count: 0, mode: 'warn', warnings: [{ code: 'noSteps', ids: [] }] }), /^계획 단계 경고\(완료는 했습니다\)/);
});

test('complete plan records completed.plan.steps, returns the warning, and refuses without writing', async (t) => {
  const root = await workspace(t);
  await planTask(root, 'warned', ACS);
  const done = await completePhase(root, 'warned', 'plan', { evidence: '기획 확인', planSteps: 'warn' });
  assert.equal(done.feature.phase, 'design');
  assert.deepEqual(done.feature.completed.plan.steps, { count: 0, mode: 'warn', warnings: [{ code: 'noSteps', ids: [] }] });
  assert.match(done.warning, /계획 단계 경고/);
  validateStored(await getFeature(root, 'warned'));

  await planTask(root, 'strict', ACS);
  const before = await getFeature(root, 'strict');
  await assert.rejects(completePhase(root, 'strict', 'plan', { evidence: '기획 확인', planSteps: 'enforce' }), (error) => error.status === 409 && /WAX_PLAN_STEPS=enforce/.test(error.message));
  assert.deepEqual(await getFeature(root, 'strict'), before);

  await planTask(root, 'clean', GOOD);
  const clean = await completePhase(root, 'clean', 'plan', { evidence: '기획 확인', planSteps: 'enforce' });
  assert.deepEqual(clean.feature.completed.plan.steps, { count: 2, mode: 'enforce', warnings: [] });
  assert.equal(clean.warning, null);

  await planTask(root, 'old', '# 옛 기획');
  assert.equal((await completePhase(root, 'old', 'plan', { evidence: '기획 확인', planSteps: 'enforce' })).feature.completed.plan.steps, undefined);
  await planTask(root, 'off', ACS);
  assert.equal((await completePhase(root, 'off', 'plan', { evidence: '기획 확인', planSteps: 'off' })).feature.completed.plan.steps, undefined);
});

test('old records load and a steps summary outside plan or in the wrong shape is rejected', async (t) => {
  const root = await workspace(t);
  await planTask(root, 'shape', GOOD);
  const { feature: stored } = await completePhase(root, 'shape', 'plan', { evidence: '기획 확인', planSteps: 'warn' });
  const withoutSteps = structuredClone(stored); delete withoutSteps.completed.plan.steps;
  validateStored(withoutSteps);
  const wrong = structuredClone(stored); wrong.completed.plan.steps = { count: 'two', mode: 'warn', warnings: [] };
  assert.throws(() => validateStored(wrong));
  const elsewhere = structuredClone(stored); elsewhere.completed.design = { at: stored.updatedAt, evidence: 'x', steps: stored.completed.plan.steps };
  assert.throws(() => validateStored(elsewhere));
});

test('CLI complete plan follows WAX_PLAN_STEPS from the environment', async (t) => {
  const root = await workspace(t);
  await planTask(root, 'cli', ACS);
  const run = (mode) => spawnSync(process.execPath, [CLI, 'complete', 'plan', 'cli', '--evidence', '기획 확인', '--project', root],
    { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko', WAX_PLAN_STEPS: mode } });
  const refused = run('enforce');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /WAX_PLAN_STEPS=enforce/);
  const bad = run('strict');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /WAX_PLAN_STEPS/);
  const warned = run('');
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /계획 단계 경고/);
  assert.equal((await getFeature(root, 'cli')).phase, 'design');
});
