import { t } from '../messages-catalog.mjs';
import { clear, dateLocale, el, richText, timeLabel } from '../dom.mjs';
import { icon } from '../icons.mjs';
import { TYPE_LABELS } from './scene-state.mjs';

export { TYPE_LABELS };
const PHASE_COLUMNS = ['plan', 'design', 'implement', 'review', 'report', 'done'];

export function createBoardDialog({ $, api, state, win = window }) {
  let tab = 'notes', noteFilter = 'all', picked = null;
  const digestUrls = new Set();
  const revokeDigests = () => { for (const url of digestUrls) URL.revokeObjectURL(url); digestUrls.clear(); };
  win.addEventListener('pagehide', revokeDigests);

  function open(id = state.currentBoard, nextTab = tab) {
    tab = nextTab; picked = null;
    const select = clear($('board-select'));
    const ids = [...new Set([...state.channels.map((c) => c.id), ...state.boards.keys()])];
    for (const channelId of ids) select.append(el('option', { value: channelId, text: channelId, selected: channelId === id }));
    select.value = id ?? ids[0] ?? '';
    render();
    if (!$('board-dialog').open) $('board-dialog').showModal();
  }

  function render() {
    revokeDigests();
    const id = $('board-select').value;
    const board = state.boards.get(id) ?? { notes: [], reports: [] };
    for (const button of $('board-dialog').querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    const panel = clear($('panel-board'));
    panel.setAttribute('aria-labelledby', `tab-${tab}`);
    if (tab === 'notes') {
      const filters = el('div', { class: 'filters', role: 'group', 'aria-label': t('office.boardDialog.filterNoteTypes') },
        ['all', 'opinion', 'question', 'answer', 'decision'].map((type) => el('button', {
          type: 'button', 'aria-pressed': String(noteFilter === type), text: type === 'all' ? t('office.boardDialog.all') : TYPE_LABELS[type],
          onclick: () => { noteFilter = type; render(); },
        })));
      const byId = new Map(board.notes.map((note) => [note.id, note]));
      const notes = board.notes.filter((note) => noteFilter === 'all' || note.type === noteFilter).slice().reverse();
      panel.append(filters, notes.length ? el('ul', { class: 'note-list' }, notes.map((note) => el('li', {},
        el('div', {},
          el('span', { class: `badge type-${note.type}`, text: TYPE_LABELS[note.type] }), ' ',
          note.stance ? el('span', { class: 'badge', text: note.stance === 'disagree' ? t('office.boardDialog.disagree') : t('office.boardDialog.agree') }) : null, ' ',
          el('strong', { text: note.author }), ' ', el('span', { class: 'kind', text: `${note.kind} · ${note.phase ?? '-'} · ${timeLabel(note.at)} · ${note.id}` })),
        note.replyTo ? el('div', { class: 'kind', text: `↳ ${note.replyTo} ${byId.get(note.replyTo)?.author ?? ''}: ${(byId.get(note.replyTo)?.body ?? '').slice(0, 60)}` }) : null,
        el('div', { class: 'body' }, richText(note.body)),
      ))) : el('p', { class: 'empty', text: t('office.boardDialog.noNotesAgentsCan') }),
      digestSection(id));
    } else if (tab === 'phases') {
      panel.append(el('div', { class: 'kanban' }, PHASE_COLUMNS.map((phase) => el('section', {},
        el('h3', {}, icon(phase === 'done' ? 'passed' : phase), ' ', state.config.labels?.[phase] ?? phase),
        state.features.filter((f) => f.phase === phase).map((f) => el('div', { class: 'card' }, el('strong', { text: f.id }), el('div', { class: 'kind', translate: 'no', text: f.title }))),
      ))));
    } else {
      const viewer = el('div');
      panel.append(board.reports.length ? el('ul', { class: 'note-list' }, board.reports.slice().reverse().map((report) => el('li', {},
        el('button', { type: 'button', text: `보고서 ${String(report.number).padStart(3, '0')}`, onclick: async () => {
          try { clear(viewer).append(el('pre', { class: 'markdown', translate: 'no', text: await api(`/api/board/${encodeURIComponent(id)}/reports/${report.number}`) })); }
          catch (error) { clear(viewer).append(el('p', { class: 'error', text: error.message })); }
        } }), ' ',
        el('span', { class: 'kind', text: t('office.boardDialog.notes', report.author, new Date(report.at).toLocaleString(dateLocale()), report.noteCount, report.path) }),
      ))) : el('p', { class: 'empty', text: t('office.boardDialog.noReportsYet') }), viewer);
    }
  }

  function digestSection(id) {
    let downloadUrl;
    const out = el('div');
    const button = el('button', { type: 'button', class: 'primary', text: t('office.boardDialog.createSummaryDraft'), onclick: async () => {
      try {
        const digest = await api(`/api/board/${encodeURIComponent(id)}/digest`);
        if (downloadUrl) { URL.revokeObjectURL(downloadUrl); digestUrls.delete(downloadUrl); }
        const blob = downloadUrl = URL.createObjectURL(new Blob([digest.markdown], { type: 'text/markdown' }));
        digestUrls.add(blob);
        clear(out).append(
          el('div', { class: 'row' },
            el('button', { type: 'button', text: t('office.boardDialog.copy'), onclick: () => navigator.clipboard?.writeText(digest.markdown) }), ' ',
            el('a', { href: blob, download: `${id}-digest.md`, text: t('office.boardDialog.download') })),
          el('pre', { class: 'markdown', translate: 'no', text: digest.markdown }));
      } catch (error) { clear(out).append(el('p', { class: 'error', text: error.message })); }
    } });
    return el('section', {}, el('h3', { text: t('office.boardDialog.summaryReport') }),
      el('p', { class: 'kind', text: t('office.boardDialog.theDraftStaysOn') }),
      button, out);
  }

  function choose() { picked = $('board-select').value; render(); }
  function reload() { if (!$('board-dialog').open) return; const keep = picked; open(keep ?? state.currentBoard); picked = keep; }
  function showTab(next) { tab = next; render(); }
  function refresh() { if ($('board-dialog').open) render(); }
  return { open, render, choose, reload, showTab, refresh };
}
