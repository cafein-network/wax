import { t } from '../web/messages-catalog.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WaxError } from './workflow.mjs';
import { chatDir } from './chat/paths.mjs';
import { appendRecord, makeId, readRecords } from './chat/store.mjs';
import { gitEnv } from './git-read.mjs';
import { shellWords } from './goal-allow.mjs';
import { MAX_TEST_MS, keepOutput, runState, testProof, windowsCommandHint } from './evidence.mjs';
import { killTree, runTaskkill } from './process-tree.mjs';
import { readSetup, setupDecisions, setupState } from './worktree-setup.mjs';
import { diffStates, worktreeState } from './worktree-import.mjs';
import { WORKTREE_ID, checkWorktreePath } from './worktrees.mjs';

export const PREIMPORT_LIMITS = { commandMs: 10 * 60_000, totalMs: MAX_TEST_MS, closeWaitMs: 2000, changed: 50, runs: 20 };
export const PREIMPORT_AUTHOR = 'wax-preimport';
export const PREIMPORT_OUTCOMES = ['passed', 'failed', 'timeout', 'stopped', 'error', 'changedTree'];
const SOURCE_ERRORS = { none: 'errors.preimport.none', shell: 'errors.preimport.shell', unapproved: 'errors.preimport.unapproved' };
const fail = (id, status = 409, ...values) => new WaxError(t(id, ...values), status);
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');


export function pickSource(found, decisions, testCommand = '') {
  const configState = setupState(found, decisions);
  const checks = found.state === 'found' ? found.config.checks : [];
  if (checks.length && configState === 'approved') return { source: 'config', commands: checks.map((argv) => [...argv]), hash: found.hash, configState };
  const text = typeof testCommand === 'string' ? testCommand.trim() : '';
  if (text) {
    const words = shellWords(text);
    if (!words) return { source: null, reason: 'shell', configState };
    return { source: 'start', commands: [words], hash: null, configState };
  }
  return { source: null, reason: checks.length ? 'unapproved' : 'none', configState };
}

export async function checkSource(realRoot, { testCommand = '', worktreePath = null } = {}) {
  const found = await readSetup(realRoot).catch(() => ({ state: 'none' }));
  const decisions = await setupDecisions(realRoot).catch(() => []);
  const picked = pickSource(found, decisions, testCommand);
  let configDiffers = false;
  if (worktreePath) {
    const copy = await readSetup(worktreePath).catch(() => ({ state: 'invalid' }));
    configDiffers = copy.state !== found.state || (found.state === 'found' && copy.hash !== found.hash) || (found.state === 'invalid' && copy.text !== found.text);
  }
  return { ...picked, ...(configDiffers ? { configDiffers: true } : {}), found };
}

export const preimportKey = ({ worktree, tip, commit, head, source, hash = null, commands }) => sha({ worktree, tip, C: commit, T: head, source, hash, commands });

export function checkEnv(entry, found, decisions, base = gitEnv()) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'WAX_WORKER') delete env[key];
  if (Number.isInteger(entry?.port)) {
    env.WAX_PORT = String(entry.port);
    if (found?.state === 'found' && found.config?.portEnv && setupState(found, decisions) === 'approved') env[found.config.portEnv] = String(entry.port);
  }
  env.WAX_PREIMPORT = '1';
  return env;
}


export function runCheck(cwd, argv, { env, timeoutMs, signal = null, spawn = nodeSpawn, timers = { set: setTimeout, clear: clearTimeout }, now = Date.now, platform = process.platform,
  taskkill = runTaskkill, kill, closeWaitMs = PREIMPORT_LIMITS.closeWaitMs } = {}) {
  return new Promise((done) => {
    const started = now();
    let output = '', truncated = false, settled = false, ended = null, child = null, timer = null, wait = null;
    const append = (chunk) => { ({ output, truncated } = keepOutput(output, chunk, truncated)); };
    const finish = (outcome, exitCode = null, sig = null) => {
      if (settled) return;
      settled = true;
      if (timer) timers.clear(timer);
      if (wait) timers.clear(wait);
      signal?.removeEventListener?.('abort', onAbort);
      done({ outcome, exitCode, signal: sig, output, truncated, timedOut: outcome === 'timeout', durationMs: Math.max(0, now() - started) });
    };
    const end = (why) => {
      if (settled || ended) return;
      ended = why;
      void killTree(child, { platform, taskkill, ...(kill ? { kill } : {}) });
      wait = timers.set(() => finish(why, null, 'SIGKILL'), closeWaitMs);
    };
    const onAbort = () => end('stopped');
    if (signal?.aborted) { finish('stopped'); return; }
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' });
    } catch (error) { append(`${error.message}${windowsCommandHint(argv, platform)}\n`); finish('error'); return; }
    child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    child.once('error', (error) => { append(`\n${error.message}${windowsCommandHint(argv, platform)}\n`); finish('error'); });
    child.once('close', (code, sig) => finish(ended ?? (code === 0 ? 'passed' : 'failed'), code ?? null, sig ?? null));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = timers.set(() => end('timeout'), Math.max(1, timeoutMs));
  });
}

export async function runChecks(cwd, commands, { env, signal = null, commandMs = PREIMPORT_LIMITS.commandMs, totalMs = PREIMPORT_LIMITS.totalMs, now = Date.now, stateOf = runState,
  onProgress = () => {}, ...options } = {}) {
  const deadline = now() + totalMs;
  const out = [];
  for (const [index, command] of commands.entries()) {
    const left = deadline - now();
    if (signal?.aborted || left <= 0 || out.some((item) => item.result.outcome === 'stopped' || item.overall)) {
      out.push({ command, state: {}, result: { outcome: 'skipped', exitCode: null, signal: null, output: '', truncated: false, timedOut: false, durationMs: 0 } });
      continue;
    }
    onProgress(index, null);
    const state = await stateOf(cwd).catch(() => ({ commit: null, dirty: null, tree: null }));
    const limit = Math.min(commandMs, Math.max(1, deadline - now()));
    const result = await runCheck(cwd, command, { env, timeoutMs: limit, signal, now, ...options });
    out.push({ command, state, result, ...(result.outcome === 'timeout' && limit < commandMs ? { overall: true } : {}) });
    onProgress(index, result);
  }
  return out.map(({ overall, ...rest }) => rest);
}

export function overallOutcome(results, changed = []) {
  const outcomes = results.map((item) => item.outcome);
  if (outcomes.includes('stopped')) return 'stopped';
  if (changed.length) return 'changedTree';
  if (outcomes.includes('timeout') || outcomes.includes('skipped')) return 'timeout';
  if (outcomes.includes('error')) return 'error';
  if (outcomes.includes('failed')) return 'failed';
  return 'passed';
}


const recordDir = (root, create = false) => chatDir(root, 'preimport', { create });
async function recordFile(root, id, create = false) {
  if (!WORKTREE_ID.test(id ?? '')) throw fail('errors.preimport.badWorktree', 400);
  const dir = await recordDir(root, create);
  return dir && join(dir, `${id}.jsonl`);
}

export async function preimportRuns(root, id, { limit = PREIMPORT_LIMITS.runs } = {}) {
  const file = await recordFile(root, id).catch(() => null);
  if (!file) return [];
  return (await readRecords(file).catch(() => ({ records: [] }))).records.filter((record) => record.kind === 'preimport').slice(-limit);
}
export const lastPreimport = async (root, id) => (await preimportRuns(root, id, { limit: 1 })).at(-1) ?? null;

export const preimportSummary = (record) => (record ? { outcome: record.outcome, source: record.source, commands: record.commands?.length ?? 0, at: record.at, seq: record.seq,
  passed: (record.results ?? []).filter((item) => item.outcome === 'passed').length } : null);


const RUNNING = new Map();

export async function preimportRunning(root) {
  let realRoot;
  try { realRoot = await realpath(root); } catch { return null; }
  return view(RUNNING.get(realRoot));
}
const view = (run) => (run && run.worktree ? { worktree: run.worktree, goal: run.goal, feature: run.feature, by: run.by, startedAt: run.startedAt, source: run.source,
  commands: run.commands, current: run.current, results: run.results.map((item) => (item ? { outcome: item.outcome, durationMs: item.durationMs } : null)), stopping: Boolean(run.stoppedBy) } : null);

export async function preimportBusy(root, id) {
  return (await preimportRunning(root))?.worktree === id;
}

export async function startPreimport(root, entry, { by, testCommand = '', onEnd = () => {}, ...options } = {}) {
  const realRoot = await realpath(root);
  const current = RUNNING.get(realRoot);
  if (current) throw fail('errors.preimport.busy', 409, current.worktree ?? '-');
  const run = { worktree: null, results: [], current: null, controller: new AbortController(), stoppedBy: null };
  RUNNING.set(realRoot, run);
  let scratch = null;
  try {
    if (!entry || entry.state !== 'active') throw fail('errors.worktreeImport.notActive', 409, entry?.id ?? '-', entry?.state ?? '-');
    scratch = await mkdtemp(join(tmpdir(), 'wax-preimport-'));
    await mkdir(join(scratch, 'objects'));
    const before = await worktreeState(root, entry, scratch);
    const picked = await checkSource(realRoot, { testCommand, worktreePath: before.folder });
    if (!picked.source) throw fail(SOURCE_ERRORS[picked.reason] ?? SOURCE_ERRORS.none, 409);
    const key = preimportKey({ worktree: entry.id, tip: before.tip, commit: before.commit, head: before.head, source: picked.source, hash: picked.hash, commands: picked.commands });
    const decisions = await setupDecisions(realRoot).catch(() => []);
    const env = checkEnv(entry, picked.found, decisions);
    Object.assign(run, { worktree: entry.id, goal: entry.goal, feature: entry.feature, by, startedAt: new Date((options.now ?? Date.now)()).toISOString(), source: picked.source,
      commands: picked.commands, results: picked.commands.map(() => null) });
    const folder = before.folder;
    const work = scratch;
    scratch = null;
    run.job = (async () => {
      let record;
      try {
        const results = await runChecks(folder, picked.commands, { env, signal: run.controller.signal, ...options,
          onProgress: (index, result) => { run.current = result ? null : index; if (result) run.results[index] = result; } });
        let after = null, changed = [], reason = null;
        try {
          after = await worktreeState(root, entry, work);
          changed = after.commit !== before.commit ? await diffStates(root, work, before.commit, after.commit) : [];
          if (after.commit !== before.commit && !changed.length) changed = ['.'];
        } catch (error) { reason = String(error.message).slice(0, 300); }
        const proofs = results.map(({ command, state, result }) => testProof({ command, state, durationMs: result.durationMs,
          result: { exitCode: result.exitCode, signal: result.signal, output: result.output, truncated: result.truncated, timedOut: result.timedOut }, author: PREIMPORT_AUTHOR,
          extra: { outcome: result.outcome }, worktree: entry }));
        let outcome = overallOutcome(results.map((item) => item.result), changed);
        if (reason && outcome === 'passed') outcome = 'error';
        record = await writeRecord(root, entry, { key, source: picked.source, hash: picked.hash, commands: picked.commands, outcome, by, startedAt: run.startedAt,
          head: before.head, tip: before.tip, commit: before.commit, behind: before.behind, ...(changed.length ? { changed: changed.slice(0, PREIMPORT_LIMITS.changed) } : {}),
          ...(run.stoppedBy ? { stoppedBy: run.stoppedBy } : {}), ...(reason ? { reason } : {}), ...(picked.configDiffers ? { configDiffers: true } : {}), results: proofs }, options.now);
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
        if (RUNNING.get(realRoot) === run) RUNNING.delete(realRoot);
      }
      try { await onEnd(record); } catch {   }
      return record;
    })();
    run.job.catch(() => {});
    return { started: view(run), key, job: run.job };
  } catch (error) {
    if (RUNNING.get(realRoot) === run) RUNNING.delete(realRoot);
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function writeRecord(root, entry, fields, now = Date.now) {
  const file = await recordFile(root, entry.id, true);
  if (!file) throw fail('errors.preimport.record', 500);
  return appendRecord(file, (seq) => ({ schema: 1, record: 'event', id: makeId('pi', seq), seq, kind: 'preimport', worktree: entry.id, goal: entry.goal, feature: entry.feature,
    ...fields, at: new Date(now()).toISOString() }));
}

export async function stopPreimport(root, id, { by } = {}) {
  const realRoot = await realpath(root);
  const run = RUNNING.get(realRoot);
  if (!run || run.worktree !== id || !run.job) throw fail('errors.preimport.notRunning', 409, String(id).slice(0, 40));
  run.stoppedBy ??= by ?? null;
  run.controller.abort();
  return run.job;
}

export async function closePreimport(root, { by = null } = {}) {
  let realRoot;
  try { realRoot = await realpath(root); } catch { return; }
  const run = RUNNING.get(realRoot);
  if (!run?.job) return;
  run.stoppedBy ??= by;
  run.controller.abort();
  await run.job.catch(() => {});
}

export async function preimportStatus(root, entry, { testCommand = '' } = {}) {
  const realRoot = await realpath(root);
  const checked = entry.state === 'active' ? await checkWorktreePath(root, entry) : null;
  const picked = await checkSource(realRoot, { testCommand, worktreePath: checked?.path ?? null });
  const running = view(RUNNING.get(realRoot));
  return { worktree: entry.id, source: picked.source, commands: picked.commands ?? [], ...(picked.reason ? { reason: picked.reason } : {}), configState: picked.configState,
    ...(picked.configDiffers ? { configDiffers: true } : {}), running: running?.worktree === entry.id ? running : null, busy: running && running.worktree !== entry.id ? running.worktree : null,
    last: await lastPreimport(root, entry.id), limits: { commandMinutes: PREIMPORT_LIMITS.commandMs / 60_000, totalMinutes: PREIMPORT_LIMITS.totalMs / 60_000 } };
}


export const PREVIEW_TAIL_LINES = 40;
const SHA_ID = /^[a-f0-9]{40,64}$/;

export function tailLines(text, lines = PREVIEW_TAIL_LINES) {
  const all = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return { text: all.slice(-lines).join('\n'), cut: all.length > lines };
}

const lastView = (record) => (record ? { seq: record.seq, outcome: record.outcome, source: record.source, by: record.by ?? null, at: record.at, behind: record.behind ?? null,
  ...(record.changed ? { changed: record.changed } : {}), ...(record.reason ? { reason: record.reason } : {}),
  results: (record.results ?? []).map((item) => { const tail = tailLines(item.output); return { command: item.command, outcome: item.outcome, durationMs: item.durationMs ?? 0,
    exitCode: item.exitCode ?? null, tail: tail.text, cut: tail.cut || Boolean(item.truncated) }; }) } : null);

export async function importChecks(root, entry, facts, { testCommand = '' } = {}) {
  const realRoot = await realpath(root);
  const checked = await checkWorktreePath(root, entry).catch(() => null);
  const picked = await checkSource(realRoot, { testCommand, worktreePath: checked?.path ?? null });
  const running = view(RUNNING.get(realRoot));
  const mine = running?.worktree === entry.id ? running : null;
  const other = running && running.worktree !== entry.id ? running.worktree : null;
  const base = { source: picked.source, commands: picked.commands ?? [], configState: picked.configState, ...(picked.configDiffers ? { configDiffers: true } : {}),
    running: mine, busy: other, limits: { commandMinutes: PREIMPORT_LIMITS.commandMs / 60_000, totalMinutes: PREIMPORT_LIMITS.totalMs / 60_000 } };
  if (!picked.source && picked.reason === 'none') return { view: { required: false, reason: 'none', ...base }, fingerprint: null, blocked: null, record: null, commands: [] };
  const last = await lastPreimport(root, entry.id);
  const key = picked.source && SHA_ID.test(facts?.commit ?? '') && SHA_ID.test(facts?.head ?? '') && SHA_ID.test(facts?.tip ?? '')
    ? preimportKey({ worktree: entry.id, tip: facts.tip, commit: facts.commit, head: facts.head, source: picked.source, hash: picked.hash, commands: picked.commands }) : null;
  const current = Boolean(key && last?.key === key);
  const passed = current && last.outcome === 'passed' && !mine;
  const state = !picked.source ? picked.reason : mine ? 'running' : !last ? 'notRun' : !current ? 'stale' : last.outcome === 'passed' ? 'passed' : 'failed';
  const blocked = passed ? null : !picked.source ? SOURCE_ERRORS[picked.reason] ?? SOURCE_ERRORS.none : 'errors.worktreeImport.checksStale';
  return { view: { required: true, state, current, passed, ...(picked.reason ? { reason: picked.reason } : {}), ...base, last: lastView(last) },
    fingerprint: { key, last: last?.key ?? null, outcome: last?.outcome ?? null, running: Boolean(mine) }, blocked,
    record: last && current ? { seq: last.seq, key: last.key, outcome: last.outcome } : null, commands: picked.commands ?? [] };
}
