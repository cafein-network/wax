import { api, el, clear } from './dom.mjs';

const LABELS = { pending: '승인 대기', decided: '응답 전달 대기', dispatching: '응답 전달 중', delivered: '도구 연결에 응답 전달됨', expired: '대기 만료', cancelled: '요청 종료' };
export function approvalCard(request, decide, { disabled = false } = {}) {
  const pending = request.status === 'pending' && Date.now() < request.expiresAt;
  return el('article', { class: 'approval-card', dataset: { request: request.id } },
    el('header', {}, el('strong', { text: `${({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI', antigravity: 'Antigravity CLI' })[request.tool] || request.tool} · ${request.action}` }),
      el('span', { class: 'badge', text: LABELS[request.status] ?? '상태 확인 필요' })),
    el('p', { class: 'kind', text: `세션 ${request.session} · 요청 ${request.callId}` }),
    el('p', { class: 'kind', text: `프로젝트 ${request.project} · 만료 ${new Date(request.expiresAt).toLocaleTimeString()}` }),
    el('pre', { class: 'approval-details', text: JSON.stringify(request.details, null, 2) }),
    pending ? el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', disabled, text: '이번만 허용', onclick: () => decide(request, 'allow') }),
      el('button', { type: 'button', disabled, text: '거부', onclick: () => decide(request, 'deny') })) :
      el('p', { text: `${request.decision === 'allow' ? '이번 요청 허용' : request.decision === 'deny' ? '요청 거부' : '승인되지 않음'}${request.decidedBy ? ` · ${request.decidedBy}` : ''}${request.reason ? ` · ${request.reason}` : ''}` }),
    request.status === 'delivered' ? el('p', { class: 'kind', text: '실행 성공 여부는 해당 도구의 결과에서 확인하세요.' }) : null);
}

export function mountApprovals(container) {
  let token, items = [], online = false, stopped = false, source, timer, loading = null, again = false, signature = '', generation = 0, responseError = '';
  const busy = new Set();
  const title = el('h2', { text: '실행 승인' });
  const state = el('p', { class: 'kind', role: 'status', text: '승인 요청 확인 중…' });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const list = el('div', { class: 'approval-list' });
  const history = el('details', {}, el('summary', { text: '최근 승인 기록' }));
  const historyList = el('div'); history.append(historyList);
  const refreshButton = el('button', { type: 'button', text: '새로고침', onclick: () => refresh() });
  container.append(el('header', { class: 'row' }, title, refreshButton), state,
    el('p', { class: 'kind', text: '연결된 도구가 보낸 요청만 표시됩니다. 일반 대화 메시지는 승인으로 처리되지 않습니다.' }), errorBox, list, history);

  const render = () => {
    const active = items.filter((r) => ['pending', 'decided', 'dispatching'].includes(r.status));
    state.textContent = online ? `대기 ${active.filter((r) => r.status === 'pending').length}개 · 승인 응답은 이 요청에만 적용됩니다.` : '연결 확인 필요 · 다시 연결될 때까지 승인할 수 없습니다.';
    const nextSignature = JSON.stringify([items, online, [...busy], items.map((r) => Date.now() >= r.expiresAt)]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    clear(list).append(...(active.length ? active.map((r) => approvalCard(r, decide, { disabled: !online || busy.has(r.id) })) : [el('p', { class: 'empty', text: '대기 중인 승인 요청이 없습니다.' })]));
    clear(historyList).append(...items.filter((r) => !active.includes(r)).map((r) => approvalCard(r, decide, { disabled: true })));
  };
  async function decide(request, decision) {
    if (!online || busy.has(request.id)) return;
    busy.add(request.id); render(); responseError = ''; errorBox.hidden = true;
    try {
      await api(`/api/approvals/${request.id}/decision`, { method: 'POST', token, body: { decision, fingerprint: request.fingerprint } });
      await refresh();
    } catch (error) { responseError = `응답을 확인하지 못했습니다: ${error.message}. 상태를 확인한 후 다시 선택하세요.`; await refresh(); }
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
        errorBox.textContent = data.issues.length ? `읽지 못한 승인 기록 ${data.issues.length}개. 원래 도구에서 요청을 확인하세요.` : responseError;
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
    source = new EventSource('/api/events');
    source.onopen = refresh;
    source.addEventListener('approvals', refresh);
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
if (container) mountApprovals(container);
