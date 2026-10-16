import { CLI_NEWS, newerThan } from '../../web/office/cli-news.mjs';
export const NEWS_INTERVAL_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
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
export function createToolNews({ fetch: fetcher = globalThis.fetch, clock = Date.now } = {}) {
  let cached = structuredClone(CLI_NEWS), nextAt = 0, pending;
  return async function news({ fresh = false, enabled = true } = {}) {
    if (!enabled) return { ...structuredClone(CLI_NEWS), mode: 'bundled', intervalMs: NEWS_INTERVAL_MS };
    if (pending) return pending;
    if (!fresh && clock() < nextAt) return structuredClone(cached);
    const task = (async () => {
      const checkedAt = new Date(clock()).toISOString(); let failed = false;
      const entries = await Promise.all(Object.entries(SOURCES).map(async ([kind, url]) => {
        const previous = cached.tools[kind];
        try {
          const response = await fetcher(url, { headers: { 'user-agent': 'wax-tool-news', accept: kind === 'antigravity' ? 'text/html' : 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(7000) });
          const release = parseToolRelease(kind, await readLimited(response));
          if (newerThan(previous.latest, release.latest)) throw Error('Official release regressed');
          const items = release.latest === previous.latest ? previous.items : release.items;
          return [kind, { ...previous, ...release, items, checkedAt, verifiedAt: checkedAt, checkStatus: 'ok' }];
        } catch {
          failed = true; return [kind, { ...previous, checkedAt, checkStatus: 'unavailable' }];
        }
      }));
      nextAt = clock() + (failed ? RETRY_MS : NEWS_INTERVAL_MS);
      cached = { ...cached, mode: 'official', checkedAt, nextCheckAt: new Date(nextAt).toISOString(), intervalMs: NEWS_INTERVAL_MS, tools: Object.fromEntries(entries) };
      return structuredClone(cached);
    })();
    pending = task;
    try { return await task; } finally { if (pending === task) pending = null; }
  };
}
export const toolNews = createToolNews();
