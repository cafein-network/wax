import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUpdates, exitCode, formatReport, latestRelease, runUpdates, updateCli } from '../src/update-cli.mjs';
import { codexMarketplace, compareVersions, execCommand, onPath, toolExec } from '../src/plugin-hosts.mjs';

const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
const latest = { version: '0.15.2' };

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const put = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); };

async function fakeHome(t, { claude = '0.15.0', codex = '0.15.0', gemini = '0.15.0', local = false } = {}) {
  const home = await temp(t);
  await put(join(home, '.claude/plugins/known_marketplaces.json'), { wax: { source: local ? { source: 'directory', path: 'C:/Tools/wax' } : { source: 'github', repo: 'cafein-network/wax' } } });
  if (codex) {
    await mkdir(join(home, '.codex/plugins/cache/wax/wax', codex), { recursive: true });
    await put(join(home, '.codex/config.toml'), '[marketplaces.wax]\nsource_type = "git"\nsource = "https://github.com/cafein-network/wax.git"\n');
  }
  if (gemini) {
    await put(join(home, '.gemini/extensions/wax/package.json'), { version: gemini });
    await put(join(home, '.gemini/extensions/wax/.gemini-extension-install.json'), { source: 'https://github.com/cafein-network/wax', type: 'github-release' });
  }
  return home;
}

function fakeExec(state, { fail = {}, prompt = [], available = ['claude', 'codex', 'copilot', 'gemini'] } = {}) {
  const calls = [];
  const exec = async (id, args, options = {}) => {
    const command = [id, ...args].join(' ');
    calls.push({ command, answer: options.answer ?? null });
    if (!available.includes(id)) return { code: null, stdout: '', stderr: 'not found', missing: true };
    if (command === 'claude plugin list --json') return { code: 0, stdout: JSON.stringify(state.claude ? [{ id: 'wax@wax', version: state.claude }] : []) };
    if (command === 'copilot plugin list --json') return { code: 0, stdout: JSON.stringify(state.copilot ? [{ name: 'wax', marketplace: 'wax', version: state.copilot }] : []) };
    if (command === 'copilot plugin marketplace list --json') return { code: 0, stdout: JSON.stringify([{ name: 'wax', source: 'GitHub: cafein-network/wax' }]) };
    if (fail[command]) return { code: 1, stdout: '', stderr: fail[command] };
    if (prompt.includes(command) && options.answer === null) return { code: null, stdout: 'Do you want to continue? [Y/n]: ', stderr: '', prompted: true };
    if (state.onUpdate?.[command]) await state.onUpdate[command]();
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  exec.available = async (id) => available.includes(id);
  return { exec, calls };
}

test('versions compare numerically and the Codex marketplace table is read without other sections', () => {
  assert.ok(compareVersions('0.9.10', '0.15.2') < 0);
  assert.ok(compareVersions('0.15.10', '0.15.2') > 0);
  assert.equal(compareVersions('0.15.2', '0.15.2'), 0);
  assert.equal(compareVersions('dev', '0.15.2'), null);
  assert.deepEqual(codexMarketplace('[marketplaces.other]\nsource = "x"\n[marketplaces.wax]\nsource_type = "local"\nsource = "C:\\\\Tools\\\\wax"\n[plugins]\nsource = "no"\n'), { source_type: 'local', source: 'C:\\Tools\\wax' });
  assert.equal(codexMarketplace('[plugins]\n'), null);
});

test('check reports each tool, skips missing ones and exits 2 when an update is available', async (t) => {
  const home = await fakeHome(t, { gemini: null }), project = await temp(t);
  const { exec, calls } = fakeExec({ claude: '0.15.0', copilot: '0.15.2' });
  const report = await checkUpdates({ home, project, env: {}, exec, latest });
  const status = Object.fromEntries(report.hosts.map((host) => [host.id, host.status]));
  assert.deepEqual(status, { claude: 'outdated', codex: 'outdated', copilot: 'current', gemini: 'missing', antigravity: 'missing', grok: 'missing' });
  assert.equal(exitCode(report, { check: true }), 2);
  assert.ok(calls.every((call) => /list --json$/.test(call.command)), 'check runs no update command');
});

test('a VS Code copilot shim alone counts as not installed', async (t) => {
  const home = await fakeHome(t), project = await temp(t);
  const { exec } = fakeExec({ claude: '0.15.2' }, { available: ['claude'] });
  const report = await checkUpdates({ home, project, env: {}, exec, latest, tools: ['copilot', 'codex'] });
  assert.deepEqual(report.hosts.map((host) => host.status), ['missing', 'missing']);
});

test('update runs the steps in order, re-reads the version and marks Claude Code for restart', async (t) => {
  const home = await fakeHome(t), project = await temp(t);
  const state = { claude: '0.15.0', copilot: '0.15.0' };
  state.onUpdate = {
    'claude plugin update wax@wax': () => { state.claude = '0.15.2'; },
    'codex plugin add wax@wax': () => mkdir(join(home, '.codex/plugins/cache/wax/wax/0.15.2'), { recursive: true }),
    'copilot plugin update wax@wax': () => { state.copilot = '0.15.2'; },
    'gemini extensions update wax': () => put(join(home, '.gemini/extensions/wax/package.json'), { version: '0.15.2' }),
  };
  const { exec, calls } = fakeExec(state);
  const report = await runUpdates(await checkUpdates({ home, project, env: {}, exec, latest }), { home, env: {}, exec, yes: true });
  const updates = calls.map((call) => call.command).filter((command) => !command.endsWith('--json'));
  assert.deepEqual(updates, ['claude plugin marketplace update wax', 'claude plugin update wax@wax', 'codex plugin marketplace upgrade wax', 'codex plugin add wax@wax', 'copilot plugin update wax@wax', 'gemini extensions update wax']);
  assert.equal(calls.find((call) => call.command === 'gemini extensions update wax').answer, 'y\n', '--yes answers the Gemini CLI consent');
  const claude = report.hosts.find((host) => host.id === 'claude');
  assert.deepEqual([claude.status, claude.before, claude.version, claude.restart], ['updated', '0.15.0', '0.15.2', true]);
  assert.ok(report.hosts.filter((host) => host.installed).every((host) => host.status === 'updated'));
  assert.equal(exitCode(report), 0);
});

test('a failing step stops that tool only, and a history mismatch suggests registering again', async (t) => {
  const home = await fakeHome(t, { gemini: null }), project = await temp(t);
  const { exec, calls } = fakeExec({ claude: '0.15.0', copilot: null }, { fail: { 'claude plugin marketplace update wax': 'fatal: refusing to merge unrelated histories' } });
  const report = await runUpdates(await checkUpdates({ home, project, env: {}, exec, latest }), { home, env: {}, exec });
  const claude = report.hosts.find((host) => host.id === 'claude');
  assert.equal(claude.status, 'failed');
  assert.equal(claude.history, true);
  assert.ok(!calls.some((call) => call.command === 'claude plugin update wax@wax'), 'the next step is not run');
  assert.ok(calls.some((call) => call.command === 'codex plugin add wax@wax'), 'other tools continue');
  assert.equal(exitCode(report), 1);
  let out = '';
  await updateCli([], { home, env: {}, exec, latest, out: (text) => { out += `${text}\n`; } });
  assert.match(out, /claude plugin marketplace remove wax → claude plugin marketplace add cafein-network\/wax → claude plugin install wax@wax/);
});

test('without --yes the Gemini CLI consent prompt stops the update instead of agreeing', async (t) => {
  const home = await fakeHome(t, { codex: null }), project = await temp(t);
  const { exec, calls } = fakeExec({ claude: '0.15.2' }, { prompt: ['gemini extensions update wax'] });
  const report = await runUpdates(await checkUpdates({ home, project, env: {}, exec, latest, tools: ['gemini'] }), { home, env: {}, exec });
  assert.equal(report.hosts[0].status, 'prompted');
  assert.equal(calls.at(-1).answer, null);
  assert.equal(exitCode(report), 1);
});

test('local folder installs run nothing, and a version that does not move is a failure', async (t) => {
  const home = await fakeHome(t, { local: true, codex: null, gemini: null }), project = await temp(t);
  const { exec, calls } = fakeExec({ claude: '0.15.0', copilot: '0.15.0' });
  const report = await runUpdates(await checkUpdates({ home, project, env: {}, exec, latest }), { home, env: {}, exec });
  assert.equal(report.hosts.find((host) => host.id === 'claude').status, 'local');
  assert.ok(!calls.some((call) => call.command.startsWith('claude plugin update')));
  assert.equal(report.hosts.find((host) => host.id === 'copilot').status, 'unchanged');
});

test('without the latest version, remote installs still run their update commands', async (t) => {
  const home = await fakeHome(t, { codex: null, gemini: null }), project = await temp(t);
  const state = { claude: '0.15.0' };
  state.onUpdate = { 'claude plugin update wax@wax': () => { state.claude = '0.15.2'; } };
  const { exec } = fakeExec(state);
  const report = await runUpdates(await checkUpdates({ home, project, env: {}, exec, latest: { version: null, error: 'timeout' }, tools: ['claude'] }), { home, env: {}, exec });
  assert.equal(report.hosts[0].status, 'updated');
});

test('project links report the linked folder and how to refresh it', async (t) => {
  const home = await fakeHome(t), project = await temp(t), source = await temp(t);
  await put(join(source, 'package.json'), { version: '0.15.0' });
  await mkdir(join(source, '.git'));
  await mkdir(join(source, 'skills/plan'), { recursive: true });
  await mkdir(join(project, '.agents/skills'), { recursive: true });
  await symlink(join(source, 'skills/plan'), join(project, '.agents/skills/wax-plan'), directoryLink);
  const { exec, calls } = fakeExec({});
  let out = '';
  const code = await updateCli(['--check', '--tool', 'antigravity,grok', '--project', project], { home, env: {}, exec, latest, out: (text) => { out += text; } });
  assert.equal(code, 2);
  assert.match(out, /git pull/);
  assert.equal(calls.length, 0);
  const json = [];
  await updateCli(['--tool', 'antigravity', '--project', project, '--json'], { home, env: {}, exec, latest, out: (text) => json.push(JSON.parse(text)) });
  assert.deepEqual([json[0].hosts[0].status, json[0].hosts[0].git, json[0].hosts[0].version], ['outdated', true, '0.15.0']);
});

test('an unknown tool or extra argument is rejected', async () => {
  await assert.rejects(updateCli(['--tool', 'cursor'], { latest }), /알 수 없는 도구: cursor/);
  await assert.rejects(updateCli(['now'], { latest }), /사용법: wax update/);
});

test('latestRelease reads the tag and reports failures without throwing', async () => {
  assert.deepEqual(await latestRelease({ fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.15.2' }) }) }), { version: '0.15.2' });
  assert.deepEqual(await latestRelease({ fetchImpl: async () => ({ ok: false, status: 403 }) }), { version: null, error: 'HTTP 403' });
  assert.equal((await latestRelease({ fetchImpl: async () => { throw new Error('offline'); } })).error, 'offline');
});

test('execCommand answers or stops at a confirmation prompt and kills on timeout', async () => {
  const asker = ['-e', "process.stdout.write('Continue? [Y/n]: ');process.stdin.once('data',d=>{console.log('got '+String(d).trim());process.exit(0)})"];
  const stopped = await execCommand(process.execPath, asker, { timeoutMs: 30_000 });
  assert.equal(stopped.prompted, true);
  assert.equal(stopped.code, null);
  const answered = await execCommand(process.execPath, asker, { timeoutMs: 30_000, answer: 'y\n' });
  assert.equal(answered.code, 0);
  assert.match(answered.stdout, /got y/);
  const slow = await execCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.code, null);
});

test('toolExec reports a missing tool without running anything', async () => {
  const exec = toolExec({ resolveCommand: async () => { throw new Error('없음'); }, run: () => assert.fail('must not run') });
  assert.equal((await exec('codex', ['x'])).missing, true);
  assert.equal(await exec.available('codex'), false);
});

test('a project-link tool whose program is on PATH but not linked here is reported as installed but unlinked, with the link command', async (t) => {
  const home = await fakeHome(t, {}), project = await temp(t), bin = await temp(t);
  await writeFile(join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), '');
  const { exec } = fakeExec({});
  const env = { PATH: bin };
  assert.equal(await onPath('agy', { env }), true);
  assert.equal(await onPath('grok', { env }), false);
  assert.equal(await onPath('agy', { env: {} }), false);
  const report = await checkUpdates({ home, project, env, exec, latest, tools: ['antigravity', 'grok'] });
  assert.deepEqual(report.hosts.map((host) => [host.id, host.status]), [['antigravity', 'unlinked'], ['grok', 'missing']]);
  const text = formatReport(report, (id, ...values) => `${id}${values.length ? `(${values.join('|')})` : ''}`, { check: true });
  assert.match(text, /cli\.update\.unlinked\n {4}cli\.update\.linkHint\(node ".*install-project\.mjs" --project ".*"\)/);
  assert.equal(exitCode(report, { check: true }), 0, 'not linked here is not a failure or an update');
});
