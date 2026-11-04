import { t } from '../../web/messages-catalog.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getTeam, listTasks } from './team.mjs';
import { readFile } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WaxError } from '../workflow.mjs';
import * as v from './validate.mjs';
import { chatDir, checkFile } from './paths.mjs';
import { withLock } from './lock.mjs';
import { writeJsonAtomic } from './store.mjs';
import { listListeners } from './listeners.mjs';
import { hostSessionHash, hostView, markHostSeen, readHostState } from './host-state.mjs';

const dashboardUser = new AsyncLocalStorage();
export const withDashboardUser = (root, author, action) => dashboardUser.run({ root, author }, action);

export const AWAY_AFTER_MS = 10 * 60 * 1000;
export const NAME_LEASE_MS = 24 * 60 * 60 * 1000;
const sessionHashOf = (session) => {
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) throw new WaxError(t('errors.chat.presence.theSessionIdMust'));
  return createHash('sha256').update(session).digest('hex');
};
function checkSession(entry, session) {
  const hash = session === undefined ? null : sessionHashOf(session);
  if (entry?.sessionHash && session === undefined) throw new WaxError(t('errors.chat.presence.runThisCommandAgain'), 409);
  if (entry?.sessionHash ? hash !== entry.sessionHash : hash !== null) throw new WaxError(t('errors.chat.presence.sessionOwnershipOfThe'), 409);
}
const publicEntry = ({ sessionHash, hostSessionHash: host, session, ...entry }) => entry;
const hostLink = (entry) => (entry?.hostSessionHash ? { hostSessionHash: entry.hostSessionHash } : {});
function hostHashOf(value) {
  if (value === undefined || value === null || value === '') return null;
  try { return hostSessionHash(value); } catch (error) { throw new WaxError(error.message); }
}

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
    if (error instanceof SyntaxError) throw new WaxError(t('errors.chat.presence.presenceJsonIsCorrupted'), 500);
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

export function storedDashboardUser(root) {
  try {
    const file = join(root, '.wax', 'chat', 'presence.json');
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 1_000_000) return null;
    const name = JSON.parse(readFileSync(file, 'utf8'))?.dashboardAuthor;
    return typeof name === 'string' ? v.author(name) : null;
  } catch { return null; }
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
    ...(previous?.sessionHash ? { sessionHash: previous.sessionHash } : {}), ...hostLink(previous), author, kind: kind ?? previous?.kind ?? 'other', model: model ?? previous?.model ?? null, peer: peer ?? previous?.peer ?? null, state, feature, note, stateAt: at, lastActive: at,
  }));
}

export async function joinPresence(root, input = {}, { now = new Date() } = {}) {
  const requested = v.author(input.author);
  const session = input.session ?? randomUUID();
  if (input.rename && !input.session) throw new WaxError(t('errors.chat.presence.renamingRequiresTheExisting'));
  const sessionHash = sessionHashOf(session);
  if (input.state !== undefined) v.state(input.state);
  const kind = input.kind ? v.kind(input.kind) : null;
  const feature = input.feature ? v.channelId(input.feature) : null;
  const note = v.optionalText(input.note, v.LIMITS.note, '메모');
  const model = v.model(input.model), peer = v.peer(input.peer), at = now.toISOString();
  const via = v.via(input.via);
  const hostHash = hostHashOf(input.hostSession);
  const file = await presenceFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const data = await load(file);
    const owned = Object.values(data.agents).find((entry) => entry.sessionHash === sessionHash);
    const [{ pm }, tasks] = await Promise.all([getTeam(root), listTasks(root)]);
    const reserved = new Set([pm?.author, ...tasks.map((task) => task.to)]);
    if (input.rename && !owned) throw new WaxError(t('errors.chat.presence.noNameHasJoined'), 409);
    if (input.rename && requested !== owned.author && reserved.has(owned.author)) throw new WaxError(t('errors.chat.presence.thePmOrAn'), 409);
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
      if (n > 99) throw new WaxError(t('errors.chat.presence.allNamesAreIn', requested), 409);
      const suffix = `-${n}`;
      author = v.author(`${[...requested].slice(0, v.LIMITS.author - suffix.length).join('').trimEnd()}${suffix}`);
    }
    if (owned && input.rename && owned.author !== author) {
      delete data.agents[owned.author].sessionHash;
      Object.assign(data.agents[owned.author], { state: 'away', stateAt: at, lastActive: at });
    }
    const previous = owned;
    const host = hostHash ? { hostSessionHash: hostHash } : hostLink(previous);
    const entry = { schema: 2, author, sessionHash, ...host, kind: kind ?? previous?.kind ?? 'other', model: model ?? previous?.model ?? null, peer: peer ?? previous?.peer ?? null,
      state: input.state ?? (owned?.state === 'away' ? 'idle' : owned?.state) ?? 'idle', feature: input.feature === undefined ? owned?.feature ?? null : feature,
      note: input.note === undefined ? owned?.note ?? null : note, ...(via ? { via } : {}), stateAt: at, lastActive: at };
    data.schema = 2;
    data.agents[author] = entry;
    await writeJsonAtomic(file, data);
    const { sessionHash: hidden, hostSessionHash: hiddenHost, ...shown } = entry;
    return { ...shown, session, requested, renamed: author !== requested, hostLinked: Boolean(entry.hostSessionHash) };
  });
}

export async function resetPresence(root, input = {}, { now = new Date() } = {}) {
  const only = input.author === undefined ? null : v.author(input.author);
  const file = await presenceFile(root, false);
  if (!file) return { removed: [], kept: [] };
  return withLock(`${file}.lock`, async () => {
    const data = await load(file);
    const listeners = await listListeners(root, { now });
    const removed = [], kept = [];
    for (const [name, entry] of Object.entries(data.agents)) {
      if (only !== null && name !== only) continue;
      if (name === data.dashboardAuthor || entry.kind === 'human') continue;
      if (only === null && (listeners.has(name) || !['idle', 'away'].includes(effectiveState(entry, now)))) { kept.push(name); continue; }
      delete data.agents[name]; removed.push(name);
    }
    if (only !== null && !removed.length) throw new WaxError(t('errors.chat.presence.noSessionHasJoined', only), 404);
    if (removed.length) await writeJsonAtomic(file, data);
    return { removed: removed.sort(), kept: kept.sort() };
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
      schema: 2, ...(previous?.sessionHash ? { sessionHash: previous.sessionHash } : {}), ...hostLink(previous), author,
      kind: input.kind ?? previous?.kind ?? 'other', model: previous?.model ?? null, peer: previous?.peer ?? null,
      state: promote ? 'discussing' : previous.state,
      feature: previous?.feature ?? input.feature ?? null, note: input.note ?? previous?.note ?? null,
      ...(input.via ? { via: input.via } : {}), stateAt: promote ? at : previous.stateAt, lastActive: at,
    };
    await writeJsonAtomic(file, data);
    return result;
  });
}
export async function checkPresenceSession(root, { author, session }) {
  author = v.author(author);
  const file = await presenceFile(root, false);
  const data = file ? await load(file) : { agents: {} };
  checkSession(Object.hasOwn(data.agents, author) ? data.agents[author] : null, session);
}

export async function resolveKind(root, author, kind) {
  if (kind) return v.kind(kind);
  const file = await presenceFile(root, false);
  if (!file) return 'other';
  const { agents } = await load(file);
  return Object.hasOwn(agents, author) ? agents[author].kind ?? 'other' : 'other';
}

export function effectiveState(entry, now = new Date(), awayAfterMs = AWAY_AFTER_MS, host = null) {
  if (host) return host.ended ? 'away' : entry.state;
  return now.getTime() - Date.parse(entry.lastActive) > awayAfterMs ? 'away' : entry.state;
}

export async function listPresence(root, { now = new Date(), awayAfterMs = AWAY_AFTER_MS } = {}) {
  const file = await presenceFile(root, false);
  if (!file) return [];
  const { agents } = await load(file);
  const listeners = await listListeners(root, { now });
  const entries = await Promise.all(Object.values(agents).map(async (entry) => {
    const host = hostView(await readHostState(root, entry.hostSessionHash).catch(() => null), now.getTime());
    return { ...publicEntry(entry), ...(host ? { host } : {}), effectiveState: effectiveState(entry, now, awayAfterMs, host), listening: listeners.has(entry.author), listeningFeatures: listeners.get(entry.author)?.features ?? null };
  }));
  return entries.sort((a, b) => a.author.localeCompare(b.author));
}

export async function markPresenceSeen(root, author, { now = new Date() } = {}) {
  author = v.author(author);
  const file = await presenceFile(root, false);
  if (!file) return null;
  const { agents } = await load(file);
  const entry = Object.hasOwn(agents, author) ? agents[author] : null;
  if (!entry?.hostSessionHash) return null;
  return hostView(await markHostSeen(root, entry.hostSessionHash), now.getTime());
}

export const WAIT_UNTIL = ['done', 'blocked', 'idle'];
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitPresenceHost(root, author, { until = 'done', timeoutMs = 600_000, pollMs = 500, clock = () => Date.now(), sleep = sleepFor, signal } = {}) {
  author = v.author(author);
  if (!WAIT_UNTIL.includes(until)) throw new WaxError(t('errors.chat.presence.waitUntil', WAIT_UNTIL.join(', ')));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86_400_000) throw new WaxError(t('errors.chat.presence.waitTimeout'));
  const hashOf = async () => {
    const file = await presenceFile(root, false);
    const { agents } = file ? await load(file) : { agents: {} };
    return Object.hasOwn(agents, author) ? agents[author].hostSessionHash ?? null : null;
  };
  const hash = await hashOf();
  if (!hash) throw new WaxError(t('errors.chat.presence.noAutoState', author), 404);
  const start = (await readHostState(root, hash))?.seq ?? 0, began = clock();
  for (;;) {
    const record = await readHostState(root, hash);
    const view = hostView(record, clock());
    if (record && record.seq > start) {
      if (view.ended) return { author, matched: false, ended: true, state: view.state, at: record.at };
      const hit = until === 'idle' ? ['idle', 'done'].includes(record.state) : record.state === until;
      if (hit) return { author, matched: true, state: view.state, event: record.event, at: record.at };
    }
    if (clock() - began >= timeoutMs || signal?.aborted) return { author, matched: false, timedOut: true, state: view?.state ?? null };
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (clock() - began))));
  }
}
