import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newerThan } from '../../web/office/cli-news.mjs';

export const TOOL_BINS = [
  { kind: 'claude', label: 'Claude Code', bin: 'claude' },
  { kind: 'codex', label: 'Codex', bin: 'codex' },
  { kind: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot' },
  { kind: 'gemini', label: 'Gemini CLI', bin: 'gemini' },
  { kind: 'antigravity', label: 'Antigravity CLI', bin: 'agy' },
  { kind: 'grok', label: 'Grok Build', bin: 'grok' },
];
const VERSION_ARGS = { grok: ['version'] };
const TIMEOUT_MS = 8000;
const CACHE_MS = 10 * 60 * 1000;

export const parseVersion = (text) => String(text ?? '').match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? null;

function readVersion(bin) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const child = spawn(bin, VERSION_ARGS[bin] ?? ['--version'], { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); finish(null); }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += chunk; if (out.length > 4000) child.kill(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? parseVersion(out) : null); });
  });
}

export async function installedVersion(bin, { home = homedir(), platform = process.platform, read = readVersion } = {}) {
  const candidates = bin === 'claude' && platform !== 'win32' ? [join(home, '.local', 'bin', 'claude'), bin] : [bin];
  const versions = await Promise.all(candidates.map(read));
  return versions.filter(Boolean).reduce((latest, version) => !latest || newerThan(version, latest) ? version : latest, null);
}

let cache = null;
let pending = null;
export async function toolVersions({ now = Date.now(), run = installedVersion, fresh = false } = {}) {
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.tools;
  if (pending) return pending;
  const task = (async () => {
  const tools = await Promise.all(TOOL_BINS.map(async ({ kind, label, bin }) => {
    const version = await run(bin);
    return { kind, label, installed: Boolean(version), version };
  }));
  cache = { at: now, tools };
  return tools;
  })();
  pending = task;
  try { return await task; } finally { if (pending === task) pending = null; }
}
