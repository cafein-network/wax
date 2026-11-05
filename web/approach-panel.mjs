import { t } from './messages-catalog.mjs';
import { el } from './dom.mjs';
import { approachEstimate } from './approach-text.mjs';

const raw = (text, tag = 'span') => el(tag, { translate: 'no', text });
const MODE = { warn: 'approach.mode.warn', ask: 'approach.mode.ask', always: 'approach.mode.always', off: 'approach.mode.off' };
const SETTING = { '': 'approach.goal.default', ask: 'approach.goal.ask', always: 'approach.goal.always', off: 'approach.goal.off' };

export function cardData(card) {
  return { id: card.feature, phase: card.phase, revision: card.revision, archived: false, mode: card.mode, state: 'waiting', designSaved: Boolean(card.designSaved),
    rounds: card.rounds ?? card.round, limits: { reason: 500, rounds: 3 }, proposal: { round: card.round, items: card.items ?? [] }, pick: null, again: null, single: null, earlier: [] };
}

export function approachView(data, { state = {}, actions = {}, card = false } = {}) {
  const { picking = null, againOpen = false, reason = '', note = '', busy = false, message = '' } = state;
  const status = message ? el('p', { class: 'kind approach-message', role: 'status', text: message }) : null;
  const head = card ? null : el('div', { class: 'agent-head' }, el('h3', { text: t('approach.screen.title') }),
    MODE[data?.mode] ? el('span', { class: 'badge approach-mode', text: t(MODE[data.mode]) }) : null);
  const section = (...children) => el('section', { class: 'approach', 'aria-label': t('approach.screen.title'), dataset: { state: data?.state ?? 'none', round: String(data?.proposal?.round ?? 0) } }, ...children);
  if (!data || data.state === 'off') return section(head, status, el('p', { class: 'kind', text: t('approach.screen.off') }));
  const summary = data.pick && data.proposal ? { chosen: { title: data.proposal.items[data.pick.index]?.title ?? '-', by: data.pick.by, via: data.pick.via, reason: data.pick.reason } } : null;
  if (!data.proposal) {
    return section(head, status, data.single ? el('p', { class: 'approach-line' }, t('approach.skippedLabel'), ' ', raw(data.single.reason)) : el('p', { class: 'kind', text: t('approach.screen.none') }));
  }
  const editable = !data.archived && data.phase === 'design';
  const canAgain = editable && !data.again && data.rounds < (data.limits?.rounds ?? 3);
  const item = (entry, index) => {
    const chosen = data.pick?.index === index;
    let confirm = null;
    if (editable && picking === index) {
      const box = el('textarea', { name: 'approach-reason', rows: '2', maxlength: String(data.limits?.reason ?? 500), disabled: busy, translate: 'no', 'aria-label': t('approach.reasonLabel'),
        oninput: (event) => actions.reason?.(event.target.value) });
      box.value = reason;
      confirm = el('div', { class: 'approach-confirm', role: 'group', 'aria-label': t('approach.confirmPick') },
        data.designSaved ? el('p', { class: 'kind approach-rewrite', role: 'note', text: t('approach.rewrite') }) : null,
        el('label', { class: 'trigger-field' }, el('span', { text: t('approach.reasonLabel') }), box),
        el('div', { class: 'row' }, el('button', { type: 'button', class: 'primary approach-confirm-pick', disabled: busy, onclick: () => actions.pick?.(index, box.value) }, t('approach.confirmPick')),
          el('button', { type: 'button', class: 'approach-cancel', disabled: busy, onclick: () => actions.close?.() }, t('approach.cancel'))));
    }
    return el('li', { class: `approach-item${chosen ? ' approach-chosen' : ''}`, dataset: { index: String(index) } },
      el('div', { class: 'agent-head' }, el('strong', { class: 'approach-title', translate: 'no', text: entry.title }),
        chosen ? el('span', { class: 'badge approach-chosen-badge', text: t('approach.chosenBadge') }) : null),
      raw(entry.summary, 'p'),
      el('dl', { class: 'trace-facts' }, el('dt', { text: t('approach.tradeoffs') }), el('dd', {}, raw(entry.tradeoffs))),
      el('p', { class: 'kind approach-estimate', text: approachEstimate(entry) }),
      editable && picking !== index && !chosen ? el('div', { class: 'row approach-actions' }, el('button', { type: 'button', class: 'approach-use', disabled: busy, onclick: () => actions.open?.(index) }, t('approach.use'))) : null,
      confirm);
  };
  let againBox = null;
  if (canAgain && againOpen) {
    const box = el('textarea', { name: 'approach-note', rows: '2', maxlength: String(data.limits?.reason ?? 500), required: true, disabled: busy, translate: 'no', 'aria-label': t('approach.noteLabel'),
      oninput: (event) => { actions.note?.(event.target.value); send.disabled = busy || !event.target.value.trim(); } });
    box.value = note;
    const send = el('button', { type: 'button', class: 'primary approach-again-send', disabled: busy || !note.trim(), onclick: () => actions.again?.(box.value) }, t('approach.againSend'));
    againBox = el('div', { class: 'approach-confirm approach-again-box' }, el('label', { class: 'trigger-field' }, el('span', { text: t('approach.noteLabel') }), box),
      el('div', { class: 'row' }, send, el('button', { type: 'button', class: 'approach-cancel', disabled: busy, onclick: () => actions.close?.() }, t('approach.cancel'))));
  }
  return section(head, status,
    card ? null : el('p', { class: 'kind', text: t('approach.screen.intro') }),
    summary ? el('p', { class: 'approach-line' }, t('approach.chosen', summary.chosen.title), ' · ', raw(summary.chosen.by),
      ...(summary.chosen.reason ? [' · ', t('approach.reason', summary.chosen.reason)] : []), ...(summary.chosen.via === 'cli' ? [' · ', t('approach.viaCli')] : [])) : null,
    data.again ? el('p', { class: 'kind approach-again-note' }, t('approach.againAsked'), ' ', raw(data.again.note)) : null,
    el('p', { class: 'kind' }, t('approach.round', data.proposal.round, data.rounds, data.limits?.rounds ?? 3), data.proposal.author ? ` · ${t('approach.by', data.proposal.author)}` : ''),
    el('ol', { class: 'note-list approach-list' }, data.proposal.items.map(item)),
    canAgain && !againOpen ? el('div', { class: 'row' }, el('button', { type: 'button', class: 'approach-again', disabled: busy || picking !== null, onclick: () => actions.openAgain?.() }, t('approach.again'))) : null,
    againBox,
    data.earlier?.length ? el('p', { class: 'kind approach-earlier' }, t('approach.earlier'), ' ', raw(data.earlier.map((round) => round.titles.join(' / ')).join(' · '))) : null);
}

export function approachField() {
  const select = el('select', { name: 'approach' }, Object.entries(SETTING).map(([value, id]) => el('option', { value, text: t(id) })));
  const node = el('fieldset', { class: 'pm-pick-box pm-approach-field' }, el('legend', { text: t('approach.goal.title') }),
    el('label', { class: 'trigger-field' }, el('span', { text: t('approach.goal.label') }), select), el('small', { class: 'kind', text: t('approach.goal.hint') }));
  return { node, read: () => select.value };
}

export function approachController(post) {
  const state = { picking: null, againOpen: false, reason: '', note: '', busy: false, message: '' };
  const actions = (data, redraw) => ({
    open: (index) => { Object.assign(state, { picking: index, againOpen: false, message: '' }); redraw(); },
    openAgain: () => { Object.assign(state, { picking: null, againOpen: true, message: '' }); redraw(); },
    close: () => { Object.assign(state, { picking: null, againOpen: false }); redraw(); },
    reason: (text) => { state.reason = text; },
    note: (text) => { state.note = text; },
    pick: (index, reason) => send(data, redraw, 'pick', { index, ...(reason.trim() ? { reason } : {}) }, t('approach.pickDone', data.proposal.items[index]?.title ?? '-')),
    again: (note) => send(data, redraw, 'again', { note }, t('approach.againDone')),
  });
  async function send(data, redraw, kind, body, done) {
    if (state.busy) return;
    state.busy = true; state.message = ''; redraw();
    try {
      await post(`/api/features/${encodeURIComponent(data.id)}/approach/${kind}`, { ...body, revision: data.revision });
      Object.assign(state, { picking: null, againOpen: false, reason: '', note: '', message: done });
    } catch (error) {
      state.message = /변경되었습니다|has changed/i.test(error.message) ? t('approach.changed') : error.message;
    } finally {
      state.busy = false;
      redraw(true);
    }
  }
  return { state, actions };
}
