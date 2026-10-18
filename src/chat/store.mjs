import { appendFile, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkFile } from './paths.mjs';
import { withLock } from './lock.mjs';

export const makeId = (prefix, seq) => `${prefix}-${String(seq).padStart(6, '0')}-${randomBytes(3).toString('hex')}`;

export async function tailSeq(file) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  try {
    const { size } = await handle.stat();
    let chunk = 4096;
    for (;;) {
      const length = Math.min(size, chunk);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim());
      for (let i = lines.length - 1; i >= (length === size ? 0 : 1); i--) {
        try { const seq = JSON.parse(lines[i]).seq; if (Number.isSafeInteger(seq)) return seq; } catch {   }
      }
      if (length === size) return 0;
      chunk *= 4;
    }
  } finally { await handle.close(); }
}

export async function appendRecord(file, build) {
  await checkFile(file);
  return withLock(`${file}.lock`, async () => {
    const record = await build((await tailSeq(file)) + 1);
    await checkFile(file);
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  });
}

export function parseLines(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && Number.isSafeInteger(record.seq)) records.push(record); else skipped++;
    } catch { skipped++; }
  }
  return { records, skipped };
}

export async function readRecords(file) {
  await checkFile(file);
  try { return parseLines(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { records: [], skipped: 0 }; throw error; }
}

export async function writeJsonAtomic(path, value) {
  await checkFile(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break; }
      catch (error) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await sleep(20 * (attempt + 1)); }
    }
  } finally { await rm(temp, { force: true }); }
}
