import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getTeam, listTasks } from './team.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WaxError } from '../workflow.mjs';
import * as v from './validate.mjs';
import { chatDir, checkFile } from './paths.mjs';
import { withLock } from './lock.mjs';
import { writeJsonAtomic } from './store.mjs';
import { listListeners } from './listeners.mjs';

const dashboardUser = new AsyncLocalStorage();
export const withDashboardUser = (root, author, action) => dashboardUser.run({ root, author }, action);

export const AWAY_AFTER_MS = 10 * 60 * 1000;
export const NAME_LEASE_MS = 24 * 60 * 60 * 1000;
const sessionHashOf = (session) => {
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) throw new WaxError('세션 ID는 영문·숫자와 . _ : - 로 된 128자 이하 문자열이어야 합니다.');
  return createHash('sha256').update(session).digest('hex');
};
function checkSession(entry, session) {
  const hash = session === undefined ? null : sessionHashOf(session);
  if (entry?.sessionHash && session === undefined) throw new WaxError('참여할 때 저장한 세션 ID를 이 명령에 --session <ID>로 붙여 다시 실행하세요. ID를 잃었다면 다시 join한 뒤 반환된 이름과 ID를 사용하세요.', 409);
  if (entry?.sessionHash ? hash !== entry.sessionHash : hash !== null) throw new WaxError('이름의 세션 소유권이 변경되었습니다. --session ID로 다시 join한 뒤 반환된 이름을 사용하세요.', 409);
}
const publicEntry = ({ sessionHash, session, ...entry }) => entry;

async function presenceFile(root, create) {
  const dir = await chatDir(root, null, { create });
  return dir && join(dir, 'presence.json');
}

async function load(file) {
  await checkFile(file);
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data.agents === 'object' ? data : { schema: 1, agents: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, agents: {} };
    if (error instanceof SyntaxError) throw new WaxError('presence.json이 손상되었습니다.', 500);
    throw error;
  }
}

async function update(root, author, session, change) {
  const file = await presenceFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const data = await load(file);
    const previous = Object.hasOwn(data.agents, author) ? data.agents[author] : null;
    checkSession(previous, session);
    const entry = { schema: 2, ...change(previous) };
    data.schema = 2;
    data.agents[author] = entry;
    await writeJsonAtomic(file, data);
    return publicEntry(entry);
  });
}

export async function reserveDashboardUser(root, author) {
  author = v.author(author);
  const file = await presenceFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const data = await load(file);
    if (data.dashboardAuthor !== author) { data.dashboardAuthor = author; await writeJsonAtomic(file, data); }
  });
}

export async function setPresence(root, input = {}, { now = new Date() } = {}) {
  const author = v.author(input.author);
  const state = v.state(input.state);
  const kind = input.kind ? v.kind(input.kind) : null;
  const feature = input.feature ? v.channelId(input.feature) : null;
  const note = v.optionalText(input.note, v.LIMITS.note, '메모');
  const model = v.model(input.model), peer = v.peer(input.peer);
  const at = now.toISOString();
  return update(root, author, input.session, (previous) => ({
    ...(previous?.sessionHash ? { sessionHash: previous.sessionHash } : {}), author, kind: kind ?? previous?.kind ?? 'other', model: model ?? previous?.model ?? null, peer: peer ?? previous?.peer ?? null, state, feature, note, stateAt: at, lastActive: at,
  }));
}

export async function joinPresence(root, input = {}, { now = new Date() } = {}) {
  const requested = v.author(input.author);
  const session = input.session ?? randomUUID();
  if (input.rename && !input.session) throw new WaxError('이름 변경에는 기존 --session ID가 필요합니다.');
  const sessionHash = sessionHashOf(session);
  if (input.state !== undefined) v.state(input.state);
  const kind = input.kind ? v.kind(input.kind) : null;
  const feature = input.feature ? v.channelId(input.feature) : null;
  const note = v.optionalText(input.note, v.LIMITS.note, '메모');
  const model = v.model(input.model), peer = v.peer(input.peer), at = now.toISOString();
  const file = await presenceFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const data = await load(file);
    const owned = Object.values(data.agents).find((entry) => entry.sessionHash === sessionHash);
    const [{ pm }, tasks] = await Promise.all([getTeam(root), listTasks(root)]);
    const reserved = new Set([pm?.author, ...tasks.map((task) => task.to)]);
    if (input.rename && !owned) throw new WaxError('이 세션 ID로 참여한 이름이 없습니다.', 409);
    if (input.rename && requested !== owned.author && reserved.has(owned.author)) throw new WaxError('PM 또는 미완료 업무의 담당자는 이름을 바꿀 수 없습니다. 먼저 역할과 업무를 정리하세요.', 409);
    const free = (name) => {
      const entry = Object.hasOwn(data.agents, name) ? data.agents[name] : null;
      if (entry?.sessionHash === sessionHash) return true;
      if (name === data.dashboardAuthor) return false;
      if (!entry) return true;
      if (!entry.sessionHash && entry.schema !== 2 && (kind === entry.kind || effectiveState(entry, now) === 'away')) return true;
      const age = now.getTime() - Date.parse(entry?.lastActive);
      const expired = entry && (!Number.isFinite(age) || age >= NAME_LEASE_MS || age < -AWAY_AFTER_MS);
      if (expired) return true;
      return !reserved.has(name) && (!entry || entry.state === 'away');
    };
    let author = owned && !input.rename ? owned.author : requested;
    for (let n = 2; !free(author); n++) {
      if (n > 99) throw new WaxError(`${requested} 이름이 모두 쓰이고 있습니다. 다른 이름을 정하세요.`, 409);
      const suffix = `-${n}`;
      author = v.author(`${[...requested].slice(0, v.LIMITS.author - suffix.length).join('').trimEnd()}${suffix}`);
    }
    if (owned && input.rename && owned.author !== author) {
      delete data.agents[owned.author].sessionHash;
      Object.assign(data.agents[owned.author], { state: 'away', stateAt: at, lastActive: at });
    }
    const previous = owned;
    const entry = { schema: 2, author, sessionHash, kind: kind ?? previous?.kind ?? 'other', model: model ?? previous?.model ?? null, peer: peer ?? previous?.peer ?? null,
      state: input.state ?? (owned?.state === 'away' ? 'idle' : owned?.state) ?? 'idle', feature: input.feature === undefined ? owned?.feature ?? null : feature,
      note: input.note === undefined ? owned?.note ?? null : note, stateAt: at, lastActive: at };
    data.schema = 2;
    data.agents[author] = entry;
    await writeJsonAtomic(file, data);
    const { sessionHash: hidden, ...publicEntry } = entry;
    return { ...publicEntry, session, requested, renamed: author !== requested };
  });
}

export async function withPresenceActivity(root, input, action, { now = new Date() } = {}) {
  const author = v.author(input.author), at = now.toISOString();
  const file = await presenceFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const data = await load(file);
    const previous = Object.hasOwn(data.agents, author) ? data.agents[author] : null;
    const human = dashboardUser.getStore();
    const isDashboardUser = human?.root === root && human.author === author;
    if (!isDashboardUser) checkSession(previous, input.session);
    if (isDashboardUser && previous?.sessionHash) return action();
    const result = await action();
    const promote = !previous || ['idle', 'away'].includes(previous.state);
    data.schema = 2;
    data.agents[author] = {
      schema: 2, ...(previous?.sessionHash ? { sessionHash: previous.sessionHash } : {}), author,
      kind: input.kind ?? previous?.kind ?? 'other', model: previous?.model ?? null, peer: previous?.peer ?? null,
      state: promote ? 'discussing' : previous.state,
      feature: previous?.feature ?? input.feature ?? null, note: input.note ?? previous?.note ?? null,
      stateAt: promote ? at : previous.stateAt, lastActive: at,
    };
    await writeJsonAtomic(file, data);
    return result;
  });
}
export async function touchPresence(root, input, clock) {
  await withPresenceActivity(root, input, async () => {}, clock);
  return (await listPresence(root, clock)).find((entry) => entry.author === input.author);
}

export async function resolveKind(root, author, kind) {
  if (kind) return v.kind(kind);
  const file = await presenceFile(root, false);
  if (!file) return 'other';
  const { agents } = await load(file);
  return Object.hasOwn(agents, author) ? agents[author].kind ?? 'other' : 'other';
}

export function effectiveState(entry, now = new Date(), awayAfterMs = AWAY_AFTER_MS) {
  return now.getTime() - Date.parse(entry.lastActive) > awayAfterMs ? 'away' : entry.state;
}

export async function listPresence(root, { now = new Date(), awayAfterMs = AWAY_AFTER_MS } = {}) {
  const file = await presenceFile(root, false);
  if (!file) return [];
  const { agents } = await load(file);
  const listeners = await listListeners(root, { now });
  return Object.values(agents)
    .map((entry) => ({ ...publicEntry(entry), effectiveState: effectiveState(entry, now, awayAfterMs), listening: listeners.has(entry.author), listeningFeatures: listeners.get(entry.author)?.features ?? null }))
    .sort((a, b) => a.author.localeCompare(b.author));
}
