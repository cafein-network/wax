import { t } from './messages-catalog.mjs';
import { api, el, clear, dateLocale } from './dom.mjs';
import { openEvents } from './events.mjs';
import { allowKindLabel } from './goal-allow.mjs';
import { phaseName } from './thread-model.mjs';

const openPreviews = new Set();
const PREVIEW_STATES = { new: 'approvals.preview.state.new', modify: 'approvals.preview.state.modify', patch: 'approvals.preview.state.patch', delete: 'approvals.preview.state.delete' };
const LINE_CLASS = { '+': 'd-add', '-': 'd-del', '@': 'd-hunk', ' ': 'd-ctx' };
const LINE_MARK = { '+': '+', '-': '-', '@': '', ' ': ' ' };
const PREVIEW_REASONS = {
  outside: () => t('approvals.preview.reason.outside'), symlink: () => t('approvals.preview.reason.symlink'), sensitive: () => t('approvals.preview.reason.sensitive'),
  binary: () => t('approvals.preview.reason.binary'), tooLarge: () => t('approvals.preview.reason.tooLarge'), notFile: () => t('approvals.preview.reason.notFile'),
  unreadable: () => t('approvals.preview.reason.unreadable'), missing: () => t('approvals.preview.reason.missing'),
  notFound: (file) => t('approvals.preview.reason.notFound', file.edit ?? 1), ambiguous: (file) => t('approvals.preview.reason.ambiguous', file.edit ?? 1, file.count ?? 2),
  emptyOld: (file) => t('approvals.preview.reason.emptyOld', file.edit ?? 1), unsupported: () => t('approvals.preview.reason.unsupported'),
};
const reasonText = (file) => (Object.hasOwn(PREVIEW_REASONS, file.none) ? PREVIEW_REASONS[file.none](file) : t('approvals.preview.reason.invalid'));
function previewFile(file) {
  const path = el('code', { translate: 'no', text: file.path ?? '?' });
  if (file.none) {
    return [el('p', { class: 'approval-preview-file', dataset: { none: file.none } }, path, ' ',
      el('span', { class: 'approval-preview-none' }, el('span', { text: t('approvals.preview.none') }), ' ', el('span', { text: reasonText(file) })))];
  }
  const head = el('p', { class: 'approval-preview-file' }, path, ' ',
    el('span', { class: 'badge', text: t(PREVIEW_STATES[file.state] ?? PREVIEW_STATES.patch) }), ' ',
    el('span', { class: 'approval-preview-counts', translate: 'no' }, el('span', { class: 'd-add-count', text: `+${file.added}` }), ' ', el('span', { class: 'd-del-count', text: `−${file.removed}` })),
    file.move ? [' ', el('span', { text: t('approvals.preview.move') }), ' ', el('code', { translate: 'no', text: file.move })] : null);
  const box = el('pre', { class: 'approval-diff', translate: 'no', tabindex: '0' },
    ...(file.lines ?? []).map(([type, text]) => el('span', { class: LINE_CLASS[type] ?? 'd-ctx', text: `${LINE_MARK[type] ?? ' '}${text}\n` })));
  return [head, box, file.omitted ? el('p', { class: 'kind', text: t('approvals.preview.omitted', file.omitted) }) : null];
}
export function previewView(request) {
  const preview = request.preview;
  if (!preview || !Array.isArray(preview.files)) return null;
  const shown = preview.files.filter((file) => !file.none);
  const added = shown.reduce((sum, file) => sum + (file.added || 0), 0), removed = shown.reduce((sum, file) => sum + (file.removed || 0), 0);
  const summary = shown.length ? t('approvals.preview.summary', preview.files.length, added, removed) : t('approvals.preview.summaryNone', preview.files.length);
  return el('details', { class: 'approval-preview', open: openPreviews.has(request.id), dataset: { added: String(added), removed: String(removed) },
    ontoggle: (event) => { if (event.target.open) openPreviews.add(request.id); else openPreviews.delete(request.id); } },
    el('summary', { text: summary }),
    ...preview.files.flatMap(previewFile),
    preview.more ? el('p', { class: 'kind', text: t('approvals.preview.more', preview.more) }) : null,
    el('p', { class: 'kind', text: t('approvals.preview.computedAt', new Date(preview.computedAt).toLocaleTimeString(dateLocale())) }));
}

export const DENY_REASON_LIMIT = 500;
const denyDrafts = new Map(), openReasons = new Set();
const reasonDelivered = (tool) => tool === 'claude';
function denyReasonField(request, disabled) {
  const input = el('textarea', { class: 'approval-deny-input', rows: '2', maxlength: String(DENY_REASON_LIMIT), disabled, translate: 'no',
    'aria-label': t('approvals.denyReason.label'), placeholder: t('approvals.denyReason.placeholder'),
    oninput: (event) => { if (event.target.value) denyDrafts.set(request.id, event.target.value); else denyDrafts.delete(request.id); } });
  input.value = denyDrafts.get(request.id) ?? '';
  return el('details', { class: 'approval-deny-reason', open: openReasons.has(request.id),
    ontoggle: (event) => { if (event.target.open) openReasons.add(request.id); else openReasons.delete(request.id); } },
    el('summary', { text: t('approvals.denyReason.toggle') }), input,
    el('p', { class: 'kind approval-deny-note', dataset: { delivered: String(reasonDelivered(request.tool)) },
      text: reasonDelivered(request.tool) ? t('approvals.denyReason.sent', DENY_REASON_LIMIT) : t('approvals.denyReason.recordOnly') }));
}
const denyReasonShown = (request) => (request.decision === 'deny' && request.denyReason
  ? el('p', { class: 'approval-deny-reason-shown', dataset: { sent: String(request.denyReasonSent === true) } },
    el('span', { text: t('approvals.denyReason.label') }), ': ', el('q', { translate: 'no', text: request.denyReason }),
    request.denyReasonSent ? null : [' ', el('span', { class: 'kind', text: t('approvals.denyReason.recordOnly') })])
  : null);
export function keepReasonFocus(scope, draw) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const id = active?.classList?.contains('approval-deny-input') && scope.contains(active) ? active.closest('.approval-card')?.dataset.request : null;
  const range = id ? [active.selectionStart, active.selectionEnd] : null;
  draw();
  if (!id) return;
  const next = [...scope.querySelectorAll('.approval-card')].find((card) => card.dataset.request === id)?.querySelector('.approval-deny-input');
  if (next && !next.disabled) { next.focus(); next.setSelectionRange(...range); }
}
const denyWithReason = (request, decide) => {
  const reason = (denyDrafts.get(request.id) ?? '').trim();
  return decide(request, 'deny', reason ? { denyReason: reason } : {});
};
export const forgetDenyReason = (id) => { denyDrafts.delete(id); openReasons.delete(id); };

const repeatBadge = (request) => (request.repeatNote ? el('span', { class: 'badge approval-repeat-badge', text: t('approvals.repeat.nth', request.repeat) }) : null);
function repeatView(request) {
  const note = request.repeatNote;
  if (!note) return null;
  const previous = note.previous;
  const line = !previous?.decision ? t('approvals.repeat.previousNone')
    : t(previous.decision === 'allow' ? 'approvals.repeat.previousAllow' : 'approvals.repeat.previousDeny', previous.decidedBy ?? '-');
  return el('div', { class: 'approval-repeat', role: 'note', dataset: { repeat: String(request.repeat), threshold: String(note.threshold) } },
    el('p', { class: 'kind', text: t('approvals.repeat.hint', request.repeat) }), el('p', { class: 'kind approval-repeat-previous', text: line }));
}

const LABELS = { pending: t('approvals.awaitingApproval'), decided: t('approvals.awaitingResponseDelivery'), dispatching: t('approvals.deliveringResponse'), delivered: t('approvals.responseDeliveredToThe'), expired: t('approvals.waitExpired'), cancelled: t('approvals.requestClosed') };
export function approvalCard(request, decide, { disabled = false } = {}) {
  const pending = request.status === 'pending' && Date.now() < request.expiresAt;
  return el('article', { class: 'approval-card', dataset: { request: request.id } },
    el('header', {}, el('strong', { text: `${({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI', antigravity: 'Antigravity CLI', grok: 'Grok Build' })[request.tool] || request.tool} · ${request.action}` }),
      repeatBadge(request), el('span', { class: 'badge', text: LABELS[request.status] ?? t('approvals.statusCheckNeeded') })),
    el('p', { class: 'kind', text: t('approvals.sessionRequest', request.session, request.callId) }),
    el('p', { class: 'kind', text: t('approvals.projectExpires', request.project, new Date(request.expiresAt).toLocaleTimeString()) }),
    request.goal ? el('p', { class: 'kind approval-goal', dataset: { goal: request.goal } }, el('span', { translate: 'no', text: t('goalAllow.approvalGoal', request.goal) }),
      request.goalAllow?.on ? el('span', {}, ' · ', t('goalAllow.approvalOn', request.goalAllow.kinds.map(allowKindLabel).join(', '))) : null) : null,
    request.outOfStage ? el('p', { class: 'approval-out-of-stage', role: 'note' }, t('approvals.outOfStage', phaseName(request.outOfStage.phase)), ' ',
      el('code', { translate: 'no', text: request.outOfStage.paths.join(', ') })) : null,
    request.workerForbidden ? el('p', { class: 'approval-worker-forbidden', role: 'note' }, t('approvals.workerForbidden'), ' ',
      el('code', { translate: 'no', text: request.workerForbidden.command })) : null,
    repeatView(request),
    previewView(request),
    el('pre', { class: 'approval-details', text: JSON.stringify(request.details, null, 2) }),
    pending ? el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', disabled, text: t('approvals.allowThisTimeOnly'), onclick: () => decide(request, 'allow') }),
      request.goalAllowOffer ? el('button', { type: 'button', class: 'approval-goal-allow', disabled, dataset: { kind: request.goalAllowOffer.kind },
        text: t('goalAllow.allowAndKeep', allowKindLabel(request.goalAllowOffer.kind)), onclick: () => decide(request, 'allow', { goalAllow: true }) }) : null,
      el('button', { type: 'button', class: 'approval-deny', disabled, text: t('approvals.deny'), onclick: () => denyWithReason(request, decide) })) : null,
    pending ? denyReasonField(request, disabled) :
      request.allowKind ? el('p', { class: 'approval-auto', text: t('goalAllow.approvalAuto', allowKindLabel(request.allowKind), request.decidedBy) }) :
      el('p', { text: `${request.decision === 'allow' ? '이번 요청 허용' : request.decision === 'deny' ? '요청 거부' : '승인되지 않음'}${request.decidedBy ? ` · ${request.decidedBy}` : ''}${request.reason ? ` · ${request.reason}` : ''}` }),
    pending ? null : denyReasonShown(request),
    request.status === 'delivered' ? el('p', { class: 'kind', text: t('approvals.checkTheToolsOwn') }) : null);
}

export function mountApprovals(container) {
  let token, items = [], online = false, stopped = false, source, timer, loading = null, again = false, signature = '', generation = 0, responseError = '';
  const busy = new Set();
  const title = el('h2', { text: t('approvals.executionApproval') });
  const state = el('p', { class: 'kind', role: 'status', text: t('approvals.checkingApprovalRequests') });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const list = el('div', { class: 'approval-list' });
  const history = el('details', {}, el('summary', { text: t('approvals.recentApprovalRecords') }));
  const historyList = el('div'); history.append(historyList);
  const autoSummary = el('summary', {});
  const autoList = el('div');
  const autoHistory = el('details', { class: 'approval-goal-allowed', hidden: true }, autoSummary, autoList);
  const refreshButton = el('button', { type: 'button', text: t('approvals.refresh'), onclick: () => refresh() });
  container.append(el('header', { class: 'row' }, title, refreshButton), state,
    el('p', { class: 'kind', text: t('approvals.onlyRequestsSentBy') }), errorBox, list, autoHistory, history);

  const render = () => {
    const active = items.filter((r) => ['pending', 'decided', 'dispatching'].includes(r.status));
    state.textContent = online ? t('approvals.waitingAnApprovalResponse', active.filter((r) => r.status === 'pending').length) : t('approvals.connectionCheckNeededYou');
    const nextSignature = JSON.stringify([items, online, [...busy], items.map((r) => Date.now() >= r.expiresAt)]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    keepReasonFocus(list, () => clear(list).append(...(active.length ? active.map((r) => approvalCard(r, decide, { disabled: !online || busy.has(r.id) })) : [el('p', { class: 'empty', text: t('approvals.noApprovalRequestsAre') })])));
    const finished = items.filter((r) => !active.includes(r));
    const auto = finished.filter((r) => r.allowKind);
    autoHistory.hidden = !auto.length;
    autoSummary.textContent = t('goalAllow.usedLine', auto.length);
    clear(autoList).append(...auto.map((r) => approvalCard(r, decide, { disabled: true })));
    clear(historyList).append(...finished.filter((r) => !r.allowKind).map((r) => approvalCard(r, decide, { disabled: true })));
  };
  async function decide(request, decision, extra = {}) {
    if (!online || busy.has(request.id)) return;
    busy.add(request.id); render(); responseError = ''; errorBox.hidden = true;
    try {
      await api(`/api/approvals/${request.id}/decision`, { method: 'POST', token, body: { decision, fingerprint: request.fingerprint, ...(extra.goalAllow ? { goalAllow: true } : {}),
        ...(decision === 'deny' && extra.denyReason ? { denyReason: extra.denyReason } : {}) } });
      forgetDenyReason(request.id);
      await refresh();
    } catch (error) { responseError = t('approvals.couldntConfirmTheResponse', error.message); await refresh(); }
    finally { busy.delete(request.id); render(); }
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    if (loading) { again = true; return loading; }
    const currentGeneration = generation;
    loading = (async () => {
      try {
        const config = await api('/api/config');
        const data = await api('/api/approvals');
        if (stopped || currentGeneration !== generation) return;
        token = config.token; items = data.requests; online = true;
        errorBox.textContent = data.issues.length ? t('approvals.approvalRecordsCouldntBe', data.issues.length) : responseError;
        errorBox.hidden = !errorBox.textContent;
        render();
      } catch (error) { if (!stopped && currentGeneration === generation) { online = false; render(); errorBox.hidden = false; errorBox.textContent = error.message; } }
      finally { loading = null; if (again && !stopped) { again = false; queueMicrotask(refresh); } }
    })();
    return loading;
  }
  function start() {
    if (source) return;
    stopped = false; generation++;
    source = openEvents();
    source.onopen = refresh;
    source.addEventListener('approvals', refresh);
    source.addEventListener('resync', refresh);
    source.onerror = () => { online = false; render(); };
    timer = setInterval(() => { render(); if (!document.hidden) refresh(); }, 3000);
    refresh();
  }
  function stop() { stopped = true; generation++; online = false; source?.close(); source = null; clearInterval(timer); render(); }
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', (event) => { if (event.persisted) start(); });
  start();
  return { refresh, stop };
}

const container = typeof document !== 'undefined' && document.getElementById('approvals');
if (container && new URLSearchParams(location.search).get('embed') !== '1') mountApprovals(container);
