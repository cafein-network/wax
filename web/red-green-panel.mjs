import { t } from './messages-catalog.mjs';
import { el } from './dom.mjs';

export function redGreenField() {
  const box = el('input', { type: 'checkbox', name: 'red-green', value: 'on' });
  const node = el('fieldset', { class: 'pm-pick-box pm-red-green-field' }, el('legend', { text: t('redGreen.goal.title') }),
    el('label', { class: 'trigger-check pm-red-green-check' }, box, el('span', { class: 'pm-worktree-text' }, el('strong', { text: t('redGreen.goal.checkbox') }),
      el('small', { class: 'kind', text: t('redGreen.goal.hint') }))));
  return { node, read: () => box.checked };
}

export function redGreenView(goal, { busy = false, set = () => {} } = {}) {
  const on = goal.discipline?.redGreen === 'enforce';
  const finished = ['done', 'stopped'].includes(goal.storedState ?? goal.state);
  const box = el('input', { type: 'checkbox', name: 'red-green', disabled: busy || (finished && !on), onchange: (event) => set(goal, { on: event.target.checked }) });
  box.checked = on;
  return el('section', { class: `pm-red-green pm-red-green-${on ? 'on' : 'off'}`, 'aria-label': t('redGreen.goal.title'), dataset: { redGreen: on ? 'on' : 'off' } },
    el('div', { class: 'agent-head' }, el('span', { class: 'kind', text: t('redGreen.goal.title') }),
      el('span', { class: `badge${on ? ' pm-auto-badge' : ''}`, text: on ? t('redGreen.goal.on') : t('redGreen.goal.off') })),
    el('label', { class: 'trigger-check pm-red-green-toggle' }, box, el('span', { class: 'pm-worktree-text' }, el('strong', { text: t('redGreen.goal.checkbox') }),
      el('small', { class: 'kind', text: t('redGreen.goal.hint') }))));
}
