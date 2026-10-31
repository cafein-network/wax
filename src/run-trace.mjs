import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFeature, LABELS, PHASES } from './workflow.mjs';
import { acceptanceTrace } from './acceptance.mjs';
import { phaseDurations } from './durations.mjs';
import { createTreeObserver, evidenceFreshness, headState } from './freshness.mjs';
import { code, inline, PR_BODY_LIMITS } from './pr-body.mjs';
import { chatDir, checkFile } from './chat/paths.mjs';
import { featureDecisions } from './chat/pm-loop.mjs';
import { cliText } from './cli-locale.mjs';
import { captureLabelText, listCaptures } from './capture.mjs';
import { compareCaptures, compareLines, hasComparison } from './visual-compare.mjs';
const PM_OUTCOME = { executed: 'trace.pmExecuted', dismissed: 'trace.pmDismissed', launched: 'trace.pmLaunched', exited: 'trace.pmExited', timeout: 'trace.pmTimeout', failed: 'trace.pmFailed', stopped: 'trace.pmStopped' };
const JUDGE_OUTCOME = { requested: 'trace.pmRequested', proposed: 'trace.pmProposed', rejected: 'trace.pmRejected', failed: 'trace.judgeFailed', timeout: 'trace.judgeTimeout', stopped: 'trace.judgeStopped' };
const pmOutcome = (decision) => (decision.kind === 'judgment' ? JUDGE_OUTCOME[decision.outcome] : PM_OUTCOME[decision.outcome]) ?? 'trace.pmDismissed';

export const TRACE_LIMITS = { visits: 200, diffs: 60, files: 50, notes: 5, pm: 10, note: 300, proofs: 30, changed: 10, timeout: 5000, buffer: 2_000_000 };
const SHA = /^[a-f0-9]{40,64}$/;
const REQUEST_ID = /^request-[a-f0-9-]{36}$/;
const time = (value) => (typeof value === 'string' ? Date.parse(value) : NaN);
const sha = (value) => (typeof value === 'string' && SHA.test(value) ? value : null);
const clip = (value, limit) => { const all = Array.from(String(value ?? '').trim()); return all.length > limit ? `${all.slice(0, limit - 1).join('')}…` : all.join(''); };

function proofSummary(proof, linked) {
  return {
    id: proof.id, kind: proof.kind, at: proof.at, linked, author: proof.author ?? null,
    ...(proof.kind === 'test' ? { command: Array.isArray(proof.command) ? proof.command.join(' ').slice(0, 300) : '', exitCode: proof.exitCode ?? null, timedOut: Boolean(proof.timedOut), commit: proof.commit ?? null, dirty: typeof proof.dirty === 'boolean' ? proof.dirty : null, verification: proof.verification ?? null } : {}),
    ...(proof.kind === 'git' ? { commit: proof.commit, files: Array.isArray(proof.files) ? proof.files.length : 0 } : {}),
  };
}

export function requestSummary(record) {
  if (!record || typeof record !== 'object' || !REQUEST_ID.test(record.id ?? '')) return null;
  const notes = (Array.isArray(record.messages) ? record.messages : [])
    .filter((m) => m && m.role === 'assistant' && ['question', 'blocked'].includes(m.outcome) && Number.isFinite(time(m.at)))
    .map((m) => ({ outcome: m.outcome, at: m.at, phase: PHASES.includes(m.phase) ? m.phase : null, text: clip(m.text, TRACE_LIMITS.note) }));
  const word = (value) => (typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null);
  return { id: record.id, tool: word(record.tool), mode: word(record.mode), author: typeof record.author === 'string' ? clip(record.author, 40) : null,
    status: word(record.status), phase: PHASES.includes(record.phase) || record.phase === 'done' ? record.phase : null, notes,
    ...(record.origin && typeof record.origin === 'object' && !Array.isArray(record.origin) ? { origin: Object.fromEntries(Object.entries(record.origin).filter(([, v]) => typeof v === 'string').slice(0, 8).map(([k, v]) => [clip(k, 40), clip(v, 300)])) } : {}) };
}

export function traceVisits(feature, { request = null, pm = [], now = Date.now() } = {}) {
  const history = Array.isArray(feature?.history) ? feature.history : [];
  const completed = feature?.completed && typeof feature.completed === 'object' ? feature.completed : {};
  const proofs = Array.isArray(feature?.proofs) ? feature.proofs : [];
  const visits = [];
  let cur = null, open = null, since = null, last = null, paused = false, iteration = 0;

  const completionFor = (phase, at) => {
    if (completed[phase]?.at === at) return completed[phase];
    for (const event of history) if (event?.action === 'archive' && event.completed?.[phase]?.at === at) return event.completed[phase];
    return null;
  };
  const enter = (phase, event, cause = null) => {
    open = PHASES.includes(phase) ? phase : null;
    since = open && !paused ? time(event.at) : null;
    cur = null;
    if (!open) return;
    cur = { phase: open, iteration, start: event.at, end: null, ms: 0, open: false, outcome: null, cause, startHead: sha(event.head), endHead: null, dirty: null, author: null, tool: null };
    visits.push(cur);
  };
  const close = (at) => { if (open && cur && since !== null && at >= since) cur.ms += at - since; since = null; };
  const finish = (event, outcome, extra = {}) => {
    if (!cur) return;
    Object.assign(cur, { end: event.at, outcome, endHead: sha(event.head), dirty: typeof event.dirty === 'boolean' ? event.dirty : null,
      author: typeof event.author === 'string' ? event.author : null, tool: typeof event.tool === 'string' ? event.tool : null, ...extra });
  };

  for (const event of history) {
    if (event === null || typeof event !== 'object') continue;
    const at = time(event.at);
    if (!Number.isFinite(at) || (last !== null && at < last)) continue;
    const { action, phase } = event;
    if (!PHASES.includes(phase) && phase !== 'done') continue;
    if (action === 'create') { paused = false; enter(phase, event); }
    else if (action === 'complete') {
      if (open === phase) {
        close(at);
        const record = completionFor(phase, event.at);
        finish(event, 'complete', record ? { completion: record } : {});
      } else if (cur) finish(event, 'moved', { endHead: null, dirty: null, author: null, tool: null });
      enter(PHASES.includes(phase) ? PHASES[PHASES.indexOf(phase) + 1] : null, event);
    } else if (action === 'archive') {
      if (Number.isSafeInteger(event.iteration)) iteration = event.iteration;
    } else if (action === 'iterate') {
      const reason = typeof event.reason === 'string' ? event.reason : null;
      if (open === phase) { close(at); finish(event, 'iterate', { reason }); }
      else if (cur) finish(event, 'moved');
      iteration += 1;
      enter('implement', event, { action: 'iterate', reason, author: typeof event.author === 'string' ? event.author : null });
    } else if (action === 'archive-feature') { close(at); paused = true; }
    else if (action === 'restore') { paused = false; if (open) since = at; }
    else if (action === 'import') {
      if (last !== null) close(last);
      if (open !== phase) { if (cur) finish({ at: new Date(last ?? at).toISOString() }, 'moved'); open = null; enter(phase, event); }
      else if (open && !paused) since = at;
    } else if (PHASES.includes(phase) && open !== phase) {
      close(at); if (cur) finish(event, 'moved', { endHead: null, dirty: null, author: null, tool: null }); enter(phase, event);
    }
    last = at;
  }
  const end = now instanceof Date ? now.getTime() : Number(now);
  if (cur && cur.end === null) {
    cur.open = true;
    if (open && since !== null && Number.isFinite(end) && end >= since) { cur.ms += end - since; since = null; }
    cur.outcome = paused || feature?.archivedAt ? 'archived' : 'open';
  }

  for (const visit of visits) {
    const startAt = time(visit.start), endAt = visit.end === null ? Infinity : time(visit.end);
    const completion = visit.completion ?? null;
    delete visit.completion;
    const linked = new Set(Array.isArray(completion?.proofIds) ? completion.proofIds : []);
    visit.proofs = proofs.filter((proof) => linked.has(proof.id) ||
      (proof.phase === visit.phase && proof.iteration === visit.iteration && time(proof.at) >= startAt && time(proof.at) <= endAt))
      .sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-TRACE_LIMITS.proofs).map((proof) => proofSummary(proof, linked.has(proof.id)));
    visit.missingProofs = [...linked].filter((id) => !proofs.some((proof) => proof.id === id));
    visit.evidence = typeof completion?.evidence === 'string' ? completion.evidence : null;
    visit.waiver = typeof completion?.waiver === 'string' ? completion.waiver : null;
    visit.warning = typeof completion?.warning === 'string' ? completion.warning : null;
    visit.author ??= typeof completion?.author === 'string' ? completion.author : null;
    visit.acceptance = visit.phase !== 'review' ? null
      : Array.isArray(completion?.acceptance) ? completion.acceptance
      : visit.open ? (acceptanceTrace(feature ?? {}).length ? acceptanceTrace(feature ?? {}) : null) : null;
    visit.acWaiver = typeof completion?.acWaiver === 'string' ? completion.acWaiver : null;
    visit.notes = (request?.notes ?? []).filter((note) => (!note.phase || note.phase === visit.phase) && time(note.at) >= startAt && time(note.at) <= endAt).slice(-TRACE_LIMITS.notes);
    visit.waiting = visit.open && request && ['question', 'blocked'].includes(request.status) && request.phase === visit.phase ? request.status : null;
    visit.files = null;
    visit.pm = [];
  }
  for (const decision of Array.isArray(pm) ? pm : []) {
    const at = time(decision?.at);
    if (!Number.isFinite(at)) continue;
    const visit = visits.find((item) => item.phase === decision.phase && at >= time(item.start) && (item.end === null || at <= time(item.end) + 1000))
      ?? (decision.phase === 'done' ? visits.at(-1) : null);
    if (visit && visit.pm.length < TRACE_LIMITS.pm) visit.pm.push({ kind: clip(decision.kind, 20), outcome: clip(decision.outcome, 20), by: clip(decision.by, 40), to: decision.to ? clip(decision.to, 40) : null, reason: clip(decision.reason, TRACE_LIMITS.note), at: decision.at });
  }
  return {
    id: feature?.id ?? null, title: feature?.title ?? null, phase: feature?.phase ?? null, iteration: Number.isSafeInteger(feature?.iteration) ? feature.iteration : 0,
    archived: Boolean(feature?.archivedAt), durations: phaseDurations(feature, now), request: request ? { ...request, notes: undefined } : null,
    visits: visits.slice(-TRACE_LIMITS.visits), omittedVisits: Math.max(0, visits.length - TRACE_LIMITS.visits),
  };
}

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', ...args], { cwd: root, encoding: 'utf8', timeout: TRACE_LIMITS.timeout, maxBuffer: TRACE_LIMITS.buffer, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

export async function changedBetween(root, from, to) {
  if (!sha(from) || !sha(to)) return null;
  if (from === to) return { from, to, count: 0, files: [] };
  try {
    const parts = (await git(root, ['diff', '--numstat', '-z', '--relative', '--no-renames', from, to, '--'])).split('\0').filter(Boolean);
    const files = [];
    for (const part of parts) {
      const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(part);
      if (!match || match[3] === '.wax' || match[3].startsWith('.wax/')) continue;
      files.push({ path: match[3], added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]) });
    }
    return { from, to, count: files.length, files: files.slice(0, TRACE_LIMITS.files) };
  } catch { return { from, to, unknown: true, count: 0, files: [] }; }
}

async function readRequest(root, id) {
  if (!REQUEST_ID.test(id)) return null;
  try {
    const dir = await chatDir(root, 'requests');
    if (!dir) return null;
    return requestSummary(JSON.parse(await readFile(await checkFile(join(dir, `${id}.json`)), 'utf8')));
  } catch { return null; }
}

export async function buildRunTrace(root, id, { language = cliText().language, now = Date.now(), observe } = {}) {
  const feature = await getFeature(root, id);
  const trace = traceVisits(feature, { request: await readRequest(root, id), pm: await featureDecisions(root, id).catch(() => []), now });
  observe ??= createTreeObserver(root);
  const current = trace.visits.some((visit) => visit.open && visit.startHead) ? (await headState(root)).head ?? null : null;
  let diffs = 0;
  for (const visit of trace.visits) {
    const to = visit.endHead ?? (visit.open ? current : null);
    if (visit.startHead && to && diffs < TRACE_LIMITS.diffs) { diffs += 1; visit.files = await changedBetween(root, visit.startHead, to); if (visit.open && visit.files) visit.files.live = true; }
    for (const summary of visit.proofs) {
      const proof = feature.proofs?.find((item) => item.id === summary.id);
      if (!proof?.tree) continue;
      const seen = await observe(proof.tree);
      summary.changed = { state: seen.state, count: seen.files.length, files: seen.files.slice(0, TRACE_LIMITS.changed) };
    }
    const startAt = time(visit.start), endAt = visit.end === null ? Infinity : time(visit.end);
    visit.captures = (await listCaptures(root, feature.id, visit.phase, visit.iteration, TRACE_LIMITS.proofs)).captures
      .filter((capture) => time(capture.at) >= startAt && time(capture.at) <= endAt);
  }
  const review = trace.visits.findLast((visit) => visit.phase === 'review');
  if (review) { const compare = await compareCaptures(root, feature.id, { iteration: review.iteration }).catch(() => null); review.compare = hasComparison(compare) ? compare : null; }
  trace.freshness = await evidenceFreshness(root, feature, observe).catch(() => null);
  trace.markdown = renderTraceMarkdown(trace, language);
  return trace;
}

const phaseName = (phase, language) => (language === 'en' ? phase : LABELS[phase] ?? phase);

export function formatSpan(ms, say) {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (minutes < 1) return say('dashboard.durationUnderMinute');
  if (minutes < 60) return say('dashboard.durationMinutes', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return say('dashboard.durationHoursMinutes', hours, minutes % 60);
  return say('dashboard.durationDaysHours', Math.floor(hours / 24), hours % 24);
}

const OUTCOME = { complete: 'trace.outcomeComplete', iterate: 'trace.outcomeIterate', moved: 'trace.outcomeMoved', open: 'trace.outcomeOpen', archived: 'trace.outcomeArchived' };
const AC_STATUS = { pass: 'prBody.acPass', fail: 'prBody.acFail', unverified: 'prBody.acUnverified', pending: 'prBody.acPending' };

export function renderTraceMarkdown(trace, language = cliText().language) {
  const { say } = cliText(language);
  const lines = [];
  const push = (...items) => lines.push(...items);
  const short = (value) => code(String(value).slice(0, 12));
  push(`# ${say('trace.heading', inline(trace.title ?? trace.id))}`, '');
  push(say('trace.generated', code(`.wax/features/${trace.id}.json`), code(`wax trace ${trace.id}`)), '');
  push(say('trace.summary', trace.phase === 'done' ? say('prBody.allDone') : phaseName(trace.phase, language), trace.iteration, trace.visits.length, formatSpan(trace.durations?.totalMs ?? 0, say)));
  if (trace.archived) push('', say('prBody.archived'));
  if (trace.request) {
    const r = trace.request;
    push('', say('trace.request', code(r.id), r.tool ? code(r.tool) : '-', r.mode ? code(r.mode) : '-', r.status ? code(r.status) : '-'));
    if (r.origin) push(say('trace.origin', Object.entries(r.origin).map(([key, value]) => `${inline(key, 40)}: ${inline(value, 300)}`).join(', ')));
  }
  if (!trace.visits.length) push('', say('trace.noVisits'));
  if (trace.omittedVisits) push('', say('trace.omittedVisits', trace.omittedVisits));

  trace.visits.forEach((visit, index) => {
    push('', `## ${index + 1}. ${phaseName(visit.phase, language)} · ${say('trace.iteration', visit.iteration)}`, '');
    const span = !visit.open || visit.outcome === 'archived' ? formatSpan(visit.ms, say) : visit.ms < 60_000 ? say('dashboard.durationJustStarted') : say('dashboard.durationSoFar', formatSpan(visit.ms, say));
    push(`- ${say('trace.when', code(visit.start, 40), visit.end ? code(visit.end, 40) : say('trace.notEnded'), span)}`);
    push(`- ${say('trace.outcome')}: ${say(OUTCOME[visit.outcome] ?? 'trace.outcomeOpen')}${visit.reason ? ` — ${inline(visit.reason, PR_BODY_LIMITS.detail)}` : ''}${visit.waiting ? ` (${say(visit.waiting === 'question' ? 'trace.waitingQuestion' : 'trace.waitingBlocked')})` : ''}`);
    if (visit.cause?.reason) push(`- ${say('trace.cause', inline(visit.cause.reason, PR_BODY_LIMITS.detail))}`);
    if (visit.author || visit.tool) push(`- ${say('trace.by', visit.author ? code(visit.author, 45) : '-', visit.tool ? code(visit.tool) : '-')}`);
    if (visit.endHead || visit.startHead) push(`- ${say('trace.commits', visit.startHead ? short(visit.startHead) : '-', visit.endHead ? short(visit.endHead) : visit.open ? say('trace.now') : '-')}${visit.dirty === true ? ` (${say('prBody.dirty')})` : visit.dirty === false ? ` (${say('prBody.clean')})` : ''}`);
    if (visit.evidence) push(`- ${say('trace.evidence', inline(visit.evidence, PR_BODY_LIMITS.detail))}`);
    if (visit.waiver) push(`- ${say('trace.waiver', inline(visit.waiver, PR_BODY_LIMITS.detail))}`);
    if (visit.warning) push(`- ${say('trace.warning', inline(visit.warning, PR_BODY_LIMITS.detail))}`);
    for (const decision of visit.pm ?? []) push(`- ${say('trace.pm', code(decision.at, 40), inline(decision.kind, 20), say(pmOutcome(decision)), code(decision.by, 45), decision.to ? code(decision.to, 45) : '-', inline(decision.reason, TRACE_LIMITS.note))}`);
    for (const note of visit.notes) push(`- ${say(note.outcome === 'question' ? 'trace.noteQuestion' : 'trace.noteBlocked', code(note.at, 40), inline(note.text, TRACE_LIMITS.note))}`);
    if (visit.proofs.length || visit.missingProofs.length) {
      push('', `### ${say('prBody.verification')}`, '');
      for (const proof of visit.proofs) {
        const label = proof.kind === 'git' ? say('prBody.commitRef', code(proof.commit.slice(0, 12))) : say('prBody.testRef', code(proof.command, 160), proof.exitCode ?? 'null', code(proof.id.slice(0, 8)));
        const result = proof.kind === 'git' ? say('prBody.fileCount', proof.files) : proof.timedOut ? say('prBody.timedOut') : proof.exitCode === 0 ? say('prBody.passed') : say('prBody.failed');
        const changed = !proof.changed ? '' : proof.changed.state === 'changed' ? `, ${say('prBody.changedFiles', proof.changed.count, proof.changed.files.slice(0, PR_BODY_LIMITS.files).map((file) => code(file, 120)).join(', '))}`
          : proof.changed.state === 'unchanged' ? `, ${say('trace.proofFresh')}` : `, ${say('trace.proofUnknown')}`;
        push(`- ${label} — ${result}${proof.linked ? `, ${say('trace.linked')}` : ''}${proof.author ? `, ${say('prBody.by', code(proof.author, 45))}` : ''}${changed}`);
      }
      for (const missing of visit.missingProofs) push(`- ${say('prBody.proofMissing', code(String(missing).slice(0, 8)))}`);
    }
    if (visit.captures?.length) {
      push('', `### ${say('prBody.captures')}`, '');
      for (const capture of visit.captures) { const label = captureLabelText(capture, say); push(`- ${code(capture.check)}${label ? ` ${inline(label, 80)}` : ''} — ${code(capture.artifact, 200)}`); }
    }
    if (visit.compare) push('', `### ${say('prBody.compare')}`, '', ...compareLines(visit.compare, say));
    if (visit.acceptance?.length) {
      push('', `### ${say('prBody.acceptance')}`, '', `| ${say('prBody.acColumn')} | ${say('prBody.statusColumn')} | ${say('prBody.evidenceColumn')} |`, '| --- | --- | --- |');
      for (const item of visit.acceptance) push(`| ${inline(item.id, 20)} | ${say(AC_STATUS[item.status] ?? 'prBody.acPending')} | ${(item.proofIds ?? []).map((proofId) => code(String(proofId).slice(0, 8), 20, true)).join('; ') || '-'}${item.detail ? ` — ${inline(item.detail, PR_BODY_LIMITS.detail)}` : ''} |`);
      if (visit.acWaiver) push('', say('prBody.acWaiver', inline(visit.acWaiver, PR_BODY_LIMITS.detail)));
    }
    if (visit.files) {
      push('', `### ${say('trace.files')}`, '');
      if (visit.files.unknown) push(say('trace.filesUnknown'));
      else if (!visit.files.count) push(say('trace.filesNone', short(visit.files.from), short(visit.files.to)));
      else {
        push(say(visit.files.live ? 'trace.filesLive' : 'trace.filesBetween', short(visit.files.from), short(visit.files.to), visit.files.count));
        for (const file of visit.files.files) push(`- ${code(file.path, 200)}${file.added === null ? ` (${say('trace.binary')})` : ` (+${file.added} −${file.deleted})`}`);
        if (visit.files.count > visit.files.files.length) push(say('prBody.moreFiles', visit.files.count - visit.files.files.length));
      }
    }
  });

  push('', `## ${say('prBody.freshness')}`, '');
  const fresh = trace.freshness;
  if (!fresh) push(say('prBody.freshnessNone'));
  else {
    const basis = say('trace.freshnessBasis', phaseName(fresh.basis.phase, language), code(fresh.basis.at, 40), code(fresh.basis.id.slice(0, 8)));
    push(fresh.state === 'changed' ? `${basis}: ${say('prBody.changedFiles', fresh.count, fresh.files.slice(0, PR_BODY_LIMITS.files).map((file) => code(file, 120)).join(', '))}`
      : fresh.state === 'unchanged' ? `${basis}: ${say('trace.proofFresh')}` : `${basis}: ${say('trace.proofUnknown')}`);
    push('', say('prBody.freshnessNote'));
  }
  push('', '---', say('trace.footer'));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
