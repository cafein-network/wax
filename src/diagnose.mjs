import { t } from '../web/messages-catalog.mjs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { WaxError, validId } from './workflow.mjs';
import { parseJsonLines } from './json-lines.mjs';
import { scrubContext, scrubValue, tailChars } from './scrub.mjs';
import { acceptanceIds } from './acceptance.mjs';
import { freshnessBasis } from './freshness.mjs';
import { phaseDurations } from './durations.mjs';
import { sumUsage } from './tool-usage.mjs';
import { agentTool } from './agent-tools.mjs';
import { testRepeatKey, commandText } from './chat/stuck-check.mjs';
import { stepProgress } from './plan-progress.mjs';
import { HUMAN_KINDS, JUDGE_END, WORKER_END, judgmentRuns, usageRecords, workerRuns } from './chat/pm-loop.mjs';

export const DIAGNOSE_LIMITS = { bytes: 20 * 1024 * 1024, lines: 50_000, cites: 10, text: 300, quote: 600, approvals: 2000, goals: 500, perCode: 20 };
export const DIMENSIONS = ['stop', 'repeat', 'plan', 'evidence', 'approval', 'cost', 'tool', 'records'];
export const SEVERITIES = ['stop', 'warn', 'info'];
const GOAL_ID = /^goal-[a-f0-9]{8}$/;
const REQUEST_ID = /^request-[a-f0-9-]{36}$/;
const APPROVAL_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
const OUTPUT_ENDS = new Set(['failed', 'timeout', 'stuck']);
const MINUTE = 60_000;

const time = (value) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
const minutes = (ms) => Math.round(ms / MINUTE);
const toolLabel = (id) => { if (typeof id !== 'string' || !id) return '-'; try { return agentTool(id).label; } catch { return oneLine(id, 30); } };
export function oneLine(value, limit = DIAGNOSE_LIMITS.text) {
  const flat = String(value ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : flat;
}
function quoteText(value, limit = DIAGNOSE_LIMITS.quote) {
  const clean = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, '');
  return tailChars(clean, limit);
}


async function plain(root, parts, { dir = false } = {}) {
  const chain = ['.wax', ...parts], rel = chain.join('/');
  let path = root;
  for (let index = 0; index < chain.length; index++) {
    path = join(path, chain[index]);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { path, rel, state: 'missing' }; throw error; }
    if (info.isSymbolicLink()) return { path, rel, state: 'link' };
    const last = index === chain.length - 1;
    if (last ? (dir ? !info.isDirectory() : !info.isFile()) : !info.isDirectory()) return { path, rel, state: 'other' };
  }
  return { path, rel, state: 'ok' };
}

async function readCapped(path, bytes) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(buffer, done, length - done, done);
      if (!bytesRead) break;
      done += bytesRead;
    }
    return { text: buffer.subarray(0, done).toString('utf8'), size, cut: size > bytes };
  } finally { await handle.close(); }
}

function createReader(root, limits) {
  const files = [], issues = [];
  const note = (entry) => { files.push(entry); return entry; };
  return {
    files, issues,
    async jsonl(parts) {
      const found = await plain(root, parts);
      if (found.state === 'missing') return null;
      if (found.state !== 'ok') { issues.push({ kind: 'link', file: found.rel }); return null; }
      const { text, size, cut } = await readCapped(found.path, limits.bytes);
      const lines = text.split('\n');
      if (cut) lines.pop();
      else if (lines.at(-1) === '') lines.pop();
      const records = [], broken = [];
      let truncated = cut ? 'bytes' : null;
      if (lines.length > limits.lines) { lines.length = limits.lines; truncated = 'lines'; }
      lines.forEach((raw, index) => {
        if (!raw.trim()) return;
        try {
          const value = JSON.parse(raw);
          if (value && typeof value === 'object' && !Array.isArray(value)) records.push({ value, line: index + 1 }); else broken.push(index + 1);
        } catch { broken.push(index + 1); }
      });
      if (broken.length) issues.push({ kind: 'broken', file: found.rel, lines: broken });
      if (truncated) issues.push({ kind: 'truncated', file: found.rel, line: lines.length, by: truncated });
      note({ file: found.rel, bytes: size, lines: lines.length, records: records.length, broken: broken.length, truncated: Boolean(truncated) });
      return { file: found.rel, records };
    },
    async doc(parts) {
      const found = await plain(root, parts);
      if (found.state === 'missing') return null;
      if (found.state !== 'ok') { issues.push({ kind: 'link', file: found.rel }); return { file: found.rel, value: null, error: 'link' }; }
      const { text, size, cut } = await readCapped(found.path, limits.bytes);
      if (cut) {
        issues.push({ kind: 'truncated', file: found.rel, line: null, by: 'bytes' });
        note({ file: found.rel, bytes: size, lines: null, broken: 0, truncated: true });
        return { file: found.rel, value: null, error: 'truncated' };
      }
      const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      try {
        const parsed = parseJsonLines(text);
        note({ file: found.rel, bytes: size, lines: lineCount, broken: 0, truncated: false });
        return { file: found.rel, value: parsed.value, lineOf: parsed.lineOf };
      } catch (error) {
        issues.push({ kind: 'badJson', file: found.rel, line: error.line ?? 1 });
        note({ file: found.rel, bytes: size, lines: lineCount, broken: 1, truncated: false });
        return { file: found.rel, value: null, error: 'json' };
      }
    },
    async names(parts) {
      const found = await plain(root, parts, { dir: true });
      if (found.state === 'missing') return [];
      if (found.state !== 'ok') { issues.push({ kind: 'link', file: found.rel }); return []; }
      return (await readdir(found.path)).sort();
    },
  };
}


const lineCite = (file, line) => ({ file, line });
function docCite(doc, pointer) {
  const line = doc?.lineOf?.(pointer) ?? null;
  return line ? { file: doc.file, line, pointer } : { file: doc.file };
}
const pointer = (...parts) => parts.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');


async function gather(root, id, { since, limits }) {
  const reader = createReader(root, limits);
  const goals = [], features = [];
  let kind = null;
  if (GOAL_ID.test(id)) {
    const doc = await reader.doc(['chat', 'pm-loop', `${id}.json`]);
    if (doc?.value) { kind = 'goal'; goals.push({ id, doc }); }
    else if (doc) throw new WaxError(t('errors.diagnose.unreadable', doc.file), 500);
  }
  if (!kind) {
    try { validId(id); } catch { throw new WaxError(t('errors.diagnose.invalidId', id)); }
    const doc = await reader.doc(['features', `${id}.json`]);
    if (!doc) throw new WaxError(t('errors.diagnose.notFound', id), 404);
    if (!doc.value) throw new WaxError(t('errors.diagnose.unreadable', doc.file), 500);
    kind = 'feature';
    features.push({ id, doc });
    const names = (await reader.names(['chat', 'pm-loop'])).filter((name) => /^goal-[a-f0-9]{8}\.json$/.test(name)).slice(0, limits.goals);
    for (const name of names) {
      const goal = await reader.doc(['chat', 'pm-loop', name]);
      if (Array.isArray(goal?.value?.features) && goal.value.features.includes(id)) goals.push({ id: name.slice(0, -5), doc: goal });
    }
  } else {
    const list = Array.isArray(goals[0].doc.value.features) ? goals[0].doc.value.features : [];
    for (const [index, featureId] of list.entries()) {
      let ok = typeof featureId === 'string';
      try { validId(featureId); } catch { ok = false; }
      const doc = ok ? await reader.doc(['features', `${featureId}.json`]) : null;
      if (doc?.value) features.push({ id: featureId, doc });
      else reader.issues.push({ kind: 'featureMissing', id: String(featureId), cite: docCite(goals[0].doc, pointer('features', index)) });
    }
  }
  const goalIds = new Set(goals.map((goal) => goal.id)), featureIds = new Set(features.map((feature) => feature.id));
  const fresh = (at) => since === null || !(time(at) < since);
  const mine = (record) => kind === 'goal' || record.feature === undefined || record.feature === null || featureIds.has(record.feature);
  const lines = (file) => (file?.records ?? []).filter(({ value }) => fresh(value.at) && mine(value)).map((item) => ({ ...item, file: file.file }));
  for (const goal of goals) goal.log = lines(await reader.jsonl(['chat', 'pm-loop', `${goal.id}.jsonl`]));
  const ofGoal = (file) => lines(file).filter(({ value }) => goalIds.has(value.goal));
  const snapshots = ofGoal(await reader.jsonl(['chat', 'snapshots', 'runs.jsonl']));
  const restores = ofGoal(await reader.jsonl(['chat', 'snapshots', 'restores.jsonl']));
  const health = ofGoal(await reader.jsonl(['chat', 'tool-health.jsonl']));
  const setup = ofGoal(await reader.jsonl(['chat', 'worktree-setup.jsonl'])).filter(({ value }) => value.kind === 'run');
  const worktrees = ofGoal(await reader.jsonl(['chat', 'worktrees.jsonl']));
  const approvals = [];
  if (goalIds.size) {
    const names = (await reader.names(['approvals'])).filter((name) => APPROVAL_FILE.test(name)).slice(0, limits.approvals);
    for (const name of names) {
      const doc = await reader.doc(['approvals', name]);
      if (doc?.value && goalIds.has(doc.value.goal) && fresh(doc.value.createdAt)) approvals.push(doc);
    }
  }
  const requests = [];
  for (const feature of features) {
    if (!REQUEST_ID.test(feature.id)) continue;
    const doc = await reader.doc(['chat', 'requests', `${feature.id}.json`]);
    if (doc?.value) requests.push(doc);
  }
  return { kind, id, goals, features, snapshots, restores, health, setup, worktrees, approvals, requests, fresh, reader };
}


function finder(dimension) {
  const out = [];
  const add = (severity, code, args = [], { numbers = {}, cites = [], method = null, quote = null } = {}) => {
    out.push({ dimension, severity, code, args, numbers, cites: cites.filter((cite) => cite && typeof cite.file === 'string'), ...(method ? { method } : {}), ...(quote ? { quote } : {}) });
  };
  return { out, add };
}
const capped = (cites, limit = DIAGNOSE_LIMITS.cites) => cites.slice(0, limit);
const logRecords = (ctx) => ctx.goals.flatMap((goal) => goal.log ?? []);
const last = (list) => list[list.length - 1];

function stopRule(ctx) {
  const { out, add } = finder('stop');
  for (const goal of ctx.goals) {
    const value = goal.doc.value, log = goal.log ?? [];
    const stopped = last(log.filter(({ value: item }) => item.kind === 'goal' && item.outcome === 'stopped'));
    if (value.state === 'stopped') {
      add('stop', 'diagnose.stop.goalStopped', [goal.id, oneLine(value.stoppedBy ?? stopped?.value.by ?? '-', 60), oneLine(value.stoppedReason ?? stopped?.value.reason ?? '-')],
        { cites: [docCite(goal.doc, '/state'), ...(value.stoppedReason ? [docCite(goal.doc, '/stoppedReason')] : []), ...(stopped ? [lineCite(stopped.file, stopped.line)] : [])] });
    } else if (value.state === 'done') add('info', 'diagnose.stop.goalDone', [goal.id], { cites: [docCite(goal.doc, '/state')] });
    else add('info', 'diagnose.stop.goalState', [goal.id, oneLine(value.state, 30)], { cites: [docCite(goal.doc, '/state')] });
    const card = last(log.filter(({ value: item }) => item.outcome === 'suggested' && HUMAN_KINDS.has(item.kind)));
    if (card) {
      const after = log.filter(({ value: item }) => item.key === card.value.key && ['executed', 'dismissed'].includes(item.outcome) && item.seq > card.value.seq);
      const end = last(log);
      const wait = Math.max(0, time(end.value.at) - time(card.value.at));
      const decided = last(after);
      add(decided ? 'info' : 'warn', decided ? 'diagnose.stop.humanCardDecided' : 'diagnose.stop.humanCard',
        [oneLine(card.value.kind, 40), oneLine(card.value.feature ?? '-', 64), minutes(Number.isFinite(wait) ? wait : 0), ...(decided ? [oneLine(decided.value.outcome, 20), oneLine(decided.value.by ?? '-', 60)] : [])],
        { numbers: { waitMs: Number.isFinite(wait) ? wait : null }, method: 'diagnose.method.humanCard',
          cites: [lineCite(card.file, card.line), ...(decided ? [lineCite(decided.file, decided.line)] : []), lineCite(end.file, end.line)] });
    }
  }
  for (const restore of ctx.restores) add('info', 'diagnose.stop.restored', [oneLine(restore.value.run ?? '-', 80), oneLine(restore.value.by ?? '-', 60)], { cites: [lineCite(restore.file, restore.line)] });
  for (const feature of ctx.features) {
    const value = feature.doc.value;
    if (value.archivedAt) add('info', 'diagnose.stop.archived', [feature.id], { cites: [docCite(feature.doc, '/archivedAt')] });
    else add('info', 'diagnose.stop.phase', [feature.id, oneLine(value.phase, 20), Number.isSafeInteger(value.iteration) ? value.iteration : '-'], { cites: [docCite(feature.doc, '/phase')] });
  }
  for (const request of ctx.requests) {
    const value = request.value;
    if (['blocked', 'paused', 'question'].includes(value.status)) add('warn', 'diagnose.stop.request', [oneLine(value.id, 80), value.status, oneLine(value.detail ?? '-')], { cites: [docCite(request, '/status'), ...(value.detail ? [docCite(request, '/detail')] : [])] });
  }
  const records = logRecords(ctx);
  const runs = workerRuns(records.map(({ value }) => value));
  const byWorker = new Map(records.filter(({ value }) => value.kind === 'worker').map((item) => [`${item.value.worker}:${item.value.outcome}`, item]));
  for (const feature of ctx.features) {
    const run = last(runs.filter((item) => item.feature === feature.id));
    if (!run?.end || !OUTPUT_ENDS.has(run.end.outcome)) continue;
    const end = byWorker.get(`${run.worker}:${run.end.outcome}`);
    if (end) add('warn', 'diagnose.stop.workerEnded', [feature.id, toolLabel(run.tool), run.end.outcome, oneLine(run.end.reason ?? '-')], { cites: [lineCite(end.file, end.line)] });
  }
  return out;
}

function repeatRule(ctx) {
  const { out, add } = finder('repeat');
  for (const feature of ctx.features) {
    const groups = new Map();
    let untracked = 0;
    const untrackedCites = [];
    (feature.doc.value.proofs ?? []).forEach((proof, index) => {
      if (proof?.kind !== 'test' || proof.exitCode === 0 || !ctx.fresh(proof.at)) return;
      const key = testRepeatKey(proof, { roots: ctx.roots });
      if (!key) { untracked += 1; untrackedCites.push(docCite(feature.doc, pointer('proofs', index))); return; }
      const group = groups.get(key) ?? { command: commandText(proof), exitCode: proof.exitCode ?? null, timedOut: Boolean(proof.timedOut), cites: [] };
      group.cites.push(docCite(feature.doc, pointer('proofs', index)));
      groups.set(key, group);
    });
    for (const group of groups.values()) {
      if (group.cites.length < 2) continue;
      add('warn', 'diagnose.repeat.sameFailure', [feature.id, group.cites.length, oneLine(group.command, 200), group.timedOut ? 'timeout' : String(group.exitCode)],
        { numbers: { count: group.cites.length }, method: 'diagnose.method.sameFailure', cites: capped(group.cites) });
    }
    if (untracked >= 2) add('info', 'diagnose.repeat.untracked', [feature.id, untracked], { numbers: { count: untracked }, cites: capped(untrackedCites) });
  }
  const records = logRecords(ctx);
  for (const item of records) {
    const value = item.value;
    if (value.kind === 'repeat' && value.outcome === 'warned') {
      add('warn', 'diagnose.repeat.warned', [oneLine(value.feature ?? '-', 64), value.repeat?.count ?? '-', oneLine(value.repeat?.command ?? '-', 200)], { numbers: { count: value.repeat?.count ?? null }, cites: [lineCite(item.file, item.line)] });
    } else if (value.kind === 'worker' && value.outcome === 'stuck') {
      add('stop', 'diagnose.repeat.stuck', [oneLine(value.feature ?? '-', 64), value.repeat?.count ?? '-', oneLine(value.repeat?.command ?? '-', 200)], { numbers: { count: value.repeat?.count ?? null }, cites: [lineCite(item.file, item.line)] });
    }
    if (value.kind === 'worker' && value.rootCause && typeof value.rootCause === 'object') {
      const cause = value.rootCause;
      if (cause.missing) add('warn', 'diagnose.repeat.noHypothesis', [oneLine(value.feature ?? '-', 64), cause.attempt ?? '-'], { cites: [lineCite(item.file, item.line)] });
      else add(cause.result === 'fixed' ? 'info' : 'warn', 'diagnose.repeat.hypothesis', [oneLine(value.feature ?? '-', 64), cause.attempt ?? '-', oneLine(cause.hypothesis ?? '-'), oneLine(cause.change ?? '-'), oneLine(cause.result ?? 'unknown', 20), cause.reproduced === false ? 'no' : cause.reproduced === true ? 'yes' : '-'],
        { cites: [lineCite(item.file, item.line)] });
    }
    if (value.outcome === 'suggested' && value.kind === 'approach-doubt') add('stop', 'diagnose.repeat.approachDoubt', [oneLine(value.feature ?? '-', 64), oneLine(value.reason ?? '-')], { cites: [lineCite(item.file, item.line)] });
  }
  const launches = new Map();
  for (const item of records) {
    const value = item.value;
    if (value.kind !== 'worker' || value.outcome !== 'launched') continue;
    const key = `${value.feature}\u0000${value.phase}\u0000${value.iteration}`;
    const entry = launches.get(key) ?? { feature: value.feature, phase: value.phase, iteration: value.iteration, runs: [] };
    entry.runs.push({ at: time(value.at), order: entry.runs.length, cite: lineCite(item.file, item.line) });
    launches.set(key, entry);
  }
  const proposedAt = new Map(ctx.features.map((feature) => [feature.id, (feature.doc.value.approach?.proposals ?? []).map((round) => time(round?.at)).filter(Number.isFinite)]));
  for (const entry of launches.values()) {
    const proposals = entry.phase === 'design' ? proposedAt.get(entry.feature) ?? [] : [];
    const runs = [...entry.runs].sort((a, b) => a.at - b.at);
    const cites = runs.filter((run, index) => {
      const next = runs[index + 1]?.at ?? Infinity;
      return !(Number.isFinite(run.at) && proposals.some((at) => at >= run.at && at < next));
    }).sort((a, b) => a.order - b.order).map((run) => run.cite);
    if (cites.length >= 2) add('info', 'diagnose.repeat.retries', [oneLine(entry.feature ?? '-', 64), oneLine(entry.phase ?? '-', 20), entry.iteration ?? '-', cites.length], { numbers: { launches: cites.length }, cites: capped(cites) });
  }
  return out;
}

const STEP_WARNING = { noSteps: 'diagnose.plan.stepWarning.noSteps', noCheck: 'diagnose.plan.stepWarning.noCheck', badCheck: 'diagnose.plan.stepWarning.badCheck',
  unknownField: 'diagnose.plan.stepWarning.unknownField', uncovered: 'diagnose.plan.stepWarning.uncovered', large: 'diagnose.plan.stepWarning.large',
  gap: 'diagnose.plan.stepWarning.gap', windowsShell: 'diagnose.plan.stepWarning.windowsShell', tooMany: 'diagnose.plan.stepWarning.tooMany',
  sharedCheck: 'diagnose.plan.stepWarning.sharedCheck' };
const STEP_WARNING_WARN = new Set(['noSteps', 'noCheck', 'badCheck', 'uncovered']);
function stepGreen(ctx, feature, add) {
  const value = feature.doc.value;
  if (!['implement', 'review', 'report'].includes(value.phase)) return;
  const proofs = Array.isArray(value.proofs) ? value.proofs : [];
  const progress = stepProgress({ ...value, proofs: proofs.filter((proof) => proof && typeof proof === 'object') }, { include: (proof) => ctx.fresh(proof.at) });
  const checked = progress?.steps.filter((row) => row.state !== 'noCheck') ?? [];
  if (!checked.length) return;
  const missing = checked.filter((row) => row.state !== 'passed').map((row) => row.id);
  const numbers = { steps: progress.total, checked: checked.length, green: checked.length - missing.length, missing: missing.length, none: progress.steps.filter((row) => row.none).length };
  const plan = docCite(feature.doc, '/artifacts/plan');
  if (missing.length) {
    const done = value.phase !== 'implement' && value.completed?.implement;
    add(done ? 'warn' : 'info', done ? 'diagnose.plan.stepsNoGreen' : 'diagnose.plan.stepsPending', [feature.id, missing.length, checked.length, missing.join(', ')],
      { numbers, method: 'diagnose.method.stepsGreen', cites: [plan, ...(done ? [docCite(feature.doc, '/completed/implement')] : [])] });
  } else {
    const cited = checked.map((row) => proofs.findIndex((proof) => proof?.id === row.proof)).filter((index) => index >= 0);
    add('info', 'diagnose.plan.stepsAllGreen', [feature.id, checked.length],
      { numbers, method: 'diagnose.method.stepsGreen', cites: capped([plan, ...cited.map((index) => docCite(feature.doc, pointer('proofs', index)))]) });
  }
}

function planRule(ctx) {
  const { out, add } = finder('plan');
  for (const feature of ctx.features) {
    const value = feature.doc.value;
    const stepsRecord = value.completed?.plan?.steps;
    if (stepsRecord && typeof stepsRecord === 'object' && Array.isArray(stepsRecord.warnings) && ctx.fresh(value.completed.plan.at)) {
      stepsRecord.warnings.forEach((warning, index) => {
        const code = STEP_WARNING[warning?.code];
        if (!code) return;
        const ids = Array.isArray(warning.ids) ? warning.ids.slice(0, 30).map((id) => oneLine(id, 10)) : [];
        add(STEP_WARNING_WARN.has(warning.code) ? 'warn' : 'info', code, [feature.id, ids.join(', ') || '-'],
          { numbers: { ids: ids.length }, cites: [docCite(feature.doc, pointer('completed', 'plan', 'steps', 'warnings', index))] });
      });
    }
    stepGreen(ctx, feature, add);
    const ids = acceptanceIds(value.artifacts?.plan);
    if (ids.length) {
      const review = value.completed?.review;
      if (!review) add('info', 'diagnose.plan.acPending', [feature.id, ids.length], { numbers: { declared: ids.length }, cites: [docCite(feature.doc, '/artifacts/plan')] });
      else {
        const trace = Array.isArray(review.acceptance) ? review.acceptance : [];
        const byId = new Map(trace.map((item, index) => [String(item?.id).toUpperCase(), { item, index }]));
        const missing = ids.filter((id) => !byId.has(id));
        const notPass = ids.filter((id) => byId.has(id) && byId.get(id).item.status !== 'pass');
        if (missing.length) add('warn', 'diagnose.plan.acMissing', [feature.id, missing.join(', ')], { numbers: { missing: missing.length, declared: ids.length }, cites: [docCite(feature.doc, '/artifacts/plan'), docCite(feature.doc, '/completed/review')] });
        if (notPass.length) add('warn', 'diagnose.plan.acNotPassed', [feature.id, notPass.map((id) => `${id} ${byId.get(id).item.status}`).join(', ')],
          { numbers: { notPassed: notPass.length, declared: ids.length }, cites: capped(notPass.map((id) => docCite(feature.doc, pointer('completed', 'review', 'acceptance', byId.get(id).index)))) });
        if (!missing.length && !notPass.length) add('info', 'diagnose.plan.acAllPass', [feature.id, ids.length], { numbers: { declared: ids.length }, cites: [docCite(feature.doc, '/completed/review/acceptance')] });
      }
    }
    const rulings = Array.isArray(value.rulings) ? value.rulings : [];
    const open = [];
    rulings.forEach((ruling, index) => {
      if (!ctx.fresh(ruling?.at)) return;
      if (ruling?.status === 'overridden') add('warn', 'diagnose.plan.rulingOverridden', [feature.id, oneLine(ruling.id, 10), oneLine(ruling.what ?? '-', 200), oneLine(ruling.marked?.defect ?? '-', 10)], { cites: [docCite(feature.doc, pointer('rulings', index))] });
      else if (ruling?.status === 'open') open.push(index);
    });
    if (open.length) add('info', 'diagnose.plan.rulingsOpen', [feature.id, open.length, open.map((index) => rulings[index].id).join(', ')], { numbers: { open: open.length }, cites: capped(open.map((index) => docCite(feature.doc, pointer('rulings', index)))) });
    const defects = (Array.isArray(value.defects) ? value.defects : []).map((defect, index) => ({ defect, index })).filter(({ defect }) => defect?.status === 'open');
    if (defects.length) add('info', 'diagnose.plan.defectsOpen', [feature.id, defects.length, defects.map(({ defect }) => defect.id).join(', ')], { numbers: { open: defects.length }, cites: capped(defects.map(({ index }) => docCite(feature.doc, pointer('defects', index)))) });
  }
  return out;
}

function evidenceRule(ctx) {
  const { out, add } = finder('evidence');
  for (const feature of ctx.features) {
    const value = feature.doc.value;
    for (const [phase, done] of Object.entries(value.completed ?? {})) {
      if (!done || typeof done !== 'object' || !ctx.fresh(done.at)) continue;
      const at = (...parts) => docCite(feature.doc, pointer('completed', phase, ...parts));
      if (done.waiver) add('warn', 'diagnose.evidence.noProof', [feature.id, phase, oneLine(done.waiver)], { cites: [at('waiver')] });
      if (done.acWaiver) add('warn', 'diagnose.evidence.acUnverified', [feature.id, oneLine(done.acWaiver)], { cites: [at('acWaiver')] });
      if (done.defectWaiver) add('warn', 'diagnose.evidence.defectUnverified', [feature.id, oneLine(done.defectWaiver)], { cites: [at('defectWaiver')] });
      const red = done.redGreen;
      if (red && typeof red === 'object') {
        if (red.waiver) add('warn', 'diagnose.evidence.noRed', [feature.id, oneLine(red.waiver)], { cites: [at('redGreen', 'waiver')] });
        else if (['missing', 'partial'].includes(red.state)) add('warn', 'diagnose.evidence.redGreenMissing', [feature.id, red.state, oneLine(red.mode ?? '-', 10)], { cites: [at('redGreen')] });
        if (Array.isArray(red.warnings) && red.warnings.length) add('info', 'diagnose.evidence.redGreenWarnings', [feature.id, red.warnings.map((code) => oneLine(code, 30)).join(', ')], { cites: [at('redGreen', 'warnings')] });
      }
    }
    const basis = freshnessBasis(value);
    if (basis) {
      const index = value.proofs.indexOf(basis);
      const head = basis.tree?.head ?? null;
      const later = (value.history ?? []).map((event, at) => ({ event, at })).filter(({ event }) => event?.action === 'complete' && typeof event.head === 'string' && time(event.at) > time(basis.at) && !event.worktree === !basis.worktree);
      const moved = later.find(({ event }) => head && event.head !== head);
      if (moved) add('warn', 'diagnose.evidence.changedAfter', [feature.id, basis.phase, oneLine(moved.event.phase, 20), head.slice(0, 12), moved.event.head.slice(0, 12)],
        { method: 'diagnose.method.changedAfter', cites: [docCite(feature.doc, pointer('proofs', index)), docCite(feature.doc, pointer('history', moved.at))] });
      else if (!head || basis.tree?.unknown) add('info', 'diagnose.evidence.freshnessUnknown', [feature.id], { cites: [docCite(feature.doc, pointer('proofs', index))] });
    }
  }
  const unknown = ctx.snapshots.filter(({ value }) => value.state === 'unknown');
  if (unknown.length) add('info', 'diagnose.evidence.snapshotUnknown', [unknown.length, [...new Set(unknown.map(({ value }) => oneLine(value.reason ?? '-', 40)))].join(', ')],
    { numbers: { count: unknown.length }, cites: capped(unknown.map((item) => lineCite(item.file, item.line))) });
  return out;
}

function approvalRule(ctx) {
  const { out, add } = finder('approval');
  const byAllow = [], waited = [], open = [], lapsed = [];
  for (const doc of ctx.approvals) {
    const value = doc.value;
    if (typeof value.decidedBy === 'string' && value.decidedBy.startsWith('goal-allow:')) byAllow.push(doc);
    else if (Number.isSafeInteger(value.decidedAt) && Number.isSafeInteger(value.createdAt) && value.decidedAt >= value.createdAt) waited.push({ doc, ms: value.decidedAt - value.createdAt });
    else if (value.status === 'pending') open.push(doc);
    else if (['expired', 'cancelled'].includes(value.status)) lapsed.push(doc);
  }
  if (waited.length) {
    waited.sort((a, b) => b.ms - a.ms || String(a.doc.value.id).localeCompare(String(b.doc.value.id)));
    const total = waited.reduce((sum, item) => sum + item.ms, 0), longest = waited[0];
    const denied = waited.filter(({ doc }) => doc.value.decision === 'deny').length;
    add(minutes(longest.ms) >= 10 ? 'warn' : 'info', 'diagnose.approval.wait', [waited.length, minutes(total), minutes(longest.ms), oneLine(longest.doc.value.action ?? '-', 80), denied],
      { numbers: { count: waited.length, totalMs: total, longestMs: longest.ms, denied }, method: 'diagnose.method.approvalWait',
        cites: capped(waited.map(({ doc }) => docCite(doc, '/decidedAt'))) });
  }
  if (open.length) add('warn', 'diagnose.approval.open', [open.length, open.map(({ value }) => oneLine(value.action ?? '-', 60)).slice(0, 3).join(', ')], { numbers: { count: open.length }, cites: capped(open.map((doc) => docCite(doc, '/status'))) });
  if (lapsed.length) add('info', 'diagnose.approval.lapsed', [lapsed.length], { numbers: { count: lapsed.length }, cites: capped(lapsed.map((doc) => docCite(doc, '/status'))) });
  if (byAllow.length) add('info', 'diagnose.approval.goalAllow', [byAllow.length], { numbers: { count: byAllow.length }, cites: capped(byAllow.map((doc) => docCite(doc, '/decidedBy'))) });
  return out;
}

function costRule(ctx) {
  const { out, add } = finder('cost');
  const records = logRecords(ctx);
  const ends = records.filter(({ value }) => usageRecords([value]).length);
  if (ends.length) {
    const summary = sumUsage(ends.map(({ value }) => value));
    for (const entry of summary.tools) {
      const cites = ends.filter(({ value }) => value.usage?.source === entry.tool).map((item) => lineCite(item.file, item.line));
      add('info', 'diagnose.cost.tool', [entry.label, entry.runs, entry.costUsd === null ? '-' : entry.costUsd.toFixed(2), entry.counted],
        { numbers: { runs: entry.runs, costUsd: entry.costUsd, tokens: entry.counted }, cites: capped(cites) });
    }
    add(summary.costUnknown ? 'warn' : 'info', 'diagnose.cost.total', [summary.runs, summary.costUsd === null ? '-' : summary.costUsd.toFixed(2), summary.costUnknown, summary.tokens],
      { numbers: { runs: summary.runs, costUsd: summary.costUsd, costUnknown: summary.costUnknown, tokens: summary.tokens }, method: 'diagnose.method.cost', cites: capped(ends.map((item) => lineCite(item.file, item.line))) });
  }
  const values = records.map(({ value }) => value);
  const lineOfRun = new Map();
  for (const item of records) {
    const { kind, outcome } = item.value;
    const id = kind === 'worker' ? item.value.worker : kind === 'judgment' ? item.value.judge : null;
    if (typeof id !== 'string') continue;
    const end = (kind === 'worker' ? WORKER_END : JUDGE_END).has(outcome);
    if (end || outcome === (kind === 'worker' ? 'launched' : 'requested')) lineOfRun.set(`${kind}:${id}:${end ? 'end' : 'start'}`, item);
  }
  const timed = new Map();
  for (const run of [...workerRuns(values).map((item) => ({ item, kind: 'worker', id: item.worker })), ...judgmentRuns(values).map((item) => ({ item, kind: 'judgment', id: item.judge }))]) {
    if (!run.item.end) continue;
    const ms = time(run.item.end.at) - time(run.item.at);
    if (!Number.isFinite(ms) || ms < 0) continue;
    const entry = timed.get(run.item.tool) ?? { tool: run.item.tool, runs: 0, ms: 0, cites: [] };
    entry.runs += 1; entry.ms += ms;
    for (const point of ['start', 'end']) { const found = lineOfRun.get(`${run.kind}:${run.id}:${point}`); if (found) entry.cites.push(lineCite(found.file, found.line)); }
    timed.set(run.item.tool, entry);
  }
  for (const entry of timed.values()) add('info', 'diagnose.cost.time', [toolLabel(entry.tool), entry.runs, minutes(entry.ms)], { numbers: { runs: entry.runs, ms: entry.ms }, method: 'diagnose.method.time', cites: capped(entry.cites) });
  for (const feature of ctx.features) {
    const history = Array.isArray(feature.doc.value.history) ? feature.doc.value.history : [];
    const lastAt = Math.max(...history.map((event) => time(event?.at)).filter(Number.isFinite));
    if (!Number.isFinite(lastAt)) continue;
    const { phases, totalMs } = phaseDurations(feature.doc.value, lastAt);
    const parts = Object.entries(phases).map(([phase, item]) => `${phase} ${minutes(item.ms)}`);
    if (parts.length) add('info', 'diagnose.cost.phases', [feature.id, parts.join(', '), minutes(totalMs)], { numbers: { totalMs, ...Object.fromEntries(Object.entries(phases).map(([phase, item]) => [`${phase}Ms`, item.ms])) }, method: 'diagnose.method.phases', cites: [docCite(feature.doc, '/history')] });
  }
  return out;
}

function toolRule(ctx) {
  const { out, add } = finder('tool');
  const silent = new Map();
  for (const item of logRecords(ctx)) {
    const value = item.value;
    if (!['worker', 'judgment'].includes(value.kind) || !OUTPUT_ENDS.has(value.outcome)) continue;
    const output = value.output && typeof value.output === 'object' ? value.output : null;
    if (!output) {
      const entry = silent.get(value.tool) ?? { tool: value.tool, outcomes: new Set(), cites: [] };
      entry.outcomes.add(value.outcome); entry.cites.unshift(lineCite(item.file, item.line));
      silent.set(value.tool, entry);
      continue;
    }
    const rpc = output.rpcError && typeof output.rpcError === 'object' ? output.rpcError : null;
    add(value.outcome === 'failed' ? 'warn' : 'info', rpc ? 'diagnose.tool.outputRpc' : 'diagnose.tool.output',
      [toolLabel(value.tool), value.outcome, oneLine(output.source ?? '-', 10), Number.isSafeInteger(output.bytes) ? output.bytes : '-', ...(rpc ? [rpc.code ?? '-', oneLine(rpc.message ?? '-')] : [])],
      { numbers: { bytes: Number.isSafeInteger(output.bytes) ? output.bytes : null, scrubbed: Number.isSafeInteger(output.scrubbed) ? output.scrubbed : null }, cites: [lineCite(item.file, item.line)],
        ...(typeof output.tail === 'string' && output.tail.trim() ? { quote: quoteText(output.tail) } : {}) });
  }
  for (const entry of silent.values()) add('info', 'diagnose.tool.noOutput', [toolLabel(entry.tool), entry.cites.length, [...entry.outcomes].join(', ')], { numbers: { runs: entry.cites.length }, cites: capped(entry.cites) });
  const shapes = new Map();
  for (const item of ctx.health) {
    const value = item.value;
    if (value.kind === 'success' || typeof value.shape !== 'string') continue;
    const key = `${value.tool}\u0000${value.shape}\u0000${value.rule ?? ''}`;
    const entry = shapes.get(key) ?? { value, cites: [] };
    entry.cites.unshift(lineCite(item.file, item.line));
    shapes.set(key, entry);
  }
  for (const { value, cites } of shapes.values()) add('warn', 'diagnose.tool.health', [toolLabel(value.tool), oneLine(value.shape, 20), oneLine(value.rule ?? '-', 60), cites.length], { numbers: { count: cites.length }, cites: capped(cites) });
  for (const item of ctx.setup) {
    const value = item.value;
    if (value.outcome === 'ok') continue;
    add('warn', 'diagnose.tool.setup', [oneLine(value.worktree ?? '-', 40), oneLine(value.outcome ?? '-', 20), value.code ?? '-'], { cites: [lineCite(item.file, item.line)],
      ...(typeof value.output === 'string' && value.output.trim() ? { quote: quoteText(value.output) } : {}) });
  }
  return out;
}

function recordsRule(ctx) {
  const { out, add } = finder('records');
  for (const issue of ctx.reader.issues) {
    if (issue.kind === 'broken') add('warn', 'diagnose.records.broken', [issue.file, issue.lines.length, issue.lines.slice(0, 10).join(', ')], { numbers: { count: issue.lines.length }, cites: capped(issue.lines.map((line) => lineCite(issue.file, line))) });
    else if (issue.kind === 'truncated') add('warn', issue.by === 'lines' ? 'diagnose.records.truncatedLines' : 'diagnose.records.truncatedBytes', [issue.file, issue.by === 'lines' ? ctx.limits.lines : Math.round(ctx.limits.bytes / 1024 / 1024)], { cites: [issue.line ? lineCite(issue.file, issue.line) : { file: issue.file }] });
    else if (issue.kind === 'link') add('warn', 'diagnose.records.link', [issue.file], { cites: [{ file: issue.file }] });
    else if (issue.kind === 'badJson') add('warn', 'diagnose.records.badJson', [issue.file, issue.line], { cites: [lineCite(issue.file, issue.line)] });
    else if (issue.kind === 'featureMissing') add('warn', 'diagnose.records.featureMissing', [oneLine(issue.id, 64)], { cites: [issue.cite] });
  }
  return out;
}

export const RULES = { stop: stopRule, repeat: repeatRule, plan: planRule, evidence: evidenceRule, approval: approvalRule, cost: costRule, tool: toolRule, records: recordsRule };

export function collect(ctx, rules = RULES, { perCode = DIAGNOSE_LIMITS.perCode } = {}) {
  let dropped = 0;
  const dimensions = DIMENSIONS.map((id) => {
    let found = (rules[id]?.(ctx) ?? []).filter((item) => { if (item.cites.length) return true; dropped += 1; return false; });
    const byCode = new Map();
    for (const item of found) { if (!byCode.has(item.code)) byCode.set(item.code, []); byCode.get(item.code).push(item); }
    const more = [];
    for (const [code, items] of byCode) {
      if (items.length <= perCode) continue;
      const hidden = items.slice(0, items.length - perCode);
      const gone = new Set(hidden);
      found = found.filter((item) => !gone.has(item));
      more.push({ dimension: id, severity: 'info', code: 'diagnose.more', args: [hidden.length, t(code, ...hidden.at(-1).args)], of: { code, args: hidden.at(-1).args }, numbers: { count: hidden.length },
        cites: hidden.flatMap((item) => item.cites).slice(-DIAGNOSE_LIMITS.cites) });
    }
    found = [...found, ...more];
    found.forEach((item, index) => { item.order = index; });
    found.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.order - b.order);
    return { id, findings: found.map(({ order, ...item }) => ({ ...item, text: t(item.code, ...item.args) })) };
  });
  return { dimensions, dropped };
}

export async function diagnose(root, id, options = {}) {
  const { report, context } = await buildReport(root, id, options);
  const done = scrubValue(report, context);
  return { ...done.value, scrubbed: done.count, scrubRules: done.rules };
}

export async function buildReport(root, id, { since = null, limits = {}, context = null, keepEmail = false } = {}) {
  if (typeof id !== 'string' || !id) throw new WaxError(t('errors.diagnose.invalidId', String(id ?? '')));
  let sinceMs = null;
  if (since !== null && since !== undefined) {
    sinceMs = Date.parse(since);
    if (typeof since !== 'string' || !Number.isFinite(sinceMs)) throw new WaxError(t('errors.diagnose.since', String(since)));
  }
  const limit = { ...DIAGNOSE_LIMITS, ...limits };
  const realRoot = await realpath(root).catch(() => root);
  const ctx = await gather(root, id, { since: sinceMs, limits: limit });
  const worktreePaths = ctx.worktrees.map(({ value }) => value.path).filter((path) => typeof path === 'string' && path.length > 1);
  ctx.roots = [...new Set([root, realRoot, ...worktreePaths])];
  ctx.limits = limit;
  const { dimensions, dropped } = collect(ctx, RULES, { perCode: limit.perCode });
  const findings = dimensions.flatMap((dimension) => dimension.findings);
  const summary = dimensions.find((dimension) => dimension.id === 'stop').findings[0] ?? null;
  const report = {
    schema: 1,
    target: { kind: ctx.kind, id, goals: ctx.goals.map((goal) => goal.id), features: ctx.features.map((feature) => feature.id) },
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    summary, dimensions, findings: findings.length,
    files: ctx.reader.files, read: ctx.reader.files.length, dropped,
  };
  return { report, context: context ?? scrubContext({ roots: ctx.roots, keepEmail }), limits: limit, ctx };
}


export const CITE_LIMITS = { chars: 20_000 };
const CITE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function recordParts(file) {
  const parts = typeof file === 'string' ? file.split('/') : [];
  if (parts[0] !== '.wax' || parts.length < 2 || !parts.slice(1).every((part) => CITE_PART.test(part) && !/^\.+$/.test(part))) return null;
  return parts.slice(1);
}

export async function readRecordText(root, file, limits = DIAGNOSE_LIMITS) {
  const parts = recordParts(file);
  if (!parts) return null;
  const found = await plain(root, parts);
  if (found.state !== 'ok') return { state: found.state };
  return readCapped(found.path, limits.bytes);
}

function valueAt(value, pointerText) {
  if (pointerText === '') return value;
  let here = value;
  for (const raw of pointerText.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (here === null || typeof here !== 'object' || !Object.hasOwn(here, key)) return undefined;
    here = here[key];
  }
  return here;
}

export async function diagnoseCite(root, id, cite, options = {}) {
  const { report, context, limits } = await buildReport(root, id, options);
  const scrubbed = scrubValue(report, context).value;
  const file = typeof cite?.file === 'string' ? cite.file : '';
  const line = Number(cite?.line);
  const wanted = typeof cite?.pointer === 'string' && cite.pointer ? cite.pointer : null;
  const found = scrubbed.dimensions.some((dimension) => dimension.findings.some((item) => item.cites.some((entry) => entry.file === file && entry.line === line && (entry.pointer ?? null) === wanted)));
  const parts = recordParts(file);
  if (!found || !Number.isSafeInteger(line) || line < 1 || !parts) throw new WaxError(t('errors.diagnose.citeNotFound'), 404);
  const reader = createReader(root, limits);
  let shown;
  if (wanted) {
    const doc = await reader.doc(parts);
    if (!doc?.value) throw new WaxError(t('errors.diagnose.citeNotFound'), 404);
    const value = valueAt(doc.value, wanted);
    if (value === undefined) throw new WaxError(t('errors.diagnose.citeNotFound'), 404);
    shown = value;
  } else {
    const records = await reader.jsonl(parts);
    const record = records?.records.find((item) => item.line === line);
    if (!record) throw new WaxError(t('errors.diagnose.citeNotFound'), 404);
    shown = record.value;
  }
  const clean = scrubValue(shown, context).value;
  const text = (typeof clean === 'string' ? clean : JSON.stringify(clean, null, 2) ?? String(clean)).replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, '');
  const chars = Array.from(text);
  const truncated = chars.length > CITE_LIMITS.chars;
  return { file, line, pointer: wanted, text: truncated ? `${chars.slice(0, CITE_LIMITS.chars).join('')}\n…` : text, truncated };
}


const SEVERITY_TEXT = { stop: 'diagnose.severity.stop', warn: 'diagnose.severity.warn', info: 'diagnose.severity.info' };
const DIMENSION_TEXT = { stop: 'diagnose.dimension.stop', repeat: 'diagnose.dimension.repeat', plan: 'diagnose.dimension.plan', evidence: 'diagnose.dimension.evidence',
  approval: 'diagnose.dimension.approval', cost: 'diagnose.dimension.cost', tool: 'diagnose.dimension.tool', records: 'diagnose.dimension.records' };
export const citeText = (cite) => `${cite.file}${cite.line ? `:${cite.line}` : ''}${cite.pointer ? `#${cite.pointer}` : ''}`;
const fence = (text) => { const ticks = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length)) + 1; return '`'.repeat(ticks); };

export const findingText = (item, say = t) => (item.code === 'diagnose.more' && item.of?.code ? say(item.code, item.args[0], say(item.of.code, ...(item.of.args ?? []))) : say(item.code, ...item.args));

export function renderDiagnose(report, say = t) {
  const lines = [`# ${say('diagnose.title', report.target.id)}`, ''];
  const summary = report.summary;
  lines.push(say('diagnose.summary', summary ? findingText(summary, say) : say('diagnose.nothing')));
  lines.push(say(report.target.kind === 'goal' ? 'diagnose.targetGoal' : 'diagnose.targetFeature', report.target.id,
    (report.target.kind === 'goal' ? report.target.features : report.target.goals).join(', ') || '-', report.read));
  if (report.since) lines.push(say('diagnose.since', report.since));
  for (const dimension of report.dimensions) {
    lines.push('', `## ${say(DIMENSION_TEXT[dimension.id])}`, '');
    const shown = dimension.findings.filter((item) => item.cites?.length);
    if (!shown.length) { lines.push(`- ${say('diagnose.nothingIn', report.read)}`); continue; }
    for (const item of shown) {
      lines.push(`- **${say(SEVERITY_TEXT[item.severity])}** ${findingText(item, say)}`);
      lines.push(`  ${say('diagnose.cites', item.cites.map((cite) => `\`${citeText(cite)}\``).join(' '))}`);
      if (item.method) lines.push(`  ${say('diagnose.methodLabel', say(item.method))}`);
      if (item.quote) { const mark = fence(item.quote); lines.push(`  ${mark}`, ...item.quote.split('\n').map((row) => `  ${row}`), `  ${mark}`); }
    }
  }
  lines.push('', say('diagnose.readOnly'));
  return `${lines.join('\n')}\n`;
}
