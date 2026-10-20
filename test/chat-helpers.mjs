import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFeature } from '../src/workflow.mjs';

export const BIN = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));

export async function createTestSymlink(t, target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file symlink privilege is unavailable');
    return false;
  }
}

export async function project(t, features = []) {
  const root = await mkdtemp(join(tmpdir(), 'wax-chat-테스트-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  for (const id of features) await createFeature(root, { id, title: `${id} 작업` });
  return root;
}

export function cli(root, args, { cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--project', root, 'chat', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export const at = (iso) => ({ now: new Date(iso) });
