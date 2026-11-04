import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditProof, dependencyChanges, depsPrompt, packageChanges, parseRequirements, requirementChanges } from '../src/deps.mjs';
import { reviewNotes } from '../src/impact.mjs';
import { createFeature, getFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildQualityReport, characteristicEvidence } from '../src/quality-report.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));

test('package.json and requirements differences', () => {
  const before = JSON.stringify({ dependencies: { a: '^1.0.0', b: '^2.0.0' }, devDependencies: { t: '1' } });
  const after = JSON.stringify({ dependencies: { a: '^1.1.0', c: '3.0.0' }, devDependencies: { t: '1', lint: '9' } });
  assert.deepEqual(packageChanges(before, after), [
    { name: 'a', kind: 'updated', from: '^1.0.0', to: '^1.1.0', section: 'dependencies' },
    { name: 'b', kind: 'removed', from: '^2.0.0', section: 'dependencies' },
    { name: 'c', kind: 'added', to: '3.0.0', section: 'dependencies' },
    { name: 'lint', kind: 'added', to: '9', section: 'devDependencies' }]);
  assert.deepEqual(packageChanges(null, '{"dependencies":{"x":"1"}}'), [{ name: 'x', kind: 'added', to: '1', section: 'dependencies' }]);
  assert.equal(packageChanges('{', '{}'), null, 'unreadable JSON is skipped, not guessed');
  assert.deepEqual([...parseRequirements('# c\nRequests==2.31.0  # http\nflask[async]>=3\n-r base.txt\nmy_pkg\n')], [['requests', '==2.31.0'], ['flask', '>=3'], ['my-pkg', '*']]);
  assert.deepEqual(requirementChanges('requests==2.31.0\nold==1', 'requests==2.32.0\nnew>=1'), [
    { name: 'new', kind: 'added', to: '>=1', section: 'requirements' },
    { name: 'old', kind: 'removed', from: '==1', section: 'requirements' },
    { name: 'requests', kind: 'updated', from: '==2.31.0', to: '==2.32.0', section: 'requirements' }]);
});

test('audit proofs: sec-deps checks or a known audit command in this iteration', () => {
  const proof = (id, extra) => ({ kind: 'test', id, iteration: 1, at: `2026-11-04T0${id}:00:00Z`, command: ['node', '-e', '0'], exitCode: 0, ...extra });
  assert.equal(auditProof({ iteration: 1, proofs: [proof(1)] }), null);
  assert.equal(auditProof({ iteration: 1, proofs: [proof(1, { checks: ['sec-deps'] })] }).id, 1);
  assert.equal(auditProof({ iteration: 1, proofs: [proof(1, { command: ['npm', 'audit', '--omit=dev'] }), proof(2, { command: ['pip-audit'], exitCode: 1 })] }).id, 2, 'the latest one');
  assert.equal(auditProof({ iteration: 2, proofs: [proof(1, { checks: ['sec-deps'] })] }), null, 'only this iteration');
});

test('in a repository: changed dependencies, licenses, the review prompt, the quality report and the CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wax-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  await writeFile(join(root, '.gitignore'), '.wax/\nnode_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { left: '^1.0.0' } }, null, 2));
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  await createFeature(root, { id: 'pay', title: '결제', projectType: 'general' });
  assert.equal((await dependencyChanges(root, await getFeature(root, 'pay'))).state, 'none');
  assert.equal(depsPrompt({ state: 'none' }), '');

  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { left: '^1.2.0', mit: '1.0.0', gpl: '2.0.0', ghost: '0.1.0' } }, null, 2));
  await writeFile(join(root, 'package-lock.json'), '{}');
  for (const [name, license] of [['mit', 'MIT'], ['gpl', 'GPL-3.0-only'], ['left', 'ISC']]) {
    await mkdir(join(root, 'node_modules', name), { recursive: true });
    await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, license }));
  }
  let feature = await getFeature(root, 'pay');
  const deps = await dependencyChanges(root, feature);
  assert.equal(deps.state, 'changed');
  assert.deepEqual(deps.lockfiles, ['package-lock.json']);
  assert.deepEqual(deps.manifests[0].changes.map(({ name, kind, license, copyleft }) => [name, kind, license, copyleft ?? false]), [
    ['ghost', 'added', null, false], ['gpl', 'added', 'GPL-3.0-only', true], ['left', 'updated', 'ISC', false], ['mit', 'added', 'MIT', false]]);
  assert.equal(deps.audit, null);

  const notes = await reviewNotes(root, feature);
  assert.match(notes, /의존성 변경\(관찰값, 판정 아님\)[\s\S]*- package\.json: \+ghost 0\.1\.0, \+gpl 2\.0\.0, left \^1\.0\.0 → \^1\.2\.0, \+mit 1\.0\.0/);
  assert.match(notes, /배포 조건을 확인할 라이선스: gpl\(GPL-3\.0-only\)/);
  assert.match(notes, /라이선스를 확인하지 못한 패키지\(설치되지 않음\): ghost/);
  assert.match(notes, /CLI test <id> --checks sec-deps -- <명령>/);

  let report = await buildQualityReport(root, 'pay', { language: 'ko', freshness: null, manual: null, impact: null });
  assert.match(report.body, /## 의존성 변경[\s\S]*`package\.json` `\+gpl 2\.0\.0` — GPL-3\.0-only \(배포 조건 확인 필요\)[\s\S]*현재 주기 감사 근거 없음/);
  assert.deepEqual(report.summary.deps, { packages: 4, lockfiles: 1, audited: false, passed: null });

  await runTestProof(root, 'pay', [process.execPath, '-e', 'process.exit(0)'], { checks: ['sec-deps'], verification: 'integration' });
  feature = await getFeature(root, 'pay');
  assert.doesNotMatch(await reviewNotes(root, feature), /감사 근거가 없습니다/);
  report = await buildQualityReport(root, 'pay', { language: 'ko', freshness: null, manual: null, impact: null });
  assert.match(report.body, /현재 주기 감사 근거: 통과 \(테스트 /);
  assert.equal(characteristicEvidence(feature).find((item) => item.id === 'security').pass, 1, 'sec-deps counts as security evidence');

  const run = (...args) => spawnSync(process.execPath, [CLI, '--project', root, 'deps', ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });
  const out = run('pay');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /package\.json \(npm\)\n- \+ghost 0\.1\.0 — 라이선스 미확인\(설치되지 않음\)\n- \+gpl 2\.0\.0 — GPL-3\.0-only \(배포 조건 확인 필요\)/);
  assert.match(out.stdout, /바뀐 잠금 파일: package-lock\.json[\s\S]*현재 주기 감사 근거: 통과/);
  assert.equal(JSON.parse(run('pay', '--json').stdout).manifests[0].ecosystem, 'npm');
  assert.match(run().stderr, /사용법: deps <id>/);
});
