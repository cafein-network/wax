import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createGitReader, emptyBlobId, gitAtLeast, readGitVersion, scratchTree, withScratch } from './git-read.mjs';
import { IMPORT_LIMITS, MERGE_TREE_VERSION, STATE_IDENTITY } from './worktree-import.mjs';
import { checkWorktreePath, isReview, readWorktrees } from './worktrees.mjs';
import { BASELINE_UNSAFE, readBaseline } from './worktree-baseline.mjs';
import { COPIED_OUTCOMES, copiedPaths as copiedOf } from './worktree-copy.mjs';
import { createTreeObserver } from './freshness.mjs';
import { getFeature } from './workflow.mjs';
import { listApprovals } from './approvals.mjs';
import { ownerAlive, readDecisions, readGoal, workerRuns } from './chat/pm-loop.mjs';

export const BOARD_LIMITS = { gitRows: 50, rowMs: 15_000, tableMs: 60_000, uncommitted: 2000, portMs: 50, patchCommits: 500, bytes: IMPORT_LIMITS.bytes };
export const AHEAD_BEHIND_VERSION = [2, 41];
const SHA = /^[a-f0-9]{40,64}$/;
const GOAL = /^goal-[a-f0-9]{8}$/;
const own = (path) => path !== '.wax' && !path.startsWith('.wax/');
const list = (text) => String(text).split('\0').filter(Boolean);
const iso = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);
const HIDDEN = /[\0\p{Cc}]/u;
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reasonOf = (error) => (error?.timedOut || error?.aborted ? 'timeout' : 'error');

export function portLink(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? `http://127.0.0.1:${port}` : null;
}

export function createBoardCache({ size = 500 } = {}) {
  const map = new Map();
  let hits = 0;
  return {
    get(key) {
      if (!key || !map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key); map.set(key, value); hits++;
      return value;
    },
    set(key, value) {
      if (!key) return value;
      map.delete(key); map.set(key, value);
      while (map.size > size) map.delete(map.keys().next().value);
      return value;
    },
    stats: () => ({ size: map.size, hits }),
  };
}
const NO_CACHE = { get: () => undefined, set: (key, value) => value, stats: () => ({ size: 0, hits: 0 }) };
async function cached(cache, key, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  return cache.set(key, await fn());
}

export function probePort(port, { timeoutMs = BOARD_LIMITS.portMs, hosts = ['127.0.0.1', '::1'] } = {}) {
  if (!portLink(port)) return Promise.resolve(false);
  const one = (host) => new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (up) => { clearTimeout(timer); socket.destroy(); done(up); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  return Promise.all(hosts.map(one)).then((results) => results.some(Boolean));
}


function worktreeLinks(decisions) {
  const byWorker = new Map(), created = new Map();
  for (const item of decisions) {
    if (item.kind !== 'worktree' || typeof item.worktree !== 'string') continue;
    if ((item.outcome === 'created' || item.outcome === 'reused') && typeof item.worker === 'string') byWorker.set(item.worker, item.worktree);
    if (item.outcome === 'created' && !created.has(item.worktree)) created.set(item.worktree, item.at ?? null);
  }
  return { byWorker, created };
}

const runOutcome = (run) => (!run.end ? 'running' : run.end.outcome === 'exited' ? (run.end.result === 'done' || run.end.result === 'blocked' ? run.end.result : 'exited') : run.end.outcome);

function lastProof(feature, id) {
  const proofs = (feature?.proofs ?? []).filter((proof) => proof?.kind === 'test' && proof.worktree?.id === id && typeof proof.at === 'string');
  const found = proofs.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (!found) return null;
  return { id: found.id ?? null, outcome: found.timedOut ? 'timeout' : found.exitCode === 0 ? 'passed' : 'failed', at: found.at, changedSince: null, ...(found.tree ? { tree: found.tree } : {}) };
}

export async function boardRows(root, { goal = null, all = false, running = null, waiting = null } = {}) {
  const entries = (await readWorktrees(root)).filter((entry) => !goal || entry.goal === goal).reverse();
  const shown = all ? entries : entries.filter((entry) => entry.state !== 'removed');
  const goals = new Map(), features = new Map();
  for (const id of new Set(shown.map((entry) => entry.goal))) {
    const [file, decisions] = await Promise.all([readGoal(root, id).catch(() => null), readDecisions(root, id).catch(() => [])]);
    const runs = workerRuns(decisions), links = worktreeLinks(decisions);
    goals.set(id, { file, runs, links });
  }
  for (const id of new Set(shown.map((entry) => entry.feature))) features.set(id, await getFeature(root, id).catch(() => null));
  const pending = shown.some((entry) => entry.state === 'active')
    ? ((await listApprovals(root).catch(() => ({ requests: [] }))).requests ?? []).filter((item) => item.status === 'pending' && GOAL.test(item.goal ?? ''))
    : [];
  const live = (id) => (running
    ? running.filter((run) => run.goal === id)
    : goals.get(id).runs.filter((run) => !run.end).map((run) => ({ ...run, goal: id, worktree: goals.get(id).links.byWorker.get(run.worker) ?? null })));
  return shown.map((entry) => {
    const { file, runs, links } = goals.get(entry.goal);
    const mine = runs.filter((run) => links.byWorker.get(run.worker) === entry.id);
    const last = mine.at(-1) ?? null;
    let activity = { kind: 'idle' };
    if (entry.state === 'active') {
      const goalRuns = live(entry.goal);
      const run = goalRuns.find((item) => (item.worktree ? item.worktree === entry.id : item.feature === entry.feature));
      const approval = pending.find((item) => item.goal === entry.goal && (run || !goalRuns.length));
      const card = waiting?.find((item) => item.goal === entry.goal && item.feature === entry.feature);
      if (approval) activity = { kind: 'waiting', reason: 'approval', approval: approval.id, action: String(approval.action ?? '').slice(0, 160) };
      else if (run) activity = { kind: 'running', worker: run.worker ?? null, tool: run.tool ?? null, phase: run.phase ?? null, since: run.at ?? null, ...(run.owner ? { alive: ownerAlive(run.owner) } : {}) };
      else if (card) activity = { kind: 'waiting', reason: 'card', detail: String(card.reason ?? '').slice(0, 300) };
      else if (!waiting && last?.end && file && !['stopped', 'done'].includes(file.state) && runOutcome(last) !== 'done') activity = { kind: 'waiting', reason: 'blocked', outcome: runOutcome(last) };
    }
    const copy = entry.setup?.copy ? { state: entry.setup.copy.state, entries: entry.setup.copy.entries.filter((item) => COPIED_OUTCOMES.has(item.outcome)).length } : null;
    const setup = entry.setup ? { outcome: entry.setup.outcome ?? null, baseline: entry.setup.baseline?.state ?? null, ...(copy ? { copy } : {}) } : null;
    return {
      id: entry.id, goal: entry.goal, goalTitle: file?.title ?? null, feature: entry.feature, branch: entry.branch, path: entry.path, state: entry.state, activity,
      ...(isReview(entry) ? { kind: 'review', pr: { number: entry.pr.number, head: entry.pr.head, cross: entry.pr.cross } } : {}),
      createdAt: links.created.get(entry.id) ?? null, port: entry.port ?? null, link: portLink(entry.port), portUp: null, setup,
      lastRun: last ? { phase: last.phase ?? null, tool: last.tool ?? null, outcome: runOutcome(last), at: last.end?.at ?? last.at ?? null } : null,
      proof: lastProof(features.get(entry.feature), entry.id), issue: null, tier: 0, git: null, partial: [],
      _entry: entry,
    };
  });
}


async function cell(row, name, fn) {
  try { return await fn(); } catch (error) {
    row.partial.push({ cell: name, reason: error?.timedOut || error?.aborted ? 'timeout' : 'error' });
    return null;
  }
}

function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function parseWorktreeList(text) {
  const out = [];
  let current = null;
  for (const field of String(text).split('\0')) {
    if (!field) { if (current) out.push(current); current = null; continue; }
    const [key, ...rest] = field.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') { if (current) out.push(current); current = { path: value, head: null, branch: null, prunable: false, detached: false }; continue; }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'prunable') current.prunable = true;
    else if (key === 'detached') current.detached = true;
  }
  if (current) out.push(current);
  return out;
}

async function projectTier(root, rows, { reader, version, signal }) {
  const out = { target: null, version: null, aheadBehind: null, refs: new Map(), commits: new Map(), worktrees: null, partial: [] };
  const fail = (name) => (error) => { out.partial.push({ cell: name, reason: error?.timedOut || error?.aborted ? 'timeout' : 'error' }); return null; };
  const options = { priority: -1, signal };
  const [head, name, found, listed] = await Promise.all([
    reader.git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], options).catch(fail('target')),
    reader.git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], options).catch(fail('target')),
    version ? Promise.resolve(String(version)) : readGitVersion(reader, root),
    reader.text(root, ['worktree', 'list', '--porcelain', '-z'], options).catch(fail('worktrees')),
  ]);
  out.version = found;
  const commit = head?.code === 0 ? String(head.stdout).trim() : '';
  if (SHA.test(commit)) out.target = { name: name?.code === 0 ? String(name.stdout).trim() || null : null, commit, detached: !(name?.code === 0) };
  if (listed !== null) out.worktrees = parseWorktreeList(listed);
  const T = out.target?.commit;
  out.aheadBehind = T ? (gitAtLeast(found, AHEAD_BEHIND_VERSION) ? 'for-each-ref' : 'rev-list') : null;
  const format = out.aheadBehind === 'for-each-ref' ? `%(refname)%00%(objectname)%00%(ahead-behind:${T})` : '%(refname)%00%(objectname)';
  const refs = await reader.text(root, ['for-each-ref', `--format=${format}`, 'refs/heads/wax/'], options).catch(fail('refs'));
  for (const line of String(refs ?? '').split('\n')) {
    const [ref, tip, counts] = line.split('\0');
    if (!ref || !SHA.test(tip ?? '')) continue;
    const [ahead, behind] = String(counts ?? '').split(' ').map(Number);
    out.refs.set(ref, { tip, ...(Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : {}) });
  }
  const tips = [...new Set([...rows.map((row) => (row.pr ? row.pr.head : out.refs.get(`refs/heads/${row.branch}`)?.tip)), T].filter(Boolean))];
  if (tips.length) {
    const text = await reader.text(root, ['log', '--no-walk=unsorted', '-z', '--format=%H%x00%T%x00%ct%x00%s', ...tips, '--'], options).catch(fail('commits'));
    const parts = String(text ?? '').split('\0');
    for (let i = 0; i + 3 < parts.length; i += 4) {
      const [hash, tree, time, subject] = parts.slice(i, i + 4).map((part, index) => (index === 0 ? part.replace(/^\n/, '') : part));
      if (SHA.test(hash)) out.commits.set(hash, { tree, at: iso(Number(time)), subject });
    }
  }
  return out;
}

function uncommittedPaths(text, baseline, copied = []) {
  const paths = new Set();
  for (const entry of list(text)) {
    if (!/^.. ./.test(entry)) continue;
    const path = entry.slice(3).replace(/\/$/, '');
    if (!own(path) || under(path, copied)) continue;
    if (entry.startsWith('??') && baseline?.state === 'ok' && baseline.paths[path]) continue;
    paths.add(path);
  }
  return paths;
}

async function rowTier(root, row, project, { reader, limits, probe, signal, priority, tiers = 1, cache = NO_CACHE }) {
  const rowStop = new AbortController();
  const timer = setTimeout(() => rowStop.abort(), limits.rowMs);
  const stop = signal ? AbortSignal.any([signal, rowStop.signal]) : rowStop.signal;
  const options = { priority, signal: stop };
  const entry = row._entry;
  try {
    const T = project.target?.commit ?? null;
    const review = isReview(entry);
    const ref = review ? null : project.refs.get(`refs/heads/${entry.branch}`) ?? null;
    const tip = review ? entry.pr.head : ref?.tip ?? null;
    const git = { tip, base: entry.base ?? null, target: project.target ? { name: project.target.name, commit: T } : null, uncommitted: null, tooMany: false, ahead: null, behind: null, baseMoved: null, lastCommit: null, lines: null, integration: null };
    row.git = git;
    row.tier = 1;
    if (!review && !tip && !project.partial.some((item) => item.cell === 'refs')) row.issue = 'branchMissing';
    const listed = project.worktrees?.find((item) => item.path.replaceAll('\\', '/').endsWith(`/.wax/worktrees/${entry.id}`)) ?? null;
    const folder = entry.state === 'removed' ? null : await checkWorktreePath(root, entry);
    if (entry.state !== 'removed' && (!folder || listed?.prunable)) row.issue = 'folderMissing';
    else if (listed && review && !(listed.detached && listed.head === entry.pr.head)) row.issue ??= 'reviewMoved';
    else if (listed && !review && listed.branch !== `refs/heads/${entry.branch}`) row.issue ??= 'notOnBranch';
    const work = [];
    if (folder && row.issue !== 'folderMissing') {
      work.push(cell(row, 'uncommitted', async () => {
        const text = await reader.text(folder.path, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], options);
        const baseline = await readBaseline(root, entry).catch(() => ({ state: 'failed' }));
        row._status = text; row._baseline = baseline;
        const count = uncommittedPaths(text, baseline, copiedPaths(entry)).size;
        git.uncommitted = count;
        git.tooMany = count > limits.uncommitted;
      }));
    }
    if (!review && tip && T) {
      if (Number.isInteger(ref.ahead)) { git.ahead = ref.ahead; git.behind = ref.behind; }
      else work.push(cell(row, 'ahead', async () => {
        const [ahead, behind] = await cached(cache, `ahead:${tip}:${T}`, async () => {
          const counts = String(await reader.text(root, ['rev-list', '--left-right', '--count', `${tip}...${T}`, '--'], options)).trim().split(/\s+/).map(Number);
          if (!counts.every(Number.isInteger) || counts.length !== 2) throw new Error('rev-list count');
          return counts;
        });
        git.ahead = ahead; git.behind = behind;
      }));
    }
    if (!review && T && entry.base) {
      if (entry.base === T) git.baseMoved = 0;
      else work.push(cell(row, 'baseMoved', async () => {
        git.baseMoved = await cached(cache, `moved:${entry.base}:${T}`, async () => {
          const count = Number(String(await reader.text(root, ['rev-list', '--count', `${entry.base}..${T}`, '--'], options)).trim());
          if (!Number.isInteger(count)) throw new Error('rev-list count');
          return count;
        });
      }));
    }
    if (tip) {
      const found = project.commits.get(tip);
      if (found) git.lastCommit = { subject: found.subject, at: found.at, tree: found.tree };
      else if (project.partial.some((item) => item.cell === 'commits')) row.partial.push({ cell: 'lastCommit', reason: project.partial.find((item) => item.cell === 'commits').reason });
    }
    if (entry.state === 'active' && row.link) work.push(cell(row, 'portUp', async () => { row.portUp = await untilAborted(probe(entry.port), stop); }));
    if (row.proof?.tree && folder && entry.state === 'active' && row.issue === null) {
      work.push(cell(row, 'proof', async () => {
        const seen = await untilAborted(reader.schedule(() => createTreeObserver(folder.path)(row.proof.tree), options), stop);
        row.proof.changedSince = seen.state === 'unknown' ? null : seen.files.length;
      }));
    }
    await Promise.all(work);
    if (review) {
      if (tiers >= 3) git.integration = { integrated: null, reason: 'review' };
      if (tiers >= 2) row.tier = tiers >= 3 ? 3 : 2;
    } else if (tiers >= 2 && folder && row.issue === null && row._status !== undefined) {
      const ctx = { root, entry, folder: folder.path, T, Ttree: project.commits.get(T)?.tree ?? null, lastTree: project.commits.get(tip)?.tree ?? null, tip, status: row._status, baseline: row._baseline, version: project.version, reader, cache, limits, options };
      await cell(row, 'lines', async () => { git.lines = await rowLines(ctx); });
      if (tiers >= 3) {
        try { git.integration = await rowIntegration(ctx); } catch (error) {
          row.partial.push({ cell: 'integration', reason: reasonOf(error) });
          git.integration = { integrated: null, reason: reasonOf(error) };
        }
      }
      row.tier = tiers >= 3 ? 3 : 2;
    }
  } finally { clearTimeout(timer); }
}


const copiedPaths = (entry) => copiedOf(entry?.setup?.copy);
const under = (path, folders) => folders.some((folder) => path === folder || path.startsWith(`${folder}/`));

function statusPlan(text, copied) {
  const paths = new Set(), untracked = new Set(), deleted = new Set();
  for (const entry of list(text)) {
    if (!/^.. ./.test(entry)) continue;
    const path = entry.slice(3);
    if (path.endsWith('/') || !own(path) || under(path, copied)) continue;
    paths.add(path);
    if (entry.startsWith('??')) untracked.add(path);
    if (entry[1] === 'D' || (entry[0] === 'D' && entry[1] === ' ')) deleted.add(path);
  }
  return { paths: [...paths].sort(), untracked, deleted };
}

async function uncommittedPlan(ctx) {
  if (ctx.plan) return ctx.plan;
  const copied = copiedPaths(ctx.entry);
  const status = statusPlan(ctx.status, copied);
  const plan = { ...status, excluded: [], blobs: new Map(), key: null, bytes: 0, tooMany: status.paths.length > ctx.limits.uncommitted, copied, baseline: ctx.baseline?.state ?? 'none' };
  ctx.plan = plan;
  if (plan.tooMany || !status.paths.length) { if (!status.paths.length) plan.key = sha256([]); return plan; }
  const files = [], links = new Map(), sizes = new Map();
  for (const path of status.paths) {
    if (status.deleted.has(path)) continue;
    let info = null;
    try { info = await lstat(join(ctx.folder, path)); } catch {   }
    if (!info) { status.deleted.add(path); continue; }
    if (info.isSymbolicLink()) links.set(path, await readlink(join(ctx.folder, path)).catch(() => ''));
    else if (info.isFile()) { files.push(path); sizes.set(path, info.size); }
  }
  const hashable = files.filter((path) => !HIDDEN.test(path));
  if (hashable.length) {
    const ids = String(await ctx.reader.text(ctx.folder, ['hash-object', '--stdin-paths'], { ...ctx.options, input: `${hashable.join('\n')}\n` })).split(/\r?\n/).filter(Boolean);
    if (ids.length !== hashable.length) throw new Error('hash-object returned a different number of ids');
    hashable.forEach((path, index) => { if (SHA.test(ids[index])) plan.blobs.set(path, ids[index]); });
  }
  const base = ctx.baseline?.state === 'ok' ? ctx.baseline.paths : null;
  if (base) {
    const same = status.paths.filter((path) => status.untracked.has(path) && base[path] && plan.blobs.get(path) === base[path]);
    plan.excluded = same;
    const skip = new Set(same);
    plan.paths = status.paths.filter((path) => !skip.has(path));
    for (const path of same) status.untracked.delete(path);
  }
  for (const path of plan.paths) plan.bytes += sizes.get(path) ?? 0;
  const complete = plan.paths.every((path) => status.deleted.has(path) || plan.blobs.has(path) || links.has(path) || !sizes.has(path));
  if (complete) plan.key = sha256(plan.paths.map((path) => [path, status.deleted.has(path) ? '-' : plan.blobs.get(path) ?? (links.has(path) ? `link:${links.get(path)}` : 'other')]));
  return plan;
}


function sumNumstat(text, keep) {
  const out = { added: 0, removed: 0, binary: 0 };
  for (const part of list(text)) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(part);
    if (!match || !keep(match[3])) continue;
    if (match[1] === '-') out.binary++;
    else { out.added += Number(match[1]); out.removed += Number(match[2]); }
  }
  return out;
}

async function rowLines(ctx) {
  const { entry, tip, reader, options, cache } = ctx;
  const plan = await uncommittedPlan(ctx);
  if (plan.tooMany) return { added: null, removed: null, binary: null, tooMany: true };
  const copied = plan.copied;
  const keepCommitted = (path) => own(path) && !under(path, copied);
  const committed = entry.base && tip && entry.base !== tip
    ? await cached(cache, `lines:${entry.base}:${tip}:${sha256(copied)}`, async () => sumNumstat(await reader.text(ctx.root, ['diff-tree', '-r', '-z', '--numstat', '--no-renames', entry.base, tip, '--'], options), keepCommitted))
    : { added: 0, removed: 0, binary: 0 };
  let uncommitted = { added: 0, removed: 0, binary: 0 };
  if (plan.paths.length) {
    const keep = new Set(plan.paths);
    const args = ['diff-index', '-z', '--numstat', '--no-renames', 'HEAD', '--'];
    if (!plan.untracked.size) uncommitted = sumNumstat(await reader.text(ctx.folder, args, options), (path) => keep.has(path));
    else {
      uncommitted = await withScratch(ctx.folder, async (scratch) => {
        const found = String(await reader.text(ctx.folder, ['rev-parse', '--git-path', 'index'], options)).trim();
        const index = await scratch.index(isAbsolute(found) ? found : resolve(ctx.folder, found));
        const plain = ['-c', 'core.splitIndex=false', '-c', 'core.untrackedCache=false'];
        const added = [...plan.untracked].filter((path) => keep.has(path));
        const empty = emptyBlobId(tip ?? entry.base);
        await reader.text(ctx.folder, [...plain, 'update-index', '-z', '--index-info'], { ...options, scratch, index, input: added.map((path) => `100644 ${empty}\t${path}\0`).join('') });
        return sumNumstat(await reader.text(ctx.folder, [...plain, ...args], { ...options, scratch, index }), (path) => keep.has(path));
      }, { reader, priority: options.priority, signal: options.signal });
    }
  }
  return { added: committed.added + uncommitted.added, removed: committed.removed + uncommitted.removed, binary: committed.binary + uncommitted.binary };
}


async function stateCommit(ctx, scratch, paths) {
  const { reader, options, folder, tip, entry } = ctx;
  const run = (args, { index = null, input = '', binary = false } = {}) => reader.text(folder, args, { ...options, scratch, index, input, ...(binary ? { encoding: 'buffer' } : {}) });
  const tree = await scratchTree(run, { base: tip, paths, index: await scratch.index(), objects: scratch.objects });
  if (!SHA.test(tree ?? '')) throw new Error('write-tree');
  const commit = String(await reader.text(folder, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', tip, '-m', `wax import ${entry.id}`], { ...options, scratch, env: STATE_IDENTITY })).trim();
  if (!SHA.test(commit)) throw new Error('commit-tree');
  return { commit, tree };
}

async function judge(ctx, W, Wtree, scratch) {
  const { reader, options, root, T, limits } = ctx;
  const at = scratch ? { ...options, scratch } : options;
  const base = await reader.git(root, ['merge-base', T, W], at);
  if (base.code !== 0 && base.code !== 1) throw new Error('merge-base');
  const mb = base.code === 0 ? String(base.stdout).trim() : null;
  if (mb) {
    const same = await reader.git(root, ['diff-tree', '--ignore-submodules=none', '--quiet', '-r', mb, W, '--'], at);
    if (same.code === 0) return { integrated: true, reason: 'no-changes' };
    if (same.code !== 1) throw new Error('diff-tree');
  }
  ctx.Ttree ??= String(await reader.text(root, ['rev-parse', '--verify', '-q', `${T}^{tree}`], options)).trim();
  const tree = Wtree ?? String(await reader.text(root, ['rev-parse', '--verify', '-q', `${W}^{tree}`], at)).trim();
  if (SHA.test(tree) && tree === ctx.Ttree) return { integrated: true, reason: 'same-tree' };
  if (gitAtLeast(ctx.version, MERGE_TREE_VERSION)) {
    const merge = (handle) => reader.git(root, ['merge-tree', '--write-tree', '--no-messages', T, W], { ...options, scratch: handle });
    const merged = scratch ? await merge(scratch) : await withScratch(root, merge, { reader, priority: options.priority, signal: options.signal });
    if (merged.code === 0) return String(merged.stdout).split('\n')[0].trim() === ctx.Ttree ? { integrated: true, reason: 'merge-adds-nothing' } : { integrated: false };
    if (merged.code !== 1) throw new Error('merge-tree');
  }
  if (!mb) return { integrated: false };
  const count = Number(String(await reader.text(root, ['rev-list', '--count', `${mb}..${T}`, '--'], options)).trim());
  if (!Number.isInteger(count)) throw new Error('rev-list count');
  if (count > limits.patchCommits) return { integrated: null, reason: 'tooDeep', commits: count };
  if (!count) return { integrated: false };
  const mine = await reader.pipe(root, ['diff-tree', '--ignore-submodules=none', '-p', mb, W, '--'], ['patch-id', '--verbatim'], at);
  if (mine.code === 129) return { integrated: null, reason: 'gitOld' };
  if (mine.firstCode !== 0 || mine.code !== 0) throw new Error('patch-id');
  const id = String(mine.stdout).trim().split(/\s+/)[0];
  if (!id) return { integrated: false };
  const commits = await reader.text(root, ['rev-list', `${mb}..${T}`, '--'], options);
  const theirs = await reader.pipe(root, ['diff-tree', '--ignore-submodules=none', '--stdin', '-p'], ['patch-id', '--verbatim'], { ...options, input: commits });
  if (theirs.code === 129) return { integrated: null, reason: 'gitOld' };
  if (theirs.firstCode !== 0 || theirs.code !== 0) throw new Error('patch-id');
  for (const line of String(theirs.stdout).split('\n')) {
    const [patch, commit] = line.trim().split(/\s+/);
    if (patch === id && SHA.test(commit ?? '')) return { integrated: true, reason: 'patch-id', commit };
  }
  return { integrated: false };
}

async function rowIntegration(ctx) {
  const { T, tip } = ctx;
  ctx.C = null;
  if (!T) return { integrated: null, reason: 'noHead' };
  if (!tip) return { integrated: null, reason: 'error' };
  if (BASELINE_UNSAFE.has(ctx.baseline?.state)) return { integrated: null, reason: 'baseline' };
  const plan = await uncommittedPlan(ctx);
  if (plan.tooMany) return { integrated: null, reason: 'tooMany' };
  if (!plan.paths.length) {
    return cached(ctx.cache, `judge:${tip}:${T}`, async () => {
      if (tip === T) return { integrated: true, reason: 'same-commit' };
      const ancestor = await ctx.reader.git(ctx.root, ['merge-base', '--is-ancestor', tip, T], ctx.options);
      if (ancestor.code === 0) return { integrated: true, reason: 'ancestor' };
      if (ancestor.code !== 1) throw new Error('merge-base --is-ancestor');
      return judge(ctx, tip, ctx.lastTree ?? null, null);
    });
  }
  if (plan.bytes > ctx.limits.bytes) return { integrated: null, reason: 'tooLarge' };
  const key = plan.key ? `judgeC:${tip}:${T}:${plan.key}` : null;
  const hit = ctx.cache.get(key);
  if (hit !== undefined) { ctx.C = hit.C; return hit.result; }
  let C = null;
  const result = await withScratch(ctx.folder, async (scratch) => {
    const made = await stateCommit(ctx, scratch, plan.paths);
    C = made.commit;
    return judge(ctx, made.commit, made.tree, scratch);
  }, { reader: ctx.reader, priority: ctx.options.priority, signal: ctx.options.signal });
  ctx.C = C;
  return ctx.cache.set(key, { result, C }).result;
}

export function integrationFingerprint({ id, tip, T, C = null, reason }) {
  return sha256({ id, tip, T, C, reason });
}

export async function worktreeBoard(root, { goal = null, all = false, offset = 0, tiers = 1, reader = createGitReader(), version = null, probe = probePort,
  limits = BOARD_LIMITS, running = null, waiting = null, cache = NO_CACHE } = {}) {
  const realRoot = await realpath(root);
  const rows = await boardRows(realRoot, { goal, all, running, waiting });
  const live = rows.filter((row) => row.state !== 'removed');
  const chosen = live.slice(offset, offset + limits.gitRows);
  const board = { project: { target: null, git: { version: null, aheadBehind: null } }, rows, gitRows: tiers >= 1 ? chosen.length : 0,
    more: Math.max(0, live.length - offset - chosen.length), partial: [],
    removedHidden: all ? 0 : (await readWorktrees(realRoot)).filter((entry) => entry.state === 'removed' && (!goal || entry.goal === goal)).length };
  if (tiers >= 1 && chosen.length) {
    const tableStop = new AbortController();
    const timer = setTimeout(() => tableStop.abort(), limits.tableMs);
    try {
      const project = await projectTier(realRoot, chosen, { reader, version, signal: tableStop.signal });
      board.project = { target: project.target, git: { version: project.version, aheadBehind: project.aheadBehind } };
      board.partial = project.partial;
      await Promise.all(chosen.map((row, index) => rowTier(realRoot, row, project, { reader, limits, probe, signal: tableStop.signal, priority: index, tiers, cache })));
    } finally { clearTimeout(timer); }
  }
  for (const row of rows) {
    delete row._entry; delete row._status; delete row._baseline;
    if (row.proof) delete row.proof.tree;
  }
  return board;
}

export async function worktreeRow(root, id, { tier = 2, reader = createGitReader(), cache = NO_CACHE, version = null, limits = BOARD_LIMITS, signal = null } = {}) {
  const realRoot = await realpath(root);
  const entry = (await readWorktrees(realRoot)).find((item) => item.id === id);
  if (!entry) return null;
  const level = tier >= 3 ? 3 : 2;
  const out = { id, tier: level, issue: null, partial: [], ...(level === 3 ? { integration: null } : { lines: null }) };
  const unknown = (reason) => { if (level === 3) out.integration = { integrated: null, reason }; return out; };
  if (entry.state === 'removed') { out.issue = 'removed'; return unknown('error'); }
  const folder = await checkWorktreePath(realRoot, entry);
  if (!folder) { out.issue = 'folderMissing'; return unknown('error'); }
  if (isReview(entry)) return unknown('review');
  const rowStop = new AbortController();
  const timer = setTimeout(() => rowStop.abort(), limits.rowMs);
  const stop = signal ? AbortSignal.any([signal, rowStop.signal]) : rowStop.signal;
  const options = { priority: 0, signal: stop };
  try {
    const known = version ?? cache.get('git-version');
    const [head, tipped, branch, status, found] = await Promise.all([
      reader.git(realRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], options),
      reader.git(realRoot, ['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}^{commit}`], options),
      reader.git(folder.path, ['symbolic-ref', '-q', 'HEAD'], options),
      reader.text(folder.path, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], options),
      known ? Promise.resolve(String(known)) : readGitVersion(reader, realRoot),
    ]);
    if (!known && found) cache.set('git-version', found);
    const T = head.code === 0 && SHA.test(String(head.stdout).trim()) ? String(head.stdout).trim() : null;
    const tip = tipped.code === 0 && SHA.test(String(tipped.stdout).trim()) ? String(tipped.stdout).trim() : null;
    if (!tip) { out.issue = 'branchMissing'; return unknown('error'); }
    if (String(branch.stdout).trim() !== `refs/heads/${entry.branch}`) { out.issue = 'notOnBranch'; return unknown('error'); }
    const baseline = await readBaseline(realRoot, entry).catch(() => ({ state: 'failed' }));
    const ctx = { root: realRoot, entry, folder: folder.path, T, Ttree: null, lastTree: null, tip, status, baseline, version: found, reader, cache, limits, options };
    if (level === 2) out.lines = await rowLines(ctx);
    else {
      out.integration = await rowIntegration(ctx);
      if (out.integration?.integrated === true && entry.state === 'active') out.cleanup = { fingerprint: integrationFingerprint({ id, tip, T, C: ctx.C ?? null, reason: out.integration.reason }) };
    }
    return out;
  } catch (error) {
    out.partial.push({ cell: level === 3 ? 'integration' : 'lines', reason: reasonOf(error) });
    return unknown(reasonOf(error));
  } finally { clearTimeout(timer); }
}
