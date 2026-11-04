import { t } from '../web/messages-catalog.mjs';
import { mkdir, lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const registry = globalThis[Symbol.for('wax.file-locks')] ??= { queues: new Map(), active: new Set() };
export class LockError extends Error { constructor(message) { super(message); this.status = 409; } }
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
const execFileAsync = promisify(execFile);
export async function processStartedAfter(pid, at, { run = execFileAsync, platform = process.platform, windows = true } = {}) {
  const markedAt = Date.parse(at);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(markedAt) || (platform === 'win32' && !windows)) return false;
  try {
    if (platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`], { timeout: 10_000, windowsHide: true });
      const started = stdout.trim() ? Number(stdout.trim()) : NaN;
      return Number.isFinite(started) ? started > markedAt + 1000 : null;
    }
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000 });
    const started = Date.parse(stdout.trim());
    return Number.isFinite(started) ? started > markedAt + 1000 : null;
  } catch { return null; }
}
const info = async (path) => { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const validOwner = (owner) => owner && typeof owner === 'object' && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
const read = async (path) => { try { return validOwner(JSON.parse(await readFile(path, 'utf8'))); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; } };
const birth = (s) => Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 && s.birthtimeMs !== s.ctimeMs ? s.birthtimeMs : null;
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && (birth(a) === null || birth(b) === null || birth(a) === birth(b));
const reuseChecks = registry.reuseChecks ??= new Map();
async function alive(owner, old = false) {
  if (!owner) return false;
  if (owner.pid === process.pid) return registry.active.has(owner.token);
  if (!processAlive(owner.pid)) return false;
  if (!old || typeof owner.at !== 'string') return true;
  const key = `${owner.pid} ${owner.at}`, now = Date.now();
  let check = reuseChecks.get(key);
  if (!check || check.until < now) {
    if (reuseChecks.size >= 256) reuseChecks.delete(reuseChecks.keys().next().value);
    check = { until: now + 60_000, reused: processStartedAfter(owner.pid, owner.at) };
    reuseChecks.set(key, check);
  }
  const reused = await check.reused;
  if (reused === null && reuseChecks.get(key) === check) reuseChecks.delete(key);
  return !reused;
}
const WINDOWS_BUSY = ['EPERM', 'EBUSY', 'EACCES'];
export async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (process.platform !== 'win32' || !WINDOWS_BUSY.includes(error.code) || attempt >= 30) throw error;
      await sleep(5 + attempt * 5);
    }
  }
}

async function sweepCandidates(path, staleMs) {
  const dir = dirname(path), now = Date.now();
  const sweeps = registry.sweeps ??= new Map();
  if (now - (sweeps.get(path) ?? -Infinity) < 60_000) return;
  if (sweeps.size >= 1024) sweeps.delete(sweeps.keys().next().value);
  sweeps.set(path, now);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return; throw error; }
  const prefix = `${basename(path)}.pending-`;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name.slice(prefix.length))) continue;
    const candidate = join(dir, entry.name), original = await info(candidate);
    if (!original?.isDirectory() || original.isSymbolicLink() || now - original.mtimeMs < Math.max(staleMs, 30_000)) continue;
    if (await alive(await read(join(candidate, 'owner.json')), true) || !same(original, await info(candidate))) continue;
    const moved = `${path}.stale-${randomUUID()}`;
    try { await rename(candidate, moved); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await rm(moved, { recursive: true, force: true });
  }
}

async function reclaim(path, staleMs) {
  const original = await info(path);
  if (!original) return true;
  if (!original.isDirectory() || original.isSymbolicLink()) throw new LockError(t('errors.fileLock.theLockPathMust'));
  const claim = join(path, '.reclaim');
  const pending = await info(claim);
  if (pending && Date.now() - pending.mtimeMs <= staleMs) return false;
  const owner = await read(join(path, 'owner.json'));
  const old = Date.now() - original.mtimeMs >= staleMs;
  if (await alive(owner, old) || (!owner && !old)) return false;
  const observed = await info(path);
  if (!same(original, observed)) return false;
  const token = randomUUID();
  try { await mkdir(claim); }
  catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code !== 'EEXIST') throw e;
    const claimInfo = await info(claim);
    if (!claimInfo || Date.now() - claimInfo.mtimeMs <= staleMs) return false;
    const reaper = await read(join(claim, 'owner.json'));
    if (!(await alive(reaper, true)) && same(original, await info(path))) {
      const moved = `${path}.reclaim-${randomUUID()}`;
      try { await renameWithRetry(claim, moved); await rm(moved, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return false;
  }
  registry.active.add(token);
  const claimIdentity = await info(claim);
  let moved;
  try {
    await writeFile(join(claim, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx' });
    const latestInfo = await info(path);
    if (!same(original, latestInfo)) return false;
    const latest = await read(join(path, 'owner.json'));
    const ownerlessSince = observed.mtimeMs;
    if (await alive(latest, old) || JSON.stringify(owner) !== JSON.stringify(latest) || (!latest && Date.now() - ownerlessSince < staleMs)) return false;
    const target = `${path}.stale-${randomUUID()}`;
    await renameWithRetry(path, target);
    moved = target;
    await rm(moved, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    return true;
  } catch (e) { if (e.code === 'ENOENT' || e.code === 'EEXIST') return false; throw e; }
  finally {
    registry.active.delete(token);
    if (!moved && same(claimIdentity, await info(claim))) await rm(claim, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

async function releaseLock(path) {
  const released = `${path}.released-${randomUUID()}`;
  try { await renameWithRetry(path, released); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    if (process.platform !== 'win32' || !WINDOWS_BUSY.includes(error.code)) throw error;
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    return;
  }
  await rm(released, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

export async function withFileLock(path, action, { timeoutMs = 5000, staleMs = 30_000, sweep = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  path = join(await realpath(dirname(path)), basename(path));
  const previous = registry.queues.get(path) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  registry.queues.set(path, tail);
  tail.then(() => { if (registry.queues.get(path) === tail) registry.queues.delete(path); });
  const token = randomUUID();
  let identity, timer;
  const candidate = `${path}.pending-${token}`;
  try {
    await Promise.race([
      previous.catch(() => {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new LockError(t('errors.fileLock.anotherRecordIsBeing'))), Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
    registry.active.add(token);
    if (sweep) await sweepCandidates(path, staleMs);
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    let vanished = 0;
    for (;;) {
      try {
        if (await info(path)) {
          if (await reclaim(path, staleMs)) continue;
        } else {
          await rename(candidate, path); identity = await info(path); break;
        }
      } catch (e) {
        const exists = Boolean(await info(path));
        if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') {
          vanished = exists ? 0 : vanished + 1;
          if (vanished > 20) throw e;
        } else {
          const transientWindowsRename = process.platform === 'win32' && e.code === 'EPERM';
          if (!['EPERM', 'EACCES'].includes(e.code) || (!transientWindowsRename && !exists)) throw e;
        }
      }
      if (Date.now() >= deadline) throw new LockError(t('errors.fileLock.anotherRecordIsBeing'));
      await sleep(10 + Math.floor(Math.random() * 30));
    }
    if (!same(identity, await info(path)) || (await read(join(path, 'owner.json')))?.token !== token) throw new LockError(t('errors.fileLock.theSaveLockChanged'));
    return await action();
  } finally {
    try {
      if (identity && same(identity, await info(path))) {
        const owner = await read(join(path, 'owner.json'));
        if (!owner || owner.token === token) await releaseLock(path);
      }
    } finally {
      try { await rm(candidate, { recursive: true, force: true }); }
      finally { clearTimeout(timer); registry.active.delete(token); release(); }
    }
  }
}
