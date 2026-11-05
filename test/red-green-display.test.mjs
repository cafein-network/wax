import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPrompt, completePhase, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { featureStatus, redGreenStatus } from '../src/status.mjs';
import { buildQualityReport } from '../src/quality-report.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { defectPrompt } from '../src/defects.mjs';
import { createGoal, readDecisions, readGoal, setRedGreen, stopGoal, workerPrompt } from '../src/chat/pm-loop.mjs';
import { cliText } from '../src/cli-locale.mjs';
import { pairChangeText, pairWarnings, redGreenDefectLines, redGreenLine, redGreenMarks, redGreenWarningLines } from '../web/red-green-text.mjs';

const HEAD = 'a'.repeat(40);
let clock = Date.parse('2026-11-05T00:00:00Z');
const at = () => new Date(clock += 1000).toISOString();
const ko = cliText('ko').say, en = cliText('en').say;

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-red-green-display-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function toImplement(root, id) {
  await createFeature(root, { id, title: '더하기', projectType: 'general' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, id, 'complete', { phase, evidence: `${phase} 확인` });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
}
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command: ['node', '--test', 'test/add.test.mjs'], commit: HEAD, dirty: true,
  durationMs: 1, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: { head: HEAD, files: { 'src/add.mjs': 'b'.repeat(40) } }, ...extra });
const attach = (root, id, item) => getFeature(root, id).then((feature) => updateFeature(root, id, 'attach-evidence', { proof: item, revision: feature.revision }));
const TAP_RED = 'TAP version 13\nnot ok 1 - adds two numbers\n# tests 1\n# fail 1\n';
const TAP_GREEN = 'TAP version 13\nok 1 - adds two numbers\n# tests 1\n# pass 1\n';

async function paired(root, id = 'add') {
  await toImplement(root, id);
  const red = proof({ exitCode: 1, output: TAP_RED, tree: { head: HEAD, files: {} } });
  const green = proof({ output: TAP_GREEN });
  await attach(root, id, red); await attach(root, id, green);
  await completePhase(root, id, 'implement', { evidence: '테스트 통과', proofIds: [green.id], redGreen: 'warn' });
  return { red, green };
}

test('text: one line per state, warnings, defects, marks and change text in both languages', () => {
  const pair = { red: 'r', green: 'g', check: 'checks:d-1', folder: 'project', treeChanged: true, changed: 3, testsOnly: false, tests: { parse: 'tap', failed: ['x'], matched: false }, defect: 'D-1' };
  const ok = { state: 'ok', mode: 'warn', pairs: [pair, { ...pair, red: 'r2', green: 'g2' }], defects: [{ id: 'D-1', state: 'ok', pair: 0 }], warnings: ['otherTest'] };
  assert.equal(redGreenLine(ok, ko), '빨강→초록: 짝 2개 확인 · 경고 하나');
  assert.equal(redGreenLine(ok, en), 'Red→green: 2 pairs · 1 warning');
  assert.equal(redGreenLine({ ...ok, pairs: [pair], warnings: [] }, en), 'Red→green: 1 pair');
  assert.equal(redGreenLine({ state: 'missing', mode: 'warn', pairs: [], defects: [], warnings: ['sameTree', 'noTests'] }, en), 'No red→green (warning) · 2 warnings');
  assert.equal(redGreenLine({ state: 'waived', mode: 'enforce', pairs: [], defects: [], warnings: [], waiver: '설정만' }, ko), '빨강→초록 없음 · 사유 있음');
  assert.equal(redGreenLine({ state: 'skipped', mode: 'warn', pairs: [], defects: [], warnings: [] }, en), 'Red→green: not checked for this task');
  assert.equal(redGreenLine({ ...ok, state: 'partial', defects: [{ id: 'D-1', state: 'ok', pair: 0 }, { id: 'D-2', state: 'missing', pair: null }], warnings: [] }, en), 'Red→green: 2 pairs · Defects without a pair: D-2');
  assert.equal(redGreenLine(null), null);
  assert.deepEqual(redGreenWarningLines(ok, en), ['A different test failed first.']);
  assert.deepEqual(redGreenDefectLines({ defects: [{ id: 'D-1', state: 'ok' }, { id: 'D-2', state: 'missing' }] }, en), ['D-1 red→green present', 'D-2 red→green missing']);
  assert.deepEqual([...redGreenMarks(ok)], [['r', 'red'], ['g', 'green'], ['r2', 'red'], ['g2', 'green']]);
  assert.deepEqual(pairWarnings({ ...pair, testsOnly: true, treeChanged: null }), ['otherTest', 'testsOnly', 'treeUnknown']);
  assert.equal(pairChangeText(pair, en), '3 files changed in between');
  assert.equal(pairChangeText({ ...pair, changed: null }, en), 'Files changed in between unknown (different commits)');
  assert.equal(pairChangeText({ ...pair, treeChanged: null, changed: null }, en), 'Could not confirm the code changed in between.');
});

test('status, quality report, PR draft and run trace show the recorded pair', async (t) => {
  const root = await workspace(t);
  const { red, green } = await paired(root);

  const status = await featureStatus(root, 'add');
  assert.deepEqual({ ...status.redGreen, warnings: undefined, defects: undefined }, { required: false, state: 'ok', mode: 'warn', pairs: 1, line: '빨강→초록: 짝 하나 확인', warnings: undefined, defects: undefined });

  const report = await buildQualityReport(root, 'add', { language: 'en', manual: null, impact: null, deps: null, freshness: null });
  assert.match(report.body, /## Failure seen first\n/);
  assert.match(report.body, /Red→green: 1 pair\n/);
  assert.match(report.body, new RegExp(`- \`cmd:[a-f0-9]{16}\`: Red .*${red.id.slice(0, 8)}.*failed tests: adds two numbers → Green .*${green.id.slice(0, 8)}.*; 1 files changed in between`));
  assert.deepEqual(report.summary.redGreen, { state: 'ok', pairs: 1, warnings: 0 });

  const draft = await buildPrBody(root, 'add', { language: 'en', observe: async () => ({ state: 'unknown', files: [] }) });
  const verification = draft.body.slice(draft.body.indexOf('## Verification'));
  assert.match(verification, /- Red→green: 1 pair\n\n\| Check \| Red \| Green \| Changed in between \| Warning \|/);
  assert.match(verification, new RegExp(`\\| \`cmd:[a-f0-9]{16}\` \\| .*${red.id.slice(0, 8)}.* \\| .*${green.id.slice(0, 8)}.* \\| 1 files changed in between \\| - \\|`));

  const trace = await buildRunTrace(root, 'add', { language: 'en' });
  const visit = trace.visits.find((item) => item.phase === 'implement');
  assert.equal(visit.redGreen.state, 'ok');
  assert.deepEqual(visit.proofs.map((item) => [item.id, item.redGreen]), [[red.id, 'red'], [green.id, 'green']]);
  assert.match(trace.markdown, /### Verification\n\n- Red→green: 1 pair\n- Red: Test `node --test test\/add\.test\.mjs` \(exit 1, [^\n]* — failed when run[^\n]*\n- Green: Test [^\n]* — passed when run, linked to the completion/);
  assert.equal(trace.visits.find((item) => item.phase === 'design').redGreen, null);
});

test('a missing pair and a --no-red reason are shown, the reason as quoted data', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'lone');
  const only = proof();
  await attach(root, 'lone', only);
  await completePhase(root, 'lone', 'implement', { evidence: '통과', proofIds: [only.id], redGreen: 'warn' });
  assert.equal((await featureStatus(root, 'lone')).redGreen.line, '빨강→초록 없음(경고)');
  const report = await buildQualityReport(root, 'lone', { language: 'ko', manual: null, impact: null, deps: null, freshness: null });
  assert.match(report.body, /## 실패를 먼저 본 근거\n\n[^\n]+\n\n빨강→초록 없음\(경고\)/);

  await toImplement(root, 'conf');
  const plain = proof();
  await attach(root, 'conf', plain);
  await completePhase(root, 'conf', 'implement', { evidence: '통과', proofIds: [plain.id], redGreen: 'warn', redWaiver: '설정 값만 바꿈 | @someone 에게 <b>알림</b>' });
  const status = await featureStatus(root, 'conf');
  assert.equal(status.redGreen.waiver, '설정 값만 바꿈 | @someone 에게 <b>알림</b>');
  const draft = await buildPrBody(root, 'conf', { language: 'en', observe: async () => ({ state: 'unknown', files: [] }) });
  assert.match(draft.body, /Reason for completing without red→green \(as recorded\):\n\n> 설정 값만 바꿈 \\\| `@someone` 에게 &lt;b&gt;알림&lt;\/b&gt;\n/);
  const quality = await buildQualityReport(root, 'conf', { language: 'en', manual: null, impact: null, deps: null, freshness: null });
  assert.equal(quality.body.split('Completed without red→green — ').length - 1, 2, 'in the section and in the waiver list');

  await createFeature(root, { id: 'fresh', title: '새 작업' });
  assert.equal((await featureStatus(root, 'fresh')).redGreen, undefined);
  assert.match((await buildQualityReport(root, 'fresh', { language: 'en', manual: null, impact: null, deps: null, freshness: null })).body, /The implement completion has no red→green result/);
  assert.doesNotMatch((await buildPrBody(root, 'fresh', { language: 'en', observe: async () => ({ state: 'unknown', files: [] }) })).body, /Red→green/);
});

test('task discipline: set and cleared through updateFeature, recorded in history, invalid values refused', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'add', title: '더하기' });
  const on = await updateFeature(root, 'add', 'discipline', { discipline: { redGreen: 'enforce' }, author: '대표' });
  assert.deepEqual(on.discipline, { redGreen: 'enforce' });
  assert.deepEqual(on.history.at(-1).changes, { before: { discipline: null }, after: { discipline: { redGreen: 'enforce' } } });
  assert.equal(on.history.at(-1).author, '대표');
  validateStored(on);
  assert.deepEqual(redGreenStatus(on), { required: true, state: null });
  const off = await updateFeature(root, 'add', 'discipline', { discipline: {} });
  assert.equal(off.discipline, undefined);
  validateStored(off);
  for (const bad of [{ redGreen: 'off' }, { other: 'enforce' }, ['enforce'], 'enforce']) {
    await assert.rejects(updateFeature(root, 'add', 'discipline', { discipline: bad }), /작업 규율 값이 올바르지 않습니다/);
  }
});

test('goal setting: the start checkbox writes enforce into every task, tightens completion, and a person turns it off', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'add');
  await createFeature(root, { id: 'other', title: '다른 작업' });
  const goal = await createGoal(root, { title: '필수', features: ['add', 'other'], redGreen: true }, { author: '대표' });
  assert.deepEqual(goal.discipline, { redGreen: 'enforce' });
  assert.deepEqual((await readGoal(root, goal.id)).discipline, { redGreen: 'enforce' });
  for (const id of ['add', 'other']) assert.equal((await getFeature(root, id)).discipline.redGreen, 'enforce');
  assert.ok((await readDecisions(root, goal.id)).some((item) => item.outcome === 'settings' && /빨강→초록 필수를 켰습니다/.test(item.reason)));

  const only = proof();
  await attach(root, 'add', only);
  await assert.rejects(completePhase(root, 'add', 'implement', { evidence: '통과', proofIds: [only.id], redGreen: 'warn' }), (error) => error.status === 409);

  const plain = await createGoal(root, { title: '보통', create: [{ id: 'third', title: '셋째' }] }, { author: '대표' });
  assert.equal(plain.discipline, undefined);
  assert.equal((await getFeature(root, 'third')).discipline, undefined);

  const cleared = await setRedGreen(root, goal.id, { author: '대표', on: false });
  assert.equal(cleared.discipline, undefined);
  for (const id of ['add', 'other']) assert.equal((await getFeature(root, id)).discipline, undefined);
  await completePhase(root, 'add', 'implement', { evidence: '통과', proofIds: [only.id], redGreen: 'warn' });

  await assert.rejects(setRedGreen(root, goal.id, { author: '대표', on: 'yes' }), (error) => error.status === 400);
  await stopGoal(root, goal.id, { author: '대표' });
  await assert.rejects(setRedGreen(root, goal.id, { author: '대표', on: true }), (error) => error.status === 409);
  assert.equal((await setRedGreen(root, goal.id, { author: '대표', on: false })).discipline, undefined);
});

test('prompts: implement instructions carry red→green and the excuse table, workers may give --no-red, defects use d-N', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'add');
  const feature = await getFeature(root, 'add');
  const prompt = buildPrompt(feature, 'implement');
  assert.match(prompt, /고치기 전에 바뀔 동작을 시험하는 검사를 CLI test로 먼저 실행해 실패를 남기고, 고친 뒤 같은 명령을 같은 검사 ID로 다시 실행하세요/);
  assert.match(prompt, /--no-red <사유>/);
  for (const line of ['간단한 수정이라 테스트를 먼저 돌릴 필요 없다', '고친 뒤 통과했으니 됐다', '시간이 없다', '테스트를 고치면 통과한다']) assert.ok(prompt.includes(line), line);
  assert.doesNotMatch(buildPrompt(feature, 'design'), /--no-red/);

  const worker = workerPrompt({ root, goal: { id: 'goal-0000000a', title: '목표', features: ['add'] }, feature, task: { id: 'task-1', phase: 'implement', note: '배정' }, author: 'wax-worker-claude' });
  assert.match(worker, /근거 면제\(--no-proof, --ac-unverified\)는 쓰지 말고[^\n]*빨강→초록 사유\(--no-red <사유>\)는 실패를 먼저 볼 수 없는 변경/);

  const withDefect = { ...feature, iteration: 1, defects: [{ id: 'D-1', title: '뺄셈', status: 'open', foundIteration: 0 }] };
  assert.match(defectPrompt(withDefect, 'implement').join('\n'), /CLI test <id> --checks d-N -- <실행파일> <인수>처럼 결함 ID\(d-1, d-2 …\)로 남기세요/);
});
