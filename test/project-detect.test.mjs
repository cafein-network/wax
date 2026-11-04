import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectType } from '../src/project-detect.mjs';

async function repo(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'wax-detect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('web frameworks in the root package mark a web project', async (t) => {
  assert.equal(await detectProjectType(await repo(t, { 'package.json': { dependencies: { react: '19', 'react-dom': '19' } } })), 'web');
  assert.equal(await detectProjectType(await repo(t, { 'package.json': { devDependencies: { vite: '7' } } })), 'web');
  assert.equal(await detectProjectType(await repo(t, { 'package.json': { dependencies: { express: '5' } } })), null);
});

test('mobile and desktop apps are not web projects even when they use React', async (t) => {
  for (const native of ['react-native', 'expo', 'electron', '@tauri-apps/api']) {
    const root = await repo(t, { 'package.json': { dependencies: { react: '19', [native]: '1' } } });
    assert.equal(await detectProjectType(root), null, native);
  }
});

test('workspaces are searched for a web package', async (t) => {
  const npm = await repo(t, {
    'package.json': { private: true, workspaces: ['apps/*', 'packages/ui'] },
    'apps/mobile/package.json': { dependencies: { react: '19', 'react-native': '0.80' } },
    'apps/site/package.json': { dependencies: { next: '16' } },
  });
  assert.equal(await detectProjectType(npm), 'web');
  const yarn = await repo(t, { 'package.json': { workspaces: { packages: ['packages/ui'] } }, 'packages/ui/package.json': { devDependencies: { '@playwright/test': '1' } } });
  assert.equal(await detectProjectType(yarn), 'web');
  const pnpm = await repo(t, { 'package.json': { private: true }, 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'apps/web/package.json': { dependencies: { vue: '3' } } });
  assert.equal(await detectProjectType(pnpm), 'web');
  const nativeOnly = await repo(t, { 'package.json': { workspaces: ['apps/*'] }, 'apps/mobile/package.json': { dependencies: { react: '19', expo: '54' } } });
  assert.equal(await detectProjectType(nativeOnly), null);
});

test('missing, oversized or malformed packages and escaping patterns are ignored', async (t) => {
  assert.equal(await detectProjectType(await repo(t, {})), null);
  assert.equal(await detectProjectType(await repo(t, { 'package.json': '{ not json' })), null);
  assert.equal(await detectProjectType(await repo(t, { 'package.json': [] })), null);
  assert.equal(await detectProjectType(await repo(t, { 'package.json': `{"dependencies":{"react":"19"},"pad":"${'x'.repeat(1024 * 1024)}"}` })), null);
  const outside = await repo(t, { 'web/package.json': { dependencies: { react: '19' } }, 'repo/package.json': { workspaces: ['../web', '!apps/*', 'apps/**/x'] } });
  assert.equal(await detectProjectType(join(outside, 'repo')), null);
});
