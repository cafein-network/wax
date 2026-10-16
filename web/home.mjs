import { api, el, clear, timeLabel } from './dom.mjs';

const $ = (id) => document.getElementById(id);
const PHASES = ['plan', 'design', 'implement', 'review', 'report'];
const PHASE_LABELS = { plan: '기획', design: '설계', implement: '구현', review: '검토', report: '결과 보고' };
const STATUS = { queued: '준비 중', running: '진행 중', question: '답변 필요', blocked: '확인 필요', paused: '일시 중지', completed: '완료' };
let config, requests = [], currentId = new URLSearchParams(location.search).get('request'), sending = false, online = false, loading, again = false;
let createId, submittedBody, replyId, repliedBody, replyTarget, messageSignature = '', listSignature = '';
const drafts = new Map();
let tools = [], preferred = 'codex', submittedTool;
try { preferred = localStorage.getItem('wax-request-tool') || preferred; } catch {   }
const selectedTool = () => current()?.tool || preferred;
const toolLabel = () => tools.find((t) => t.id === selectedTool())?.label || selectedTool();
const active = (r) => ['queued', 'running'].includes(r.status);
const current = () => requests.find((r) => r.id === currentId);
const showError = (error) => { $('error').hidden = !error; $('error').textContent = error?.message ?? ''; };
function select(id) {
  if (id !== currentId) {
    drafts.set(currentId, $('request-body').value);
    $('request-body').value = drafts.get(id) ?? '';
    clear($('conversation'));
  }
  currentId = id; messageSignature = '';
  history.replaceState(null, '', id ? `/?request=${encodeURIComponent(id)}` : '/');
  render();
}
function render() {
  $('connection').dataset.online = String(online);
  $('connection').textContent = online ? '연결됨' : '연결 확인 중';
  $('send').disabled = sending || !online || (!current() && !tools.some((t) => t.id === preferred && t.installed));
  $('request-tool').disabled = Boolean(current()) || sending;
  $('request-tool').value = selectedTool();
  const installed = tools.find((t) => t.id === selectedTool())?.installed;
  $('tool-note').textContent = !installed ? '이 CLI를 설치한 뒤 대시보드를 다시 열어주세요.' : selectedTool() === 'antigravity' ? 'Antigravity 계정의 사용량이 적용됩니다. 새 권한 요청은 웹에서 승인할 수 없어 터미널 설정 확인이 필요합니다.' : `${toolLabel()}의 로그인 또는 API 설정을 사용합니다. 해당 계정의 한도·비용이 적용됩니다.`;
  const r = current();
  $('welcome').hidden = Boolean(r); $('progress').hidden = !r;
  $('send').firstChild.textContent = sending ? '보내는 중 ' : r ? '보내기 ' : '시작하기 ';
  $('request-body').placeholder = r ? '추가 요청이나 질문에 대한 답변을 입력하세요' : '예: 회원가입이 안 되는 문제를 찾아서 고쳐줘';
  $('composer-hint').textContent = r && active(r) ? '추가 요청은 현재 단계가 끝나면 반영해요' : `${toolLabel()}가 이 프로젝트에서 작업합니다`;
  $('request-count').textContent = requests.length || '';
  const nextList = JSON.stringify([currentId, requests.map((item) => [item.id, item.title, item.status, item.phase])]);
  if (listSignature !== nextList) {
    listSignature = nextList;
    clear($('requests')).append(...requests.map((item) => el('li', {}, el('button', { type: 'button', 'aria-current': String(item.id === currentId), onclick: () => select(item.id) },
      el('span', { class: 'request-name', text: item.title }), el('span', { class: 'request-meta', text: `${STATUS[item.status] ?? item.status} · ${PHASE_LABELS[item.phase] ?? '결과 보고'}` })))));
  }
  if (r) {
    $('progress').dataset.state = r.status;
    $('request-title').textContent = r.title;
    $('request-status').textContent = STATUS[r.status] ?? r.status;
    $('progress-detail').textContent = r.detail;
    $('stop').hidden = !active(r); $('resume').hidden = !['paused', 'blocked'].includes(r.status);
    $('stop').disabled = !online; $('resume').disabled = !online;
    $('detail-link').href = `/manage?feature=${encodeURIComponent(r.id)}`;
    const index = r.phase === 'done' ? 5 : PHASES.indexOf(r.phase);
    clear($('steps')).append(...PHASES.map((phase, i) => el('li', { class: i < index ? 'done' : i === index ? 'current' : '', 'aria-current': i === index ? 'step' : undefined, text: PHASE_LABELS[phase] })));
  }
  const messages = r?.messages ?? [];
  const signature = JSON.stringify([currentId, messages]);
  if (signature !== messageSignature) {
    const previousIds = new Set([...$('conversation').children].map((node) => node.dataset.message));
    if (messageSignature && !messages.some((m) => previousIds.has(m.id))) clear($('conversation'));
    if (!r) clear($('conversation'));
    for (const m of messages) {
      if (previousIds.has(m.id)) continue;
      $('conversation').append(el('article', { class: m.role === 'user' ? 'user-message' : 'assistant-message', dataset: { message: m.id } },
        el('header', {}, el('strong', { text: m.role === 'user' ? '나' : toolLabel() }), el('span', { text: `${m.phase ? PHASE_LABELS[m.phase] + ' · ' : ''}${timeLabel(m.at)}` })),
        el('div', { class: 'message-body', text: m.text })));
    }
    messageSignature = signature;
  }
}
async function refresh() {
  if (loading) { again = true; return loading; }
  loading = (async () => {
    try {
      config = await api('/api/config');
      if (!tools.length) {
        tools = (await api('/api/request-tools')).tools;
        if (!tools.some((t) => t.id === preferred && t.installed)) preferred = tools.find((t) => t.installed)?.id || tools[0]?.id;
        clear($('request-tool')).append(...tools.map((t) => el('option', { value: t.id, text: t.label + (t.installed ? '' : ' · 설치 필요') })));
      }
      const data = await api('/api/requests');
      requests = data.requests; online = true;
      $('project').textContent = config.project;
      render();
    } catch (error) { online = false; render(); showError(error); }
    finally { loading = null; if (again) { again = false; void refresh(); } }
  })();
  return loading;
}
$('request-tool').addEventListener('change', () => {
  preferred = $('request-tool').value;
  try { localStorage.setItem('wax-request-tool', preferred); } catch {   }
  render();
});
$('new-request').addEventListener('click', () => { select(null); $('request-body').focus(); });
for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => { $('request-body').value = button.dataset.example; $('request-body').focus(); });
$('request-body').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('request-form').requestSubmit(); } });
$('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !online || (!current() && !tools.some((t) => t.id === preferred && t.installed))) return;
  const body = $('request-body').value.trim();
  if (!body) return;
  const target = current()?.id ?? null, tool = selectedTool();
  sending = true; showError(null); render();
  try {
    if (!target && (!createId || submittedBody !== body || submittedTool !== tool)) { createId = `request-${crypto.randomUUID()}`; submittedBody = body; submittedTool = tool; }
    if (target && (!replyId || repliedBody !== body || replyTarget !== target)) { replyId = crypto.randomUUID(); repliedBody = body; replyTarget = target; }
    const result = await api(target ? `/api/requests/${target}/reply` : '/api/requests', { method: 'POST', token: config.token, body: target ? { body, messageId: replyId } : { id: createId, body, tool } });
    if (currentId === target && $('request-body').value.trim() === body) $('request-body').value = '';
    if (drafts.get(target)?.trim() === body) drafts.delete(target);
    createId = null; submittedBody = null;
    replyId = null; repliedBody = null; replyTarget = null;
    await refresh();
    if (currentId === target) { select(result.id); $('request-body').focus(); }
  } catch (error) { showError(error); }
  finally { sending = false; render(); }
});
for (const [button, action, body] of [['stop', 'stop', {}], ['resume', 'reply', { resume: true }]]) {
  $(button).addEventListener('click', async () => {
    if (!currentId || !online) return;
    $(button).disabled = true; showError(null);
    try { await api(`/api/requests/${currentId}/${action}`, { method: 'POST', token: config.token, body }); await refresh(); }
    catch (error) { showError(error); }
    finally { $(button).disabled = !online; }
  });
}
const approvals = $('approvals');
new MutationObserver(() => { approvals.hidden = !approvals.querySelector('.approval-card') || approvals.querySelectorAll('.approval-card button').length === 0; }).observe(approvals, { childList: true, subtree: true });
await refresh();
const events = new EventSource('/api/events');
events.addEventListener('requests', () => { void refresh(); });
events.onopen = () => { void refresh(); };
events.onerror = () => { online = false; render(); };
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
window.addEventListener('pagehide', () => { clearInterval(poll); events.close(); });
