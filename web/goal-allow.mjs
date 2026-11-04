import { t } from './messages-catalog.mjs';
import { el, timeLabel } from './dom.mjs';

export const ALLOW_KINDS = ['wax', 'test', 'write', 'read'];
const KIND_LABELS = { wax: t('goalAllow.kind.wax'), test: t('goalAllow.kind.test'), write: t('goalAllow.kind.write'), read: t('goalAllow.kind.read') };
const KIND_HINTS = { wax: t('goalAllow.kindHint.wax'), test: t('goalAllow.kindHint.test'), write: t('goalAllow.kindHint.write'), read: t('goalAllow.kindHint.read') };
export const allowKindLabel = (kind) => KIND_LABELS[kind] ?? kind;

export function allowFields({ suggested = [], checks = [] } = {}) {
  const test = el('input', { name: 'allow-test', maxlength: '500', translate: 'no', spellcheck: 'false', autocomplete: 'off' });
  const boxes = ALLOW_KINDS.map((kind) => {
    const box = el('input', { type: 'checkbox', name: 'allow', value: kind });
    return { kind, box, node: el('label', { class: 'trigger-check pm-allow-kind', dataset: { kind } }, box,
      el('span', { class: 'pm-allow-text' }, el('strong', { text: allowKindLabel(kind) }),
        suggested.includes(kind) ? el('span', { class: 'badge pm-allow-suggested', text: t('goalAllow.suggested') }) : null,
        el('small', { class: 'kind', text: KIND_HINTS[kind] }))) };
  });
  const testBox = boxes.find((item) => item.kind === 'test').box;
  const sync = () => { const empty = !test.value.trim(); testBox.disabled = empty; if (empty) testBox.checked = false; };
  test.addEventListener('input', sync);
  sync();
  const offers = checks.length ? el('p', { class: 'kind pm-allow-manual-checks' }, t('goalAllow.manualChecks'), ' ',
    checks.map((command) => el('button', { type: 'button', class: 'link pm-allow-manual-check', translate: 'no', text: command, onclick: () => { test.value = command; sync(); test.focus(); } }))) : null;
  const node = el('fieldset', { class: 'pm-pick-box pm-allow' }, el('legend', { text: t('goalAllow.title') }),
    el('p', { class: 'kind', text: t('goalAllow.startHint') }),
    suggested.length ? el('p', { class: 'kind pm-allow-suggested-hint', text: t('goalAllow.suggestedHint') }) : null,
    el('label', { class: 'trigger-field pm-allow-test' }, el('span', { text: t('goalAllow.testLabel') }), test, el('small', { class: 'kind', text: t('goalAllow.testHint') })),
    offers,
    boxes.map((item) => item.node));
  return { node, read: () => ({ kinds: boxes.filter((item) => item.box.checked).map((item) => item.kind), test: test.value.trim() }) };
}

export function allowView(goal, { off, on = () => {}, busy = false } = {}) {
  const allow = goal.allow ?? { on: false, kinds: [] };
  const used = goal.allowUsed?.total ?? 0;
  const finished = ['done', 'stopped'].includes(goal.storedState ?? goal.state);
  return el('section', { class: `pm-allow-state pm-allow-${allow.on ? 'on' : 'off'}`, 'aria-label': t('goalAllow.title'), dataset: { allow: allow.on ? 'on' : 'off' } },
    el('div', { class: 'agent-head' }, el('span', { class: 'kind', text: t('goalAllow.title') }),
      el('span', { class: `badge pm-allow-badge${allow.on ? ' pm-auto-badge' : ''}`, text: allow.on ? t('goalAllow.on') : t('goalAllow.off') }),
      allow.on && allow.by ? el('span', { class: 'kind', translate: 'no', text: t('goalAllow.onLine', allow.by, timeLabel(allow.at)) }) : null,
      el('span', { class: 'spacer' }),
      allow.on ? el('button', { type: 'button', class: 'pm-allow-off', disabled: busy, text: t('goalAllow.turnOff'), onclick: () => off(goal) }) : null),
    allow.on ? el('ul', { class: 'pm-allow-kinds' }, allow.kinds.map((kind) => el('li', { dataset: { kind } }, allowKindLabel(kind),
      kind === 'test' && allow.test ? el('span', { class: 'kind' }, ' · ', t('goalAllow.testShown'), ' ', el('code', { translate: 'no', text: allow.test })) : null))) : null,
    used ? el('p', { class: 'kind pm-allow-used', text: t('goalAllow.usedLine', used) }) : null,
    !allow.on && allow.ended ? el('p', { class: 'kind pm-allow-ended', text: t('goalAllow.ended') }) : null,
    !allow.on && allow.lapsed && !finished ? el('div', { class: 'pm-allow-lapsed' },
      el('p', { class: 'kind', text: t('goalAllow.lapsed', allow.lapsed.kinds.map((kind) => allowKindLabel(kind)).join(', ')) }),
      allow.lapsed.test ? el('p', { class: 'kind' }, t('goalAllow.testShown'), ' ', el('code', { translate: 'no', text: allow.lapsed.test })) : null,
      el('button', { type: 'button', class: 'pm-allow-on', disabled: busy, text: t('goalAllow.turnOnAgain'), onclick: () => on(goal, { kinds: allow.lapsed.kinds, test: allow.lapsed.test ?? '' }) })) : null,
    !allow.on && !allow.ended && !allow.lapsed && !finished ? el('p', { class: 'kind pm-allow-hint', text: t('goalAllow.offHint') }) : null);
}
