import { t } from './messages-catalog.mjs';
import { api, clear, commandLine, el } from '/dom.mjs';
import { icon } from '/icons.mjs';
import { TOOLS, commandFor } from '/commands.mjs';
import { DEMO_TASKS, DEMO_KIND_LABELS, DEMO_PHASE_KEYS, demoSnapshot, demoScenario, demoProof, demoReleasePlan } from '/workflow-demo-model.mjs';

const $ = (id) => document.getElementById(id);
let position = 0, playing = false, timer = null, officeReady = false;
const releaseOptions = { version: '0.2.0', dates: {} };
let options = { task: { ...DEMO_TASKS.system }, models: {} };
let renderedPosition = -1;
let portraits = new Map(), installed = new Map(), toolStatus = 'checking', environment = null, environmentFailed = false;
const last = () => demoScenario(options).steps.length - 1;
const label = (person) => `${DEMO_KIND_LABELS[person.kind] ?? person.kind} · ${person.role}`;
const textIcon = (node, name, text) => clear(node).append(icon(name), el('span', { text }));
function stop() { clearTimeout(timer); timer = null; playing = false; }
function pausePlayback() {
  stop(); textIcon($('demo-play'), 'play', position === last() ? t('workflowDemo.replay') : t('workflowDemo.play'));
  $('demo-play').setAttribute('aria-pressed', 'false');
  $('demo-position').textContent = `${position} / ${last()} · ${position === last() ? '재생 완료' : '정지'}`;
}
function post(message) { $('office-frame').contentWindow?.postMessage(message, location.origin); }
function syncOffice() { if (officeReady) post({ type: 'wax-demo-step', position, options, rate: Number($('demo-speed').value) }); }
function officeAction(action, author) {
  stop(); render();
  post({ type: 'wax-demo-action', action, author });
}
function inspect(title, body) {
  stop(); render(); $('demo-dialog-title').textContent = title; $('demo-dialog-body').textContent = body; $('demo-dialog').showModal();
}
function portrait(person, size = 36) {
  return portraits.has(person.author) ? el('img', { src: portraits.get(person.author), alt: t('workflowDemo.character', person.role), width: size, height: size, class: 'demo-portrait' }) : icon('team', size);
}
function schedule() {
  clearTimeout(timer);
  if (!playing || position === last()) return;
  timer = setTimeout(() => { position++; if (position === last()) stop(); render(); schedule(); }, 4000 / Number($('demo-speed').value));
}
function jump(value) { stop(); position = demoSnapshot(value, options).index; render(); }
const status = { pending: t('workflowDemo.waiting'), current: t('workflowDemo.inProgress'), done: t('workflowDemo.done'), blocked: t('workflowDemo.blocked') };
const agentStates = { idle: t('workflowDemo.waiting'), working: t('workflowDemo.working'), reviewing: t('workflowDemo.verifying'), discussing: t('workflowDemo.discussing') };
function render() {
  const view = demoSnapshot(position, options), actor = view.team.find((person) => person.author === view.step.actor);
  textIcon($('demo-play'), playing ? 'pause' : 'play', playing ? t('workflowDemo.paused') : position === last() ? t('workflowDemo.replay') : t('workflowDemo.play'));
  $('demo-play').setAttribute('aria-pressed', String(playing));
  $('demo-play').disabled = !officeReady;
  $('demo-seek').disabled = !officeReady;
  $('demo-next').disabled = !officeReady || position === last();
  $('demo-prev').disabled = !officeReady || position === 0;
  $('demo-slide-number').textContent = `${position + 1} / ${last() + 1} · ${view.phases[view.step.phase].label}`;
  if (renderedPosition !== -1 && renderedPosition !== position && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('demo-slider-card').querySelector('.demo-moment').animate([{ opacity: .25, transform: `translateX(${position > renderedPosition ? 12 : -12}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 180 });
  }
  renderedPosition = position;
  $('demo-position').textContent = `${position} / ${last()}${position === last() ? ' · 재생 완료' : playing ? ' · 재생 중' : ' · 정지'}`;
  $('demo-duration').textContent = t('workflowDemo.aboutS1Pm', last() * 4, view.team.length - 1);
  $('demo-seek').max = String(last()); $('demo-seek').value = String(position);
  $('demo-seek').setAttribute('aria-valuetext', `${position} / ${last()} · ${view.step.title}`);
  textIcon($('demo-state'), view.step.done ? 'passed' : view.step.state === '막힘' ? 'failed' : DEMO_PHASE_KEYS[view.step.phase], view.step.done ? t('workflowDemo.done') : view.step.state ?? t('workflowDemo.inProgress'));
  $('demo-state').className = `badge${view.step.state === '막힘' ? ' demo-warning' : ''}`;
  $('demo-flow-heading').textContent = view.task.title;
  $('demo-next-checkpoint').textContent = view.nextMilestone ? t('workflowDemo.nextCheckpoint', view.nextMilestone.code, view.nextMilestone.alias, view.nextMilestone.criterion) : t('workflowDemo.milestonesReachedLaunched', view.milestones.length, view.milestones.length);
  $('demo-team-heading').textContent = t('workflowDemo.allTeamsAndAssignees', view.team.length, view.team.length - 1);
  const current = view.team.filter((person) => person.state !== 'idle' && person.kind !== 'human');
  clear($('demo-current-assignees')).append(...(current.length ? current : view.team.filter((person) => person.author === view.step.actor)).map((person) => el('button', {
    type: 'button', class: 'demo-assignee', disabled: !officeReady, 'aria-label': t('workflowDemo.currentAssigneeCard', label(person)), onclick: () => officeAction('agent', person.author),
  }, portrait(person, 36), el('span', { text: person.role }))));
  const currentAction = view.index === 0 || view.step.done ? ['play', view.step.done ? t('workflowDemo.replay') : t('workflowDemo.collaborationStarted')] : view.unresolved ? ['test', t('workflowDemo.checkFailureEvidence')] : view.step.phase < 2 ? ['board', t('workflowDemo.checkWhiteboard')] : view.step.phase === 4 ? ['report', t('workflowDemo.checkResultReport')] : ['team', t('workflowDemo.checkAssignee')];
  textIcon($('demo-current-action'), ...currentAction);
  $('demo-current-action').disabled = !officeReady;
  $('demo-title').textContent = `${label(actor)} · ${view.step.title}`;
  $('demo-detail').textContent = view.step.detail;
  $('demo-action').textContent = view.step.action ?? (view.unresolved ? t('workflowDemo.openTheFailureEvidence') : view.step.phase < 2 ? t('workflowDemo.clickTheAssigneeCharacter') : view.step.phase === 4 ? t('workflowDemo.checkTheReportingAssignee') : t('workflowDemo.seeTheCurrentStatus'));
  clear($('demo-stats')).append(...[
    [t('workflowDemo.currentStage'), view.step.done ? t('workflowDemo.done') : view.phases[view.step.phase].label, t('workflowDemo.characterPerStage')],
    [t('workflowDemo.activeMembers'), `${view.team.filter((p) => p.kind !== 'human' && p.state !== 'idle').length} / ${view.team.length - 1}`, t('workflowDemo.activeAssignedAi')],
    [t('workflowDemo.tests'), `${view.passed} / ${view.failed}`, t('workflowDemo.passFailHistory')],
    [t('workflowDemo.estimatedDifficulty'), view.assessment.label, t('workflowDemo.ptsBasedOnTask', view.assessment.score)],
  ].map(([name, value, hint]) => el('div', { class: 'stat' }, el('span', { class: 'kind', text: name }), el('strong', { text: value }), el('span', { class: 'kind', text: hint }))));
  clear($('demo-flow')).append(...view.phases.map((phase) => {
    const milestone = view.milestones[phase.phase];
    const state = milestone.reached ? 'done' : view.index === 0 ? 'pending' : view.nextMilestone?.phase === phase.phase ? view.step.state === '막힘' ? 'blocked' : 'current' : 'pending';
    return el('li', { class: `demo-phase-${state}` },
      el('button', { type: 'button', class: `flow-node${state === 'blocked' ? ' has-failures' : ''}`, disabled: !phase.events.length,
        'aria-current': view.nextMilestone?.phase === phase.phase ? 'step' : null,
        onclick: () => milestone.reached ? jump(milestone.evidence.index) : inspect(`${milestone.code} · ${milestone.alias}`, `도달 조건: ${milestone.criterion}\n\n${phase.events.map((event) => `${label(view.team.find((p) => p.author === event.actor))} · ${event.title}\n${event.detail}`).join('\n\n')}`),
      }, el('strong', { class: 'icon-label' }, icon(DEMO_PHASE_KEYS[phase.phase]), phase.label),
        el('span', { class: 'demo-milestone-code', text: `${milestone.code} · ${milestone.alias}` }),
        el('span', { class: 'demo-phase-status icon-label' }, icon(milestone.reached ? 'passed' : state === 'blocked' ? 'failed' : DEMO_PHASE_KEYS[phase.phase], 14), milestone.reached ? t('workflowDemo.reached') : status[state]),
        el('span', { class: 'kind', text: t('workflowDemo.text', phase.events.length, milestone.criterion) })),
      el('div', { class: 'demo-assignees' }, phase.assignees.map((person) => el('button', { type: 'button', class: 'demo-assignee', title: label(person), 'aria-label': t('workflowDemo.assigneeCard', phase.label, label(person)), disabled: !officeReady, onclick: () => officeAction('agent', person.author) }, portrait(person, 28), el('span', { text: person.role })))));
  }));
  clear($('demo-team')).append(...view.team.map((person) => el('li', { class: person.state !== 'idle' ? 'demo-active-agent' : '' },
    el('button', { type: 'button', class: 'demo-person', disabled: !officeReady, 'aria-label': t('workflowDemo.characterCard', label(person)), onclick: () => officeAction('agent', person.author) },
      portrait(person, 56), el('span', {}, el('strong', { text: person.role }), el('span', { class: 'kind', text: person.model || (person.kind === 'human' ? t('workflowDemo.ceoPm') : t('workflowDemo.defaultModel', DEMO_KIND_LABELS[person.kind])) }))),
    el('div', { class: 'agent-head' }, el('span', { class: 'badge', text: view.step.done ? t('workflowDemo.done') : agentStates[person.state] }), el('span', { class: 'kind', text: person.note })))));
  clear($('demo-proofs')).append(...(view.tests.length ? view.tests.slice().reverse().map((event) => el('div', { class: 'demo-proof' },
    el('div', { class: 'agent-head' }, icon(event.proof === 'pass' ? 'passed' : 'failed'), el('strong', { text: event.proof === 'pass' ? t('workflowDemo.passedOnRerun') : t('workflowDemo.firstTestFailed') }), el('span', { class: 'kind', text: t('workflowDemo.virtualEvidence') })),
    el('button', { type: 'button', class: 'link icon-label', 'aria-label': `${event.proof === 'pass' ? '통과' : '실패'} 실행 근거 보기`, onclick: () => inspect(event.title, demoProof(event.proof, view.task)) }, icon('test'), t('workflowDemo.viewExecutionEvidence'))))
    : [el('p', { class: 'empty', text: t('workflowDemo.evidenceAppearsWhenQa') })]));
  clear($('demo-events')).append(...(view.events.length ? view.events.slice().reverse().map((event) => el('li', { class: `event${event.proof === 'fail' ? ' failed' : ''}` },
    el('span', { class: 'when' }, icon(event.proof ? event.proof === 'pass' ? 'passed' : 'failed' : DEMO_PHASE_KEYS[event.phase]), el('span', { text: String(event.index).padStart(2, '0') })),
    el('div', {}, el('div', { class: 'event-head' }, el('span', { class: 'badge', text: view.team.find((p) => p.author === event.actor).role }), el('button', { type: 'button', class: 'link', text: event.title, onclick: () => jump(event.index) })), el('p', { class: 'detail', text: event.detail }))))
    : [el('li', { class: 'empty', text: t('workflowDemo.playTheDemoTo') })]));
  $('demo-open-assignee').disabled = !officeReady;
  $('demo-open-board').disabled = !officeReady;
  $('demo-open-proof').disabled = !view.tests.length;
  $('demo-open-report').disabled = !officeReady || !view.events.some((event) => event.phase === 4 && event.actor !== 'PM');
  renderPreview(view); renderRelease(view); syncOffice();
}
function renderRelease(view) {
  const plan = demoReleasePlan(view, releaseOptions);
  $('demo-release-status').textContent = plan.ready ? t('workflowDemo.officialReadyMilestones5', plan.version) : t('workflowDemo.current5ReachedNext', plan.currentVersion, plan.reached, plan.remaining[0].criterion);
  clear($('demo-release-plan')).append(...plan.checkpoints.map((checkpoint) => {
    const date = el('input', { type: 'date', value: checkpoint.date, 'aria-label': t('workflowDemo.targetDate', checkpoint.alias) });
    const saveDate = () => { releaseOptions.dates[checkpoint.phase] = date.value; };
    date.addEventListener('input', saveDate); date.addEventListener('change', saveDate);
    return el('li', { class: checkpoint.reached ? 'is-reached' : '' },
      el('div', { class: 'agent-head' }, icon(checkpoint.reached ? 'passed' : DEMO_PHASE_KEYS[checkpoint.phase]), el('strong', { text: `${checkpoint.alias} · ${checkpoint.version}` })),
      el('p', { class: 'kind', text: `${checkpoint.code} · ${checkpoint.criterion}` }),
      el('p', { class: 'kind', text: t('workflowDemo.assignee', checkpoint.owners.join(' · ')) }),
      el('div', { class: 'demo-release-row' }, el('label', {}, '목표일 ', date),
        el('button', { type: 'button', class: 'link', disabled: !checkpoint.reached, text: checkpoint.reached ? t('workflowDemo.viewWhenReachedAnd') : t('workflowDemo.waitingForConditions'), onclick: () => jump(checkpoint.evidence.index) })));
  }));
}
$('demo-release-version').addEventListener('input', () => {
  const input = $('demo-release-version');
  try { demoReleasePlan(demoSnapshot(position, options), { version: input.value }); releaseOptions.version = input.value; $('demo-release-error').hidden = true; input.setCustomValidity(''); renderRelease(demoSnapshot(position, options)); }
  catch (error) { $('demo-release-error').hidden = false; $('demo-release-error').textContent = error.message; input.setCustomValidity(error.message); }
});
function renderModelSettings() {
  const scenario = demoScenario(options);
  $('demo-assessment').textContent = t('workflowDemo.estimatedDifficultyPts1', scenario.assessment.label, scenario.assessment.score, scenario.team.length - 1, scenario.assessment.reasons.join(' · '));
  clear($('demo-models')).append(...scenario.team.filter((p) => p.kind !== 'human').map((person) => {
    const tool = el('select', { id: `demo-kind-${person.author}`, 'aria-label': t('workflowDemo.tool', person.role) }, TOOLS.map((item) => el('option', { value: item.kind, selected: person.kind === item.kind, text: item.label })));
    const model = el('input', { type: 'text', id: `demo-model-${person.author}`, value: person.model ?? '', maxlength: 60, placeholder: t('workflowDemo.useDefaultModel'), 'aria-label': t('workflowDemo.modelId', person.role) });
    const change = () => { options.models[person.author] = { kind: tool.value, model: model.value }; stop(); position = 0; render(); renderTools(); };
    tool.addEventListener('change', change); model.addEventListener('input', change); model.addEventListener('change', change);
    return el('div', { class: 'demo-model-setting' }, el('strong', { class: 'kind', text: person.role }), el('label', { for: tool.id, class: 'visually-hidden', text: t('workflowDemo.tool2') }), tool, model);
  }));
}
function settingsChanged() {
  stop(); position = 0;
  options.task = { ...DEMO_TASKS[$('demo-task').value], ...Object.fromEntries(['api', 'data', 'sensitive', 'parallel'].map((key) => [key, $(`demo-risk-${key}`).checked])) };
  renderModelSettings(); render(); renderTools();
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== $('office-frame').contentWindow) return;
  if (event.data?.type === 'wax-demo-error') { officeReady = false; stop(); $('demo-office-status').textContent = t('workflowDemo.couldntUpdateTheOffice'); $('demo-office-retry').hidden = false; render(); }
  if (event.data?.type === 'wax-demo-ready') { officeReady = true; $('demo-office-retry').hidden = true; $('demo-office-status').textContent = t('workflowDemo.tryTheCharactersAnd'); render(); }
  if (event.data?.type === 'wax-demo-cast' && Array.isArray(event.data.cast)) {
    const members = new Set(demoScenario(options).team.map((p) => p.author));
    for (const person of event.data.cast) if (person && typeof person === 'object' && members.has(person.author) && typeof person.portrait === 'string' && /^data:image\/png;base64,/.test(person.portrait) && person.portrait.length < 100_000) portraits.set(person.author, person.portrait);
    render();
  }
  if (event.data?.type === 'wax-demo-interaction') { stop(); render(); }
});
$('demo-play').addEventListener('click', () => { if (playing) stop(); else { if (position === last()) position = 0; playing = true; } render(); schedule(); });
$('demo-prev').addEventListener('click', () => jump(position - 1));
$('demo-slider-card').addEventListener('keydown', (event) => { if (event.target !== event.currentTarget) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); jump(position + (event.key === 'ArrowRight' ? 1 : -1)); } });
$('demo-next').addEventListener('click', () => jump(position + 1));
$('demo-reset').addEventListener('click', () => jump(0));
$('demo-seek').addEventListener('input', () => jump($('demo-seek').value));
$('demo-speed').addEventListener('change', schedule);
$('demo-close').addEventListener('click', () => $('demo-dialog').close());
$('demo-task').addEventListener('change', () => { for (const key of ['api', 'data', 'sensitive', 'parallel']) $(`demo-risk-${key}`).checked = DEMO_TASKS[$('demo-task').value][key]; settingsChanged(); });
for (const key of ['api', 'data', 'sensitive', 'parallel']) $(`demo-risk-${key}`).addEventListener('change', settingsChanged);
$('demo-open-assignee').addEventListener('click', () => officeAction('agent', demoSnapshot(position, options).step.actor));
$('demo-open-board').addEventListener('click', () => officeAction('board'));
$('demo-open-report').addEventListener('click', () => officeAction('report'));
$('demo-open-proof').addEventListener('click', () => { const view = demoSnapshot(position, options), proof = view.tests.at(-1); if (proof) inspect(proof.title, demoProof(proof.proof, view.task)); });
textIcon($('demo-prev'), 'previous', t('workflowDemo.previousStage')); textIcon($('demo-next'), 'next', t('workflowDemo.nextStage')); textIcon($('demo-reset'), 'reset', t('workflowDemo.restart'));
textIcon($('demo-open-assignee'), 'team', t('workflowDemo.currentAssigneeCard2')); textIcon($('demo-open-board'), 'board', t('workflowDemo.whiteboard'));
textIcon($('demo-open-proof'), 'test', t('workflowDemo.executionEvidence')); textIcon($('demo-open-report'), 'report', t('workflowDemo.resultReport'));
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); render(); } });
window.addEventListener('pagehide', () => { stop(); render(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) render(); });

function renderPreview(view) {
  const panel = clear($('demo-preview'));
  const revisions = view.events.filter((event) => ['frontend', 'backend'].includes(event.actor));
  $('demo-preview-version').textContent = t('workflowDemo.pointChanges', view.index, revisions.length);
  if (view.step.phase < 2) { panel.append(el('p', { class: 'empty', text: t('workflowDemo.aSampleTaskScreen') })); }
  else if (view.task.scope === 'system') {
    const count = el('p', { class: 'kind', role: 'status', text: t('workflowDemo.tryHowRequestsAre') });
    panel.append(el('div', { class: 'demo-artifact' }, el('strong', { text: t('workflowDemo.confirmOrder') }), el('p', { text: t('workflowDemo.sampleItem12000') }),
      el('button', { type: 'button', text: t('workflowDemo.tryRepeatedClicks'), onclick: () => { pausePlayback(); count.textContent = view.passed ? t('workflowDemo.oneRequestDuplicate') : t('workflowDemo.twoRequestsDuplicate'); } }), count));
  } else if (view.task.scope === 'feature') {
    const result = el('ul', { class: 'note-list' });
    const search = el('input', { type: 'search', placeholder: t('workflowDemo.taskSearch'), 'aria-label': t('workflowDemo.taskSearchPreview') });
    const update = () => clear(result).append(...[t('workflowDemo.loginImprovement'), t('workflowDemo.dashboardSorting'), t('workflowDemo.searchFilter')].filter((name) => name.includes(search.value)).map((name) => el('li', { text: name })));
    search.addEventListener('input', update); update(); panel.append(el('div', { class: 'demo-artifact' }, search, result));
  } else panel.append(el('div', { class: `demo-artifact demo-preview-stats${view.passed ? ' is-fixed' : ''}` }, [t('workflowDemo.inProgress3'), t('workflowDemo.review1'), t('workflowDemo.done8')].map((text) => el('div', { class: 'stat', text }))));
  panel.append(el('p', { class: 'kind', text: t('workflowDemo.virtualDeliverablePreviewDoes') }));
  clear($('demo-revisions')).append(...(revisions.length ? revisions.slice().reverse().map((event) => el('li', {}, el('button', { type: 'button', class: 'link', text: `${event.index} · ${event.title}`, onclick: () => jump(event.index) }))) : [el('li', { class: 'kind', text: t('workflowDemo.noImplementationChangesYet') })]));
}
$('demo-preview-doc').addEventListener('click', () => { const view = demoSnapshot(position, options); inspect(t('workflowDemo.documentsAndEvidenceAt'), `# [가상 데모] ${view.task.title}\n\n${view.events.map((event) => `- ${event.title}: ${event.detail}`).join('\n')}\n\n통과 ${view.passed}회 / 실패 이력 ${view.failed}회`); });
function renderEnvironment() {
  $('demo-environment-summary').textContent = `처음 시작 · 개발환경 가이드${toolStatus === 'ready' ? ` · 도구 ${[...installed.values()].filter((tool) => tool.installed).length}개 설치 확인` : ''}`;
  $('demo-runtime').textContent = environment ? `Node ${environment.runtime?.node ?? '확인 불가'} · ${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[environment.runtime?.platform] ?? '운영체제 확인 필요'} · wax ${environment.version}` : environmentFailed ? t('workflowDemo.couldntCheckTheRuntime') : t('workflowDemo.checkingRuntimeEnvironment');
  $('demo-project-root').textContent = environment ? `${environment.project} · ${environment.root}` : environmentFailed ? t('workflowDemo.checkTheDashboardConnection') : t('workflowDemo.checkingWorkingFolder');
  clear($('demo-environment-tools')).append(...TOOLS.map((tool) => el('div', { class: 'demo-environment-tool' },
    el('span', { text: tool.label }), el('span', { class: 'kind', text: toolStatus === 'checking' ? t('workflowDemo.checking') : toolStatus === 'failed' ? t('workflowDemo.checkFailed') : installed.get(tool.kind)?.installed ? installed.get(tool.kind).version : t('workflowDemo.installNotConfirmed') }))));
}
function renderStartCommands() {
  const kind = $('demo-start-tool').value;
  clear($('demo-start-commands')).append(commandLine(t('workflowDemo.gettingStarted'), commandFor(kind, 'init'), t('workflowDemo.runInASession')), commandLine(t('workflowDemo.joinFromAnotherSession'), commandFor(kind, 'join'), t('workflowDemo.joinAnAlreadyStarted')));
}
clear($('demo-start-tool')).append(...TOOLS.map((tool) => el('option', { value: tool.kind, text: tool.label })));
$('demo-start-tool').addEventListener('change', renderStartCommands);
renderStartCommands(); renderEnvironment();
if (location.hash === '#demo-environment') $('demo-environment').open = true;
function renderTools() {
  const query = $('demo-tool-search').value.trim().toLowerCase();
  const rolesFor = (tool) => demoScenario(options).team.filter((person) => person.kind === tool.kind).map((person) => person.role).join(' · ');
  clear($('demo-tools')).append(...TOOLS.filter((tool) => `${tool.label} ${rolesFor(tool)}`.toLowerCase().includes(query)).map((tool) => {
    const local = installed.get(tool.kind);
    return el('article', { class: 'demo-tool' }, el('div', { class: 'agent-head' }, icon('implement'), el('strong', { text: tool.label })),
      el('p', { class: 'kind', text: toolStatus === 'checking' ? t('workflowDemo.checkingInstallStatus') : toolStatus === 'failed' ? t('workflowDemo.installStatusCheckFailed') : local?.installed ? `설치됨 · ${local.version ?? '버전 확인 필요'}` : t('workflowDemo.installNotConfirmedOn') }),
      el('p', { class: 'kind', text: rolesFor(tool) ? t('workflowDemo.demoAssignment', rolesFor(tool)) : t('workflowDemo.notAssignedInThis') }),
      el('button', { type: 'button', class: 'link', text: t('workflowDemo.usageGuide'), onclick: () => {
        stop(); render(); $('demo-dialog-title').textContent = t('workflowDemo.usageGuide2', tool.label);
        const body = $('demo-dialog-body'); clear(body).append(el('p', { text: t('workflowDemo.commandsToRunIn') }),
          ...[['join', t('workflowDemo.joinTeam')], ['work', t('workflowDemo.workOnAnAssignment')], ['status', t('workflowDemo.checkProgress')], ['daily', t('workflowDemo.dailyReport')]].map(([command, name]) => commandLine(name, commandFor(tool.kind, command), '')));
        $('demo-dialog').showModal();
      } }));
  }));
  if (!$('demo-tools').children.length) $('demo-tools').append(el('p', { class: 'empty', text: t('workflowDemo.noMatchingTools') }));
}
$('demo-tool-search').addEventListener('input', renderTools);
$('demo-current-action').addEventListener('click', () => {
  const view = demoSnapshot(position, options);
  if (view.index === 0 || view.step.done) { position = 0; playing = true; render(); schedule(); }
  else if (view.unresolved) inspect(t('workflowDemo.failedExecutionEvidence'), demoProof('fail', view.task));
  else if (view.step.phase < 2) officeAction('board');
  else if (view.step.phase === 4) officeAction('report');
  else officeAction('agent', view.step.actor);
});
$('demo-focus').addEventListener('click', () => {
  const focused = $('demo-root').classList.toggle('demo-focus-mode');
  $('demo-focus').setAttribute('aria-pressed', String(!focused));
  $('demo-focus').textContent = focused ? t('workflowDemo.viewAll') : t('workflowDemo.viewCurrentFlowOnly');
  document.querySelectorAll('.demo-expandable').forEach((node) => { node.open = !focused; });
});
for (const details of document.querySelectorAll('.demo-expandable, .demo-setup')) details.addEventListener('toggle', () => { if (details.open && playing) { stop(); render(); } });
document.addEventListener('focusin', (event) => { if (playing && event.target.closest('.demo-expandable, .demo-setup')) pausePlayback(); });
$('office-frame').addEventListener('load', () => post({ type: 'wax-demo-ping' }));
$('demo-office-retry').addEventListener('click', () => { pausePlayback(); officeReady = false; $('demo-office-status').textContent = t('workflowDemo.reloadingCharacters'); render(); $('office-frame').src = '/office?embed=1&demo=1'; });
renderModelSettings(); renderTools(); render();
post({ type: 'wax-demo-ping' });
api('/api/tools').then(({ tools }) => { installed = new Map(tools.map((tool) => [tool.kind, tool])); toolStatus = 'ready'; renderTools(); renderEnvironment(); }).catch(() => { toolStatus = 'failed'; renderTools(); renderEnvironment(); });

api('/api/config').then((config) => { environment = config; renderEnvironment(); }).catch(() => { environmentFailed = true; renderEnvironment(); });
