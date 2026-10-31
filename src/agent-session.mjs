import { t } from '../web/messages-catalog.mjs';
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { agentTool, resolveAgentCommand } from './agent-tools.mjs';
import { runCodexSession } from './codex-session.mjs';
import { createApproval, waitForApproval, finishDelivery, cancelApproval } from './approvals.mjs';
import { WaxError } from './workflow.mjs';
import { acpServers } from './chat/design-mcp.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export async function runAgentSession(root, options = {}) {
  const { tool = 'codex', prompt, thread, outputSchema, signal, launch = spawn,
    requestTimeoutMs = 30_000, approvalTimeoutMs = 120_000, executable, mcpServers = [] } = options;
  const { label } = agentTool(tool);
  if (tool === 'codex') return runCodexSession(root, options);
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) throw new WaxError(t('errors.agentSession.executionRequestsMustBe'));
  if (thread !== undefined && (typeof thread !== 'string' || !thread || thread.length > 256)) throw new WaxError(t('errors.agentSession.invalidToolSessionId'));
  signal?.throwIfAborted();
  const servers = acpServers(mcpServers);
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
    if (closing || child.stdin.destroyed || fatal) return reject(fatal || new Error(t('errors.agentSession.theExecutionConnectionWas')));
    child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
  });
  const rpc = (method, params, timeout = requestTimeoutMs) => {
    if (fatal) return Promise.reject(fatal);
    const id = `wax-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { calls.delete(id); fail(new WaxError(t('errors.agentSession.responseTimedOut', label, method))); reject(fatal); }, timeout) : undefined;
      calls.set(id, { resolve, reject, timer });
      const frame = acp ? { jsonrpc: '2.0', id, method, params } : { type: 'control_request', request_id: id, request: { subtype: method, ...params } };
      send(frame).catch(fail);
    });
  };
  const approve = async (id, params, emit) => {
    const key = String(id);
    if (seen.has(key)) throw new WaxError(t('errors.agentSession.duplicateToolApprovalRequest'));
    seen.add(key);
    if (seen.size > 2000) throw new WaxError(t('errors.agentSession.theExecutionApprovalRequest'));
    const local = new AbortController();
    const abort = () => local.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) local.abort();
    const entry = { controller: local }; permissions.set(key, entry);
    let pending;
    try {
      if (acp && (params.sessionId !== sessionId || !Array.isArray(params.options) || !params.options.some((o) => o.kind === 'allow_once'))) throw new WaxError(t('errors.agentSession.unsupportedApprovalScopeOr'));
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
    if (denied) throw new WaxError(t('errors.agentSession.antigravityCliRequestedExecution'));
    const value = frame.structured_output !== undefined ? JSON.stringify(frame.structured_output) : frame.result ?? frame.response;
    if (typeof value !== 'string' || !value.trim() || value.length > 200_000) throw new WaxError(t('errors.agentSession.theFinalReportFrom', label));
    sessionId = frame.session_id || frame.conversation_id || sessionId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new WaxError(t('errors.agentSession.didNotReceiveA'));
    resolveResult({ threadId: sessionId, status: 'completed', message: value });
  };
  const receive = (m) => {
    if (acp) {
      if (m.jsonrpc !== '2.0') throw new WaxError(t('errors.agentSession.invalidAcpResponse'));
      if (m.method && m.id !== undefined) {
        if (m.method !== 'session/request_permission') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported client capability' } });
        return approve(m.id, m.params, (decision) => {
          const option = m.params.options.find((o) => o.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'));
          return send({ jsonrpc: '2.0', id: m.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
        });
      }
      if (m.method === 'session/update') {
        if (m.params?.sessionId !== sessionId) throw new WaxError(t('errors.agentSession.acpResponseFromA'));
        const update = m.params.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          text += update.content.text;
          if (text.length > 200_000) throw new WaxError(t('errors.agentSession.theAiReportIs'));
        }
      }
      if (m.id !== undefined && calls.has(m.id)) {
        const call = calls.get(m.id); clearTimeout(call.timer); calls.delete(m.id);
        if (m.error) call.reject(new WaxError(t('errors.agentSession.connectionRequestFailedCheck', label)));
        else call.resolve(m.result);
      }
    } else if (tool === 'claude') {
      if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
      if (m.type === 'control_response') {
        const response = m.response, call = calls.get(response?.request_id);
        if (call) { clearTimeout(call.timer); calls.delete(response.request_id); response.subtype === 'success' ? call.resolve(response.response) : call.reject(new WaxError(t('errors.agentSession.claudeFailedToInitialize'))); }
      }
      if (m.type === 'control_cancel_request') permissions.get(String(m.request_id))?.controller.abort();
      if (m.type === 'control_request') {
        if (m.request?.subtype !== 'can_use_tool') return send({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported control request' } });
        return approve(m.request_id, m.request, (decision) => send({ type: 'control_response', response: {
          subtype: 'success', request_id: m.request_id, response: decision === 'allow' ? { behavior: 'allow', updatedInput: m.request.input } : { behavior: 'deny', message: decision === 'deny' ? 'wax에서 승인하지 않은 실행입니다.' : 'wax 승인 대기 시간이 지나 실행하지 않았습니다.' },
        } }));
      }
      if (m.type === 'result') {
        if (m.is_error || m.subtype !== 'success') throw new WaxError(t('errors.agentSession.claudeDidntFinishRunning'));
        complete(m);
      }
    } else if (m.event === 'result') {
      const refused = Array.isArray(m.result?.denied_actions) ? m.result.denied_actions : [];
      if (refused.length) throw new WaxError(t('errors.agentSession.antigravityDeniedActions', [...new Set(refused.map((item) => String(item?.display_name || item?.action || '?').slice(0, 40)))].slice(0, 5).join(', ')));
      if (m.result?.status !== 'SUCCESS') throw new WaxError(t('errors.agentSession.antigravityDidntFinishRunning'));
      complete(m.result);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 2_000_000) { fail(new WaxError(t('errors.agentSession.theToolResponseSize'))); return; }
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
  child.stdin.on('error', fail); child.on('error', () => fail(new WaxError(t('errors.agentSession.couldNotStartCheck', label))));
  child.on('close', (code) => { if (!closing) fail(new WaxError(t('errors.agentSession.connectionClosedExitCheck', label, code))); });
  const abort = () => fail(new WaxError(t('errors.agentSession.executionStopped')));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (acp) {
      const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wax', version } });
      if (init.protocolVersion !== 1) throw new WaxError(t('errors.agentSession.unsupportedAcpVersion'));
      if (thread && init.agentCapabilities?.loadSession) {
        sessionId = thread;
        await rpc('session/load', { sessionId, cwd: root, mcpServers: servers });
      } else {
        const session = await rpc('session/new', { cwd: root, mcpServers: servers });
        sessionId = session.sessionId;
      }
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new WaxError(t('errors.agentSession.noAcpSessionId'));
      text = '';
      const turn = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${prompt}\n\n최종 응답은 설명·코드펜스 없이 다음 스키마에 맞는 JSON 객체 하나로 반환하세요:\n${JSON.stringify(outputSchema)}` }] }, 0);
      if (turn.stopReason !== 'end_turn') throw new WaxError(t('errors.agentSession.taskDidNotComplete', label, turn.stopReason));
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
