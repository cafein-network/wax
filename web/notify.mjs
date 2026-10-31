import { t } from './messages-catalog.mjs';
import { api, el, storage, store, tr, trFill } from './dom.mjs';
import { openEvents } from './events.mjs';
import { createNoticeModel, noticeUrl, titleWithCount } from './notify-model.mjs';
import { phaseName } from './thread-model.mjs';

const KEY = 'wax.notify';
const TOOLS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI', antigravity: 'Antigravity CLI', grok: 'Grok Build' };
const supported = () => typeof Notification === 'function';
const permission = () => (supported() ? Notification.permission : 'unsupported');
const away = () => document.hidden || !document.hasFocus();
let enabled = storage(KEY, 'off') === 'on', model = null, source = null;

const button = el('button', { type: 'button', class: 'notify-toggle', onclick: toggle });
function render() {
  const state = permission(), on = enabled && state === 'granted';
  button.disabled = state === 'unsupported' || state === 'denied';
  button.setAttribute('aria-pressed', String(on));
  button.dataset.state = on ? 'on' : state === 'granted' || state === 'default' ? 'off' : state;
  button.textContent = state === 'unsupported' ? t('notify.unsupported') : state === 'denied' ? t('notify.blocked') : on ? t('notify.on') : t('notify.off');
  button.title = state === 'unsupported' ? t('notify.unsupportedHelp') : state === 'denied' ? t('notify.blockedHelp') : on ? t('notify.onHelp') : t('notify.offHelp');
}
async function toggle() {
  if (enabled) { enabled = false; store(KEY, 'off'); render(); return; }
  if (permission() === 'default') { try { await Notification.requestPermission(); } catch {   } }
  enabled = permission() === 'granted';
  store(KEY, enabled ? 'on' : 'off'); render();
}

function updateTitle() { const next = titleWithCount(document.title, model?.pending ?? 0); if (next !== document.title) document.title = next; }
function viewed() { if (away()) return; model?.viewed(); updateTitle(); render(); }

function describe(notice) {
  if (notice.kind === 'question') return { title: trFill(t('notify.question'), notice.author), body: notice.body.slice(0, 200) };
  if (notice.kind === 'approval') {
    const subject = notice.details?.command ?? notice.details?.path ?? '';
    return { title: tr(t('notify.approval')), body: [`${TOOLS[notice.tool] ?? notice.tool} · ${notice.action}`, typeof subject === 'string' ? subject.slice(0, 160) : ''].filter(Boolean).join('\n') };
  }
  if (notice.kind === 'proposal') return { title: trFill(t('notify.proposal'), notice.name), body: notice.body.slice(0, 200) };
  if (notice.kind === 'trigger') return { title: trFill(t('notify.trigger'), notice.name), body: notice.body.slice(0, 200) };
  if (notice.kind === 'pm') return { title: trFill(notice.suggestion === 'stopped' ? t('notify.pmStopped') : t('notify.pm'), notice.feature || notice.goal), body: tr(notice.body).slice(0, 200) };
  return { title: tr(t('notify.phaseDone', phaseName(notice.phase))), body: notice.title || notice.feature };
}
async function open(notice) {
  let requestId;
  if (notice.kind === 'approval') { try { requestId = (await api('/api/requests')).requests.find((r) => r.approvals?.includes(notice.id))?.id; } catch {   } }
  const next = new URL(noticeUrl(notice, { requestId }), location.href);
  if (next.pathname + next.search === location.pathname + location.search) { history.replaceState(null, '', next); location.reload(); } else location.assign(next);
}
function show(notice) {
  if (!notice) return;
  updateTitle();
  if (!enabled || permission() !== 'granted') return;
  const { title, body } = describe(notice);
  try {
    const shown = new Notification(title, { body, tag: notice.key, icon: '/favicon.svg' });
    shown.onclick = () => { window.focus(); shown.close(); open(notice); };
  } catch {   }
}

async function settle() {
  const at = model.connected();
  try {
    const [approvals, features] = await Promise.all([api('/api/approvals'), api('/api/features')]);
    model.baseline({ approvals: approvals.requests, features }, at);
  } catch { if (model.settling) model.baseline({}, at); }
}
const parse = (event) => { try { return JSON.parse(event.data); } catch { return {}; } };
function connect() {
  if (source) return;
  source = openEvents();
  source.addEventListener('open', settle);
  source.addEventListener('resync', settle);
  source.addEventListener('message', (event) => show(model.message(parse(event), away())));
  source.addEventListener('features', (event) => { for (const notice of model.features(parse(event).features, away())) show(notice); });
  source.addEventListener('proposals', (event) => show(model.proposal(parse(event), away())));
  source.addEventListener('pm', (event) => show(model.pm(parse(event), away())));
  source.addEventListener('trigger-notice', (event) => show(model.triggerNotice(parse(event), away())));
  source.addEventListener('approvals', () => api('/api/approvals').then((data) => { for (const notice of model.approvals(data.requests, away())) show(notice); }, () => {}));
}
function disconnect() { source?.close(); source = null; }

const bar = typeof document !== 'undefined' && new URLSearchParams(location.search).get('embed') !== '1' && document.querySelector('header.topbar, header.home-header');
if (bar) {
  render();
  const picker = bar.querySelector('.language-picker');
  if (picker) picker.before(button); else bar.append(button);
  document.addEventListener('visibilitychange', viewed);
  window.addEventListener('focus', viewed);
  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', (event) => { if (event.persisted && model) connect(); });
  try {
    const config = await api('/api/config');
    model = createNoticeModel({ user: config.user, offset: Date.parse(config.now) - Date.now() || 0 });
    connect();
  } catch {   }
}
