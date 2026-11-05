import { t } from '../web/messages-catalog.mjs';
import { execFile } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { constants, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WaxError } from './workflow.mjs';
import { gitEnv } from './freshness.mjs';
import { withLock } from './chat/lock.mjs';
import { chatDir, safeDir } from './chat/paths.mjs';
import { ENV_NAME, WORKTREE_LIMITS, appendWorktree, checkWorktree, isReview, readWorktrees, worktreeNumber } from './worktrees.mjs';
import { readSetup, recordSetupRun, runSetup, setupDecisions, setupState } from './worktree-setup.mjs';
import { BASELINE_LIMITS, finishBaseline, startBaseline } from './worktree-baseline.mjs';
import { copyFolders } from './worktree-copy.mjs';

export const PORT_RANGE = [41000, 41999];
export const ENV_DEFAULTS = ['.env', '.env.local'];
export const ENV_LIMITS = { bytes: 1024 * 1024, names: WORKTREE_LIMITS.env };
const SHA = /^[a-f0-9]{40,64}$/;
const FEATURE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SETUP_BLOCKS = new Set(['failed', 'timeout', 'stopped']);
export const SETUP_OUTCOME_TEXT = { none: 'worktrees.outcome.none', invalid: 'worktrees.outcome.invalid', pending: 'worktrees.outcome.pending', changed: 'worktrees.outcome.changed',
  ok: 'worktrees.outcome.ok', failed: 'worktrees.outcome.failed', timeout: 'worktrees.outcome.timeout', stopped: 'worktrees.outcome.stopped' };

const fail = (id, status = 409, ...values) => Object.assign(new WaxError(t(id, ...values), status), { worktree: true });

function git(cwd, args, { timeout = 60_000 } = {}) {
  return new Promise((done, reject) => {
    execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 1_000_000, windowsHide: true, env: gitEnv() },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : done(String(stdout))));
  });
}
const gitLine = async (cwd, args) => { try { return (await git(cwd, args)).trim() || null; } catch { return null; } };

export async function worktreeBase(root) {
  const real = await realpath(root);
  const top = await gitLine(real, ['rev-parse', '--show-toplevel']);
  if (!top) throw fail('errors.worktrees.notGit', 409);
  let realTop;
  try { realTop = await realpath(top); } catch { realTop = null; }
  if (realTop !== real) throw fail('errors.worktrees.notTop', 409, top);
  const head = await gitLine(real, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head || !SHA.test(head)) throw fail('errors.worktrees.noCommit', 409);
  return head;
}

export function pickPort(entries = [], range = PORT_RANGE) {
  const used = new Set(entries.filter((entry) => entry.state === 'active' && Number.isInteger(entry.port)).map((entry) => entry.port));
  for (let port = range[0]; port <= range[1]; port++) if (!used.has(port)) return port;
  return null;
}

const PROBE_MS = 1000;
function bindOnce(host, port, timeoutMs) {
  return new Promise((done) => {
    const server = createServer();
    let timer = null;
    const end = (value) => { clearTimeout(timer); done(value); };
    timer = setTimeout(() => { try { server.close(); } catch {   } end('unknown'); }, timeoutMs);
    server.once('error', (error) => end(error.code === 'EADDRINUSE' || error.code === 'EACCES' ? 'busy'
      : ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL', 'ENOTFOUND'].includes(error.code) && host === '::1' ? 'none' : 'unknown'));
    server.listen({ host, port, exclusive: true }, () => server.close(() => end('ok')));
  });
}
function connectOnce(host, port, timeoutMs) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    let timer = null;
    const end = (value) => { clearTimeout(timer); socket.destroy(); done(value); };
    timer = setTimeout(() => end('busy'), timeoutMs);
    socket.once('connect', () => end('busy'));
    socket.once('error', () => end('free'));
  });
}

export async function portFree(port, { timeoutMs = PROBE_MS } = {}) {
  try {
    const v4 = await bindOnce('127.0.0.1', port, timeoutMs);
    if (v4 !== 'ok') return v4 === 'busy' ? 'busy' : 'unknown';
    const v6 = await bindOnce('::1', port, timeoutMs);
    if (v6 === 'busy') return 'busy';
    for (const host of ['127.0.0.1', ...(v6 === 'ok' ? ['::1'] : [])]) if ((await connectOnce(host, port, timeoutMs)) === 'busy') return 'busy';
    return 'free';
  } catch { return 'unknown'; }
}

export async function pickFreePort(entries = [], { range = PORT_RANGE, probe = portFree } = {}) {
  const used = new Set(entries.filter((entry) => entry.state === 'active' && Number.isInteger(entry.port)).map((entry) => entry.port));
  for (let port = range[0]; port <= range[1]; port++) {
    if (used.has(port)) continue;
    let found;
    try { found = await probe(port); } catch { found = 'unknown'; }
    if (found === 'free') return { port, checked: true };
    if (found !== 'busy') return { port: pickPort(entries, range), checked: false };
  }
  return { port: null, checked: true };
}

export function envNames(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > ENV_LIMITS.names) throw new WaxError(t('errors.worktrees.envNames', ENV_LIMITS.names), 400);
  for (const name of value) if (typeof name !== 'string' || !ENV_NAME.test(name)) throw new WaxError(t('errors.worktrees.envName', String(name).slice(0, 40)), 400);
  return [...new Set(value)];
}

export async function copyEnv(root, dir, names = []) {
  const realRoot = await realpath(root);
  const copied = [], skipped = [];
  const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
  for (const name of names) {
    if (!ENV_NAME.test(name)) { skipped.push({ name, reason: 'invalid' }); continue; }
    const source = join(realRoot, name), target = join(dir, name);
    let info;
    try { info = await lstat(source); } catch { skipped.push({ name, reason: 'missing' }); continue; }
    if (info.isSymbolicLink()) { skipped.push({ name, reason: 'link' }); continue; }
    if (!info.isFile()) { skipped.push({ name, reason: 'notFile' }); continue; }
    if (info.size > ENV_LIMITS.bytes) { skipped.push({ name, reason: 'tooLarge' }); continue; }
    let bytes;
    let input;
    try {
      input = await open(source, constants.O_RDONLY | NOFOLLOW);
      const opened = await input.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.size > ENV_LIMITS.bytes) { skipped.push({ name, reason: 'changed' }); continue; }
      bytes = await input.readFile();
    } catch (error) { skipped.push({ name, reason: error.code === 'ELOOP' ? 'link' : 'unreadable' }); continue; }
    finally { await input?.close(); }
    let output;
    try { output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
    catch (error) { skipped.push({ name, reason: error.code === 'EEXIST' || error.code === 'ELOOP' ? 'exists' : 'unwritable' }); continue; }
    try {
      await output.writeFile(bytes);
      if (process.platform !== 'win32') await output.chmod(0o600);
    } finally { await output.close(); }
    copied.push(name);
  }
  return { copied, skipped };
}

async function setupIn(root, dir) {
  const found = await readSetup(dir);
  const state = setupState(found, await setupDecisions(root));
  return { state, ...(found.state === 'found' ? { config: found.config, hash: found.hash } : {}), ...(found.reason ? { reason: found.reason } : {}) };
}

const portVars = (port, setup) => (Number.isInteger(port) ? { WAX_PORT: String(port), ...(setup.state === 'approved' && setup.config?.portEnv ? { [setup.config.portEnv]: String(port) } : {}) } : {});

const LONG_PATH = /Filename too long|cannot create directory at|unable to create file .*: No such file or directory|could not create leading directories/i;

export function addFailureDetail(detail, { path = '', platform = process.platform } = {}) {
  const text = String(detail ?? '').trim().slice(0, 300);
  return platform === 'win32' && LONG_PATH.test(detail) ? `${text} ${t('errors.worktrees.longPaths', path)}` : text;
}

export async function prepareWorktree(root, goal, feature, { by = 'pm-loop', now = Date.now, spawn, timers, setupTimeoutMs, signal = null, portProbe, baselineLimits = BASELINE_LIMITS, platform, taskkill,
  copyOptions = {} } = {}) {
  if (!goal?.worktrees?.on) throw fail('errors.worktrees.off', 409, goal?.id ?? '-');
  if (signal?.aborted) throw Object.assign(fail('errors.worktrees.stoppedBefore', 409, goal.id), { setupOutcome: 'stopped' });
  if (!FEATURE.test(feature ?? '')) throw fail('errors.worktrees.featureId', 409, String(feature).slice(0, 64));
  const realRoot = await realpath(root);
  const lockDir = await chatDir(root, null, { create: true });
  const made = await withLock(join(lockDir, 'worktrees.make.lock'), async () => {
    const all = await readWorktrees(root);
    const mine = all.filter((entry) => entry.goal === goal.id && entry.feature === feature && !isReview(entry));
    const current = mine.filter((entry) => entry.state === 'active').at(-1) ?? null;
    if (current) {
      const checked = await checkWorktree(root, current);
      if (checked) return { entry: checked, created: false };
      await appendWorktree(root, { ...current, state: 'removed', by, at: undefined }, { now: now() });
    }
    const numbers = all.filter((entry) => entry.goal === goal.id).map((entry) => worktreeNumber(entry.id) ?? 0);
    await safeDir(realRoot, ['.wax', 'worktrees'], { create: true });
    const dir = join(realRoot, '.wax', 'worktrees');
    let n = Math.max(0, ...numbers) + 1;
    const taken = async (k) => Boolean(await gitLine(realRoot, ['rev-parse', '--verify', '-q', `refs/heads/wax/${goal.id}/${feature}-${k}`]))
      || await lstat(join(dir, `${goal.id}-${k}`)).then(() => true, () => false);
    while (n <= 9999 && await taken(n)) n++;
    if (n > 9999) throw fail('errors.worktrees.noNumber', 409, goal.id);
    const previous = mine.at(-1) ?? null;
    const tip = previous ? await gitLine(realRoot, ['rev-parse', '--verify', '-q', `refs/heads/${previous.branch}^{commit}`]) : null;
    const base = tip && SHA.test(tip) ? tip : goal.worktrees.base;
    if (!SHA.test(base ?? '') || !(await gitLine(realRoot, ['rev-parse', '--verify', '-q', `${base}^{commit}`]))) throw fail('errors.worktrees.noBase', 409, String(base ?? '-').slice(0, 64));
    const { port, checked } = await pickFreePort(all, { ...(portProbe ? { probe: portProbe } : {}) });
    if (port === null) throw fail('errors.worktrees.noPort', 409, PORT_RANGE[0], PORT_RANGE[1]);
    const id = `${goal.id}-${n}`, branch = `wax/${goal.id}/${feature}-${n}`, path = join(dir, id);
    const hooks = await mkdtemp(join(tmpdir(), 'wax-no-hooks-'));
    try { await git(realRoot, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '-q', '-b', branch, path, base]); }
    catch (error) { throw fail('errors.worktrees.addFailed', 409, branch, addFailureDetail(String(error.stderr || error.message), { path })); }
    finally { await rm(hooks, { recursive: true, force: true }).catch(() => {}); }
    const entry = await appendWorktree(root, { id, goal: goal.id, feature, branch, path, base, port, env: [], setup: null, state: 'active', by }, { now: now() });
    const usable = await checkWorktree(root, entry);
    if (!usable) throw fail('errors.worktrees.notUsable', 409, id);
    return { entry: usable, created: true, portChecked: checked };
  });
  let { entry } = made;
  let copied = entry.env ?? [], skipped = [];
  if (made.created) ({ copied, skipped } = await copyEnv(root, entry.path, goal.worktrees.env ?? []));
  const setup = await setupIn(root, entry.path);
  const previous = entry.setup?.outcome ?? null;
  const again = !made.created && (SETUP_BLOCKS.has(previous) || (['pending', 'changed'].includes(previous) && setup.state === 'approved'));
  const argv = setup.state === 'approved' ? setup.config?.setup ?? null : null;
  let outcome = made.created || again ? setup.state === 'approved' ? argv ? null : 'none' : setup.state : entry.setup?.outcome ?? 'none';
  let run = null, baseline = null;
  const copyList = setup.state === 'approved' ? setup.config?.copy ?? [] : [];
  const previousCopy = entry.setup?.copy ?? null;
  let copy = previousCopy;
  if (copyList.length && (made.created || (again && (!previousCopy || previousCopy.state === 'stopped')))) {
    copy = await copyFolders(realRoot, entry.path, copyList, { signal, ...(platform ? { platform } : {}), now, ...copyOptions });
    if (copy.state === 'stopped') outcome = 'stopped';
  }
  if ((made.created || again) && argv && outcome !== 'stopped') {
    const start = signal?.aborted ? null : await startBaseline(root, entry.id, { reuse: SETUP_BLOCKS.has(previous), limits: baselineLimits, dir: entry.path });
    run = await runSetup(entry.path, argv, { env: portVars(entry.port, setup), ...(setupTimeoutMs ? { timeoutMs: setupTimeoutMs } : {}), ...(spawn ? { spawn } : {}), ...(timers ? { timers } : {}), now,
      ...(signal ? { signal } : {}), ...(platform ? { platform } : {}), ...(taskkill ? { taskkill } : {}) });
    outcome = run.outcome;
    await recordSetupRun(root, { worktree: entry.id, goal: goal.id, feature, hash: setup.hash, outcome: run.outcome, code: run.code, signal: run.signal, ms: run.ms, output: run.output }, now());
    if (outcome === 'ok') baseline = await finishBaseline(root, entry.id, start, { hash: setup.hash ?? null, limits: baselineLimits, dir: entry.path, now: now() });
  }
  if (made.created || again) {
    const record = await appendWorktree(root, { ...entry, env: copied, setup: { hash: setup.hash ?? null, outcome, ...(baseline ? { baseline } : {}), ...(copy ? { copy } : {}) }, by, at: undefined }, { now: now() });
    entry = { ...record, path: entry.path };
  }
  if (SETUP_BLOCKS.has(outcome)) {
    const out = run?.output ? run.output.slice(-300) : '';
    const id = outcome === 'timeout' ? 'errors.worktrees.setupTimeout' : outcome === 'stopped' ? 'errors.worktrees.setupStopped' : 'errors.worktrees.setupFailed';
    throw Object.assign(fail(id, 409, entry.id, run?.code ?? '-', out), { setupOutcome: outcome, entry });
  }
  return { entry, created: made.created, env: portVars(entry.port, setup), setup: { state: setup.state, outcome, ...(setup.hash ? { hash: setup.hash } : {}), ...(baseline ? { baseline } : {}), ...(copy ? { copy } : {}) }, copied, skipped,
    ...(made.created ? { portChecked: made.portChecked } : {}) };
}

export async function envCandidates(root, extra = []) {
  const realRoot = await realpath(root);
  const names = [...new Set([...ENV_DEFAULTS, ...extra.filter((name) => ENV_NAME.test(name))])].slice(0, ENV_LIMITS.names);
  const out = [];
  for (const name of names) {
    let exists = false;
    try { const info = await lstat(join(realRoot, name)); exists = info.isFile() && !info.isSymbolicLink(); } catch {   }
    out.push({ name, exists });
  }
  return out;
}

