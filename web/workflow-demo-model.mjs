export const DEMO_PHASES = ['기획', '설계', '구현', '검토', '보고'];
export const DEMO_MILESTONES = [
  { alias: '씨앗', suffix: 'SEED', criterion: '수용 기준·검증 방법 확정' },
  { alias: '청사진', suffix: 'MAP', criterion: 'UX·인터페이스 설계 합의' },
  { alias: '조립', suffix: 'BUILD', criterion: '구현 후 테스트 재실행 통과' },
  { alias: '관문', suffix: 'GATE', criterion: '독립 리뷰·회귀 검증 통과' },
  { alias: '출항', suffix: 'SHIP', criterion: '보고서와 PM 최종 확인' },
];
export const DEMO_PHASE_KEYS = ['plan', 'design', 'implement', 'review', 'report'];
export const DEMO_TASKS = {
  ui: { title: '모바일 통계 카드 정렬', scope: 'ui', api: false, data: false, sensitive: false, parallel: false },
  feature: { title: '작업 검색·필터 추가', scope: 'feature', api: true, data: false, sensitive: false, parallel: true },
  system: { title: '결제 중복 요청 방지', scope: 'system', api: true, data: true, sensitive: true, parallel: true },
};
export const DEMO_TEAM = [
  { author: 'PM', kind: 'human', role: 'PM', phases: [0, 4] },
  { author: 'planner', kind: 'claude', role: '기획', phases: [0] },
  { author: 'ux', kind: 'gemini', role: 'UX·설계', phases: [0, 1] },
  { author: 'frontend', kind: 'claude', role: '프론트엔드', phases: [2] },
  { author: 'backend', kind: 'claude', role: '백엔드', phases: [1, 2] },
  { author: 'qa', kind: 'gemini', role: 'QA·테스트', phases: [2, 3] },
  { author: 'reviewer', kind: 'codex', role: '코드 리뷰', phases: [3] },
  { author: 'docs', kind: 'claude', role: '문서·보고', phases: [4] },
];
export const DEMO_KIND_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', antigravity: 'Antigravity', human: '사용자' };
export function assessDemoTask(input = DEMO_TASKS.system) {
  const scope = ['ui', 'feature', 'system'].includes(input?.scope) ? input.scope : 'ui';
  let score = { ui: 1, feature: 2, system: 3 }[scope];
  const reasons = [scope === 'ui' ? '화면 중심의 변경' : scope === 'feature' ? '기능 단위의 변경' : '여러 구성 요소에 걸친 변경'];
  for (const [key, points, reason] of [['api', 2, 'API 연동'], ['data', 2, '데이터 변경'], ['sensitive', 3, '결제·인증 등 영향도가 큰 동작'], ['parallel', 1, '병렬 구현과 통합 검증']]) {
    if (input?.[key] === true) { score += points; reasons.push(reason); }
  }
  const level = score <= 2 ? 'low' : score <= 6 ? 'medium' : 'high';
  return { level, label: { low: '낮음', medium: '보통', high: '높음' }[level], score, reasons };
}
export function normalizeDemoOptions(options = {}) {
  const source = options?.task ?? DEMO_TASKS.system;
  const scope = ['ui', 'feature', 'system'].includes(source.scope) ? source.scope : 'system';
  const task = { scope, title: DEMO_TASKS[scope].title, ...Object.fromEntries(['api', 'data', 'sensitive', 'parallel'].map((key) => [key, source[key] === true])) };
  const models = {};
  for (const person of DEMO_TEAM.filter((p) => p.kind !== 'human')) {
    const selected = options?.models?.[person.author];
    models[person.author] = { kind: ['claude', 'codex', 'gemini', 'copilot', 'antigravity'].includes(selected?.kind) ? selected.kind : person.kind,
      model: typeof selected?.model === 'string' ? selected.model.trim().slice(0, 60) : '' };
  }
  return { task, models };
}

export const DEMO_STEPS = [
  { phase: 0, actor: 'PM', title: '작업과 팀 준비', state: '준비', detail: '역할에 필요한 인원을 구성했습니다. 재생하면 사무실에서 실제 UX를 체험할 수 있습니다.', action: '캐릭터·화이트보드를 눌러 보세요.' },
  { phase: 0, actor: 'PM', title: '역할별 업무 배정', detail: '기획·설계·구현·검증·보고의 담당자와 수용 기준을 배정합니다.' },
  { phase: 0, actor: 'planner', title: '기획과 수용 기준 정리', checkpoint: 0, detail: '문제, 사용자의 기대, 완료 조건과 검증 방법을 정리하고 UX 담당자와 논의합니다.', type: 'decision' },
  { phase: 1, actor: 'ux', title: 'UX·오류 상태 설계', detail: '정상 동작뿐 아니라 좁은 화면, 진행 중 상태와 실패 후 복구 동작을 설계합니다.' },
  { phase: 1, actor: 'backend', title: '인터페이스·데이터 설계', checkpoint: 1, detail: '프론트엔드와 API 계약, 데이터 변경 범위와 중복 요청 방지 기준을 합의합니다.', requires: 'backend', type: 'decision' },
  { phase: 2, actor: 'frontend', title: '화면 구현 시작', detail: 'UX 설계에 맞춰 화면과 진행·오류 상태를 구현합니다.' },
  { phase: 2, actor: 'backend', title: '서버 병렬 구현', detail: '화면 구현과 병렬로 요청 처리와 데이터 무결성을 구현합니다.', requires: 'backend' },
  { phase: 2, actor: 'qa', title: 'QA 시나리오 준비', detail: '일반 동작과 경계 조건, 실패 후 재시도 시나리오를 준비합니다.' },
  { phase: 2, actor: 'qa', title: '첫 통합 테스트 실패', detail: '빠른 연속 동작과 오류 복구에서 수용 기준을 충족하지 못했습니다.', state: '막힘', proof: 'fail' },
  { phase: 2, actor: 'qa', title: '실패 원인 질문', detail: '실패 출력과 재현 조건을 화이트보드에 남기고 구현 담당자에게 확인을 요청합니다.', type: 'question' },
  { phase: 2, actor: 'backend', title: '서버 원인 수정', detail: '중복 요청 처리와 상태 갱신 순서를 수정하고 원인을 설명합니다.', requires: 'backend', type: 'answer' },
  { phase: 2, actor: 'frontend', title: '화면 복구 처리 수정', detail: '진행 상태를 먼저 반영하고, 실패 후 재시도할 수 있도록 수정합니다.', type: 'answer' },
  { phase: 2, actor: 'qa', title: '재실행 테스트 통과', checkpoint: 2, detail: '경계 조건과 오류 복구를 포함한 시나리오가 모두 통과했습니다.', proof: 'pass' },
  { phase: 3, actor: 'reviewer', title: '독립 코드 리뷰', detail: '구현 담당자와 별도로 수용 기준, 변경 코드와 실행 근거를 검토합니다.' },
  { phase: 3, actor: 'reviewer', title: '검토 질문·영향 범위 확인', detail: '기존 동작의 회귀 가능성과 테스트가 빠진 경로를 구현 담당자에게 질문합니다.', type: 'question' },
  { phase: 3, actor: 'frontend', title: '회귀 근거와 답변', detail: '영향 범위와 추가로 확인한 근거를 제시해 검토 질문에 답합니다.', type: 'answer' },
  { phase: 3, actor: 'reviewer', title: '리뷰 통과·결정 기록', checkpoint: 3, detail: '수용 기준과 회귀 검증을 확인하고 검토를 통과시킵니다.', type: 'decision' },
  { phase: 4, actor: 'docs', title: '변경 내용·근거 보고', detail: '구현 내용, 실패와 수정, 검증 근거와 남은 제한을 보고서에 정리합니다.' },
  { phase: 4, actor: 'PM', title: '최종 확인·작업 완료', checkpoint: 4, detail: 'PM이 결과를 확인했습니다. 담당자 카드·화이트보드·보고서를 열어 전체 이력을 살펴보세요.', done: true },
];
export function demoScenario(options = {}) {
  const normalized = normalizeDemoOptions(options), assessment = assessDemoTask(normalized.task);
  const included = assessment.level === 'high' ? DEMO_TEAM : DEMO_TEAM.filter((person) => !['planner', 'docs', ...(assessment.level === 'low' ? ['backend', 'qa'] : [])].includes(person.author));
  const members = new Set(included.map((p) => p.author));
  const replacement = { planner: 'ux', docs: 'frontend', qa: 'reviewer' };
  const steps = DEMO_STEPS.filter((step) => !step.requires || members.has(step.requires)).map((step) => ({ ...step, actor: members.has(step.actor) ? step.actor : replacement[step.actor] ?? 'frontend', ...(!members.has('backend') && step.title === 'UX·오류 상태 설계' ? { checkpoint: 1 } : {}) }));
  const team = included.map((person) => ({ ...person, ...(person.kind === 'human' ? {} : normalized.models[person.author]),
    phases: [...new Set([...person.phases, ...(assessment.level !== 'high' && person.author === 'frontend' ? [4] : []), ...(assessment.level === 'low' && person.author === 'reviewer' ? [2] : [])])],
    role: assessment.level !== 'high' && person.author === 'ux' ? '기획·UX·설계' : assessment.level === 'low' && person.author === 'reviewer' ? 'QA·코드 리뷰' : person.role }));
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
      if (step.phase < 2 && ['planner', 'ux', ...(step.phase === 1 ? ['backend'] : [])].includes(person.author)) state = 'discussing';
      if (step.phase === 2 && ['frontend', 'backend'].includes(person.author)) state = 'working';
      if (step.phase === 2 && person.author === 'qa' && events.some((event) => event.actor === 'qa')) state = 'reviewing';
      if (step.phase === 3 && ['qa', 'reviewer'].includes(person.author)) state = 'reviewing';
      if (step.phase === 4 && person.author === step.actor) state = 'discussing';
      if (step.actor === person.author && state === 'idle') state = person.kind === 'human' ? 'discussing' : ['qa', 'reviewer'].includes(person.author) ? 'reviewing' : 'working';
    }
    return { ...person, state, note: step.actor === person.author ? step.title : state === 'idle' ? '담당 단계 대기' : `${DEMO_PHASES[step.phase]} 협업 중` };
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
      body: `[가상 데모] ${event.title}\n${event.detail}`, at: iso(event.index), replyTo: event.type === 'answer' && question ? `n-${String(question.index).padStart(6, '0')}-000000` : null };
  });
  const agents = view.team.map((person) => ({ ...person, effectiveState: person.state, feature: 'demo-work', lastActive: new Date(now).toISOString(), stateAt: iso(view.index) }));
  const tasks = view.team.filter((person) => person.kind !== 'human').map((person, index) => ({ id: `t-${String(index + 1).padStart(6, '0')}-000000`, feature: 'demo-work', to: person.author,
    phase: DEMO_PHASE_KEYS[person.phases.includes(view.step.phase) ? view.step.phase : person.phases[0]], by: 'PM', kind: 'human', status: view.step.done || Math.max(...person.phases) < view.step.phase ? 'done' : person.state === 'idle' ? 'open' : view.unresolved && person.author === 'frontend' ? 'blocked' : 'accepted',
    note: `[가상 데모] ${person.role}`, at: iso(0), updates: [] }));
  const profiles = view.team.map((person) => {
    const mine = view.events.filter((event) => event.actor === person.author);
    const labels = ['기획·설계', '구현', '검토', '테스트', '소통', '보고'];
    const keys = ['plan', 'build', 'review', 'test', 'talk', 'report'];
    return { author: person.author, kind: person.kind, level: 1 + Math.floor(mine.length / 2), firstAt: iso(0), lastAt: iso(view.index),
      summary: `[가상 데모] ${person.role} 담당 · 시뮬레이션 기록으로 변화하는 예시 수치입니다.`,
      axes: keys.map((key, index) => { const value = mine.filter((event) => index === 0 ? event.phase < 2 : index === 1 ? event.phase === 2 && !event.proof : index === 2 ? event.phase === 3 : index === 3 ? event.proof : index === 4 ? event.type : event.phase === 4).length;
        return { key, label: labels[index], value, score: Math.min(90, 50 + value * 7), grade: value >= 3 ? '우수' : '보통' }; }),
      badges: [{ id: 'first', icon: '✓', label: '첫 기여', desc: '가상 데모 첫 기록', progress: mine.length ? 1 : 0, goal: 1, earned: mine.length > 0 }],
      metrics: { bugRate: mine.some((event) => event.proof === 'fail') ? .5 : null, bugsFound: mine.filter((event) => event.proof === 'fail').length, commits: 0, workMs: mine.length * 30_000, tasksDone: tasks.filter((task) => task.to === person.author && task.status === 'done').length, tests: mine.filter((event) => event.proof).length },
      counts: { assigned: view.team.length - 1, tasksDone: view.step.done ? 1 : 0, testsPassed: view.passed, testsFailed: view.failed } };
  });
  const room = view.index === 0 || view.step.done ? 'roof' : ['qa', 'reviewer'].includes(view.step.actor) ? 'lab' : view.step.phase < 2 ? 'meeting' : view.step.phase === 4 ? 'boss' : 'dev';
  return { view, room, agents, profiles, tasks, notes,
    features: [{ id: 'demo-work', title: `[가상 데모] ${view.task.title}`, phase, iteration: 0, updatedAt: iso(view.index) }],
    messages: view.events.map((event) => ({ id: `m-${String(event.index).padStart(6, '0')}-000000`, author: event.actor, kind: agents.find((a) => a.author === event.actor)?.kind,
      type: event.type ?? 'opinion', body: `[가상 데모] ${event.detail}`, at: iso(event.index), to: event.phase === 4 ? ['PM'] : [] })),
    reports: view.events.filter((event) => event.phase === 4 && event.actor !== 'PM').map((event, index) => ({ id: `r-${index + 1}`, number: index + 1, author: event.actor, at: iso(event.index), noteCount: notes.length, path: 'demo/report.md' })),
  };
}

export function demoReleasePlan(view, { version = '0.2.0', dates = {} } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.length > 40) throw new Error('목표 버전은 0.2.0처럼 입력하세요.');
  const suffixes = ['plan.1', 'alpha.1', 'beta.1', 'rc.1', ''];
  const checkpoints = view.milestones.map((milestone, index) => ({ ...milestone,
    version: `${version}${suffixes[index] ? `-${suffixes[index]}` : ''}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(dates[index] ?? '') ? dates[index] : '',
    owners: view.phases[index].assignees.map((person) => person.role),
  }));
  const reached = checkpoints.filter((checkpoint) => checkpoint.reached);
  return { version, checkpoints, ready: reached.length === checkpoints.length, reached: reached.length,
    currentVersion: reached.at(-1)?.version ?? '계획 전', remaining: checkpoints.filter((checkpoint) => !checkpoint.reached) };
}
