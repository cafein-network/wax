import { t } from './messages-catalog.mjs';
import { api, clear, el, timeLabel, tr } from './dom.mjs';
import { openEvents } from './events.mjs';

export const OUTCOMES = {
  proposed: t('triggers.outcome.proposed'), notified: t('triggers.outcome.notified'), skipped: t('triggers.outcome.skipped'), limited: t('triggers.outcome.limited'),
  error: t('triggers.outcome.error'), accepted: t('triggers.outcome.accepted'), dismissed: t('triggers.outcome.dismissed'), expired: t('triggers.outcome.expired'),
  created: t('triggers.outcome.created'), edited: t('triggers.outcome.edited'), enabled: t('triggers.outcome.enabled'), disabled: t('triggers.outcome.disabled'),
  baseline: t('triggers.outcome.baseline'), connection: t('triggers.outcome.connection'),
};
export const ACTION_LABELS = { request: t('triggers.action.request'), daily: t('triggers.action.daily'), notify: t('triggers.action.notify') };
export const MODE_LABELS = { sm: t('triggers.mode.sm'), project: t('triggers.mode.project') };
const SOURCE_LABELS = { schedule: t('triggers.source.schedule'), local: t('triggers.source.local'), 'github-issues': t('triggers.source.githubIssues'), 'ci-failure': t('triggers.source.ciFailure') };
const GITHUB = new Set(['github-issues', 'ci-failure']);
const DEFAULT_TEXT = { 'github-issues': t('triggers.defaultText.issues'), 'ci-failure': t('triggers.defaultText.ci') };
const defaultText = (type) => (DEFAULT_TEXT[type] ? tr(DEFAULT_TEXT[type]) : '');

function pollLine(trigger) {
  const poll = trigger.poll;
  if (!poll) return null;
  if (trigger.enabled && poll.connection && poll.connection !== 'ok') {
    return el('p', { class: 'error trigger-connection', role: 'status', dataset: { connection: poll.connection } }, el('strong', { text: t('triggers.connectionNeeded') }), ' · ', poll.reason);
  }
  return el('p', { class: 'kind trigger-connection', dataset: { connection: poll.connection ?? 'pending' } },
    poll.connection === 'ok' ? t('triggers.connected') : t('triggers.connectionPending'),
    trigger.enabled && poll.nextPoll ? ` · ${t('triggers.nextPoll', dateTime(poll.nextPoll))}` : '',
    ' · ', poll.baseline ? t('triggers.baselineSeen', poll.seen) : t('triggers.firstPollPending'));
}
const dateTime = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : `${date.toLocaleDateString()} ${timeLabel(iso)}`; };
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

export function triggerItem(trigger, act) {
  const state = trigger.state ?? {};
  const badge = trigger.enabled ? t('triggers.enabled') : trigger.disabledReason ? t('triggers.autoDisabled') : t('triggers.disabled');
  const action = trigger.action.kind === 'request' ? `${ACTION_LABELS.request} · ${MODE_LABELS[trigger.action.mode]} · ${trigger.action.tool}` : ACTION_LABELS[trigger.action.kind];
  return el('li', { class: `trigger-item${trigger.enabled ? '' : ' trigger-off'}`, dataset: { trigger: trigger.id } },
    el('div', { class: 'agent-head' }, el('span', { class: 'badge', text: badge }), el('strong', { translate: 'no', text: trigger.name }), el('code', { class: 'kind', text: trigger.id })),
    el('p', { class: 'kind' }, `${SOURCE_LABELS[trigger.source.type]} · `, el('code', { translate: 'no', text: trigger.describe }), trigger.nextRun ? ` · ${t('triggers.nextRun', dateTime(trigger.nextRun))}` : ''),
    pollLine(trigger),
    el('p', { class: 'kind' }, action, ' · ', t('triggers.limits', trigger.limits.perDay, trigger.limits.cooldown, trigger.today ?? 0)),
    trigger.action.text ? el('p', { class: 'trigger-text', translate: 'no', text: trigger.action.text }) : null,
    trigger.disabledReason ? el('p', { class: 'error', role: 'status', text: trigger.disabledReason })
      : state.lastError ? el('p', { class: 'error', role: 'status' }, t('triggers.lastError', state.failures ?? 0), ' ', el('span', { translate: 'no', text: state.lastError })) : null,
    trigger.events?.length ? el('details', { class: 'trigger-events' }, el('summary', { text: t('triggers.recentEvents', trigger.events.length) }),
      el('ul', {}, trigger.events.map((event) => el('li', {}, el('span', { class: 'kind', text: `${dateTime(event.at)} · ` }), OUTCOMES[event.outcome] ?? event.outcome,
        event.missed ? ` · ${t('triggers.missed', event.missed)}` : '', event.outcome === 'baseline' ? ` · ${t('triggers.baselineCount', event.count ?? 0)}` : '',
        event.outcome === 'connection' && event.status === 'ok' ? ` · ${t('triggers.connected')}` : '',
        event.eventKey && event.source && GITHUB.has(event.source) ? el('code', { class: 'kind', translate: 'no', text: ` ${event.eventKey.replace(/^[a-z-]+:/, '')}` }) : null,
        event.reason ? el('span', { class: 'kind' }, ' · ', event.reason) : null)))) : null,
    el('div', { class: 'row trigger-actions' },
      el('button', { type: 'button', text: t('triggers.edit'), onclick: () => act(trigger, 'edit') }),
      el('button', { type: 'button', class: trigger.enabled ? '' : 'primary', text: trigger.enabled ? t('triggers.turnOff') : t('triggers.turnOn'), onclick: (event) => { event.currentTarget.disabled = true; act(trigger, trigger.enabled ? 'disable' : 'enable'); } }),
      el('button', { type: 'button', class: 'link', text: t('triggers.delete'), onclick: (event) => { if (confirm(t('triggers.confirmDelete'))) { event.currentTarget.disabled = true; act(trigger, 'delete'); } } })));
}

const field = (label, input, hint) => el('label', { class: 'trigger-field' }, el('span', { text: label }), input, hint ? el('small', { class: 'kind', text: hint }) : null);

export function mountTriggers(container) {
  let config, tools = [], editing = null, loading = null, again = false;
  const count = el('span', { class: 'kind' });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const list = el('ul', { class: 'note-list trigger-list' });
  const inputs = {
    name: el('input', { name: 'name', maxlength: '80', required: true, placeholder: t('triggers.namePlaceholder') }),
    source: el('select', { name: 'source' }, Object.entries(SOURCE_LABELS).map(([value, text]) => el('option', { value, text }))),
    repo: el('input', { name: 'repo', maxlength: '140', placeholder: 'owner/name', translate: 'no', spellcheck: 'false', autocapitalize: 'off' }),
    label: el('input', { name: 'label', maxlength: '50', placeholder: 'wax', translate: 'no', spellcheck: 'false' }),
    branch: el('input', { name: 'branch', maxlength: '200', placeholder: 'main', translate: 'no', spellcheck: 'false', autocapitalize: 'off' }),
    workflow: el('input', { name: 'workflow', maxlength: '100', placeholder: 'ci.yml', translate: 'no', spellcheck: 'false' }),
    every: el('input', { name: 'every', value: '5m', translate: 'no', spellcheck: 'false' }),
    cron: el('input', { name: 'cron', placeholder: '0 9 * * 1-5', translate: 'no', spellcheck: 'false' }),
    timezone: el('input', { name: 'timezone', translate: 'no', spellcheck: 'false' }),
    action: el('select', { name: 'action' }, Object.entries(ACTION_LABELS).map(([value, text]) => el('option', { value, text }))),
    mode: el('select', { name: 'mode' }, Object.entries(MODE_LABELS).map(([value, text]) => el('option', { value, text }))),
    tool: el('select', { name: 'tool' }),
    text: el('textarea', { name: 'text', rows: '3', maxlength: '2000', placeholder: t('triggers.textPlaceholder') }),
    perDay: el('input', { name: 'perDay', type: 'number', min: '1', max: '100', value: '3' }),
    cooldown: el('input', { name: 'cooldown', value: '30m', translate: 'no', spellcheck: 'false' }),
    enabled: el('input', { name: 'enabled', type: 'checkbox', checked: true }),
  };
  const scheduleFields = el('div', { class: 'trigger-grid' }, field(t('triggers.cron'), inputs.cron, t('triggers.cronHint')), field(t('triggers.timezone'), inputs.timezone));
  const labelField = field(t('triggers.label'), inputs.label, t('triggers.labelHint'));
  const ciFields = [field(t('triggers.branch'), inputs.branch), field(t('triggers.workflow'), inputs.workflow, t('triggers.workflowHint'))];
  const githubFields = el('div', { class: 'trigger-github' },
    el('div', { class: 'trigger-grid' }, field(t('triggers.repo'), inputs.repo), labelField, ...ciFields, field(t('triggers.every'), inputs.every, t('triggers.everyHint'))),
    el('p', { class: 'kind trigger-github-note', text: t('triggers.githubNote') }));
  const requestFields = el('div', { class: 'trigger-grid' }, field(t('triggers.modeLabel'), inputs.mode), field(t('triggers.tool'), inputs.tool));
  const textField = field(t('triggers.text'), inputs.text, t('triggers.textHint'));
  const formTitle = el('h3', {});
  const form = el('form', { class: 'trigger-form', hidden: true },
    formTitle, field(t('triggers.name'), inputs.name),
    el('div', { class: 'trigger-grid' }, field(t('triggers.sourceLabel'), inputs.source), field(t('triggers.actionLabel'), inputs.action)),
    scheduleFields, githubFields, requestFields, textField,
    el('div', { class: 'trigger-grid' }, field(t('triggers.perDay'), inputs.perDay), field(t('triggers.cooldown'), inputs.cooldown, t('triggers.cooldownHint'))),
    el('label', { class: 'trigger-check' }, inputs.enabled, el('span', { text: t('triggers.enableNow') })),
    el('p', { class: 'kind', text: t('triggers.humanOnly') }),
    el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary', text: t('triggers.save') }), el('button', { type: 'button', text: t('triggers.cancel'), onclick: () => closeForm() })));
  const newButton = el('button', { type: 'button', class: 'new-trigger', text: t('triggers.new'), onclick: () => openForm(null) });
  container.append(el('header', {}, el('h2', { id: 'triggers-heading', text: t('triggers.title') }), count),
    el('p', { class: 'kind', text: t('triggers.intro') }), errorBox, newButton, form, list);

  const showError = (error) => { errorBox.hidden = !error; errorBox.textContent = error?.message ?? ''; };
  let lastSource = 'schedule';
  function sync() {
    const type = inputs.source.value;
    scheduleFields.hidden = type !== 'schedule';
    githubFields.hidden = !GITHUB.has(type);
    labelField.hidden = type !== 'github-issues';
    for (const node of ciFields) node.hidden = type !== 'ci-failure';
    for (const name of ['repo', 'every']) inputs[name].required = GITHUB.has(type);
    inputs.label.required = type === 'github-issues';
    inputs.branch.required = type === 'ci-failure';
    if (type !== lastSource && inputs.action.value === 'request' && (!inputs.text.value.trim() || Object.keys(DEFAULT_TEXT).some((key) => inputs.text.value === defaultText(key)))) inputs.text.value = defaultText(type);
    lastSource = type;
    requestFields.hidden = inputs.action.value !== 'request';
    textField.hidden = inputs.action.value === 'daily';
    inputs.text.required = inputs.action.value !== 'daily' && !(GITHUB.has(type) && inputs.action.value === 'request');
    inputs.cron.required = inputs.source.value === 'schedule';
  }
  inputs.source.addEventListener('change', sync);
  inputs.action.addEventListener('change', sync);
  function openForm(trigger) {
    editing = trigger;
    formTitle.textContent = trigger ? t('triggers.editTitle') : t('triggers.newTitle');
    inputs.name.value = trigger?.name ?? '';
    inputs.source.value = trigger?.source.type ?? 'schedule';
    inputs.cron.value = trigger?.source.cron ?? '';
    inputs.repo.value = trigger?.source.repo ?? '';
    inputs.label.value = trigger?.source.label ?? '';
    inputs.branch.value = trigger?.source.branch ?? '';
    inputs.workflow.value = trigger?.source.workflow ?? '';
    inputs.every.value = trigger?.source.every ?? '5m';
    lastSource = inputs.source.value;
    inputs.timezone.value = trigger?.source.timezone ?? localZone();
    inputs.action.value = trigger?.action.kind ?? 'request';
    inputs.mode.value = trigger?.action.mode ?? 'sm';
    inputs.tool.value = trigger?.action.tool ?? tools.find((tool) => tool.installed)?.id ?? tools[0]?.id ?? 'codex';
    inputs.text.value = trigger?.action.text ?? '';
    inputs.perDay.value = String(trigger?.limits.perDay ?? 3);
    inputs.cooldown.value = trigger?.limits.cooldown ?? '30m';
    inputs.enabled.checked = trigger ? trigger.enabled : true;
    form.hidden = false; newButton.hidden = true; sync(); inputs.name.focus();
  }
  function sourceBody(type) {
    const value = (name) => inputs[name].value.trim();
    if (type === 'schedule') return { type, cron: inputs.cron.value, timezone: value('timezone') };
    if (type === 'github-issues') return { type, repo: value('repo'), label: value('label'), every: value('every') };
    if (type === 'ci-failure') return { type, repo: value('repo'), branch: value('branch'), ...(value('workflow') ? { workflow: value('workflow') } : {}), every: value('every') };
    return { type: 'local' };
  }
  function closeForm() { editing = null; form.hidden = true; newButton.hidden = false; }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; showError(null);
    const kind = inputs.action.value;
    const body = {
      ...(editing ? { id: editing.id } : {}), name: inputs.name.value, enabled: inputs.enabled.checked,
      source: sourceBody(inputs.source.value),
      action: kind === 'request' ? { kind, mode: inputs.mode.value, tool: inputs.tool.value, text: inputs.text.value } : kind === 'notify' ? { kind, text: inputs.text.value } : { kind },
      limits: { perDay: Number(inputs.perDay.value), cooldown: inputs.cooldown.value.trim() },
    };
    try { await api('/api/triggers', { method: 'POST', token: config.token, body }); closeForm(); await refresh(); }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  });

  async function act(trigger, action) {
    if (action === 'edit') { openForm(trigger); return; }
    showError(null);
    try { await api(`/api/triggers/${trigger.id}/${action}`, { method: 'POST', token: config.token, body: {} }); }
    catch (error) { showError(error); }
    await refresh();
  }
  function refresh() {
    if (loading) { again = true; return loading; }
    loading = (async () => {
      try {
        config ??= await api('/api/config');
        if (!tools.length) {
          tools = (await api('/api/request-tools')).tools;
          clear(inputs.tool).append(...tools.map((tool) => el('option', { value: tool.id, text: tool.label })));
        }
        const data = await api('/api/triggers');
        count.textContent = t('triggers.count', data.triggers.filter((trigger) => trigger.enabled).length, data.proposedToday, data.dailyCap);
        clear(list).append(...(data.triggers.length ? data.triggers.map((trigger) => triggerItem(trigger, act)) : [el('li', { class: 'empty', text: t('triggers.empty') })]));
        if (data.issues?.length) showError({ message: t('triggers.unreadable', data.issues.join(', ')) });
      } catch (error) { showError(error); }
      finally { loading = null; if (again) { again = false; queueMicrotask(refresh); } }
    })();
    return loading;
  }
  const source = openEvents();
  for (const type of ['triggers', 'proposals', 'resync']) source.addEventListener(type, () => { void refresh(); });
  window.addEventListener('pagehide', () => source.close());
  refresh();
  return { refresh };
}

const container = typeof document !== 'undefined' && document.getElementById('triggers-panel');
if (container && new URLSearchParams(location.search).get('embed') !== '1') mountTriggers(container);
