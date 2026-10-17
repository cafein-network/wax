import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApproval, waitForApproval, finishDelivery, cancelApproval, cancelSessionApprovals } from './approvals.mjs';
import { probeDashboard } from './chat/server.mjs';
import { WaxError } from './workflow.mjs';

async function projectFor(cwd, configured) {
  let root = await realpath(cwd);
  if (configured) {
    const project = await realpath(resolve(configured));
    const inside = relative(project, root);
    if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) throw new WaxError('승인 요청의 작업 경로가 프로젝트 밖입니다.');
    return project;
  }
  for (;;) {
    try { if ((await lstat(join(root, '.wax'))).isDirectory()) return root; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

export async function handleClaudeApproval(input, { env = process.env, signal, emit, timeoutMs = 30_000, dashboard = probeDashboard,
  log = (text) => process.stderr.write(text) } = {}) {
  if (!['PermissionRequest', 'SessionEnd'].includes(input?.hook_event_name)) return false;
  if (input.hook_event_name === 'PermissionRequest' && env.WAX_APPROVALS !== 'on') return false;
  if (typeof input.cwd !== 'string' || typeof input.session_id !== 'string') throw new WaxError('Claude 승인 요청에 작업 경로와 세션 ID가 필요합니다.');
  const root = await projectFor(input.cwd, env.WAX_PROJECT);
  if (!root) return false;
  if (input.hook_event_name === 'SessionEnd') { await cancelSessionApprovals(root, 'claude', input.session_id); return false; }
  if (typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) throw new WaxError('Claude 도구 이름과 실행 인수가 필요합니다.');
  const port = Number(env.WAX_APPROVAL_PORT || 4330);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WaxError('WAX_APPROVAL_PORT가 잘못되었습니다.');
  const running = await dashboard(port);
  if (!running?.root || await realpath(running.root) !== root) return false;
  const pending = await createApproval(root, { tool: 'claude', session: input.session_id,
    callId: input.tool_use_id || randomUUID(), action: input.tool_name,
    details: { cwd: input.cwd, tool: input.tool_name, input: input.tool_input } }, { timeoutMs });
  try {
    log(`wax: 실행 승인 대기 — http://127.0.0.1:${port}/chat (최대 ${Math.ceil(timeoutMs / 1000)}초, 응답이 없으면 콘솔 승인으로 돌아갑니다.)\n`);
    const decision = await waitForApproval(root, pending, { signal });
    if (!decision || signal?.aborted) return false;
    await emit({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
      behavior: decision === 'allow' ? 'allow' : 'deny',
      ...(decision === 'deny' ? { message: 'wax 대화창에서 사용자가 이 요청을 거부했습니다.' } : {}),
    } } });
    await finishDelivery(root, pending.request.id, pending.secret);
    return true;
  } finally { await cancelApproval(root, pending.request.id, pending.secret, 'Claude 연결 종료').catch(() => {}); }
}

export const CODEX_APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'mcpServer/elicitation/request']);

export const confirmOnly = (p) => p?.mode === 'form' && p.requestedSchema && typeof p.requestedSchema === 'object' && !Object.keys(p.requestedSchema.properties || {}).length;

export async function handleCodexApproval(root, message, { item, signal, emit, timeoutMs = 120_000 } = {}) {
  if (!CODEX_APPROVAL_METHODS.has(message.method)) return false;
  const p = message.params;
  if (message.method === 'mcpServer/elicitation/request') return handleCodexElicitation(root, message, { signal, emit, timeoutMs });
  if (!p || typeof p.threadId !== 'string' || typeof p.turnId !== 'string' || typeof p.itemId !== 'string') throw new WaxError('Codex 승인 요청의 세션·턴·항목 ID가 필요합니다.');
  const fileChange = message.method === 'item/fileChange/requestApproval';
  if (fileChange && (!item?.changes || !Object.keys(item.changes).length)) throw new WaxError('승인할 파일 변경 내용을 받지 못했습니다.');
  if (fileChange && p.grantRoot != null) throw new WaxError('세션 동안 디렉터리 쓰기를 허용하는 요청은 이번만 허용으로 처리할 수 없습니다.');
  if (!fileChange && !p.command && !item?.command && !p.networkApprovalContext) throw new WaxError('승인할 명령이나 네트워크 대상을 받지 못했습니다.');
  if (p.availableDecisions && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes('accept') || !p.availableDecisions.includes('decline'))) {
    throw new WaxError('이번 요청의 허용·거부 선택지를 wax가 지원하지 않습니다.');
  }
  const pending = await createApproval(root, { tool: 'codex', session: p.threadId,
    callId: p.itemId, action: fileChange ? '파일 변경' : p.networkApprovalContext ? '네트워크 접근' : '명령 실행',
    details: { ...p, ...(item ? { item } : {}) } }, { timeoutMs });
  try {
    const decision = await waitForApproval(root, pending, { signal });
    if (signal?.aborted) return true;
    await emit({ id: message.id, result: { decision: decision === 'allow' ? 'accept' : 'decline' } });
    if (decision) await finishDelivery(root, pending.request.id, pending.secret);
    return true;
  } finally { await cancelApproval(root, pending.request.id, pending.secret, 'Codex 연결 종료').catch(() => {}); }
}

async function handleCodexElicitation(root, message, { signal, emit, timeoutMs }) {
  const p = message.params;
  if (!p || typeof p.threadId !== 'string' || typeof p.serverName !== 'string' || typeof p.message !== 'string') throw new WaxError('MCP 확인 요청의 세션·서버 정보가 필요합니다.');
  if (!confirmOnly(p)) throw new WaxError('입력값이 필요한 MCP 요청은 wax에서 답할 수 없습니다. Codex 앱이나 터미널에서 진행하세요.');
  const pending = await createApproval(root, { tool: 'codex', session: p.threadId, callId: String(message.id),
    action: `MCP 도구 실행 (${p.serverName.slice(0, 60)})`, details: { serverName: p.serverName, message: p.message.slice(0, 4000), ...(p.turnId ? { turnId: p.turnId } : {}) } }, { timeoutMs });
  try {
    const decision = await waitForApproval(root, pending, { signal });
    if (signal?.aborted) return true;
    await emit({ id: message.id, result: decision === 'allow' ? { action: 'accept', content: {} } : { action: 'decline', content: null } });
    if (decision) await finishDelivery(root, pending.request.id, pending.secret);
    return true;
  } finally { await cancelApproval(root, pending.request.id, pending.secret, 'Codex 연결 종료').catch(() => {}); }
}
