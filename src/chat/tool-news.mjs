import { CLI_NEWS, newerThan } from '../../web/office/cli-news.mjs';
export const NEWS_INTERVAL_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const FRESH_INTERVAL_MS = 60_000;
const SOURCES = {
  claude: 'https://api.github.com/repos/anthropics/claude-code/releases/latest',
  codex: 'https://api.github.com/repos/openai/codex/releases/latest',
  copilot: 'https://api.github.com/repos/github/copilot-cli/releases/latest',
  gemini: 'https://api.github.com/repos/google-gemini/gemini-cli/releases/latest',
  antigravity: 'https://antigravity.google/docs/changelog/',
};
const REPOS = { claude: 'anthropics/claude-code', codex: 'openai/codex', copilot: 'github/copilot-cli', gemini: 'google-gemini/gemini-cli' };
const plain = (text) => String(text).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, x => ({ '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'" })[x]).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+|\(#\d+(?:, #\d+)*\)|[`*_]/g, '').replace(/\s+/g, ' ').trim();
const short = (text) => { const value = plain(text); return value.length > 90 ? value.slice(0, 89) + '…' : value; };
export function parseToolRelease(kind, body) {
  if (kind === 'antigravity') {
    const release = body.match(/<article\b[^>]*\bid="rel-cli-(\d+\.\d+\.\d+)"[^>]*>([\s\S]*?)<\/article>/);
    if (!release) throw Error('CLI release missing');
    const items = [...release[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].slice(0, 3).map(x => ({ version: release[1], text: short(x[1]), original: true }));
    if (!items.length) throw Error('CLI notes missing');
    return { latest: release[1], items, source: SOURCES.antigravity, publishedAt: release[2].match(/<time\b[^>]*datetime="([^"]+)"/)?.[1] ?? null };
  }
  const data = JSON.parse(body), version = String(data.tag_name).match(/^(?:rust-v|v)?(\d+\.\d+\.\d+)$/)?.[1];
  if (!version || data.draft || data.prerelease || typeof data.body !== 'string' || !Number.isFinite(Date.parse(data.published_at))) throw Error('Stable release missing');
  const items = data.body.split('\n').filter(x => /^\s*[-*] /.test(x)).slice(0, 3).map(x => ({ version, text: short(x.replace(/^\s*[-*] /, '')), original: true }));
  if (!items.length) throw Error('Release notes missing');
  return { latest: version, items, source: `https://github.com/${REPOS[kind]}/releases/tag/${encodeURIComponent(data.tag_name)}`, publishedAt: data.published_at };
}
async function readLimited(response) {
  if (!response.ok) throw Error('Official source unavailable');
  const parts = []; let length = 0;
  for await (const part of response.body) {
    length += part.length; if (length > 2_000_000) throw Error('Official source too large'); parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

function rateLimitDelay(response, now) {
  const retry = response.headers.get('retry-after');
  const seconds = retry?.trim() ? Number(retry) : NaN;
  const retryAt = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retry);
  const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  const times = [retryAt, resetAt].filter(at => Number.isFinite(at) && at > now && at <= 8.64e15);
  return times.length ? Math.max(RETRY_MS, ...times.map(at => at - now)) : NEWS_INTERVAL_MS;
}

export function createToolNews({ fetch: fetcher = globalThis.fetch, clock = Date.now } = {}) {
  let cached = structuredClone(CLI_NEWS), nextFreshAt = 0, pending;
  const schedules = Object.fromEntries(Object.keys(SOURCES).map(kind => [kind, { nextAt: 0, blockedUntil: 0, failures: 0 }]));
  return async function news({ fresh = false, enabled = true } = {}) {
    if (!enabled) return { ...structuredClone(CLI_NEWS), mode: 'bundled', intervalMs: NEWS_INTERVAL_MS };
    if (pending) return structuredClone(await pending);
    const now = clock(), force = fresh && now >= nextFreshAt;
    const due = Object.entries(SOURCES).filter(([kind]) => now >= schedules[kind].nextAt || (force && now >= schedules[kind].blockedUntil));
    if (!due.length) return structuredClone(cached);
    if (force) nextFreshAt = now + FRESH_INTERVAL_MS;
    const task = (async () => {
      const checkedAt = new Date(now).toISOString();
      const entries = await Promise.all(due.map(async ([kind, url]) => {
        const previous = cached.tools[kind], schedule = schedules[kind];
        try {
          const response = await fetcher(url, { headers: { 'user-agent': 'wax-tool-news', accept: kind === 'antigravity' ? 'text/html' : 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(7000) });
          if (response.status === 403 || response.status === 429) {
            schedule.blockedUntil = clock() + rateLimitDelay(response, clock());
            await response.body?.cancel();
            throw Error('Official source rate limited');
          }
          const release = parseToolRelease(kind, await readLimited(response));
          schedule.failures = 0;
          schedule.blockedUntil = 0;
          schedule.nextAt = clock() + NEWS_INTERVAL_MS;
          if (newerThan(previous.latest, release.latest)) return [kind, { ...previous, checkedAt, verifiedAt: checkedAt, checkStatus: 'ok' }];
          const items = release.latest === previous.latest ? previous.items : release.items;
          return [kind, { ...previous, ...release, items, checkedAt, verifiedAt: checkedAt, checkStatus: 'ok' }];
        } catch {
          schedule.failures++;
          const backoff = Math.min(NEWS_INTERVAL_MS, RETRY_MS * 2 ** Math.min(schedule.failures - 1, 4));
          schedule.nextAt = Math.max(clock() + backoff, schedule.blockedUntil);
          return [kind, { ...previous, checkedAt, checkStatus: 'unavailable' }];
        }
      }));
      const nextAt = Math.min(...Object.values(schedules).map(schedule => schedule.nextAt));
      cached = { ...cached, mode: 'official', checkedAt, nextCheckAt: new Date(nextAt).toISOString(), intervalMs: NEWS_INTERVAL_MS, tools: { ...cached.tools, ...Object.fromEntries(entries) } };
      return structuredClone(cached);
    })();
    pending = task;
    try { return await task; } finally { if (pending === task) pending = null; }
  };
}
export const toolNews = createToolNews();
