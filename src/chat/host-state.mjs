import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const HOST_STATES = ['working', 'blocked', 'done', 'idle', 'unknown'];
export const HOST_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];
export const STALE_AFTER_MS = 20 * 60 * 1000;
export const ENDED_AFTER_MS = 2 * 60 * 60 * 1000;
export const POST_TOOL_EVERY_MS = 60 * 1000;
export const KEEP_MS = 24 * 60 * 60 * 1000;
export const MAX_FILES = 200;
export const WAITING_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'];
const HASH = /^[0-9a-f]{64}$/;

export function hostSessionHash(session) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) throw new Error('host session ID must be 1-128 letters, digits or ._:- characters');
  return createHash('sha256').update(session).digest('hex');
}

export function stateFor(event, { notificationType } = {}) {
  switch (event) {
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit': case 'PostToolUse': return 'working';
    case 'PermissionRequest': return 'blocked';
    case 'Notification': return WAITING_NOTIFICATIONS.includes(notificationType) ? 'blocked' : null;
    case 'Stop': return 'done';
    case 'SessionEnd': return 'idle';
    default: return null;
  }
}

let lastSeq = 0;
export function nextSeq(now = Date.now()) {
  const micro = Math.floor((performance.timeOrigin + performance.now()) * 1000) % 1000;
  lastSeq = Math.max(lastSeq + 1, now * 1000 + micro);
  return lastSeq;
}

async function realDir(path) {
  try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`not a plain directory: ${path}`); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function hostDir(root, create) {
  const wax = join(root, '.wax'), chat = join(wax, 'chat'), host = join(chat, 'host');
  if (!await realDir(wax) || !await realDir(chat)) return null;
  if (await realDir(host)) return host;
  if (!create) return null;
  try { await mkdir(host); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return await realDir(host) ? host : null;
}

async function readRecord(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && value.schema === 1 && HOST_STATES.includes(value.state) && Number.isFinite(value.seq) ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeRecord(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await sleep(20 * (attempt + 1)); }
    }
  } finally { await rm(temp, { force: true }); }
}

async function tidy(dir, keep, now) {
  let names;
  try { names = (await readdir(dir)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name) && name !== keep); } catch { return; }
  const files = [];
  for (const name of names) {
    try { const info = await lstat(join(dir, name)); files.push({ name, mtime: info.mtimeMs }); } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const [index, file] of files.entries()) {
    if (index >= MAX_FILES - 1 || now - file.mtime > KEEP_MS) await rm(join(dir, file.name), { force: true });
  }
}

export async function recordHostEvent(root, input, { now = Date.now(), env = process.env, tool = 'claude' } = {}) {
  if (env.WAX_WORKER === '1') return { skipped: 'worker' };
  if (env.WAX_HOST_STATE === 'off') return { skipped: 'off' };
  if (!HOST_EVENTS.includes(input?.event)) return { skipped: 'event' };
  const state = stateFor(input.event, input);
  if (!state) return { skipped: 'no-change' };
  const hash = hostSessionHash(input.session);
  const dir = await hostDir(root, true);
  if (!dir) return { skipped: 'not-a-wax-project' };
  const file = join(dir, `${hash}.json`);
  const previous = await readRecord(file);
  if (input.event === 'PostToolUse' && previous?.state === 'working' && !previous.ended && now - Date.parse(previous.at) < POST_TOOL_EVERY_MS) return { skipped: 'recent' };
  const seq = nextSeq(now);
  if (previous && previous.seq >= seq) return { skipped: 'stale' };
  const detail = input.event === 'Notification' ? input.notificationType : input.event === 'PermissionRequest' ? input.toolName : null;
  const record = {
    schema: 1, tool, state, event: input.event, ...(typeof detail === 'string' && /^[\w.:-]{1,64}$/.test(detail) ? { detail } : {}),
    seq, at: new Date(now).toISOString(), seen: false, ...(input.event === 'SessionEnd' ? { ended: true } : {}),
  };
  await writeRecord(file, record);
  await tidy(dir, `${hash}.json`, now);
  return record;
}

export async function readHostState(root, hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) return null;
  const dir = await hostDir(root, false);
  return dir ? readRecord(join(dir, `${hash}.json`)) : null;
}

export function hostView(record, now = Date.now()) {
  if (!record) return null;
  const age = now - Date.parse(record.at);
  const ended = Boolean(record.ended) || !(age <= ENDED_AFTER_MS);
  let state = record.state;
  if (state === 'done' && record.seen) state = 'idle';
  if ((state === 'working' || state === 'blocked') && !(age <= STALE_AFTER_MS)) state = 'unknown';
  return { tool: record.tool, state, event: record.event, ...(record.detail ? { detail: record.detail } : {}), seq: record.seq, at: record.at, seen: Boolean(record.seen), ended };
}

export async function markHostSeen(root, hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) return null;
  const dir = await hostDir(root, false);
  if (!dir) return null;
  const file = join(dir, `${hash}.json`);
  const record = await readRecord(file);
  if (!record || record.state !== 'done' || record.seen) return record;
  const latest = await readRecord(file);
  if (!latest || latest.seq !== record.seq) return latest;
  const seen = { ...record, seen: true };
  await writeRecord(file, seen);
  return seen;
}
