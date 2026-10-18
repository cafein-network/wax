import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chatDir } from './paths.mjs';
import { writeJsonAtomic } from './store.mjs';

export const LISTEN_BEAT_MS = 30 * 1000;
export const LISTEN_STALE_MS = 3 * LISTEN_BEAT_MS;
const FORGET_MS = 24 * 60 * 60 * 1000;
const FILE = /^[0-9a-f]{32}\.[0-9a-z-]{1,40}\.json$/;
const MAX_BYTES = 4096;
const nameKey = (author) => createHash('sha256').update(author).digest('hex').slice(0, 32);

export async function startBeat(root, author, feature, beatMs, onError) {
  const dir = await chatDir(root, 'listeners', { create: true });
  const token = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(dir, `${nameKey(author)}.${token}.json`);
  let stopped = false, writing = Promise.resolve();
  const beat = () => (writing = writing.catch(() => {}).then(() => stopped ? undefined : writeJsonAtomic(file, { schema: 1, author, feature: feature ?? null, at: new Date().toISOString() })));
  await beat();
  const timer = setInterval(() => beat().catch(onError), beatMs);
  timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await writing.catch(() => {}); await rm(file, { force: true }).catch(() => {}); };
}

export async function listListeners(root, { now = new Date() } = {}) {
  const dir = await chatDir(root, 'listeners');
  const result = new Map();
  if (!dir) return result;
  for (const name of await readdir(dir)) {
    if (!FILE.test(name)) continue;
    try {
      const info = await lstat(join(dir, name));
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
      const age = now.getTime() - Date.parse(data?.at);
      if (age > FORGET_MS) { await rm(join(dir, name), { force: true }); continue; }
      if (typeof data?.author !== 'string' || !(age >= -LISTEN_STALE_MS && age <= LISTEN_STALE_MS)) continue;
      const previous = result.get(data.author);
      const features = !data.feature || previous?.features === null ? null : [...new Set([...(previous?.features ?? []), data.feature])];
      result.set(data.author, { features });
    } catch {   }
  }
  return result;
}
