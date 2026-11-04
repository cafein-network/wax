import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { project } from './chat-helpers.mjs';
import { runCodexSession } from '../src/codex-session.mjs';

function lingeringCodex(turn) {
  const child = new EventEmitter();
  child.pid = 4242;
  for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
  const send = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const m = JSON.parse(line);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread' } } });
      if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'turn' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', ...turn } } });
      }
    }
  });
  return () => child;
}

test('Codex session: a failed turn keeps its own error when the process does not confirm exit', async (t) => {
  const root = await project(t);
  const limit = 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Nov 22nd, 2026 2:36 PM.';
  const error = await runCodexSession(root, { prompt: 'test', executable: 'fake.js', launch: lingeringCodex({ status: 'failed', error: { message: limit } }), exitWaitMs: 10, output() {}, log() {} })
    .then(() => null, (failure) => failure);
  assert.ok(error);
  assert.match(error.message, /usage limit/);
  assert.doesNotMatch(error.message, /종료를 확인하지 못했습니다/);
  assert.equal(error.toolOutput.error, limit, 'tool health sees the real failure shape');
});

test('Codex session: a finished turn whose process never closes is still reported as unconfirmed', async (t) => {
  const root = await project(t);
  await assert.rejects(runCodexSession(root, { prompt: 'test', executable: 'fake.js', launch: lingeringCodex({ status: 'completed' }), exitWaitMs: 10, output() {}, log() {} }),
    /종료를 확인하지 못했습니다/);
});

test('Codex session on Windows: ending the session ends the launcher\'s child process too', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await project(t), fake = join(root, 'fake-codex.js'), pidFile = join(root, 'grandchild.pid');
  await writeFile(fake, `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'reply',type:'agentMessage',text:'done'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});`);
  const outcome = await runCodexSession(root, { prompt: 'test', executable: fake, output() {}, log() {} }).then((value) => ({ value }), (error) => ({ error }));
  const pid = Number(await readFile(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid); } catch {   } });
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await sleep(100); } catch { alive = false; }
  }
  assert.equal(outcome.error?.message, undefined, 'the session finishes instead of failing to confirm exit');
  assert.equal(outcome.value.message, 'done');
  assert.equal(alive, false, 'the grandchild holding the pipe was ended with the launcher');
});
