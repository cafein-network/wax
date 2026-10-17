import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { WaxError } from '../workflow.mjs';

export const DESIGN_TOOLS = {
  figma: { label: 'Figma', pattern: /figma/i, read: ['get_metadata', 'get_screenshot', 'get_design_context'], write: ['use_figma'] },
  blender: { label: 'Blender', pattern: /blender/i, read: ['execute_blender_code', 'get_scene_info'], write: ['execute_blender_code'] },
};
export const STATES = ['unchecked', 'unsupported', 'not-configured', 'auth-required', 'error', 'target-mismatch', 'read-only', 'read-write', 'connected'];

export function designSupport(agent, tool) {
  if (agent === 'codex') return { ok: true, check: 'session' };
  if (agent === 'claude') return tool === 'blender' ? { ok: true, check: 'health' }
    : { ok: false, reason: 'Claude Code 세션의 Figma 화면을 wax가 직접 받아 올 방법이 없어 미리보기를 확인할 수 없습니다.', next: 'Figma 작업은 실행 도구를 Codex로 선택하세요.' };
  return { ok: false, reason: '이 실행 도구는 MCP 연결 상태를 확인할 방법을 제공하지 않아 실제 연결을 검사할 수 없습니다.', next: 'Codex 또는 Claude Code를 실행 도구로 선택하세요.' };
}

const clean = (text) => String(text ?? '').replace(/(bearer|token|authorization|api[_-]?key|secret|password)\S*\s*[:=]?\s*\S+/gi, '$1 [숨김]').slice(0, 300);

export function pickServer(names, tool, configured) {
  if (configured) return names.includes(configured) ? configured : null;
  const matches = names.filter((name) => DESIGN_TOOLS[tool].pattern.test(name));
  return matches.length === 1 ? matches[0] : matches.find((name) => name.toLowerCase() === tool) ?? null;
}

export async function openCodexMcp(root, { launch = spawn, command = ['codex', ['app-server']], requestTimeoutMs = 30_000 } = {}) {
  root = await realpath(root);
  const child = launch(command[0], command[1], { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const calls = new Map();
  let sequence = 0, fatal, threadId, diagnostics = '';
  const fail = (error) => { fatal ||= error; for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); } calls.clear(); };
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.id !== undefined && message.method) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'wax design check does not answer interactive requests' } })}\n`);
      return;
    }
    const call = message?.id !== undefined && calls.get(message.id);
    if (!call) return;
    calls.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(new WaxError(`Codex MCP 요청 실패: ${clean(message.error.message)}`)) : call.resolve(message.result);
  });
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.once('error', () => fail(new WaxError('Codex를 시작하지 못했습니다. Codex CLI 설치와 로그인을 확인하세요.')));
  child.once('exit', (code) => fail(new WaxError(`Codex 연결 종료 (exit=${code}). Codex 로그인과 설정을 확인하세요.`)));
  const rpc = (method, params, timeout = requestTimeoutMs) => {
    if (fatal) return Promise.reject(fatal);
    const id = `wax-design-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { calls.delete(id); reject(new WaxError(`Codex MCP 응답 대기 시간 초과: ${method}`)); }, timeout);
      calls.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const close = () => { fail(new WaxError('Codex MCP 연결을 닫았습니다.')); reader.close(); child.stdin.end(); child.kill(); };
  try {
    await rpc('initialize', { clientInfo: { name: 'wax', title: 'wax design', version: '0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    threadId = (await rpc('thread/start', { cwd: root, ephemeral: true })).thread.id;
  } catch (error) { close(); throw error; }
  return {
    async servers(serverName = null) {
      const result = await rpc('mcpServerStatus/list', { threadId, serverName, detail: 'toolsAndAuthOnly' }, 60_000);
      return (result.data || []).map((s) => ({ name: s.name, runtime: s.runtimeStatus ?? null, auth: s.authStatus ?? null, tools: Object.keys(s.tools || {}),
        schemas: Object.fromEntries(Object.entries(s.tools || {}).map(([name, tool]) => [name, tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : []])) }));
    },
    async call(server, tool, args = {}, timeout = 120_000) {
      const result = await rpc('mcpServer/tool/call', { threadId, server, tool, arguments: args }, timeout);
      return { isError: Boolean(result.isError), content: Array.isArray(result.content) ? result.content : [], structured: result.structuredContent ?? null };
    },
    close,
  };
}

export function codexState(server) {
  if (!server) return { state: 'not-configured' };
  if (server.runtime === 'connected') return { state: 'connected' };
  if (server.runtime === 'authenticationRequired' || server.auth === 'notLoggedIn') return { state: 'auth-required' };
  if (server.runtime === 'disabled') return { state: 'not-configured', detail: 'Codex 설정에서 꺼져 있습니다.' };
  return { state: 'error', detail: `MCP 서버 상태: ${server.runtime ?? '알 수 없음'}` };
}

export function parseClaudeMcpList(text) {
  const servers = [];
  for (const line of String(text).split('\n')) {
    const match = /^(.+?): .* - (.+)$/.exec(line.trim());
    if (!match) continue;
    const status = match[2];
    const state = /connected/i.test(status) && !/fail|not/i.test(status) ? 'connected' : /auth/i.test(status) ? 'auth-required' : /pending/i.test(status) ? 'auth-required' : 'error';
    servers.push({ name: match[1].trim(), state, detail: clean(status) });
  }
  return servers;
}

export function claudeMcpList(root, { run = execFile, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    run('claude', ['mcp', 'list'], { cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 1_000_000 }, (error, stdout) => {
      if (error && !stdout) reject(new WaxError('Claude Code의 MCP 목록을 읽지 못했습니다. Claude Code 설치와 로그인을 확인하세요.'));
      else resolve(parseClaudeMcpList(stdout));
    });
  });
}

export function acpServers(list = []) {
  if (!Array.isArray(list) || list.length > 10) throw new WaxError('MCP 서버 목록이 올바르지 않습니다.');
  return list.map((server) => {
    if (!server || typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(server.name)) throw new WaxError('MCP 서버 이름이 올바르지 않습니다.');
    if (typeof server.command !== 'string' || !/^(\/|[A-Za-z]:\\)/.test(server.command) || server.command.length > 500) throw new WaxError('MCP 서버 실행 파일은 절대 경로여야 합니다.');
    const args = server.args ?? [];
    if (!Array.isArray(args) || args.length > 20 || !args.every((arg) => typeof arg === 'string' && arg.length <= 500)) throw new WaxError('MCP 서버 인수가 올바르지 않습니다.');
    return { name: server.name, command: server.command, args, env: [] };
  });
}

export const toolText = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
export const toolImage = (result) => result.content.find((c) => c.type === 'image' && typeof c.data === 'string');
export const safeDetail = clean;
