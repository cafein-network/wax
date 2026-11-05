import { t } from './messages-catalog.mjs';
import { dateLocale, el } from './dom.mjs';

const STATUS = { open: 'rulings.status.open', acknowledged: 'rulings.status.acknowledged', overridden: 'rulings.status.overridden' };
const raw = (text, tag = 'span') => el(tag, { translate: 'no', text });
const stamp = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

export function rulingsView(data, { state = {}, actions = {}, phaseLabel = (phase) => phase } = {}) {
  const { overriding = null, notes = new Map(), busy = false, message = '' } = state;
  const summary = data?.summary ?? { total: 0, unacknowledged: 0 };
  const head = el('div', { class: 'agent-head' }, el('h3', { text: t('rulings.screen.title') }),
    summary.total ? el('span', { class: `badge${summary.unacknowledged ? ' rulings-open-badge' : ''}`, text: t('rulings.summary', summary.total, summary.unacknowledged) }) : null);
  const status = message ? el('p', { class: 'kind rulings-message', role: 'status', text: message }) : null;
  if (!data?.rulings?.length) return el('section', { class: 'rulings', 'aria-label': t('rulings.screen.title'), dataset: { total: '0' } }, head, status, el('p', { class: 'kind', text: t('rulings.screen.none') }));
  const editable = !data.archived;

  const item = (ruling) => {
    const marked = ruling.marked;
    const buttons = [];
    if (editable && ruling.status !== 'overridden' && overriding !== ruling.id) {
      if (ruling.status !== 'acknowledged') buttons.push(el('button', { type: 'button', class: 'ruling-ack', disabled: busy, onclick: () => actions.mark?.(ruling, 'acknowledge') }, t('rulings.acknowledge')));
      buttons.push(el('button', { type: 'button', class: 'ruling-override', disabled: busy, onclick: () => actions.open?.(ruling.id) }, t('rulings.override')));
    }
    let confirm = null;
    if (editable && overriding === ruling.id) {
      const note = el('textarea', { name: 'ruling-note', rows: '3', maxlength: '500', required: true, disabled: busy, translate: 'no', 'aria-label': t('rulings.override.noteLabel'),
        oninput: (event) => { actions.note?.(ruling.id, event.target.value); send.disabled = busy || !event.target.value.trim(); } });
      note.value = notes.get(ruling.id) ?? '';
      const effect = data.effect === 'iterate' ? t('rulings.override.iterate', phaseLabel(data.phase)) : t('rulings.override.defect', phaseLabel(data.phase));
      const send = el('button', { type: 'button', class: 'primary ruling-confirm', disabled: busy || !note.value.trim(), onclick: () => actions.mark?.(ruling, 'override', note.value) }, t('rulings.override.confirm'));
      confirm = el('div', { class: 'ruling-confirm-box', dataset: { effect: data.effect } },
        el('p', { class: 'kind ruling-effect', role: 'note', text: effect }),
        el('label', { class: 'trigger-field' }, el('span', { text: t('rulings.override.noteLabel') }), note),
        el('div', { class: 'row' }, send, el('button', { type: 'button', class: 'ruling-cancel', disabled: busy, onclick: () => actions.close?.() }, t('rulings.override.cancel'))));
    }
    return el('li', { class: `ruling ruling-${ruling.status}${ruling.flag ? ' ruling-flagged' : ''}`, dataset: { ruling: ruling.id, status: ruling.status } },
      el('div', { class: 'agent-head' }, el('code', { translate: 'no', text: ruling.id }), el('span', { class: 'badge', translate: 'no', text: ruling.area }),
        ruling.flag ? el('span', { class: 'badge ruling-flag', text: t('rulings.flag') }) : null,
        el('span', { class: `badge ruling-status`, text: t(STATUS[ruling.status] ?? STATUS.open) })),
      raw(ruling.what, 'p'),
      el('dl', { class: 'trace-facts' },
        el('dt', { text: t('rulings.screen.why') }), el('dd', {}, raw(ruling.why)),
        el('dt', { text: t('rulings.table.cost') }), el('dd', {}, raw(ruling.cost)),
        marked?.note ? el('dt', { text: t('rulings.screen.note') }) : null, marked?.note ? el('dd', {}, raw(marked.note)) : null),
      el('p', { class: 'kind' }, t('rulings.screen.phase', phaseLabel(ruling.phase), ruling.iteration),
        ruling.author ? ' · ' : null, ruling.author ? t('rulings.screen.by', ruling.author) : null,
        marked ? ' · ' : null, marked ? t('rulings.screen.marked', marked.by, stamp(marked.at)) : null,
        marked?.defect ? ' · ' : null, marked?.defect ? el('code', { translate: 'no', text: t('redGreen.defectOf', marked.defect) }) : null),
      buttons.length ? el('div', { class: 'row ruling-actions' }, buttons) : null,
      confirm);
  };
  return el('section', { class: 'rulings', 'aria-label': t('rulings.screen.title'), dataset: { total: String(summary.total), unacknowledged: String(summary.unacknowledged) } },
    head, el('p', { class: 'kind', text: t('rulings.screen.intro') }), status,
    el('ul', { class: 'note-list rulings-list' }, data.rulings.map(item)));
}
