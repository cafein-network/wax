import { t } from '../web/messages-catalog.mjs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cliText } from './cli-locale.mjs';
import { PLUGIN_HOSTS, PROJECT_LINKS, WAX_REPO, compareVersions, inspectLink, onPath, toolExec } from './plugin-hosts.mjs';

const INSTALLER = fileURLToPath(new URL('../scripts/install-project.mjs', import.meta.url));

const STEP_TIMEOUT_MS = 180_000, LATEST_TIMEOUT_MS = 5000;
const HISTORY = /unrelated histor|refusing to merge|non-fast-forward|divergent|diverged|not possible to fast-forward/i;
export const UPDATE_TOOLS = [...PLUGIN_HOSTS, ...PROJECT_LINKS].map((item) => item.id);

export async function latestRelease({ fetchImpl = globalThis.fetch, timeoutMs = LATEST_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${WAX_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'wax-update' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { version: null, error: `HTTP ${response.status}` };
    const version = String((await response.json())?.tag_name ?? '').replace(/^v/, '');
    return /^\d+\.\d+\.\d+$/.test(version) ? { version } : { version: null, error: 'tag' };
  } catch (error) { return { version: null, error: error.name === 'TimeoutError' ? 'timeout' : error.message }; }
}

function judge(state, latest) {
  if (!state.installed) return state.binary ? 'unlinked' : 'missing';
  if (state.source === 'local') return 'local';
  const order = compareVersions(state.version, latest);
  if (order === null) return 'unknown';
  return order < 0 ? 'outdated' : 'current';
}

export async function checkUpdates({ tools = UPDATE_TOOLS, project = process.cwd(), home = homedir(), env = process.env, exec = toolExec(), latest, platform = process.platform } = {}) {
  const release = latest ?? await latestRelease();
  const ctx = { exec, home, env };
  const hosts = await Promise.all([...PLUGIN_HOSTS, ...PROJECT_LINKS].filter((item) => tools.includes(item.id)).map(async (item) => {
    let state;
    try {
      state = item.location ? await inspectLink(project, item) : await item.inspect(ctx);
      if (item.location && !state.installed && item.bin && await onPath(item.bin, { env, platform })) state = { ...state, binary: true, project };
    }
    catch (error) { return { id: item.id, label: item.label, installed: false, status: 'error', error: error.message }; }
    return { id: item.id, label: item.label, ...state, status: judge(state, release.version) };
  }));
  return { latest: release.version, latestError: release.error ?? null, hosts };
}

export async function runUpdates(report, { yes = false, home = homedir(), env = process.env, exec = toolExec(), timeoutMs = STEP_TIMEOUT_MS, onStep = () => {} } = {}) {
  const hosts = [];
  for (const host of report.hosts) {
    const item = PLUGIN_HOSTS.find((entry) => entry.id === host.id);
    if (!item || !['outdated', 'unknown'].includes(host.status)) { hosts.push(host); continue; }
    const steps = [];
    let failure = null;
    for (const args of item.steps) {
      onStep(host, args);
      const result = await exec(item.id, args, { timeoutMs, answer: item.prompts && yes ? 'y\n' : null });
      const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
      steps.push({ command: [item.id, ...args].join(' '), code: result.code, timedOut: Boolean(result.timedOut), prompted: Boolean(result.prompted) });
      if (result.prompted) failure = { status: 'prompted' };
      else if (result.timedOut) failure = { status: 'timeout' };
      else if (result.code !== 0) failure = { status: 'failed', error: output.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || `exit ${result.code}`, history: HISTORY.test(output) };
      if (failure) break;
    }
    if (failure) { hosts.push({ ...host, ...failure, steps, command: steps.at(-1).command }); continue; }
    const after = await item.inspect({ exec, home, env }).catch(() => ({ installed: true, version: null }));
    const changed = after.version && after.version !== host.version;
    const behind = compareVersions(after.version, report.latest);
    let status = changed ? 'updated' : 'current';
    if (behind !== null && behind < 0) status = 'unchanged';
    hosts.push({ ...host, before: host.version, version: after.version ?? host.version, status, steps, restart: status === 'updated' && Boolean(item.restart) });
  }
  return { ...report, hosts };
}

const PROBLEM = new Set(['failed', 'prompted', 'timeout', 'unchanged', 'error']);

function describe(host, say) {
  const reinstall = PLUGIN_HOSTS.find((item) => item.id === host.id)?.reinstall;
  switch (host.status) {
    case 'missing': return say('cli.update.missing');
    case 'unlinked': return `${say('cli.update.unlinked')}
    ${say('cli.update.linkHint', `node "${INSTALLER}" --project "${host.project}"`)}`;
    case 'current': return say('cli.update.current');
    case 'outdated': return say('cli.update.outdated');
    case 'unknown': return say('cli.update.unknown');
    case 'local': return say('cli.update.local');
    case 'updated': return say('cli.update.updated') + (host.restart ? ` ${say('cli.update.restart')}` : '');
    case 'unchanged': return say('cli.update.unchanged', host.version ?? '-');
    case 'prompted': return say('cli.update.prompted', host.command);
    case 'timeout': return say('cli.update.timeout', Math.round(STEP_TIMEOUT_MS / 1000), host.command);
    case 'failed': return say('cli.update.failed', host.command, host.error) + (host.history && reinstall ? `\n    ${say('cli.update.history', reinstall.join(' → '))}` : '');
    case 'error': return say('cli.update.error', host.error);
    default: return host.status;
  }
}

function linkHint(host, latest, say) {
  if (host.source !== 'link' || !host.installed) return '';
  const order = compareVersions(host.version, latest);
  if (order === null || order >= 0) return '';
  return `\n    ${say(host.git ? 'cli.update.linkGit' : 'cli.update.linkZip', host.root)}`;
}

const sourceText = (source, say) => ({ remote: say('cli.update.source.remote'), local: say('cli.update.source.local'), link: say('cli.update.source.link') })[source] ?? say('cli.update.source.unknown');

export function formatReport(report, say, { check = false } = {}) {
  const lines = [report.latest ? say('cli.update.latest', report.latest) : say('cli.update.latestUnknown', report.latestError ?? '-'), ''];
  const width = Math.max(...report.hosts.map((host) => host.label.length), 10) + 2;
  for (const host of report.hosts) {
    const version = !host.installed ? '-' : host.before && host.before !== host.version ? `${host.before} → ${host.version}` : host.version ?? '?';
    const source = !host.installed ? '' : sourceText(host.source, say);
    lines.push(`${host.label.padEnd(width)}${version.padEnd(18)}${source.padEnd(10)}${describe(host, say)}${linkHint(host, report.latest, say)}`);
  }
  lines.push('');
  if (check && report.hosts.some((host) => host.status === 'outdated')) lines.push(say('cli.update.runHint'));
  else if (!check && report.hosts.some((host) => host.status === 'updated')) lines.push(say('cli.update.sessions'));
  return lines.join('\n').trimEnd();
}

export function exitCode(report, { check = false } = {}) {
  if (report.hosts.some((host) => PROBLEM.has(host.status))) return 1;
  if (check && report.hosts.some((host) => host.status === 'outdated' || (host.source === 'link' && compareVersions(host.version, report.latest) < 0))) return 2;
  return 0;
}

export async function updateCli(args, { out = (text) => console.log(text), ...deps } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, check: { type: 'boolean' }, tool: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const { say } = cliText();
  if (values.help) { out(say('cli.update.help')); return 0; }
  if (positionals.length) throw new Error(t('errors.updateCli.usage'));
  const tools = values.tool ? values.tool.split(',').map((id) => id.trim()).filter(Boolean) : UPDATE_TOOLS;
  const unknown = tools.find((id) => !UPDATE_TOOLS.includes(id));
  if (unknown || !tools.length) throw new Error(t('errors.updateCli.unknownTool', unknown ?? '', UPDATE_TOOLS.join(', ')));
  const project = resolve(values.project ?? process.cwd());
  let report = await checkUpdates({ ...deps, tools, project });
  if (!values.check) {
    report = await runUpdates(report, { ...deps, yes: Boolean(values.yes), onStep: values.json ? () => {} : (host, step) => out(say('cli.update.running', host.label, [host.id, ...step].join(' '))) });
  }
  out(values.json ? JSON.stringify(report, null, 2) : formatReport(report, say, { check: Boolean(values.check) }));
  return exitCode(report, { check: Boolean(values.check) });
}
