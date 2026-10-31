import { t } from './messages-catalog.mjs';
import { api, clear, commandLine, el, timeLabel } from './dom.mjs';
import { openEvents } from './events.mjs';

const ACTIONS = { request: t('proposals.action.request'), daily: t('proposals.action.daily') };
const MODES = { sm: t('proposals.mode.sm'), project: t('proposals.mode.project') };

export function proposalCard(proposal, tools, decide, { busy = false } = {}) {
  const request = proposal.action === 'request';
  const text = request ? el('textarea', { class: 'proposal-text', rows: '3', maxlength: '8000', translate: 'no', 'aria-label': t('proposals.text') }) : null;
  if (text) text.value = proposal.text;
  const tool = request ? el('select', { 'aria-label': t('proposals.tool') }, tools.map((item) => el('option', { value: item.id, text: item.label + (item.installed ? '' : ` · ${t('proposals.notInstalled')}`) }))) : null;
  if (tool) { if (!tools.some((item) => item.id === proposal.tool)) tool.append(el('option', { value: proposal.tool, text: proposal.tool })); tool.value = proposal.tool; }
  const mode = request ? el('select', { 'aria-label': t('proposals.modeLabel') }, Object.entries(MODES).map(([value, label]) => el('option', { value, text: label }))) : null;
  if (mode) mode.value = proposal.mode;
  return el('article', { class: 'proposal-card', id: proposal.id, dataset: { proposal: proposal.id } },
    el('header', {}, el('span', { class: 'badge', text: ACTIONS[proposal.action] ?? proposal.action }), el('strong', { translate: 'no', text: proposal.triggerName }),
      el('span', { class: 'kind', text: timeLabel(proposal.createdAt) }), proposal.missed ? el('span', { class: 'badge proposal-missed', text: t('proposals.missed', proposal.missed) }) : null),
    el('p', { class: 'kind' }, t('proposals.source'), ' ', el('code', { translate: 'no', text: proposal.source?.label ?? '' }),
      /^https:\/\/[^\s]+$/.test(proposal.source?.url ?? '') ? el('a', { href: proposal.source.url, target: '_blank', rel: 'noopener noreferrer', text: t('proposals.openSource') }) : null),
    request ? text : el('p', { text: proposal.text }),
    request ? el('div', { class: 'proposal-options' }, el('label', {}, el('span', { text: t('proposals.tool') }), tool), el('label', {}, el('span', { text: t('proposals.modeLabel') }), mode)) : null,
    proposal.quoted ? el('details', { class: 'proposal-quoted' }, el('summary', { text: t('proposals.quoted') }), el('pre', { translate: 'no', text: proposal.quoted })) : null,
    el('div', { class: 'row proposal-actions' },
      el('button', { type: 'button', class: 'primary', disabled: busy, text: request ? t('proposals.accept') : t('proposals.acceptDaily'),
        onclick: () => decide(proposal, 'accept', request ? { text: text.value, tool: tool.value, mode: mode.value } : {}) }),
      el('button', { type: 'button', disabled: busy, text: t('proposals.dismiss'), onclick: () => decide(proposal, 'dismiss', {}) })));
}

export function mountProposals(container) {
  let config, tools = [], items = [], loading = null, again = false;
  const busy = new Set();
  const count = el('span', { class: 'kind' });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const notice = el('div', { class: 'proposal-notice', role: 'status', hidden: true });
  const list = el('div', { class: 'proposal-list' });
  container.append(el('header', {}, el('h2', { id: 'proposals-heading', text: t('proposals.title') }), count), el('p', { class: 'kind', text: t('proposals.intro') }), notice, errorBox, list);
  const drafts = new Map();
  function render() {
    for (const card of list.querySelectorAll('.proposal-card')) {
      const text = card.querySelector('.proposal-text');
      if (text) drafts.set(card.dataset.proposal, { text: text.value, tool: card.querySelectorAll('select')[0].value, mode: card.querySelectorAll('select')[1].value });
    }
    container.hidden = !items.length && notice.hidden;
    count.textContent = items.length ? t('proposals.count', items.length) : '';
    clear(list).append(...items.map((proposal) => {
      const draft = drafts.get(proposal.id);
      return proposalCard(draft ? { ...proposal, ...draft } : proposal, tools, decide, { busy: busy.has(proposal.id) });
    }));
  }
  async function decide(proposal, action, input) {
    if (busy.has(proposal.id)) return;
    busy.add(proposal.id); errorBox.hidden = true; render();
    try {
      const result = await api(`/api/proposals/${proposal.id}/${action}`, { method: 'POST', token: config.token, body: input });
      drafts.delete(proposal.id);
      if (action === 'accept' && result.request) { location.assign(`${location.pathname}?request=${encodeURIComponent(result.request.id)}`); return; }
      if (action === 'accept') { clear(notice).append(el('p', { text: t('proposals.dailyAccepted') }), commandLine(t('proposals.dailyCommand'), '/wax:daily')); notice.hidden = false; }
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { busy.delete(proposal.id); }
    await refresh();
  }
  function refresh() {
    if (loading) { again = true; return loading; }
    loading = (async () => {
      try {
        config ??= await api('/api/config');
        if (!tools.length) tools = (await api('/api/request-tools')).tools;
        items = (await api('/api/proposals')).proposals;
        render();
      } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; container.hidden = false; }
      finally { loading = null; if (again) { again = false; queueMicrotask(refresh); } }
    })();
    return loading;
  }
  const source = openEvents();
  for (const type of ['proposals', 'resync']) source.addEventListener(type, () => { void refresh(); });
  source.onopen = () => { void refresh(); };
  window.addEventListener('pagehide', () => source.close());
  refresh();
  return { refresh };
}

const container = typeof document !== 'undefined' && document.getElementById('proposals');
if (container && new URLSearchParams(location.search).get('embed') !== '1') mountProposals(container);
