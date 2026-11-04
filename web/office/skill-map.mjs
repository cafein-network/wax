import { t } from '../messages-catalog.mjs';
import { clear, el, tr, trFill } from '../dom.mjs';
import { KIND_LABELS } from './model.mjs';

export const shade = (count) => (count >= 5 ? 3 : count >= 2 ? 2 : count >= 1 ? 1 : 0);

export function skillMapView(map) {
  if (!map.people.length) return el('p', { class: 'empty', text: t('office.skillMap.noSessionsOrRecords') });
  const groups = [];
  for (const column of map.columns) {
    if (groups.at(-1)?.group === column.group) groups.at(-1).span++;
    else groups.push({ group: column.group, span: 1 });
  }
  const cell = (row, column) => {
    const value = row.cells[column.key];
    const count = value?.count ?? 0, failed = value?.failed ?? 0;
    const label = count || failed ? trFill('{0} {1}: {2}건', row.author, column.label, count) + (failed ? trFill(', 실패 {0}건', failed) : '') : trFill('{0} {1}: 기록 없음', row.author, column.label);
    return el('td', { class: `skill-cell level-${shade(count)}`, title: label, 'aria-label': label },
      count ? String(count) : '', failed ? el('span', { class: 'skill-failed', 'aria-hidden': 'true', text: `✕${failed}` }) : '');
  };
  const table = el('table', { class: 'skill-map' },
    el('caption', { class: 'visually-hidden', text: t('office.skillMap.recordedWorkPerMember') }),
    el('thead', {},
      el('tr', {}, el('td', {}), ...groups.map((g) => el('th', { scope: 'colgroup', colspan: String(g.span), text: map.groups[g.group] }))),
      el('tr', {}, el('th', { scope: 'col', text: t('office.skillMap.member') }), ...map.columns.map((c) => el('th', { scope: 'col', class: c.holders ? '' : 'gap', text: c.label })))),
    el('tbody', {}, ...map.people.map((row) => el('tr', {},
      el('th', { scope: 'row' }, row.author, el('span', { class: 'kind', text: KIND_LABELS[row.kind] ?? row.kind })),
      ...map.columns.map((column) => cell(row, column))))));
  const gaps = el('ul', { class: 'skill-gaps' },
    el('li', {}, el('b', { text: t('office.skillMap.emptyAreas') }), ' ', map.gaps.empty.length ? map.gaps.empty.map((label) => tr(label)).join(', ') : t('office.skillMap.none')),
    el('li', {}, el('b', { text: t('office.skillMap.areasOnlyOneMember') }), ' ', map.gaps.single.length ? map.gaps.single.map((g) => `${tr(g.label)}(${g.author})`).join(', ') : t('office.skillMap.none')));
  const notes = [
    el('p', { class: 'hint', text: t('office.skillMap.countsOnlyRecordsLeft') }),
    map.unattributed ? el('p', { class: 'hint', text: trFill('작성자를 알 수 없는 근거 {0}개는 세지 않았습니다. wax test·evidence에 --author를 붙이면 셉니다.', map.unattributed) }) : null,
    map.hiddenAreas ? el('p', { class: 'hint', text: trFill('기록이 적은 코드 영역 {0}개는 생략했습니다.', map.hiddenAreas) }) : null,
  ].filter(Boolean);
  const title = el('p', { class: 'hint', 'aria-hidden': 'true', text: t('office.skillMap.recordedWorkPerMember') });
  return el('div', {}, gaps, title, el('div', { class: 'skill-scroll' }, table), ...notes);
}

export function createSkillMapDialog({ $, api }) {
  async function open() {
    const content = clear($('skill-content'));
    content.append(el('p', { class: 'hint', text: t('office.skillMap.loading') }));
    if (!$('skill-dialog').open) $('skill-dialog').showModal();
    try { clear(content).append(skillMapView(await api('/api/skills/map'))); }
    catch { clear(content).append(el('p', { class: 'empty', text: t('office.skillMap.couldNotLoadThe') })); }
  }
  return { open };
}
