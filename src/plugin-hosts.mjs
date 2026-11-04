import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { resolveAgentCommand } from './agent-tools.mjs';

export const WAX_REPO = 'cafein-network/wax';
const VERSION = /^\d+\.\d+\.\d+$/;

export function compareVersions(a, b) {
  if (!VERSION.test(a ?? '') || !VERSION.test(b ?? '')) return null;
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = (path) => stat(path).then(() => true, () => false);
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const remoteUrl = (value) => /^(https?:\/\/|git@|github:)/i.test(value ?? '') || /^[\w.-]+\/[\w.-]+$/.test(value ?? '');

export function codexMarketplace(toml) {
  const lines = toml.split(/\r?\n/), start = lines.findIndex((line) => /^\s*\[\s*marketplaces\s*\.\s*"?wax"?\s*\]\s*$/.test(line));
  if (start < 0) return null;
  const values = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*(source_type|source)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (match) values[match[1]] = match[2].replace(/\\(.)/g, '$1');
  }
  return values;
}

const cliJson = async (exec, id, args) => {
  const result = await exec(id, args, { timeoutMs: 60_000 });
  if (result.code !== 0) return null;
  return parseJson(result.stdout);
};

const reRegister = (tool, install) => [`${tool} plugin marketplace remove wax`, `${tool} plugin marketplace add ${WAX_REPO}`, `${tool} plugin ${install} wax@wax`];

export const PLUGIN_HOSTS = [
  {
    id: 'claude', label: 'Claude Code', restart: true,
    steps: [['plugin', 'marketplace', 'update', 'wax'], ['plugin', 'update', 'wax@wax']],
    reinstall: reRegister('claude', 'install'),
    async inspect({ exec, home, env }) {
      const list = await cliJson(exec, 'claude', ['plugin', 'list', '--json']);
      if (!Array.isArray(list)) return { installed: false };
      const plugin = list.find((item) => item?.id === 'wax@wax');
      if (!plugin) return { installed: false };
      const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
      const source = await readJson(join(dir, 'plugins', 'known_marketplaces.json')).then((all) => all?.wax?.source, () => null);
      const kind = !source ? 'unknown' : source.source === 'github' || remoteUrl(source.url ?? source.repo) ? 'remote' : 'local';
      return { installed: true, version: plugin.version ?? null, source: kind };
    },
  },
  {
    id: 'codex', label: 'Codex',
    steps: [['plugin', 'marketplace', 'upgrade', 'wax'], ['plugin', 'add', 'wax@wax']],
    reinstall: reRegister('codex', 'add'),
    async inspect({ exec, home, env }) {
      if (!(await exec.available('codex'))) return { installed: false };
      const dir = env.CODEX_HOME || join(home, '.codex');
      const versions = (await readdir(join(dir, 'plugins', 'cache', 'wax', 'wax')).catch(() => [])).filter((name) => VERSION.test(name));
      if (!versions.length) return { installed: false };
      versions.sort(compareVersions);
      const market = codexMarketplace(await readFile(join(dir, 'config.toml'), 'utf8').catch(() => ''));
      const kind = !market ? 'unknown' : market.source_type === 'git' || remoteUrl(market.source) ? 'remote' : 'local';
      return { installed: true, version: versions.at(-1), source: kind };
    },
  },
  {
    id: 'copilot', label: 'GitHub Copilot CLI',
    steps: [['plugin', 'update', 'wax@wax']],
    reinstall: reRegister('copilot', 'install'),
    async inspect({ exec }) {
      const list = await cliJson(exec, 'copilot', ['plugin', 'list', '--json']);
      const plugin = Array.isArray(list) && list.find((item) => item?.name === 'wax' && item?.marketplace === 'wax');
      if (!plugin) return { installed: false };
      const markets = await cliJson(exec, 'copilot', ['plugin', 'marketplace', 'list', '--json']);
      const market = Array.isArray(markets) ? markets.find((item) => item?.name === 'wax') : null;
      const kind = !market ? 'unknown' : /^GitHub:/i.test(market.source ?? '') || remoteUrl(market.source) ? 'remote' : 'local';
      return { installed: true, version: plugin.version ?? null, source: kind };
    },
  },
  {
    id: 'gemini', label: 'Gemini CLI', prompts: true,
    steps: [['extensions', 'update', 'wax']],
    reinstall: ['gemini extensions uninstall wax', `gemini extensions install https://github.com/${WAX_REPO}`],
    async inspect({ home }) {
      const dir = join(home, '.gemini', 'extensions', 'wax');
      const pkg = await readJson(join(dir, 'package.json')).catch(() => null);
      if (!pkg) return { installed: false };
      const install = await readJson(join(dir, '.gemini-extension-install.json')).catch(() => null);
      const kind = !install ? 'unknown' : ['github-release', 'git'].includes(install.type) || remoteUrl(install.source) ? 'remote' : 'local';
      return { installed: true, version: pkg.version ?? null, source: kind };
    },
  },
];

export const PROJECT_LINKS = [
  { id: 'antigravity', label: 'Antigravity CLI', location: ['.agents', 'skills'], bin: 'agy' },
  { id: 'grok', label: 'Grok Build', location: ['.grok', 'skills'], bin: 'grok' },
];

export async function onPath(bin, { env = process.env, platform = process.platform } = {}) {
  const names = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''].map((ext) => `${bin}${ext}`) : [bin];
  for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of names) if ((await stat(join(dir, name)).catch(() => null))?.isFile()) return true;
  }
  return false;
}

export async function inspectLink(project, link) {
  const path = join(project, ...link.location, 'wax-plan');
  const info = await lstat(path).catch(() => null);
  if (!info?.isSymbolicLink()) return { installed: false };
  let root;
  try { root = resolve(await realpath(path), '..', '..'); } catch { return { installed: false }; }
  const pkg = await readJson(join(root, 'package.json')).catch(() => null);
  return { installed: true, version: pkg?.version ?? null, source: 'link', root, git: await exists(join(root, '.git')) };
}

const PROMPT = /\[(?:Y\/n|y\/N|y\/n)\]|\(y\/n\)/i;
export function execCommand(command, args, { timeoutMs = 180_000, answer = null, launch = spawn } = {}) {
  return new Promise((done) => {
    let stdout = '', stderr = '', finished = false, timedOut = false, prompted = false, answered = false, child;
    const finish = (result) => { if (!finished) { finished = true; clearTimeout(timer); done({ stdout, stderr, timedOut, prompted, ...result }); } };
    try { child = launch(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { done({ code: null, stdout, stderr: error.message, timedOut, prompted }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const watch = () => {
      if (answered || prompted || !PROMPT.test(stdout.slice(-400) + stderr.slice(-400))) return;
      if (answer === null) { prompted = true; child.kill(); return; }
      answered = true;
      child.stdin.write(answer);
    };
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-20_000); watch(); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20_000); watch(); });
    child.on('error', (error) => finish({ code: null, stderr: stderr || error.message }));
    child.on('close', (code) => finish({ code: timedOut || prompted ? null : code }));
  });
}

export function toolExec({ resolveCommand = resolveAgentCommand, run = execCommand } = {}) {
  const exec = async (id, args, options) => {
    let command, prefix;
    try { [command, prefix] = await resolveCommand(id); }
    catch (error) { return { code: null, stdout: '', stderr: error.message, missing: true }; }
    return run(command, [...prefix, ...args], options);
  };
  exec.available = (id) => resolveCommand(id).then(() => true, () => false);
  return exec;
}
