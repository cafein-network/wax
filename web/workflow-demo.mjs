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
  stop(); textIcon($('demo-play'), 'play', position === last() ? '다시 재생' : '재생');
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
  return portraits.has(person.author) ? el('img', { src: portraits.get(person.author), alt: `${person.role} 캐릭터`, width: size, height: size, class: 'demo-portrait' }) : icon('team', size);
}
function schedule() {
  clearTimeout(timer);
  if (!playing || position === last()) return;
  timer = setTimeout(() => { position++; if (position === last()) stop(); render(); schedule(); }, 4000 / Number($('demo-speed').value));
}
function jump(value) { stop(); position = demoSnapshot(value, options).index; render(); }
const status = { pending: '대기', current: '진행 중', done: '완료', blocked: '막힘' };
const agentStates = { idle: '대기', working: '작업 중', reviewing: '검증 중', discussing: '논의 중' };
function render() {
  const view = demoSnapshot(position, options), actor = view.team.find((person) => person.author === view.step.actor);
  textIcon($('demo-play'), playing ? 'pause' : 'play', playing ? '일시정지' : position === last() ? '다시 재생' : '재생');
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
  $('demo-duration').textContent = `약 ${last() * 4}초 · PM 1명 + AI ${view.team.length - 1}명`;
  $('demo-seek').max = String(last()); $('demo-seek').value = String(position);
  $('demo-seek').setAttribute('aria-valuetext', `${position} / ${last()} · ${view.step.title}`);
  textIcon($('demo-state'), view.step.done ? 'passed' : view.step.state === '막힘' ? 'failed' : DEMO_PHASE_KEYS[view.step.phase], view.step.done ? '완료' : view.step.state ?? '진행 중');
  $('demo-state').className = `badge${view.step.state === '막힘' ? ' demo-warning' : ''}`;
  $('demo-flow-heading').textContent = view.task.title;
  $('demo-next-checkpoint').textContent = view.nextMilestone ? `다음 체크포인트 ${view.nextMilestone.code} · ${view.nextMilestone.alias} — ${view.nextMilestone.criterion}` : `마일스톤 ${view.milestones.length}/${view.milestones.length} 도달 · 출항 완료`;
  $('demo-team-heading').textContent = `전체 팀·담당자 ${view.team.length}명 · PM 1 + AI ${view.team.length - 1}`;
  const current = view.team.filter((person) => person.state !== 'idle' && person.kind !== 'human');
  clear($('demo-current-assignees')).append(...(current.length ? current : view.team.filter((person) => person.author === view.step.actor)).map((person) => el('button', {
    type: 'button', class: 'demo-assignee', disabled: !officeReady, 'aria-label': `현재 담당 ${label(person)} 카드`, onclick: () => officeAction('agent', person.author),
  }, portrait(person, 36), el('span', { text: person.role }))));
  const currentAction = view.index === 0 || view.step.done ? ['play', view.step.done ? '다시 재생' : '협업 시작'] : view.unresolved ? ['test', '실패 근거 확인'] : view.step.phase < 2 ? ['board', '화이트보드 확인'] : view.step.phase === 4 ? ['report', '결과 보고서 확인'] : ['team', '담당자 확인'];
  textIcon($('demo-current-action'), ...currentAction);
  $('demo-current-action').disabled = !officeReady;
  $('demo-title').textContent = `${label(actor)} · ${view.step.title}`;
  $('demo-detail').textContent = view.step.detail;
  $('demo-action').textContent = view.step.action ?? (view.unresolved ? '실패 근거와 화이트보드를 열어 담당자 간 질문·답변을 확인하세요.' : view.step.phase < 2 ? '회의실의 담당 캐릭터와 화이트보드를 눌러 보세요.' : view.step.phase === 4 ? '사장실의 보고 담당자와 결과 보고서를 확인하세요.' : '담당 캐릭터 카드에서 현재 상태·최근 메시지·검증 지표를 확인하세요.');
  clear($('demo-stats')).append(...[
    ['진행 단계', view.step.done ? '완료' : view.phases[view.step.phase].label, '단계별 담당 캐릭터'],
    ['활동 인원', `${view.team.filter((p) => p.kind !== 'human' && p.state !== 'idle').length} / ${view.team.length - 1}`, '활동 중 / 배정된 AI'],
    ['테스트', `${view.passed} / ${view.failed}`, '통과 / 실패 이력'],
    ['예상 난이도', view.assessment.label, `${view.assessment.score}점 · 작업 조건 기준`],
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
        el('span', { class: 'demo-phase-status icon-label' }, icon(milestone.reached ? 'passed' : state === 'blocked' ? 'failed' : DEMO_PHASE_KEYS[phase.phase], 14), milestone.reached ? '도달' : status[state]),
        el('span', { class: 'kind', text: `${phase.events.length}건 · ${milestone.criterion}` })),
      el('div', { class: 'demo-assignees' }, phase.assignees.map((person) => el('button', { type: 'button', class: 'demo-assignee', title: label(person), 'aria-label': `${phase.label} 담당 ${label(person)} 카드`, disabled: !officeReady, onclick: () => officeAction('agent', person.author) }, portrait(person, 28), el('span', { text: person.role })))));
  }));
  clear($('demo-team')).append(...view.team.map((person) => el('li', { class: person.state !== 'idle' ? 'demo-active-agent' : '' },
    el('button', { type: 'button', class: 'demo-person', disabled: !officeReady, 'aria-label': `${label(person)} 캐릭터 카드`, onclick: () => officeAction('agent', person.author) },
      portrait(person, 56), el('span', {}, el('strong', { text: person.role }), el('span', { class: 'kind', text: person.model || (person.kind === 'human' ? '대표 · PM' : `${DEMO_KIND_LABELS[person.kind]} · 기본 모델`) }))),
    el('div', { class: 'agent-head' }, el('span', { class: 'badge', text: view.step.done ? '완료' : agentStates[person.state] }), el('span', { class: 'kind', text: person.note })))));
  clear($('demo-proofs')).append(...(view.tests.length ? view.tests.slice().reverse().map((event) => el('div', { class: 'demo-proof' },
    el('div', { class: 'agent-head' }, icon(event.proof === 'pass' ? 'passed' : 'failed'), el('strong', { text: event.proof === 'pass' ? '재실행 통과' : '첫 테스트 실패' }), el('span', { class: 'kind', text: '가상 근거' })),
    el('button', { type: 'button', class: 'link icon-label', 'aria-label': `${event.proof === 'pass' ? '통과' : '실패'} 실행 근거 보기`, onclick: () => inspect(event.title, demoProof(event.proof, view.task)) }, icon('test'), '실행 근거 보기')))
    : [el('p', { class: 'empty', text: 'QA가 테스트를 시작하면 근거가 나타납니다.' })]));
  clear($('demo-events')).append(...(view.events.length ? view.events.slice().reverse().map((event) => el('li', { class: `event${event.proof === 'fail' ? ' failed' : ''}` },
    el('span', { class: 'when' }, icon(event.proof ? event.proof === 'pass' ? 'passed' : 'failed' : DEMO_PHASE_KEYS[event.phase]), el('span', { text: String(event.index).padStart(2, '0') })),
    el('div', {}, el('div', { class: 'event-head' }, el('span', { class: 'badge', text: view.team.find((p) => p.author === event.actor).role }), el('button', { type: 'button', class: 'link', text: event.title, onclick: () => jump(event.index) })), el('p', { class: 'detail', text: event.detail }))))
    : [el('li', { class: 'empty', text: '재생하면 담당자의 협업 기록이 쌓입니다.' })]));
  $('demo-open-assignee').disabled = !officeReady;
  $('demo-open-board').disabled = !officeReady;
  $('demo-open-proof').disabled = !view.tests.length;
  $('demo-open-report').disabled = !officeReady || !view.events.some((event) => event.phase === 4 && event.actor !== 'PM');
  renderPreview(view); renderRelease(view); syncOffice();
}
function renderRelease(view) {
  const plan = demoReleasePlan(view, releaseOptions);
  $('demo-release-status').textContent = plan.ready ? `정식 ${plan.version} 준비 완료 · 마일스톤 5/5 도달` : `현재 ${plan.currentVersion} · ${plan.reached}/5 도달 · 다음 조건: ${plan.remaining[0].criterion}`;
  clear($('demo-release-plan')).append(...plan.checkpoints.map((checkpoint) => {
    const date = el('input', { type: 'date', value: checkpoint.date, 'aria-label': `${checkpoint.alias} 목표일` });
    const saveDate = () => { releaseOptions.dates[checkpoint.phase] = date.value; };
    date.addEventListener('input', saveDate); date.addEventListener('change', saveDate);
    return el('li', { class: checkpoint.reached ? 'is-reached' : '' },
      el('div', { class: 'agent-head' }, icon(checkpoint.reached ? 'passed' : DEMO_PHASE_KEYS[checkpoint.phase]), el('strong', { text: `${checkpoint.alias} · ${checkpoint.version}` })),
      el('p', { class: 'kind', text: `${checkpoint.code} · ${checkpoint.criterion}` }),
      el('p', { class: 'kind', text: `담당: ${checkpoint.owners.join(' · ')}` }),
      el('div', { class: 'demo-release-row' }, el('label', {}, '목표일 ', date),
        el('button', { type: 'button', class: 'link', disabled: !checkpoint.reached, text: checkpoint.reached ? '도달 시점·근거 보기' : '조건 충족 대기', onclick: () => jump(checkpoint.evidence.index) })));
  }));
}
$('demo-release-version').addEventListener('input', () => {
  const input = $('demo-release-version');
  try { demoReleasePlan(demoSnapshot(position, options), { version: input.value }); releaseOptions.version = input.value; $('demo-release-error').hidden = true; input.setCustomValidity(''); renderRelease(demoSnapshot(position, options)); }
  catch (error) { $('demo-release-error').hidden = false; $('demo-release-error').textContent = error.message; input.setCustomValidity(error.message); }
});
function renderModelSettings() {
  const scenario = demoScenario(options);
  $('demo-assessment').textContent = `예상 난이도 ${scenario.assessment.label} (${scenario.assessment.score}점) · PM 1명 + AI ${scenario.team.length - 1}명\n판단 근거: ${scenario.assessment.reasons.join(' · ')}`;
  clear($('demo-models')).append(...scenario.team.filter((p) => p.kind !== 'human').map((person) => {
    const tool = el('select', { id: `demo-kind-${person.author}`, 'aria-label': `${person.role} 도구` }, TOOLS.map((item) => el('option', { value: item.kind, selected: person.kind === item.kind, text: item.label })));
    const model = el('input', { type: 'text', id: `demo-model-${person.author}`, value: person.model ?? '', maxlength: 60, placeholder: '기본 모델 사용', 'aria-label': `${person.role} 모델 ID` });
    const change = () => { options.models[person.author] = { kind: tool.value, model: model.value }; stop(); position = 0; render(); renderTools(); };
    tool.addEventListener('change', change); model.addEventListener('input', change); model.addEventListener('change', change);
    return el('div', { class: 'demo-model-setting' }, el('strong', { class: 'kind', text: person.role }), el('label', { for: tool.id, class: 'visually-hidden', text: '도구' }), tool, model);
  }));
}
function settingsChanged() {
  stop(); position = 0;
  options.task = { ...DEMO_TASKS[$('demo-task').value], ...Object.fromEntries(['api', 'data', 'sensitive', 'parallel'].map((key) => [key, $(`demo-risk-${key}`).checked])) };
  renderModelSettings(); render(); renderTools();
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== $('office-frame').contentWindow) return;
  if (event.data?.type === 'wax-demo-error') { officeReady = false; stop(); $('demo-office-status').textContent = '사무실 데모를 갱신하지 못했습니다.'; $('demo-office-retry').hidden = false; render(); }
  if (event.data?.type === 'wax-demo-ready') { officeReady = true; $('demo-office-retry').hidden = true; $('demo-office-status').textContent = '캐릭터·화이트보드 직접 체험'; render(); }
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
textIcon($('demo-prev'), 'previous', '이전 단계'); textIcon($('demo-next'), 'next', '다음 단계'); textIcon($('demo-reset'), 'reset', '다시 시작');
textIcon($('demo-open-assignee'), 'team', '현재 담당자 카드'); textIcon($('demo-open-board'), 'board', '화이트보드');
textIcon($('demo-open-proof'), 'test', '실행 근거'); textIcon($('demo-open-report'), 'report', '결과 보고서');
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); render(); } });
window.addEventListener('pagehide', () => { stop(); render(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) render(); });

function renderPreview(view) {
  const panel = clear($('demo-preview'));
  const revisions = view.events.filter((event) => ['frontend', 'backend'].includes(event.actor));
  $('demo-preview-version').textContent = `${view.index}번 시점 · 변경 ${revisions.length}회`;
  if (view.step.phase < 2) { panel.append(el('p', { class: 'empty', text: '구현이 시작되면 작업 화면 예시가 나타납니다. 이전 이력을 선택하면 해당 시점으로 돌아갑니다.' })); }
  else if (view.task.scope === 'system') {
    const count = el('p', { class: 'kind', role: 'status', text: '연속 클릭 시 요청 처리 결과를 체험하세요.' });
    panel.append(el('div', { class: 'demo-artifact' }, el('strong', { text: '주문 확인' }), el('p', { text: '샘플 상품 · 12,000원' }),
      el('button', { type: 'button', text: '연속 클릭 체험', onclick: () => { pausePlayback(); count.textContent = view.passed ? '요청 1회 · 중복 요청 차단 (수정 후 예시)' : '요청 2회 · 중복 요청 발생 (수정 전 예시)'; } }), count));
  } else if (view.task.scope === 'feature') {
    const result = el('ul', { class: 'note-list' });
    const search = el('input', { type: 'search', placeholder: '작업 검색', 'aria-label': '미리보기 작업 검색' });
    const update = () => clear(result).append(...['로그인 개선', '대시보드 정렬', '검색 필터'].filter((name) => name.includes(search.value)).map((name) => el('li', { text: name })));
    search.addEventListener('input', update); update(); panel.append(el('div', { class: 'demo-artifact' }, search, result));
  } else panel.append(el('div', { class: `demo-artifact demo-preview-stats${view.passed ? ' is-fixed' : ''}` }, ['진행 중 3', '검토 1', '완료 8'].map((text) => el('div', { class: 'stat', text }))));
  panel.append(el('p', { class: 'kind', text: '가상 산출물 미리보기 · 실제 앱이나 서버 요청을 실행하지 않습니다.' }));
  clear($('demo-revisions')).append(...(revisions.length ? revisions.slice().reverse().map((event) => el('li', {}, el('button', { type: 'button', class: 'link', text: `${event.index} · ${event.title}`, onclick: () => jump(event.index) }))) : [el('li', { class: 'kind', text: '아직 구현 변경이 없습니다.' })]));
}
$('demo-preview-doc').addEventListener('click', () => { const view = demoSnapshot(position, options); inspect('현재 시점 문서·근거', `# [가상 데모] ${view.task.title}\n\n${view.events.map((event) => `- ${event.title}: ${event.detail}`).join('\n')}\n\n통과 ${view.passed}회 / 실패 이력 ${view.failed}회`); });
function renderEnvironment() {
  $('demo-environment-summary').textContent = `처음 시작 · 개발환경 가이드${toolStatus === 'ready' ? ` · 도구 ${[...installed.values()].filter((tool) => tool.installed).length}개 설치 확인` : ''}`;
  $('demo-runtime').textContent = environment ? `Node ${environment.runtime?.node ?? '확인 불가'} · ${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[environment.runtime?.platform] ?? '운영체제 확인 필요'} · wax ${environment.version}` : environmentFailed ? '실행 환경을 확인하지 못했습니다.' : '실행 환경 확인 중…';
  $('demo-project-root').textContent = environment ? `${environment.project} · ${environment.root}` : environmentFailed ? '대시보드 연결을 확인한 뒤 새로고침하세요.' : '작업 폴더 확인 중…';
  clear($('demo-environment-tools')).append(...TOOLS.map((tool) => el('div', { class: 'demo-environment-tool' },
    el('span', { text: tool.label }), el('span', { class: 'kind', text: toolStatus === 'checking' ? '확인 중' : toolStatus === 'failed' ? '확인 실패' : installed.get(tool.kind)?.installed ? installed.get(tool.kind).version : '설치 확인 안 됨' }))));
}
function renderStartCommands() {
  const kind = $('demo-start-tool').value;
  clear($('demo-start-commands')).append(commandLine('처음 시작', commandFor(kind, 'init'), '선택한 AI 도구 세션에서 실행'), commandLine('다른 세션 참여', commandFor(kind, 'join'), '이미 시작한 프로젝트에 참여'));
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
      el('p', { class: 'kind', text: toolStatus === 'checking' ? '설치 상태 확인 중…' : toolStatus === 'failed' ? '설치 상태 확인 실패' : local?.installed ? `설치됨 · ${local.version ?? '버전 확인 필요'}` : '이 PC에서 설치 확인 안 됨' }),
      el('p', { class: 'kind', text: rolesFor(tool) ? `데모 배정: ${rolesFor(tool)}` : '현재 데모에는 미배정 · 역할 설정에서 선택 가능' }),
      el('button', { type: 'button', class: 'link', text: '사용 안내', onclick: () => {
        stop(); render(); $('demo-dialog-title').textContent = `${tool.label} 사용 안내`;
        const body = $('demo-dialog-body'); clear(body).append(el('p', { text: '해당 도구의 세션에서 실행할 명령입니다. 복사 후 직접 사용할 수 있습니다.' }),
          ...[['join', '팀 참여'], ['work', '배정 업무 수행'], ['status', '진행 확인'], ['daily', '일일 보고']].map(([command, name]) => commandLine(name, commandFor(tool.kind, command), '')));
        $('demo-dialog').showModal();
      } }));
  }));
  if (!$('demo-tools').children.length) $('demo-tools').append(el('p', { class: 'empty', text: '일치하는 도구가 없습니다.' }));
}
$('demo-tool-search').addEventListener('input', renderTools);
$('demo-current-action').addEventListener('click', () => {
  const view = demoSnapshot(position, options);
  if (view.index === 0 || view.step.done) { position = 0; playing = true; render(); schedule(); }
  else if (view.unresolved) inspect('실패 실행 근거', demoProof('fail', view.task));
  else if (view.step.phase < 2) officeAction('board');
  else if (view.step.phase === 4) officeAction('report');
  else officeAction('agent', view.step.actor);
});
$('demo-focus').addEventListener('click', () => {
  const focused = $('demo-root').classList.toggle('demo-focus-mode');
  $('demo-focus').setAttribute('aria-pressed', String(!focused));
  $('demo-focus').textContent = focused ? '전체 보기' : '현재 흐름만 보기';
  document.querySelectorAll('.demo-expandable').forEach((node) => { node.open = !focused; });
});
for (const details of document.querySelectorAll('.demo-expandable, .demo-setup')) details.addEventListener('toggle', () => { if (details.open && playing) { stop(); render(); } });
document.addEventListener('focusin', (event) => { if (playing && event.target.closest('.demo-expandable, .demo-setup')) pausePlayback(); });
$('office-frame').addEventListener('load', () => post({ type: 'wax-demo-ping' }));
$('demo-office-retry').addEventListener('click', () => { pausePlayback(); officeReady = false; $('demo-office-status').textContent = '캐릭터를 다시 불러오는 중…'; render(); $('office-frame').src = '/office?embed=1&demo=1'; });
renderModelSettings(); renderTools(); render();
post({ type: 'wax-demo-ping' });
api('/api/tools').then(({ tools }) => { installed = new Map(tools.map((tool) => [tool.kind, tool])); toolStatus = 'ready'; renderTools(); renderEnvironment(); }).catch(() => { toolStatus = 'failed'; renderTools(); renderEnvironment(); });

api('/api/config').then((config) => { environment = config; renderEnvironment(); }).catch(() => { environmentFailed = true; renderEnvironment(); });
