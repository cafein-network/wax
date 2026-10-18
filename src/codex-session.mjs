import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { handleCodexApproval, CODEX_APPROVAL_METHODS } from './approval-hosts.mjs';
import { WaxError } from './workflow.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export function codexExitMessage(code, diagnostics = '') {
  if (/Could not find home directory/i.test(diagnostics)) return 'Codex가 사용자 홈 폴더를 찾지 못했습니다. 대시보드가 제한된 계정으로 실행된 경우입니다. 평소 로그인한 사용자 계정에서 대시보드를 다시 열고 이어서 진행을 눌러주세요. 플러그인을 다시 설치할 필요는 없습니다.';
  if (/not logged in|please (?:log|sign) in|unauthorized|authentication failed|\b401\b/i.test(diagnostics)) return 'Codex 로그인을 확인하지 못했습니다. 대시보드를 실행한 계정에서 codex login으로 로그인한 뒤 이어서 진행을 눌러주세요.';
  if (/access is denied|permission denied|os error 5|EACCES/i.test(diagnostics)) return 'Codex가 설정 또는 작업 폴더에 접근하지 못했습니다. 평소 로그인한 계정에서 대시보드를 실행하고 폴더 접근 권한을 확인해 주세요.';
  return `Codex 연결 종료 (exit=${code}). 대시보드를 실행한 계정에서 Codex 설치·로그인 상태와 설정을 확인해 주세요.`;
}

async function codexCommand(executable) {
  if (executable) return executable.endsWith('.js') ? [process.execPath, [executable, 'app-server']] : [executable, ['app-server']];
  if (process.platform !== 'win32') return ['codex', ['app-server']];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const file of [join(dir, 'codex.exe'), join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) {
      try { await access(file); return file.endsWith('.js') ? [process.execPath, [file, 'app-server']] : [file, ['app-server']]; } catch {   }
    }
  }
  throw new WaxError('Codex 실행 파일을 찾지 못했습니다. --executable로 codex.exe 또는 codex.js 경로를 지정하세요.');
}

export async function runCodexSession(root, { prompt, thread, executable, signal, output = (text) => process.stdout.write(text),
  log = (text) => process.stderr.write(text), launch = spawn, requestTimeoutMs = 30_000, approvalTimeoutMs = 120_000, outputSchema } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) throw new WaxError('비어 있지 않은 100000자 이하의 --prompt가 필요합니다.');
  root = await realpath(root);
  const [command, args] = await codexCommand(executable);
  const child = launch(command, args, { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const closed = new Promise((done) => child.once('close', () => { exited = true; done(); }));
  const reader = createInterface({ input: child.stdout });
  const calls = new Map(), approvals = new Map(), items = new Map(), completions = new Map();
  let sequence = 0, threadId, turnId, closing = false, fatal, messageText = '', diagnostics = '';
  let resolveTurn, rejectTurn;
  const turnDone = new Promise((done, fail) => { resolveTurn = done; rejectTurn = fail; });
  turnDone.catch(() => {});
  const key = (p, id) => JSON.stringify([p.threadId, p.turnId, id]);
  const send = (message) => new Promise((done, fail) => {
    if (closing || child.stdin.destroyed) { fail(new Error('Codex 연결이 종료되었습니다.')); return; }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? fail(error) : done());
  });
  const fail = (error) => {
    fatal ||= error;
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
    calls.clear();
    for (const request of approvals.values()) request.controller.abort();
    rejectTurn(error);
  };
  const rpc = (method, params) => {
    if (fatal) return Promise.reject(fatal);
    const id = `wax-${++sequence}`;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Codex 응답 대기 시간 초과: ${method}`)); }, requestTimeoutMs);
      calls.set(id, { resolve: done, reject, timer });
      send({ id, method, params }).catch((error) => { clearTimeout(timer); calls.delete(id); reject(error); });
    });
  };
  const finishTurn = () => {
    const turn = completions.get(turnId);
    if (!turn) return;
    if (turn.status === 'completed') resolveTurn({ threadId, turnId, status: turn.status, message: messageText });
    else rejectTurn(new Error(turn.error?.message || `Codex 작업 ${turn.status}`));
  };
  reader.on('line', (line) => {
    let message;
    try {
      if (line.length > 2_000_000) throw new Error('Codex 메시지 크기 제한 초과');
      if (!line.trim()) return;
      if (!line.trimStart().startsWith('{')) { log(`Codex stdout 안내: ${line.slice(0, 2000)}\n`); return; }
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('잘못된 Codex 메시지');
    }
    catch (error) { fail(error); return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const call = calls.get(message.id);
      if (call) { calls.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
      return;
    }
    const p = message.params || {};
    if (Object.hasOwn(message, 'id') && message.method) {
      if (!CODEX_APPROVAL_METHODS.has(message.method)) {
        log(`wax: 지원하지 않는 Codex 사용자 요청 ${message.method}. 원래 Codex 인터페이스에서 진행하세요.\n`);
        send({ id: message.id, error: { code: -32601, message: 'wax does not support this user interaction; no permission granted' } }).catch(fail);
        return;
      }
      if (p.threadId !== threadId || (turnId && p.turnId != null && p.turnId !== turnId) || (turnId && p.turnId == null && message.method !== 'mcpServer/elicitation/request') || approvals.has(message.id)) {
        fail(new Error('Codex 승인 요청의 세션 또는 요청 ID가 일치하지 않습니다.')); return;
      }
      const controller = new AbortController();
      let replied = false;
      const request = { controller, turnId: p.turnId, itemId: p.itemId, promise: null };
      approvals.set(message.id, request);
      request.promise = handleCodexApproval(root, message, { item: items.get(key(p, p.itemId)), signal: controller.signal,
        timeoutMs: approvalTimeoutMs, emit: async (reply) => { if (controller.signal.aborted) throw new Error('Codex 요청이 종료되었습니다.'); replied = true; await send(reply); } })
        .catch(async (error) => {
          log(`wax 승인 연결: ${error.message}\n`);
          if (!replied && !controller.signal.aborted && !closing) await send({ id: message.id, result: message.method === 'mcpServer/elicitation/request' ? { action: 'decline', content: null } : { decision: 'decline' } }).catch(fail);
        }).finally(() => approvals.delete(message.id));
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      if (p.threadId === threadId) approvals.get(p.requestId)?.controller.abort();
      return;
    }
    if (p.threadId !== threadId) return;
    if (message.method === 'item/started' && p.item) items.set(key(p, p.item.id), p.item);
    if (message.method === 'item/completed' && p.item) {
      if (p.item.type === 'agentMessage' && typeof p.item.text === 'string') messageText = p.item.text;
      items.delete(key(p, p.item.id));
      for (const request of approvals.values()) if (request.turnId === p.turnId && request.itemId === p.item.id) request.controller.abort();
    }
    if (message.method === 'item/agentMessage/delta') output(p.delta || '');
    if (message.method === 'turn/completed' && p.turn) {
      completions.set(p.turn.id, p.turn);
      for (const request of approvals.values()) if (request.turnId === p.turn.id) request.controller.abort();
      finishTurn();
    }
  });
  child.stderr.on('data', (chunk) => { const text = chunk.toString(); diagnostics = (diagnostics + text).slice(-12000); log(text); });
  child.stdin.on('error', fail);
  child.once('error', fail);
  child.once('exit', (code) => { if (!closing) fail(new Error(codexExitMessage(code, diagnostics))); });
  const abort = () => {
    if (threadId && turnId) send({ id: `wax-interrupt-${++sequence}`, method: 'turn/interrupt', params: { threadId, turnId } }).catch(() => {});
    fail(new Error('사용자가 Codex 작업을 중단했습니다.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Codex 작업이 중단되었습니다.');
    await rpc('initialize', { clientInfo: { name: 'wax', title: 'wax approvals', version } });
    await send({ method: 'initialized', params: {} });
    const result = await rpc(thread ? 'thread/resume' : 'thread/start', { ...(thread ? { threadId: thread } : {}), cwd: root });
    threadId = result.thread.id;
    log(`wax Codex 세션: ${threadId}\n승인 요청은 이 프로젝트의 wax 대화창에서 처리합니다.\n`);
    const started = await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }], ...(outputSchema ? { outputSchema } : {}) });
    turnId = started.turn.id; finishTurn();
    return await turnDone;
  } finally {
    closing = true;
    signal?.removeEventListener('abort', abort);
    for (const request of approvals.values()) request.controller.abort();
    await Promise.allSettled([...approvals.values()].map((request) => request.promise));
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('Codex 연결 종료')); }
    calls.clear(); reader.close(); child.stdin.end(); child.kill();
    if (child.pid && !exited) {
      let timer;
      try {
        await Promise.race([closed, new Promise((done) => { timer = setTimeout(done, 3000); })]);
        if (!exited) { child.kill('SIGKILL'); await Promise.race([closed, new Promise((done) => { timer = setTimeout(done, 3000); })]); }
      } finally { clearTimeout(timer); }
      if (!exited) throw new Error('Codex 프로세스 종료를 확인하지 못했습니다. 실행 상태를 확인하세요.');
    }
  }
}
