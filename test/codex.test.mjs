import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installProject } from '../scripts/install-project.mjs';
import { installCodex } from '../scripts/install-codex.mjs';
import { getFeature } from '../src/workflow.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wax codex test '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('project install is idempotent and linked launchers operate on the target project', async (t) => {
  const project = await workspace(t);
  const missing = await installProject({ project, check: true });
  assert.equal(missing.ok, false);
  assert.deepEqual(await readdir(project), []);
  const first = await installProject({ project });
  assert.equal(first.skills.length, 26);
  for (const location of ['.agents/skills', '.grok/skills']) assert.equal(first.skills.filter((skill) => skill.location === location).length, 13);
  assert.deepEqual((await readdir(project)).sort(), ['.agents', '.grok']);
  assert.equal((await installProject({ project })).ok, true);
  assert.equal((await installProject({ project, check: true })).ok, true);
  assert.equal((await installCodex({ project, check: true })).skills.length, 26);
  const cli = join(project, '.agents', 'skills', 'wax-plan', 'run.mjs');
  const call = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--project', project], { encoding: 'utf8' }));
  assert.equal(call('start', 'hello', '--title', '경로에 공백이 있는 작업').revision, 1);
  const document = join(project, 'plan with spaces.md');
  await writeFile(document, '# 수용 기준');
  assert.equal(call('save', 'plan', 'hello', '--file', document, '--revision', '1').revision, 2);
  assert.equal(call('complete', 'plan', 'hello', '--evidence', '기준 확인', '--revision', '2').phase, 'design');
  assert.equal((await getFeature(project, 'hello')).artifacts.plan, '# 수용 기준');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const skill of first.skills) {
    assert.equal(await realpath(skill.path), skill.source);
    assert.equal(execFileSync(process.execPath, [join(skill.path, 'run.mjs'), '--version'], { encoding: 'utf8' }).trim(), version);
  }
});

test('installer preserves conflicting skills and does not partly install', async (t) => {
  const project = await workspace(t);
  const skills = join(project, '.grok', 'skills');
  await mkdir(join(skills, 'wax-review'), { recursive: true });
  await writeFile(join(skills, 'wax-review', 'SKILL.md'), 'user instructions');
  await assert.rejects(installProject({ project }), /기존 파일은 변경하지 않았습니다/);
  assert.deepEqual(await readdir(skills), ['wax-review']);
  assert.deepEqual(await readdir(project), ['.grok']);
  assert.equal(await readFile(join(skills, 'wax-review', 'SKILL.md'), 'utf8'), 'user instructions');
  const check = await installProject({ project, check: true });
  assert.equal(check.ok, false);
  assert.equal(check.skills.find((skill) => skill.name === 'wax-review' && skill.location === '.grok/skills').status, 'conflict');
  assert.equal(check.skills.find((skill) => skill.name === 'wax-review' && skill.location === '.agents/skills').status, 'missing');
});

test('installer rejects redirected destination directories and checks without writing', async (t) => {
  const project = await workspace(t);
  const outside = await workspace(t);
  await symlink(outside, join(project, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installProject({ project }), /일반 디렉터리/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual((await readdir(project)).sort(), ['.agents']);
  const empty = await workspace(t);
  for (const name of ['install-project.mjs', 'install-codex.mjs']) {
    const script = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
    assert.throws(() => execFileSync(process.execPath, [script, '--project', empty, '--check'], { encoding: 'utf8', stdio: 'pipe' }), (error) => {
      assert.equal(error.status, 1);
      assert.equal(JSON.parse(error.stdout).ok, false);
      return true;
    });
  }
  assert.deepEqual(await readdir(empty), []);
});
