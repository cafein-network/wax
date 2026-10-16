import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { project } from './chat-helpers.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { createApproval, listApprovals, decideApproval, takeDecision, finishDelivery, waitForApproval, cancelApproval, cancelSessionApprovals } from '../src/approvals.mjs';
import { handleClaudeApproval, handleCodexApproval } from '../src/approval-hosts.mjs';
import { runCodexSession } from '../src/codex-session.mjs';

const input = (changes = {}) => ({ tool: 'claude', session: 'session-1', callId: 'tool-1', action: 'Bash', details: { cwd: '/project', command: 'npm test' }, ...changes });
const approve = (root, request, decision = 'allow') => decideApproval(root, request.id, { decision, fingerprint: request.fingerprint, actor: '사람' });
async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(20); }
  throw new Error('test timed out');
}
async function setup(t) {
  const root = await project(t);
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, intervalMs: 50 });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  const post = (request, decision, extra = {}) => fetch(`${base}/api/approvals/${request.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': config.token, ...extra }, body: JSON.stringify({ fingerprint: request.fingerprint, decision }),
  });
  return { root, server, base, config, post };
}

test('request, one-time human decision, adapter claim and confirmed delivery are distinct', async (t) => {
  const root = await project(t);
  const { request, secret } = await createApproval(root, input());
  const publicText = JSON.stringify(await listApprovals(root));
  assert.ok(!publicText.includes(secret)); assert.ok(!publicText.includes('secretHash'));
  await assert.rejects(takeDecision(root, request.id, 'wrong'), { status: 403 });
  await assert.rejects(approve(root, { ...request, fingerprint: 'wrong' }), { status: 409 });
  await approve(root, request);
  await assert.rejects(approve(root, request, 'deny'), { status: 409 });
  assert.equal(await takeDecision(root, request.id, secret), 'allow');
  assert.equal((await listApprovals(root)).requests[0].status, 'dispatching');
  await assert.rejects(takeDecision(root, request.id, secret), { status: 409 });
  await finishDelivery(root, request.id, secret);
  const saved = (await listApprovals(root)).requests[0];
  assert.equal(saved.status, 'delivered');
  assert.deepEqual(saved.events.map((e) => e.status), ['pending', 'decided', 'dispatching', 'delivered']);
});

test('concurrent browser decisions have exactly one winner', async (t) => {
  const root = await project(t);
  const { request } = await createApproval(root, input());
  const results = await Promise.allSettled([approve(root, request), approve(root, request, 'deny')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
});

test('expiry, disconnect, session ending and replay never yield permission', async (t) => {
  const root = await project(t);
  const expired = await createApproval(root, input(), { timeoutMs: 100 });
  assert.equal(await waitForApproval(root, expired, { pollMs: 20 }), null);
  await assert.rejects(approve(root, expired.request), { status: 409 });
  assert.equal((await listApprovals(root)).requests[0].status, 'expired');
  const pending = await createApproval(root, input());
  await approve(root, pending.request);
  await cancelSessionApprovals(root, 'claude', 'session-1');
  assert.equal(await waitForApproval(root, pending, { pollMs: 20 }), null);
  const disconnected = await createApproval(root, input());
  const controller = new AbortController(); controller.abort();
  assert.equal(await waitForApproval(root, disconnected, { signal: controller.signal }), null);
  await assert.rejects(takeDecision(root, disconnected.request.id, disconnected.secret), { status: 409 });
});

test('mutated payload, foreign project and symlink storage cannot be approved', async (t) => {
  const root = await project(t), other = await project(t);
  const pending = await createApproval(root, input());
  const path = join(root, '.wax', 'approvals', `${pending.request.id}.json`);
  const original = await readFile(path, 'utf8');
  const record = JSON.parse(original); record.details.command = 'changed command';
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(approve(root, pending.request), { status: 500 });
  assert.equal((await listApprovals(root)).issues.length, 1);
  await writeFile(path, original);
  const otherPending = await createApproval(other, input());
  const otherPath = join(other, '.wax', 'approvals', `${pending.request.id}.json`);
  await writeFile(otherPath, original);
  await assert.rejects(approve(other, pending.request), { status: 403 });
  await cancelApproval(other, otherPending.request.id, otherPending.secret);
  const unsafe = await project(t, ['login']);
  await symlink(join(root, '.wax', 'approvals'), join(unsafe, '.wax', 'approvals'), 'junction');
  await assert.rejects(createApproval(unsafe, input()), /심볼릭 링크/);
});

test('GUI endpoint requires token, origin and exact request; chat text is not approval', async (t) => {
  const { root, base, config, post } = await setup(t);
  const { request, secret } = await createApproval(root, input());
  assert.equal((await post(request, 'allow', { 'x-chat-token': 'wrong' })).status, 403);
  assert.equal((await post(request, 'allow', { origin: 'http://foreign.example' })).status, 403);
  assert.equal((await post(request, 'acceptForSession')).status, 400);
  await fetch(`${base}/api/channels/general/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': config.token }, body: JSON.stringify({ body: '허용', type: 'message' }) });
  assert.equal((await listApprovals(root)).requests[0].status, 'pending');
  assert.equal((await post(request, 'deny')).status, 200);
  assert.equal(await takeDecision(root, request.id, secret), 'deny');
  assert.equal((await post(request, 'allow')).status, 409);
  for (const page of ['/', '/chat']) assert.match(await (await fetch(base + page)).text(), /id="approvals"/);
});

test('Claude hook waits for a GUI answer and emits the exact allow/deny response', async (t) => {
  const { root, post, server } = await setup(t);
  for (const decision of ['allow', 'deny']) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/wax-approval-hook.mjs', import.meta.url))], {
      cwd: root, env: { ...process.env, WAX_APPROVALS: 'on', WAX_PROJECT: root, WAX_APPROVAL_PORT: String(server.address().port) }, windowsHide: true,
    });
    let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; });
    const closed = once(child, 'close');
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', cwd: root, session_id: 'hook-session', tool_use_id: decision, tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    const request = await until(async () => (await listApprovals(root)).requests.find((r) => r.callId === decision));
    assert.equal(stdout, '', 'no approval before a human response');
    assert.equal((await post(request, decision)).status, 200);
    assert.equal((await closed)[0], 0);
    const response = JSON.parse(stdout);
    assert.equal(response.hookSpecificOutput.decision.behavior, decision);
    assert.equal(response.hookSpecificOutput.decision.updatedPermissions, undefined);
    assert.equal((await listApprovals(root)).requests.find((r) => r.id === request.id).status, 'delivered');
  }
});

test('Claude unavailable dashboard and timed-out hook leave native permission flow unchanged', async (t) => {
  const root = await project(t, ['login']);
  const input = { hook_event_name: 'PermissionRequest', cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  let emitted = 0;
  assert.equal(await handleClaudeApproval(input, { env: {}, dashboard: async () => { throw new Error('opt-out must not probe'); }, emit: () => { emitted++; } }), false);
  assert.equal(await handleClaudeApproval(input, { env: { WAX_APPROVALS: 'on' }, dashboard: async () => null, emit: () => { emitted++; } }), false);
  assert.equal((await listApprovals(root)).requests.length, 0);
  let notice = '';
  assert.equal(await handleClaudeApproval(input, { env: { WAX_APPROVALS: 'on' }, dashboard: async () => ({ root }), timeoutMs: 100,
    log: (text) => { notice += text; }, emit: () => { emitted++; } }), false);
  assert.match(notice, /4330\/chat/);
  assert.match(notice, /콘솔 승인/);
  assert.equal(emitted, 0);
});

test('Codex adapter binds thread/turn/item and only allows once with a full preview', async (t) => {
  const root = await project(t);
  const message = { id: 55, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'patch' } };
  await assert.rejects(handleCodexApproval(root, message, { emit() {} }), /파일 변경 내용/);
  await assert.rejects(handleCodexApproval(root, { ...message, params: { ...message.params, grantRoot: root } }, {
    item: { changes: [{ path: 'app.js', diff: '+new code' }] }, emit() {},
  }), /세션 동안/);
  const replies = [];
  const waiting = handleCodexApproval(root, message, { item: { id: 'patch', changes: [{ path: 'app.js', diff: '+new code' }] }, emit: async (r) => replies.push(r) });
  const request = await until(async () => (await listApprovals(root)).requests.find((r) => r.status === 'pending'));
  assert.equal(request.details.turnId, 'turn');
  assert.match(JSON.stringify(request.details), /new code/);
  await approve(root, request); await waiting;
  assert.deepEqual(replies, [{ id: 55, result: { decision: 'accept' } }]);
  const controller = new AbortController(); controller.abort();
  const cancelled = { ...message, id: 56, method: 'item/commandExecution/requestApproval', params: { ...message.params, command: 'npm test' } };
  await handleCodexApproval(root, cancelled, { signal: controller.signal, emit: (r) => replies.push(r) });
  assert.equal(replies.length, 1, 'cancelled host requests receive no stale reply');
});

test('Codex App Server session completes its RPC loop through GUI approval', async (t) => {
  const { root, post } = await setup(t);
  const fake = join(root, 'fake-codex.js');
  await writeFile(fake, `process.stdout.write('Starting Codex...\\n');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
rl.on('line', line => { const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread-e2e'}}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn-e2e'}}});
    send({method:'item/started',params:{threadId:'thread-e2e',turnId:'turn-e2e',item:{id:'cmd',type:'commandExecution',command:'npm test',cwd:process.cwd()}}});
    send({id:123,method:'item/commandExecution/requestApproval',params:{threadId:'thread-e2e',turnId:'turn-e2e',itemId:'cmd',command:'npm test',availableDecisions:['accept','decline']}});
  }
  if (m.id === 123 && m.result) {
    send({method:'serverRequest/resolved',params:{threadId:'thread-e2e',requestId:123}});
    send({method:'item/agentMessage/delta',params:{threadId:'thread-e2e',delta:'decision=' + m.result.decision}});
    send({method:'turn/completed',params:{threadId:'thread-e2e',turn:{id:'turn-e2e',status:'completed'}}});
  }
});`);
  let output = '';
  const running = runCodexSession(root, { prompt: '테스트 실행', executable: fake, output: (text) => { output += text; }, log() {} });
  const request = await until(async () => (await listApprovals(root)).requests.find((r) => r.tool === 'codex'));
  assert.equal((await post(request, 'allow')).status, 200);
  assert.equal((await running).status, 'completed');
  assert.equal(output, 'decision=accept');
  assert.equal((await listApprovals(root)).requests[0].status, 'delivered');
});

test('Codex host resolution, completed items, process loss and interruption cancel pending GUI actions', async (t) => {
  for (const mode of ['resolved', 'item-completed', 'exit', 'interrupt']) {
    const root = await project(t), controller = new AbortController(), replies = [];
    let child;
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    const launch = () => {
      child = new EventEmitter();
      for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
      child.kill = () => { child.stdout.end(); child.stderr.end(); };
      child.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().trim().split('\n')) {
          const m = JSON.parse(line);
          if (m.method === 'initialize') send({ id: m.id, result: {} });
          if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread' } } });
          if (m.method === 'turn/start') {
            send({ id: m.id, result: { turn: { id: 'turn' } } });
            send({ id: 17, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'npm test' } });
          }
          if (m.id === 17) replies.push(m);
        }
      });
      return child;
    };
    const running = runCodexSession(root, { prompt: 'test', executable: 'fake.js', launch, signal: controller.signal, output() {}, log() {} });
    const outcome = running.then((value) => ({ value }), (error) => ({ error }));
    const pending = await until(async () => (await listApprovals(root)).requests[0]);
    if (mode === 'exit') child.emit('exit', 1);
    else if (mode === 'interrupt') controller.abort();
    else {
      send(mode === 'resolved' ? { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 17 } } :
        { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'cmd' } } });
      await until(async () => (await listApprovals(root)).requests[0].status === 'cancelled');
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }
    const result = await outcome;
    assert.equal(Boolean(result.error), ['exit', 'interrupt'].includes(mode), mode);
    assert.equal((await listApprovals(root)).requests[0].status, 'cancelled', mode);
    await assert.rejects(approve(root, pending), { status: 409 });
    assert.deepEqual(replies, [], `${mode}: a cancelled RPC receives no stale decision`);
  }
});
