import { t } from '../../web/messages-catalog.mjs';
import { copyFile, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { WaxError } from '../workflow.mjs';
import { runAgentSession } from '../agent-session.mjs';
import { agentTool } from '../agent-tools.mjs';
import { artifactFile } from '../quality.mjs';
import { checkFile, safeDir } from './paths.mjs';
import { withLock, processAlive } from './lock.mjs';
import { writeJsonAtomic } from './store.mjs';
import { DESIGN_TOOLS, designSupport, openCodexMcp, claudeMcpList, codexState, pickServer, toolText, toolImage, safeDetail } from './design-mcp.mjs';

const ACTIVE = new Set(['queued', 'producing']);
const OPEN = new Set(['queued', 'producing', 'review', 'blocked', 'failed', 'stopped', 'approved']);
const USABLE = new Set(['read-write', 'connected']);
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,62}$/u;
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['complete', 'question', 'blocked'] },
    report: { type: 'string' }, changes: { type: 'string' }, nodeId: { type: 'string' },
    objects: { type: 'array', items: { type: 'string' } }, render: { type: 'string' }, exported: { type: 'string' },
  }, required: ['outcome', 'report', 'changes', 'nodeId', 'objects', 'render', 'exported'],
};
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new WaxError(t('errors.chat.design.enter', label));
  if (value.length > max) throw new WaxError(t('errors.chat.design.mustBeCharactersOr', label, max));
  return value.replace(/\r\n/g, '\n').trim();
};
const clientId = (value) => {
  if (value === undefined) return randomUUID();
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new WaxError(t('errors.chat.design.invalidRequestId'));
  return value;
};

export function parseFigmaUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new WaxError(t('errors.chat.design.checkTheFigmaLink')); }
  const match = /^\/(?:design|file)\/([A-Za-z0-9]{10,64})(?:\/|$)/.exec(parsed.pathname);
  if (parsed.protocol !== 'https:' || !/^(www\.)?figma\.com$/.test(parsed.hostname) || !match) throw new WaxError(t('errors.chat.design.aFileLinkIn'));
  const node = parsed.searchParams.get('node-id');
  if (!node || !/^\d+[-:]\d+$/.test(node)) throw new WaxError(t('errors.chat.design.youNeedTheLink'));
  const nodeId = node.replace('-', ':');
  return { fileKey: match[1], nodeId, url: `https://www.figma.com/design/${match[1]}/?node-id=${nodeId.replace(':', '-')}` };
}

function blenderTarget(input = {}) {
  const file = text(input.file, 300, 'Blender 파일 경로');
  const local = normalize(file);
  if (isAbsolute(file) || local.startsWith('..') || extname(local).toLowerCase() !== '.blend') throw new WaxError(t('errors.chat.design.theBlenderFileMust'));
  for (const [key, label] of [['scene', '장면'], ['collection', '컬렉션']]) if (typeof input[key] !== 'string' || !NAME.test(input[key])) throw new WaxError(t('errors.chat.design.theNameMustStart', label));
  return { file: local.split(sep).join('/'), scene: input.scene, collection: input.collection };
}

async function designDir(root, parts = [], create = true) { return safeDir(root, ['.wax', 'design', ...parts], { create }); }
async function targetsFile(root) { return checkFile(join(await designDir(root), 'targets.json')); }
async function loadTargets(root) {
  try { const data = JSON.parse(await readFile(await targetsFile(root), 'utf8')); return Array.isArray(data.targets) ? data : { schema: 1, targets: [] }; }
  catch (error) { if (error.code === 'ENOENT') return { schema: 1, targets: [] }; throw new WaxError(t('errors.chat.design.couldntReadTheDesign'), 500); }
}
async function changeTargets(root, change) {
  const file = await targetsFile(root);
  return withLock(`${file}.lock`, async () => { const data = await loadTargets(root); const result = await change(data); await writeJsonAtomic(file, data); return result; });
}
export async function listTargets(root) { return (await loadTargets(root)).targets; }

export async function saveTarget(root, input = {}) {
  const tool = input.tool;
  if (!Object.hasOwn(DESIGN_TOOLS, tool)) throw new WaxError(t('errors.chat.design.theDesignToolMust'));
  const label = text(input.label ?? (tool === 'figma' ? 'Figma 프레임' : 'Blender 컬렉션'), 80, '대상 이름');
  const server = input.server ? text(input.server, 64, 'MCP 서버 이름') : undefined;
  const detail = tool === 'figma' ? { figma: parseFigmaUrl(input.url) } : { blender: blenderTarget(input) };
  const busy = input.id && (await openJobs(root)).find((job) => job.targetId === input.id);
  if (busy) throw new WaxError(t('errors.chat.design.anInProgressDesign', busy.title), 409);
  return changeTargets(root, (data) => {
    const now = new Date().toISOString();
    const same = data.targets.find((t) => t.tool === tool && JSON.stringify(t[tool]) === JSON.stringify(detail[tool]));
    if (same && same.id !== input.id) throw new WaxError(t('errors.chat.design.thisTargetIsAlready', same.label), 409);
    if (input.id) {
      const target = data.targets.find((t) => t.id === input.id);
      if (!target || target.tool !== tool) throw new WaxError(t('errors.chat.design.designTargetNotFound'), 404);
      if (JSON.stringify(target[tool]) !== JSON.stringify(detail[tool])) target.checks = {};
      Object.assign(target, { label, server, ...detail, updatedAt: now });
      return target;
    }
    if (data.targets.length >= 50) throw new WaxError(t('errors.chat.design.youCanConnectUp'));
    const target = { id: `target-${randomUUID().slice(0, 8)}`, tool, label, ...(server ? { server } : {}), ...detail, checks: {}, createdAt: now, updatedAt: now };
    data.targets.push(target);
    return target;
  });
}

const NEXT = {
  figma: {
    codex: { 'not-configured': '터미널에서 codex mcp add figma --url https://mcp.figma.com/mcp 를 실행하고 Figma 로그인에서 Allow access를 누른 뒤 다시 검사하세요.', 'auth-required': '터미널에서 codex mcp login figma 를 실행해 Figma 로그인을 마친 뒤 다시 검사하세요.' },
  },
  blender: {
    codex: { 'not-configured': 'Blender MCP를 Codex에 등록하세요(예: codex mcp add blender -- uvx blender-mcp). Blender에서 MCP 애드온 서버를 켠 뒤 다시 검사하세요.' },
    claude: { 'not-configured': 'Blender MCP를 Claude Code에 등록하세요(예: claude mcp add blender -- uvx blender-mcp). Blender에서 MCP 애드온 서버를 켠 뒤 다시 검사하세요.', 'auth-required': 'Claude Code에서 /mcp를 열어 blender 서버를 승인한 뒤 다시 검사하세요.' },
  },
};
const nextFor = (tool, agent, state, fallback) => NEXT[tool]?.[agent]?.[state] ?? fallback ?? {
  'auth-required': '실행 도구에서 MCP 서버 로그인을 마친 뒤 다시 검사하세요.',
  error: tool === 'blender' ? 'Blender가 켜져 있고 MCP 애드온 서버가 시작됐는지 확인한 뒤 다시 검사하세요.' : '네트워크와 Figma 파일 권한을 확인한 뒤 다시 검사하세요.',
}[state] ?? '';

const argsFor = (props, values) => Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
  const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return props.includes(key) ? [[key, value]] : props.includes(snake) ? [[snake, value]] : [];
}));
const classify = (detail) => /401|unauthori|log ?in|auth/i.test(detail) ? 'auth-required' : 'error';

const blenderProbe = (target) => [
  'import bpy, json',
  `s = bpy.data.scenes.get(${JSON.stringify(target.scene)})`,
  `c = bpy.data.collections.get(${JSON.stringify(target.collection)})`,
  "print('WAX_PROBE ' + json.dumps({'file': bpy.data.filepath, 'dirty': bpy.data.is_dirty, 'scene': bool(s),",
  "  'collection': bool(s and c and c in s.collection.children_recursive), 'objects': sorted(o.name for o in c.all_objects) if c else []}))",
].join('\n');
export function readProbe(output) {
  const line = output.split('\n').reverse().find((l) => l.includes('WAX_PROBE '));
  try { return line ? JSON.parse(line.slice(line.indexOf('WAX_PROBE ') + 10)) : null; } catch { return null; }
}
async function sameFile(root, target, open) {
  if (!open) return false;
  const expected = resolve(root, target.file);
  try { return await realpath(open) === await realpath(expected); } catch { return resolve(open) === expected; }
}

async function probeTarget(root, target, client, server) {
  if (target.tool === 'figma') {
    const read = server.tools.find((t) => t === 'get_metadata') ?? server.tools.find((t) => t === 'get_screenshot');
    if (!read) return { state: 'error', detail: 'Figma MCP에 읽기 도구(get_metadata)가 없습니다.' };
    const result = await client.call(server.name, read, argsFor(server.schemas[read] || [], { fileKey: target.figma.fileKey, nodeId: target.figma.nodeId }), 60_000);
    if (result.isError) { const detail = safeDetail(toolText(result)); return { state: classify(detail), detail: `대상 프레임을 읽지 못했습니다: ${detail}`, next: '이 Figma 계정에 파일 보기 권한이 있는지, 링크의 프레임이 맞는지 확인하세요.' }; }
    return server.tools.includes('use_figma')
      ? { state: 'read-write', detail: '대상 프레임 읽기 확인 · 쓰기 도구(use_figma) 사용 가능. 파일 편집 권한과 플랜은 첫 제작에서 확인됩니다.' }
      : { state: 'read-only', detail: '대상 프레임은 읽을 수 있지만 쓰기 도구(use_figma)가 없습니다.', next: '원격 Figma MCP(https://mcp.figma.com/mcp)를 연결해야 캔버스에 쓸 수 있습니다. 데스크톱 서버는 읽기 전용입니다.' };
  }
  if (!server.tools.includes('execute_blender_code')) return { state: 'read-only', detail: 'Blender MCP에 코드 실행 도구가 없어 대상 파일을 확인하거나 수정할 수 없습니다.' };
  const result = await client.call(server.name, 'execute_blender_code', { code: blenderProbe(target.blender) }, 60_000);
  const probe = !result.isError && readProbe(toolText(result));
  if (!probe) return { state: classify(toolText(result)), detail: `Blender 상태를 읽지 못했습니다: ${safeDetail(toolText(result))}` };
  if (!await sameFile(root, target.blender, probe.file)) {
    return { state: 'target-mismatch', detail: probe.file ? `Blender에 다른 파일(${basename(probe.file)})이 열려 있습니다. wax는 다른 파일을 수정하지 않습니다.` : 'Blender에 저장하지 않은 새 파일이 열려 있습니다.',
      next: `Blender에서 프로젝트의 ${target.blender.file}을(를) 열거나 새 파일을 그 경로로 저장한 뒤 다시 검사하세요.` };
  }
  if (!probe.scene) return { state: 'target-mismatch', detail: `열린 파일에 장면 ${target.blender.scene}이(가) 없습니다.`, next: '장면 이름을 확인하거나 Blender에서 그 이름으로 장면을 만든 뒤 다시 검사하세요.' };
  return { state: 'read-write', detail: `${target.blender.file} · 장면 ${target.blender.scene} 확인${probe.collection ? ` · 컬렉션 ${target.blender.collection}(${probe.objects.length}개 오브젝트)` : ` · 컬렉션 ${target.blender.collection}은 첫 제작 때 만듭니다`}.` };
}

export async function inspectTarget(root, target, agent, mcp = {}) {
  agentTool(agent);
  const support = designSupport(agent, target.tool);
  if (!support.ok) return { state: 'unsupported', detail: support.reason, next: support.next };
  if (agent === 'claude') {
    const servers = await (mcp.claudeList ?? claudeMcpList)(root);
    const name = pickServer(servers.map((s) => s.name), target.tool, target.server);
    const server = servers.find((s) => s.name === name);
    if (!server) return { state: 'not-configured', detail: `Claude Code에 ${DESIGN_TOOLS[target.tool].label} MCP가 등록되어 있지 않습니다.`, next: nextFor(target.tool, agent, 'not-configured') };
    if (server.state !== 'connected') return { state: server.state, server: name, detail: server.detail, next: nextFor(target.tool, agent, server.state) };
    return { state: 'connected', server: name, detail: '연결 확인. Claude Code는 도구 목록과 열린 파일을 알려 주지 않아 대상 파일은 제작 세션에서 확인합니다.' };
  }
  const client = await (mcp.codex ?? openCodexMcp)(root);
  try {
    const servers = await client.servers();
    const name = pickServer(servers.map((s) => s.name), target.tool, target.server);
    const server = servers.find((s) => s.name === name);
    const base = codexState(server);
    if (base.state !== 'connected') {
      return { ...base, ...(name ? { server: name } : {}), detail: base.detail ?? (base.state === 'not-configured' ? `Codex에 ${DESIGN_TOOLS[target.tool].label} MCP가 등록되어 있지 않습니다.` : 'MCP 로그인이 필요합니다.'), next: nextFor(target.tool, agent, base.state) };
    }
    const result = await probeTarget(root, target, client, server);
    const known = [...DESIGN_TOOLS[target.tool].read, ...DESIGN_TOOLS[target.tool].write, 'get_screenshot', 'upload_assets', 'generate_image'];
    return { ...result, server: name, tools: server.tools.filter((t) => known.includes(t)), next: result.next ?? nextFor(target.tool, agent, result.state) };
  } catch (error) {
    return { state: 'error', detail: safeDetail(error.message), next: nextFor(target.tool, agent, 'error') };
  } finally { client.close(); }
}

export async function checkTarget(root, id, agent, mcp) {
  const target = (await listTargets(root)).find((t) => t.id === id);
  if (!target) throw new WaxError(t('errors.chat.design.designTargetNotFound'), 404);
  const result = { agent, ...(await inspectTarget(root, target, agent, mcp)), checkedAt: new Date().toISOString() };
  return changeTargets(root, (data) => {
    const current = data.targets.find((t) => t.id === id);
    if (!current || JSON.stringify(current[current.tool]) !== JSON.stringify(target[target.tool])) throw new WaxError(t('errors.chat.design.theTargetChangedDuring'), 409);
    current.checks = { ...current.checks, [agent]: result };
    return { target: current, check: result };
  });
}


async function openJobs(root) {
  const dir = await designDir(root, ['jobs'], false);
  if (!dir) return [];
  const found = [];
  for (const name of (await readdir(dir)).filter((f) => /^design-[a-f0-9-]{36}\.json$/.test(f))) {
    try { const job = JSON.parse(await readFile(join(dir, name), 'utf8')); if (OPEN.has(job.status)) found.push(job); } catch {   }
  }
  return found;
}
const pin = (target) => ({ id: target.id, tool: target.tool, label: target.label, ...(target.server ? { server: target.server } : {}), [target.tool]: target[target.tool] });

const jobId = (id) => { if (typeof id !== 'string' || !/^design-[a-f0-9-]{36}$/.test(id)) throw new WaxError(t('errors.chat.design.invalidDesignTaskId')); return id; };
async function jobFile(root, id) { return checkFile(join(await designDir(root, ['jobs']), `${jobId(id)}.json`)); }
async function readJob(root, id) {
  try { return JSON.parse(await readFile(await jobFile(root, id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new WaxError(t('errors.chat.design.designTaskNotFound'), 404); throw new WaxError(t('errors.chat.design.couldntReadTheDesignTask'), 500); }
}
const interrupted = (job) => ACTIVE.has(job.status) && job.owner && !processAlive(job.owner.pid);
export function publicJob(job) {
  const { owner, thread, clientIds, ...data } = job;
  return interrupted(job) ? { ...data, status: 'stopped', detail: '실행 연결이 끊겼습니다. 이어서 제작하면 저장된 의견부터 다시 진행합니다.' } : data;
}
const latest = (job) => job.versions.at(-1)?.n ?? 0;
const ensureCurrent = (job, version, revision) => {
  if (revision !== job.revision || version !== latest(job)) throw new WaxError(t('errors.chat.design.thisDesignTaskWas'), 409);
};

async function incoming(root, id, name) {
  const dir = await designDir(root, ['jobs', id]);
  return join(dir, name);
}

export function designPrompt(job, target, { version, render, exported, previous, feedback }) {
  const history = job.feedback.map((f) => `v${f.version} 의견: ${f.text}`);
  const lines = [
    `대표가 wax B1 디자인실에서 요청한 디자인을 ${DESIGN_TOOLS[target.tool].label} MCP로 실제 제작하는 디자인 담당입니다. 이번 결과는 v${version}입니다.`,
    `작업 제목: ${job.title}`, `요청 내용: ${job.brief}`,
    ...(history.length ? ['대표 의견 이력(최신이 마지막):', ...history] : []),
    ...(feedback ? [`이번에 반영할 대표 의견: ${feedback.text}`] : []),
  ];
  if (target.tool === 'figma') {
    lines.push(`대상 Figma 파일 키 ${target.figma.fileKey}, 대상 프레임 노드 ${target.figma.nodeId} (${target.figma.url}).`,
      previous ? `이전 버전 결과 프레임 ${previous.source.nodeId}를 같은 노드에서 고치세요. 새 프레임을 만들지 말고 nodeId에 같은 ID를 반환하세요.`
        : '대상 프레임 안에 이번 결과 프레임 하나를 만들고 그 프레임의 노드 ID를 nodeId에 반환하세요.',
      '대상 프레임 밖의 페이지·프레임과 다른 파일은 수정하지 마세요. 이미지가 필요하면 upload_assets를 쓰고, 편집 권한이나 쓰기 도구가 없으면 아무것도 바꾸지 말고 outcome=blocked로 이유를 보고하세요.',
      '미리보기는 wax가 nodeId의 화면을 Figma에서 직접 받아 저장합니다. render와 exported는 빈 문자열로 두세요.');
  } else {
    lines.push(`대상 Blender 파일 ${target.blender.file}, 장면 ${target.blender.scene}, 컬렉션 ${target.blender.collection}.`,
      `먼저 bpy.data.filepath가 ${target.blender.file}(프로젝트 안)인지 확인하세요. 다른 파일이 열려 있으면 아무것도 바꾸지 말고 outcome=blocked로 보고하세요.`,
      `장면 ${target.blender.scene}의 컬렉션 ${target.blender.collection} 안에서만 오브젝트를 만들고 고치세요(없으면 이 장면에 만드세요). 다른 컬렉션·오브젝트·파일은 수정하지 마세요.`,
      `결과를 ${render}에 PNG로 렌더하고(긴 변 1024px 이하), 컬렉션만 ${exported}에 glTF 바이너리(.glb)로 내보낸 뒤 .blend 파일을 저장하세요.`,
      `render와 exported에 위 두 경로를 그대로, objects에 컬렉션 안 오브젝트 이름을 반환하세요. nodeId는 빈 문자열입니다.`);
  }
  lines.push('wax 상태 파일과 요청 기록은 수정하지 마세요. 실제로 만들지 못했으면 성공으로 보고하지 말고 outcome=blocked 또는 question으로 이유와 대표가 할 다음 행동을 적으세요.',
    'report는 대표에게 보여 줄 짧은 한국어 보고, changes는 이번 버전에서 바뀐 점입니다.');
  return lines.join('\n\n');
}

export function createDesignRunner({ root, execute = runAgentSession, mcp = {}, notify = () => {}, timeoutMs = 20 * 60_000 } = {}) {
  const instance = randomUUID(), owner = { pid: process.pid, instance };
  const jobs = new Map(), controllers = new Map();
  let stopped = false;
  const changed = () => notify('design', {});
  async function mutate(id, change) {
    const file = await jobFile(root, id);
    const job = await withLock(`${file}.lock`, async () => {
      const current = await readJob(root, id);
      const result = await change(current);
      if (result === false) return current;
      current.updatedAt = new Date().toISOString();
      await writeJsonAtomic(file, current);
      return current;
    });
    changed();
    return job;
  }
  async function list() {
    const dir = await designDir(root, ['jobs'], false);
    const ids = dir ? (await readdir(dir)).filter((f) => /^design-[a-f0-9-]{36}\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
    const all = await Promise.all(ids.map((id) => readJob(root, id).catch(() => null)));
    return { targets: await listTargets(root), jobs: all.filter(Boolean).map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  async function usableCheck(target, agent) {
    const check = target.checks?.[agent];
    if (!check || !USABLE.has(check.state)) throw new WaxError(t('errors.chat.design.connectionCheckMustPass', agentTool(agent).label, target.label, check?.next ? ` ${check.next}` : ''), 409);
  }

  async function submit({ targetId, agent = 'codex', title, brief, feature, clientId: requestId, author }) {
    if (stopped) throw new WaxError(t('errors.chat.design.theExecutionConnectionWas'), 409);
    const key = clientId(requestId);
    title = text(title, 100, '작업 제목'); brief = text(brief, 4000, '요청 내용');
    if (feature !== undefined && feature !== null && (typeof feature !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(feature))) throw new WaxError(t('errors.chat.design.theTaskIdTo'));
    const target = (await listTargets(root)).find((t) => t.id === targetId);
    if (!target) throw new WaxError(t('errors.chat.design.designTargetNotFound'), 404);
    const support = designSupport(agent, target.tool);
    if (!support.ok) throw new WaxError(`${support.reason} ${support.next}`, 409);
    await usableCheck(target, agent);
    const dir = await designDir(root, ['jobs']);
    const job = await withLock(join(dir, 'create.lock'), async () => {
      const { jobs: existing } = await list();
      const same = existing.find((j) => j.clientKey === key);
      if (same) return same;
      const open = existing.find((j) => j.targetId === targetId && OPEN.has(j.status));
      if (open) throw new WaxError(t('errors.chat.design.thisTargetHasAn', open.title), 409);
      const now = new Date().toISOString(), id = `design-${randomUUID()}`;
      const created = { schema: 1, id, clientKey: key, targetId, target: pin(target), tool: target.tool, agent, title, brief, ...(feature ? { feature } : {}), author,
        status: 'queued', detail: 'v1 제작을 준비하고 있습니다.', revision: 1, versions: [], feedback: [], pending: null, approved: null, handoff: null,
        owner, clientIds: [key], createdAt: now, updatedAt: now };
      await writeJsonAtomic(await jobFile(root, id), created);
      return created;
    });
    changed();
    if (job.status === 'queued' && job.owner?.instance === instance) schedule(job.id);
    return publicJob(job);
  }

  async function feedback(id, { version, revision, text: body, clientId: requestId, author }) {
    const key = clientId(requestId);
    body = text(body, 4000, '수정 의견');
    const job = await mutate(id, (job) => {
      if (job.clientIds?.includes(key)) return false;
      if (ACTIVE.has(job.status) && !interrupted(job)) throw new WaxError(t('errors.chat.design.buildingSendFeedbackAfter'), 409);
      if (!['review', 'blocked', 'failed', 'stopped', 'producing', 'queued'].includes(job.status)) throw new WaxError(t('errors.chat.design.feedbackCantBeSent'), 409);
      ensureCurrent(job, version, revision);
      const entry = { id: key, version: latest(job), text: body, author, at: new Date().toISOString() };
      job.feedback.push(entry); job.clientIds = [...(job.clientIds ?? []), key].slice(-200);
      job.pending = key; job.status = 'queued'; job.owner = owner; job.revision += 1;
      job.detail = `대표 의견을 반영한 v${latest(job) + 1} 제작을 준비합니다.`;
    });
    if (job.status === 'queued' && job.owner?.instance === instance) schedule(id);
    return publicJob(job);
  }

  async function approve(id, { version, revision, author }) {
    return publicJob(await mutate(id, (job) => {
      if (job.approved?.version === version && job.status !== 'review') return false;
      if (job.status !== 'review') throw new WaxError(t('errors.chat.design.onlyAVersionUnder'), 409);
      ensureCurrent(job, version, revision);
      job.approved = { version, author, at: new Date().toISOString() };
      job.status = 'approved'; job.revision += 1; job.detail = `v${version} 버전을 확정했습니다. 개발에 인계하세요.`;
    }));
  }

  async function handoff(id, { version, revision }) {
    const current = await readJob(root, id);
    if (current.handoff?.version === version) return publicJob(current);
    if (current.status !== 'approved' || current.approved?.version !== version) throw new WaxError(t('errors.chat.design.onlyAVersionThe'), 409);
    if (revision !== current.revision) throw new WaxError(t('errors.chat.design.thisDesignTaskWasChanged'), 409);
    const chosen = current.versions.find((v) => v.n === version);
    const preview = chosen && await artifactFile(root, chosen.preview);
    if (!preview) throw new WaxError(t('errors.chat.design.cantHandOffBecause'), 409);
    const exported = current.tool === 'blender' && chosen.source.exported ? await artifactFileAny(root, chosen.source.exported) : null;
    if (current.tool === 'blender' && !exported) {
      const message = `확정한 v${version} 버전에 내보낸 모델(glb)이 없어 인계할 수 없습니다. 확정을 취소했습니다. 의견을 보내면 같은 컬렉션에서 모델까지 내보낸 다음 버전을 만듭니다.`;
      await mutate(id, (job) => {
        if (job.status !== 'approved' || job.approved?.version !== version) return false;
        job.approved = null; job.status = 'blocked'; job.revision += 1; job.detail = message;
      });
      throw new WaxError(message, 409);
    }
    const target = current.target ?? (await listTargets(root)).find((t) => t.id === current.targetId);
    const docs = await safeDir(root, ['docs', 'wax', 'design', id], { create: true });
    const local = (path) => relative(root, path).split(sep).join('/');
    return publicJob(await mutate(id, async (job) => {
      if (job.handoff?.version === version) return false;
      if (job.status !== 'approved' || job.approved?.version !== version || job.revision !== revision) throw new WaxError(t('errors.chat.design.theApprovedVersionChanged'), 409);
      const image = join(docs, `v${version}${extname(preview)}`);
      await copyFile(preview, image);
      const assets = [];
      if (exported) {
        const copy = join(docs, `v${version}${extname(exported)}`);
        await copyFile(exported, copy);
        assets.push(local(copy));
      }
      const doc = join(docs, `handoff-v${version}.md`);
      await writeFile(doc, [
        `# 디자인 인계 — ${job.title}`, '',
        `- 확정 버전: v${version} (${job.approved.at}${job.approved.author ? `, ${job.approved.author}` : ''})`,
        `- 도구: ${DESIGN_TOOLS[job.tool].label} · 실행: ${agentTool(job.agent).label}`,
        ...(job.tool === 'figma' ? [`- 원본: ${target?.figma.url ?? ''} · 결과 프레임 ${chosen.source.nodeId}`, `- 결과 프레임 링크: https://www.figma.com/design/${chosen.source.fileKey}/?node-id=${chosen.source.nodeId.replace(':', '-')}`]
          : [`- 원본: ${chosen.source.file} · 장면 ${chosen.source.scene} · 컬렉션 ${chosen.source.collection}`, `- 오브젝트: ${chosen.source.objects.join(', ') || '-'}`]),
        `- 미리보기: ${local(image)}`, ...assets.map((a) => `- 내보낸 파일: ${a}`), '',
        '## 요청', job.brief, '',
        '## 이번 버전에서 바뀐 점', chosen.changes || '-', '',
        ...(job.feedback.length ? ['## 대표 의견 이력', ...job.feedback.map((f) => `- v${f.version}: ${f.text}`), ''] : []),
        '## 개발 지시', job.tool === 'figma'
          ? '확정 미리보기와 결과 프레임을 기준으로 실제 화면(HTML/CSS 또는 프로젝트 UI)을 구현하세요. 프레임에 없는 상태(로딩·오류·빈 화면)는 기존 관례를 따르고 차이를 보고하세요.'
          : '내보낸 모델을 프로젝트에 연결하고, 실제 화면에서 렌더한 결과를 확정 미리보기와 비교하세요.', '',
      ].join('\n'), { mode: 0o600 });
      job.handoff = { version, doc: local(doc), preview: local(image), assets, ...(job.feature ? { feature: job.feature } : {}), at: new Date().toISOString() };
      job.status = 'handed-off'; job.revision += 1; job.detail = `v${version} 버전을 개발에 인계했습니다: ${local(doc)}`;
    }));
  }

  async function reopen(id, { version, revision }) {
    return publicJob(await mutate(id, (job) => {
      if (job.status === 'review' && !job.approved) return false;
      if (job.status !== 'approved' || job.approved?.version !== version) throw new WaxError(t('errors.chat.design.onlyAnApprovedVersion'), 409);
      if (revision !== job.revision) throw new WaxError(t('errors.chat.design.thisDesignTaskWasChanged'), 409);
      job.approved = null; job.status = 'review'; job.revision += 1;
      job.detail = `v${version} 확정을 취소했습니다. 수정 의견을 보내거나 다시 확정하세요.`;
    }));
  }
  async function stop(id) {
    const job = await mutate(id, (job) => {
      if (!ACTIVE.has(job.status)) return false;
      job.status = 'stopped'; job.detail = '중지했습니다. 이어서 제작하면 저장된 의견부터 다시 진행합니다.';
    });
    controllers.get(id)?.abort();
    return publicJob(job);
  }
  async function resume(id) {
    const job = await mutate(id, (job) => {
      if (!['stopped', 'failed', 'blocked'].includes(job.status) && !interrupted(job)) return false;
      if (jobs.has(id)) throw new WaxError(t('errors.chat.design.finishingThePreviousRun'), 409);
      job.status = 'queued'; job.owner = owner; job.detail = `v${latest(job) + 1} 제작을 다시 준비합니다.`;
    });
    if (job.status === 'queued' && job.owner?.instance === instance) schedule(id);
    return publicJob(job);
  }

  async function produce(id, controller) {
    let job = await readJob(root, id);
    if (job.status !== 'queued' || job.owner?.instance !== instance) return;
    const target = (await listTargets(root)).find((t) => t.id === job.targetId);
    if (!target) throw new WaxError(t('errors.chat.design.theDesignTargetWas'));
    const pinned = job.target ?? pin(target);
    if (target.tool !== pinned.tool || JSON.stringify(target[target.tool]) !== JSON.stringify(pinned[pinned.tool])) throw new WaxError(t('errors.chat.design.theConnectedTargetFile'));
    const { check } = await checkTarget(root, target.id, job.agent, mcp);
    if (!USABLE.has(check.state)) throw Object.assign(new WaxError(`${check.detail}${check.next ? ` ${check.next}` : ''}`), { quiet: true });
    const version = latest(job) + 1, previous = job.versions.at(-1);
    const feedbackEntry = job.pending ? job.feedback.find((f) => f.id === job.pending) : null;
    const run = randomUUID().slice(0, 8);
    const render = await incoming(root, id, `v${version}-${run}-render.png`), exported = await incoming(root, id, `v${version}-${run}.glb`);
    job = await mutate(id, (current) => {
      if (current.status !== 'queued' || controller.signal.aborted) return false;
      current.status = 'producing'; current.detail = `${DESIGN_TOOLS[target.tool].label}에서 v${version} 버전을 만들고 있습니다.`;
    });
    if (job.status !== 'producing') return;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result;
    try {
      result = await execute(root, { tool: job.agent, prompt: designPrompt(job, target, { version, render, exported, previous, feedback: feedbackEntry }),
        thread: job.thread, outputSchema: SCHEMA, signal: controller.signal, approvalTimeoutMs: timeoutMs, output() {}, log() {} });
    } finally { clearTimeout(timer); }
    if (controller.signal.aborted) return;
    let reply;
    try { reply = JSON.parse(result.message); } catch { throw new WaxError(t('errors.chat.design.couldntReadTheDesigners')); }
    if (!['complete', 'question', 'blocked'].includes(reply?.outcome) || typeof reply.report !== 'string' || !reply.report.trim()) throw new WaxError(t('errors.chat.design.theDesignersReportIs'));
    if (reply.outcome !== 'complete') {
      await mutate(id, (current) => { if (current.status !== 'producing') return false; current.status = 'blocked'; current.thread = result.threadId; current.detail = reply.report.slice(0, 2000); });
      return;
    }
    const source = await receive(target, job, version, reply, { render, exported, previous });
    await mutate(id, (current) => {
      if (current.status !== 'producing') return false;
      current.versions.push({ n: version, at: new Date().toISOString(), source: source.source, preview: source.preview, changes: String(reply.changes || '').slice(0, 4000),
        report: reply.report.slice(0, 4000), ...(feedbackEntry ? { feedback: feedbackEntry.id } : {}) });
      current.pending = null; current.thread = result.threadId; current.status = 'review'; current.revision += 1;
      current.detail = `v${version} 제작을 마쳤습니다. 미리보기를 확인하고 수정 의견을 보내거나 확정하세요.`;
    });
  }

  async function receive(target, job, version, reply, { render, exported, previous }) {
    const dir = await designDir(root, ['jobs', job.id]);
    if (target.tool === 'figma') {
      const nodeId = String(reply.nodeId || '');
      if (!/^\d+:\d+$/.test(nodeId)) throw new WaxError(t('errors.chat.design.didNotReceiveThe'));
      if (previous && previous.source.nodeId !== nodeId) throw new WaxError(t('errors.chat.design.theReportSaysA', previous.source.nodeId));
      const client = await (mcp.codex ?? openCodexMcp)(root);
      try {
        const servers = await client.servers();
        const server = servers.find((s) => s.name === pickServer(servers.map((item) => item.name), 'figma', target.server));
        if (!server?.tools.includes('get_screenshot')) throw new WaxError(t('errors.chat.design.theFigmaMcpConnection'));
        const shot = await client.call(server.name, 'get_screenshot', argsFor(server.schemas.get_screenshot || [], { fileKey: target.figma.fileKey, nodeId }), 120_000);
        const image = !shot.isError && toolImage(shot);
        if (!image) throw new WaxError(t('errors.chat.design.couldntGetTheResult', safeDetail(toolText(shot))));
        const bytes = Buffer.from(image.data, 'base64');
        const ext = bytes[0] === 0x89 && bytes[1] === 0x50 ? '.png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? '.jpg' : null;
        if (!ext || bytes.length > 20 * 1024 * 1024) throw new WaxError(t('errors.chat.design.theImageFromFigma'));
        const file = join(dir, `v${version}${ext}`);
        await writeFile(file, bytes, { mode: 0o600 });
        return { source: { fileKey: target.figma.fileKey, nodeId, url: target.figma.url }, preview: relative(root, file).split(sep).join('/') };
      }
      finally { client.close(); }
    }
    const base = await realpath(root), local = (path) => relative(base, path).split(sep).join('/');
    const rendered = await artifactFile(root, relative(root, render));
    if (!rendered || extname(rendered) !== '.png') throw new WaxError(t('errors.chat.design.theRenderResultIs', local(render)));
    const glb = await artifactFileAny(root, relative(root, exported));
    if (!glb) throw new WaxError(t('errors.chat.design.theExportedModelIs', local(exported)));
    const objects = Array.isArray(reply.objects) ? reply.objects.filter((o) => typeof o === 'string' && o.length <= 63).slice(0, 200) : [];
    if (job.agent === 'codex') {
      const client = await (mcp.codex ?? openCodexMcp)(root);
      try {
        const name = pickServer((await client.servers()).map((s) => s.name), 'blender', target.server);
        const probe = readProbe(toolText(await client.call(name, 'execute_blender_code', { code: blenderProbe(target.blender) }, 60_000)));
        if (!probe || !await sameFile(root, target.blender, probe.file)) throw new WaxError(t('errors.chat.design.theTargetFileIsnt'));
        if (!probe.collection || !probe.objects.length) throw new WaxError(t('errors.chat.design.collectionHasNoObjects', target.blender.collection));
        objects.splice(0, objects.length, ...probe.objects);
      } finally { client.close(); }
    }
    return { source: { file: target.blender.file, scene: target.blender.scene, collection: target.blender.collection, objects, exported: local(glb) }, preview: local(rendered) };
  }

  async function perform(id) {
    const dir = await designDir(root, ['jobs']);
    const controller = new AbortController(); controllers.set(id, controller);
    try {
      await withLock(join(dir, 'runner.lock'), () => produce(id, controller), { timeoutMs: 15_000 });
    } catch (error) {
      await mutate(id, (job) => {
        if (!ACTIVE.has(job.status) || job.owner?.instance !== instance) return false;
        job.status = controller.signal.aborted ? 'stopped' : 'failed';
        job.detail = controller.signal.aborted ? '중지했거나 제한 시간을 넘겼습니다. 이어서 제작하면 저장된 의견부터 다시 진행합니다.' : String(error.message).slice(0, 2000);
      }).catch(() => {});
    } finally {
      controllers.delete(id);
      if (controller.signal.aborted) await mutate(id, (job) => { if (job.status !== 'producing' || job.owner?.instance !== instance) return false; job.status = 'stopped'; job.detail = '중지했습니다. 이어서 제작하면 저장된 의견부터 다시 진행합니다.'; }).catch(() => {});
    }
  }
  function schedule(id) {
    if (stopped || jobs.has(id)) return;
    const previous = [...jobs.values()].at(-1) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => perform(id)).finally(async () => {
      jobs.delete(id);
      const current = await readJob(root, id).catch(() => null);
      if (current?.status === 'queued' && current.owner?.instance === instance) schedule(id);
    });
    jobs.set(id, job); job.catch(() => {});
  }
  async function close() {
    stopped = true;
    for (const id of jobs.keys()) await stop(id).catch(() => {});
    await Promise.allSettled([...jobs.values()]);
  }
  return { list, submit, feedback, approve, reopen, handoff, stop, resume, close, settled: () => Promise.allSettled([...jobs.values()]),
    check: (id, agent) => checkTarget(root, id, agent, mcp), saveTarget: (input) => saveTarget(root, input) };
}

const EXPORTS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.blend']);
async function artifactFileAny(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file)) return null;
  try {
    const base = await realpath(root), path = await realpath(resolve(base, file));
    const local = relative(base, path);
    if (!local || local.startsWith('..') || isAbsolute(local) || !EXPORTS.has(extname(path).toLowerCase())) return null;
    const info = await stat(path);
    return info.isFile() && info.size > 0 && info.size <= 200 * 1024 * 1024 ? path : null;
  } catch { return null; }
}

export async function designHandoffs(root, feature) {
  const dir = await designDir(root, ['jobs'], false);
  if (!dir) return [];
  const found = [];
  for (const name of (await readdir(dir)).filter((f) => /^design-[a-f0-9-]{36}\.json$/.test(f))) {
    try { const job = JSON.parse(await readFile(join(dir, name), 'utf8')); if (job.handoff && job.feature === feature) found.push({ title: job.title, version: job.handoff.version, doc: job.handoff.doc, preview: job.handoff.preview }); } catch {   }
  }
  return found;
}

export async function versionPreview(root, id, n) {
  const job = await readJob(root, id);
  const version = job.versions.find((v) => v.n === n);
  const path = version && await artifactFile(root, version.preview);
  if (!path || !['.png', '.jpg', '.jpeg'].includes(extname(path).toLowerCase())) throw new WaxError(t('errors.chat.design.noPreviewFile'), 404);
  return path;
}
