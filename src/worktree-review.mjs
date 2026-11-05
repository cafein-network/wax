import { t } from '../web/messages-catalog.mjs';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WaxError } from './workflow.mjs';
import { gitEnv } from './git-read.mjs';
import { withLock } from './chat/lock.mjs';
import { chatDir, safeDir } from './chat/paths.mjs';
import { appendRecord, makeId, readRecords } from './chat/store.mjs';
import { REVIEW_KIND, appendWorktree, checkWorktree, isReview, readWorktrees, reviewRef, worktreeNumber } from './worktrees.mjs';
import { PACKAGE_FILES, SETUP_FILE, readSetup, setupHuman } from './worktree-setup.mjs';

export const REVIEW_LIMITS = { fetchMs: 120_000, gitMs: 60_000 };
export const REVIEW_RUNS_FILE = 'review-runs.jsonl';
const SHA = /^[a-f0-9]{40,64}$/;
const FEATURE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fail = (id, status = 409, ...values) => new WaxError(t(id, ...values), status);

function git(cwd, args, { timeout = REVIEW_LIMITS.gitMs } = {}) {
  return new Promise((done, reject) => {
    execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 1_000_000, windowsHide: true, env: gitEnv() },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(Object.assign(error, { stderr: String(stderr ?? '') })); return; }
        done({ code: error ? error.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
  });
}
const gitLine = async (cwd, args) => { try { const out = await git(cwd, args); return out.code === 0 ? out.stdout.trim() || null : null; } catch { return null; } };

async function withoutHooks(fn) {
  const hooks = await mkdtemp(join(tmpdir(), 'wax-no-hooks-'));
  try { return await fn(['-c', `core.hooksPath=${hooks}`]); } finally { await rm(hooks, { recursive: true, force: true }).catch(() => {}); }
}


export function repoKey(url) {
  const text = String(url ?? '').trim();
  let host = null, path = null;
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(text);
  const scp = web ? null : /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(text);
  if (web) [, host, path] = web; else if (scp) [, host, path] = scp;
  if (!host || !path) return null;
  const parts = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9._-]{1,100}$/.test(part) || part === '.' || part === '..')) return null;
  return `${host.toLowerCase()}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}
const prKey = (pr) => `${pr.repo.host}/${pr.repo.owner.toLowerCase()}/${pr.repo.name.toLowerCase()}`;

export async function prRemote(realRoot, pr) {
  const out = await git(realRoot, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => null);
  if (!out || out.code !== 0) return null;
  const want = prKey(pr);
  const names = [];
  for (const line of out.stdout.split('\n')) {
    const at = line.indexOf(' ');
    if (at < 0) continue;
    const key = line.slice(0, at), url = line.slice(at + 1);
    const name = key.slice('remote.'.length, -'.url'.length);
    if (!key.startsWith('remote.') || !key.endsWith('.url') || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name)) continue;
    if (repoKey(url) === want) names.push(name);
  }
  if (!names.length) return null;
  return names.includes('origin') ? 'origin' : [...new Set(names)].sort()[0];
}


const SCRIPT = /(?:^|\/)(?:scripts|bin|\.husky|\.githooks)\/|\.(?:sh|bash|zsh|ps1|psm1|bat|cmd)$|(?:^|\/)(?:Makefile|makefile|GNUmakefile)$/;
export function riskyFiles(files = [], refs = []) {
  const named = new Set(refs);
  const out = [];
  for (const path of files) {
    const why = path === SETUP_FILE ? 'setup' : named.has(path) ? 'ref' : PACKAGE_FILES.includes(basename(path)) ? 'package' : path.startsWith('.github/') ? 'github' : SCRIPT.test(path) ? 'script' : null;
    if (why) out.push({ path, why });
  }
  return out;
}

export async function projectSetupHash(root) {
  try { const found = await readSetup(await realpath(root)); return found.state === 'found' ? found.hash : null; } catch { return null; }
}

export async function reviewFacts(root, pr) {
  const realRoot = await realpath(root);
  const [remote, shallow, found] = await Promise.all([prRemote(realRoot, pr), gitLine(realRoot, ['rev-parse', '--is-shallow-repository']),
    readSetup(realRoot).catch(() => ({ state: 'none' }))]);
  const refs = found.state === 'found' ? found.refs.map((ref) => ref.path) : [];
  const risky = riskyFiles(pr.files, refs);
  return { remote, shallow: shallow === 'true', risky, setupChanged: pr.files.includes(SETUP_FILE), ready: Boolean(remote) && shallow === 'false' };
}


export const fetchArgs = (hooks, remote, number) => [...hooks, '-c', 'fetch.writeCommitGraph=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--no-show-forced-updates', '--no-prune',
  remote, `+refs/pull/${number}/head:${reviewRef(number)}`];

export async function fetchPullHead(root, pr, { timeout = REVIEW_LIMITS.fetchMs } = {}) {
  if (!Number.isSafeInteger(pr?.number) || !SHA.test(pr?.head ?? '')) throw fail('errors.worktreeReview.number', 400);
  const realRoot = await realpath(root);
  const facts = await reviewFacts(realRoot, pr);
  if (!facts.remote) throw fail('errors.worktreeReview.noRemote', 409, prKey(pr));
  if (facts.shallow) throw fail('errors.worktreeReview.shallow', 409);
  const ref = reviewRef(pr.number);
  const result = await withoutHooks((hooks) => git(realRoot, fetchArgs(hooks, facts.remote, pr.number), { timeout })).catch((error) => ({ code: -1, stderr: String(error.stderr || error.message) }));
  if (result.code !== 0) throw fail('errors.worktreeReview.fetchFailed', 502, String(result.stderr).trim().split('\n').at(-1)?.slice(0, 300) || '-');
  const got = await gitLine(realRoot, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (got !== pr.head) {
    if (got && SHA.test(got)) await withoutHooks((hooks) => git(realRoot, [...hooks, 'update-ref', '-d', ref, got])).catch(() => null);
    throw fail('errors.worktreeReview.headMoved', 409, pr.number);
  }
  return { remote: facts.remote, ref, head: got };
}


export async function addReviewWorktree(root, goal, feature, pr, { by, now = Date.now } = {}) {
  const who = setupHuman(by);
  if (!FEATURE.test(feature ?? '')) throw fail('errors.worktrees.featureId', 409, String(feature).slice(0, 64));
  const realRoot = await realpath(root);
  const lockDir = await chatDir(root, null, { create: true });
  return withLock(join(lockDir, 'worktrees.make.lock'), async () => {
    const head = await gitLine(realRoot, ['rev-parse', '--verify', '-q', `${pr.head}^{commit}`]);
    if (head !== pr.head) throw fail('errors.worktreeReview.headMissing', 409, pr.head.slice(0, 12));
    const all = await readWorktrees(root);
    await safeDir(realRoot, ['.wax', 'worktrees'], { create: true });
    const dir = join(realRoot, '.wax', 'worktrees');
    let n = Math.max(0, ...all.filter((entry) => entry.goal === goal.id).map((entry) => worktreeNumber(entry.id) ?? 0)) + 1;
    while (n <= 9999 && await lstat(join(dir, `${goal.id}-${n}`)).then(() => true, () => false)) n++;
    if (n > 9999) throw fail('errors.worktrees.noNumber', 409, goal.id);
    const id = `${goal.id}-${n}`, path = join(dir, id);
    const added = await withoutHooks((hooks) => git(realRoot, [...hooks, 'worktree', 'add', '-q', '--detach', path, pr.head])).catch((error) => ({ code: -1, stderr: String(error.stderr || error.message) }));
    if (added.code !== 0) throw fail('errors.worktreeReview.addFailed', 409, pr.number, String(added.stderr).trim().slice(0, 300));
    const entry = await appendWorktree(root, { id, goal: goal.id, feature, kind: REVIEW_KIND, branch: null, path, base: pr.head, port: null, env: [], setup: null,
      pr: { number: pr.number, head: pr.head, cross: pr.cross === true, url: pr.url ?? '' }, state: 'active', by: who }, { now: now() });
    const usable = await checkWorktree(root, entry);
    if (!usable) throw fail('errors.worktrees.notUsable', 409, id);
    return usable;
  });
}

export async function deleteReviewRef(root, entry, all = null) {
  if (!isReview(entry)) return null;
  const realRoot = await realpath(root);
  const others = (all ?? await readWorktrees(root)).filter((item) => isReview(item) && item.id !== entry.id && item.state !== 'removed' && item.pr.number === entry.pr.number);
  if (others.length) return 'kept';
  const ref = reviewRef(entry.pr.number);
  const now = await gitLine(realRoot, ['rev-parse', '--verify', '-q', ref]);
  if (!now) return 'missing';
  if (now !== entry.pr.head) return 'changed';
  const done = await withoutHooks((hooks) => git(realRoot, [...hooks, 'update-ref', '-d', ref, entry.pr.head])).catch(() => ({ code: -1 }));
  if (done.code === 0) return 'deleted';
  return (await gitLine(realRoot, ['rev-parse', '--verify', '-q', ref])) ? 'changed' : 'missing';
}


const runsFile = async (root, create = false) => { const dir = await chatDir(root, null, { create }); return dir && join(dir, REVIEW_RUNS_FILE); };

export async function reviewRunDecisions(root) {
  const file = await runsFile(root).catch(() => null);
  if (!file) return [];
  const { records } = await readRecords(file).catch(() => ({ records: [] }));
  return records.filter((record) => record.kind === 'decision' && record.decision === 'allow-run' && Number.isSafeInteger(record.pr) && SHA.test(record.head ?? '') &&
    (record.hash === null || /^[a-f0-9]{64}$/.test(record.hash ?? '')));
}

export function reviewRunState(entry, decisions, hash) {
  if (!isReview(entry)) return { allowed: false, hash };
  const decision = decisions.filter((item) => item.pr === entry.pr.number && item.head === entry.pr.head && item.hash === hash).at(-1) ?? null;
  return { allowed: Boolean(decision), hash, ...(decision ? { decision: { by: decision.by ?? null, at: decision.at ?? null } } : {}) };
}

export async function untrustedReviewPaths(root, entries) {
  const reviews = entries.filter(isReview);
  if (!reviews.length) return [];
  const [decisions, hash] = await Promise.all([reviewRunDecisions(root), projectSetupHash(root)]);
  return reviews.filter((entry) => !reviewRunState(entry, decisions, hash).allowed).map((entry) => entry.path);
}

export async function recordReviewRun(root, entry, { author, head, hash, now = Date.now() } = {}) {
  const who = setupHuman(author);
  if (!isReview(entry) || entry.state !== 'active') throw fail('errors.worktreeReview.notReview', 409, String(entry?.id ?? '-'));
  if (head !== entry.pr.head) throw fail('errors.worktreeReview.headChanged', 409, entry.pr.number);
  const current = await projectSetupHash(root);
  if ((hash ?? null) !== current) throw fail('errors.worktrees.setupChanged', 409);
  const file = await runsFile(root, true);
  return appendRecord(file, (seq) => ({ schema: 1, record: 'event', id: makeId('rr', seq), seq, kind: 'decision', decision: 'allow-run', worktree: entry.id,
    pr: entry.pr.number, head: entry.pr.head, cross: entry.pr.cross, hash: current, by: who, at: new Date(now).toISOString() }));
}
