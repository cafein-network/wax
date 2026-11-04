import { t } from '../messages-catalog.mjs';
import { clear, el, richText, timeLabel, trFill } from '../dom.mjs';

const TYPE_CLASS = { task: 'task', test: 'test', commit: 'commit', message: 'talk', note: 'talk', report: 'report', memo: 'memo' };
const STATUS_LABELS = { open: t('office.workNotes.assigned'), accepted: t('office.workNotes.inProgress'), blocked: t('office.workNotes.blocked') };

export function workNotesView(notes) {
  const open = notes.open.length
    ? el('ul', { class: 'note-list' }, notes.open.map((task) => el('li', {},
      el('span', { class: 'badge', text: STATUS_LABELS[task.status] ?? task.status }), ' ', el('code', { text: task.feature }), task.note ? el('div', { class: 'body' }, richText(task.note)) : '')))
    : el('p', { class: 'empty', text: t('office.workNotes.noCurrentAssignments') });
  const memo = notes.lastMemo
    ? el('div', { class: 'worknote-last' }, el('span', { class: 'kind', text: timeLabel(notes.lastMemo.at) }), el('div', { class: 'body' }, richText(notes.lastMemo.body)))
    : el('p', { class: 'empty', text: t('office.workNotes.noMemosYet') });
  const days = notes.dayList.length
    ? notes.dayList.map((day) => {
      const c = day.counts;
      return el('details', { class: 'worknote-day', open: day === notes.dayList[0] ? '' : null },
        el('summary', {}, el('b', { text: day.date }), ' ', el('span', { class: 'kind', text: trFill('업무 완료 {0} · 테스트 {1}/{2} 통과 · 커밋 {3} · 메시지 {4}', c.tasksDone, c.testsPassed, c.testsPassed + c.testsFailed, c.commits, c.messages) })),
        el('ol', { class: 'worknote-list' }, day.entries.map((entry) => el('li', { class: `worknote-${TYPE_CLASS[entry.type] ?? 'talk'}${entry.type === 'test' && !entry.passed ? ' failed' : ''}` },
          el('span', { class: 'kind', text: new Date(entry.at).toTimeString().slice(0, 5) }),
          el('div', {}, el('b', { text: entry.title }), entry.feature ? el('code', { text: entry.feature }) : '',
            entry.detail ? el('div', { class: 'body' }, richText(entry.detail)) : '')))));
    })
    : [el('p', { class: 'empty', text: trFill('최근 {0}일 동안 남은 기록이 없습니다.', notes.days) })];
  return el('div', { class: 'worknotes' },
    el('h4', { text: t('office.workNotes.currentAssignments') }), open,
    el('h4', { text: t('office.workNotes.latestMemo') }), memo,
    el('h4', { text: trFill('최근 {0}일', notes.days) }), ...days,
    el('p', { class: 'hint', text: t('office.workNotes.collectedFromTaskTest') }));
}

export function workNotesPanel({ api, author, days = 7 }) {
  const panel = el('div', {}, el('p', { class: 'hint', text: t('office.workNotes.loadingWorkNotes') }));
  api(`/api/work-notes/${encodeURIComponent(author)}?days=${days}`)
    .then((notes) => clear(panel).append(workNotesView(notes)))
    .catch(() => clear(panel).append(el('p', { class: 'empty', text: t('office.workNotes.couldNotLoadThe') })));
  return panel;
}
