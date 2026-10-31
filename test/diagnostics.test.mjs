import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFeature } from '../src/workflow.mjs';
import { diagnoseProject } from '../src/diagnostics.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('diagnostics finds all damaged files and locks while preserving every record', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'healthy', title: '정상 작업' });
  const directory = join(root, '.wax', 'features');
  await writeFile(join(directory, 'broken.json'), '{');
  await writeFile(join(directory, 'schema.json'), '{}');
  await mkdir(join(directory, 'healthy.lock'));
  const before = await readdir(directory);
  const original = await readFile(join(directory, 'healthy.json'), 'utf8');
  const result = await diagnoseProject(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.features, { total: 3, valid: 1 });
  assert.deepEqual(result.issues.map((issue) => issue.file), ['broken.json', 'healthy.lock', 'schema.json']);
  assert.deepEqual(await readdir(directory), before);
  assert.equal(await readFile(join(directory, 'healthy.json'), 'utf8'), original);
  assert.equal(await readFile(join(directory, 'broken.json'), 'utf8'), '{');
  const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [cli, 'doctor', '--project', root], { encoding: 'utf8', stdio: 'pipe' }), (error) => {
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(error.stdout).issues.length, 3);
    return true;
  });
});

test('diagnostics does not initialize an empty project and rejects symlink data roots', async (t) => {
  const root = await workspace(t);
  assert.equal((await diagnoseProject(root)).ok, true);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await diagnoseProject(join(root, 'missing'))).ok, false);
  const outside = await workspace(t);
  await symlink(outside, join(root, '.wax'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await diagnoseProject(root)).issues[0].code, 'INVALID_DIRECTORY');
  assert.deepEqual(await readdir(outside), []);
});

test('diagnostics reports Playwright tools for web projects without installing or creating anything', async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  const asked = [];
  let result = await diagnoseProject(root, { readVersion: async (bin) => { asked.push(bin); return null; } });
  assert.equal(result.ok, true);
  assert.deepEqual(asked, ['playwright-cli']);
  assert.deepEqual({ ...result.browser, hints: result.browser.hints.length }, { projectType: 'web', playwrightCli: null, playwrightTest: null, hints: 2 });
  await mkdir(join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
  await writeFile(join(root, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({ version: '1.56.0' }));
  result = await diagnoseProject(root, { readVersion: async () => '0.1.0' });
  assert.deepEqual(result.browser, { projectType: 'web', playwrightCli: '0.1.0', playwrightTest: '1.56.0', hints: [] });
  assert.deepEqual((await readdir(root)).sort(), ['node_modules', 'package.json']);
});
