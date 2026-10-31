import { t } from '../../web/messages-catalog.mjs';
import { createServer, get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LABELS, PHASES, WaxError, createFeature, getFeature } from '../workflow.mjs';
import { listChannels, postMessage, readMessages, resolveTarget } from './channels.mjs';
import { AWAY_AFTER_MS, listPresence, withDashboardUser, reserveDashboardUser, storedDashboardUser } from './presence.mjs';
import { listBoard, postNote, readReport } from './board.mjs';
import { buildDigest } from './digest.mjs';
import { ChatWatcher, featureSummary } from './watcher.mjs';
import { createEventHub } from './event-hub.mjs';
import { buildDailyDraft, collectDay, readDailyReport } from './daily.mjs';
import { assignTask, getTeam, listTasks, setPm, updateTask } from './team.mjs';
import { author as validAuthor } from './validate.mjs';
import { listProfiles } from './skills.mjs';
import { buildSkillMap } from './skill-map.mjs';
import { collectWorkNotes } from './work-notes.mjs';
import { decideRule, listRules, ruleCandidates } from './rules.mjs';
import { ingest as wikiIngest, lint as wikiLint, readPage as readWikiPage } from '../wiki.mjs';
import { listUsage } from './usage.mjs';
import { toolVersions } from './tools.mjs';
import { toolNews } from './tool-news.mjs';
import { listApprovals, decideApproval } from '../approvals.mjs';
import { requestTools as discoverRequestTools } from '../agent-tools.mjs';
import { createRequestRunner } from './requests.mjs';
import { search as searchRecords, indexStatus } from '../search.mjs';
import { spawn } from 'node:child_process';
import { createDesignRunner, versionPreview } from './design.mjs';
import { artifactFile } from '../quality.mjs';
import { createTreeObserver } from '../freshness.mjs';
import { buildRunTrace } from '../run-trace.mjs';
import { CAPTURE_IMAGE_TYPES, captureImageFile } from '../capture.mjs';
import { detectProjectType } from '../project-detect.mjs';
import { createGoal, createPmLoop, dismissSuggestion, executeSuggestion, goalOverview, pmLoopOverview, resumeGoal, setJudgeTool, setMode, stopGoal } from './pm-loop.mjs';
import { acceptProposal, createTriggerScheduler, deleteTrigger, dismissProposal, listProposals, saveTrigger, setTriggerEnabled, triggerOverview } from './triggers.mjs';

const publicDir = fileURLToPath(new URL('../../web/', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
export const DEFAULT_PORT = 4330;
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const FIXED = { '/': 'chat.html', '/start': 'home.html', '/manage': 'index.html', '/chat': 'chat.html', '/help': 'help.html', '/demo': 'workflow-demo.html', '/demo/': 'workflow-demo.html', '/office': 'office/index.html', '/office/': 'office/index.html', '/search': 'search.html', '/style.css': 'style.css', '/home.css': 'home.css', '/favicon.svg': 'favicon.svg' };
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

async function readJson(req, maxBytes = 64_000) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new WaxError(t('errors.chat.server.aJsonRequestIs'), 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new WaxError(t('errors.chat.server.theRequestIsToo'), 413);
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WaxError(t('errors.chat.server.validJsonIsRequired')); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WaxError(t('errors.chat.server.aJsonObjectIs'));
  return data;
}

export function createChatServer({ root, env = process.env, intervalMs = 1000, executeRequest, executeDesign, executeWorker, executeJudge, designMcp, requestTools = discoverRequestTools, triggerClock, gh, pmClock, pmStaleMs, workerTimeoutMs, judgeTimeoutMs } = {}) {
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const validToken = (header) => {
    if (typeof header !== 'string') return false;
    const bytes = Buffer.from(header);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };
  const user = validAuthor(env.WAX_CHAT_USER || storedDashboardUser(root) || '대표');
  const onePerson = (agents) => agents.filter((agent) => agent.kind !== 'human' || agent.author === user);
  let identityReady;
  const ensureIdentity = () => identityReady ??= reserveDashboardUser(root, user).catch(error => {
    identityReady = null;
    throw error;
  });
  const watcher = new ChatWatcher(root, { intervalMs });
  const events = createEventHub();
  const broadcast = events.broadcast;
  const requests = createRequestRunner({ root, execute: executeRequest, notify: broadcast });
  const design = createDesignRunner({ root, execute: executeDesign, mcp: designMcp, notify: broadcast });
  const triggers = createTriggerScheduler({ root, notify: broadcast, intervalMs, now: triggerClock, ...(gh ? { gh } : {}), onError: (error) => console.error('wax 트리거:', error.message) });
  const pmLoop = createPmLoop({ root, notify: broadcast, intervalMs, now: pmClock, staleMs: pmStaleMs, user, listTools: requestTools,
    ...(executeWorker ? { execute: executeWorker } : {}), ...(executeJudge ? { executeJudge } : {}), ...(workerTimeoutMs ? { workerTimeoutMs } : {}), ...(judgeTimeoutMs ? { judgeTimeoutMs } : {}),
    onError: (error) => console.error('wax PM 루프:', error.message) });
  for (const event of ['features', 'tasks', 'presence']) watcher.on(event, () => pmLoop.poke());
  const pmOptions = async () => ({ ...(pmClock ? { now: pmClock() } : {}), ...(pmStaleMs ? { staleMs: pmStaleMs } : {}), tools: await pmLoop.tools().catch(() => []) });
  for (const event of ['message', 'note', 'report', 'presence', 'features', 'daily', 'tasks', 'approvals', 'rules', 'wiki']) watcher.on(event, (data) => broadcast(event, event === 'presence' ? { ...data, agents: onePerson(data.agents) } : data));
  watcher.on('error', (error) => console.error('wax 대시보드 감시:', error.message));
  const heartbeat = setInterval(() => events.ping(), 15_000);
  heartbeat.unref();

  let indexJob = null;
  const startIndexJob = (rebuild) => {
    if (indexJob?.running) return indexJob;
    const job = indexJob = { running: true, rebuild, startedAt: new Date().toISOString(), error: null, result: null };
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/wax.mjs', import.meta.url)), '--project', root, 'search', 'index', ...(rebuild ? ['--rebuild'] : []), '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', (code) => {
      job.running = false; job.finishedAt = new Date().toISOString();
      try { if (code === 0) job.result = JSON.parse(stdout); else job.error = stderr.replace(/^wax search:\s*/, '').trim() || `색인 작업이 끝나지 않았습니다 (exit=${code}).`; }
      catch { job.error = '색인 결과를 읽지 못했습니다.'; }
      broadcast('search', { running: false });
    });
    child.on('error', () => { job.running = false; job.error = '색인 작업을 시작하지 못했습니다.'; broadcast('search', { running: false }); });
    broadcast('search', { running: true });
    return job;
  };

  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const port = req.socket.localPort;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new WaxError(t('errors.chat.server.hostNotAllowed'), 403);
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new WaxError(t('errors.chat.server.onlySameOriginRequests'), 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { pathname } = url;
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite) && (req.method !== 'GET' || pathname.startsWith('/api/'))) {
        throw new WaxError(t('errors.chat.server.onlySameOriginRequests'), 403);
      }
      if (req.method === 'GET' && pathname === '/' && (url.searchParams.has('feature') || url.searchParams.has('date'))) {
        res.writeHead(302, { location: `/manage${url.search}` }); res.end(); return;
      }
      if (req.method === 'GET' && pathname === '/' && (url.searchParams.has('mode') || url.searchParams.has('request'))) {
        res.writeHead(302, { location: `/start${url.search}` }); res.end(); return;
      }

      const file = req.method === 'GET' && staticFile(pathname);
      if (file) {
        let content;
        try { content = await readFile(resolve(publicDir, file)); }
        catch (error) { if (error.code === 'ENOENT') throw new WaxError(t('errors.chat.server.fileNotFound'), 404); throw error; }
        res.writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
        res.end(content);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        json(res, 200, { name: 'wax', version, runtime: { node: process.versions.node, platform: process.platform }, project: basename(root), description: await projectDescription(root), repoType: await detectProjectType(root), root, token, phases: PHASES, labels: LABELS, user, awayAfterMs: AWAY_AFTER_MS, now: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        req.on('close', events.connect(res, req.headers['last-event-id']));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/channels') { json(res, 200, await listChannels(root)); return; }
      if (req.method === 'GET' && pathname === '/api/request-tools') { json(res, 200, { tools: await requestTools() }); return; }
      if (req.method === 'GET' && pathname === '/api/requests') {
        const pending = (await listApprovals(root)).requests.filter((approval) => approval.status === 'pending');
        json(res, 200, { requests: await requests.list({ approvals: pending }) }); return;
      }
      if (req.method === 'GET' && pathname === '/api/approvals') { json(res, 200, await listApprovals(root)); return; }
      if (req.method === 'GET' && pathname === '/api/presence') { json(res, 200, onePerson(await listPresence(root))); return; }
      if (req.method === 'GET' && pathname === '/api/features') { json(res, 200, await featureSummary(root)); return; }
      if (req.method === 'GET' && pathname === '/api/search') {
        const q = url.searchParams;
        const result = await searchRecords(root, { query: q.get('q') ?? '', kind: q.get('kind') || undefined, feature: q.get('feature') || undefined, author: q.get('author') || undefined,
          phase: q.get('phase') || undefined, from: q.get('from') || undefined, to: q.get('to') || undefined, cursor: q.get('cursor') || undefined, limit: q.get('limit') || undefined }, { sync: !indexJob?.running });
        json(res, 200, result);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/search/status') {
        const running = indexJob?.running;
        let status = await indexStatus(root);
        if (running && !indexJob.running) status = await indexStatus(root);
        json(res, 200, { ...status, job: indexJob }); return;
      }
      if (req.method === 'GET' && pathname === '/api/design') { json(res, 200, await design.list()); return; }
      const previewRoute = pathname.match(/^\/api\/design\/jobs\/(design-[a-f0-9-]{36})\/versions\/([1-9][0-9]{0,3})\/preview$/);
      if (req.method === 'GET' && previewRoute) {
        const path = await versionPreview(root, previewRoute[1], Number(previewRoute[2]));
        res.writeHead(200, { 'content-type': { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extname(path).toLowerCase()], 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
        res.end(await readFile(path));
        return;
      }
      const artifactRoute = pathname.match(/^\/api\/features\/([a-z0-9-]+)\/artifacts\/design-preview$/);
      if (req.method === 'GET' && artifactRoute) {
        const feature = await getFeature(root, artifactRoute[1]);
        const preview = feature.completed.design?.checks?.find(check => check.id === 'design-preview' && check.status === 'pass');
        const path = preview && await artifactFile(root, preview.artifact);
        if (!path) throw new WaxError(t('errors.chat.server.theRegisteredDesignPreview'), 404);
        const extension = extname(path).toLowerCase();
        res.setHeader('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        if (['.blend', '.rbxl', '.rbxlx'].includes(extension)) res.setHeader('content-disposition', `attachment; filename="preview${extension}"`);
        res.writeHead(200, { 'content-type': MIME[extension] || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4' })[extension] || 'application/octet-stream' });
        res.end(await readFile(path)); return;
      }
      const captureRoute = pathname.match(/^\/api\/features\/([a-z0-9-]+)\/captures\/([a-z]+-[0-9]+)\/([^/]+)$/);
      if (req.method === 'GET' && captureRoute) {
        const path = await captureImageFile(root, captureRoute[1], captureRoute[2], captureRoute[3]);
        if (!path) throw new WaxError(t('errors.chat.server.noCaptureImage'), 404);
        res.writeHead(200, { 'content-type': CAPTURE_IMAGE_TYPES[extname(path).toLowerCase()], 'content-security-policy': "default-src 'none'; sandbox" });
        res.end(await readFile(path)); return;
      }
      const proofsRoute = pathname.match(/^\/api\/features\/([a-z0-9-]+)\/proofs$/);
      if (req.method === 'GET' && proofsRoute) {
        const feature = await getFeature(root, proofsRoute[1]);
        const observe = createTreeObserver(root), changed = new Map();
        for (const proof of feature.proofs ?? []) if (proof.tree) { const seen = await observe(proof.tree); changed.set(proof.id, { state: seen.state, count: seen.files.length, files: seen.files.slice(0, 10) }); }
        json(res, 200, { feature: feature.id, proofs: (feature.proofs ?? []).map((proof) => ({
          id: proof.id, kind: proof.kind, phase: proof.phase, iteration: proof.iteration, at: proof.at, commit: proof.commit ?? null,
          ...(proof.kind === 'test' ? { exitCode: proof.exitCode ?? null, timedOut: Boolean(proof.timedOut), durationMs: proof.durationMs ?? null, command: Array.isArray(proof.command) ? proof.command.join(' ').slice(0, 300) : '', verification: proof.verification ?? null } : {}),
          ...(proof.kind === 'git' ? { files: Array.isArray(proof.files) ? proof.files.length : 0 } : {}),
          ...(changed.has(proof.id) ? { changed: changed.get(proof.id) } : {}),
        })) });
        return;
      }
      const traceRoute = pathname.match(/^\/api\/features\/([a-z0-9-]+)\/trace$/);
      if (req.method === 'GET' && traceRoute) {
        json(res, 200, await buildRunTrace(root, traceRoute[1], { language: url.searchParams.get('lang') === 'en' ? 'en' : 'ko' }));
        return;
      }
      const proofRoute = pathname.match(/^\/api\/features\/([^/]+)\/proofs\/([^/]+)$/);
      if (req.method === 'GET' && proofRoute) {
        const feature = await getFeature(root, proofRoute[1]);
        const proof = (feature.proofs ?? []).find((item) => item.id === proofRoute[2]);
        if (!proof) throw new WaxError(t('errors.chat.server.noExecutionEvidence'), 404);
        json(res, 200, { feature: feature.id, proof });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/team') { json(res, 200, { ...(await getTeam(root)), tasks: await listTasks(root, { all: url.searchParams.get('all') === '1' }) }); return; }
      if (req.method === 'GET' && pathname === '/api/tools/news') { json(res, 200, await toolNews({ enabled: env.WAX_TOOL_NEWS !== 'off' })); return; }
      if (req.method === 'GET' && pathname === '/api/tools') { json(res, 200, { tools: await toolVersions() }); return; }
      if (req.method === 'GET' && pathname === '/api/usage') { json(res, 200, await listUsage(root)); return; }
      if (req.method === 'GET' && pathname === '/api/profiles') { json(res, 200, { profiles: await listProfiles(root) }); return; }
      if (req.method === 'GET' && pathname === '/api/skills/map') { json(res, 200, await buildSkillMap(root)); return; }
      if (req.method === 'GET' && pathname === '/api/wiki') {
        const pages = (await wikiLint(root)).map(({ slug, title, path, problems }) => ({ slug, title, path, errors: problems.filter((p) => p.level === 'error').length, warnings: problems.filter((p) => p.level === 'warning').length, problems }));
        json(res, 200, { pages, pending: (await wikiIngest(root, { batch: 1 })).pending });
        return;
      }
      const wikiRoute = pathname.match(/^\/api\/wiki\/([a-z0-9][a-z0-9-]{0,63})$/);
      if (req.method === 'GET' && wikiRoute) { json(res, 200, await readWikiPage(root, wikiRoute[1])); return; }
      if (req.method === 'GET' && pathname === '/api/triggers') { json(res, 200, await triggerOverview(root)); return; }
      if (req.method === 'GET' && pathname === '/api/proposals') { json(res, 200, { proposals: await listProposals(root, { all: url.searchParams.get('all') === '1' }) }); return; }
      if (req.method === 'GET' && pathname === '/api/pm-loop') { json(res, 200, await pmLoopOverview(root, { user, ...await pmOptions() })); return; }
      const pmGoalRoute = pathname.match(/^\/api\/pm-loop\/(goal-[a-f0-9]{8})$/);
      if (req.method === 'GET' && pmGoalRoute) { json(res, 200, await goalOverview(root, pmGoalRoute[1], { user, ...await pmOptions() })); return; }
      if (req.method === 'GET' && pathname === '/api/rules') { json(res, 200, { rules: await listRules(root, { all: true }), candidates: (await ruleCandidates(root)).length }); return; }
      const notesRoute = pathname.match(/^\/api\/work-notes\/([^/]+)$/);
      if (req.method === 'GET' && notesRoute) {
        let name;
        try { name = decodeURIComponent(notesRoute[1]); } catch { throw new WaxError(t('errors.chat.server.theMemberNameIs')); }
        const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 7;
        json(res, 200, await collectWorkNotes(root, name, { days }));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/daily') { const day = await collectDay(root, url.searchParams.get('date') || undefined); json(res, 200, { ...day, agents: onePerson(day.agents) }); return; }
      if (req.method === 'GET' && pathname === '/api/daily/draft') {
        const day = await collectDay(root, url.searchParams.get('date') || undefined);
        json(res, 200, { markdown: buildDailyDraft({ ...day, agents: onePerson(day.agents) }) });
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
        json(res, 200, await readMessages(root, channelRoute[1], { since: url.searchParams.get('since') || undefined, id: url.searchParams.get('id') || undefined, limit: url.searchParams.get('limit') || undefined }));
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

      if (req.method === 'GET') throw new WaxError(t('errors.chat.server.pathNotFound'), 404);
      if (!validToken(req.headers['x-chat-token'])) throw new WaxError(t('errors.chat.server.theSessionHasExpired'), 403);
      if (req.method === 'POST' && pathname === '/api/tools/refresh') { await readJson(req, 1000); json(res, 200, { tools: await toolVersions({ fresh: true }) }); return; }
      if (req.method === 'POST' && pathname === '/api/tools/news/refresh') { await readJson(req, 1000); json(res, 200, await toolNews({ fresh: true, enabled: env.WAX_TOOL_NEWS !== 'off' })); return; }
      await ensureIdentity();
      return await withDashboardUser(root, user, async () => {
      const ruleRoute = pathname.match(/^\/api\/rules\/(r-[0-9]{6}-[a-f0-9]{6})\/(approve|reject|retire)$/);
      if (req.method === 'POST' && ruleRoute) {
        const data = await readJson(req, 4000);
        const result = await decideRule(root, ruleRoute[1], ruleRoute[2], { author: user, note: data.note });
        broadcast('rules', {});
        json(res, 200, result);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/triggers') {
        const data = await readJson(req, 16000);
        const trigger = await saveTrigger(root, data, { author: user });
        triggers.poke();
        broadcast('triggers', {});
        json(res, 200, trigger);
        return;
      }
      const triggerRoute = pathname.match(/^\/api\/triggers\/(trg-[a-z0-9-]{1,40})\/(enable|disable|delete)$/);
      if (req.method === 'POST' && triggerRoute) {
        await readJson(req, 1000);
        const result = triggerRoute[2] === 'delete' ? await deleteTrigger(root, triggerRoute[1], { author: user }) : await setTriggerEnabled(root, triggerRoute[1], triggerRoute[2] === 'enable', { author: user });
        if (triggerRoute[2] === 'enable') triggers.poke();
        broadcast('triggers', {});
        json(res, 200, result);
        return;
      }
      const proposalRoute = pathname.match(/^\/api\/proposals\/(proposal-[a-f0-9-]{36})\/(accept|dismiss)$/);
      if (req.method === 'POST' && proposalRoute) {
        const data = await readJson(req, 16000);
        const result = proposalRoute[2] === 'accept'
          ? await acceptProposal(root, proposalRoute[1], { author: user, text: data.text, tool: data.tool, mode: data.mode, submit: requests.submit })
          : await dismissProposal(root, proposalRoute[1], { author: user });
        broadcast('proposals', {});
        json(res, 200, result);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/pm-loop') {
        const data = await readJson(req, 16000);
        const goal = await createGoal(root, { title: data.title, features: data.features, create: data.create, budgets: data.budgets, judgeTool: data.judgeTool }, { author: user });
        pmLoop.poke();
        json(res, 201, goal);
        return;
      }
      const pmActionRoute = pathname.match(/^\/api\/pm-loop\/(goal-[a-f0-9]{8})\/(execute|dismiss|stop|resume|settings)$/);
      if (req.method === 'POST' && pmActionRoute) {
        const [, id, action] = pmActionRoute;
        const data = await readJson(req, action === 'execute' ? 256_000 : 4000);
        const options = { author: user, ...await pmOptions() };
        const result = action === 'execute' ? await executeSuggestion(root, id, data.key, { ...options, workers: pmLoop.workers, judges: pmLoop.judges, tool: data.tool, to: data.to, proposal: data.proposal })
          : action === 'dismiss' ? await dismissSuggestion(root, id, data.key, { ...options, reason: data.reason })
          : action === 'settings' ? ('mode' in data ? await setMode(root, id, { author: user, mode: data.mode }) : await setJudgeTool(root, id, { author: user, tool: data.judgeTool }))
          : action === 'stop' ? await stopGoal(root, id, { ...options, reason: data.reason }) : await resumeGoal(root, id, { ...options, budgets: data.budgets });
        if (action === 'stop') { void pmLoop.workers.stopGoal(id, user); void pmLoop.judges.stopGoal(id, user); }
        pmLoop.poke();
        json(res, 200, result);
        return;
      }
      const pmWorkerRoute = pathname.match(/^\/api\/pm-loop\/(goal-[a-f0-9]{8})\/workers\/(pw-[a-f0-9]{8})\/stop$/);
      if (req.method === 'POST' && pmWorkerRoute) {
        await readJson(req, 1000);
        const [, id, worker] = pmWorkerRoute;
        const view = await goalOverview(root, id, { user, ...await pmOptions() });
        const run = view.workers.find((item) => item.id === worker);
        if (!run) throw new WaxError(t('errors.pmLoop.workerNotFound', worker), 404);
        const job = pmLoop.workers.stop(worker, user);
        if (!job) throw new WaxError(t('errors.pmLoop.workerElsewhere', worker), 409);
        await job;
        pmLoop.poke();
        json(res, 200, { goal: id, worker, stopped: true });
        return;
      }
      const pmJudgeRoute = pathname.match(/^\/api\/pm-loop\/(goal-[a-f0-9]{8})\/judgments\/(pj-[a-f0-9]{8})\/stop$/);
      if (req.method === 'POST' && pmJudgeRoute) {
        await readJson(req, 1000);
        const [, id, judge] = pmJudgeRoute;
        const view = await goalOverview(root, id, { user, ...await pmOptions() });
        if (!view.judgments.some((item) => item.id === judge)) throw new WaxError(t('errors.pmLoop.judgeNotFound', judge), 404);
        const job = pmLoop.judges.stop(judge, user);
        if (!job) throw new WaxError(t('errors.pmLoop.judgeElsewhere', judge), 409);
        await job;
        pmLoop.poke();
        json(res, 200, { goal: id, judge, stopped: true });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/requests') {
        const data = await readJson(req, 40000);
        json(res, 202, await requests.submit({ id: data.id, body: data.body, author: user, tool: data.tool, mode: data.mode, projectType: data.projectType }));
        return;
      }
      const requestRoute = pathname.match(/^\/api\/requests\/(request-[a-f0-9-]{36})\/(reply|stop)$/);
      if (req.method === 'POST' && requestRoute) {
        const data = await readJson(req, 40000);
        json(res, 200, requestRoute[2] === 'stop' ? await requests.stop(requestRoute[1]) : await requests.reply(requestRoute[1], { body: data.body, messageId: data.messageId, resume: data.resume === true, approveWorkflow: data.approveWorkflow === true, workflowRevision: data.workflowRevision }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/design/targets') {
        const data = await readJson(req, 8000);
        const target = await design.saveTarget({ id: data.id, tool: data.tool, label: data.label, server: data.server, url: data.url, file: data.file, scene: data.scene, collection: data.collection });
        broadcast('design', {});
        json(res, 200, target);
        return;
      }
      const checkRoute = pathname.match(/^\/api\/design\/targets\/(target-[a-f0-9]{8})\/check$/);
      if (req.method === 'POST' && checkRoute) {
        const data = await readJson(req, 1000);
        const result = await design.check(checkRoute[1], data.agent);
        broadcast('design', {});
        json(res, 200, result);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/design/jobs') {
        const data = await readJson(req, 12000);
        json(res, 202, await design.submit({ targetId: data.targetId, agent: data.agent, title: data.title, brief: data.brief, feature: data.feature || undefined, clientId: data.clientId, author: user }));
        return;
      }
      const jobRoute = pathname.match(/^\/api\/design\/jobs\/(design-[a-f0-9-]{36})\/(feedback|approve|reopen|handoff|stop|resume)$/);
      if (req.method === 'POST' && jobRoute) {
        const data = await readJson(req, 12000), [, id, action] = jobRoute;
        const input = { version: data.version, revision: data.revision, author: user };
        json(res, 200, action === 'feedback' ? await design.feedback(id, { ...input, text: data.text, clientId: data.clientId })
          : action === 'approve' ? await design.approve(id, input) : action === 'reopen' ? await design.reopen(id, input) : action === 'handoff' ? await design.handoff(id, input)
          : action === 'stop' ? await design.stop(id) : await design.resume(id));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/search/index') {
        const data = await readJson(req, 1000);
        json(res, 202, startIndexJob(data.rebuild === true));
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
      throw new WaxError(t('errors.chat.server.pathNotFound'), 404);
      });
    } catch (error) {
      const status = error instanceof WaxError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 && !(error instanceof WaxError) ? '서버 오류가 발생했습니다.' : error.message, ...(error.state ? { state: error.state } : {}) });
      else res.end();
    }
  });

  server.startWatching = async () => {
    try { await ensureIdentity(); } catch (error) { watcher.emit('error', error); }
    await triggers.start();
    await pmLoop.start();
    return watcher.start();
  };
  server.watcher = watcher;
  server.requests = requests;
  server.design = design;
  server.triggers = triggers;
  server.pmLoop = pmLoop;
  server.shutdown = async () => {
    await triggers.close();
    await pmLoop.close();
    await requests.close();
    await design.close();
    watcher.stop();
    clearInterval(heartbeat);
    events.close();
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
