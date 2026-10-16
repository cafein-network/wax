import { mkdir, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const registry = globalThis[Symbol.for('wax.file-locks')] ??= { queues: new Map(), active: new Set() };
export class LockError extends Error { constructor(message) { super(message); this.status = 409; } }
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
const info = async (path) => { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const read = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; } };
const birth = (s) => Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 && s.birthtimeMs !== s.ctimeMs ? s.birthtimeMs : null;
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && (birth(a) === null || birth(b) === null || birth(a) === birth(b));
const alive = (owner) => owner && (owner.pid === process.pid ? registry.active.has(owner.token) : processAlive(owner.pid));

async function reclaim(path, staleMs) {
  const original = await info(path);
  if (!original) return true;
  if (!original.isDirectory() || original.isSymbolicLink()) throw new LockError('잠금 경로는 일반 디렉터리이어야 합니다.');
  const owner = await read(join(path, 'owner.json'));
  if (alive(owner) || (!owner && Date.now() - original.mtimeMs < staleMs)) return false;
  const observed = await info(path);
  if (!same(original, observed)) return false;
  const claim = join(path, '.reclaim');
  const token = randomUUID();
  try { await mkdir(claim); }
  catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code !== 'EEXIST') throw e;
    const claimInfo = await info(claim), reaper = await read(join(claim, 'owner.json'));
    if (claimInfo && !alive(reaper) && Date.now() - claimInfo.mtimeMs > staleMs && same(original, await info(path))) {
      const moved = `${path}.reclaim-${randomUUID()}`;
      try { await rename(claim, moved); await rm(moved, { recursive: true, force: true }); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return false;
  }
  registry.active.add(token);
  const claimIdentity = await info(claim);
  let moved;
  try {
    await writeFile(join(claim, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    const latestInfo = await info(path);
    if (!same(original, latestInfo)) return false;
    const latest = await read(join(path, 'owner.json'));
    const ownerlessSince = observed.mtimeMs;
    if (alive(latest) || JSON.stringify(owner) !== JSON.stringify(latest) || (!latest && Date.now() - ownerlessSince < staleMs)) return false;
    moved = `${path}.stale-${randomUUID()}`;
    await rename(path, moved);
    await rm(moved, { recursive: true, force: true });
    return true;
  } catch (e) { if (e.code === 'ENOENT' || e.code === 'EEXIST') return false; throw e; }
  finally {
    registry.active.delete(token);
    if (!moved && same(claimIdentity, await info(claim))) await rm(claim, { recursive: true, force: true });
  }
}

export async function withFileLock(path, action, { timeoutMs = 5000, staleMs = 30_000 } = {}) {
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
      new Promise((_, reject) => { timer = setTimeout(() => reject(new LockError('다른 기록이 저장 중입니다. 잠시 후 다시 시도하세요.')), Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
    registry.active.add(token);
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    for (;;) {
      try {
        if (await info(path)) {
          if (await reclaim(path, staleMs)) continue;
        } else {
          await rename(candidate, path); identity = await info(path); break;
        }
      } catch (e) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code) || !await info(path)) throw e; }
      if (Date.now() >= deadline) throw new LockError('다른 기록이 저장 중입니다. 잠시 후 다시 시도하세요.');
      await sleep(10 + Math.floor(Math.random() * 30));
    }
    if (!same(identity, await info(path)) || (await read(join(path, 'owner.json')))?.token !== token) throw new LockError('저장 잠금이 변경되었습니다. 다시 시도하세요.');
    return await action();
  } finally {
    try {
      if (identity && same(identity, await info(path))) {
        const owner = await read(join(path, 'owner.json'));
        if (!owner || owner.token === token) await rm(path, { recursive: true, force: true });
      }
    } finally {
      try { await rm(candidate, { recursive: true, force: true }); }
      finally { clearTimeout(timer); registry.active.delete(token); release(); }
    }
  }
}
