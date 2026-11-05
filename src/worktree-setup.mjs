import { t } from '../web/messages-catalog.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WaxError } from './workflow.mjs';
import { chatDir } from './chat/paths.mjs';
import { withLock } from './chat/lock.mjs';
import { appendRecord, makeId, readRecords } from './chat/store.mjs';
import * as v from './chat/validate.mjs';
import { ENV_NAME, PORT_ENV } from './worktrees.mjs';
import { COPY_LIMITS, copyPathShape, copyStatus } from './worktree-copy.mjs';
import { killTree, runTaskkill } from './process-tree.mjs';

export const SETUP_FILE = 'docs/wax/worktree.json';
export const SETUP_LIMITS = { file: 64 * 1024, args: 50, arg: 1000, refs: 20, refBytes: 1024 * 1024, packageBytes: 32 * 1024 * 1024, env: 10, checks: 5, timeoutMs: 5 * 60_000, output: 4000, text: 64 * 1024 };
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun', 'npx'];
export const PACKAGE_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
export const packageManager = (argv0) => PACKAGE_MANAGERS.includes(String(argv0 ?? '').split(/[\\/]/).at(-1).replace(/\.(?:cmd|exe|bat|ps1)$/i, '').toLowerCase());
const KEYS = ['setup', 'env', 'portEnv', 'copy', 'checks'];
const HIDDEN = /[\0\p{Cc}\p{Cf}]/u;
const MACHINE = new Set(['pm-loop', 'auto']);
const fail = (id, status = 400, ...values) => new WaxError(t(id, ...values), status);

export function setupHuman(author) {
  const who = v.author(author);
  if (MACHINE.has(who) || who.startsWith('wax-worker-')) throw fail('errors.worktrees.needsPerson', 403, who);
  return who;
}

async function plainDir(path) {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}
const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
class Invalid extends Error {}
const invalid = (id, ...values) => { throw new Invalid(t(id, ...values)); };

const goodArg = (arg) => typeof arg === 'string' && arg && arg.length <= SETUP_LIMITS.arg && !HIDDEN.test(arg);

export function parseSetupConfig(text) {
  let value;
  try { value = JSON.parse(text); } catch { invalid('worktrees.setup.invalidJson'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('worktrees.setup.notObject');
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) invalid('worktrees.setup.extraKey', JSON.stringify(key.slice(0, 40)));
  const { setup = null, env = [], portEnv = null, copy = null, checks = null } = value;
  if (setup === null && copy === null && checks === null) invalid('worktrees.setup.nothing');
  if (setup !== null) {
    if (!Array.isArray(setup) || !setup.length || setup.length > SETUP_LIMITS.args) invalid('worktrees.setup.setupShape', SETUP_LIMITS.args);
    setup.forEach((arg, index) => { if (!goodArg(arg)) invalid('worktrees.setup.argShape', index, SETUP_LIMITS.arg); });
  }
  if (copy !== null) {
    if (!Array.isArray(copy) || !copy.length || copy.length > COPY_LIMITS.entries) invalid('worktrees.setup.copyShape', COPY_LIMITS.entries);
    copy.forEach((path, index) => { if (!copyPathShape(path)) invalid('worktrees.setup.copyPathShape', index, COPY_LIMITS.path, COPY_LIMITS.segments); });
  }
  if (checks !== null) {
    if (!Array.isArray(checks) || !checks.length || checks.length > SETUP_LIMITS.checks) invalid('worktrees.setup.checksShape', SETUP_LIMITS.checks, SETUP_LIMITS.args);
    checks.forEach((argv, index) => {
      if (!Array.isArray(argv) || !argv.length || argv.length > SETUP_LIMITS.args) invalid('worktrees.setup.checksShape', SETUP_LIMITS.checks, SETUP_LIMITS.args);
      argv.forEach((arg, at) => { if (!goodArg(arg)) invalid('worktrees.setup.checkArgShape', index, at, SETUP_LIMITS.arg); });
    });
  }
  if (!Array.isArray(env) || env.length > SETUP_LIMITS.env || !env.every((name) => typeof name === 'string' && ENV_NAME.test(name))) invalid('worktrees.setup.envShape', SETUP_LIMITS.env);
  if (portEnv !== null && !(typeof portEnv === 'string' && PORT_ENV.test(portEnv))) invalid('worktrees.setup.portEnvShape');
  return { setup: setup ? [...setup] : null, env: [...new Set(env)], portEnv, copy: copy ? [...new Set(copy)] : [], checks: checks ? checks.map((argv) => [...argv]) : [] };
}

export const configCommands = (config) => [...(config.setup ? [config.setup] : []), ...config.checks];

async function referencedFiles(dir, commands) {
  const found = new Map();
  const packages = new Set();
  if (commands.some((argv) => packageManager(argv[0]))) {
    for (const name of PACKAGE_FILES) {
      const full = join(dir, name);
      let info;
      try { info = await lstat(full); } catch (error) { if (missing(error)) continue; throw error; }
      if (info.isSymbolicLink()) invalid('worktrees.setup.refLink', name);
      if (!info.isFile()) continue;
      if (info.size > SETUP_LIMITS.packageBytes) invalid('worktrees.setup.refTooLarge', name, SETUP_LIMITS.packageBytes / 1024);
      found.set(name, await readFile(full));
      packages.add(name);
    }
  }
  for (const arg of commands.flat()) {
    const candidates = [arg];
    const flag = arg.match(/^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.+)$/);
    if (flag) candidates.push(flag[1]);
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith('-')) continue;
      const full = isAbsolute(candidate) ? resolve(candidate) : resolve(dir, candidate);
      const rel = relative(dir, full);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      let info;
      try { info = await lstat(full); } catch (error) { if (missing(error)) continue; throw error; }
      const path = rel.split(sep).join('/');
      if (info.isSymbolicLink()) invalid('worktrees.setup.refLink', path);
      if (!info.isFile()) continue;
      let real;
      try { real = await realpath(full); } catch { invalid('worktrees.setup.refLink', path); }
      if (real !== full) invalid('worktrees.setup.refLink', path);
      if (info.size > SETUP_LIMITS.refBytes) invalid('worktrees.setup.refTooLarge', path, SETUP_LIMITS.refBytes / 1024);
      if (!found.has(path)) found.set(path, await readFile(full));
      if (found.size - packages.size > SETUP_LIMITS.refs) invalid('worktrees.setup.tooManyRefs', SETUP_LIMITS.refs);
    }
  }
  return [...found.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([path, bytes]) => ({ path, bytes, ...(packages.has(path) ? { package: true } : {}) }));
}

export function setupHash(configBytes, refs = []) {
  const hash = createHash('sha256').update('wax-worktree-setup-v1\0');
  for (const { path, bytes } of [{ path: SETUP_FILE, bytes: configBytes }, ...refs]) {
    hash.update(`${path}\0${bytes.length}\0`); hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}

export async function readSetup(dir) {
  const docs = join(dir, 'docs'), wax = join(docs, 'wax'), file = join(wax, 'worktree.json');
  let info;
  try { info = await lstat(file); } catch (error) { if (missing(error)) return { state: 'none' }; return { state: 'invalid', reason: String(error.message).slice(0, 200) }; }
  if (!(await plainDir(docs)) || !(await plainDir(wax)) || info.isSymbolicLink() || !info.isFile()) return { state: 'invalid', reason: t('worktrees.setup.fileLink') };
  if (info.size > SETUP_LIMITS.file) return { state: 'invalid', reason: t('worktrees.setup.fileTooLarge', SETUP_LIMITS.file / 1024) };
  let bytes;
  try { bytes = await readFile(file); } catch (error) { return { state: 'invalid', reason: String(error.message).slice(0, 200) }; }
  const text = bytes.toString('utf8');
  try {
    const config = parseSetupConfig(text);
    const refs = await referencedFiles(dir, configCommands(config));
    return { state: 'found', config, text, refs, hash: setupHash(bytes, refs) };
  } catch (error) {
    if (error instanceof Invalid) return { state: 'invalid', reason: error.message, text };
    return { state: 'invalid', reason: String(error.message).slice(0, 200), text };
  }
}

const recordFile = async (root, create = false) => { const dir = await chatDir(root, null, { create }); return dir && join(dir, 'worktree-setup.jsonl'); };
export async function setupDecisions(root) {
  const file = await recordFile(root);
  if (!file) return [];
  return (await readRecords(file)).records.filter((record) => record.kind === 'decision' && record.decision === 'approved' && typeof record.hash === 'string');
}
export async function setupRuns(root, { limit = 20 } = {}) {
  const file = await recordFile(root);
  if (!file) return [];
  return (await readRecords(file)).records.filter((record) => record.kind === 'run').slice(-limit);
}

export function setupState(found, decisions = []) {
  if (found.state !== 'found') return found.state;
  const last = decisions.at(-1);
  if (!last) return 'pending';
  return last.hash === found.hash ? 'approved' : 'changed';
}

const NPM_CI = new Set(['ci', 'clean-install', 'ic', 'install-clean']);
export function npmCiWipes(config) {
  const setup = config?.setup;
  if (!setup || !/^npm$/i.test(String(setup[0]).split(/[\\/]/).at(-1).replace(/\.(?:cmd|exe|bat|ps1)$/i, ''))) return false;
  return NPM_CI.has(setup.slice(1).find((arg) => !arg.startsWith('-'))) && (config.copy ?? []).some((path) => path.split('/').at(-1).toLowerCase() === 'node_modules');
}

const preview = (bytes) => {
  if (bytes.length > SETUP_LIMITS.text || bytes.includes(0)) return null;
  return bytes.toString('utf8');
};

export async function setupReview(root, { platform = process.platform } = {}) {
  const real = await realpath(root);
  const found = await readSetup(real);
  const decisions = await setupDecisions(root);
  const last = decisions.at(-1) ?? null;
  return { file: SETUP_FILE, state: setupState(found, decisions), ...(found.reason ? { reason: found.reason } : {}), ...(found.text !== undefined ? { text: found.text.slice(0, SETUP_LIMITS.text) } : {}),
    ...(found.state === 'found' ? { hash: found.hash, config: found.config, refs: found.refs.map((ref) => ({ path: ref.path, size: ref.bytes.length, text: preview(ref.bytes), ...(ref.package ? { package: true } : {}) })),
      packageManager: configCommands(found.config).some((argv) => packageManager(argv[0])),
      ...(found.config.copy.length ? { copy: await copyStatus(real, found.config.copy).catch(() => found.config.copy.map((path) => ({ path, state: 'unknown' }))) } : {}),
      ...(npmCiWipes(found.config) ? { npmCiCopy: true } : {}),
      ...(found.config.copy.length && platform === 'win32' ? { copyUnsupported: true } : {}) } : {}),
    approved: last ? { hash: last.hash, by: last.by ?? null, at: last.at ?? null, files: last.files ?? [] } : null,
    limits: { timeoutMinutes: SETUP_LIMITS.timeoutMs / 60_000, output: SETUP_LIMITS.output } };
}

export async function decideSetup(root, { author, hash, now = Date.now() } = {}) {
  const who = setupHuman(author);
  const file = await recordFile(root, true);
  return withLock(`${file}.decide.lock`, async () => {
    const found = await readSetup(await realpath(root));
    if (found.state === 'none') throw fail('errors.worktrees.setupMissing', 404, SETUP_FILE);
    if (found.state === 'invalid') throw fail('errors.worktrees.setupInvalid', 409, found.reason);
    if (typeof hash !== 'string' || hash !== found.hash) throw fail('errors.worktrees.setupChanged', 409);
    const record = await appendRecord(file, (seq) => ({ schema: 1, record: 'event', id: makeId('ws', seq), seq, kind: 'decision', decision: 'approved', hash: found.hash,
      files: [SETUP_FILE, ...found.refs.map((ref) => ref.path)], by: who, at: new Date(now).toISOString() }));
    return { state: 'approved', hash: record.hash, by: who, at: record.at, files: record.files };
  });
}

export async function recordSetupRun(root, run, now = Date.now()) {
  const file = await recordFile(root, true);
  return appendRecord(file, (seq) => ({ schema: 1, record: 'event', id: makeId('ws', seq), seq, kind: 'run', ...run, output: tail(run.output ?? ''), at: new Date(now).toISOString() }));
}

const tail = (text, max = SETUP_LIMITS.output) => { const chars = Array.from(String(text)); return chars.length > max ? chars.slice(-max).join('') : chars.join(''); };

export const killSetupTree = (child, options = {}) => killTree(child, options);

export function runSetup(cwd, argv, { env = {}, timeoutMs = SETUP_LIMITS.timeoutMs, spawn = nodeSpawn, timers = { set: setTimeout, clear: clearTimeout }, now = Date.now, signal = null,
  platform = process.platform, taskkill = runTaskkill } = {}) {
  return new Promise((done) => {
    const started = now();
    let output = '', settled = false, timedOut = false, timer = null, child;
    const keep = (chunk) => { output = tail(output + chunk.toString('utf8'), SETUP_LIMITS.output * 2); };
    const onAbort = () => { killSetupTree(child, { platform, taskkill }); finish({ outcome: 'stopped', code: null, signal: 'SIGKILL' }); };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) timers.clear(timer);
      signal?.removeEventListener?.('abort', onAbort);
      done({ ...result, ms: Math.max(0, now() - started), output: tail(output) });
    };
    if (signal?.aborted) { finish({ outcome: 'stopped', code: null, signal: null }); return; }
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env, WAX_WORKER: '1' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32' });
    } catch (error) { keep(String(error.message)); finish({ outcome: 'failed', code: null, signal: null }); return; }
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', (error) => { keep(`\n${error.message}\n`); finish({ outcome: 'failed', code: null, signal: null }); });
    child.once('close', (code, sig) => finish({ outcome: timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed', code: code ?? null, signal: sig ?? null }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = timers.set(() => { timedOut = true; killSetupTree(child, { platform, taskkill }); finish({ outcome: 'timeout', code: null, signal: 'SIGKILL' }); }, timeoutMs);
  });
}
