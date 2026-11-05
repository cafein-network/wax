import { t } from './messages-catalog.mjs';
import { api, clear, el, timeLabel } from './dom.mjs';

const VERDICTS = ['right', 'wrong', 'unsure'];
const VERDICT_TEXT = { right: () => t('pmLoop.review.right'), wrong: () => t('pmLoop.review.wrong'), unsure: () => t('pmLoop.review.unsure') };
const VERDICT_HINT = { right: () => t('pmLoop.review.rightHint'), wrong: () => t('pmLoop.review.wrongHint'), unsure: () => t('pmLoop.review.unsureHint') };
const END_TEXT = { exited: () => t('pmLoop.outcome.exited'), timeout: () => t('pmLoop.outcome.timeout'), failed: () => t('pmLoop.outcome.failed'), stopped: () => t('pmLoop.outcome.stopped'), stuck: () => t('pmLoop.outcome.stuck') };
const HYPOTHESIS_RESULT = { fixed: () => t('pmLoop.reviewList.fixed'), 'not-fixed': () => t('pmLoop.reviewList.notFixed'), unknown: () => t('pmLoop.reviewList.unknownResult') };
export const verdictText = (verdict) => (VERDICT_TEXT[verdict] ?? (() => verdict))();
export const verdictHint = (verdict) => (VERDICT_HINT[verdict] ?? (() => ''))();
const raw = (text) => el('span', { translate: 'no', text: String(text ?? '') });
const keyOf = (item) => `${item.goal}:${item.target}`;
const ended = (item) => item.subject === 'repeat-stuck' || Boolean(item.facts?.end);

export function reviewFacts(item) {
  const end = item.facts?.end;
  return [
    end ? t('pmLoop.review.factEnd', (END_TEXT[end] ?? (() => end))()) : null,
    ended(item) ? (item.facts?.completed ? t('pmLoop.review.factCompleted') : t('pmLoop.review.factNotCompleted')) : null,
    item.facts?.passedAfter === true ? t('pmLoop.review.factPassed') : item.facts?.passedAfter === false && ended(item) ? t('pmLoop.review.factNotPassed') : null,
  ].filter(Boolean);
}

export function reviewRows(goals = []) {
  return goals.flatMap((goal) => (goal.repeatReviews ?? []).map((item) => ({ ...item, goal: goal.id, title: goal.title })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.target).localeCompare(String(a.target)));
}

export function progressView(summary) {
  const goal = summary?.criterion?.rated ?? 10;
  return el('div', { class: 'pm-review-progress' },
    el('p', { class: 'kind', text: t('pmLoop.reviewList.progress', summary?.rated ?? 0, goal, summary?.wrong ?? 0, summary?.unsure ?? 0, summary?.unrated ?? 0) }),
    el('progress', { max: String(goal), value: String(Math.min(summary?.rated ?? 0, goal)), 'aria-label': t('pmLoop.reviewList.progressLabel') }));
}

function evidenceView(detail) {
  if (!detail) return el('p', { class: 'kind', text: t('pmLoop.reviewList.loading') });
  if (detail.error) return el('p', { class: 'error', text: detail.error });
  const ev = detail.evidence ?? { proofs: [] };
  const proofs = ev.proofs.map((proof) => proof.missing
    ? el('li', { class: 'pm-review-proof', dataset: { proof: proof.id, missing: 'true' } }, el('code', { translate: 'no', text: proof.id }), ' · ', t('pmLoop.reviewList.noProof'))
    : el('li', { class: 'pm-review-proof', dataset: { proof: proof.id, sameKey: String(Boolean(proof.sameKey)) } },
      el('p', { class: 'kind' }, `${timeLabel(proof.at)} · `, el('code', { translate: 'no', text: proof.id }), ' · ',
        !proof.tree ? t('pmLoop.reviewList.noTree') : proof.tree.head ? t('pmLoop.reviewList.tree', proof.tree.head, proof.tree.files) : t('pmLoop.reviewList.treeNoHead', proof.tree.files),
        proof.sameKey ? '' : ` · ${t('pmLoop.reviewList.otherKey')}`),
      el('div', { class: 'pm-review-outputs' },
        el('figure', {}, el('figcaption', { class: 'kind', text: t('pmLoop.reviewList.normalized') }), el('pre', { class: 'pm-review-normalized', translate: 'no', text: proof.normalized || '-' })),
        el('figure', {}, el('figcaption', { class: 'kind', text: t('pmLoop.reviewList.raw') }), el('pre', { class: 'pm-review-raw', translate: 'no', text: proof.raw || '-' })))));
  const hypotheses = detail.hypotheses ?? [];
  return el('div', { class: 'pm-review-evidence' },
    el('p', { class: 'kind' }, t('pmLoop.reviewList.head', ev.exitCode ?? '-', ev.count ?? '-', ev.sameKey ?? 0, ev.proofs.length),
      ev.sameCode === true ? el('span', { class: 'badge pm-review-same-code', text: t('pmLoop.reviewList.sameCode') })
        : ev.sameCode === false ? el('span', { class: 'badge pm-review-other-code', text: t('pmLoop.reviewList.otherCode') }) : null),
    hypotheses.length ? el('ul', { class: 'note-list pm-review-hypotheses' }, hypotheses.map((item) => el('li', { class: 'kind' },
      item.missing ? t('pmLoop.reviewList.noHypothesis') : [`${t('pmLoop.reviewList.hypothesis')} `, raw(item.hypothesis), ` · ${(HYPOTHESIS_RESULT[item.result] ?? HYPOTHESIS_RESULT.unknown)()}`]))) : null,
    el('ul', { class: 'note-list pm-review-proofs' }, proofs));
}

export function repeatDefaultView(card, { busy = false, decide = () => {}, openRow = () => {}, notes = new Map() } = {}) {
  if (!card) return null;
  const box = (...children) => el('section', { class: 'pm-repeat-default', dataset: { state: card.state }, 'aria-label': t('pmLoop.repeatDefault.title') }, ...children);
  if (card.state === 'wrong') {
    return box(el('p', { class: 'kind', text: t('pmLoop.repeatDefault.wrong', card.wrong) }),
      card.first ? el('button', { type: 'button', class: 'pm-repeat-default-open', text: t('pmLoop.repeatDefault.openWrong'), onclick: () => openRow(card.first.goal, card.first.target) }) : null);
  }
  if (card.state === 'decided') {
    return box(el('p', {}, el('strong', { text: t('pmLoop.repeatDefault.decided') }), el('span', { class: 'kind' }, ' · ', raw(card.by), ` · ${timeLabel(card.at)}`)),
      el('p', { class: 'kind', text: t('pmLoop.repeatDefault.decidedHow') }), el('code', { translate: 'no', text: 'WAX_STUCK_CHECK=stop' }));
  }
  if (card.state === 'later') {
    return box(el('p', { class: 'kind' }, t('pmLoop.repeatDefault.later'), ' · ', raw(card.by), ` · ${timeLabel(card.at)}`, card.note ? [' · ', raw(card.note)] : '',
      ` · ${t('pmLoop.repeatDefault.again', card.again)}`));
  }
  const note = el('input', { type: 'text', name: 'repeat-default-note', maxlength: '300', placeholder: t('pmLoop.review.note'), value: notes.get('repeat-default') ?? '',
    oninput: (event) => notes.set('repeat-default', event.target.value) });
  return box(el('p', {}, el('strong', { text: t('pmLoop.repeatDefault.ask', card.right, card.wrong) })),
    el('p', { class: 'kind', text: t('pmLoop.repeatDefault.askHint') }),
    el('div', { class: 'row pm-review-buttons' },
      el('button', { type: 'button', class: 'primary pm-repeat-default-decided', disabled: busy, text: t('pmLoop.repeatDefault.plan'), onclick: () => decide('decided', notes.get('repeat-default') ?? '') }),
      el('button', { type: 'button', class: 'pm-repeat-default-later', disabled: busy, text: t('pmLoop.repeatDefault.notYet'), onclick: () => decide('later', notes.get('repeat-default') ?? '') }), note));
}

export function createReviewList({ send, rerender }) {
  const node = el('section', { class: 'pm-review-list', hidden: true, 'aria-label': t('pmLoop.reviewList.title') });
  const state = { open: false, filter: 'unrated', expanded: new Set(), details: new Map(), notes: new Map(), current: null };
  let rows = [], shown = [], busy = false;

  const load = (item) => {
    const key = keyOf(item);
    if (state.details.has(key)) return;
    state.details.set(key, null);
    api(`/api/pm-loop/${item.goal}/reviews/${item.target}`).then((detail) => state.details.set(key, detail), (error) => state.details.set(key, { error: error.message }))
      .finally(() => rerender());
  };
  const expand = (key) => { state.expanded.add(key); state.current = key; };
  const nextAfter = (key) => {
    const at = shown.findIndex((item) => keyOf(item) === key);
    return [...shown.slice(at + 1), ...shown.slice(0, Math.max(at, 0))].find((item) => !item.review && keyOf(item) !== key && ended(item)) ?? null;
  };
  async function review(item, verdict) {
    if (busy) return;
    const key = keyOf(item), next = nextAfter(key), note = state.notes.get(key) ?? '';
    const ok = await send(`/api/pm-loop/${item.goal}/reviews`, { target: item.target, verdict, ...(note.trim() ? { note } : {}) });
    if (!ok) return;
    state.notes.delete(key);
    if (state.filter === 'unrated') state.expanded.delete(key);
    if (next) expand(keyOf(next));
    rerender();
    node.querySelector(`[data-focus="row:${CSS.escape(state.current ?? '')}"]`)?.focus();
  }
  node.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    const verdict = VERDICTS[['1', '2', '3'].indexOf(event.key)];
    const item = verdict && shown.find((entry) => keyOf(entry) === state.current);
    if (!item || !ended(item) || !state.expanded.has(state.current)) return;
    event.preventDefault();
    void review(item, verdict);
  });

  function row(item) {
    const key = keyOf(item), open = state.expanded.has(key);
    if (open) load(item);
    const facts = reviewFacts(item);
    const note = el('input', { type: 'text', name: 'review-note', maxlength: '300', placeholder: t('pmLoop.review.note'), value: state.notes.get(key) ?? '',
      dataset: { focus: `note:${key}` }, oninput: (event) => state.notes.set(key, event.target.value), onfocus: () => { state.current = key; } });
    return el('li', { class: `pm-review-row${state.current === key ? ' current' : ''}`, dataset: { goal: item.goal, target: item.target, subject: item.subject, verdict: item.review?.verdict ?? 'none' } },
      el('button', { type: 'button', class: 'pm-review-toggle', 'aria-expanded': String(open), dataset: { focus: `row:${key}` },
        onclick: () => { if (open && state.current === key) state.expanded.delete(key); else expand(key); rerender(); } },
        el('span', { class: `badge pm-review-subject pm-review-${item.subject}`, text: item.subject === 'repeat-stuck' ? t('pmLoop.outcome.stuck') : t('pmLoop.review.warned') }), ' ',
        raw(item.title), ` · `, raw(item.feature ?? '-'), ` · ${timeLabel(item.at)}`,
        item.review ? el('strong', { class: 'pm-review-verdict', text: ` · ${verdictText(item.review.verdict)}` }) : null),
      open ? el('div', { class: 'pm-review-open-body' },
        el('code', { class: 'kind pm-review-command', translate: 'no', text: item.repeat?.command || '-' }),
        facts.length ? el('p', { class: 'kind pm-review-facts', text: facts.join(' · ') }) : null,
        evidenceView(state.details.get(key)),
        item.review ? el('p', { class: 'kind pm-review-done' }, verdictText(item.review.verdict), ' · ', raw(item.review.by ?? '-'), ` · ${timeLabel(item.review.at)}`,
          item.review.note ? [' · ', raw(item.review.note)] : '') : null,
        ended(item) ? el('div', { class: 'row pm-review-buttons' },
          VERDICTS.map((verdict, index) => el('button', { type: 'button', class: `pm-review-${verdict}`, disabled: busy, title: verdictHint(verdict),
            'aria-keyshortcuts': String(index + 1), text: `${verdictText(verdict)} (${index + 1})`, onclick: () => review(item, verdict) })), note)
          : el('p', { class: 'kind pm-review-wait', text: t('pmLoop.review.waitEnd') })) : null);
  }

  return {
    node,
    get open() { return state.open; },
    toggle() { state.open = !state.open; rerender(); if (state.open) node.querySelector('[data-focus^="row:"]')?.focus(); },
    show(goal, target) {
      state.open = true; state.filter = 'all'; expand(`${goal}:${target}`); rerender();
      const button = node.querySelector(`[data-focus="row:${CSS.escape(`${goal}:${target}`)}"]`);
      button?.scrollIntoView?.({ block: 'nearest' }); button?.focus();
    },
    render(data, options = {}) {
      busy = Boolean(options.busy);
      rows = reviewRows(data?.goals ?? []);
      shown = state.filter === 'unrated' ? rows.filter((item) => !item.review) : rows;
      node.hidden = !state.open;
      if (!state.open) { clear(node); return; }
      const active = node.contains(document.activeElement) ? document.activeElement : null;
      const focus = active?.dataset?.focus ?? null, caret = active?.selectionStart ?? null;
      if (!state.current || !shown.some((item) => keyOf(item) === state.current)) {
        const first = shown.find((item) => !item.review) ?? shown[0];
        state.current = first ? keyOf(first) : null;
        if (first) state.expanded.add(state.current);
      }
      const filterButton = (value) => el('button', { type: 'button', class: `pm-review-filter${state.filter === value ? ' primary' : ''}`, 'aria-pressed': String(state.filter === value), dataset: { filter: value, focus: `filter:${value}` },
        text: value === 'unrated' ? t('pmLoop.reviewList.filterUnrated') : t('pmLoop.reviewList.filterAll'), onclick: () => { state.filter = value; rerender(); } });
      const unreadable = data?.issues?.length ?? 0;
      clear(node).append(...[
        el('h3', { text: t('pmLoop.reviewList.title') }),
        unreadable ? el('p', { class: 'error pm-review-unreadable', text: t('pmLoop.reviewList.unreadable', unreadable) }) : null,
        progressView(data?.repeatReview),
        el('p', { class: 'kind', text: t('pmLoop.reviewList.intro') }),
        el('div', { class: 'row pm-review-filters', role: 'group', 'aria-label': t('pmLoop.reviewList.filter') }, filterButton('unrated'), filterButton('all')),
        shown.length ? el('ul', { class: 'note-list pm-review-rows' }, shown.map(row)) : el('p', { class: 'kind pm-review-empty', text: t('pmLoop.reviewList.empty') })].filter(Boolean));
      if (focus) {
        const again = node.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
        again?.focus();
        if (again && caret !== null && typeof again.setSelectionRange === 'function') again.setSelectionRange(caret, caret);
      }
    },
  };
}
