import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { completePhase, createFeature, getFeature, importFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { TOOLS } from '../src/mcp.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);
let clock = Date.parse('2026-11-05T00:00:00Z');
const at = () => new Date(clock += 1000).toISOString();

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-red-green-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function toImplement(root, id, extra = {}) {
  await createFeature(root, { id, title: '더하기', projectType: 'general', ...extra });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, id, 'complete', { phase, evidence: `${phase} 확인` });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
}
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command: ['node', '--test'], commit: HEAD, dirty: true,
  durationMs: 1, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: { head: HEAD, files: { 'src/a.mjs': 'b'.repeat(40) } }, ...extra });
const attach = (root, id, item) => getFeature(root, id).then((feature) => updateFeature(root, id, 'attach-evidence', { proof: item, revision: feature.revision }));
const complete = (root, id, options = {}) => completePhase(root, id, 'implement', { evidence: '테스트 통과', redGreen: 'warn', ...options });

test('implement completion records the pair, validates, and returns a warning when none is found', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'add');
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof();
  await attach(root, 'add', red); await attach(root, 'add', green);
  const { feature, warning } = await complete(root, 'add', { proofIds: [green.id] });
  const record = feature.completed.implement.redGreen;
  assert.equal(record.state, 'ok');
  assert.equal(record.mode, 'warn');
  assert.deepEqual(record.pairs.map(({ red: r, green: g, folder, treeChanged, changed, testsOnly }) => ({ r, g, folder, treeChanged, changed, testsOnly })),
    [{ r: red.id, g: green.id, folder: 'project', treeChanged: true, changed: 1, testsOnly: false }]);
  assert.equal(warning, null);
  validateStored(await getFeature(root, 'add'));

  await toImplement(root, 'lonely');
  const only = proof();
  await attach(root, 'lonely', only);
  const warned = await complete(root, 'lonely', { proofIds: [only.id] });
  assert.equal(warned.feature.completed.implement.redGreen.state, 'missing');
  assert.match(warned.warning, /빨강→초록 경고/);

  assert.equal(feature.completed.plan.redGreen, undefined);
});

test('enforce refuses with 409 and leaves the record unchanged; --no-red completes and is kept', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'add');
  const only = proof();
  await attach(root, 'add', only);
  const before = await getFeature(root, 'add');
  await assert.rejects(complete(root, 'add', { proofIds: [only.id], redGreen: 'enforce' }), (error) => error.status === 409 && /WAX_RED_GREEN=enforce/.test(error.message));
  const after = await getFeature(root, 'add');
  assert.equal(after.revision, before.revision);
  assert.equal(after.phase, 'implement');
  const { feature, warning } = await complete(root, 'add', { proofIds: [only.id], redGreen: 'enforce', redWaiver: '설정 값만 바꿈' });
  assert.deepEqual(feature.completed.implement.redGreen, { state: 'waived', mode: 'enforce', pairs: [], defects: [], warnings: [], waiver: '설정 값만 바꿈' });
  assert.equal(warning, null);
  assert.equal(feature.phase, 'review');
});

test('--no-red outside implement is refused; off records nothing', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'add', title: '더하기' });
  await updateFeature(root, 'add', 'save', { phase: 'plan', content: '# 기획' });
  await assert.rejects(completePhase(root, 'add', 'plan', { evidence: '확인', redWaiver: '사유' }), /구현 단계에만/);
  await toImplement(root, 'off');
  const only = proof();
  await attach(root, 'off', only);
  const { feature } = await complete(root, 'off', { proofIds: [only.id], redGreen: 'off' });
  assert.equal(feature.completed.implement.redGreen, undefined);
});

test('WAX_RED_GREEN from the environment, and a task discipline of enforce beats warn', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'env');
  const only = proof();
  await attach(root, 'env', only);
  const saved = process.env.WAX_RED_GREEN;
  t.after(() => { if (saved === undefined) delete process.env.WAX_RED_GREEN; else process.env.WAX_RED_GREEN = saved; });
  process.env.WAX_RED_GREEN = 'strict';
  await assert.rejects(completePhase(root, 'env', 'implement', { evidence: '확인', proofIds: [only.id] }), /WAX_RED_GREEN/);
  process.env.WAX_RED_GREEN = 'enforce';
  await assert.rejects(completePhase(root, 'env', 'implement', { evidence: '확인', proofIds: [only.id] }), /enforce/);
  delete process.env.WAX_RED_GREEN;

  const source = structuredClone(await getFeature(root, 'env'));
  source.discipline = { redGreen: 'enforce' };
  await importFeature(root, source, 'strict-task');
  await assert.rejects(completePhase(root, 'strict-task', 'implement', { evidence: '확인', proofIds: [only.id] }), /WAX_RED_GREEN=enforce/);
  await assert.rejects(importFeature(root, { ...source, discipline: { redGreen: 'always' } }, 'bad'), /형식/);
  await assert.rejects(importFeature(root, { ...source, discipline: { redGreen: 'enforce', extra: true } }, 'bad'), /형식/);
});

test('stored records: a malformed redGreen or one outside implement is rejected', async (t) => {
  const root = await workspace(t);
  await toImplement(root, 'add');
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof();
  await attach(root, 'add', red); await attach(root, 'add', green);
  const { feature } = await complete(root, 'add', { proofIds: [green.id] });
  const forged = structuredClone(feature);
  forged.completed.implement.redGreen.state = 'perfect';
  assert.throws(() => validateStored(forged), /형식/);
  const misplaced = structuredClone(feature);
  misplaced.completed.design.redGreen = feature.completed.implement.redGreen;
  assert.throws(() => validateStored(misplaced), /형식/);
});

test('CLI --no-red: refused with a pair, accepted without one; MCP wax_complete takes noRed', async (t) => {
  const root = await workspace(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, '--project', root, ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko', WAX_RED_GREEN: '' } });
  await toImplement(root, 'pair');
  const red = proof({ exitCode: 1, tree: { head: HEAD, files: {} } }), green = proof();
  await attach(root, 'pair', red); await attach(root, 'pair', green);
  const refused = run('complete', 'implement', 'pair', '--evidence', '통과', '--proofs', green.id, '--no-red', '문서만');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--no-red 사유를 함께 쓰지 마세요/);
  await toImplement(root, 'docs');
  const only = proof();
  await attach(root, 'docs', only);
  const done = run('complete', 'implement', 'docs', '--evidence', '통과', '--proofs', only.id, '--no-red', '실패를 먼저 볼 수 없는 설정 변경');
  assert.equal(done.status, 0, done.stderr);
  assert.equal((await getFeature(root, 'docs')).completed.implement.redGreen.waiver, '실패를 먼저 볼 수 없는 설정 변경');
  const schema = TOOLS.find((tool) => tool.name === 'wax_complete').inputSchema;
  assert.equal(schema.properties.noRed.maxLength, 2000);
});

test('real wax test proofs in a git repository pair across a code fix, not across two identical runs', async (t) => {
  const root = await workspace(t);
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=wax', '-c', 'user.email=wax@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  await mkdir(join(root, 'src')); await mkdir(join(root, 'test'));
  await writeFile(join(root, 'src', 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  await writeFile(join(root, 'test', 'add.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\ntest('더하기는 합을 낸다', () => assert.equal(add(2, 3), 5));\n");
  await writeFile(join(root, '.gitignore'), '.wax/\n');
  git('add', '.'); git('commit', '-q', '-m', 'start');
  await toImplement(root, 'add');
  const check = [process.execPath, '--test', '--test-reporter=tap', 'test/add.test.mjs'];
  const failed = await runTestProof(root, 'add', check, { checks: ['func-add'], verification: 'runtime' });
  assert.equal(failed.recorded, true);
  assert.notEqual(failed.proof.exitCode, 0);
  const again = await runTestProof(root, 'add', check, { checks: ['func-add'], verification: 'runtime' });
  assert.notEqual(again.proof.exitCode, 0);
  await writeFile(join(root, 'src', 'add.mjs'), 'export const add = (a, b) => a + b;\n');
  const passed = await runTestProof(root, 'add', check, { checks: ['func-add'], verification: 'runtime' });
  assert.equal(passed.proof.exitCode, 0, passed.proof.output);
  const { feature } = await complete(root, 'add', { proofIds: [passed.proof.id] });
  const record = feature.completed.implement.redGreen;
  assert.equal(record.state, 'ok');
  assert.equal(record.pairs[0].red, again.proof.id);
  assert.equal(record.pairs[0].check, 'checks:func-add');
  assert.equal(record.pairs[0].treeChanged, true);
  assert.equal(record.pairs[0].changed, 1);
  assert.deepEqual(record.pairs[0].tests, { parse: 'tap', failed: ['더하기는 합을 낸다'], matched: true });
  assert.deepEqual(record.warnings, []);
  assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), '1');

  const second = await workspace(t);
  const git2 = (...args) => execFileSync('git', ['-c', 'user.name=wax', '-c', 'user.email=wax@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: second, stdio: 'pipe' });
  git2('init', '-q');
  await writeFile(join(second, '.gitignore'), '.wax/\nflag\n');
  await writeFile(join(second, 'check.mjs'), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('flag') ? 0 : 1);\n");
  git2('add', '.'); git2('commit', '-q', '-m', 'start');
  await toImplement(second, 'flaky');
  const flag = [process.execPath, 'check.mjs'];
  const red = await runTestProof(second, 'flaky', flag);
  assert.equal(red.proof.exitCode, 1);
  await writeFile(join(second, 'flag'), '');
  const green = await runTestProof(second, 'flaky', flag);
  assert.equal(green.proof.exitCode, 0);
  const judged = (await complete(second, 'flaky', { proofIds: [green.proof.id] })).feature.completed.implement.redGreen;
  assert.equal(judged.state, 'missing');
  assert.deepEqual(judged.warnings, ['sameTree']);
  assert.ok(JSON.parse(await readFile(join(second, '.wax', 'features', 'flaky.json'), 'utf8')).completed.implement.redGreen);
});
