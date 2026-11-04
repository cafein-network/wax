import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkFile, safeDir } from './paths.mjs';

export const USAGE_STALE_MS = 24 * 60 * 60 * 1000;
export const USAGE_ENDED_MS = 5 * 60 * 1000;
const FILE = /^[A-Za-z0-9-]{8,64}\.json$/;
const LIMIT_KINDS = new Set(['five_hour', 'seven_day', 'spend_limit']);
const num = (value, max = Infinity) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null);
const iso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);
const text = (value, max = 80) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

export function cleanUsage(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1 || typeof raw.session !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(raw.session)) return null;
  const at = iso(raw.at);
  if (!at) return null;
  return {
    tool: raw.tool === 'claude' ? 'claude' : 'other',
    session: raw.session, model: text(raw.model), at, ended: raw.ended === true,
    context: raw.context ? { percent: num(raw.context.percent, 100), tokens: num(raw.context.tokens), window: num(raw.context.window) } : null,
    rateLimits: (Array.isArray(raw.rateLimits) ? raw.rateLimits : [])
      .filter((limit) => limit && LIMIT_KINDS.has(limit.kind) && num(limit.percentUsed, 1000) !== null)
      .map((limit) => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: iso(limit.resetsAt) })),
    costUsd: num(raw.costUsd),
  };
}

export async function listUsage(root, { now = Date.now() } = {}) {
  const dir = await safeDir(root, ['.wax', 'usage']);
  const records = [];
  if (dir) {
    for (const name of (await readdir(dir)).filter((file) => FILE.test(file))) {
      try {
        const record = cleanUsage(JSON.parse(await readFile(await checkFile(join(dir, name)), 'utf8')));
        if (record) records.push(record);
      } catch {   }
    }
  }
  const age = (record) => now - Date.parse(record.at);
  const live = records.filter((record) => age(record) <= USAGE_STALE_MS && !(record.ended && age(record) > USAGE_ENDED_MS)).sort((a, b) => b.at.localeCompare(a.at));
  const withLimits = records.filter((record) => record.rateLimits.length && age(record) <= USAGE_STALE_MS).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  return {
    claude: {
      limits: withLimits?.rateLimits ?? [], limitsAt: withLimits?.at ?? null,
      sessions: live.filter((record) => record.tool === 'claude').map(({ session, model, at, ended, context, costUsd }) => ({ session, model, at, ended, context, costUsd })),
    },
  };
}
