import { t } from './messages-catalog.mjs';
import { api, clear, el, timeLabel } from './dom.mjs';
import { openEvents } from './events.mjs';
import { phaseName } from './thread-model.mjs';

export const KIND_LABELS = {
  'confirm-plan': t('pmLoop.kind.confirmPlan'), assign: t('pmLoop.kind.assign'), renotify: t('pmLoop.kind.renotify'), reclaim: t('pmLoop.kind.reclaim'),
  blocked: t('pmLoop.kind.blocked'), 'pr-body': t('pmLoop.kind.prBody'), 'await-pr': t('pmLoop.kind.awaitPr'), escalate: t('pmLoop.kind.escalate'),
  'ask-reviewer': t('pmLoop.kind.askReviewer'), 'start-worker': t('pmLoop.kind.startWorker'),
  judge: t('pmLoop.kind.judge'), 'judge-proposal': t('pmLoop.kind.judgeProposal'), 'judge-failed': t('pmLoop.kind.judgeFailed'), wait: t('pmLoop.kind.wait'), worker: t('pmLoop.kind.worker'), 'wait-capacity': t('pmLoop.kind.waitCapacity'), held: t('pmLoop.kind.held'),
  finished: t('pmLoop.kind.finished'), missing: t('pmLoop.kind.missing'), archived: t('pmLoop.kind.archived'), stopped: t('pmLoop.kind.stopped'), planned: t('pmLoop.kind.planned'),
};
export const STATE_LABELS = { planning: t('pmLoop.state.planning'), running: t('pmLoop.state.running'), 'waiting-human': t('pmLoop.state.waitingHuman'), done: t('pmLoop.state.done'), stopped: t('pmLoop.state.stopped') };
const OUTCOME_LABELS = { executed: t('pmLoop.outcome.executed'), dismissed: t('pmLoop.outcome.dismissed'), failed: t('pmLoop.outcome.failed'), created: t('pmLoop.outcome.created'),
  stopped: t('pmLoop.outcome.stopped'), resumed: t('pmLoop.outcome.resumed'), done: t('pmLoop.outcome.done'),
  launched: t('pmLoop.outcome.launched'), exited: t('pmLoop.outcome.exited'), timeout: t('pmLoop.outcome.timeout'),
  requested: t('pmLoop.outcome.requested'), proposed: t('pmLoop.outcome.proposed'), rejected: t('pmLoop.outcome.rejected'), settings: t('pmLoop.outcome.settings'), mode: t('pmLoop.outcome.mode') };
const JUDGMENT_LABELS = { plan: t('pmLoop.judge.plan'), block: t('pmLoop.judge.block'), report: t('pmLoop.judge.report') };
const BLOCK_ACTIONS = [['retry', t('pmLoop.judge.actionRetry')], ['reassign', t('pmLoop.judge.actionReassign')], ['ask', t('pmLoop.judge.actionAsk')], ['iterate', t('pmLoop.judge.actionIterate')]];
const BUDGETS = [['phaseRuns', t('pmLoop.budgetLabel.phaseRuns')], ['workers', t('pmLoop.budgetLabel.workers')], ['hours', t('pmLoop.budgetLabel.hours')], ['iterations', t('pmLoop.budgetLabel.iterations')], ['failures', t('pmLoop.budgetLabel.failures')], ['autoPerHour', t('pmLoop.budgetLabel.autoPerHour')]];
const phaseLabel = (phase) => (phase ? phaseName(phase) : '-');
const raw = (text, tag = 'span') => el(tag, { translate: 'no', text });

export function elapsedLabel(ms) {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return seconds < 60 ? t('app.seconds', seconds) : t('pmLoop.duration.minutes', Math.floor(seconds / 60), seconds % 60);
}

function executeLabel(card, tool) {
  if (card.kind === 'assign') return t('pmLoop.action.assignTo', card.to);
  if (card.kind === 'start-worker') return t('pmLoop.action.startWorker', card.options?.find((item) => item.id === tool)?.label ?? tool);
  if (card.kind === 'judge') return t('pmLoop.action.judge', card.label ?? '-');
  if (card.kind === 'judge-proposal') return card.judgment === 'plan' ? t('pmLoop.action.acceptPlan') : card.judgment === 'report' ? t('pmLoop.action.acceptReport') : t('pmLoop.action.acceptBlock');
  return { 'confirm-plan': t('pmLoop.action.confirm'), renotify: t('pmLoop.action.renotify'), reclaim: t('pmLoop.action.reclaim'), blocked: t('pmLoop.action.reclaim'),
    'pr-body': t('pmLoop.action.prBody'), 'await-pr': t('pmLoop.action.awaitPr') }[card.kind];
}

export function proposalEditor(card, drafts = new Map(), { busy = false } = {}) {
  const value = drafts.get(card.key) ?? structuredClone(card.proposal);
  const keep = () => drafts.set(card.key, value);
  const field = (label, control, extra = {}) => el('label', { class: 'trigger-field', ...extra }, el('span', { text: label }), control);
  if (card.judgment === 'block') {
    const toolBox = field(t('pmLoop.judge.fieldTool'), el('select', { name: 'judge-tool', disabled: busy, onchange: (event) => { value.tool = event.target.value || null; keep(); } },
      el('option', { value: '', selected: !value.tool || undefined, text: t('pmLoop.judge.toolUnset') }),
      (card.toolOptions ?? []).map((item) => el('option', { value: item.id, selected: item.id === value.tool || undefined, text: item.label }))), { class: 'trigger-field pm-tool' });
    const question = el('textarea', { name: 'judge-question', rows: '2', maxlength: '500', disabled: busy, translate: 'no', oninput: (event) => { value.question = event.target.value; keep(); } });
    question.value = value.question ?? '';
    const questionBox = field(t('pmLoop.judge.fieldQuestion'), question);
    const show = () => {
      toolBox.hidden = !['retry', 'reassign'].includes(value.action);
      questionBox.hidden = value.action !== 'ask';
    };
    const action = el('select', { name: 'judge-action', disabled: busy, onchange: (event) => {
      value.action = event.target.value;
      if (!['retry', 'reassign'].includes(value.action)) value.tool = null;
      if (value.action !== 'ask') value.question = null; else value.question = question.value;
      keep(); show();
    } }, BLOCK_ACTIONS.map(([id, label]) => el('option', { value: id, selected: id === value.action || undefined, text: label })));
    show();
    return { node: el('div', { class: 'pm-proposal' }, field(t('pmLoop.judge.fieldAction'), action, { class: 'trigger-field pm-tool' }), toolBox, questionBox), read: () => value };
  }
  if (card.judgment === 'plan') {
    const rows = value.tasks.map((task) => {
      const title = el('input', { name: 'judge-title', maxlength: '200', disabled: busy, translate: 'no', oninput: (event) => { task.title = event.target.value; keep(); } });
      title.value = task.title;
      const ac = el('textarea', { name: 'judge-ac', rows: String(Math.min(6, Math.max(2, task.ac.length))), disabled: busy, translate: 'no',
        oninput: (event) => { task.ac = event.target.value.split('\n').map((line) => line.trim()).filter(Boolean); keep(); } });
      ac.value = task.ac.join('\n');
      return el('fieldset', { class: 'pm-pick-box pm-plan-task', dataset: { task: task.id } }, el('legend', {}, el('code', { translate: 'no', text: task.id })),
        field(t('pmLoop.judge.fieldTitle'), title), field(t('pmLoop.judge.fieldAc'), ac));
    });
    return { node: el('div', { class: 'pm-proposal' }, rows, el('p', { class: 'kind', text: t('pmLoop.judge.planNote') })), read: () => value };
  }
  const report = el('textarea', { name: 'judge-report', rows: '8', maxlength: '4000', disabled: busy, translate: 'no', oninput: (event) => { value.report = event.target.value; keep(); } });
  report.value = value.report ?? '';
  return { node: el('div', { class: 'pm-proposal' }, field(t('pmLoop.judge.fieldReport'), report)), read: () => value };
}

export function pmCard(card, decide, { busy = false, choices = new Map(), drafts = new Map() } = {}) {
  const detail = card.warning ?? card.note ?? card.file ?? null;
  const launch = card.kind === 'start-worker' && card.executable;
  let tool = card.options?.some((item) => item.id === choices.get(card.key)) ? choices.get(card.key) : card.tool ?? null;
  const editor = card.kind === 'judge-proposal' && card.proposal ? proposalEditor(card, drafts, { busy }) : null;
  const extra = () => (launch ? { tool } : card.kind === 'assign' ? { to: card.to } : editor ? { proposal: editor.read() } : {});
  const execute = card.executable ? el('button', { type: 'button', class: 'primary', disabled: busy, text: executeLabel(card, tool), onclick: () => decide(card, 'execute', extra()) }) : null;
  const picker = launch && card.options?.length > 1 ? el('label', { class: 'trigger-field pm-tool' }, el('span', { text: t('pmLoop.workerTool') }),
    el('select', { name: 'tool', disabled: busy, onchange: (event) => { tool = event.target.value; choices.set(card.key, tool); execute.textContent = executeLabel(card, tool); } },
      card.options.map((item) => el('option', { value: item.id, selected: item.id === tool || undefined, text: item.label })))) : null;
  return el('article', { class: `proposal-card pm-card${card.human ? ' pm-human' : ''}`, dataset: { key: card.key, kind: card.kind } },
    el('header', {}, el('span', { class: 'badge', text: KIND_LABELS[card.kind] ?? card.kind }),
      card.judgment ? el('span', { class: 'badge pm-judgment', text: JUDGMENT_LABELS[card.judgment] ?? card.judgment }) : null,
      card.feature ? el('strong', { translate: 'no', text: card.feature }) : null,
      card.phase ? el('span', { class: 'kind', text: phaseLabel(card.phase) }) : null,
      card.human ? el('span', { class: 'badge pm-human-badge', text: t('pmLoop.humanDecision') }) : null),
    el('p', { text: card.reason }),
    detail ? el('pre', { class: 'pm-detail', translate: 'no', text: detail }) : null,
    card.judged ? el('p', { class: 'kind pm-judged', text: card.judged }) : null,
    card.kind === 'judge' && card.executable ? el('p', { class: 'kind', text: t('pmLoop.judge.readOnly') }) : null,
    editor && card.proposal.reason ? el('p', { class: 'kind pm-ai-reason' }, t('pmLoop.judge.aiReason'), ' ', raw(card.proposal.reason)) : null,
    editor?.node ?? null,
    editor ? el('p', { class: 'kind', text: t('pmLoop.judge.edited') }) : null,
    card.inputs?.length ? el('p', { class: 'kind pm-inputs', text: t('pmLoop.judge.inputs', card.inputs.join(', ')) }) : null,
    card.sameTool?.length ? el('p', { class: 'kind' }, t('pmLoop.sameTool'), ' ', raw(card.sameTool.join(', '))) : null,
    card.kind === 'start-worker' && !launch ? el('p', { class: 'kind' }, t('pmLoop.startWorkerHow'), ' ', el('code', { translate: 'no', text: 'wax chat watch' })) : null,
    launch ? el('p', { class: 'kind', text: t('pmLoop.workers.approvals') }) : null,
    picker,
    el('div', { class: 'row proposal-actions' },
      execute,
      card.kind === 'confirm-plan' ? null : el('button', { type: 'button', disabled: busy, text: card.executable ? t('pmLoop.action.dismiss') : t('pmLoop.action.acknowledge'), onclick: () => { drafts.delete(card.key); decide(card, 'dismiss'); } })));
}

function featureRow(feature) {
  const next = feature.next;
  return el('li', { class: `pm-feature pm-next-${next.kind}`, dataset: { feature: feature.id } },
    el('div', { class: 'agent-head' }, el('strong', { translate: 'no', text: feature.id }), feature.title ? raw(feature.title) : null,
      el('span', { class: 'badge', text: feature.phase === 'done' ? t('pmLoop.state.done') : phaseLabel(feature.phase) }),
      feature.ac ? el('span', { class: 'kind', text: t('pmLoop.acCount', feature.ac) }) : null),
    el('p', { class: 'kind' }, t('pmLoop.assignee'), ' ', feature.assignee ? raw(`${feature.assignee.to} · ${feature.assignee.task}`) : '-'),
    el('p', { class: 'kind' }, t('pmLoop.next'), ' ', el('span', { class: 'badge', text: KIND_LABELS[next.kind] ?? next.kind }), ' ', next.reason));
}

function budgetInputs(goal) {
  return el('div', { class: 'trigger-grid pm-budgets' }, BUDGETS.map(([name, label]) => el('label', { class: 'trigger-field' }, el('span', { text: label }),
    el('input', { type: 'number', name, min: name === 'iterations' ? '0' : '1', value: String(goal?.budgets?.[name] ?? '') }))));
}
const readBudgets = (box) => Object.fromEntries([...box.querySelectorAll('input[type="number"]')].map((input) => [input.name, input.value === '' ? undefined : Number(input.value)]));

function workerRow(goal, worker, { act, busy }) {
  return el('li', { class: 'pm-worker', dataset: { worker: worker.id, tool: worker.tool } },
    el('div', { class: 'agent-head' }, el('span', { class: 'badge', text: worker.label }), el('strong', { translate: 'no', text: worker.feature }),
      el('span', { class: 'kind', text: phaseLabel(worker.phase) }), raw(`${worker.to} · ${worker.task}`)),
    el('div', { class: 'row proposal-actions' },
      el('span', { class: 'kind pm-elapsed', dataset: { started: worker.startedAt }, text: worker.alive ? t('pmLoop.workers.elapsed', elapsedLabel(worker.elapsedMs)) : t('pmLoop.workers.lost') }),
      worker.alive ? el('button', { type: 'button', class: 'pm-worker-stop', disabled: busy, text: t('pmLoop.workers.stop'), onclick: () => act(goal, `workers/${worker.id}/stop`) }) : null));
}

function judgmentRow(goal, run, { act, busy }) {
  return el('li', { class: 'pm-worker pm-judging', dataset: { judge: run.id, tool: run.tool } },
    el('div', { class: 'agent-head' }, el('span', { class: 'badge', text: run.label }), el('span', { class: 'badge', text: JUDGMENT_LABELS[run.judgment] ?? run.judgment }),
      run.feature ? el('strong', { translate: 'no', text: run.feature }) : null, run.task ? raw(run.task) : null),
    el('div', { class: 'row proposal-actions' },
      el('span', { class: 'kind pm-elapsed', dataset: { started: run.startedAt }, text: run.alive ? t('pmLoop.workers.elapsed', elapsedLabel(run.elapsedMs)) : t('pmLoop.workers.lost') }),
      run.alive ? el('button', { type: 'button', class: 'pm-worker-stop pm-judge-stop', disabled: busy, text: t('pmLoop.judge.stop'), onclick: () => act(goal, `judgments/${run.id}/stop`) }) : null));
}

function judgeToolPicker(goal, { act, busy, toolOptions = [] }) {
  const judge = goal.judge ?? {};
  const options = [{ id: '', label: judge.fallbackLabel ? t('pmLoop.judge.toolDefault', judge.fallbackLabel) : t('pmLoop.judge.toolDefaultNone') }, ...toolOptions];
  if (judge.setting && !toolOptions.some((item) => item.id === judge.setting)) options.push({ id: judge.setting, label: judge.setting });
  return el('label', { class: 'trigger-field pm-tool pm-judge-tool' }, el('span', { text: t('pmLoop.judge.toolLabel') }),
    el('select', { name: 'judgeTool', disabled: busy, onchange: (event) => act(goal, 'settings', { judgeTool: event.target.value || null }) },
      options.map((item) => el('option', { value: item.id, selected: item.id === (judge.setting ?? '') || undefined, text: item.label }))),
    el('small', { class: 'kind', text: t('pmLoop.judge.toolHint') }));
}

const recordKind = (item) => (item.kind === 'worker' ? t('pmLoop.kind.workerRecord') : item.kind === 'judgment' ? t('pmLoop.kind.judgmentRecord') : KIND_LABELS[item.kind] ?? item.kind);
const byLabel = (item) => (item.by === 'auto' ? [el('span', { class: 'badge pm-auto-badge', text: t('pmLoop.auto.by') }), item.rule ? ' ' : null, item.rule ? el('code', { class: 'kind', translate: 'no', text: item.rule }) : null] : raw(item.by));

function modeView(goal, { act, busy }) {
  const auto = goal.auto ?? { mode: goal.mode ?? 'suggest', used: 0, cap: goal.budget?.limits?.autoPerHour ?? 0, recent: [] };
  const on = auto.mode === 'auto';
  return el('section', { class: `pm-mode pm-mode-${on ? 'auto' : 'suggest'}`, 'aria-label': t('pmLoop.mode.label'), dataset: { mode: auto.mode } },
    el('div', { class: 'agent-head' }, el('span', { class: 'kind', text: t('pmLoop.mode.label') }),
      el('span', { class: `badge pm-mode-badge${on ? ' pm-auto-badge' : ''}`, text: on ? t('pmLoop.mode.auto') : t('pmLoop.mode.suggest') }),
      on && auto.by ? el('span', { class: 'kind pm-mode-by', text: t('pmLoop.mode.autoOn', auto.by, timeLabel(auto.at)) }) : null,
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: on ? 'pm-mode-off' : 'pm-mode-on', disabled: busy, text: on ? t('pmLoop.mode.turnOff') : t('pmLoop.mode.turnOn'),
        onclick: () => act(goal, 'settings', { mode: on ? 'suggest' : 'auto' }) })),
    on ? null : el('p', { class: 'kind', text: t('pmLoop.mode.suggestHint') }),
    el('details', { class: 'pm-mode-help', open: on || undefined }, el('summary', { text: t('pmLoop.mode.auto') }),
      el('p', { class: 'kind pm-auto-does', text: t('pmLoop.mode.autoDoes') }),
      el('p', { class: 'kind pm-auto-never', text: t('pmLoop.mode.autoNever') }),
      el('p', { class: 'kind', text: t('pmLoop.mode.autoLimits') })),
    on ? el('div', { class: 'pm-auto-activity' }, el('h4', { text: t('pmLoop.auto.activity') }),
      el('p', { class: 'kind pm-auto-usage', text: t('pmLoop.auto.usage', auto.used, auto.cap) }),
      auto.recent?.length ? el('ul', { class: 'note-list' }, auto.recent.map((item) => el('li', { dataset: { rule: item.rule ?? '' } },
        el('span', { class: 'kind', text: `${timeLabel(item.at)} · ` }), `${recordKind(item)} · ${OUTCOME_LABELS[item.outcome] ?? item.outcome}`,
        item.rule ? el('span', { class: 'kind' }, ' · ', el('code', { translate: 'no', text: item.rule })) : null,
        item.feature ? el('span', { class: 'kind' }, ' · ', raw(item.feature)) : null,
        item.reason ? el('span', { class: 'kind' }, ' · ', item.reason) : null)))
        : el('p', { class: 'kind', text: t('pmLoop.auto.none') })) : null);
}

export function goalView(goal, { decide, act, busy, choices, drafts, toolOptions }) {
  const usage = goal.budget.usage, limits = goal.budget.limits;
  const budgets = budgetInputs(goal);
  const stopped = goal.state === 'stopped';
  return el('article', { class: `pm-goal pm-state-${goal.state}`, id: goal.id, dataset: { goal: goal.id, state: goal.state } },
    el('header', {}, el('span', { class: 'badge pm-state', text: STATE_LABELS[goal.state] ?? goal.state }), el('h3', { translate: 'no', text: goal.title }), el('code', { class: 'kind', text: goal.id }),
      el('span', { class: 'spacer' }),
      stopped ? null : el('button', { type: 'button', class: 'pm-stop', disabled: busy, text: t('pmLoop.action.stop'), onclick: () => act(goal, 'stop') })),
    stopped && goal.stoppedReason ? el('p', { class: 'error', role: 'status', text: goal.stoppedReason }) : null,
    el('p', { class: 'kind pm-budget' }, t('pmLoop.budgetLine', usage.phaseRuns, limits.phaseRuns, usage.workers, limits.workers, usage.hours, limits.hours, usage.iterations, limits.iterations, usage.failures, limits.failures)),
    goal.daily ? el('p', { class: 'kind pm-daily', text: t('pmLoop.workers.daily', goal.daily.used, goal.daily.cap) }) : null,
    modeView(goal, { act, busy }),
    goal.workers?.length ? el('section', { class: 'pm-workers', 'aria-label': t('pmLoop.workers.title') }, el('h4', { text: t('pmLoop.workers.title') }),
      el('ul', { class: 'note-list' }, goal.workers.map((worker) => workerRow(goal, worker, { act, busy })))) : null,
    goal.judgments?.length ? el('section', { class: 'pm-workers pm-judgments', 'aria-label': t('pmLoop.judge.running') }, el('h4', { text: t('pmLoop.judge.running') }),
      el('ul', { class: 'note-list' }, goal.judgments.map((run) => judgmentRow(goal, run, { act, busy })))) : null,
    el('details', { class: 'pm-resume', open: stopped || undefined }, el('summary', { text: stopped ? t('pmLoop.resumeTitle') : t('pmLoop.budgetTitle') }),
      el('p', { class: 'kind', text: t('pmLoop.budgetHint') }), budgets, judgeToolPicker(goal, { act, busy, toolOptions }),
      stopped ? el('button', { type: 'button', class: 'primary pm-resume-button', disabled: busy, text: t('pmLoop.action.resume'), onclick: () => act(goal, 'resume', { budgets: readBudgets(budgets) }) }) : null),
    goal.suggestions.length ? el('div', { class: 'proposal-list pm-cards' }, goal.suggestions.map((card) => pmCard({ ...card, goal: goal.id }, (item, action, extra) => decide(goal, item, action, extra), { busy, choices, drafts }))) : null,
    el('ul', { class: 'note-list pm-features' }, goal.features.map(featureRow)),
    goal.decisions.length ? el('details', { class: 'pm-decisions' }, el('summary', { text: t('pmLoop.decisions', goal.decisions.length) }),
      el('ul', {}, goal.decisions.map((item) => el('li', {}, el('span', { class: 'kind', text: `${timeLabel(item.at)} · ` }),
        item.kind && item.kind !== 'goal' ? `${recordKind(item)} · ` : '', OUTCOME_LABELS[item.outcome] ?? item.outcome,
        item.feature ? el('span', { class: 'kind' }, ' · ', raw(item.feature)) : null, item.by ? el('span', { class: 'kind' }, ' · ', byLabel(item)) : null,
        item.reason ? el('span', { class: 'kind' }, ' · ', item.reason) : null)))) : null);
}

export function mountPmLoop(container) {
  let config, loading = null, again = false, busy = false, data = null;
  const toolChoices = new Map();
  const drafts = new Map();
  const count = el('span', { class: 'kind' });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const pmHint = el('div', { class: 'pm-hint', hidden: true });
  const list = el('div', { class: 'pm-goals' });
  const title = el('input', { name: 'title', maxlength: '200', required: true, placeholder: t('pmLoop.titlePlaceholder') });
  const picks = el('div', { class: 'pm-picks' });
  const fresh = el('textarea', { name: 'create', rows: '3', placeholder: t('pmLoop.newFeaturesPlaceholder'), translate: 'no' });
  const budgets = budgetInputs(null);
  const form = el('form', { class: 'pm-form', hidden: true },
    el('h3', { text: t('pmLoop.newTitle') }),
    el('label', { class: 'trigger-field' }, el('span', { text: t('pmLoop.field.title') }), title),
    el('fieldset', { class: 'pm-pick-box' }, el('legend', { text: t('pmLoop.pickFeatures') }), picks),
    el('label', { class: 'trigger-field' }, el('span', { text: t('pmLoop.newFeatures') }), fresh, el('small', { class: 'kind', text: t('pmLoop.newFeaturesHint') })),
    el('details', {}, el('summary', { text: t('pmLoop.budgetTitle') }), budgets),
    el('p', { class: 'kind', text: t('pmLoop.planningHint') }),
    el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary', text: t('pmLoop.create') }), el('button', { type: 'button', text: t('pmLoop.cancel'), onclick: () => closeForm() })));
  const newButton = el('button', { type: 'button', class: 'new-trigger pm-new', text: t('pmLoop.new'), onclick: () => openForm() });
  container.append(el('header', {}, el('h2', { id: 'pm-loop-heading', text: t('pmLoop.title') }), count),
    el('p', { class: 'kind', text: t('pmLoop.intro') }), pmHint, errorBox, newButton, form, list);

  const showError = (error) => { errorBox.hidden = !error; errorBox.textContent = error?.message ?? ''; };
  async function openForm() {
    showError(null);
    try {
      const features = (await api('/api/features')).filter((feature) => feature.phase !== 'done');
      clear(picks).append(...(features.length ? features.map((feature) => el('label', { class: 'trigger-check' }, el('input', { type: 'checkbox', name: 'feature', value: feature.id }),
        el('span', { translate: 'no', text: `${feature.id} · ${feature.title}` }), el('span', { class: 'kind', text: phaseLabel(feature.phase) }))) : [el('p', { class: 'kind', text: t('pmLoop.noFeatures') })]));
    } catch (error) { showError(error); }
    form.hidden = false; newButton.hidden = true; title.focus();
  }
  function closeForm() { form.hidden = true; newButton.hidden = false; form.reset(); }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; showError(null);
    const create = fresh.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [id, ...rest] = line.split(/\s+/); return { id, title: rest.join(' ') || id }; });
    const body = { title: title.value, features: [...picks.querySelectorAll('input:checked')].map((input) => input.value), create, budgets: readBudgets(budgets) };
    try { const goal = await api('/api/pm-loop', { method: 'POST', token: config.token, body }); closeForm(); await refresh(); document.getElementById(goal.id)?.scrollIntoView({ block: 'nearest' }); }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  });

  async function send(path, body) {
    if (busy) return;
    busy = true; showError(null); render();
    try { await api(path, { method: 'POST', token: config.token, body }); }
    catch (error) { showError(error); }
    finally { busy = false; }
    await refresh();
  }
  const decide = (goal, card, action, extra = {}) => send(`/api/pm-loop/${goal.id}/${action}`, { key: card.key, ...(action === 'execute' ? extra : {}) });
  const act = (goal, action, extra = {}) => send(`/api/pm-loop/${goal.id}/${action}`, extra);
  async function takePm() {
    try { await api('/api/team/pm', { method: 'POST', token: config.token, body: { self: true } }); } catch (error) { showError(error); }
    await refresh();
  }

  function render() {
    if (!data) return;
    const waiting = data.goals.reduce((sum, goal) => sum + goal.waiting.length, 0);
    count.textContent = data.goals.length ? t('pmLoop.count', data.goals.length, waiting) : '';
    const canAssign = data.pm && data.pm === data.user;
    pmHint.hidden = canAssign || !data.goals.length;
    clear(pmHint).append(el('p', { class: 'kind', text: data.pm ? t('pmLoop.notPm', data.pm) : t('pmLoop.noPm') }),
      data.pm ? '' : el('button', { type: 'button', text: t('pmLoop.takePm'), onclick: takePm }));
    clear(list).append(...(data.goals.length ? [...data.goals].reverse().map((goal) => goalView(goal, { decide, act, busy, choices: toolChoices, drafts, toolOptions: data.toolOptions ?? [] })) : [el('p', { class: 'empty kind', text: t('pmLoop.empty') })]));
    if (data.issues?.length) showError({ message: t('pmLoop.unreadable', data.issues.join(', ')) });
  }
  function refresh() {
    if (loading) { again = true; return loading; }
    loading = (async () => {
      try {
        config ??= await api('/api/config');
        data = await api('/api/pm-loop');
        render();
      } catch (error) { showError(error); }
      finally { loading = null; if (again) { again = false; queueMicrotask(refresh); } }
    })();
    return loading;
  }
  const ticker = setInterval(() => {
    for (const node of container.querySelectorAll('.pm-elapsed[data-started]')) {
      const started = Date.parse(node.dataset.started);
      if (Number.isFinite(started) && node.closest('.pm-worker')?.querySelector('.pm-worker-stop')) node.textContent = t('pmLoop.workers.elapsed', elapsedLabel(Date.now() - started));
    }
  }, 1000);
  const source = openEvents();
  for (const type of ['pm', 'features', 'tasks', 'presence', 'resync']) source.addEventListener(type, () => { void refresh(); });
  window.addEventListener('pagehide', () => { source.close(); clearInterval(ticker); });
  refresh();
  return { refresh };
}

const container = typeof document !== 'undefined' && document.getElementById('pm-loop-panel');
if (container && new URLSearchParams(location.search).get('embed') !== '1') mountPmLoop(container);
