import { t } from './messages-catalog.mjs';
import { dateLocale, el } from './dom.mjs';
import { formatDuration } from './dashboard-model.mjs';
import { usageLines } from './usage-text.mjs';
const PM_OUTCOME = { executed: 'trace.pmExecuted', dismissed: 'trace.pmDismissed', launched: 'trace.pmLaunched', exited: 'trace.pmExited', timeout: 'trace.pmTimeout', failed: 'trace.pmFailed', stopped: 'trace.pmStopped', stuck: 'trace.pmStuck', warned: 'trace.pmRepeatWarned', restored: 'trace.pmRestored' };
const JUDGE_OUTCOME = { requested: 'trace.pmRequested', proposed: 'trace.pmProposed', rejected: 'trace.pmRejected', failed: 'trace.judgeFailed', timeout: 'trace.judgeTimeout', stopped: 'trace.judgeStopped' };
const pmOutcome = (decision) => (decision.kind === 'judgment' ? JUDGE_OUTCOME[decision.outcome] : PM_OUTCOME[decision.outcome]) ?? 'trace.pmDismissed';

const OUTCOMES = { complete: 'trace.outcomeComplete', iterate: 'trace.outcomeIterate', moved: 'trace.outcomeMoved', open: 'trace.outcomeOpen', archived: 'trace.outcomeArchived' };
const DEFECT = { resolved: 'qualityReport.defectResolved', open: 'qualityReport.defectOpen', pending: 'qualityReport.pending' };
const AC = { pass: 'prBody.acPass', fail: 'prBody.acFail', unverified: 'prBody.acUnverified', pending: 'prBody.acPending' };
const short = (value) => String(value ?? '').slice(0, 12);
const stamp = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};
const raw = (text, tag = 'span') => el(tag, { translate: 'no', text });
const row = (label, ...value) => [el('dt', { text: label }), el('dd', {}, ...value)];

function span(visit) {
  if (!visit.open || visit.outcome === 'archived') return formatDuration(visit.ms);
  return visit.ms < 60_000 ? t('dashboard.durationJustStarted') : t('dashboard.durationSoFar', formatDuration(visit.ms));
}

function proofItem(proof) {
  const label = proof.kind === 'git' ? t('prBody.commitRef', short(proof.commit)) : null;
  const result = proof.kind === 'git' ? t('prBody.fileCount', proof.files) : proof.timedOut ? t('prBody.timedOut') : proof.exitCode === 0 ? t('prBody.passed') : t('prBody.failed');
  const changed = proof.changed?.state === 'changed' ? t('dashboard.traceProofChanged', proof.changed.count)
    : proof.changed?.state === 'unchanged' ? t('trace.proofFresh') : proof.changed ? t('trace.proofUnknown') : null;
  const passed = proof.kind === 'git' || (proof.exitCode === 0 && !proof.timedOut);
  return el('li', { class: `trace-proof ${passed ? 'proof-pass' : 'proof-fail'}` },
    label ? el('code', { translate: 'no', text: label }) : el('code', { translate: 'no', text: proof.command }),
    el('span', { class: 'kind' }, ` · ${result}`, proof.linked ? ` · ${t('trace.linked')}` : '', changed ? ` · ${changed}` : ''),
    proof.changed?.files?.length ? el('div', { class: 'trace-paths' }, proof.changed.files.map((file) => raw(file, 'code'))) : null);
}

function filesBlock(files) {
  if (!files) return el('p', { class: 'kind', text: t('dashboard.traceFilesMissing') });
  if (files.unknown) return el('p', { class: 'kind', text: t('dashboard.traceFilesUnknown') });
  if (!files.count) return el('p', { class: 'kind', text: t('dashboard.traceFilesNone', short(files.from), short(files.to)) });
  return el('div', {},
    el('p', { class: 'kind', text: t(files.live ? 'dashboard.traceFilesLive' : 'dashboard.traceFilesBetween', files.count, short(files.from), short(files.to)) }),
    el('ul', { class: 'trace-files' }, files.files.map((file) => el('li', {}, raw(file.path, 'code'),
      el('span', { class: 'kind', text: file.added === null ? ` ${t('trace.binary')}` : ` +${file.added} −${file.deleted}` })))),
    files.count > files.files.length ? el('p', { class: 'kind', text: t('prBody.moreFiles', files.count - files.files.length) }) : null);
}

const RUN_STATE = { new: 'trace.runState.new', delete: 'trace.runState.delete', modify: 'trace.runState.modify' };
const SKIP_REASON = { changed: 'trace.skip.changed', outside: 'trace.skip.outside', sensitive: 'trace.skip.sensitive', symlink: 'trace.skip.symlink', notFile: 'trace.skip.notFile',
  tooLarge: 'trace.skip.tooLarge', unreadable: 'trace.skip.unreadable' };
const NONE_REASON = { binary: 'trace.binary', tooLarge: 'trace.runTooLarge', link: 'trace.skip.symlink' };
const LINE_CLASS = { '+': 'd-add', '-': 'd-del', '@': 'd-hunk', ' ': 'd-ctx' };
const LINE_MARK = { '+': '+', '-': '-', '@': '', ' ': ' ' };
const runState = { diffs: new Map(), open: new Set(), previews: new Map(), results: new Map(), busy: new Set() };
let rerender = () => {};
const counts = (file) => (file.added === null || file.added === undefined ? t(NONE_REASON[file.none] ?? 'trace.runTooLarge') : `+${file.added} −${file.removed}`);

function diffBox(data) {
  if (!data) return el('p', { class: 'kind', text: t('trace.diffLoading') });
  if (data.error) return el('p', { class: 'error', text: data.error });
  if (data.none) return el('p', { class: 'kind', text: t(NONE_REASON[data.none] ?? 'trace.runTooLarge') });
  return el('div', {},
    el('pre', { class: 'approval-diff trace-run-diff', translate: 'no', tabindex: '0' }, ...(data.lines ?? []).map(([type, text]) => el('span', { class: LINE_CLASS[type] ?? 'd-ctx', text: `${LINE_MARK[type] ?? ' '}${text}\n` }))),
    data.omitted ? el('p', { class: 'kind', text: t('approvals.preview.omitted', data.omitted) }) : null);
}

function runFile(run, file, actions) {
  const key = `${run.run}|${file.path}`, opened = runState.open.has(key);
  const toggle = async () => {
    if (runState.open.has(key)) { runState.open.delete(key); rerender(); return; }
    runState.open.add(key); rerender();
    if (runState.diffs.has(key) && !runState.diffs.get(key).error) return;
    try { runState.diffs.set(key, await actions.diff(run.run, file.path)); } catch (error) { runState.diffs.set(key, { error: error.message }); }
    rerender();
  };
  return el('li', { class: `trace-run-file state-${file.state}`, dataset: { path: file.path } },
    el('button', { type: 'button', class: 'link trace-run-toggle', 'aria-expanded': opened ? 'true' : 'false', onclick: actions ? toggle : null, disabled: actions ? undefined : true },
      raw(file.path, 'code')),
    ' ', el('span', { class: 'badge', text: t(RUN_STATE[file.state] ?? 'trace.runState.modify') }), ' ', el('span', { class: 'kind', translate: 'no', text: counts(file) }),
    opened ? diffBox(runState.diffs.get(key)) : null);
}

function previewBlock(run, preview, actions) {
  const busy = runState.busy.has(run.run);
  const cancel = () => { runState.previews.delete(run.run); rerender(); };
  const confirm = async () => {
    runState.busy.add(run.run); rerender();
    try {
      const result = await actions.restore(run.run, preview.fingerprint);
      runState.previews.delete(run.run); runState.results.set(run.run, result); runState.diffs.clear(); runState.open.clear();
    } catch (error) { runState.previews.set(run.run, { ...preview, error: error.message }); }
    runState.busy.delete(run.run);
    rerender(); actions.reload();
  };
  return el('div', { class: 'trace-restore-preview', role: 'group', 'aria-label': t('trace.restorePreview') },
    el('p', { class: 'trace-restore-summary', text: t('trace.restoreSummary', preview.restore.length, preview.skip.length) }),
    preview.busy ? el('p', { class: 'error', text: t('trace.restoreBusy', preview.busy) }) : null,
    preview.commits ? el('p', { class: 'kind', text: t('trace.restoreCommits', preview.commits) }) : null,
    preview.concurrent ? el('p', { class: 'kind', text: t('trace.runConcurrent', preview.concurrent) }) : null,
    el('h5', { text: t('trace.restoreWill') }),
    preview.restore.length ? el('ul', { class: 'trace-restore-list restore-write' }, preview.restore.map((item) => el('li', { dataset: { path: item.path } }, raw(item.path, 'code'), ' ',
      el('span', { class: 'badge', text: t(item.action === 'delete' ? 'trace.restoreDelete' : 'trace.restoreWrite') }), ' ', el('span', { class: 'kind', translate: 'no', text: counts(item) }))))
      : el('p', { class: 'kind', text: t('trace.restoreNothing') }),
    el('h5', { text: t('trace.restoreLeft') }),
    preview.skip.length ? el('ul', { class: 'trace-restore-list restore-skip' }, preview.skip.map((item) => el('li', { dataset: { path: item.path, reason: item.reason } }, raw(item.path, 'code'), ' ',
      el('span', { class: 'kind', text: t(SKIP_REASON[item.reason] ?? 'trace.skip.changed') }))))
      : el('p', { class: 'kind', text: t('trace.restoreNoneLeft') }),
    el('p', { class: 'kind', text: t('trace.restoreIgnored') }),
    el('p', { class: 'kind', text: t('trace.restorePrivate') }),
    preview.error ? el('p', { class: 'error', role: 'alert', text: preview.error }) : null,
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary trace-restore-confirm', onclick: confirm, disabled: busy || !preview.restore.length || preview.busy ? true : undefined }, t('trace.restoreConfirm')),
      el('button', { type: 'button', class: 'trace-restore-cancel', onclick: cancel, disabled: busy || undefined }, t('dashboard.cancel'))));
}

function resultBlock(result) {
  return el('div', { class: 'trace-restore-result', role: 'status' },
    el('p', { text: t('trace.restoreDone', result.restored.length, result.skipped.length) }),
    result.failed?.length ? el('p', { class: 'error', text: t('trace.restoreFailed', result.failed.length) }) : null,
    el('p', { class: 'kind' }, t('trace.restoreUndo'), ' ', raw(result.restoreRun, 'code')));
}

function runBlock(run, actions) {
  const restore = run.kind === 'restore', imported = run.kind === 'import';
  const heading = el('h4', {}, t(restore ? 'trace.restoreRunTitle' : imported ? 'trace.importRunTitle' : 'trace.runFilesTitle'), ' ', raw(run.run, 'code'));
  const parts = [heading];
  if (restore) parts.push(el('p', { class: 'kind' }, t('trace.restoreRunOf'), ' ', raw(run.target ?? '-', 'code'), ' · ', raw(run.by ?? '-')));
  if (imported) parts.push(el('p', { class: 'kind' }, t('trace.importRunOf'), ' ', raw(run.target ?? '-', 'code'), ' · ', raw(run.by ?? '-')));
  const note = { missing: 'trace.runMissing', omitted: 'trace.runOmitted', running: 'trace.runRunning' }[run.state];
  if (note) parts.push(el('p', { class: 'kind', text: t(note) }));
  else if (run.state === 'unknown') parts.push(el('p', { class: 'kind', text: t('trace.runUnknown', run.reason ?? '-') }));
  else {
    if (run.concurrent) parts.push(el('p', { class: 'kind trace-run-concurrent', text: t('trace.runConcurrent', run.concurrent) }));
    if (run.commits) parts.push(el('p', { class: 'kind', text: t('trace.runCommits', run.commits) }));
    parts.push(run.files.length ? el('ul', { class: 'trace-files trace-run-files' }, run.files.map((file) => runFile(run, file, actions))) : el('p', { class: 'kind', text: t('trace.runNone') }));
    if (run.more) parts.push(el('p', { class: 'kind', text: t('prBody.moreFiles', run.more) }));
    const preview = runState.previews.get(run.run), result = runState.results.get(run.run);
    if (result) parts.push(resultBlock(result));
    if (actions && run.count && !preview) {
      const open = async () => {
        runState.busy.add(run.run); runState.results.delete(run.run); rerender();
        try { runState.previews.set(run.run, await actions.preview(run.run)); } catch (error) { runState.previews.set(run.run, { error: error.message, restore: [], skip: [] }); }
        runState.busy.delete(run.run); rerender();
      };
      parts.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'trace-restore-open', onclick: open, disabled: runState.busy.has(run.run) || undefined },
        t(restore ? 'trace.restoreUndoButton' : imported ? 'trace.importUndoButton' : 'trace.restoreButton'))));
    }
    if (preview) parts.push(previewBlock(run, preview, actions));
  }
  return el('section', { class: `trace-run run-${run.kind} run-state-${run.state}`, dataset: { run: run.run } }, ...parts);
}

const labelNodes = (item) => el('span', { class: 'compare-label' }, [item.viewport ? raw(item.viewport) : null, item.scroll !== undefined ? el('span', { text: t('capture.scroll', item.scroll) }) : null, item.state ? raw(item.state) : null]
  .filter(Boolean).flatMap((node, index) => (index ? [' · ', node] : [node])));
function diffLabel(diff) {
  if (!diff) return '';
  if (diff.state === 'compared') return t('compare.ratio', (diff.ratio * 100).toFixed(2), diff.size);
  if (diff.state === 'size') return t('compare.sizeDiffers', diff.baseline, diff.review);
  return t(diff.reason === 'large' ? 'compare.skippedLarge' : diff.reason === 'missing' ? 'compare.skippedMissing' : 'compare.skippedFormat');
}
function thumb(artifact, caption) {
  const [, , id, folder, name] = String(artifact).split('/');
  const image = name && /\.(?:png|jpe?g|webp|gif)$/i.test(name);
  return el('figure', { class: 'compare-shot' },
    image ? el('img', { src: `/api/features/${encodeURIComponent(id)}/captures/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`, alt: caption, loading: 'lazy' }) : null,
    el('figcaption', {}, el('span', { text: caption }), ' ', raw(artifact, 'code')));
}
function compareBlock(compare) {
  const unpaired = [...compare.missingBaseline.map((item) => [t('compare.noBaselineLabel'), item]), ...compare.notRecaptured.map((item) => [t('compare.notRecapturedLabel'), item])];
  return el('section', { class: 'trace-compare' }, el('h4', { text: t('prBody.compare') }),
    el('p', { class: 'kind', text: t('compare.summary', compare.counts.pairs, compare.counts.missingBaseline, compare.counts.notRecaptured) }),
    el('ul', { class: 'compare-pairs' }, compare.pairs.map((pair) => el('li', { class: `compare-pair diff-${pair.diff?.state ?? 'none'}` },
      el('div', {}, el('strong', {}, labelNodes(pair)), pair.diff ? el('span', { class: 'kind compare-ratio' }, ' · ', diffLabel(pair.diff)) : null),
      el('div', { class: 'compare-shots' }, thumb(pair.baseline.artifact, t('compare.baseline')), thumb(pair.review.artifact, t('compare.implementation')))))),
    unpaired.length ? el('ul', { class: 'compare-unpaired' }, unpaired.map(([text, item]) => el('li', {}, el('span', { class: 'badge', text }), ' ', labelNodes(item), el('div', { class: 'trace-paths' }, raw(item.artifact, 'code'))))) : null,
    compare.unlabeled.baseline || compare.unlabeled.review ? el('p', { class: 'kind', text: t('compare.unlabeled', compare.unlabeled.baseline, compare.unlabeled.review) }) : null,
    el('p', { class: 'kind', text: t('compare.observation') }));
}

function visitItem(visit, index, phaseLabel, actions) {
  const facts = el('dl', { class: 'trace-facts' },
    row(t('dashboard.traceStarted'), stamp(visit.start)),
    row(t('dashboard.traceEnded'), visit.end ? stamp(visit.end) : t('trace.notEnded')),
    row(t('trace.outcome'), t(OUTCOMES[visit.outcome] ?? 'trace.outcomeOpen'), visit.waiting ? ` · ${t(visit.waiting === 'question' ? 'trace.waitingQuestion' : 'trace.waitingBlocked')}` : ''),
    visit.reason ? row(t('dashboard.traceReason'), raw(visit.reason)) : [],
    visit.cause?.reason ? row(t('dashboard.traceCause'), raw(visit.cause.reason)) : [],
    row(t('dashboard.traceSession'), visit.author ? raw(visit.author) : '-'),
    row(t('dashboard.traceTool'), visit.tool ? raw(visit.tool) : '-'),
    visit.manuals?.length ? row(t('manual.title'), el('span', { class: 'trace-manual', translate: 'no', text: visit.manuals.join(', ') })) : [],
    visit.usage ? row(t('usage.heading'), el('span', { class: 'trace-usage' }, ...usageLines(visit.usage).flatMap((line, i) => (i ? [el('br'), line] : [line])))) : [],
    row(t('dashboard.traceCommits'), visit.startHead || visit.endHead
      ? el('span', {}, raw(visit.startHead ? short(visit.startHead) : '-', 'code'), ' → ', visit.endHead ? raw(short(visit.endHead), 'code') : visit.open ? t('trace.now') : '-',
        visit.dirty === true ? ` · ${t('prBody.dirty')}` : visit.dirty === false ? ` · ${t('prBody.clean')}` : '')
      : '-'),
    visit.evidence ? row(t('dashboard.traceEvidence'), raw(visit.evidence)) : [],
    visit.waiver ? row(t('dashboard.traceWaiver'), raw(visit.waiver)) : [],
    visit.warning ? row(t('dashboard.traceWarning'), raw(visit.warning)) : []);
  const notes = visit.notes?.length ? el('ul', { class: 'trace-notes' }, visit.notes.map((note) => el('li', {},
    el('span', { class: `badge type-${note.outcome === 'question' ? 'question' : 'blocked'}`, text: note.outcome === 'question' ? t('dashboard.question') : t('dashboard.blocked') }),
    ' ', el('span', { class: 'kind', text: stamp(note.at) }), ' ', raw(note.text)))) : null;
  const pm = visit.pm?.length ? el('ul', { class: 'trace-notes trace-pm' }, visit.pm.map((decision) => el('li', {},
    el('span', { class: 'badge', text: t('dashboard.tracePm') }), ' ', el('span', { class: 'kind', text: stamp(decision.at) }), ' ',
    t(pmOutcome(decision)), ' · ', raw(decision.kind), ' · ', raw(decision.by), decision.to ? [' → ', raw(decision.to)] : '', ' · ', decision.reason))) : null;
  const proofs = visit.proofs.length ? el('section', {}, el('h4', { text: t('dashboard.evidence') }), el('ul', { class: 'trace-proofs' }, visit.proofs.map(proofItem))) : null;
  const captures = visit.captures?.length ? el('section', {}, el('h4', { text: t('prBody.captures') }),
    el('ul', { class: 'trace-captures' }, visit.captures.map((capture) => el('li', {}, raw(capture.check, 'code'),
      el('span', { class: 'kind', text: ` ${[capture.viewport, capture.scroll !== undefined ? t('capture.scroll', capture.scroll) : '', capture.state].filter(Boolean).join(' · ')}` }),
      el('div', { class: 'trace-paths' }, raw(capture.artifact, 'code')))))) : null;
  const acceptance = visit.acceptance?.length ? el('section', {}, el('h4', { text: t('prBody.acceptance') }),
    el('ul', { class: 'trace-ac' }, visit.acceptance.map((item) => el('li', { class: `ac-${item.status}` },
      el('strong', { translate: 'no', text: item.id }), ' ', el('span', { class: 'badge', text: t(AC[item.status] ?? 'prBody.acPending') }),
      item.detail ? el('div', { class: 'kind', translate: 'no', text: item.detail }) : null))),
    visit.acWaiver ? el('p', { class: 'kind' }, `${t('dashboard.traceAcWaiver')} `, raw(visit.acWaiver)) : null) : null;
  const defects = visit.defects?.length ? el('section', {}, el('h4', { text: t('trace.defects') }),
    el('ul', { class: 'trace-ac' }, visit.defects.map((item) => el('li', { class: `ac-${item.status === 'resolved' ? 'pass' : item.status === 'open' ? 'unverified' : 'pending'}` },
      el('strong', { translate: 'no', text: item.id }), item.title ? [' ', raw(item.title)] : '', ' ', el('span', { class: 'badge', text: t(DEFECT[item.status] ?? 'qualityReport.pending') }),
      item.detail ? el('div', { class: 'kind', translate: 'no', text: item.detail }) : null))),
    visit.defectWaiver ? el('p', { class: 'kind' }, `${t('dashboard.traceDefectWaiver')} `, raw(visit.defectWaiver)) : null) : null;
  const logged = visit.loggedDefects?.length ? el('section', {}, el('h4', { text: t('trace.loggedDefects') }),
    el('ul', { class: 'trace-ac' }, visit.loggedDefects.map((item) => el('li', { class: 'ac-fail' }, el('strong', { translate: 'no', text: item.id }), item.title ? [' ', raw(item.title)] : '')))) : null;
  const files = el('section', {}, el('h4', { text: t('trace.files') }), filesBlock(visit.files));
  const runs = visit.runs?.length ? el('div', { class: 'trace-runs' }, visit.runs.map((run) => runBlock(run, actions))) : null;
  return el('li', { class: `trace-visit outcome-${visit.outcome}`, dataset: { phase: visit.phase } },
    el('details', { open: visit.open || undefined },
      el('summary', {},
        el('span', { class: 'trace-step', text: String(index + 1) }),
        el('strong', { text: phaseLabel(visit.phase) }),
        el('span', { class: 'kind', text: ` ${t('trace.iteration', visit.iteration)}` }),
        el('span', { class: 'badge', text: t(OUTCOMES[visit.outcome] ?? 'trace.outcomeOpen') }),
        el('span', { class: 'kind trace-span', text: span(visit) })),
      el('div', { class: 'trace-body' }, facts, notes, pm, proofs, captures, visit.compare ? compareBlock(visit.compare) : null, acceptance, defects, logged, files, runs)));
}

function freshnessLine(freshness, phaseLabel) {
  if (!freshness) return el('p', { class: 'kind', text: t('dashboard.traceFreshnessNone') });
  const state = freshness.state === 'changed' ? t('dashboard.traceProofChanged', freshness.count) : freshness.state === 'unchanged' ? t('trace.proofFresh') : t('trace.proofUnknown');
  return el('div', {},
    el('p', { class: 'kind', text: `${t('trace.freshnessBasis', phaseLabel(freshness.basis.phase), stamp(freshness.basis.at), freshness.basis.id.slice(0, 8))}: ${state}` }),
    freshness.files?.length ? el('div', { class: 'trace-paths' }, freshness.files.map((file) => raw(file, 'code'))) : null);
}

export function traceView(trace, phaseLabel, actions = null) {
  rerender = actions?.render ?? (() => {});
  const request = trace.request ? el('p', { class: 'kind trace-request' }, `${t('dashboard.traceRequest')} `, raw(trace.request.id, 'code'),
    trace.request.tool ? ` · ${t('dashboard.traceTool')} ` : '', trace.request.tool ? raw(trace.request.tool) : '',
    trace.request.origin ? el('span', {}, ` · ${t('dashboard.traceOrigin')} `, raw(Object.values(trace.request.origin).join(', '))) : null) : null;
  const recipes = trace.recipes?.length ? trace.recipes.map((recipe) => el('p', { class: 'kind trace-recipe', dataset: { recipe: recipe.id } }, `${t('trace.recipeLabel')} `,
    recipe.source === 'builtin' ? el('strong', { text: recipe.title }) : raw(recipe.title, 'strong'), ' · ', raw(recipe.goal, 'code'))) : [];
  const allows = (trace.goalAllows ?? []).map((item) => el('p', { class: 'kind trace-goal-allow', dataset: { goal: item.goal } }, t('trace.goalAllow', item.total), ' (',
    raw(Object.entries(item.kinds).map(([kind, n]) => `${kind} ${n}`).join(', ')), ') · ', raw(item.goal, 'code')));
  const visits = trace.visits.length
    ? el('ol', { class: 'trace-timeline' }, trace.visits.map((visit, index) => visitItem(visit, index, phaseLabel, actions)))
    : el('p', { class: 'empty', text: t('dashboard.traceNoVisits') });
  return {
    summary: t('dashboard.traceSummary', trace.iteration, trace.visits.length, formatDuration(trace.durations?.totalMs ?? 0)),
    body: [request, ...recipes, ...allows, visits, el('section', { class: 'trace-freshness' }, el('h3', { text: t('prBody.freshness') }), freshnessLine(trace.freshness, phaseLabel))],
  };
}
