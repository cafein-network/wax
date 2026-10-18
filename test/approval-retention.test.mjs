import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { createApproval, cancelApproval, listApprovals, pruneApprovals } from '../src/approvals.mjs';
import { ChatWatcher } from '../src/chat/watcher.mjs';

const input = { tool: 'codex', session: 's', callId: 'i', action: 'command', details: { command: 'npm test' } };

test('500 finished approvals are cached and retention preserves active and damaged records', async (t) => {
  const root = await project(t), dir = join(root, '.wax', 'approvals');
  for (let batch = 0; batch < 25; batch++) {
    await Promise.all(Array.from({ length: 20 }, async () => {
      const p = await createApproval(root, input);
      await cancelApproval(root, p.request.id, p.secret);
    }));
  }
  let reads = 0;
  const readFile = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async (...args) => {
    if (String(args[0]).startsWith(dir) && String(args[0]).endsWith('.json')) reads++;
    return readFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const coldStart = performance.now(); await listApprovals(root); const coldMs = performance.now() - coldStart;
  assert.equal(reads, 500);
  reads = 0;
  const warmStart = performance.now(); const warm = await listApprovals(root); const warmMs = performance.now() - warmStart;
  assert.equal(reads, 0, 'unchanged records must not be read/validated again');
  assert.equal(warm.requests.length, 50); assert.equal(warm.historyOmitted, 450);
  t.diagnostic(`500 approvals: cold=${coldMs.toFixed(1)}ms, cached=${warmMs.toFixed(1)}ms, cached JSON reads=${reads}`);
  warm.requests[0].details.command = 'mutated by caller';
  assert.equal((await listApprovals(root)).requests[0].details.command, 'npm test');
  const pending = await createApproval(root, input);
  await fs.promises.writeFile(join(dir, 'broken.json'), '{broken');
  const removed = await Promise.all([pruneApprovals(root), pruneApprovals(root)]);
  assert.equal(removed.reduce((sum, n) => sum + n, 0), 400);
  assert.equal((await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json')).length, 102);
  const snapshot = await listApprovals(root);
  assert.equal(snapshot.requests[0].id, pending.request.id);
  assert.equal(snapshot.requests[0].status, 'pending'); assert.equal(snapshot.issues.length, 1);
  await fs.promises.writeFile(join(dir, `${pending.request.id}.json`), '{changed');
  const changed = await listApprovals(root);
  assert.ok(!changed.requests.some((r) => r.id === pending.request.id)); assert.equal(changed.issues.length, 2);
});

test('watcher reports a persistent approval path error once and re-arms after recovery', async (t) => {
  const root = await project(t, ['one']), path = join(root, '.wax', 'approvals');
  await fs.promises.writeFile(path, 'not a directory');
  const watcher = new ChatWatcher(root), errors = [];
  watcher.on('error', (error) => errors.push(error));
  await watcher.tick(); await watcher.tick(); assert.equal(errors.length, 1);
  await fs.promises.unlink(path); await fs.promises.mkdir(path); await watcher.tick();
  await fs.promises.rmdir(path); await fs.promises.writeFile(path, 'broken again');
  await watcher.tick(); await watcher.tick(); assert.equal(errors.length, 2);
});

test('Claude standard approval hooks are separate from usage modules', async () => {
  const hooks = JSON.parse(await fs.promises.readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const modules = JSON.parse(await fs.promises.readFile(new URL('../claude-mods/hooks.json', import.meta.url), 'utf8'));
  assert.ok(modules.modules.includes('./usage.mjs')); assert.equal(modules.hooks, undefined);
  assert.equal(hooks.hooks.PermissionRequest[0].hooks[0].timeout, 35);
  assert.match(hooks.hooks.PermissionRequest[0].hooks[0].command, /wax-approval-hook\.mjs/);
  assert.ok(hooks.hooks.SessionEnd);
});
