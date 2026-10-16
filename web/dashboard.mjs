import { icon } from '/icons.mjs';
import { api, clear, commandLine, el, richText, storage, store, timeLabel } from '/dom.mjs';
import { assignmentCommand, nextCommand } from '/commands.mjs';
import { deriveAttention, deriveDecisions, paginateTimeline, deriveTimelineFlow } from '/dashboard-model.mjs';
import { createLatestRefresh } from '/dashboard-refresh.mjs';

const $ = (id) => document.getElementById(id);
const PHASE_ORDER = ['plan', 'design', 'implement', 'review', 'report'];
const STATE_LABELS = { working: '작업 중', discussing: '논의 중', reviewing: '검토 중', idle: '대기', away: '자리 비움' };
const KIND_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', copilot: 'GitHub Copilot', human: '사람', other: '기타' };
const TASK_LABELS = { open: '대기', accepted: '진행 중', blocked: '막힘', done: '완료', cancelled: '취소' };
const EVENT_LABELS = { phase: '단계', feature: '작업', proof: '근거', message: '대화', note: '노트', report: '보고', daily: '일일 보고', task: '업무' };
const FILTERS = [
  { id: 'all', label: '전체', test: () => true },
  { id: 'fail', label: '실패·막힘', test: (e) => e.passed === false || e.status === 'blocked' },
  { id: 'work', label: '단계·근거', test: (e) => ['phase', 'feature', 'proof'].includes(e.type) },
  { id: 'talk', label: '대화', test: (e) => e.type === 'message' || e.type === 'note' },
  { id: 'task', label: '업무', test: (e) => e.type === 'task' },
  { id: 'report', label: '보고', test: (e) => e.type === 'report' || e.type === 'daily' },
];

let config;
let day = null;
let timelinePage = 1, timelineContext = '';
let timelineMode = storage('wax.dashboard.timelineView', 'records') === 'flow' ? 'flow' : 'records';
let timelineStage = null;
let filter = storage('wax.dashboard.filter', 'all');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let date = new URLSearchParams(location.search).get('date') || localToday();
let focus = /^[a-z0-9][a-z0-9-]{0,63}$/.test(new URLSearchParams(location.search).get('feature') ?? '') ? new URLSearchParams(location.search).get('feature') : null;
const pageUrl = () => { const q = new URLSearchParams(); if (date !== localToday()) q.set('date', date); if (focus) q.set('feature', focus); return q.size ? `/manage?${q}` : '/manage'; };
const phaseLabel = (phase) => config?.labels?.[phase] ?? (phase === 'done' ? '완료' : phase === 'any' ? '현재 단계' : phase);
const isPm = () => Boolean(day?.pm && day.pm.author === config.user);

function showError(error) {
  $('error').hidden = !error;
  $('error').textContent = error ? (error.message ?? String(error)) : '';
}

function stat(label, value, hint, action) {
  return el('button', { type: 'button', class: 'stat', onclick: action, 'aria-label': `${label} ${value} · 관련 기록 보기` }, el('span', { class: 'kind', text: label }), el('strong', { text: value }), hint ? el('span', { class: 'kind', text: hint }) : null);
}

let focusedTarget = null;
function goTo(target, recordId) {
  const root = $(target === 'timeline' ? 'events' : target)?.closest('.panel') ?? $(`${target}-heading`)?.closest('.panel');
  if (!root) return;
  const node = recordId ? [...root.querySelectorAll('[data-record-id]')].find((item) => item.dataset.recordId === recordId) ?? root : root;
  if (focusedTarget) {
    focusedTarget.node.classList.remove('dashboard-target');
    if (focusedTarget.tabIndex === null) focusedTarget.node.removeAttribute('tabindex');
    else focusedTarget.node.setAttribute('tabindex', focusedTarget.tabIndex);
  }
  focusedTarget = { node, tabIndex: node.getAttribute('tabindex') };
  node.classList.add('dashboard-target'); node.tabIndex = -1;
  node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}
function showTimeline(value, recordId) {
  filter = value; timelineStage = null; timelineMode = 'records'; timelinePage = 1; store('wax.dashboard.filter', value); renderTimeline(recordId); goTo('timeline', recordId);
}
function recordActions(event) {
  const channel = event.channel ?? event.feature ?? 'general';
  return el('div', { class: 'record-actions' },
    el('button', { type: 'button', class: 'link', text: event.type === 'proof' ? '실행 근거 보기' : '원문 보기', onclick: () => inspectRecord(event) }),
    event.type !== 'proof' ? el('a', { href: `/chat?channel=${encodeURIComponent(channel)}`, text: '채널에서 대화' }) : null);
}
let inspectGeneration = 0;
async function inspectRecord(event) {
  const version = ++inspectGeneration;
  try {
    let title, text;
    if (event.type === 'proof') {
      const { proof } = await api(`/api/features/${encodeURIComponent(event.feature)}/proofs/${encodeURIComponent(event.id)}`);
      title = `${event.feature} · 실행 근거`;
      const result = proof.kind === 'test' ? proof.timedOut ? '시간 초과' : proof.exitCode === 0 ? '통과' : `실패 (종료 코드 ${proof.exitCode ?? '없음'})` : '커밋 연결';
      text = `# ${title}\n\n- 결과: ${result}\n- 단계: ${phaseLabel(proof.phase)}\n- 시각: ${proof.at}\n- 근거 ID: ${proof.id}\n- 커밋: ${proof.commit ?? '연결된 커밋 없음'}`;
      if (proof.kind === 'test') text += `\n- 실행 시간: ${proof.durationMs}ms\n- 실행 명령: ${proof.command.join(' ')}\n\n## 실제 출력${proof.truncated ? ' (길이 제한으로 일부 생략됨)' : ''}\n\n${proof.output || '(출력 없음)'}`;
      else text += `\n\n## 변경 파일\n\n${proof.files.join('\n')}`;
    } else {
      const channel = event.channel ?? event.feature ?? 'general';
      let record;
      if (event.type === 'note') record = (await api(`/api/board/${encodeURIComponent(channel)}`)).notes.find((n) => n.id === event.id);
      else {
        const seq = Number(event.id?.match(/^m-(\d+)-/)?.[1]);
        if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('원문 ID가 올바르지 않습니다.');
        const since = `m-${String(seq - 1).padStart(6, '0')}-000000`;
        record = (await api(`/api/channels/${encodeURIComponent(channel)}/messages?since=${since}&limit=1`)).messages.find((m) => m.id === event.id);
      }
      if (!record) throw new Error('원문 기록을 찾을 수 없습니다. 최신 기록을 다시 확인해 주세요.');
      title = `${channel} · ${record.type === 'decision' ? '결정' : record.type === 'question' ? '질문' : '기록'} 원문`;
      text = `# ${title}\n\n- 작성자: ${record.author}\n- 기록 ID: ${record.id}\n- 시각: ${record.at}\n\n${record.body}`;
    }
    if (version === inspectGeneration) openDoc(title, text, `wax-record-${event.id}.md`);
  } catch (error) { if (version === inspectGeneration) showError(error); }
}
function renderAttention() {
  const items = deriveAttention(day, { feature: focus, limit: 5 });
  $('attention-count').textContent = focus ? `${focus} · 최대 5건` : '최대 5건';
  clear($('attention')).append(...(items.length ? items.map((item) => el('li', { class: 'attention-item', dataset: { kind: item.kind } },
    el('strong', { text: item.title }), el('p', { class: 'attention-detail', text: item.detail }),
    el('span', { class: 'record-meta', text: `${item.feature ?? '전체'} · ${item.kind === 'test' ? day.date + ' 기록' : '현재 현황'} · ${timeLabel(item.at)} · ${item.recordId}` }),
    el('div', { class: 'attention-actions' },
      el('button', { type: 'button', class: 'link', text: item.kind === 'test' ? '타임라인에서 확인' : item.kind === 'blocked' ? '업무 확인' : '질문 확인', onclick: () => item.kind === 'test' ? showTimeline('fail', item.recordId) : goTo(item.target, item.recordId) }),
      item.kind !== 'blocked' ? el('button', { type: 'button', class: 'link', text: '원문·근거 보기', onclick: () => inspectRecord({ id: item.recordId, feature: item.feature, type: item.kind === 'test' ? 'proof' : 'note' }) }) : null),
  )) : [el('li', { class: 'empty', text: '확인이 필요한 막힌 업무·실패 근거·미해결 질문이 없습니다.' })]));
}
function renderDecisions() {
  $('decisions-date').textContent = `${day.date}${focus ? ` · ${focus}` : ''}`;
  const decisions = deriveDecisions(day, { feature: focus });
  clear($('decisions')).append(...(decisions.length ? decisions.map((item) => el('li', {},
    el('div', { class: 'agent-head' }, el('span', { class: 'badge type-decision', text: '결정' }), el('strong', { text: item.author }), el('span', { class: 'kind', text: `${item.feature ?? '전체'} · ${timeLabel(item.at)}` })),
    el('div', { class: 'body' }, richText(item.body ?? item.detail)), recordActions(item),
  )) : [el('li', { class: 'empty', text: '선택한 날짜에 등록된 결정이 없습니다.' })]));
}

function renderStats() {
  const s = day.stats;
  clear($('stats')).append(
    stat('진행 중 작업', s.inProgress, `완료 ${s.done}`, () => goTo('features')),
    stat('완료한 단계', s.phasesCompleted, day.date === localToday() ? '오늘' : day.date, () => showTimeline('work')),
    stat('테스트', `${s.testsPassed} / ${s.testsFailed}`, `통과 / 실패 · 커밋 ${s.commits}`, () => showTimeline(s.testsFailed ? 'fail' : 'work')),
    stat('업무', `${s.tasksDone} / ${s.tasksOpen}`, `완료 / 남음 · 막힘 ${s.tasksBlocked}`, () => goTo('tasks')),
    stat('대화', s.messages + s.notes, `결정 ${s.decisions} · 미해결 질문 ${s.openQuestions}`, () => showTimeline('talk')),
    stat('참여자', s.authors, `선택한 날짜의 기록 작성자 · 보고 ${s.dailyReports}`, () => goTo('team')),
  );
}

function eventNode(event) {
  return el('li', { dataset: { recordId: event.id ?? '' }, class: `event type-${event.type}${event.passed === false ? ' failed' : ''}${event.status === 'blocked' ? ' failed' : ''}` },
    el('time', { class: 'when', datetime: event.at, text: timeLabel(event.at) }),
    el('div', {},
      el('div', { class: 'event-head' },
        el('span', { class: 'badge', text: EVENT_LABELS[event.type] ?? event.type }),
        event.feature ? el('span', { class: 'kind', text: event.feature }) : null,
        el('strong', { text: event.title })),
      event.doing ? el('div', { class: 'doing' }, el('span', { class: 'kind', text: '하는 일 ' }), event.doing) : null,
      event.detail && event.type !== 'message' ? el('div', { class: 'detail', text: event.detail }) : null,
      event.type === 'message' ? el('div', { class: 'detail' }, richText(event.body ?? event.detail)) : null,
      ['proof', 'note', 'message'].includes(event.type) ? recordActions(event) : null));
}

function setTimelineMode(mode) {
  timelineMode = mode; timelineStage = null;
  store('wax.dashboard.timelineView', mode);
  renderTimeline();
}
function renderTimelineFlow(events) {
  const root = clear($('timeline-flow'));
  root.append(el('p', { class: 'kind', text: '선택한 날짜·현재 페이지의 기록입니다. 화살표는 작업 단계 순서이며, 단계를 누르면 해당 기록을 봅니다.' }));
  for (const group of deriveTimelineFlow(events)) {
    const hasPhases = group.stages.some((stage) => stage.phase !== 'other' && stage.events.length);
    root.append(el('section', { class: 'timeline-flow-group' },
      el('h3', { text: group.feature ?? '공통 기록' }),
      el('ol', { class: 'timeline-flow-stages', 'aria-label': `${group.feature ?? '공통'} 작업 흐름` }, group.stages.filter((stage) => stage.phase === 'other' ? stage.events.length : hasPhases).map((stage) => {
        const failures = stage.events.filter((event) => event.passed === false || event.status === 'blocked').length;
        return el('li', { class: stage.phase === 'other' ? 'flow-other' : '' }, el('button', {
          type: 'button', class: `flow-node${failures ? ' has-failures' : ''}`, disabled: !stage.events.length,
          onclick: () => { timelineStage = { feature: group.feature, phase: stage.phase }; timelineMode = 'records'; timelinePage = 1; renderTimeline(); goTo('timeline'); },
        }, el('strong', { class: 'icon-label' }, icon(stage.phase === 'other' ? 'board' : stage.phase), stage.phase === 'other' ? '기타·단계 없음' : phaseLabel(stage.phase)),
          el('span', { class: 'kind', text: `${stage.events.length}건` }),
          failures ? el('span', { class: 'flow-failures', text: `실패·막힘 기록 ${failures}건` }) : null));
      }))));
  }
  if (!events.length) root.append(el('p', { class: 'empty', text: '선택한 조건의 기록이 없습니다.' }));
}
function changeTimelinePage(page) {
  timelinePage = page;
  renderTimeline();
  $('events').scrollTop = 0;
  goTo('timeline');
}
function renderTimeline(recordId) {
  const context = JSON.stringify([day.date, focus, filter, timelineStage]);
  const changed = context !== timelineContext;
  if (changed) { timelinePage = 1; timelineContext = context; }
  const timeline = $('events'), scrollTop = timeline.scrollTop;
  const focused = timeline.contains(document.activeElement) ? document.activeElement.closest('[data-record-id]')?.dataset.recordId : null;
  const scope = focus ? day.events.filter((event) => event.feature === focus) : day.events;
  const scoped = timelineStage ? scope.filter((event) => (event.feature ?? null) === timelineStage.feature && (PHASE_ORDER.includes(event.phase) ? event.phase : 'other') === timelineStage.phase) : scope;
  clear($('filters')).append(...FILTERS.map((item) => el('button', {
    type: 'button', 'aria-pressed': String(filter === item.id),
    onclick: () => { filter = item.id; timelineStage = null; store('wax.dashboard.filter', filter); renderTimeline(); },
  }, `${item.label} ${scoped.filter(item.test).length}`)),
  ...(focus ? [el('button', { type: 'button', class: 'focus-chip', 'aria-label': `${focus} 작업만 보기 해제`, onclick: () => setFocus(null) }, `작업: ${focus} ✕`)] : []));
  if (timelineStage) $('filters').append(el('button', { type: 'button', class: 'focus-chip',
    text: `${timelineStage.feature ?? '공통'} · ${timelineStage.phase === 'other' ? '기타·단계 없음' : phaseLabel(timelineStage.phase)} ✕`,
    'aria-label': '단계별 기록 보기 해제', onclick: () => { timelineStage = null; renderTimeline(); } }));
  const test = (FILTERS.find((item) => item.id === filter) ?? FILTERS[0]).test;
  const events = scoped.filter(test).slice().reverse();
  $('timeline-count').textContent = `${day.date} · ${scoped.length}건${focus ? ` (전체 ${day.events.length}건)` : ''}`;
  const result = paginateTimeline(events, { page: timelinePage, recordId });
  timelinePage = result.page;
  $('timeline-record-view').setAttribute('aria-pressed', String(timelineMode === 'records'));
  $('timeline-flow-view').setAttribute('aria-pressed', String(timelineMode === 'flow'));
  timeline.hidden = timelineMode === 'flow';
  $('timeline-flow').hidden = timelineMode !== 'flow';
  if (timelineMode === 'flow') renderTimelineFlow(result.items);
  clear(timeline).append(...(result.items.length ? result.items.map(eventNode) : [el('li', { class: 'empty', text: scoped.length ? '선택한 필터에 해당하는 기록이 없습니다.' : '이 날의 기록이 없습니다. AI 세션이 wax 명령을 실행하면 여기에 쌓입니다.' })]));
  $('timeline-pagination').hidden = result.pages === 1;
  $('timeline-page-status').textContent = `${result.page} / ${result.pages} 페이지 · ${result.start}–${result.end} / ${result.total}건`;
  $('timeline-prev').disabled = result.page === 1;
  $('timeline-next').disabled = result.page === result.pages;
  timeline.scrollTop = changed || recordId ? 0 : scrollTop;
  if (focused) { const node = [...timeline.querySelectorAll('[data-record-id]')].find((item) => item.dataset.recordId === focused); node?.querySelector('button')?.focus({ preventScroll: true }); }
}

function renderTeam() {
  $('pm-label').textContent = day.pm ? `프로젝트 PM: ${day.pm.author} (${KIND_LABELS[day.pm.kind] ?? day.pm.kind})` : 'PM 미지정';
  const actions = clear($('pm-actions'));
  if (!day.pm) {
    actions.hidden = false;
    actions.append(el('button', { type: 'button', onclick: () => setPm(true) }, `${config.user}을(를) PM으로 지정`),
      el('span', { class: 'kind', text: '또는 AI 세션에서 /wax:pm 실행' }));
  } else if (!isPm()) {
    actions.hidden = false;
    const confirm = el('span', { class: 'row', hidden: true },
      el('span', { class: 'kind', text: `${day.pm.author} 대신 내가 이 프로젝트의 PM을 맡을까요? 진행 중인 배정과 보고 흐름이 바뀝니다.` }),
      el('button', { type: 'button', onclick: () => setPm(true, true) }, '교체'),
      el('button', { type: 'button', class: 'link', onclick: () => { confirm.hidden = true; } }, '취소'));
    actions.append(el('button', { type: 'button', class: 'link', onclick: () => { confirm.hidden = false; } }, 'PM 교체…'), confirm);
  } else {
    actions.hidden = false;
    actions.append(el('span', { class: 'kind', text: `${config.user}님이 PM입니다.` }), el('button', { type: 'button', class: 'link', onclick: () => setPm(false) }, 'PM 해제'));
  }
  const tasksFor = (author) => day.tasks.filter((task) => task.to === author);
  clear($('agents')).append(...(day.agents.length ? day.agents.map((agent) => el('li', { class: `agent state-${agent.effectiveState}` },
    el('div', { class: 'agent-head' },
      el('i', { class: `dot kind-${agent.kind}` }),
      el('strong', { text: agent.author }),
      day.pm?.author === agent.author ? el('span', { class: 'badge', text: 'PM' }) : null,
      el('span', { class: 'kind', text: agent.model ? `${KIND_LABELS[agent.kind] ?? agent.kind} · ${agent.model}` : KIND_LABELS[agent.kind] ?? agent.kind, title: agent.model ? '모델은 세션이 스스로 밝힌 값입니다' : null }),
      el('span', { class: 'badge', text: STATE_LABELS[agent.effectiveState] ?? agent.effectiveState })),
    agent.note ? el('div', { class: 'doing', text: agent.note }) : null,
    ((next) => (next ? commandLine('다음 명령', next.text, next.reason) : null))(nextCommand({ agent, features: day.features, tasks: day.tasks })),
    el('div', { class: 'kind', text: `${agent.feature ?? '전체'} · ${timeLabel(agent.lastActive)}${tasksFor(agent.author).length ? ` · 맡은 업무 ${tasksFor(agent.author).length}` : ''}` })))
    : [el('li', { class: 'empty', text: '아직 참여한 AI 세션이 없습니다. 쓰는 도구에서 /wax:init(처음) 또는 /wax:join(다른 세션)을 실행하면 들어옵니다. Codex는 $wax:join, Antigravity CLI는 /join입니다.' })]));
  const names = day.agents.filter((agent) => agent.kind !== 'human').map((agent) => agent.author);
  const selected = $('assign-to').value;
  if (JSON.stringify(names) !== $('assign-to').dataset.names) {
    clear($('assign-to')).append(el('option', { value: '', text: names.length ? '참여한 AI 선택' : '참여한 AI가 없습니다' }), ...names.map((author) => el('option', { value: author, text: author })));
    $('assign-to').dataset.names = JSON.stringify(names);
    if (names.includes(selected)) $('assign-to').value = selected;
  }
}

function taskNode(task) {
  return el('li', { dataset: { recordId: task.id }, class: `task status-${task.status}` },
    el('div', { class: 'agent-head' },
      el('span', { class: 'badge', text: TASK_LABELS[task.status] }),
      el('strong', { text: `${task.to}` }),
      el('span', { class: 'kind', text: `${task.feature} · ${phaseLabel(task.phase)}` })),
    el('div', { class: 'detail', text: task.note }),
    task.updates.at(-1)?.note ? el('div', { class: 'doing', text: `${TASK_LABELS[task.updates.at(-1).status]}: ${task.updates.at(-1).note}` }) : null,
    el('div', { class: 'kind', text: `${task.id} · ${timeLabel(task.at)} 배정` }),
    isPm() ? el('button', { type: 'button', class: 'link', onclick: () => cancelTask(task) }, '배정 취소') : null);
}

function renderAssignHint() {
  const hint = $('assign-hint');
  if (!hint || !day) return;
  const name = $('assign-to').value.trim();
  const agent = day.agents.find((a) => a.author === name);
  const text = agent && assignmentCommand(agent.kind);
  clear(hint).append(...(text ? [commandLine(`배정 후 ${name} 세션에서`, text, '배정받은 업무를 수락하고 그 단계를 수행합니다')]
    : name ? [el('span', { class: 'kind', text: '참여 중인 세션이 아니면 그 세션이 다음 wax 명령을 실행할 때 배정을 확인합니다.' })] : []));
}

function renderTasks() {
  $('tasks-count').textContent = day.tasks.length ? `남은 업무 ${day.tasks.length}` : '';
  const groups = new Map();
  for (const task of day.tasks) groups.set(task.to, [...(groups.get(task.to) ?? []), task]);
  clear($('tasks')).append(...(groups.size ? [...groups].map(([author, tasks]) => el('div', { class: 'task-group' },
    el('h3', { text: author }), el('ul', { class: 'task-list' }, tasks.map(taskNode))))
    : [el('p', { class: 'empty', text: day.pm ? 'PM이 배정한 업무가 없습니다.' : 'PM을 지정하면 업무를 배정할 수 있습니다.' })]));
  $('assign').hidden = !isPm();
  if (isPm()) {
    const current = $('assign-feature').value;
    const open = day.features.filter((f) => f.phase !== 'done');
    const signature = JSON.stringify(open.map((f) => [f.id, f.title]));
    if ($('assign-feature').dataset.signature !== signature) {
      clear($('assign-feature')).append(...open.map((f) => el('option', { value: f.id, text: `${f.id} — ${f.title}` })));
      $('assign-feature').dataset.signature = signature;
    }
    $('assign-empty').hidden = open.length > 0;
    $('assign-feature').disabled = !open.length;
    $('assign').querySelector('button[type="submit"]').disabled = !open.length || Boolean($('assign').dataset.pending);
    if (current && open.some((f) => f.id === current)) $('assign-feature').value = current;
    else if (focus && day.features.some((f) => f.id === focus && f.phase !== 'done')) $('assign-feature').value = focus;
    renderAssignHint();
    if (!$('assign-phase').options.length) $('assign-phase').append(el('option', { value: 'any', text: '현재 단계' }), ...PHASE_ORDER.map((p) => el('option', { value: p, text: phaseLabel(p) })));
  }
}

function renderFeatures() {
  clear($('features')).append(...(day.features.length ? day.features.map((feature) => {
    const index = feature.phase === 'done' ? PHASE_ORDER.length : PHASE_ORDER.indexOf(feature.phase);
    return el('li', { class: feature.id === focus ? 'focused' : '' },
      el('div', { class: 'agent-head' }, el('button', { type: 'button', class: 'link', onclick: () => setFocus(feature.id), text: feature.id }), el('span', { class: 'kind', text: feature.title })),
      el('ol', { class: 'stepper', 'aria-label': `${feature.id} 진행 단계: ${phaseLabel(feature.phase)}` }, PHASE_ORDER.map((phase, i) => el('li', {
        class: i < index ? 'done' : i === index ? 'current' : '',
      }, icon(phase, 14), phaseLabel(phase)))));
  }) : [el('li', { class: 'empty', text: 'wax 작업이 없습니다.' })]));
}

function renderQuestions() {
  clear($('questions')).append(...(day.openQuestions.length ? day.openQuestions.map((q) => el('li', { dataset: { recordId: q.id } },
    el('div', { class: 'agent-head' }, el('span', { class: 'badge type-question', text: '질문' }), el('strong', { text: q.author }), el('span', { class: 'kind', text: `${q.feature} · ${q.id}` })),
    el('div', { class: 'body' }, richText(q.body)), recordActions({ ...q, type: 'note' }))) : [el('li', { class: 'empty', text: '미해결 질문이 없습니다.' })]));
}

function renderReports() {
  clear($('reports')).append(...(day.reports.length ? day.reports.map((report) => el('li', {},
    el('button', { type: 'button', class: 'link', onclick: () => openReport(report) }, `${String(report.number).padStart(2, '0')}. ${report.author}`),
    el('span', { class: 'kind', text: ` ${timeLabel(report.at)} · ${report.path}` }))) : [el('li', { class: 'empty', text: `${day.date} 일일 보고서가 아직 없습니다.` })]));
}

function render() {
  renderStats(); renderTimeline(); renderTeam(); renderTasks(); renderFeatures(); renderQuestions(); renderReports(); renderAttention(); renderDecisions();
}

const refreshOptions = {
  load: (requestedDate) => api(`/api/daily?date=${encodeURIComponent(requestedDate)}`),
  apply: (value, requestedDate) => {
    const previous = new Set((day?.events ?? []).map((event) => `${event.type}:${event.feature ?? event.channel ?? ''}:${event.id ?? event.at}`));
    const added = day?.date === value.date ? value.events.filter((event) => !previous.has(`${event.type}:${event.feature ?? event.channel ?? ''}:${event.id ?? event.at}`)).length : 0;
    day = value;
    $('timeline-updates').textContent = added ? `새 기록 ${added}개가 있습니다.` : '';
    showError(null);
    render();
    $('updated-at').dataset.state = 'live';
    $('updated-at').textContent = `${requestedDate} 기록 · ${timeLabel(new Date().toISOString())} 갱신 · 업무·질문은 현재 현황`;
  },
  onError: (error) => {
    showError(error);
    $('updated-at').dataset.state = 'stale';
    $('updated-at').textContent = day ? `${day.date}의 마지막 기록을 표시 중 · 새로고침이 필요합니다` : '기록을 불러오지 못했습니다';
  },
  onPending: (busy) => {
    $('refresh-dashboard').disabled = busy;
    $('refresh-dashboard').textContent = busy ? '갱신 중…' : '새로고침';
    document.querySelector('.dash').setAttribute('aria-busy', String(busy));
  },
};
let refreshState = createLatestRefresh(refreshOptions);
function refresh() { return refreshState.refresh(date); }
$('refresh-dashboard').addEventListener('click', refresh);

let pending;
const scheduleRefresh = () => { clearTimeout(pending); pending = setTimeout(() => refreshState.invalidate(date), 400); };

function openDoc(title, markdown, filename) {
  $('doc-title').textContent = title;
  $('doc-body').textContent = markdown;
  $('doc-download').onclick = () => {
    const link = el('a', { href: URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' })), download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  $('doc-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(markdown); $('doc-copy').textContent = '복사됨'; }
    catch { $('doc-copy').textContent = '복사 실패'; }
    setTimeout(() => { $('doc-copy').textContent = '복사'; }, 1500);
  };
  $('doc-dialog').showModal();
}

async function openReport(report) {
  const version = ++inspectGeneration;
  try { const markdown = await api(`/api/daily/reports/${report.date}/${report.number}`); if (version !== inspectGeneration) return; openDoc(`${report.date} 일일 보고 ${String(report.number).padStart(2, '0')}`, markdown, `wax-daily-${report.date}-${report.number}.md`); }
  catch (error) { showError(error); }
}

async function setPm(self, replace = false) {
  try { await api('/api/team/pm', { method: 'POST', token: config.token, body: self ? { self: true, replace } : {} }); await refresh(); }
  catch (error) { showError(error); }
}

async function cancelTask(task) {
  try { await api(`/api/tasks/${task.id}/cancel`, { method: 'POST', token: config.token, body: { body: '대시보드에서 PM이 취소' } }); await refresh(); }
  catch (error) { showError(error); }
}

$('assign-to').addEventListener('input', renderAssignHint);
$('assign').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.target.dataset.pending) return;
  const fields = ['assign-feature', 'assign-to', 'assign-phase', 'assign-note'];
  const draft = fields.map((id) => $(id).value);
  event.target.dataset.pending = 'true';
  const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true;
  try {
    await api('/api/tasks', { method: 'POST', token: config.token, body: { feature: $('assign-feature').value, to: $('assign-to').value.trim(), phase: $('assign-phase').value, body: $('assign-note').value } });
    if (fields.every((id, i) => $(id).value === draft[i])) $('assign-note').value = '';
    await refresh();
  } catch (error) { showError(error); }
  finally { delete event.target.dataset.pending; submit.disabled = !$('assign-feature').value; }
});
$('new-feature').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.target.dataset.pending) return;
  const form = event.target;
  const fields = ['feature-id', 'feature-title', 'feature-description'];
  const input = fields.map((id) => $(id).value);
  form.dataset.pending = 'true';
  const submit = form.querySelector('button[type="submit"]'); submit.disabled = true;
  try {
    const feature = await api('/api/features', { method: 'POST', token: config.token, body: { id: $('feature-id').value.trim(), title: $('feature-title').value.trim(), description: $('feature-description').value } });
    if (fields.every((id, i) => $(id).value === input[i])) form.reset();
    await refresh();
    if (isPm() && [...$('assign-feature').options].some((o) => o.value === feature.id)) $('assign-feature').value = feature.id;
  } catch (error) { showError(error); }
  finally { delete form.dataset.pending; submit.disabled = false; }
});
$('open-draft').addEventListener('click', async () => {
  const requestedDate = day?.date ?? date, version = ++inspectGeneration;
  try {
    const { markdown } = await api(`/api/daily/draft?date=${encodeURIComponent(requestedDate)}`);
    if (version === inspectGeneration) openDoc(`${requestedDate} 일일 업무 집계 초안`, markdown, `wax-daily-draft-${requestedDate}.md`);
  } catch (error) { if (version === inspectGeneration) showError(error); }
});
document.querySelectorAll('dialog [data-close]').forEach((button) => button.addEventListener('click', () => { inspectGeneration++; button.closest('dialog').close(); }));
$('timeline-record-view').addEventListener('click', () => setTimelineMode('records'));
$('timeline-flow-view').addEventListener('click', () => setTimelineMode('flow'));
$('timeline-prev').addEventListener('click', () => changeTimelinePage(timelinePage - 1));
$('timeline-next').addEventListener('click', () => changeTimelinePage(timelinePage + 1));
$('date').addEventListener('change', () => {
  if (!$('date').value) return;
  timelineStage = null;
  date = $('date').value;
  history.replaceState(null, '', pageUrl());
  refresh();
});
$('today').addEventListener('click', () => { timelineStage = null; date = localToday(); $('date').value = date; history.replaceState(null, '', pageUrl()); refresh(); });

function setFocus(id) {
  timelineStage = null;
  focus = id;
  history.replaceState(null, '', pageUrl());
  renderTimeline(); renderFeatures(); renderAttention(); renderDecisions();
}

function fitOffice() {
  const frame = $('office-frame');
  if (focus) frame.src = `/office?embed=1&board=${encodeURIComponent(focus)}`;
  const fit = () => { const doc = frame.contentDocument?.documentElement; if (doc) frame.style.height = `${doc.scrollHeight}px`; };
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument?.documentElement;
    if (!doc) return;
    new ResizeObserver(fit).observe(frame.contentDocument.body);
    fit();
  });
}
fitOffice();

function connect() {
  const source = new EventSource('/api/events');
  let connection = 0;
  source.onopen = async () => {
    const version = ++connection;
    $('status').dataset.state = 'sync'; $('status').textContent = '기록 동기화 중…';
    try {
      const nextConfig = await api('/api/config');
      if (version !== connection) return;
      config = nextConfig;
      const result = await refresh();
      if (version !== connection) return;
      $('status').dataset.state = result.status === 'error' ? 'down' : 'live';
      $('status').textContent = result.status === 'error' ? '연결됨 · 기록 갱신 필요' : '실시간 연결됨';
    } catch (error) { if (version !== connection) return; showError(error); $('status').dataset.state = 'down'; $('status').textContent = '연결됨 · 세션 갱신 필요'; }
  };
  source.onerror = () => { connection++; $('status').dataset.state = 'down'; $('status').textContent = '연결 끊김 — 다시 연결 중'; };
  for (const name of ['message', 'note', 'report', 'presence', 'features', 'daily', 'tasks']) source.addEventListener(name, scheduleRefresh);
  return () => { connection++; source.close(); };
}

let disconnect = null, refreshTimer;
function startLive() {
  if (disconnect) return;
  disconnect = connect();
  refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
}
window.addEventListener('pagehide', () => {
  disconnect?.(); disconnect = null;
  refreshState.stop(); clearTimeout(pending); clearInterval(refreshTimer);
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !config) return;
  refreshState = createLatestRefresh(refreshOptions);
  startLive(); refresh();
});
try {
  config = await api('/api/config');
  document.title = `${config.project} · wax 대시보드`;
  $('project').textContent = `${config.project} · v${config.version}`;
  $('date').value = date;
  await refresh();
  startLive();
} catch (error) { showError(error); }
