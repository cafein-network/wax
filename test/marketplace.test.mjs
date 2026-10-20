import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('Codex catalog resolves wax from the marketplace root with its CLI and all skills', async () => {
  const catalog = await readJson('.agents/plugins/marketplace.json');
  const pkg = await readJson('package.json');
  assert.equal(catalog.name, 'wax');
  assert.equal(catalog.interface.displayName, 'wax');
  assert.equal(catalog.plugins.length, 1);
  const entry = catalog.plugins[0];
  assert.equal(entry.name, 'wax');
  assert.deepEqual(entry.source, { source: 'local', path: './' });
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.equal(entry.category, 'Productivity');
  assert.ok(pkg.files.includes('.agents/plugins/marketplace.json'));

  const pluginRoot = new URL(entry.source.path, root);
  const manifest = JSON.parse(await readFile(new URL('.codex-plugin/plugin.json', pluginRoot), 'utf8'));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, pkg.version);
  const skillsRoot = new URL(manifest.skills, pluginRoot);
  const skills = (await readdir(skillsRoot, { withFileTypes: true })).filter(item => item.isDirectory());
  assert.equal(skills.length, 13);
  for (const skill of skills) {
    const skillRoot = new URL(`${skill.name}/`, skillsRoot);
    assert.match(await readFile(new URL('SKILL.md', skillRoot), 'utf8'), /^---\r?\n/);
    const version = execFileSync(process.execPath, [fileURLToPath(new URL('run.mjs', skillRoot)), '--version'], { encoding: 'utf8' }).trim();
    assert.equal(version, pkg.version);
  }
  for (const path of ['.claude-plugin/marketplace.json', '.github/plugin/marketplace.json']) {
    const otherCatalog = await readJson(path);
    assert.equal(otherCatalog.name, catalog.name);
    assert.ok(otherCatalog.plugins.some(plugin => plugin.name === entry.name && plugin.source === entry.source.path));
  }
});
