import { t } from '../messages-catalog.mjs';
import { clear, el, timeLabel } from '../dom.mjs';
import { KIND_LABELS, STATE_LABELS } from './model.mjs';
import { SIDE_ROOMS } from './side-rooms.mjs';

export const EMPTY_LIST = t('office.listView.noAiSessionsHave');

export function agentRow(item, { agents, recent }, rooms = SIDE_ROOMS) {
  const agent = agents.find((a) => a.author === item.author);
  const last = recent.get(item.author)?.at(-1);
  return {
    author: item.author,
    kind: KIND_LABELS[item.kind] ?? item.kind,
    state: `${STATE_LABELS[item.state] ?? item.state}${item.spot ? '' : item.seated ? '' : ' (자리 없음)'}`,
    room: item.spot ? (rooms[item.room] ?? rooms.dev).label : '-',
    feature: item.feature ?? '-',
    lastActive: agent?.lastActive ?? null,
    last: last ? `[${last.channel}] ${last.text.slice(0, 80)}` : '-',
  };
}

export function createListView({ $, state, view = 'office', store = () => {}, openAgent, requestFrame = () => {} }) {
  let stale = false;
  const isList = () => view === 'list';
  function render() {
    stale = !isList();
    if (stale) return;
    const rows = state.scene.map((item) => {
      const row = agentRow(item, state);
      return el('tr', {},
        el('td', {}, el('button', { type: 'button', class: 'link', onclick: () => openAgent(item.author), text: row.author })),
        el('td', { text: row.kind }),
        el('td', { text: row.state }),
        el('td', { text: row.room }),
        el('td', { text: row.feature }),
        el('td', { text: row.lastActive ? timeLabel(row.lastActive) : '-' }),
        el('td', { translate: 'no' }, row.last),
      );
    });
    clear($('agent-rows')).append(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 7, class: 'empty', text: EMPTY_LIST }))]));
  }
  function apply() {
    const list = isList();
    $('list-view').hidden = !list;
    $('office-view').hidden = list;
    $('view-toggle').setAttribute('aria-pressed', String(list));
    $('view-toggle').textContent = list ? t('office.listView.officeView') : t('office.listView.listView');
    if (list && stale) render();
    if (!list) requestFrame();
  }
  function toggle() {
    view = isList() ? 'office' : 'list';
    store('wax-chat.office.view', view);
    apply();
  }
  return { isList, render, apply, toggle };
}
