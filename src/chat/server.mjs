import { createServer, get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LABELS, PHASES, WaxError, createFeature, getFeature } from '../workflow.mjs';
import { listChannels, postMessage, readMessages, resolveTarget } from './channels.mjs';
import { AWAY_AFTER_MS, listPresence, withDashboardUser, reserveDashboardUser } from './presence.mjs';
import { listBoard, postNote, readReport } from './board.mjs';
import { buildDigest } from './digest.mjs';
import { ChatWatcher, featureSummary } from './watcher.mjs';
import { buildDailyDraft, collectDay, readDailyReport } from './daily.mjs';
import { assignTask, getTeam, listTasks, setPm, updateTask } from './team.mjs';
import { author as validAuthor } from './validate.mjs';
import { listProfiles } from './skills.mjs';
import { listUsage } from './usage.mjs';
import { toolVersions } from './tools.mjs';
import { toolNews } from './tool-news.mjs';
import { listApprovals, decideApproval } from '../approvals.mjs';
import { requestTools as discoverRequestTools } from '../agent-tools.mjs';
import { createRequestRunner } from './requests.mjs';

const publicDir = fileURLToPath(new URL('../../web/', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
export const DEFAULT_PORT = 4330;
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const FIXED = { '/': 'home.html', '/manage': 'index.html', '/chat': 'chat.html', '/help': 'help.html', '/demo': 'workflow-demo.html', '/demo/': 'workflow-demo.html', '/office': 'office/index.html', '/office/': 'office/index.html', '/style.css': 'style.css', '/home.css': 'home.css', '/favicon.svg': 'favicon.svg' };
const STATIC_PATTERNS = [/^\/([a-z-]+\.mjs)$/, /^\/(office\/[a-z-]+\.(?:mjs|css))$/, /^\/(office\/side\/[a-z0-9-]+\.(?:png|json))$/];

function staticFile(pathname) {
  if (Object.hasOwn(FIXED, pathname)) return FIXED[pathname];
  for (const pattern of STATIC_PATTERNS) { const match = pathname.match(pattern); if (match) return match[1]; }
  return null;
}

export async function projectDescription(root) {
  const clip = (text) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat; };
  try {
    const description = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))?.description;
    if (typeof description === 'string' && description.trim()) return clip(description);
  } catch {   }
  for (const name of ['README.md', 'readme.md', 'README.ko.md']) {
    let text;
    try { text = await readFile(join(root, name), 'utf8'); } catch { continue; }
    for (const block of text.replace(/<!--[\s\S]*?-->/g, '').split(/\n\s*\n/)) {
      const line = block.trim();
      if (!line || /^(#|!\[|\[!\[|<|```|[-*|>])/.test(line)) continue;
      const plain = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
      if (plain.trim()) return clip(plain);
    }
  }
  return null;
}

async function readJson(req, maxBytes = 1_000_000) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new WaxError('JSON 요청이 필요합니다.', 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new WaxError('요청이 너무 큽니다.', 413);
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WaxError('유효한 JSON이 필요합니다.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WaxError('JSON 객체가 필요합니다.');
  return data;
}

export function createChatServer({ root, env = process.env, intervalMs = 1000, executeRequest, requestTools = discoverRequestTools } = {}) {
  const token = randomBytes(32).toString('hex');
  const user = validAuthor(env.WAX_CHAT_USER || '사람');
  let identityReady;
  const ensureIdentity = () => identityReady ??= reserveDashboardUser(root, user).catch(error => {
    identityReady = null;
    throw error;
  });
  const watcher = new ChatWatcher(root, { intervalMs });
  const clients = new Set();
  const broadcast = (event, data) => { const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(frame); };
  const requests = createRequestRunner({ root, execute: executeRequest, notify: broadcast });
  for (const event of ['message', 'note', 'report', 'presence', 'features', 'daily', 'tasks', 'approvals']) watcher.on(event, (data) => broadcast(event, data));
  watcher.on('error', (error) => console.error('wax 대시보드 감시:', error.message));
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000);
  heartbeat.unref();

  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const port = req.socket.localPort;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new WaxError('허용되지 않은 호스트입니다.', 403);
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new WaxError('동일 출처의 요청만 허용합니다.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { pathname } = url;
      if (req.method === 'GET' && pathname === '/' && (url.searchParams.has('feature') || url.searchParams.has('date'))) {
        res.writeHead(302, { location: `/manage${url.search}` }); res.end(); return;
      }

      const file = req.method === 'GET' && staticFile(pathname);
      if (file) {
        let content;
        try { content = await readFile(resolve(publicDir, file)); }
        catch (error) { if (error.code === 'ENOENT') throw new WaxError('파일이 없습니다.', 404); throw error; }
        res.writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
        res.end(content);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        json(res, 200, { name: 'wax', version, runtime: { node: process.versions.node, platform: process.platform }, project: basename(root), description: await projectDescription(root), root, token, phases: PHASES, labels: LABELS, user, awayAfterMs: AWAY_AFTER_MS, now: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/channels') { json(res, 200, await listChannels(root)); return; }
      if (req.method === 'GET' && pathname === '/api/request-tools') { json(res, 200, { tools: await requestTools() }); return; }
      if (req.method === 'GET' && pathname === '/api/requests') { json(res, 200, { requests: await requests.list() }); return; }
      if (req.method === 'GET' && pathname === '/api/approvals') { json(res, 200, await listApprovals(root)); return; }
      if (req.method === 'GET' && pathname === '/api/presence') { json(res, 200, await listPresence(root)); return; }
      if (req.method === 'GET' && pathname === '/api/features') { json(res, 200, await featureSummary(root)); return; }
      const proofRoute = pathname.match(/^\/api\/features\/([^/]+)\/proofs\/([^/]+)$/);
      if (req.method === 'GET' && proofRoute) {
        const feature = await getFeature(root, proofRoute[1]);
        const proof = (feature.proofs ?? []).find((item) => item.id === proofRoute[2]);
        if (!proof) throw new WaxError('실행 근거가 없습니다.', 404);
        json(res, 200, { feature: feature.id, proof });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/team') { json(res, 200, { ...(await getTeam(root)), tasks: await listTasks(root, { all: url.searchParams.get('all') === '1' }) }); return; }
      if (req.method === 'GET' && pathname === '/api/tools/news') { json(res, 200, await toolNews({ fresh: url.searchParams.get('fresh') === '1', enabled: env.WAX_TOOL_NEWS !== 'off' })); return; }
      if (req.method === 'GET' && pathname === '/api/tools') { json(res, 200, { tools: await toolVersions({ fresh: url.searchParams.get('fresh') === '1' }) }); return; }
      if (req.method === 'GET' && pathname === '/api/usage') { json(res, 200, await listUsage(root)); return; }
      if (req.method === 'GET' && pathname === '/api/profiles') { json(res, 200, { profiles: await listProfiles(root) }); return; }
      if (req.method === 'GET' && pathname === '/api/daily') { json(res, 200, await collectDay(root, url.searchParams.get('date') || undefined)); return; }
      if (req.method === 'GET' && pathname === '/api/daily/draft') {
        json(res, 200, { markdown: buildDailyDraft(await collectDay(root, url.searchParams.get('date') || undefined)) });
        return;
      }
      const dailyRoute = pathname.match(/^\/api\/daily\/reports\/(\d{4}-\d{2}-\d{2})\/(\d{1,2})$/);
      if (req.method === 'GET' && dailyRoute) {
        const markdown = await readDailyReport(root, dailyRoute[1], Number(dailyRoute[2]));
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end(markdown);
        return;
      }

      const channelRoute = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
      const boardRoute = pathname.match(/^\/api\/board\/([^/]+)(?:\/(notes|digest|reports\/(\d{1,3})))?$/);
      if (req.method === 'GET' && channelRoute) {
        json(res, 200, await readMessages(root, channelRoute[1], { since: url.searchParams.get('since') || undefined, limit: url.searchParams.get('limit') || undefined }));
        return;
      }
      if (req.method === 'GET' && boardRoute && !boardRoute[2]) { json(res, 200, await listBoard(root, boardRoute[1])); return; }
      if (req.method === 'GET' && boardRoute?.[2] === 'digest') {
        const feature = await resolveTarget(root, boardRoute[1]);
        const { notes, reports } = await listBoard(root, boardRoute[1]);
        json(res, 200, buildDigest({ board: boardRoute[1], title: feature?.title, notes, reports, all: url.searchParams.get('all') === '1' }));
        return;
      }
      if (req.method === 'GET' && boardRoute?.[3]) {
        const markdown = await readReport(root, boardRoute[1], Number(boardRoute[3]));
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end(markdown);
        return;
      }

      if (req.method === 'GET') throw new WaxError('찾을 수 없는 경로입니다.', 404);
      if (req.headers['x-chat-token'] !== token) throw new WaxError('세션이 만료되었습니다. 페이지를 새로고침하세요.', 403);
      await ensureIdentity();
      return await withDashboardUser(root, user, async () => {
      if (req.method === 'POST' && pathname === '/api/requests') {
        const data = await readJson(req, 40000);
        json(res, 202, await requests.submit({ id: data.id, body: data.body, author: user, tool: data.tool }));
        return;
      }
      const requestRoute = pathname.match(/^\/api\/requests\/(request-[a-f0-9-]{36})\/(reply|stop)$/);
      if (req.method === 'POST' && requestRoute) {
        const data = await readJson(req, 40000);
        json(res, 200, requestRoute[2] === 'stop' ? await requests.stop(requestRoute[1]) : await requests.reply(requestRoute[1], { body: data.body, messageId: data.messageId, resume: data.resume === true }));
        return;
      }
      const approvalRoute = pathname.match(/^\/api\/approvals\/([a-f0-9-]{36})\/decision$/);
      if (req.method === 'POST' && approvalRoute) {
        const data = await readJson(req, 4096);
        const result = await decideApproval(root, approvalRoute[1], { decision: data.decision, fingerprint: data.fingerprint, actor: user });
        broadcast('approvals', {});
        json(res, 200, result);
        return;
      }
      if (req.method === 'POST' && channelRoute) {
        const data = await readJson(req);
        json(res, 201, await postMessage(root, channelRoute[1], { author: user, kind: 'human', body: data.body, type: data.type, replyTo: data.replyTo, to: data.to }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/features') {
        const data = await readJson(req);
        json(res, 201, await createFeature(root, { id: data.id, title: data.title, description: data.description ?? '' }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/team/pm') {
        const data = await readJson(req);
        json(res, 200, await setPm(root, data.self ? { author: user, kind: 'human', replace: data.replace === true } : { author: data.author || undefined, kind: data.kind || undefined, replace: data.replace === true }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/tasks') {
        const data = await readJson(req);
        json(res, 201, await assignTask(root, { author: user, kind: 'human', feature: data.feature, to: data.to, phase: data.phase, body: data.body }));
        return;
      }
      const taskRoute = pathname.match(/^\/api\/tasks\/(t-\d{6,}-[0-9a-f]{6})\/(accept|done|block|cancel)$/);
      if (req.method === 'POST' && taskRoute) {
        const data = await readJson(req);
        json(res, 200, await updateTask(root, taskRoute[1], taskRoute[2], { author: user, kind: 'human', body: data.body }));
        return;
      }
      if (req.method === 'POST' && boardRoute?.[2] === 'notes') {
        const data = await readJson(req);
        json(res, 201, await postNote(root, boardRoute[1], { author: user, kind: 'human', body: data.body, type: data.type, stance: data.stance, replyTo: data.replyTo }));
        return;
      }
      throw new WaxError('찾을 수 없는 경로입니다.', 404);
      });
    } catch (error) {
      const status = error instanceof WaxError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 && !(error instanceof WaxError) ? '서버 오류가 발생했습니다.' : error.message });
      else res.end();
    }
  });

  server.startWatching = async () => {
    try { await ensureIdentity(); } catch (error) { watcher.emit('error', error); }
    return watcher.start();
  };
  server.watcher = watcher;
  server.requests = requests;
  server.shutdown = async () => {
    await requests.close();
    watcher.stop();
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(() => done()));
  };
  return server;
}

export function probeDashboard(port, { timeoutMs = 1500 } = {}) {
  return new Promise((done) => {
    const request = get({ host: '127.0.0.1', port, path: '/api/config', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const config = JSON.parse(body);
          done(config?.name === 'wax' ? { project: config.project, root: config.root ?? null, version: config.version, url: `http://127.0.0.1:${port}/` } : null);
        } catch { done(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => done(null));
  });
}

export async function startServer({ root, env = process.env, port = DEFAULT_PORT }) {
  const server = createChatServer({ root, env });
  await server.startWatching();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  const actual = server.address().port;
  console.log(`wax 대시보드 → http://127.0.0.1:${actual}/  ·  채널 /chat  ·  가상 사무실 /office\n프로젝트: ${root}\n종료: Ctrl+C`);
  const stop = async () => { await server.shutdown(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}
