import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { agentTool, resolveAgentCommand } from './agent-tools.mjs';
import { runCodexSession } from './codex-session.mjs';
import { createApproval, waitForApproval, finishDelivery, cancelApproval } from './approvals.mjs';
import { WaxError } from './workflow.mjs';

export async function runAgentSession(root, options = {}) {
  const { tool = 'codex', prompt, thread, outputSchema, signal, launch = spawn,
    requestTimeoutMs = 30_000, approvalTimeoutMs = 120_000, executable } = options;
  const { label } = agentTool(tool);
  if (tool === 'codex') return runCodexSession(root, options);
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) throw new WaxError('실행 요청은 100000자 이하여야 합니다.');
  if (thread !== undefined && (typeof thread !== 'string' || !thread || thread.length > 256)) throw new WaxError('잘못된 도구 세션 ID입니다.');
  signal?.throwIfAborted();
  root = await realpath(root);
  const [command, prefix] = executable ? [process.execPath, [executable]] : await resolveAgentCommand(tool);
  const acp = ['gemini', 'copilot'].includes(tool);
  const args = acp ? [tool === 'gemini' ? '--experimental-acp' : '--acp'] : [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...(outputSchema ? ['--json-schema', JSON.stringify(outputSchema)] : []),
    ...(tool === 'claude' ? ['--print', '--verbose', '--permission-prompt-tool', 'stdio'] : ['--print-timeout', '30m']),
    ...(thread ? [tool === 'claude' ? '--resume' : '--conversation', thread] : []),
  ];
  const child = launch(command, [...prefix, ...args], { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController(), calls = new Map(), permissions = new Map(), seen = new Set(), deliveries = new Set();
  let closing = false, exited = false, sequence = 0, sessionId = thread, text = '', buffer = '', denied = false, fatal;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const closed = new Promise((resolve) => child.once('close', () => { exited = true; resolve(); }));
  const fail = (error) => {
    fatal ||= error; rejectResult(error); controller.abort();
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
    calls.clear();
    for (const pending of permissions.values()) pending.controller.abort();
  };
  const send = (frame) => new Promise((resolve, reject) => {
    if (closing || child.stdin.destroyed || fatal) return reject(fatal || new Error('실행 연결이 종료되었습니다.'));
    child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
  });
  const rpc = (method, params, timeout = requestTimeoutMs) => {
    if (fatal) return Promise.reject(fatal);
    const id = `wax-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { calls.delete(id); fail(new WaxError(`${label} 응답 대기 시간 초과: ${method}`)); reject(fatal); }, timeout) : undefined;
      calls.set(id, { resolve, reject, timer });
      const frame = acp ? { jsonrpc: '2.0', id, method, params } : { type: 'control_request', request_id: id, request: { subtype: method, ...params } };
      send(frame).catch(fail);
    });
  };
  const approve = async (id, params, emit) => {
    const key = String(id);
    if (seen.has(key)) throw new WaxError('중복된 도구 승인 요청입니다.');
    seen.add(key);
    if (seen.size > 2000) throw new WaxError('실행 승인 요청 한도를 초과했습니다.');
    const local = new AbortController();
    const abort = () => local.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) local.abort();
    const entry = { controller: local }; permissions.set(key, entry);
    let pending;
    try {
      if (acp && (params.sessionId !== sessionId || !Array.isArray(params.options) || !params.options.some((o) => o.kind === 'allow_once'))) throw new WaxError('지원하지 않는 승인 범위 또는 세션입니다.');
      pending = await createApproval(root, { tool, session: sessionId || 'starting', callId: key,
        action: acp ? params.toolCall?.title || '도구 실행' : params.tool_name,
        details: params }, { timeoutMs: approvalTimeoutMs });
      const decision = await waitForApproval(root, pending, { signal: local.signal });
      if (local.signal.aborted || closing) return;
      await emit(decision);
      if (decision) await finishDelivery(root, pending.request.id, pending.secret);
    } finally {
      permissions.delete(key); controller.signal.removeEventListener('abort', abort);
      if (pending) await cancelApproval(root, pending.request.id, pending.secret, '도구 연결 종료').catch(() => {});
    }
  };
  const complete = (frame) => {
    if (denied) throw new WaxError('Antigravity CLI에서 실행 권한을 요청했지만 비대화형 모드에서는 승인할 수 없습니다. 터미널의 권한 설정을 확인한 뒤 이어서 진행하세요.');
    const value = frame.structured_output !== undefined ? JSON.stringify(frame.structured_output) : frame.result ?? frame.response;
    if (typeof value !== 'string' || !value.trim() || value.length > 200_000) throw new WaxError(`${label}의 최종 보고가 없거나 너무 큽니다.`);
    sessionId = frame.session_id || frame.conversation_id || sessionId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new WaxError('도구 세션 ID를 받지 못했습니다.');
    resolveResult({ threadId: sessionId, status: 'completed', message: value });
  };
  const receive = (m) => {
    if (acp) {
      if (m.jsonrpc !== '2.0') throw new WaxError('잘못된 ACP 응답입니다.');
      if (m.method && m.id !== undefined) {
        if (m.method !== 'session/request_permission') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported client capability' } });
        return approve(m.id, m.params, (decision) => {
          const option = m.params.options.find((o) => o.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'));
          return send({ jsonrpc: '2.0', id: m.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
        });
      }
      if (m.method === 'session/update') {
        if (m.params?.sessionId !== sessionId) throw new WaxError('다른 세션의 ACP 응답입니다.');
        const update = m.params.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          text += update.content.text;
          if (text.length > 200_000) throw new WaxError('AI 보고가 너무 큽니다.');
        }
      }
      if (m.id !== undefined && calls.has(m.id)) {
        const call = calls.get(m.id); clearTimeout(call.timer); calls.delete(m.id);
        if (m.error) call.reject(new WaxError(`${label} 연결 요청 실패. CLI 로그인·API 설정과 지원 버전을 확인하세요.`));
        else call.resolve(m.result);
      }
    } else if (tool === 'claude') {
      if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
      if (m.type === 'control_response') {
        const response = m.response, call = calls.get(response?.request_id);
        if (call) { clearTimeout(call.timer); calls.delete(response.request_id); response.subtype === 'success' ? call.resolve(response.response) : call.reject(new WaxError('Claude 초기화에 실패했습니다. CLI 설정을 확인하세요.')); }
      }
      if (m.type === 'control_cancel_request') permissions.get(String(m.request_id))?.controller.abort();
      if (m.type === 'control_request') {
        if (m.request?.subtype !== 'can_use_tool') return send({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported control request' } });
        return approve(m.request_id, m.request, (decision) => send({ type: 'control_response', response: {
          subtype: 'success', request_id: m.request_id, response: decision === 'allow' ? { behavior: 'allow', updatedInput: m.request.input } : { behavior: 'deny', message: 'wax에서 승인하지 않은 실행입니다.' },
        } }));
      }
      if (m.type === 'result') {
        if (m.is_error || m.subtype !== 'success') throw new WaxError('Claude 실행을 마치지 못했습니다. 로그인·사용량·권한 설정을 확인한 뒤 이어서 진행하세요.');
        complete(m);
      }
    } else if (m.event === 'result') {
      if (m.result?.status !== 'SUCCESS') throw new WaxError('Antigravity 실행을 마치지 못했습니다. 로그인·사용량·권한 설정을 확인하세요.');
      complete(m.result);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 2_000_000) { fail(new WaxError('도구 응답 크기를 초과했습니다.')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line || closing || fatal) continue;
      try {
        const delivery = Promise.resolve(receive(JSON.parse(line))).catch(fail);
        deliveries.add(delivery); delivery.finally(() => deliveries.delete(delivery));
      } catch (error) { fail(error); }
    }
  });
  let diagnosticTail = '';
  child.stderr.on('data', (chunk) => {
    diagnosticTail = (diagnosticTail + String(chunk)).slice(-12_000);
    if (tool === 'antigravity' && /permission.{0,80}(denied|ask|require)|soft.denied|not allowed/i.test(diagnosticTail)) denied = true;
  });
  child.stdin.on('error', fail); child.on('error', () => fail(new WaxError(`${label}를 시작하지 못했습니다. 설치와 실행 권한을 확인하세요.`)));
  child.on('close', (code) => { if (!closing) fail(new WaxError(`${label} 연결 종료 (exit=${code}). 해당 CLI의 로그인·API 설정과 사용량을 확인하세요.`)); });
  const abort = () => fail(new WaxError('실행을 중지했습니다.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (acp) {
      const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wax', version: '0.12.6' } });
      if (init.protocolVersion !== 1) throw new WaxError('지원하지 않는 ACP 버전입니다.');
      if (thread && init.agentCapabilities?.loadSession) {
        sessionId = thread;
        await rpc('session/load', { sessionId, cwd: root, mcpServers: [] });
      } else {
        const session = await rpc('session/new', { cwd: root, mcpServers: [] });
        sessionId = session.sessionId;
      }
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new WaxError('ACP 세션 ID가 없습니다.');
      text = '';
      const turn = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${prompt}\n\n최종 응답은 설명·코드펜스 없이 다음 스키마에 맞는 JSON 객체 하나로 반환하세요:\n${JSON.stringify(outputSchema)}` }] }, 0);
      if (turn.stopReason !== 'end_turn') throw new WaxError(`${label} 작업이 완료되지 않았습니다 (${turn.stopReason}).`);
      complete({ response: text });
    } else {
      if (tool === 'claude') await rpc('initialize', { hooks: null });
      await send(tool === 'claude' ? { type: 'user', session_id: sessionId || '', message: { role: 'user', content: prompt }, parent_tool_use_id: null } : { event: 'user', message: { content: prompt } });
    }
    const completed = await result;
    if (fatal) throw fatal;
    return completed;
  } finally {
    closing = true; controller.abort(); signal?.removeEventListener('abort', abort);
    for (const entry of permissions.values()) entry.controller.abort();
    for (const call of calls.values()) clearTimeout(call.timer);
    if (!exited) { child.stdin.end(); child.kill(); }
    const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000);
    try { await closed; await Promise.allSettled([...deliveries]); } finally { clearTimeout(force); }
  }
}
