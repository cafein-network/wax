import { t } from './messages-catalog.mjs';
import { dateLocale, el } from './dom.mjs';
import { formatDuration } from './dashboard-model.mjs';
const PM_OUTCOME = { executed: 'trace.pmExecuted', dismissed: 'trace.pmDismissed', launched: 'trace.pmLaunched', exited: 'trace.pmExited', timeout: 'trace.pmTimeout', failed: 'trace.pmFailed', stopped: 'trace.pmStopped' };
const JUDGE_OUTCOME = { requested: 'trace.pmRequested', proposed: 'trace.pmProposed', rejected: 'trace.pmRejected', failed: 'trace.judgeFailed', timeout: 'trace.judgeTimeout', stopped: 'trace.judgeStopped' };
const pmOutcome = (decision) => (decision.kind === 'judgment' ? JUDGE_OUTCOME[decision.outcome] : PM_OUTCOME[decision.outcome]) ?? 'trace.pmDismissed';

const OUTCOMES = { complete: 'trace.outcomeComplete', iterate: 'trace.outcomeIterate', moved: 'trace.outcomeMoved', open: 'trace.outcomeOpen', archived: 'trace.outcomeArchived' };
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

function visitItem(visit, index, phaseLabel) {
  const facts = el('dl', { class: 'trace-facts' },
    row(t('dashboard.traceStarted'), stamp(visit.start)),
    row(t('dashboard.traceEnded'), visit.end ? stamp(visit.end) : t('trace.notEnded')),
    row(t('trace.outcome'), t(OUTCOMES[visit.outcome] ?? 'trace.outcomeOpen'), visit.waiting ? ` · ${t(visit.waiting === 'question' ? 'trace.waitingQuestion' : 'trace.waitingBlocked')}` : ''),
    visit.reason ? row(t('dashboard.traceReason'), raw(visit.reason)) : [],
    visit.cause?.reason ? row(t('dashboard.traceCause'), raw(visit.cause.reason)) : [],
    row(t('dashboard.traceSession'), visit.author ? raw(visit.author) : '-'),
    row(t('dashboard.traceTool'), visit.tool ? raw(visit.tool) : '-'),
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
  const files = el('section', {}, el('h4', { text: t('trace.files') }), filesBlock(visit.files));
  return el('li', { class: `trace-visit outcome-${visit.outcome}`, dataset: { phase: visit.phase } },
    el('details', { open: visit.open || undefined },
      el('summary', {},
        el('span', { class: 'trace-step', text: String(index + 1) }),
        el('strong', { text: phaseLabel(visit.phase) }),
        el('span', { class: 'kind', text: ` ${t('trace.iteration', visit.iteration)}` }),
        el('span', { class: 'badge', text: t(OUTCOMES[visit.outcome] ?? 'trace.outcomeOpen') }),
        el('span', { class: 'kind trace-span', text: span(visit) })),
      el('div', { class: 'trace-body' }, facts, notes, pm, proofs, captures, visit.compare ? compareBlock(visit.compare) : null, acceptance, files)));
}

function freshnessLine(freshness, phaseLabel) {
  if (!freshness) return el('p', { class: 'kind', text: t('dashboard.traceFreshnessNone') });
  const state = freshness.state === 'changed' ? t('dashboard.traceProofChanged', freshness.count) : freshness.state === 'unchanged' ? t('trace.proofFresh') : t('trace.proofUnknown');
  return el('div', {},
    el('p', { class: 'kind', text: `${t('trace.freshnessBasis', phaseLabel(freshness.basis.phase), stamp(freshness.basis.at), freshness.basis.id.slice(0, 8))}: ${state}` }),
    freshness.files?.length ? el('div', { class: 'trace-paths' }, freshness.files.map((file) => raw(file, 'code'))) : null);
}

export function traceView(trace, phaseLabel) {
  const request = trace.request ? el('p', { class: 'kind trace-request' }, `${t('dashboard.traceRequest')} `, raw(trace.request.id, 'code'),
    trace.request.tool ? ` · ${t('dashboard.traceTool')} ` : '', trace.request.tool ? raw(trace.request.tool) : '',
    trace.request.origin ? el('span', {}, ` · ${t('dashboard.traceOrigin')} `, raw(Object.values(trace.request.origin).join(', '))) : null) : null;
  const visits = trace.visits.length
    ? el('ol', { class: 'trace-timeline' }, trace.visits.map((visit, index) => visitItem(visit, index, phaseLabel)))
    : el('p', { class: 'empty', text: t('dashboard.traceNoVisits') });
  return {
    summary: t('dashboard.traceSummary', trace.iteration, trace.visits.length, formatDuration(trace.durations?.totalMs ?? 0)),
    body: [request, visits, el('section', { class: 'trace-freshness' }, el('h3', { text: t('prBody.freshness') }), freshnessLine(trace.freshness, phaseLabel))],
  };
}
