import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { project, BIN, createTestSymlink } from './chat-helpers.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { postNote } from '../src/chat/board.mjs';
import { assignTask, setPm, updateTask } from '../src/chat/team.mjs';
import { loadSqlite } from '../src/sqlite.mjs';
import { buildIndex, indexStatus, search, openIndex, syncIndex, plan, terms, bigrams, marksIn } from '../src/search.mjs';
import { sqlite, korean, skip, STORE, channelFile, line, refs, count, run, RECOVERY_RECORDS, bigChannel, ownerPid } from './search-helpers.mjs';

test('R2: two builds at once both finish and leave a complete index', { skip }, async (t) => {
  const root = await project(t);
  await bigChannel(root, 8000);
  const results = await Promise.all([run([BIN, '--project', root, 'search', 'index']), run([BIN, '--project', root, 'search', 'index', '--rebuild']), buildIndex(root)]);
  for (const r of results.slice(0, 2)) assert.equal(r.code, 0, r.stderr);
  const status = await indexStatus(root);
  assert.equal(status.state, 'ready'); assert.equal(status.documents, 8000);
});

test('R2: after a dashboard restart an interrupted build is shown with a resume action that completes it', { skip }, async (t) => {
  const { createChatServer } = await import('../src/chat/server.mjs');
  const root = await project(t);
  await bigChannel(root);
  const start = async () => {
    const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => server.listening ? server.shutdown() : undefined);
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, base, token: (await (await fetch(`${base}/api/config`)).json()).token };
  };
  const dir = join(root, '.wax', 'search');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.db.new-2147483646-1'), 'left by a killed build');
  await buildIndex(root);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('index.db.new-')), []);
  let { server, base, token } = await start();
  await fetch(`${base}/api/search/index`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify({ rebuild: true }) });
  const pid = await ownerPid(root);
  for (let i = 0; i < 400 && (await indexStatus(root)).state !== 'building'; i++) await new Promise((done) => setTimeout(done, 5));
  process.kill(pid, 'SIGKILL');
  let stopped;
  for (let i = 0; i < 400; i++) {
    stopped = await (await fetch(`${base}/api/search/status`)).json();
    if (!stopped.job?.running) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(stopped.job?.running, false, JSON.stringify(stopped));
  assert.equal(stopped.state, 'interrupted', JSON.stringify(stopped));
  await server.shutdown();
  ({ server, base, token } = await start());
  let status = await (await fetch(`${base}/api/search/status`)).json();
  assert.equal(status.state, 'interrupted'); assert.equal(status.job, null);
  await postMessage(root, 'general', { author: '대표', kind: 'human', body: '재시작 뒤 인계' });
  await fetch(`${base}/api/search/index`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: '{}' });
  for (let i = 0; i < 200; i++) { status = await (await fetch(`${base}/api/search/status`)).json(); if (!status.job?.running) break; await new Promise((done) => setTimeout(done, 50)); }
  assert.equal(status.state, 'ready', JSON.stringify(status.job)); assert.equal(status.documents, RECOVERY_RECORDS + 1);
  const found = await (await fetch(`${base}/api/search?q=${encodeURIComponent('인계')}&author=${encodeURIComponent('대표')}`)).json();
  assert.equal(found.total, 1);
});
