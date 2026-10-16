import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, lstat, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCodex } from './install-codex.mjs';
if (process.platform !== 'win32') throw new Error('Run this validation with Windows Node.js 22 or later.');
const plugin = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(plugin, '.wax-native-validation-'));
try {
  const project = join(temp, 'project with spaces'); await mkdir(project);
  assert.equal((await installCodex({ project, check: true })).ok, false);
  await assert.rejects(lstat(join(project, '.agents')), { code: 'ENOENT' });
  const installed = await installCodex({ project }); assert.equal(installed.skills.length, 12);
  assert.equal((await installCodex({ project })).ok, true); assert.equal((await installCodex({ project, check: true })).ok, true);
  const { version } = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
  for (const skill of installed.skills) {
    assert.equal((await lstat(skill.path)).isSymbolicLink(), true);
    assert.equal(execFileSync(process.execPath, [join(skill.path, 'run.mjs'), '--version'], { encoding: 'utf8', windowsHide: true }).trim(), version);
  }
  const launcher = join(project, '.agents/skills/wax-plan/run.mjs');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [launcher, ...args, '--project', project], { encoding: 'utf8', windowsHide: true }));
  assert.equal(run('start', 'native', '--title', '윈도우 검증').title, '윈도우 검증');
  const document = join(temp, '한글 문서.md'); await writeFile(document, '# 한글 기획 문서', 'utf8');
  assert.equal(run('save', 'plan', 'native', '--file', document, '--revision', '1').revision, 2);
  assert.equal(run('complete', 'plan', 'native', '--evidence', '네이티브 CLI 검증', '--revision', '2').phase, 'design');
  assert.ok(run('archive', 'native', '--revision', '3').archivedAt);
  assert.equal(run('restore', 'native', '--revision', '4').archivedAt, null);
  const tested = JSON.parse(execFileSync(process.execPath, [launcher, 'test', 'native', '--project', project, '--revision', '5', '--', process.execPath, '-e', 'console.log("네이티브 테스트 통과")'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(tested.recorded, true); assert.equal(tested.proof.exitCode, 0); assert.match(tested.proof.output, /네이티브 테스트 통과/);
  const backup = run('backup'); assert.equal(backup.features[0].proofs.length, 1);
  console.log(`PASS Windows ${process.version}: 12 Codex junction skills, idempotent install/check, linked launchers, Korean/spaced paths, lifecycle, archive/restore, test proof and backup.`);
} finally { await rm(temp, { recursive: true, force: true }); }
