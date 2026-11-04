import { t } from './messages-catalog.mjs';
export const DEMO_PHASES = [t('workflowDemoModel.plan'), t('workflowDemoModel.design'), t('workflowDemoModel.implement'), t('workflowDemoModel.review'), t('workflowDemoModel.report')];
export const DEMO_MILESTONES = [
  { alias: t('workflowDemoModel.seed'), suffix: 'SEED', criterion: t('workflowDemoModel.acceptanceCriteriaAndVerification') },
  { alias: t('workflowDemoModel.blueprint'), suffix: 'MAP', criterion: t('workflowDemoModel.uxAndInterfaceDesign') },
  { alias: t('workflowDemoModel.assembly'), suffix: 'BUILD', criterion: t('workflowDemoModel.implementationAndRepeatedTests') },
  { alias: t('workflowDemoModel.gate'), suffix: 'GATE', criterion: t('workflowDemoModel.independentReviewAndRegression') },
  { alias: t('workflowDemoModel.launch'), suffix: 'SHIP', criterion: t('workflowDemoModel.reportAndPmFinal') },
];
export const DEMO_PHASE_KEYS = ['plan', 'design', 'implement', 'review', 'report'];
export const DEMO_TASKS = {
  ui: { title: t('workflowDemoModel.alignMobileStatisticsCards'), scope: 'ui', api: false, data: false, sensitive: false, parallel: false },
  feature: { title: t('workflowDemoModel.addTaskSearchAnd'), scope: 'feature', api: true, data: false, sensitive: false, parallel: true },
  system: { title: t('workflowDemoModel.preventDuplicatePaymentRequests'), scope: 'system', api: true, data: true, sensitive: true, parallel: true },
};
export const DEMO_TEAM = [
  { author: 'PM', kind: 'human', role: 'PM', phases: [0, 4] },
  { author: 'planner', kind: 'claude', role: t('workflowDemoModel.plan'), phases: [0] },
  { author: 'ux', kind: 'gemini', role: t('workflowDemoModel.uxDesign'), phases: [0, 1] },
  { author: 'frontend', kind: 'claude', role: t('workflowDemoModel.frontend'), phases: [2] },
  { author: 'backend', kind: 'claude', role: t('workflowDemoModel.backend'), phases: [1, 2] },
  { author: 'qa', kind: 'gemini', role: t('workflowDemoModel.qaTests'), phases: [2, 3] },
  { author: 'reviewer', kind: 'codex', role: t('workflowDemoModel.codeReview'), phases: [3] },
  { author: 'docs', kind: 'claude', role: t('workflowDemoModel.docsReporting'), phases: [4] },
];
export const DEMO_KIND_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', antigravity: 'Antigravity', grok: 'Grok', human: t('workflowDemoModel.ceo') };
export function assessDemoTask(input = DEMO_TASKS.system) {
  const scope = ['ui', 'feature', 'system'].includes(input?.scope) ? input.scope : 'ui';
  let score = { ui: 1, feature: 2, system: 3 }[scope];
  const reasons = [scope === 'ui' ? t('workflowDemoModel.uiFocusedChange') : scope === 'feature' ? t('workflowDemoModel.featureLevelChange') : t('workflowDemoModel.changeAcrossSeveralComponents')];
  for (const [key, points, reason] of [['api', 2, t('workflowDemoModel.apiIntegration')], ['data', 2, t('workflowDemoModel.dataChanges')], ['sensitive', 3, t('workflowDemoModel.highImpactBehaviorSuch')], ['parallel', 1, t('workflowDemoModel.parallelImplementationAndIntegration')]]) {
    if (input?.[key] === true) { score += points; reasons.push(reason); }
  }
  const level = score <= 2 ? 'low' : score <= 6 ? 'medium' : 'high';
  return { level, label: { low: t('workflowDemoModel.low'), medium: t('workflowDemoModel.average'), high: t('workflowDemoModel.high') }[level], score, reasons };
}
export function normalizeDemoOptions(options = {}) {
  const source = options?.task ?? DEMO_TASKS.system;
  const scope = ['ui', 'feature', 'system'].includes(source.scope) ? source.scope : 'system';
  const task = { scope, title: DEMO_TASKS[scope].title, ...Object.fromEntries(['api', 'data', 'sensitive', 'parallel'].map((key) => [key, source[key] === true])) };
  const models = {};
  for (const person of DEMO_TEAM.filter((p) => p.kind !== 'human')) {
    const selected = options?.models?.[person.author];
    models[person.author] = { kind: ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'grok'].includes(selected?.kind) ? selected.kind : person.kind,
      model: typeof selected?.model === 'string' ? selected.model.trim().slice(0, 60) : '' };
  }
  return { task, models };
}

export const DEMO_STEPS = [
  { phase: 0, actor: 'PM', title: t('workflowDemoModel.prepareTheTaskAnd'), state: t('workflowDemoModel.ready'), detail: t('workflowDemoModel.theTeamIsReady'), action: t('workflowDemoModel.selectCharactersAndWhiteboards') },
  { phase: 0, actor: 'PM', title: t('workflowDemoModel.assignWorkByRole'), detail: t('workflowDemoModel.assignOwnersAndAcceptance') },
  { phase: 0, actor: 'planner', title: t('workflowDemoModel.defineThePlanAnd'), checkpoint: 0, detail: t('workflowDemoModel.clarifyTheProblemUser'), type: 'decision' },
  { phase: 1, actor: 'ux', title: t('workflowDemoModel.designUxAndError'), detail: t('workflowDemoModel.inDesignRoomB1') },
  { phase: 1, actor: 'backend', title: t('workflowDemoModel.designInterfacesAndData'), checkpoint: 1, detail: t('workflowDemoModel.agreeOnFrontendApi'), requires: 'backend', type: 'decision' },
  { phase: 2, actor: 'frontend', title: t('workflowDemoModel.beginTheUiImplementation'), detail: t('workflowDemoModel.buildTheUiAnd') },
  { phase: 2, actor: 'backend', title: t('workflowDemoModel.implementTheServerIn'), detail: t('workflowDemoModel.implementRequestProcessingAnd'), requires: 'backend' },
  { phase: 2, actor: 'qa', title: t('workflowDemoModel.prepareQaScenarios'), detail: t('workflowDemoModel.coverNormalBehaviorBoundaries') },
  { phase: 2, actor: 'qa', title: t('workflowDemoModel.firstIntegrationTestFails'), detail: t('workflowDemoModel.rapidRepeatedActionsAnd'), state: t('workflowDemoModel.blocked'), proof: 'fail' },
  { phase: 2, actor: 'qa', title: t('workflowDemoModel.askAboutTheFailure'), detail: t('workflowDemoModel.postTheFailingOutput'), type: 'question' },
  { phase: 2, actor: 'backend', title: t('workflowDemoModel.fixTheServerIssue'), detail: t('workflowDemoModel.correctDuplicateRequestHandling'), requires: 'backend', type: 'answer' },
  { phase: 2, actor: 'frontend', title: t('workflowDemoModel.fixUiRecovery'), detail: t('workflowDemoModel.showProgressEarlyAnd'), type: 'answer' },
  { phase: 2, actor: 'qa', title: t('workflowDemoModel.repeatedTestsPass'), checkpoint: 2, detail: t('workflowDemoModel.allScenariosPassIncluding'), proof: 'pass' },
  { phase: 3, actor: 'reviewer', title: t('workflowDemoModel.independentCodeReview'), detail: t('workflowDemoModel.aSeparateReviewerChecks') },
  { phase: 3, actor: 'reviewer', title: t('workflowDemoModel.reviewQuestionsAndImpact'), detail: t('workflowDemoModel.askAboutRegressionRisks'), type: 'question' },
  { phase: 3, actor: 'frontend', title: t('workflowDemoModel.regressionEvidenceAndAnswers'), detail: t('workflowDemoModel.answerReviewQuestionsWith'), type: 'answer' },
  { phase: 3, actor: 'reviewer', title: t('workflowDemoModel.reviewPassedDecisionRecorded'), checkpoint: 3, detail: t('workflowDemoModel.confirmAcceptanceCriteriaAnd'), type: 'decision' },
  { phase: 4, actor: 'docs', title: t('workflowDemoModel.reportChangesAndEvidence'), detail: t('workflowDemoModel.summarizeImplementationFailuresFixes') },
  { phase: 4, actor: 'PM', title: t('workflowDemoModel.finalCheckAndTask'), checkpoint: 4, detail: t('workflowDemoModel.thePmCheckedThe'), done: true },
];
export function demoScenario(options = {}) {
  const normalized = normalizeDemoOptions(options), assessment = assessDemoTask(normalized.task);
  const included = assessment.level === 'high' ? DEMO_TEAM : DEMO_TEAM.filter((person) => !['planner', 'docs', ...(assessment.level === 'low' ? ['backend', 'qa'] : [])].includes(person.author));
  const members = new Set(included.map((p) => p.author));
  const replacement = { planner: 'ux', docs: 'frontend', qa: 'reviewer' };
  const steps = DEMO_STEPS.filter((step) => !step.requires || members.has(step.requires)).map((step) => ({ ...step, actor: members.has(step.actor) ? step.actor : replacement[step.actor] ?? 'frontend', ...(!members.has('backend') && step.title === 'UX·오류 상태 설계' ? { checkpoint: 1 } : {}) }));
  const team = included.map((person) => ({ ...person, ...(person.kind === 'human' ? {} : normalized.models[person.author]),
    phases: [...new Set([...person.phases, ...(assessment.level !== 'high' && person.author === 'frontend' ? [4] : []), ...(assessment.level === 'low' && person.author === 'reviewer' ? [2] : [])])],
    role: assessment.level !== 'high' && person.author === 'ux' ? t('workflowDemoModel.planningUxDesign') : assessment.level === 'low' && person.author === 'reviewer' ? t('workflowDemoModel.qaCodeReview') : person.role }));
  return { ...normalized, assessment, steps, team };
}
export function demoSnapshot(position, options = {}) {
  const scenario = demoScenario(options), steps = scenario.steps;
  const index = Math.min(steps.length - 1, Math.max(0, Math.trunc(Number(position)) || 0));
  const step = steps[index];
  const events = steps.slice(1, index + 1).map((event, offset) => ({ ...event, index: offset + 1 }));
  const tests = events.filter((event) => event.proof);
  const team = scenario.team.map((person) => {
    let state = 'idle';
    if (index > 0 && !step.done) {
      if (step.phase === 0 && ['planner', 'ux'].includes(person.author)) state = 'discussing';
      if (step.phase === 1 && ['ux', 'backend'].includes(person.author)) state = 'working';
      if (step.phase === 2 && ['frontend', 'backend'].includes(person.author)) state = 'working';
      if (step.phase === 2 && person.author === 'qa' && events.some((event) => event.actor === 'qa')) state = 'reviewing';
      if (step.phase === 3 && ['qa', 'reviewer'].includes(person.author)) state = 'reviewing';
      if (step.phase === 4 && person.author === step.actor) state = 'discussing';
      if (step.actor === person.author && state === 'idle') state = person.kind === 'human' ? 'discussing' : ['qa', 'reviewer'].includes(person.author) ? 'reviewing' : 'working';
    }
    return { ...person, state, note: step.actor === person.author ? step.title : state === 'idle' ? t('workflowDemoModel.waitingForAssignedStage') : t('workflowDemoModel.collaborating', DEMO_PHASES[step.phase]) };
  });
  const prefix = { ui: 'UX', feature: 'FTR', system: 'PAY' }[scenario.task.scope];
  const milestones = DEMO_MILESTONES.map((milestone, phase) => {
    const evidence = events.find((event) => event.checkpoint === phase);
    return { ...milestone, phase, code: `${prefix}-M${phase + 1}-${milestone.suffix}`, reached: Boolean(evidence), evidence: evidence ?? null };
  });
  return { ...scenario, team, index, step, events, tests, milestones, nextMilestone: milestones.find((milestone) => !milestone.reached) ?? null,
    passed: tests.filter((event) => event.proof === 'pass').length, failed: tests.filter((event) => event.proof === 'fail').length,
    unresolved: tests.at(-1)?.proof === 'fail',
    phases: DEMO_PHASES.map((label, phase) => ({ label, phase,
      state: step.done || phase < step.phase ? 'done' : phase > step.phase || index === 0 ? 'pending' : step.state === '막힘' ? 'blocked' : 'current',
      events: events.filter((event) => event.phase === phase),
      assignees: team.filter((person) => person.phases.includes(phase) || (scenario.assessment.level !== 'high' && phase === 0 && person.author === 'ux') || (scenario.assessment.level === 'low' && phase === 2 && person.author === 'reviewer') || (scenario.assessment.level !== 'high' && phase === 4 && person.author === 'frontend')),
    })),
  };
}
export function demoProof(result, task = DEMO_TASKS.system) {
  return `[가상 데모 · 실제 실행이 아닌 예시]\n작업: ${task.title}\n명령: node --test sample/workflow.test.mjs\n\n${result === 'fail' ? '✖ 경계 조건·오류 복구\nExpected: 수용 기준 충족\nReceived: 경계 조건에서 잘못된 상태\n\n종료 코드: 1\n다음 행동: 실패 원인 수정 후 재실행' : '✔ 정상 동작\n✔ 경계 조건\n✔ 오류 후 재시도\n\n테스트: 3개 통과\n종료 코드: 0'}`;
}
export function demoOfficeSnapshot(position, options = {}, now = Date.now()) {
  const view = demoSnapshot(position, options), iso = (index) => new Date(now - (view.index - index) * 30_000).toISOString();
  const phase = view.step.done ? 'done' : DEMO_PHASE_KEYS[view.step.phase];
  const notes = view.events.map((event) => {
    const question = view.events.filter((prior) => prior.index < event.index && prior.type === 'question').at(-1);
    return { id: `n-${String(event.index).padStart(6, '0')}-000000`, seq: event.index, author: event.actor,
      kind: view.team.find((person) => person.author === event.actor)?.kind ?? 'other', phase: DEMO_PHASE_KEYS[event.phase], type: event.type ?? 'opinion',
      body: t('workflowDemoModel.virtualDemo', event.title, event.detail), at: iso(event.index), replyTo: event.type === 'answer' && question ? `n-${String(question.index).padStart(6, '0')}-000000` : null };
  });
  const agents = view.team.map((person) => ({ ...person, effectiveState: person.state, feature: 'demo-work', lastActive: new Date(now).toISOString(), stateAt: iso(view.index) }));
  const tasks = view.team.filter((person) => person.kind !== 'human').map((person, index) => ({ id: `t-${String(index + 1).padStart(6, '0')}-000000`, feature: 'demo-work', to: person.author,
    phase: DEMO_PHASE_KEYS[person.phases.includes(view.step.phase) ? view.step.phase : person.phases[0]], by: 'PM', kind: 'human', status: view.step.done || Math.max(...person.phases) < view.step.phase ? 'done' : person.state === 'idle' ? 'open' : view.unresolved && person.author === 'frontend' ? 'blocked' : 'accepted',
    note: t('workflowDemoModel.virtualDemo2', person.role), at: iso(0), updates: [] }));
  const profiles = view.team.map((person) => {
    const mine = view.events.filter((event) => event.actor === person.author);
    const labels = [t('workflowDemoModel.planningDesign'), t('workflowDemoModel.implement'), t('workflowDemoModel.review'), t('workflowDemoModel.tests'), t('workflowDemoModel.communication'), t('workflowDemoModel.report')];
    const keys = ['plan', 'build', 'review', 'test', 'talk', 'report'];
    return { author: person.author, kind: person.kind, level: 1 + Math.floor(mine.length / 2), firstAt: iso(0), lastAt: iso(view.index),
      summary: t('workflowDemoModel.virtualDemoHandledBy', person.role),
      axes: keys.map((key, index) => { const value = mine.filter((event) => index === 0 ? event.phase < 2 : index === 1 ? event.phase === 2 && !event.proof : index === 2 ? event.phase === 3 : index === 3 ? event.proof : index === 4 ? event.type : event.phase === 4).length;
        return { key, label: labels[index], value, score: Math.min(90, 50 + value * 7), grade: value >= 3 ? t('workflowDemoModel.strong') : t('workflowDemoModel.average') }; }),
      badges: [{ id: 'first', icon: '✓', label: t('workflowDemoModel.firstContribution'), desc: t('workflowDemoModel.firstDemoActivity'), progress: mine.length ? 1 : 0, goal: 1, earned: mine.length > 0 }],
      metrics: { bugRate: mine.some((event) => event.proof === 'fail') ? .5 : null, bugsFound: mine.filter((event) => event.proof === 'fail').length, commits: 0, workMs: mine.length * 30_000, tasksDone: tasks.filter((task) => task.to === person.author && task.status === 'done').length, tests: mine.filter((event) => event.proof).length },
      counts: { assigned: view.team.length - 1, tasksDone: view.step.done ? 1 : 0, testsPassed: view.passed, testsFailed: view.failed } };
  });
  const room = view.index === 0 || view.step.done ? 'roof' : ['qa', 'reviewer'].includes(view.step.actor) ? 'lab' : view.step.phase === 0 ? 'meeting' : view.step.phase === 1 ? 'studio' : view.step.phase === 4 ? 'boss' : 'dev';
  return { view, room, agents, profiles, tasks, notes,
    features: [{ id: 'demo-work', title: t('workflowDemoModel.virtualDemo2', view.task.title), phase, iteration: 0, updatedAt: iso(view.index) }],
    messages: view.events.map((event) => ({ id: `m-${String(event.index).padStart(6, '0')}-000000`, author: event.actor, kind: agents.find((a) => a.author === event.actor)?.kind,
      type: event.type ?? 'opinion', body: t('workflowDemoModel.virtualDemo2', event.detail), at: iso(event.index), to: event.phase === 4 ? ['PM'] : [] })),
    reports: view.events.filter((event) => event.phase === 4 && event.actor !== 'PM').map((event, index) => ({ id: `r-${index + 1}`, number: index + 1, author: event.actor, at: iso(event.index), noteCount: notes.length, path: 'demo/report.md' })),
  };
}

export function demoReleasePlan(view, { version = '0.2.0', dates = {} } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.length > 40) throw new Error(t('workflowDemoModel.enterATargetVersion'));
  const suffixes = ['plan.1', 'alpha.1', 'beta.1', 'rc.1', ''];
  const checkpoints = view.milestones.map((milestone, index) => ({ ...milestone,
    version: `${version}${suffixes[index] ? `-${suffixes[index]}` : ''}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(dates[index] ?? '') ? dates[index] : '',
    owners: view.phases[index].assignees.map((person) => person.role),
  }));
  const reached = checkpoints.filter((checkpoint) => checkpoint.reached);
  return { version, checkpoints, ready: reached.length === checkpoints.length, reached: reached.length,
    currentVersion: reached.at(-1)?.version ?? t('workflowDemoModel.notPlanned'), remaining: checkpoints.filter((checkpoint) => !checkpoint.reached) };
}
