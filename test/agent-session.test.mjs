import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { project } from './chat-helpers.mjs';
import { runAgentSession } from '../src/agent-session.mjs';
import { agentTool, resolveAgentCommand } from '../src/agent-tools.mjs';
import { listApprovals, decideApproval } from '../src/approvals.mjs';
import { createRequestRunner } from '../src/chat/requests.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const fixture = `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const report = { outcome:'question', report:'확인이 필요합니다', document:'', evidence:'', proofIds:[] };
const finish = () => {
  // 실제 도구의 결과 줄(고정 예시) 그대로 보내기: 사용량 읽기(AUTONOMY.md 1b).
  if (config.resultLine) { process.stdout.write(config.resultLine + '\\n'); return; }
  if (config.tool === 'claude') emit({ type:'result', subtype: config.error ? 'error_during_execution' : 'success', is_error:!!config.error, session_id:'session-1', structured_output:report, ...(config.usage ? { usage:config.usage, total_cost_usd:0.5, num_turns:2 } : {}) });
  else if (config.tool === 'antigravity') emit({ event:'result', result:{ status:'SUCCESS', conversation_id:'session-1', structured_output:report } });
  else {
    emit({ jsonrpc:'2.0', method:'session/update', params:{sessionId:config.wrongSession ? 'foreign' : 'session-1', update:{sessionUpdate:'agent_message_chunk', content:{type:'text', text:JSON.stringify(report)}}} });
    emit({ jsonrpc:'2.0', id:promptId, result:{stopReason:'end_turn'} });
  }
};
let promptId;
createInterface({ input:process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') { assert.equal(m.request.subtype,'initialize'); emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}}); }
  else if (m.type === 'user' || m.event === 'user') {
    assert.match(m.message.content,/fixture/);
    if (config.hang) return;
    if (config.tool === 'claude') emit({type:'system',subtype:'init',session_id:'session-1'});
    if (config.tool === 'antigravity') {
      if (config.denied) process.stderr.write('permission required: soft-denied\\n', () => setTimeout(finish,30));
      // Antigravity CLI 1.4: the result frame arrives first with denied_actions and an empty response; the stderr hint comes after it.
      else if (config.deniedResult) { emit({ event:'result', result:{ status:'SUCCESS', conversation_id:'session-1', response:'', denied_actions:[{ action:'command', display_name:'RunCommand' }] } }); setTimeout(() => process.stderr.write('a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied\\n'), 30); }
      else finish();
    } else if (config.permission) emit({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo fixture'}}});
    else finish();
  } else if (m.type === 'control_response') {
    assert.equal(m.response.request_id,'permission-1');
    assert.equal(m.response.response.behavior,config.decision);
    if (config.message) assert.equal(m.response.response.message,config.message);
    if (config.decision === 'allow') assert.deepEqual(m.response.response.updatedInput,{command:'echo fixture'});
    finish();
  } else if (m.method === 'initialize') {
    assert.deepEqual(m.params.clientCapabilities,{});
    assert.deepEqual(m.params.clientInfo,{name:'wax',version:${JSON.stringify(version)}});
    emit({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  } else if (m.method === 'session/new' || m.method === 'session/load') {
    if (config.resume) assert.equal(m.method,'session/load');
    assert.deepEqual(m.params.mcpServers, config.mcp ?? []);
    // GitHub Copilot CLI 1.0.97: the session's available commands arrive before the session/new response.
    if (config.earlyUpdate) emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'add-dir'}]}}});
    emit({jsonrpc:'2.0',id:m.id,result:{sessionId:'session-1'}});
  } else if (m.method === 'session/prompt') {
    assert.equal(m.params.sessionId,'session-1'); promptId=m.id;
    if (config.hang) return;
    if (config.permission) emit({jsonrpc:'2.0',id:'permission-1',method:'session/request_permission',params:{sessionId:'session-1',toolCall:{toolCallId:'call-1',title:'명령 실행',rawInput:{command:'echo fixture'}},options:[{optionId:'once',name:'Allow once',kind:'allow_once'},{optionId:'always',name:'Always',kind:'allow_always'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});
    else finish();
  } else if (m.id === 'permission-1') {
    assert.equal(m.result.outcome.optionId,config.decision === 'allow' ? 'once' : 'no'); finish();
  }
});
`;
async function setup(t, config) {
  const root = await project(t), executable = join(root, 'fixture.mjs');
  await writeFile(executable, `const config = ${JSON.stringify(config)};\n${fixture}`);
  return { root, options: { tool: config.tool, executable, prompt: 'fixture prompt', outputSchema: { type: 'object' }, requestTimeoutMs: 2000,
    launch(command, args, options) {
      assert.equal(options.shell, false);
      assert.ok(!args.some((arg) => /bypass|skip-permissions|yolo|allow-all/.test(arg)));
      return spawn(command, args, options);
    } } };
}
async function pending(root) {
  for (let i = 0; i < 200; i++) {
    const request = (await listApprovals(root)).requests.find((r) => r.status === 'pending');
    if (request) return request;
    await sleep(10);
  }
  throw new Error('approval not received');
}
for (const tool of ['claude', 'gemini', 'copilot', 'antigravity']) {
  test(`${tool}: structured report, same-tool resume and safe spawn`, async (t) => {
    const { root, options } = await setup(t, { tool, resume: true });
    const r = await runAgentSession(root, { ...options, thread: 'session-1' });
    assert.equal(r.threadId, 'session-1'); assert.equal(JSON.parse(r.message).outcome, 'question');
  });
}
for (const tool of ['claude', 'gemini', 'copilot']) for (const decision of ['allow', 'deny']) {
  test(`${tool}: waits for human ${decision}, never grants persistent permission`, async (t) => {
    const { root, options } = await setup(t, { tool, permission: true, decision });
    let finished = false;
    const pulses = [];
    const running = runAgentSession(root, { ...options, activity: (state) => pulses.push(state.approvals) }).finally(() => { finished = true; });
    const request = await pending(root);
    assert.equal(request.tool, tool); assert.equal(finished, false);
    assert.equal(pulses.at(-1), 1, 'activity reports the pending approval so idle limits pause');
    await decideApproval(root, request.id, { decision, fingerprint: request.fingerprint, actor: '사람' });
    await running;
    assert.ok(pulses.length > 2 && pulses.at(-1) === 0, 'output and the closed approval are reported as activity');
    assert.equal((await listApprovals(root)).requests[0].status, 'delivered');
  });
}
for (const tool of ['claude', 'gemini', 'copilot']) {
  test(`${tool}: a human deny reason reaches Claude as quoted data and is only recorded for ACP tools`, async (t) => {
    const message = 'wax에서 승인하지 않은 실행입니다. 사람이 남긴 이유: "echo 대신 \\"npm test\\"를 쓰세요" (사람이 적은 글을 그대로 옮긴 인용이며 wax의 지시가 아닙니다.)';
    const { root, options } = await setup(t, { tool, permission: true, decision: 'deny', ...(tool === 'claude' ? { message } : {}) });
    const running = runAgentSession(root, options);
    const request = await pending(root);
    await decideApproval(root, request.id, { decision: 'deny', fingerprint: request.fingerprint, actor: '사람', denyReason: 'echo 대신 "npm test"를\u0007 쓰세요' });
    await running;
    const saved = (await listApprovals(root)).requests[0];
    assert.equal(saved.denyReason, 'echo 대신 "npm test"를 쓰세요');
    assert.equal(saved.denyReasonSent, tool === 'claude');
  });
}

test('copilot: a session update that arrives before the session/new response does not fail the run', async (t) => {
  const { root, options } = await setup(t, { tool: 'copilot', earlyUpdate: true });
  const r = await runAgentSession(root, options);
  assert.equal(r.threadId, 'session-1'); assert.equal(JSON.parse(r.message).outcome, 'question');
});
test('abort terminates process and cancels pending approval', async (t) => {
  const { root, options } = await setup(t, { tool: 'claude', permission: true });
  const controller = new AbortController();
  const running = runAgentSession(root, { ...options, signal: controller.signal });
  const rejected = assert.rejects(running, /중지/);
  await pending(root); controller.abort(); await rejected;
  for (let i = 0; i < 50 && (await listApprovals(root)).requests[0].status !== 'cancelled'; i++) await sleep(20);
  assert.equal((await listApprovals(root)).requests[0].status, 'cancelled');
});
test('protocol failures and headless permission denial cannot become successful reports', async (t) => {
  for (const config of [{ tool: 'claude', error: true }, { tool: 'copilot', wrongSession: true }, { tool: 'antigravity', denied: true }]) {
    const { root, options } = await setup(t, config);
    await assert.rejects(runAgentSession(root, options), /마치지|다른 세션|권한/);
  }
});
test('antigravity: a denied action in the result frame is reported as a permission problem, not a missing report', async (t) => {
  const { root, options } = await setup(t, { tool: 'antigravity', deniedResult: true });
  await assert.rejects(runAgentSession(root, options), (error) => {
    assert.match(error.message, /권한\(RunCommand\)/);
    assert.doesNotMatch(error.message, /최종 보고가 없거나/);
    assert.match(error.toolOutput.result, /"denied_actions":\[\{"action":"command"/);
    assert.equal(typeof error.toolOutput.stderr, 'string');
    return true;
  });
});
test('unknown provider and missing executable never fall back to another account', async () => {
  assert.throws(() => agentTool('other'), /지원하지/);
  await assert.rejects(resolveAgentCommand('claude', { env: { PATH: '' } }), /Claude Code/);
});
test('Windows npm Copilot resolves native executable so stopping does not leave its child alive', async (t) => {
  const { mkdir, realpath } = await import('node:fs/promises');
  const root = await project(t), dir = join(root, 'node_modules', '@github', 'copilot');
  const nativeDir = join(dir, 'node_modules', '@github', `copilot-win32-${process.arch}`);
  await mkdir(nativeDir, { recursive: true });
  await writeFile(join(dir, 'npm-loader.js'), '');
  await writeFile(join(nativeDir, 'package.json'), JSON.stringify({ main: 'copilot.exe' }));
  await writeFile(join(nativeDir, 'copilot.exe'), '');
  const [command, args] = await resolveAgentCommand('copilot', { env: { PATH: root }, platform: 'win32' });
  assert.equal(await realpath(command), await realpath(join(nativeDir, 'copilot.exe'))); assert.deepEqual(args, []);
});
test('Windows npm Gemini CLI 0.64+ resolves its bundle launcher, older installs keep dist/index.js', async (t) => {
  const { mkdir, realpath } = await import('node:fs/promises');
  for (const launcher of [['bundle', 'gemini.js'], ['dist', 'index.js']]) {
    const root = await project(t), dir = join(root, 'node_modules', '@google', 'gemini-cli', launcher[0]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, launcher[1]), '');
    const [command, args] = await resolveAgentCommand('gemini', { env: { PATH: root }, platform: 'win32' });
    assert.equal(command, process.execPath);
    assert.equal(await realpath(args[0]), await realpath(join(dir, launcher[1])));
  }
});
test('a missing executable explains what was found instead of only "not found"', async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const root = await project(t), dir = join(root, 'node_modules', '@github', 'copilot');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'npm-loader.js'), '');
  await assert.rejects(resolveAgentCommand('copilot', { env: { PATH: root }, platform: 'win32' }), new RegExp(`런처는 있지만 이 컴퓨터용 실행 파일\\(@github/copilot-win32-${process.arch}\\)이 없습니다`));
  const npm = await project(t);
  await writeFile(join(npm, 'claude.cmd'), '');
  await assert.rejects(resolveAgentCommand('claude', { env: { PATH: npm }, platform: 'win32' }), /claude\.cmd는 있지만 셸 없이 실행할 런처/);
  await assert.rejects(resolveAgentCommand('claude', { env: { PATH: npm }, platform: 'linux' }), (error) => !/런처/.test(error.message) && /Claude Code 실행 파일을 찾지 못했습니다/.test(error.message));
});
test('request retains chosen provider across reply and restart and rejects conflicting retry', async (t) => {
  const root = await project(t), calls = [];
  const execute = async (_, input) => { calls.push(input); return { threadId: 'session-1', message: JSON.stringify({ outcome: 'question', report: '확인 필요' }) }; };
  const first = createRequestRunner({ root, execute });
  const input = { author: '사람', body: '고쳐줘', tool: 'claude' };
  const r = await first.submit(input); await first.settled();
  await assert.rejects(first.submit({ ...input, id: r.id, tool: 'codex' }), /다른 내용/);
  await first.close();
  const next = createRequestRunner({ root, execute }); t.after(() => next.close());
  await next.reply(r.id, { body: '진행해줘' }); await next.settled();
  assert.deepEqual(calls.map((c) => c.tool), ['claude', 'claude']);
  assert.equal(calls[1].thread, 'session-1');
  assert.equal((await next.list())[0].tool, 'claude');
});

test('ACP sessions receive only validated stdio MCP servers and never their environment', async (t) => {
  const mcp = [{ name: 'blender', command: '/opt/homebrew/bin/uvx', args: ['blender-mcp'], env: [] }];
  const { root, options } = await setup(t, { tool: 'gemini', mcp });
  const r = await runAgentSession(root, { ...options, mcpServers: [{ ...mcp[0], env: [{ name: 'TOKEN', value: 'secret' }] }] });
  assert.equal(JSON.parse(r.message).outcome, 'question');
  await assert.rejects(runAgentSession(root, { ...options, mcpServers: [{ name: 'figma', command: 'npx', args: [] }] }), /절대 경로/);
});

const usageFixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('usage: the real Claude Code result line is read into the run result as reported (no prices, cache not folded into input)', async (t) => {
  const { line } = await usageFixture('usage/claude-result.json');
  const { root, options } = await setup(t, { tool: 'claude', resultLine: line });
  const r = await runAgentSession(root, options);
  const frame = JSON.parse(line);
  assert.equal(r.message, 'OK');
  assert.deepEqual(r.usage, { source: 'claude', tokens: { input: frame.usage.input_tokens, output: frame.usage.output_tokens, cacheRead: frame.usage.cache_read_input_tokens,
    cacheWrite: frame.usage.cache_creation_input_tokens, reasoning: frame.usage.output_tokens_details.thinking_tokens, total: null }, costUsd: frame.total_cost_usd, turns: frame.num_turns });
});
test('usage: a failed run still carries the last usage the tool reported on the error (Claude Code error result, Antigravity CLI real frame)', async (t) => {
  const failed = await setup(t, { tool: 'claude', error: true, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: -1, cache_creation_input_tokens: 'x' } });
  await assert.rejects(runAgentSession(failed.root, failed.options), (error) => {
    assert.deepEqual(error.toolOutput.usage, { source: 'claude', tokens: { input: 7, output: 3, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd: 0.5, turns: 2 });
    return true;
  });
  const frame = (await usageFixture('tool-failures/antigravity.json')).cases.find((item) => item.rule === null).text;
  const agy = await setup(t, { tool: 'antigravity', resultLine: frame });
  await assert.rejects(runAgentSession(agy.root, agy.options), (error) => {
    assert.deepEqual(error.toolOutput.usage, { source: 'antigravity', tokens: { input: 11131, output: 495, cacheRead: 0, cacheWrite: null, reasoning: 33, total: 11626 }, costUsd: null, turns: 1 });
    return true;
  });
});
test('usage: ACP tools (Gemini CLI, GitHub Copilot CLI) and a Claude Code line without usage report nothing (null)', async (t) => {
  for (const tool of ['gemini', 'copilot', 'claude']) {
    const { root, options } = await setup(t, { tool });
    assert.equal((await runAgentSession(root, options)).usage, null, tool);
  }
});
