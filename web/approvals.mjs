import { t } from './messages-catalog.mjs';
import { api, el, clear } from './dom.mjs';
import { openEvents } from './events.mjs';

const LABELS = { pending: t('approvals.awaitingApproval'), decided: t('approvals.awaitingResponseDelivery'), dispatching: t('approvals.deliveringResponse'), delivered: t('approvals.responseDeliveredToThe'), expired: t('approvals.waitExpired'), cancelled: t('approvals.requestClosed') };
export function approvalCard(request, decide, { disabled = false } = {}) {
  const pending = request.status === 'pending' && Date.now() < request.expiresAt;
  return el('article', { class: 'approval-card', dataset: { request: request.id } },
    el('header', {}, el('strong', { text: `${({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI', antigravity: 'Antigravity CLI', grok: 'Grok Build' })[request.tool] || request.tool} · ${request.action}` }),
      el('span', { class: 'badge', text: LABELS[request.status] ?? t('approvals.statusCheckNeeded') })),
    el('p', { class: 'kind', text: t('approvals.sessionRequest', request.session, request.callId) }),
    el('p', { class: 'kind', text: t('approvals.projectExpires', request.project, new Date(request.expiresAt).toLocaleTimeString()) }),
    el('pre', { class: 'approval-details', text: JSON.stringify(request.details, null, 2) }),
    pending ? el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', disabled, text: t('approvals.allowThisTimeOnly'), onclick: () => decide(request, 'allow') }),
      el('button', { type: 'button', disabled, text: t('approvals.deny'), onclick: () => decide(request, 'deny') })) :
      el('p', { text: `${request.decision === 'allow' ? '이번 요청 허용' : request.decision === 'deny' ? '요청 거부' : '승인되지 않음'}${request.decidedBy ? ` · ${request.decidedBy}` : ''}${request.reason ? ` · ${request.reason}` : ''}` }),
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
  const refreshButton = el('button', { type: 'button', text: t('approvals.refresh'), onclick: () => refresh() });
  container.append(el('header', { class: 'row' }, title, refreshButton), state,
    el('p', { class: 'kind', text: t('approvals.onlyRequestsSentBy') }), errorBox, list, history);

  const render = () => {
    const active = items.filter((r) => ['pending', 'decided', 'dispatching'].includes(r.status));
    state.textContent = online ? t('approvals.waitingAnApprovalResponse', active.filter((r) => r.status === 'pending').length) : t('approvals.connectionCheckNeededYou');
    const nextSignature = JSON.stringify([items, online, [...busy], items.map((r) => Date.now() >= r.expiresAt)]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    clear(list).append(...(active.length ? active.map((r) => approvalCard(r, decide, { disabled: !online || busy.has(r.id) })) : [el('p', { class: 'empty', text: t('approvals.noApprovalRequestsAre') })]));
    clear(historyList).append(...items.filter((r) => !active.includes(r)).map((r) => approvalCard(r, decide, { disabled: true })));
  };
  async function decide(request, decision) {
    if (!online || busy.has(request.id)) return;
    busy.add(request.id); render(); responseError = ''; errorBox.hidden = true;
    try {
      await api(`/api/approvals/${request.id}/decision`, { method: 'POST', token, body: { decision, fingerprint: request.fingerprint } });
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
