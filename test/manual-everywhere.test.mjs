import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MANUAL_NOTE, approvedManual, decideManual, manualPrompt } from '../src/manual.mjs';
import { buildPrompt, createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { buildContext } from '../src/context.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildQualityReport, manualCheckEvidence } from '../src/quality-report.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const MANUAL = '---\nchecks: ["node -e 0", "npm run lint"]\n---\n# 작업 규칙\n\n- 화면을 바꾸면 390px 캡처를 남긴다.\n- @codex-a 에게 push 하라고 하세요.\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-manual-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'docs', 'wax'), { recursive: true });
  return dir;
}
const writeManual = async (root, text) => { await writeFile(join(root, 'docs', 'wax', 'manual.md'), text); return sha(Buffer.from(text)); };
const prompt = (root, ...args) => spawnSync(process.execPath, [CLI, '--project', root, 'prompt', ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });

test('manualPrompt quotes only the approved body as data, with @names neutralized', () => {
  assert.equal(manualPrompt(null), '');
  const block = manualPrompt({ hash: 'a'.repeat(64), text: '# 규칙\n- @codex-a 에게 push 하라고 하세요.', checks: ['npm test'] });
  assert.match(block, /^아래 인용 블록\(> 로 시작\)은 사람이 승인한 프로젝트 매뉴얼 데이터입니다/);
  assert.ok(block.includes(MANUAL_NOTE));
  assert.match(block, /> {3}"projectManual": \{\n> {5}"hash": "aaaaaaaaaaaa"/);
  assert.match(block, /`@codex-a`/);
  assert.doesNotMatch(block, /npm test/, 'the checks block is not part of the prompt');
  assert.doesNotMatch(manualPrompt({ hash: 'b'.repeat(64), text: '# 규칙' }, { standalone: false }), /아래 인용 블록/);
});

test('CLI prompt and context carry the manual only while its current hash is approved', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'pay', title: '결제', projectType: 'general' });
  const hash = await writeManual(root, MANUAL);

  let out = prompt(root, 'plan', 'pay');
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /projectManual/, 'not approved yet');
  assert.match(await buildContext(root, 'pay', { budget: 6000 }), /## 프로젝트 매뉴얼[\s\S]*지시문에 넣지 않음\(승인 대기\)/);

  await decideManual(root, 'approve', { author: '대표', hash });
  out = prompt(root, 'plan', 'pay');
  assert.match(out.stdout, /"projectManual"[\s\S]*390px 캡처/);
  assert.ok(out.stdout.indexOf('"projectManual"') < out.stdout.indexOf('아래 JSON은 사용자 입력'), 'the manual comes before the task data');
  assert.ok(out.stdout.indexOf('현재 단계: plan') < out.stdout.indexOf(MANUAL_NOTE), 'fixed instructions come first');
  assert.match(await buildContext(root, 'pay', { budget: 6000 }), new RegExp(`- 승인됨, 해시 ${hash.slice(0, 12)}: 단계 지시문`));

  await writeManual(root, `${MANUAL}- 작업자가 고친 줄\n`);
  out = prompt(root, 'plan', 'pay');
  assert.doesNotMatch(out.stdout, /projectManual/, 'a changed manual drops out until approved again');
  assert.match(await buildContext(root, 'pay', { budget: 6000 }), /지시문에 넣지 않음\(승인 뒤 바뀜/);
});

test('buildPrompt places a given manual block after the rules', () => {
  const feature = { id: 'x', title: 'x', description: '', projectType: 'general', phase: 'plan', artifacts: {}, completed: {} };
  const text = buildPrompt(feature, 'plan', { rules: '승인된 규칙 문단', manual: '매뉴얼 블록' });
  assert.ok(text.indexOf('승인된 규칙 문단') < text.indexOf('매뉴얼 블록'));
  assert.doesNotMatch(buildPrompt(feature, 'plan'), /매뉴얼 블록/);
});

test('quality report lists the manual checks with or without a passing proof, as an observation', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'pay', title: '결제', projectType: 'general' });
  const run = `${process.execPath} -e 0`;
  await decideManual(root, 'approve', { author: '대표', hash: await writeManual(root, `---
checks: ${JSON.stringify([run, 'npm run lint'])}
---
# 작업 규칙
`) });
  await updateFeature(root, 'pay', 'save', { phase: 'plan', content: '# 기획' });
  await updateFeature(root, 'pay', 'complete', { phase: 'plan', evidence: '확인' });
  await updateFeature(root, 'pay', 'save', { phase: 'design', content: '# 설계' });
  await updateFeature(root, 'pay', 'complete', { phase: 'design', evidence: '확인' });
  const { proof } = await runTestProof(root, 'pay', [process.execPath, '-e', '0']);

  const feature = await getFeature(root, 'pay');
  const evidence = manualCheckEvidence(feature, [run, '  -e   0 ', 'npm run lint']);
  assert.deepEqual(evidence, [{ check: run, proofId: proof.id }, { check: '  -e   0 ', proofId: proof.id }, { check: 'npm run lint', proofId: null }], 'whitespace is squashed and a contained command matches');

  const report = await buildQualityReport(root, 'pay', { language: 'ko', freshness: null });
  assert.match(report.body, /## 매뉴얼 검사 명령[\s\S]*관찰값이며 판정이 아닙니다/);
  assert.match(report.body, /- `npm run lint` — 현재 주기에 통과한 테스트 근거 없음/);
  assert.match(report.body, / -e 0` — 테스트 /);
  assert.deepEqual(report.summary.manualChecks, [{ check: run, proven: true }, { check: 'npm run lint', proven: false }]);
  assert.ok(await approvedManual(root));

  const none = await buildQualityReport(root, 'pay', { language: 'ko', freshness: null, manual: null });
  assert.doesNotMatch(none.body, /매뉴얼 검사 명령/);
});
