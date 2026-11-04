import { t } from '../web/messages-catalog.mjs';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { WaxError } from './workflow.mjs';

export const AGENT_TOOLS = [
  { id: 'codex', label: 'Codex', bin: 'codex', launchers: ['@openai/codex/bin/codex.js'] },
  { id: 'claude', label: 'Claude Code', bin: 'claude', launchers: ['@anthropic-ai/claude-code/cli.js'] },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', launchers: ['@google/gemini-cli/bundle/gemini.js', '@google/gemini-cli/dist/index.js'] },
  { id: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot', launchers: ['@github/copilot/npm-loader.js'] },
  { id: 'antigravity', label: 'Antigravity CLI', bin: 'agy' },
];
export function agentTool(id = 'codex') {
  const tool = AGENT_TOOLS.find((item) => item.id === id);
  if (!tool) throw new WaxError(t('errors.agentTools.unsupportedExecutionTool'));
  return tool;
}
export async function resolveAgentCommand(id, { env = process.env, platform = process.platform } = {}) {
  const tool = agentTool(id);
  let hint = null;
  for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const candidates = platform === 'win32' ? [join(dir, `${tool.bin}.exe`), ...(tool.launchers ?? []).map((launcher) => join(dir, 'node_modules', launcher))] : [join(dir, tool.bin)];
    for (const file of candidates) {
      try {
        await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (id === 'copilot' && file.endsWith('npm-loader.js')) {
          const name = `@github/copilot-${platform}-${process.arch}`;
          try { const native = createRequire(file).resolve(name); await access(native); return [native, []]; }
          catch { hint = `${file}의 런처는 있지만 이 컴퓨터용 실행 파일(${name})이 없습니다. GitHub Copilot CLI를 다시 설치하세요.`; continue; }
        }
        return /\.[mc]?js$/.test(file) ? [process.execPath, [file]] : [file, []];
      } catch {   }
    }
    if (platform === 'win32' && !hint && await access(join(dir, `${tool.bin}.cmd`)).then(() => true, () => false)) {
      hint = `${join(dir, `${tool.bin}.cmd`)}는 있지만 셸 없이 실행할 ${tool.launchers?.length ? `런처(${tool.launchers.map((launcher) => join(dir, 'node_modules', launcher)).join(', ')})` : '실행 파일(.exe)'}를 찾지 못했습니다.`;
    }
  }
  throw new WaxError(t('errors.agentTools.executableNotFound', tool.label, hint ? `${hint} ` : ''));
}
const VERIFY_VERSION = new Set(['copilot']);
const VERSION_TIMEOUT_MS = 8000, VERSION_CACHE_MS = 10 * 60_000;
const versionCache = new Map();
export function commandVersion(command, args, { launch = spawn, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    let child;
    try { child = launch(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
    child.stdout?.on('data', (chunk) => { out += chunk; if (out.length > 4000) child.kill(); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? String(out).match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? null : null));
  });
}
async function verifiedVersion(command, args, { version, now }) {
  const key = JSON.stringify([command, ...args]);
  const hit = versionCache.get(key);
  if (hit && now - hit.at < VERSION_CACHE_MS) return hit.value;
  const value = await version(command, [...args, '--version']);
  versionCache.set(key, { at: now, value });
  return value;
}
export async function requestTools({ resolve = resolveAgentCommand, version = commandVersion, now = Date.now() } = {}) {
  return Promise.all(AGENT_TOOLS.map(async ({ id, label }) => {
    let installed = false;
    try {
      const [command, args] = await resolve(id);
      installed = VERIFY_VERSION.has(id) ? Boolean(await verifiedVersion(command, args, { version, now })) : true;
    } catch { installed = false; }
    return { id, label, installed, approval: id === 'antigravity' ? 'configured' : 'dashboard' };
  }));
}
