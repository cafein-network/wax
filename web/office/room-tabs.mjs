import { t } from '../messages-catalog.mjs';
import { clear, el } from '../dom.mjs';
import { roomCounts } from './model.mjs';
import { BUILDING, SIDE_ROOMS, SIDE_ROOM_ORDER } from './side-rooms.mjs';

export function roomTabsModel(scene, room, order = SIDE_ROOM_ORDER) {
  const counts = roomCounts(scene);
  const names = Object.fromEntries(order.map((id) => [id, scene.filter((item) => item.spot && (item.room ?? 'dev') === id).map((item) => item.author)]));
  return { counts, names, key: JSON.stringify([room, counts, names]) };
}

export function neighborRoom(order, id, key) {
  const index = order.indexOf(id);
  return key === 'ArrowRight' ? order[(index + 1) % order.length] : key === 'ArrowLeft' ? order[(index + order.length - 1) % order.length] : null;
}

export function floorScrollTop(id, { top, width, scrollY }, building = BUILDING) {
  const floorTop = building.floorTop[id];
  if (floorTop === undefined) return null;
  return scrollY + top + floorTop * (width / building.SIZE.width) - 80;
}

export function createRoomTabs({ $, state, store, stage, reduced = () => false, win = window, doc = document, rooms = SIDE_ROOMS, order = SIDE_ROOM_ORDER }) {
  let shownKey = '';
  function scrollToFloor(id, behavior = 'smooth') {
    const rect = stage.getBoundingClientRect();
    const top = floorScrollTop(id, { top: rect.top, width: rect.width, scrollY: win.scrollY });
    if (top !== null) win.scrollTo({ top, behavior: reduced() ? 'instant' : behavior });
  }
  function select(id) {
    if (!rooms[id]) return;
    state.room = id;
    store('wax.office.room', id);
    render();
    scrollToFloor(id);
  }
  function render() {
    const { counts, names, key } = roomTabsModel(state.scene, state.room, order);
    if (key === shownKey) return;
    shownKey = key;
    const focused = $('room-tabs').contains(doc.activeElement) ? doc.activeElement.dataset.room : null;
    const tabs = clear($('room-tabs'));
    for (const id of order) {
      tabs.append(el('button', {
        type: 'button', role: 'tab', 'aria-selected': String(state.room === id), tabindex: state.room === id ? '0' : '-1', 'data-room': id,
        title: names[id].join(', ') || t('office.roomTabs.empty'), onclick: () => select(id),
        onkeydown: (event) => {
          const next = neighborRoom(order, id, event.key);
          if (next) { event.preventDefault(); select(next); $('room-tabs').querySelector('[aria-selected="true"]')?.focus(); }
        },
      }, el('span', { class: 'room-name', text: rooms[id].label }), el('span', { class: 'room-count', text: `${counts[id] ?? 0}명` })));
    }
    if (focused) tabs.querySelector(`[data-room="${focused}"]`)?.focus();
  }
  return { render, select, scrollToFloor };
}
