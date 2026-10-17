import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { project } from './chat-helpers.mjs';
import { createRequestRunner } from '../src/chat/requests.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { withLock } from '../src/chat/lock.mjs';
import { getFeature, listFeatures, PHASES, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { listPresence } from '../src/chat/presence.mjs';
import { runCodexSession, codexExitMessage } from '../src/codex-session.mjs';

async function until(check) {
  for (let n = 0; n < 250; n++) { const result = await check(); if (result) return result; await sleep(20); }
  throw new Error('condition timed out');
}
const response = (phase, overrides = {}) => ({ threadId: 'test-thread', message: JSON.stringify({ outcome: 'complete', report: `${phase} 보고`, document: `# ${phase}\n\n확인된 범위와 결과`, evidence: '테스트 픽스처 검증', proofIds: [], ...overrides }) });
function executor(calls, options = {}) {
  return async (root, input) => {
    const feature = (await listFeatures(root)).find((f) => input.prompt.includes(`현재 작업: ${f.id},`));
    calls.push({ phase: feature.phase, ...input });
    if (options.before) await options.before(root, input, feature);
    if (options.outcome) return response(feature.phase, options.outcome);
    const proofIds = [];
    if (['implement', 'review'].includes(feature.phase) && !options.noProof) {
      const result = await runTestProof(root, feature.id, [process.execPath, '-e', 'require("node:assert/strict").equal(2 + 2, 4)'], { revision: feature.revision });
      assert.equal(result.recorded, true);
      proofIds.push(result.proof.id);
    }
    return response(feature.phase, { proofIds });
  };
}
async function runnerFor(t, options = {}) {
  const root = await project(t), calls = [];
  const runner = createRequestRunner({ root, execute: executor(calls, options), phaseTimeoutMs: options.phaseTimeoutMs });
  t.after(() => runner.close());
  return { root, calls, runner };
}

test('one sentence runs five phases in order, reports each and records real checks', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  const r = await runner.submit({ author: '사장', body: '첫 화면을 간결하게 고쳐줘' });
  await runner.settled();
  const [saved] = await runner.list();
  assert.equal(saved.status, 'completed');
  assert.deepEqual(calls.map((c) => c.phase), PHASES);
  assert.equal(calls[0].thread, undefined);
  assert.equal(calls[1].thread, 'test-thread');
  assert.equal(calls[0].outputSchema.properties.outcome.type, 'string');
  assert.equal(saved.messages.filter((m) => m.role === 'assistant').length, 5);
  assert.equal(saved.owner, undefined); assert.equal(saved.thread, undefined);
  const feature = await getFeature(root, r.id);
  assert.equal(feature.phase, 'done'); assert.equal(feature.proofs.length, 2);
  assert.match(await readFile(join(root, 'docs', 'wax', r.id, 'plan.md'), 'utf8'), /# plan/);
  assert.equal((await listPresence(root)).find((a) => a.author === 'wax-pm').state, 'idle');
});

test('duplicate submission is idempotent and queued requests never execute in parallel', async (t) => {
  let running = 0, peak = 0;
  const { calls, runner } = await runnerFor(t, { before: async () => { peak = Math.max(peak, ++running); await sleep(10); running--; } });
  const input = { id: `request-${randomUUID()}`, author: '사장', body: '오류 수정' };
  const results = await Promise.all([runner.submit(input), runner.submit(input), runner.submit({ author: '사장', body: '다음 요청' })]);
  assert.equal(results[0].id, results[1].id);
  await runner.settled();
  assert.equal((await runner.list()).length, 2); assert.equal(calls.length, 10); assert.equal(peak, 1);
  await assert.rejects(runner.submit({ ...input, body: '다른 내용' }), { status: 409 });
});

test('project creates a workflow first and runs later phases only after that revision is confirmed', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  const r = await runner.submit({ author: '사장', body: '예약 서비스 프로젝트', mode: 'project' });
  await runner.settled();
  let [saved] = await runner.list();
  assert.equal(saved.mode, 'project'); assert.equal(saved.status, 'workflow');
  assert.deepEqual(calls.map((c) => c.phase), ['plan']);
  assert.match(calls[0].prompt, /프로젝트 모드/);
  assert.match(calls[0].prompt, /선행 관계/);
  assert.equal((await getFeature(root, r.id)).completed.plan, undefined);
  assert.equal(saved.workflow.document, (await getFeature(root, r.id)).artifacts.plan);
  await assert.rejects(runner.reply(r.id, { resume: true }), /워크플로우를 확인/);
  await assert.rejects(runner.reply(r.id, { approveWorkflow: true, workflowRevision: saved.workflow.revision + 1 }), { status: 409 });
  const approval = { approveWorkflow: true, workflowRevision: saved.workflow.revision };
  await Promise.all([runner.reply(r.id, approval), runner.reply(r.id, approval)]);
  await runner.settled();
  [saved] = await runner.list();
  assert.equal(saved.status, 'completed'); assert.equal(saved.workflow.started, true);
  assert.deepEqual(calls.map((c) => c.phase), PHASES);
  await runner.reply(r.id, approval); await runner.settled();
  assert.equal(calls.length, 5, 'repeated confirmation never reruns completed work');
});

test('workflow edits require reviewing the rebuilt revision; modes are immutable and legacy requests remain SM', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  const input = { author: '사장', body: '새 프로젝트', mode: 'project' };
  const r = await runner.submit(input); await runner.settled();
  const oldRevision = (await runner.list())[0].workflow.revision;
  await runner.reply(r.id, { body: '결제 기능은 다음으로 미루자' }); await runner.settled();
  const [saved] = await runner.list();
  assert.equal(saved.status, 'workflow'); assert.ok(saved.workflow.revision > oldRevision);
  assert.deepEqual(calls.map((c) => c.phase), ['plan', 'plan']);
  assert.match(calls[1].prompt, /결제 기능은 다음으로/);
  await assert.rejects(runner.reply(r.id, { approveWorkflow: true, workflowRevision: oldRevision }), { status: 409 });
  await assert.rejects(runner.submit({ ...input, id: r.id, mode: 'sm' }), { status: 409 });
  await assert.rejects(runner.submit({ author: '사장', body: '잘못된 모드', mode: 'unknown' }), /진행 모드/);
  const sm = await runner.submit({ author: '사장', body: '로그인 오류 수정', mode: 'sm' }); await runner.settled();
  assert.equal((await runner.list()).find((item) => item.id === sm.id).status, 'completed');
  assert.match(calls[2].prompt, /SM\(유지보수\) 모드/);
  const file = join(root, '.wax', 'chat', 'requests', `${sm.id}.json`);
  const raw = JSON.parse(await readFile(file, 'utf8')); delete raw.mode; await writeFile(file, JSON.stringify(raw));
  assert.equal((await runner.list()).find((item) => item.id === sm.id).mode, 'sm');
});

test('project workflow survives dashboard restart and a plan saved elsewhere is shown for review before it runs', async (t) => {
  const { root, runner } = await runnerFor(t);
  const r = await runner.submit({ author: '사장', body: '새 서비스 만들기', mode: 'project' }); await runner.settled();
  const [saved] = await runner.list(); await runner.close();
  const calls = [], reopened = createRequestRunner({ root, execute: executor(calls) });
  t.after(() => reopened.close());
  assert.equal((await reopened.list())[0].status, 'workflow'); assert.equal(calls.length, 0);
  const feature = await getFeature(root, r.id);
  await updateFeature(root, r.id, 'save', { phase: 'plan', content: '# 직접 고친 워크플로우', revision: feature.revision });
  await reopened.reply(r.id, { approveWorkflow: true, workflowRevision: saved.workflow.revision }); await reopened.settled();
  const [review] = await reopened.list();
  assert.equal(review.status, 'workflow'); assert.equal(review.workflow.approved, false);
  assert.equal(review.workflow.document, '# 직접 고친 워크플로우');
  assert.equal(calls.length, 0, 'an old confirmation must not run a changed plan');
  assert.equal((await getFeature(root, r.id)).phase, 'plan');
  await reopened.reply(r.id, { approveWorkflow: true, workflowRevision: review.workflow.revision }); await reopened.settled();
  assert.equal((await reopened.list())[0].status, 'completed');
  assert.deepEqual(calls.map((c) => c.phase), PHASES.slice(1));
  assert.equal((await getFeature(root, r.id)).artifacts.plan, '# 직접 고친 워크플로우', 'the reviewed manual plan is kept');
});

test('evidence, title edits and evidence racing the start keep a reviewed workflow startable', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  const r = await runner.submit({ author: '사장', body: '예약 서비스', mode: 'project' }); await runner.settled();
  const [saved] = await runner.list();
  let feature = await getFeature(root, r.id);
  assert.equal((await runTestProof(root, r.id, [process.execPath, '-e', ''], { revision: feature.revision })).recorded, true);
  feature = await getFeature(root, r.id);
  await updateFeature(root, r.id, 'edit', { title: '바뀐 제목', description: feature.description, revision: feature.revision });
  await runner.reply(r.id, { approveWorkflow: true, workflowRevision: saved.workflow.revision }); await runner.settled();
  assert.equal((await runner.list())[0].status, 'completed');
  assert.deepEqual(calls.map((c) => c.phase), PHASES);
});

test('evidence attached between claiming the start and completing the plan is retried, not blocked', async (t) => {
  const root = await project(t), calls = [], id = `request-${randomUUID()}`;
  let raced = false;
  const runner = createRequestRunner({ root, execute: executor(calls), notify: () => {
    if (raced) return;
    const r = JSON.parse(readFileSync(join(root, '.wax', 'chat', 'requests', `${id}.json`), 'utf8'));
    if (!r.workflow?.starting) return;
    raced = true;
    const file = join(root, '.wax', 'features', `${id}.json`), feature = JSON.parse(readFileSync(file, 'utf8'));
    feature.revision += 1; feature.history.push({ action: 'attach-evidence', phase: 'plan', at: new Date().toISOString() });
    writeFileSync(file, JSON.stringify(feature));
  } });
  t.after(() => runner.close());
  await runner.submit({ id, author: '사장', body: '예약 서비스', mode: 'project' }); await runner.settled();
  const [saved] = await runner.list();
  await runner.reply(id, { approveWorkflow: true, workflowRevision: saved.workflow.revision }); await runner.settled();
  assert.equal(raced, true);
  const [done] = await runner.list();
  assert.equal(done.status, 'completed', done.detail); assert.equal(done.workflow.starting, undefined);
  assert.deepEqual(calls.map((c) => c.phase), PHASES);
});

test('a lost start record resumes from design only when the completed plan is exactly the approved one', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  const approveWithoutStart = async (id) => {
    const file = join(root, '.wax', 'chat', 'requests', `${id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.workflow.approved = true; raw.status = 'blocked';
    await writeFile(file, JSON.stringify(raw));
    return raw.workflow;
  };
  const r = await runner.submit({ author: '사장', body: '예약 서비스', mode: 'project' }); await runner.settled();
  const workflow = await approveWithoutStart(r.id);
  let feature = await getFeature(root, r.id);
  await updateFeature(root, r.id, 'complete', { phase: 'plan', evidence: workflow.evidence, proofIds: workflow.proofIds, revision: feature.revision });
  await runner.reply(r.id, { resume: true }); await runner.settled();
  assert.equal((await runner.list())[0].status, 'completed');
  assert.deepEqual(calls.map((c) => c.phase), PHASES);

  const other = await runner.submit({ author: '사장', body: '관리 화면', mode: 'project' }); await runner.settled();
  const approved = await approveWithoutStart(other.id);
  feature = await getFeature(root, other.id);
  feature = await updateFeature(root, other.id, 'save', { phase: 'plan', content: '# 다른 세션이 바꾼 계획', revision: feature.revision });
  await updateFeature(root, other.id, 'complete', { phase: 'plan', evidence: approved.evidence, revision: feature.revision });
  await runner.reply(other.id, { resume: true }); await runner.settled();
  const blocked = (await runner.list()).find((item) => item.id === other.id);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.newRequest, true); assert.match(blocked.detail, /새 프로젝트 요청/);
  await assert.rejects(runner.reply(other.id, { resume: true }), { status: 409 });
  await assert.rejects(runner.reply(other.id, { body: '다시 해줘' }), /새 프로젝트 요청/);
  assert.equal(calls.length, 6, 'a plan changed by another session never runs without a new review');
});

test('a correction sent right after approval rewrites the workflow instead of failing the start', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  const r = await runner.submit({ author: '사장', body: '예약 서비스', mode: 'project' }); await runner.settled();
  const [saved] = await runner.list();
  await withLock(join(root, '.wax', 'chat', 'presence.json.lock'), async () => {
    await runner.reply(r.id, { approveWorkflow: true, workflowRevision: saved.workflow.revision });
    await sleep(200);
    await runner.reply(r.id, { body: '결제는 빼줘' });
  });
  await runner.settled();
  const [rewritten] = await runner.list();
  assert.equal(rewritten.status, 'workflow'); assert.equal(rewritten.workflow.approved, false);
  assert.deepEqual(calls.map((c) => c.phase), ['plan', 'plan']);
  assert.match(calls[1].prompt, /결제는 빼줘/);
  assert.equal((await getFeature(root, r.id)).phase, 'plan');
});

test('approving while the plan job is still finishing starts once that job is done instead of pausing', async (t) => {
  const root = await project(t), calls = [], id = `request-${randomUUID()}`;
  let runner, approval;
  runner = createRequestRunner({ root, execute: executor(calls), notify: () => {
    if (approval) return;
    const r = JSON.parse(readFileSync(join(root, '.wax', 'chat', 'requests', `${id}.json`), 'utf8'));
    if (r.status === 'workflow') approval = runner.reply(id, { approveWorkflow: true, workflowRevision: r.workflow.revision }).then(() => 'approved', (error) => error.status);
  } });
  t.after(() => runner.close());
  const r = await runner.submit({ id, author: '사장', body: '예약 서비스', mode: 'project' });
  await runner.settled();
  assert.equal(await approval, 'approved');
  await runner.settled();
  assert.equal((await runner.list())[0].status, 'completed');
  assert.deepEqual(calls.map((c) => c.phase), PHASES);
});

test('input arriving while a project workflow is being written is included before confirmation', async (t) => {
  let added = false;
  const { calls, runner } = await runnerFor(t, { before: async (root, input, feature) => {
    if (!added) { added = true; await runner.reply(feature.id, { body: '모바일 화면도 범위에 포함해줘' }); }
  } });
  await runner.submit({ author: '사장', body: '예약 서비스를 만들자', mode: 'project' });
  await until(async () => (await runner.list())[0].status === 'workflow');
  await runner.settled();
  assert.deepEqual(calls.map((c) => c.phase), ['plan', 'plan']);
  assert.match(calls[1].prompt, /모바일 화면도/);
  assert.equal((await runner.list())[0].workflow.approved, false);
});

test('questions pause and a chat answer resumes the same phase', async (t) => {
  const root = await project(t), calls = [];
  let asked = false;
  const complete = executor(calls);
  const runner = createRequestRunner({ root, execute: async (...args) => {
    if (!asked) { asked = true; return response('plan', { outcome: 'question', report: '관리자만 사용할 기능인가요?' }); }
    return complete(...args);
  } });
  t.after(() => runner.close());
  const request = await runner.submit({ author: '사장', body: '설정 화면 추가' });
  await runner.settled();
  assert.equal((await runner.list())[0].status, 'question');
  assert.equal((await getFeature(root, request.id)).phase, 'plan');
  await runner.reply(request.id, { body: '관리자만 사용해' }); await runner.settled();
  assert.match(calls[0].prompt, /관리자만 사용해/);
  assert.equal((await runner.list())[0].status, 'completed');
});

test('missing proof, failed connection and malformed output block with a visible reason', async (t) => {
  const { root, runner } = await runnerFor(t, { noProof: true });
  const r = await runner.submit({ author: '사장', body: '오류 수정' }); await runner.settled();
  assert.equal((await getFeature(root, r.id)).phase, 'implement');
  assert.match((await runner.list())[0].detail, /테스트 근거/);
  for (const execute of [async () => { throw new Error('Codex 로그인 필요'); }, async () => ({ message: 'invalid' })]) {
    const isolated = await project(t), other = createRequestRunner({ root: isolated, execute });
    t.after(() => other.close());
    await other.submit({ author: '사장', body: '작업' }); await other.settled();
    assert.equal((await other.list())[0].status, 'blocked');
    assert.ok((await other.list())[0].detail.length > 5);
  }
});

test('stop aborts execution, timeout pauses, and stale requests do not silently restart', async (t) => {
  for (const timeout of [false, true]) {
    const { root, runner } = await runnerFor(t, { phaseTimeoutMs: timeout ? 80 : 5000, before: async (root, { signal }) => {
      await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }); });
    } });
    const r = await runner.submit({ author: '사장', body: '긴 작업' });
    await until(async () => (await runner.list())[0].status === 'running');
    if (!timeout) await runner.stop(r.id);
    await runner.settled();
    assert.equal((await runner.list())[0].status, 'paused');
    assert.equal((await getFeature(root, r.id)).phase, 'plan');
  }
  const root = await project(t), calls = [], runner = createRequestRunner({ root, execute: executor(calls) });
  const r = await runner.submit({ author: '사장', body: '저장된 작업' }); await runner.settled(); await runner.close();
  const file = join(root, '.wax', 'chat', 'requests', `${r.id}.json`);
  const raw = JSON.parse(await readFile(file)); raw.status = 'running'; raw.owner.pid = 2147483647; await writeFile(file, JSON.stringify(raw));
  const reopened = createRequestRunner({ root, execute: async () => { throw new Error('must not run'); } });
  t.after(() => reopened.close());
  assert.equal((await reopened.list())[0].status, 'paused');
  assert.equal(calls.length, 5);
});

test('a concurrent workflow edit cannot be overwritten or reported as completed', async (t) => {
  const { root, runner } = await runnerFor(t, { before: async (root, input, f) => {
    await updateFeature(root, f.id, 'edit', { title: '다른 세션이 변경', description: f.description, revision: f.revision });
  } });
  const r = await runner.submit({ author: '사장', body: '변경 충돌' }); await runner.settled();
  const feature = await getFeature(root, r.id);
  assert.equal(feature.phase, 'plan'); assert.equal(feature.title, '다른 세션이 변경');
  assert.match((await runner.list())[0].detail, /다른 세션/);
});

test('follow-up delivery is idempotent and completed work keeps its previous iteration', async (t) => {
  const { root, runner, calls } = await runnerFor(t);
  const r = await runner.submit({ author: '사장', body: '화면을 만들어줘' }); await runner.settled();
  const reply = { body: '버튼 색상을 변경해줘', messageId: randomUUID() };
  await runner.reply(r.id, reply); await runner.settled();
  assert.deepEqual(calls.map((c) => c.phase), [...PHASES, 'implement', 'review', 'report']);
  const feature = await getFeature(root, r.id);
  assert.equal(feature.iteration, 1); assert.equal(feature.history.filter((e) => e.action === 'archive').length, 1);
  await runner.reply(r.id, reply); await runner.settled();
  assert.equal(calls.length, 8);
  assert.equal((await runner.list())[0].messages.filter((m) => m.text === reply.body).length, 1);
});

test('a run waits for another dashboard that is only finishing its cleanup instead of blocking', async (t) => {
  const { root, calls, runner } = await runnerFor(t);
  await runner.submit({ author: '사장', body: '준비 요청' }); await runner.settled();
  await withLock(join(root, '.wax', 'chat', 'requests', 'runner.lock'), async () => {
    await runner.submit({ author: '사장', body: '정리 중에 들어온 요청' });
    await sleep(1500);
  });
  await runner.settled();
  const late = (await runner.list()).find((item) => item.title === '정리 중에 들어온 요청');
  assert.equal(late.status, 'completed', late.detail);
  assert.equal(calls.length, 10);
});

test('separate dashboards cannot run agents concurrently in one project', async (t) => {
  const root = await project(t);
  let running = false, secondRan = false;
  const first = createRequestRunner({ root, execute: async (root, { signal }) => {
    running = true;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stop')), { once: true }));
  } });
  const second = createRequestRunner({ root, execute: async () => { secondRan = true; return response('plan'); } });
  t.after(async () => { await first.close(); await second.close(); });
  const r = await first.submit({ author: '사장', body: '첫 요청' }); await until(() => running);
  await second.submit({ author: '사장', body: '두 번째 창 요청' }); await second.settled();
  assert.equal(secondRan, false);
  assert.equal((await second.list()).find((item) => item.title === '두 번째 창 요청').status, 'blocked');
  await first.stop(r.id); await first.settled();
});

test('request API is token protected, plain chat stays passive, homepage and detail screen load', async (t) => {
  const root = await project(t), calls = [];
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, executeRequest: executor(calls) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, token = config.token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify(body) });
  assert.match(await (await fetch(base)).text(), /무엇을 할까요/);
  assert.match(await (await fetch(base + '/manage')).text(), /assign-to/);
  assert.equal((await post('/api/requests', { body: '실행' }, 'wrong')).status, 403);
  await fetch(base + '/api/requests');
  await post('/api/channels/general/messages', { body: '일반 대화' });
  assert.equal(calls.length, 0);
  const created = await post('/api/requests', { body: '실행해줘' });
  assert.equal(created.status, 202); const request = await created.json();
  await server.requests.settled();
  assert.equal(calls.length, 5);
  assert.equal((await post(`/api/requests/${request.id}/reply`, { resume: true })).status, 400);
});

test('Codex structured report uses authoritative final item and sends schema without permission overrides', async (t) => {
  const root = await project(t), fake = join(root, 'fake.js');
  await writeFile(fake, `const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start') {
  if(!m.params.outputSchema || m.params.approvalPolicy || m.params.sandboxPolicy) process.exit(2);
  send({id:m.id,result:{turn:{id:'turn'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',delta:'partial'}});
  send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'reply',type:'agentMessage',text:'{"ok":true}'}}});
  send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});`);
  const result = await runCodexSession(root, { executable: fake, prompt: 'test', outputSchema: { type: 'object' }, output() {}, log() {} });
  assert.deepEqual(JSON.parse(result.message), { ok: true });
});

test('early Codex startup failures explain the home/profile issue without exposing raw diagnostics', async (t) => {
  const root = await project(t), fake = join(root, 'bad-profile.js');
  await writeFile(fake, "process.stderr.write('Error: Could not find home directory\\n'); process.exit(1);");
  await assert.rejects(runCodexSession(root, { executable: fake, prompt: 'test', output() {}, log() {} }), /사용자 홈 폴더.*다시 설치할 필요는 없습니다/);
  assert.match(codexExitMessage(1, '401 Unauthorized'), /codex login/);
  assert.match(codexExitMessage(1, 'Access is denied'), /접근/);
  assert.doesNotMatch(codexExitMessage(1, 'unexpected secret=abc'), /secret=abc/);
});
