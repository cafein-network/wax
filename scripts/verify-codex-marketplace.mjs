import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.argv[2];
if (!cli) throw new Error('Pass the installed Codex executable or codex.js path.');
const root = resolve(process.argv[3] || fileURLToPath(new URL('../', import.meta.url)));
const testHome = await mkdtemp(join(tmpdir(), 'wax-codex-marketplace-'));
const isScript = /\.m?js$/i.test(cli);
const call = args => JSON.parse(execFileSync(isScript ? process.execPath : cli, [
  ...(isScript ? [cli] : []), 'plugin', ...args, '--json'
], { cwd: root, env: { ...process.env, CODEX_HOME: testHome }, encoding: 'utf8', timeout: 60000 }));

try {
  const added = call(['marketplace', 'add', root]);
  assert.equal(added.marketplaceName, 'wax');
  const available = call(['list', '--marketplace', 'wax', '--available']);
  assert.ok(available.available.some(plugin => plugin.pluginId === 'wax@wax'));
  call(['add', 'wax@wax']);
  const installed = call(['list', '--marketplace', 'wax']);
  assert.ok(installed.installed.some(plugin => plugin.pluginId === 'wax@wax' && plugin.enabled));
  assert.equal(call(['marketplace', 'add', root]).alreadyAdded, true);
  call(['add', 'wax@wax']);
  console.log('PASS: Codex discovers, installs, enables and reinstalls wax@wax with an isolated configuration.');
} finally {
  await rm(testHome, { recursive: true, force: true, maxRetries: 5 });
}
