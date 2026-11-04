import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changeImpact, commandCovers, importedPaths, impactPrompt, isTestPath, relateTests } from '../src/impact.mjs';
import { buildPrompt, createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildQualityReport } from '../src/quality-report.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));

test('test paths, relative imports and whole-suite commands', () => {
  for (const path of ['test/a.test.mjs', 'src/a.spec.ts', 'tests/test_api.py', 'pkg/x_test.go', '__tests__/b.js', 'e2e/login.ts']) assert.equal(isTestPath(path), true, path);
  for (const path of ['src/a.mjs', 'test/fixtures/data.js', 'docs/test/readme.md', 'test/helpers.json']) assert.equal(isTestPath(path), false, path);
  assert.deepEqual(importedPaths('test/a.test.mjs', "import { x } from '../src/a.mjs';\nconst b = require('./helpers');\nawait import('../src/lazy.js');\nimport 'node:fs';\nimport '../../outside.js';"),
    ['src/a.mjs', 'test/helpers', 'src/lazy.js']);
  const tests = new Set(['test/a.test.mjs', 'test/b.test.mjs']);
  assert.equal(commandCovers(['npm', 'test'], 'test/a.test.mjs', tests), true);
  assert.equal(commandCovers(['C:\\node\\node.exe', '--import', './x.mjs', '--test'], 'test/a.test.mjs', tests), true);
  assert.equal(commandCovers(['node', '--test', 'test/b.test.mjs'], 'test/a.test.mjs', tests), false, 'a run that picks other files does not cover this one');
  assert.equal(commandCovers(['node', '--test', 'test\\a.test.mjs'], 'test/a.test.mjs', tests), true, 'Windows separators');
  assert.equal(commandCovers(['node', '-e', '0'], 'test/a.test.mjs', tests), false);
  assert.equal(commandCovers(['npx', 'playwright', 'test', 'e2e/login.ts'], 'e2e/login.ts', new Set(['e2e/login.ts'])), true);
});

test('relateTests links changed files to tests and reports which ran in this iteration', () => {
  const tests = [
    { path: 'test/pay.test.mjs', text: "import { pay } from '../src/pay.mjs';" },
    { path: 'test/refund.test.mjs', text: "import { refund } from '../src/refund';" },
    { path: 'test/secrets.test.mjs', text: 'no imports' },
    { path: 'test/other.test.mjs', text: "import '../src/other.mjs';" }];
  const proofs = [
    { kind: 'test', id: 'p1', at: '2026-11-04T01:00:00Z', command: ['node', '--test', 'test/pay.test.mjs'], exitCode: 1 },
    { kind: 'test', id: 'p2', at: '2026-11-04T02:00:00Z', command: ['node', '--test', 'test/pay.test.mjs'], exitCode: 0 },
    { kind: 'git', id: 'g1', at: '2026-11-04T03:00:00Z' }];
  const result = relateTests(['src/pay.mjs', 'src/refund.mjs', 'src/secrets.mjs', 'src/lonely.mjs', 'README.md', 'test/other.test.mjs'], tests, proofs);
  assert.deepEqual(result.related.map(({ test: path, because, run, proofId, passed }) => [path, because, run, proofId, passed]), [
    ['test/other.test.mjs', ['test/other.test.mjs'], false, null, null],
    ['test/pay.test.mjs', ['src/pay.mjs'], true, 'p2', true],
    ['test/refund.test.mjs', ['src/refund.mjs'], false, null, null],
    ['test/secrets.test.mjs', ['src/secrets.mjs'], false, null, null]]);
  assert.deepEqual(result.untested, ['src/lonely.mjs'], 'docs are not sources');
  const text = impactPrompt({ state: 'ok', ...result });
  assert.match(text, /^변경 영향\(관찰값, 판정 아님\)/);
  assert.match(text, /돌리지 않은 관련 테스트: test\/other\.test\.mjs\(test\/other\.test\.mjs\); test\/refund\.test\.mjs\(src\/refund\.mjs\)/);
  assert.match(text, /관련 테스트를 찾지 못한 바뀐 소스: src\/lonely\.mjs/);
  assert.equal(impactPrompt({ state: 'ok', related: [{ test: 'a', because: ['b'], run: true, passed: true }], untested: [] }), '');
  assert.equal(impactPrompt({ state: 'unknown' }), '');
});

test('in a repository: changes since the task began, the review prompt, the quality report and the CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wax-impact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  await mkdir(join(root, 'src')); await mkdir(join(root, 'test'));
  await writeFile(join(root, '.gitignore'), '.wax/\n');
  await writeFile(join(root, 'src', 'pay.mjs'), 'export const pay = () => 1;\n');
  await writeFile(join(root, 'src', 'stable.mjs'), 'export const stable = 1;\n');
  await writeFile(join(root, 'test', 'pay.test.mjs'), "import { pay } from '../src/pay.mjs';\n");
  await writeFile(join(root, 'test', 'stable.test.mjs'), "import { stable } from '../src/stable.mjs';\n");
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');

  await createFeature(root, { id: 'pay', title: '결제', projectType: 'general' });
  await writeFile(join(root, 'src', 'pay.mjs'), 'export const pay = () => 2;\n');
  let impact = await changeImpact(root, await getFeature(root, 'pay'));
  assert.equal(impact.state, 'ok');
  assert.equal(impact.changed, 1);
  assert.deepEqual(impact.related.map((item) => [item.test, item.run]), [['test/pay.test.mjs', false]], 'untouched files bring no tests');

  for (const phase of ['plan', 'design', 'implement']) {
    await updateFeature(root, 'pay', 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, 'pay', 'complete', { phase, evidence: '확인', ...(phase === 'implement' ? { waiver: '단계 진행만 확인' } : {}) });
  }
  const feature = await getFeature(root, 'pay');
  impact = await changeImpact(root, feature);
  const prompt = buildPrompt(feature, 'review', { impact: impactPrompt(impact) });
  assert.match(prompt, /돌리지 않은 관련 테스트: test\/pay\.test\.mjs\(src\/pay\.mjs\)/);
  assert.doesNotMatch(buildPrompt(feature, 'implement', { impact: impactPrompt(impact) }), /변경 영향/, 'only the review prompt carries it');

  const out = spawnSync(process.execPath, [CLI, '--project', root, 'prompt', 'review', 'pay'], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });
  assert.match(out.stdout, /변경 영향\(관찰값/);

  let report = await buildQualityReport(root, 'pay', { language: 'ko', freshness: null, manual: null });
  assert.match(report.body, /## 변경 영향[\s\S]*- `test\/pay\.test\.mjs` — 현재 주기에 돌리지 않음 \(`src\/pay\.mjs`\)/);
  assert.deepEqual(report.summary.impact, { changed: 1, related: 1, notRun: 1 });

  await runTestProof(root, 'pay', [process.execPath, '--test', 'test/pay.test.mjs']);
  impact = await changeImpact(root, await getFeature(root, 'pay'));
  assert.deepEqual(impact.related.map((item) => [item.test, item.run, item.passed]), [['test/pay.test.mjs', true, true]]);
  assert.equal(impactPrompt(impact), '', 'nothing to say once the related test ran');

  const cli = spawnSync(process.execPath, [CLI, '--project', root, 'impact', 'pay'], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /바뀐 파일 1개, 관련 테스트 1개, 그중 현재 주기에 돌리지 않은 것 0개[\s\S]*- test\/pay\.test\.mjs — 현재 주기에 통과 \(src\/pay\.mjs\)/);
  assert.equal(JSON.parse(spawnSync(process.execPath, [CLI, '--project', root, 'impact', 'pay', '--json'], { encoding: 'utf8' }).stdout).related[0].run, true);
  assert.match(spawnSync(process.execPath, [CLI, '--project', root, 'impact'], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } }).stderr, /사용법: impact <id>/);
});
