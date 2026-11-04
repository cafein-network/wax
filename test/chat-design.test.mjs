import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { project } from './chat-helpers.mjs';
import { parseFigmaUrl, saveTarget, checkTarget, createDesignRunner, designHandoffs, readProbe } from '../src/chat/design.mjs';
import { parseClaudeMcpList, pickServer, designSupport } from '../src/chat/design-mcp.mjs';
import { requestPrompt } from '../src/chat/requests.mjs';
import { handleCodexApproval } from '../src/approval-hosts.mjs';
import { listApprovals, decideApproval } from '../src/approvals.mjs';
import { withLock } from '../src/chat/lock.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a50000000049454e44ae426082', 'hex');
const FIGMA = 'https://www.figma.com/design/AbCdEfGhIjKl123/Lookbook?node-id=12-34&t=SECRETshareToken';
const until = async (check) => { for (let i = 0; i < 250; i++) { const value = await check(); if (value) return value; await sleep(20); } throw new Error('condition timed out'); };
const text = (value) => ({ isError: false, content: [{ type: 'text', text: value }] });

function codex(state) {
  return async () => ({
    async servers() { return state.servers; },
    async call(server, tool, args) { state.calls.push({ server, tool, args }); return state.handlers[tool](args); },
    close() { state.closed = (state.closed ?? 0) + 1; },
  });
}
const figmaServer = (tools = ['get_metadata', 'get_screenshot', 'use_figma']) => ({ name: 'figma', runtime: 'connected', auth: 'oAuth', tools,
  schemas: { get_metadata: ['fileKey', 'nodeId'], get_screenshot: ['fileKey', 'nodeId'] } });
function figmaState() {
  return { servers: [figmaServer()], calls: [], handlers: {
    get_metadata: () => text('<frame id="12:34" name="Upload" />'),
    get_screenshot: () => ({ isError: false, content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] }),
  } };
}
const reply = (fields) => ({ threadId: 'design-thread', message: JSON.stringify({ outcome: 'complete', report: '만들었습니다', changes: '업로드 영역 추가', nodeId: '', objects: [], render: '', exported: '', ...fields }) });

test('Figma links keep only the file and the selected frame, and Blender targets stay inside the project', async (t) => {
  assert.deepEqual(parseFigmaUrl(FIGMA), { fileKey: 'AbCdEfGhIjKl123', nodeId: '12:34', url: 'https://www.figma.com/design/AbCdEfGhIjKl123/?node-id=12-34' });
  assert.throws(() => parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKl123/Lookbook'), /node-id/);
  assert.throws(() => parseFigmaUrl('https://evil.example/design/AbCdEfGhIjKl123/?node-id=1-2'), /figma\.com/);
  const root = await project(t);
  for (const file of ['/tmp/x.blend', '../x.blend', 'design/x.obj']) await assert.rejects(saveTarget(root, { tool: 'blender', file, scene: 'Scene', collection: 'WAX' }), /\.blend/);
  const target = await saveTarget(root, { tool: 'figma', url: FIGMA, label: '룩북 업로드' });
  assert.doesNotMatch(JSON.stringify(target), /SECRET/);
  await assert.rejects(saveTarget(root, { tool: 'figma', url: FIGMA }), { status: 409 });
});

test('connection checks report what the real session answered and never call a missing or unchecked tool connected', async (t) => {
  const root = await project(t);
  const figma = await saveTarget(root, { tool: 'figma', url: FIGMA });
  const none = { servers: [{ name: 'blender', runtime: 'connected', tools: [], schemas: {} }], calls: [], handlers: {} };
  let { check } = await checkTarget(root, figma.id, 'codex', { codex: codex(none) });
  assert.equal(check.state, 'not-configured'); assert.match(check.next, /codex mcp add figma --url https:\/\/mcp\.figma\.com\/mcp/);
  ({ check } = await checkTarget(root, figma.id, 'codex', { codex: codex({ servers: [{ ...figmaServer(), runtime: 'authenticationRequired', auth: 'notLoggedIn' }], calls: [], handlers: {} }) }));
  assert.equal(check.state, 'auth-required'); assert.match(check.next, /codex mcp login figma/);
  const denied = figmaState(); denied.handlers.get_metadata = () => ({ isError: true, content: [{ type: 'text', text: 'HTTP 403 forbidden Bearer abc.def.secret' }] });
  ({ check } = await checkTarget(root, figma.id, 'codex', { codex: codex(denied) }));
  assert.equal(check.state, 'error'); assert.doesNotMatch(JSON.stringify(check), /abc\.def\.secret/);
  const readOnly = figmaState(); readOnly.servers = [figmaServer(['get_metadata', 'get_screenshot'])];
  ({ check } = await checkTarget(root, figma.id, 'codex', { codex: codex(readOnly) }));
  assert.equal(check.state, 'read-only'); assert.match(check.next, /mcp\.figma\.com/);
  const ok = figmaState();
  ({ check } = await checkTarget(root, figma.id, 'codex', { codex: codex(ok) }));
  assert.equal(check.state, 'read-write'); assert.deepEqual(ok.calls[0].args, { fileKey: 'AbCdEfGhIjKl123', nodeId: '12:34' });
  assert.equal(ok.closed, 1, 'the check session is closed');
  ({ check } = await checkTarget(root, figma.id, 'claude', { claudeList: async () => { throw new Error('must not be asked'); } }));
  assert.equal(check.state, 'unsupported'); assert.match(check.next, /Codex/);
  ({ check } = await checkTarget(root, figma.id, 'gemini'));
  assert.equal(check.state, 'unsupported');
  assert.equal(designSupport('copilot', 'blender').ok, false);
});

test('Blender checks confirm the open file before anything changes, and a different project file is a mismatch', async (t) => {
  const root = await project(t);
  await mkdir(join(root, 'design'), { recursive: true }); await writeFile(join(root, 'design', 'prop.blend'), 'BLENDER');
  const target = await saveTarget(root, { tool: 'blender', file: 'design/prop.blend', scene: 'Scene', collection: 'WAX_Prop' });
  const state = { servers: [{ name: 'blender', runtime: 'connected', tools: ['execute_blender_code', 'get_scene_info'], schemas: {} }], calls: [], handlers: {
    execute_blender_code: () => text(`WAX_PROBE ${JSON.stringify({ file: '/Users/someone/other-project/trebuchet.blend', dirty: true, scene: true, collection: false, objects: [] })}`),
  } };
  let { check } = await checkTarget(root, target.id, 'codex', { codex: codex(state) });
  assert.equal(check.state, 'target-mismatch'); assert.match(check.detail, /trebuchet\.blend/); assert.match(check.next, /design\/prop\.blend/);
  assert.match(state.calls[0].args.code, /bpy\.data\.filepath/); assert.doesNotMatch(state.calls[0].args.code, /\.save|remove|new\(/, 'the probe only reads');
  state.handlers.execute_blender_code = () => text(`WAX_PROBE ${JSON.stringify({ file: join(root, 'design', 'prop.blend'), dirty: false, scene: true, collection: false, objects: [] })}`);
  ({ check } = await checkTarget(root, target.id, 'codex', { codex: codex(state) }));
  assert.equal(check.state, 'read-write'); assert.match(check.detail, /첫 제작 때 만듭니다/);
  ({ check } = await checkTarget(root, target.id, 'claude', { claudeList: async () => parseClaudeMcpList('blender: uvx blender-mcp - ✗ Failed to connect\n') }));
  assert.equal(check.state, 'error');
  ({ check } = await checkTarget(root, target.id, 'claude', { claudeList: async () => parseClaudeMcpList('Checking MCP server health…\n\nblender: uvx blender-mcp - ✔ Connected\n') }));
  assert.equal(check.state, 'connected'); assert.match(check.detail, /제작 세션에서 확인/);
  assert.deepEqual(readProbe('noise\nWAX_PROBE {"file":"a"}'), { file: 'a' }); assert.equal(readProbe('Traceback: error'), null);
  assert.equal(pickServer(['figma-desktop', 'figma'], 'figma'), 'figma');
  assert.equal(pickServer(['blender'], 'blender', 'missing'), null);
});

async function figmaJob(t, { execute, state = figmaState() } = {}) {
  const root = await project(t), calls = [];
  const target = await saveTarget(root, { tool: 'figma', url: FIGMA, label: '룩북 업로드 화면' });
  const runner = createDesignRunner({ root, mcp: { codex: codex(state) }, execute: execute ?? (async (r, input) => { calls.push(input); return reply({ nodeId: '12:99' }); }) });
  t.after(() => runner.close());
  return { root, target, runner, calls, state };
}

test('a design job needs a passing check, keeps one open job per target and makes v1 only from a received Figma image', async (t) => {
  const { root, target, runner, calls, state } = await figmaJob(t);
  const input = { targetId: target.id, agent: 'codex', title: '룩북 업로드 화면', brief: '상품 사진을 올리는 첫 화면', clientId: randomUUID(), feature: 'lookbook-upload' };
  await assert.rejects(runner.submit(input), { status: 409 }, 'no check yet');
  await runner.check(target.id, 'codex');
  const job = await runner.submit(input);
  assert.equal((await runner.submit(input)).id, job.id, 'a resent request is the same job');
  await assert.rejects(runner.submit({ ...input, clientId: randomUUID() }), /진행 중인 디자인 작업/);
  await runner.settled();
  const [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'review'); assert.equal(saved.versions.length, 1);
  assert.deepEqual(saved.versions[0].source, { fileKey: 'AbCdEfGhIjKl123', nodeId: '12:99', url: 'https://www.figma.com/design/AbCdEfGhIjKl123/?node-id=12-34' });
  assert.deepEqual(await readFile(join(root, saved.versions[0].preview)), PNG);
  assert.equal(state.calls.at(-1).tool, 'get_screenshot'); assert.deepEqual(state.calls.at(-1).args, { fileKey: 'AbCdEfGhIjKl123', nodeId: '12:99' });
  assert.match(calls[0].prompt, /대상 프레임 안에 이번 결과 프레임 하나를 만들고/);
  assert.equal(calls[0].tool, 'codex'); assert.equal(saved.owner, undefined); assert.equal(saved.thread, undefined);
});

test('feedback continues the same frame to the next version, stale clicks are refused and the approved version is handed off', async (t) => {
  const { root, target, runner, calls } = await figmaJob(t);
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '룩북 업로드 화면', brief: '상품 사진 업로드', feature: 'lookbook-upload' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  await assert.rejects(runner.feedback(job.id, { version: 1, revision: saved.revision - 1, text: '버튼을 키워 주세요' }), { status: 409 });
  await assert.rejects(runner.approve(job.id, { version: 0, revision: saved.revision }), { status: 409 });
  const note = { version: 1, revision: saved.revision, text: '업로드 버튼을 더 크게, 실패 안내를 위로', clientId: randomUUID() };
  await Promise.all([runner.feedback(job.id, note), runner.feedback(job.id, note)]);
  await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.versions.length, 2); assert.equal(saved.feedback.length, 1, 'a double click is one opinion');
  assert.equal(saved.versions[1].source.nodeId, '12:99'); assert.equal(saved.versions[1].feedback, note.clientId);
  assert.match(calls[1].prompt, /이전 버전 결과 프레임 12:99를 같은 노드에서 고치세요/); assert.match(calls[1].prompt, /업로드 버튼을 더 크게/);
  assert.equal(calls[1].thread, 'design-thread');
  await assert.rejects(runner.handoff(job.id, { version: 2, revision: saved.revision }), /확정한 버전만/);
  await assert.rejects(runner.approve(job.id, { version: 1, revision: saved.revision }), { status: 409 }, 'an older version cannot be approved');
  saved = await runner.approve(job.id, { version: 2, revision: saved.revision, author: '대표' });
  await assert.rejects(runner.feedback(job.id, { version: 2, revision: saved.revision, text: '다시' }), /새 디자인 작업/);
  saved = await runner.handoff(job.id, { version: 2, revision: saved.revision });
  assert.equal(saved.status, 'handed-off'); assert.equal(saved.handoff.version, 2);
  const doc = await readFile(join(root, saved.handoff.doc), 'utf8');
  assert.match(doc, /확정 버전: v2/); assert.match(doc, /node-id=12-99/); assert.match(doc, /업로드 버튼을 더 크게/);
  assert.deepEqual(await readFile(join(root, saved.handoff.preview)), PNG);
  const handoffs = await designHandoffs(root, 'lookbook-upload');
  assert.deepEqual(handoffs.map((h) => h.version), [2]);
  assert.match(requestPrompt({ mode: 'project', messages: [{ role: 'user', text: '구현' }], root, handoffs }, { id: 'lookbook-upload', phase: 'implement', projectType: 'lookbook', workMode: 'project', title: 'x', description: '', artifacts: {}, completed: {}, history: [], proofs: [], iteration: 1, revision: 1 }), /확정해 인계한 디자인/);
  assert.equal((await runner.handoff(job.id, { version: 2, revision: saved.revision })).handoff.at, saved.handoff.at, 'a resent handoff changes nothing');
});

test('no version without real results: a different frame, a blocked report or a dropped connection leave a visible next step', async (t) => {
  let answer = reply({ nodeId: '12:99' });
  const { target, runner, state } = await figmaJob(t, { execute: async () => answer });
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '업로드', brief: '첫 화면' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  answer = reply({ nodeId: '55:1' });
  await runner.feedback(job.id, { version: 1, revision: saved.revision, text: '색을 밝게' });
  await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'failed'); assert.equal(saved.versions.length, 1); assert.match(saved.detail, /다른 프레임/);
  answer = { threadId: 't', message: JSON.stringify({ outcome: 'blocked', report: '이 파일의 편집 권한이 없습니다. 파일 소유자에게 편집 권한을 요청하세요.', changes: '', nodeId: '', objects: [], render: '', exported: '' }) };
  await runner.resume(job.id); await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'blocked'); assert.match(saved.detail, /편집 권한/); assert.equal(saved.versions.length, 1);
  state.servers = [{ ...figmaServer(), runtime: 'failed' }];
  await runner.resume(job.id); await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'failed'); assert.match(saved.detail, /다시 검사/);
  state.servers = [figmaServer()]; state.handlers.get_screenshot = () => ({ isError: true, content: [{ type: 'text', text: 'node not found' }] });
  answer = reply({ nodeId: '12:99' });
  await runner.resume(job.id); await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'failed'); assert.match(saved.detail, /화면을 받지 못했습니다/); assert.equal(saved.versions.length, 1);
});

test('stop ends a long production without holding the job, and resume continues with the saved feedback', async (t) => {
  let release, started = 0;
  const { target, runner } = await figmaJob(t, { execute: async (r, { signal }) => {
    started++;
    if (started === 1) await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); });
    return reply({ nodeId: '12:99' });
  } });
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '업로드', brief: '첫 화면' });
  await until(async () => (await runner.list()).jobs[0].status === 'producing');
  const stoppedJob = await runner.stop(job.id);
  assert.equal(stoppedJob.status, 'stopped');
  await runner.settled();
  assert.equal((await runner.list()).jobs[0].status, 'stopped'); assert.equal((await runner.list()).jobs[0].versions.length, 0);
  await runner.resume(job.id); await runner.settled();
  const [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'review'); assert.equal(saved.versions[0].n, 1); assert.equal(started, 2);
  assert.equal(typeof release, 'function');
});

test('Blender versions need the render and the target collection read back from the open file', async (t) => {
  const root = await project(t);
  await mkdir(join(root, 'design'), { recursive: true }); await writeFile(join(root, 'design', 'prop.blend'), 'BLENDER');
  const target = await saveTarget(root, { tool: 'blender', file: 'design/prop.blend', scene: 'Scene', collection: 'WAX_Prop' });
  let open = join(root, 'design', 'prop.blend'), objects = [];
  const state = { servers: [{ name: 'blender', runtime: 'connected', tools: ['execute_blender_code'], schemas: {} }], calls: [], handlers: {
    execute_blender_code: () => text(`WAX_PROBE ${JSON.stringify({ file: open, dirty: false, scene: true, collection: objects.length > 0, objects })}`),
  } };
  const prompts = [];
  const runner = createDesignRunner({ root, mcp: { codex: codex(state) }, execute: async (r, { prompt }) => {
    prompts.push(prompt);
    const render = /(\S+v\d+-[a-f0-9]{8}-render\.png)/.exec(prompt)[1], exported = /(\S+v\d+-[a-f0-9]{8}\.glb)/.exec(prompt)[1];
    await writeFile(render, PNG); await writeFile(exported, 'glTF');
    objects = ['Upload_Stand'];
    return reply({ objects: ['Upload_Stand'], render, exported });
  } });
  t.after(() => runner.close());
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '업로드 받침대 소품', brief: '룩북 업로드 화면에 쓸 받침대' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'review', saved.detail);
  assert.deepEqual(saved.versions[0].source.objects, ['Upload_Stand']); assert.match(saved.versions[0].source.exported, /v1-[a-f0-9]{8}\.glb$/);
  assert.match(prompts[0], /다른 파일이 열려 있으면 아무것도 바꾸지 말고/); assert.match(prompts[0], /컬렉션 WAX_Prop 안에서만/);
  saved = await runner.approve(job.id, { version: 1, revision: saved.revision });
  saved = await runner.handoff(job.id, { version: 1, revision: saved.revision });
  assert.equal(saved.handoff.assets.length, 1); assert.match(await readFile(join(root, saved.handoff.doc), 'utf8'), /Upload_Stand/);
  const second = await saveTarget(root, { tool: 'blender', file: 'design/prop.blend', scene: 'Scene', collection: 'WAX_Other' });
  await runner.check(second.id, 'codex');
  open = '/Users/someone/other-project/trebuchet.blend';
  await runner.submit({ targetId: second.id, title: '다른 소품', brief: '두 번째' });
  await runner.settled();
  const other = (await runner.list()).jobs.find((j) => j.targetId === second.id);
  assert.equal(other.status, 'failed'); assert.match(other.detail, /trebuchet\.blend/); assert.equal(prompts.length, 1, 'no agent run against another file');
});

test('Codex MCP tool confirmations go to the wax approval card; forms that want data stay in Codex', async (t) => {
  const root = await project(t);
  const message = { id: 77, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: null, serverName: 'figma', mode: 'form', message: 'Allow use_figma to edit the file?', requestedSchema: { type: 'object', properties: {} } } };
  const replies = [];
  const waiting = handleCodexApproval(root, message, { emit: async (r) => replies.push(r) });
  const request = await until(async () => (await listApprovals(root)).requests.find((r) => r.status === 'pending'));
  assert.match(request.action, /MCP 도구 실행 \(figma\)/);
  await decideApproval(root, request.id, { decision: 'allow', fingerprint: request.fingerprint, actor: '대표' });
  await waiting;
  assert.deepEqual(replies, [{ id: 77, result: { action: 'accept', content: {} } }]);
  await assert.rejects(handleCodexApproval(root, { ...message, id: 78, params: { ...message.params, requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } } }, { emit() {} }), /입력값이 필요한/);
});

test('design API: token protected writes, the full round trip over HTTP and previews served as images only', async (t) => {
  const { createChatServer } = await import('../src/chat/server.mjs');
  const root = await project(t), state = figmaState();
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, designMcp: { codex: codex(state) }, executeDesign: async () => reply({ nodeId: '12:99' }) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = async (path, body, auth = token) => { const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': auth }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  assert.equal((await post('/api/design/targets', { tool: 'figma', url: FIGMA }, 'wrong')).status, 403);
  const target = (await post('/api/design/targets', { tool: 'figma', url: FIGMA, label: '룩북 업로드' })).body;
  assert.equal((await post(`/api/design/targets/${target.id}/check`, { agent: 'codex' })).body.check.state, 'read-write');
  const job = (await post('/api/design/jobs', { targetId: target.id, agent: 'codex', title: '업로드 화면', brief: '상품 사진 업로드', clientId: randomUUID() })).body;
  await server.design.settled();
  let saved = (await (await fetch(`${base}/api/design`)).json()).jobs[0];
  assert.equal(saved.status, 'review'); assert.equal(saved.author, '대표');
  const image = await fetch(`${base}/api/design/jobs/${job.id}/versions/1/preview`);
  assert.equal(image.headers.get('content-type'), 'image/png'); assert.match(image.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await fetch(`${base}/api/design/jobs/${job.id}/versions/2/preview`)).status, 404);
  saved = (await post(`/api/design/jobs/${job.id}/approve`, { version: 1, revision: saved.revision })).body;
  saved = (await post(`/api/design/jobs/${job.id}/handoff`, { version: 1, revision: saved.revision })).body;
  assert.equal(saved.status, 'handed-off'); assert.match(saved.handoff.doc, /^docs\/wax\/design\//);
});

test('a production whose dashboard process died shows as stopped and resumes in the new dashboard', async (t) => {
  const { root, target, runner } = await figmaJob(t);
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '업로드', brief: '첫 화면' });
  await runner.settled();
  const file = join(root, '.wax', 'design', 'jobs', `${job.id}.json`);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(raw, { status: 'producing', owner: { pid: 2147483646, instance: 'gone' } });
  await writeFile(file, JSON.stringify(raw));
  const [shown] = (await runner.list()).jobs;
  assert.equal(shown.status, 'stopped'); assert.match(shown.detail, /연결이 끊겼습니다/);
  await runner.resume(job.id); await runner.settled();
  const [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'review'); assert.equal(saved.versions.length, 2, 'the interrupted version is produced again');
});

async function blenderJob(t, execute) {
  const root = await project(t);
  await mkdir(join(root, 'design'), { recursive: true });
  for (const name of ['a.blend', 'b.blend']) await writeFile(join(root, 'design', name), 'BLENDER');
  const target = await saveTarget(root, { tool: 'blender', file: 'design/a.blend', scene: 'Scene', collection: 'WAX_Prop' });
  const state = { open: join(root, 'design', 'a.blend'), servers: [{ name: 'blender', runtime: 'connected', tools: ['execute_blender_code'], schemas: {} }], calls: [], handlers: {} };
  state.handlers.execute_blender_code = () => text(`WAX_PROBE ${JSON.stringify({ file: state.open, dirty: false, scene: true, collection: true, objects: ['Stand'] })}`);
  const prompts = [];
  const runner = createDesignRunner({ root, mcp: { codex: codex(state) }, execute: async (r, input) => { prompts.push(input.prompt); return execute(input.prompt, prompts.length); } });
  t.after(() => runner.close());
  await runner.check(target.id, 'codex');
  return { root, target, runner, state, prompts };
}
const paths = (prompt) => ({ render: /(\S+v\d+-[a-f0-9]{8}-render\.png)/.exec(prompt)[1], exported: /(\S+v\d+-[a-f0-9]{8}\.glb)/.exec(prompt)[1] });

test('a job stays on the file it started with: target edits are refused while it is open and a moved target stops the next run', async (t) => {
  const { root, target, runner, state, prompts } = await blenderJob(t, async (prompt) => {
    const { render, exported } = paths(prompt); await writeFile(render, PNG); await writeFile(exported, 'glTF');
    return reply({ objects: ['Stand'], render, exported });
  });
  const job = await runner.submit({ targetId: target.id, title: '받침대', brief: 'v1' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'review'); assert.equal(saved.target.blender.file, 'design/a.blend');
  await assert.rejects(saveTarget(root, { id: target.id, tool: 'blender', file: 'design/b.blend', scene: 'Scene', collection: 'WAX_Prop' }), /진행 중인 디자인 작업/);
  const file = join(root, '.wax', 'design', 'targets.json'), data = JSON.parse(await readFile(file, 'utf8'));
  data.targets[0].blender.file = 'design/b.blend'; await writeFile(file, JSON.stringify(data));
  state.open = join(root, 'design', 'b.blend');
  await runner.feedback(job.id, { version: 1, revision: saved.revision, text: '더 높게' });
  await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'failed'); assert.match(saved.detail, /연결 대상.*바뀌었습니다/); assert.equal(saved.versions.length, 1);
  assert.equal(prompts.length, 1, 'no run against b.blend');
});

test('a Blender version needs its exported model, and a retry never takes a failed run\'s leftover render', async (t) => {
  const { runner, target, prompts } = await blenderJob(t, async (prompt, n) => {
    const { render, exported } = paths(prompt);
    if (n === 1) { await writeFile(render, PNG); await writeFile(exported, 'glTF'); return { threadId: 't', message: JSON.stringify({ outcome: 'blocked', report: '내보내기 중 Blender가 멈췄습니다.', changes: '', nodeId: '', objects: [], render: '', exported: '' }) }; }
    if (n === 2) return reply({ objects: ['Stand'], render, exported });
    await writeFile(render, PNG);
    return reply({ objects: ['Stand'], render, exported });
  });
  const job = await runner.submit({ targetId: target.id, title: '받침대', brief: 'v1' });
  await runner.settled();
  await runner.resume(job.id); await runner.settled();
  let [saved] = (await runner.list()).jobs;
  assert.notEqual(paths(prompts[0]).render, paths(prompts[1]).render, 'each run writes to its own files');
  assert.equal(saved.status, 'failed'); assert.match(saved.detail, /렌더 결과/); assert.equal(saved.versions.length, 0);
  await runner.resume(job.id); await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'failed'); assert.match(saved.detail, /내보낸 모델/); assert.equal(saved.versions.length, 0);
});

test('a handoff refused for a missing model reopens the job so the next version can fix it; an approval can be cancelled', async (t) => {
  const { root, target, runner } = await blenderJob(t, async (prompt) => {
    const { render, exported } = paths(prompt); await writeFile(render, PNG); await writeFile(exported, 'glTF');
    return reply({ objects: ['Stand'], render, exported });
  });
  const job = await runner.submit({ targetId: target.id, title: '받침대', brief: 'v1' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  saved = await runner.approve(job.id, { version: 1, revision: saved.revision });
  const file = join(root, '.wax', 'design', 'jobs', `${job.id}.json`), raw = JSON.parse(await readFile(file, 'utf8'));
  delete raw.versions[0].source.exported; await writeFile(file, JSON.stringify(raw));
  await assert.rejects(runner.handoff(job.id, { version: 1, revision: saved.revision }), /내보낸 모델/);
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'blocked', 'the refused approval is reopened, not left stuck'); assert.equal(saved.approved, null);
  assert.match(saved.detail, /확정을 취소했습니다/);
  await runner.feedback(job.id, { version: 1, revision: saved.revision, text: 'glb까지 내보내 주세요' }); await runner.settled();
  [saved] = (await runner.list()).jobs;
  assert.equal(saved.status, 'review'); assert.equal(saved.versions.length, 2);
  saved = await runner.approve(job.id, { version: 2, revision: saved.revision });
  await assert.rejects(runner.reopen(job.id, { version: 1, revision: saved.revision }), { status: 409 });
  saved = await runner.reopen(job.id, { version: 2, revision: saved.revision });
  assert.equal(saved.status, 'review'); assert.equal(saved.approved, null);
  saved = await runner.approve(job.id, { version: 2, revision: saved.revision });
  saved = await runner.handoff(job.id, { version: 2, revision: saved.revision });
  assert.equal(saved.status, 'handed-off'); assert.equal(saved.handoff.assets.length, 1);
});

test('a handoff overtaken by a cancel writes nothing, and each version keeps its own handoff document', async (t) => {
  const { root, target, runner } = await figmaJob(t);
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '업로드', brief: '첫 화면' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  saved = await runner.approve(job.id, { version: 1, revision: saved.revision });
  const stale = saved.revision;
  const [handed, reopened] = await Promise.allSettled([runner.handoff(job.id, { version: 1, revision: stale }), runner.reopen(job.id, { version: 1, revision: stale })]);
  assert.equal([handed, reopened].filter((r) => r.status === 'fulfilled').length, 1);
  const docs = join(root, 'docs', 'wax', 'design', job.id), exists = (name) => readFile(join(docs, name)).then(() => true, () => false);
  if (handed.status === 'fulfilled') return assert.equal(await exists('handoff-v1.md'), true);
  assert.equal(await exists('handoff-v1.md'), false, 'the cancelled handoff left no document');
  [saved] = (await runner.list()).jobs;
  await runner.feedback(job.id, { version: 1, revision: saved.revision, text: '버튼을 키워 주세요' }); await runner.settled();
  [saved] = (await runner.list()).jobs;
  saved = await runner.approve(job.id, { version: 2, revision: saved.revision });
  saved = await runner.handoff(job.id, { version: 2, revision: saved.revision });
  await assert.rejects(runner.handoff(job.id, { version: 1, revision: stale }), { status: 409 });
  assert.equal(saved.handoff.doc, `docs/wax/design/${job.id}/handoff-v2.md`);
  assert.match(await readFile(join(docs, 'handoff-v2.md'), 'utf8'), /확정 버전: v2/);
  assert.equal(await exists('handoff-v1.md'), false, 'a late v1 request cannot publish over v2');
});

test('a handoff that passed its first check but is overtaken while waiting for the job lock publishes nothing', async (t) => {
  const { root, target, runner } = await figmaJob(t);
  await runner.check(target.id, 'codex');
  const job = await runner.submit({ targetId: target.id, title: '업로드', brief: '첫 화면' });
  await runner.settled();
  let [saved] = (await runner.list()).jobs;
  saved = await runner.approve(job.id, { version: 1, revision: saved.revision });
  const file = join(root, '.wax', 'design', 'jobs', `${job.id}.json`);
  let late;
  await withLock(`${file}.lock`, async () => {
    late = runner.handoff(job.id, { version: 1, revision: saved.revision });
    late.catch(() => {});
    await sleep(300);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    Object.assign(raw, { status: 'review', approved: null, revision: raw.revision + 1 });
    await writeFile(file, JSON.stringify(raw));
  });
  await assert.rejects(late, { status: 409 });
  const written = await readdir(join(root, 'docs', 'wax', 'design', job.id)).catch(() => []);
  assert.deepEqual(written.filter((name) => name.startsWith('handoff') || name.startsWith('v1')), [], 'no handoff document or copy was published');
  assert.equal((await runner.list()).jobs[0].status, 'review');
});
