import { t } from './messages-catalog.mjs';
import { icon } from '/icons.mjs';
import { openEvents } from '/events.mjs';
import { api, clear, commandLine, el, richText, storage, store, timeLabel } from '/dom.mjs';
import { assignmentCommand, commandFor, nextCommand } from '/commands.mjs';
import { deriveAttention, deriveDecisions, paginateTimeline, deriveTimelineFlow, durationItems } from '/dashboard-model.mjs';
import { createLatestRefresh } from '/dashboard-refresh.mjs';
import { rulesView } from '/rules-panel.mjs';
import { wikiView } from '/wiki-panel.mjs';
import { traceView } from '/trace-panel.mjs';

const $ = (id) => document.getElementById(id);
const PHASE_ORDER = ['plan', 'design', 'implement', 'review', 'report'];
const STATE_LABELS = { working: t('dashboard.working'), discussing: t('dashboard.discussing'), reviewing: t('dashboard.reviewing'), idle: t('dashboard.waiting'), away: t('dashboard.away') };
const KIND_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', copilot: 'GitHub Copilot', grok: 'Grok', human: t('dashboard.ceo'), other: t('dashboard.other') };
const TASK_LABELS = { open: t('dashboard.waiting'), accepted: t('dashboard.inProgress'), blocked: t('dashboard.blocked'), done: t('dashboard.done'), cancelled: t('dashboard.cancel') };
const EVENT_LABELS = { phase: t('dashboard.stage'), feature: t('dashboard.task'), proof: t('dashboard.evidence'), message: t('dashboard.chat'), note: t('dashboard.notes'), report: t('dashboard.report'), daily: t('dashboard.dailyReport'), task: t('dashboard.assignments') };
const FILTERS = [
  { id: 'all', label: t('dashboard.all'), test: () => true },
  { id: 'fail', label: t('dashboard.failedBlocked'), test: (e) => e.passed === false || e.status === 'blocked' },
  { id: 'work', label: t('dashboard.stagesEvidence'), test: (e) => ['phase', 'feature', 'proof'].includes(e.type) },
  { id: 'talk', label: t('dashboard.chat'), test: (e) => e.type === 'message' || e.type === 'note' },
  { id: 'task', label: t('dashboard.assignments'), test: (e) => e.type === 'task' },
  { id: 'report', label: t('dashboard.report'), test: (e) => e.type === 'report' || e.type === 'daily' },
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
const phaseLabel = (phase) => config?.labels?.[phase] ?? (phase === 'done' ? t('dashboard.done') : phase === 'any' ? t('dashboard.currentStage') : phase);
const isPm = () => Boolean(day?.pm && day.pm.author === config.user);

function showError(error) {
  $('error').hidden = !error;
  $('error').textContent = error ? (error.message ?? String(error)) : '';
}

function stat(label, value, hint, action) {
  return el('button', { type: 'button', class: 'stat', onclick: action, 'aria-label': t('dashboard.viewRelatedRecords', label, value) }, el('span', { class: 'kind', text: label }), el('strong', { text: value }), hint ? el('span', { class: 'kind', text: hint }) : null);
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
    el('button', { type: 'button', class: 'link', text: event.type === 'proof' ? t('dashboard.viewExecutionEvidence') : t('dashboard.viewOriginal'), onclick: () => inspectRecord(event) }),
    event.type !== 'proof' ? el('a', { href: `/chat?channel=${encodeURIComponent(channel)}`, text: t('dashboard.chatInChannel') }) : null);
}
let inspectGeneration = 0;
async function inspectRecord(event) {
  const version = ++inspectGeneration;
  try {
    let title, text;
    if (event.type === 'proof') {
      const { proof } = await api(`/api/features/${encodeURIComponent(event.feature)}/proofs/${encodeURIComponent(event.id)}`);
      title = t('dashboard.executionEvidence', event.feature);
      const result = proof.kind === 'test' ? proof.timedOut ? t('dashboard.timedOut') : proof.exitCode === 0 ? t('dashboard.passed') : `실패 (종료 코드 ${proof.exitCode ?? '없음'})` : t('dashboard.commitLinked');
      text = `# ${title}\n\n- 결과: ${result}\n- 단계: ${phaseLabel(proof.phase)}\n- 시각: ${proof.at}\n- 근거 ID: ${proof.id}\n- 커밋: ${proof.commit ?? '연결된 커밋 없음'}`;
      if (proof.kind === 'test') text += `\n- 실행 시간: ${proof.durationMs}ms\n- 실행 명령: ${proof.command.join(' ')}\n\n## 실제 출력${proof.truncated ? ' (길이 제한으로 일부 생략됨)' : ''}\n\n${proof.output || '(출력 없음)'}`;
      else text += `\n\n## 변경 파일\n\n${proof.files.join('\n')}`;
    } else {
      const channel = event.channel ?? event.feature ?? 'general';
      let record;
      if (event.type === 'note') record = (await api(`/api/board/${encodeURIComponent(channel)}`)).notes.find((n) => n.id === event.id);
      else {
        const seq = Number(event.id?.match(/^m-(\d+)-/)?.[1]);
        if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(t('dashboard.theOriginalRecordId'));
        const since = `m-${String(seq - 1).padStart(6, '0')}-000000`;
        record = (await api(`/api/channels/${encodeURIComponent(channel)}/messages?since=${since}&limit=1`)).messages.find((m) => m.id === event.id);
      }
      if (!record) throw new Error(t('dashboard.couldntFindTheOriginal'));
      title = `${channel} · ${record.type === 'decision' ? '결정' : record.type === 'question' ? '질문' : '기록'} 원문`;
      text = t('dashboard.nnAuthorNRecord', title, record.author, record.id, record.at, record.body);
    }
    if (version === inspectGeneration) openDoc(title, text, `wax-record-${event.id}.md`);
  } catch (error) { if (version === inspectGeneration) showError(error); }
}
function renderAttention() {
  const items = deriveAttention(day, { feature: focus, limit: 5 });
  $('attention-count').textContent = focus ? t('dashboard.upTo5', focus) : t('dashboard.upTo52');
  clear($('attention')).append(...(items.length ? items.map((item) => el('li', { class: 'attention-item', dataset: { kind: item.kind } },
    el('strong', { text: item.title }), el('p', { class: 'attention-detail', translate: 'no', text: item.detail }),
    el('span', { class: 'record-meta', text: `${item.feature ?? '전체'} · ${item.kind === 'test' ? day.date + ' 기록' : '현재 현황'} · ${timeLabel(item.at)} · ${item.recordId}` }),
    el('div', { class: 'attention-actions' },
      el('button', { type: 'button', class: 'link', text: item.kind === 'test' ? t('dashboard.checkInTimeline') : item.kind === 'blocked' ? t('dashboard.checkTask') : t('dashboard.checkQuestion'), onclick: () => item.kind === 'test' ? showTimeline('fail', item.recordId) : goTo(item.target, item.recordId) }),
      item.kind !== 'blocked' ? el('button', { type: 'button', class: 'link', text: t('dashboard.viewOriginalEvidence'), onclick: () => inspectRecord({ id: item.recordId, feature: item.feature, type: item.kind === 'test' ? 'proof' : 'note' }) }) : null),
  )) : [el('li', { class: 'empty', text: t('dashboard.noBlockedTasksFailed') })]));
}
function renderDecisions() {
  $('decisions-date').textContent = `${day.date}${focus ? ` · ${focus}` : ''}`;
  const decisions = deriveDecisions(day, { feature: focus });
  clear($('decisions')).append(...(decisions.length ? decisions.map((item) => el('li', {},
    el('div', { class: 'agent-head' }, el('span', { class: 'badge type-decision', text: t('dashboard.decision') }), el('strong', { text: item.author }), el('span', { class: 'kind', text: `${item.feature ?? '전체'} · ${timeLabel(item.at)}` })),
    el('div', { class: 'body' }, richText(item.body ?? item.detail)), recordActions(item),
  )) : [el('li', { class: 'empty', text: t('dashboard.noDecisionsAreRegistered') })]));
}

function renderStats() {
  const s = day.stats;
  clear($('stats')).append(
    stat(t('dashboard.activeTasks'), s.inProgress, t('dashboard.complete', s.done), () => goTo('features')),
    stat(t('dashboard.completedStages'), s.phasesCompleted, day.date === localToday() ? t('dashboard.today') : day.date, () => showTimeline('work')),
    stat(t('dashboard.tests'), `${s.testsPassed} / ${s.testsFailed}`, t('dashboard.passedFailedCommits', s.commits), () => showTimeline(s.testsFailed ? 'fail' : 'work')),
    stat(t('dashboard.assignments'), `${s.tasksDone} / ${s.tasksOpen}`, t('dashboard.doneRemainingBlocked', s.tasksBlocked), () => goTo('tasks')),
    stat(t('dashboard.chat'), s.messages + s.notes, t('dashboard.decisionsUnresolvedQuestions', s.decisions, s.openQuestions), () => showTimeline('talk')),
    stat(t('dashboard.participants'), s.authors, t('dashboard.authorsOfRecordsOn', s.dailyReports), () => goTo('team')),
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
      event.detail && event.type !== 'message' ? el('div', { class: 'detail', translate: 'no', text: event.detail }) : null,
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
  root.append(el('p', { class: 'kind', text: t('dashboard.theseAreRecordsFor') }));
  for (const group of deriveTimelineFlow(events)) {
    const hasPhases = group.stages.some((stage) => stage.phase !== 'other' && stage.events.length);
    root.append(el('section', { class: 'timeline-flow-group' },
      el('h3', { text: group.feature ?? t('dashboard.sharedRecords') }),
      el('ol', { class: 'timeline-flow-stages', 'aria-label': `${group.feature ?? '공통'} 작업 흐름` }, group.stages.filter((stage) => stage.phase === 'other' ? stage.events.length : hasPhases).map((stage) => {
        const failures = stage.events.filter((event) => event.passed === false || event.status === 'blocked').length;
        return el('li', { class: stage.phase === 'other' ? 'flow-other' : '' }, el('button', {
          type: 'button', class: `flow-node${failures ? ' has-failures' : ''}`, disabled: !stage.events.length,
          onclick: () => { timelineStage = { feature: group.feature, phase: stage.phase }; timelineMode = 'records'; timelinePage = 1; renderTimeline(); goTo('timeline'); },
        }, el('strong', { class: 'icon-label' }, icon(stage.phase === 'other' ? 'board' : stage.phase), stage.phase === 'other' ? t('dashboard.otherNoStage') : phaseLabel(stage.phase)),
          el('span', { class: 'kind', text: `${stage.events.length}건` }),
          failures ? el('span', { class: 'flow-failures', text: t('dashboard.failedBlockedRecords', failures) }) : null));
      }))));
  }
  if (!events.length) root.append(el('p', { class: 'empty', text: t('dashboard.noRecordsMatchThe') }));
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
  ...(focus ? [el('button', { type: 'button', class: 'focus-chip', 'aria-label': t('dashboard.clearTheTasksOnly', focus), onclick: () => setFocus(null) }, t('dashboard.task2', focus))] : []));
  if (timelineStage) $('filters').append(el('button', { type: 'button', class: 'focus-chip',
    text: `${timelineStage.feature ?? '공통'} · ${timelineStage.phase === 'other' ? '기타·단계 없음' : phaseLabel(timelineStage.phase)} ✕`,
    'aria-label': t('dashboard.clearTheByStage'), onclick: () => { timelineStage = null; renderTimeline(); } }));
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
  clear(timeline).append(...(result.items.length ? result.items.map(eventNode) : [el('li', { class: 'empty', text: scoped.length ? t('dashboard.noRecordsMatchTheSelected') : t('dashboard.noRecordsForThis') })]));
  $('timeline-pagination').hidden = result.pages === 1;
  $('timeline-page-status').textContent = t('dashboard.pageOf', result.page, result.pages, result.start, result.end, result.total);
  $('timeline-prev').disabled = result.page === 1;
  $('timeline-next').disabled = result.page === result.pages;
  timeline.scrollTop = changed || recordId ? 0 : scrollTop;
  if (focused) { const node = [...timeline.querySelectorAll('[data-record-id]')].find((item) => item.dataset.recordId === focused); node?.querySelector('button')?.focus({ preventScroll: true }); }
}

function renderTeam() {
  $('pm-label').textContent = day.pm ? t('dashboard.projectPm', day.pm.author, KIND_LABELS[day.pm.kind] ?? day.pm.kind) : t('dashboard.noPmAssigned');
  const actions = clear($('pm-actions'));
  if (!day.pm) {
    actions.hidden = false;
    actions.append(el('button', { type: 'button', onclick: () => setPm(true) }, t('dashboard.setAsPm', config.user)),
      el('span', { class: 'kind', text: t('dashboard.orRunWaxPm') }));
  } else if (!isPm()) {
    actions.hidden = false;
    const confirm = el('span', { class: 'row', hidden: true },
      el('span', { class: 'kind', text: t('dashboard.takeOverAsThis', day.pm.author) }),
      el('button', { type: 'button', onclick: () => setPm(true, true) }, t('dashboard.replace')),
      el('button', { type: 'button', class: 'link', onclick: () => { confirm.hidden = true; } }, t('dashboard.cancel')));
    actions.append(el('button', { type: 'button', class: 'link', onclick: () => { confirm.hidden = false; } }, t('dashboard.replacePm')), confirm);
  } else {
    actions.hidden = false;
    actions.append(el('span', { class: 'kind', text: t('dashboard.isThePm', config.user) }), el('button', { type: 'button', class: 'link', onclick: () => setPm(false) }, t('dashboard.clearPm')));
  }
  const tasksFor = (author) => day.tasks.filter((task) => task.to === author);
  clear($('agents')).append(...(day.agents.length ? day.agents.map((agent) => el('li', { class: `agent state-${agent.effectiveState}` },
    el('div', { class: 'agent-head' },
      el('i', { class: `dot kind-${agent.kind}` }),
      el('strong', { text: agent.author }),
      day.pm?.author === agent.author ? el('span', { class: 'badge', text: 'PM' }) : null,
      el('span', { class: 'kind', text: agent.model ? `${KIND_LABELS[agent.kind] ?? agent.kind} · ${agent.model}` : KIND_LABELS[agent.kind] ?? agent.kind, title: agent.model ? t('dashboard.theModelIsAs') : null }),
      el('span', { class: 'badge', text: STATE_LABELS[agent.effectiveState] ?? agent.effectiveState }),
      agent.listening ? el('span', { class: 'badge', text: t('dashboard.listening'), title: t('dashboard.listeningToTheChannel') }) : null),
    agent.note ? el('div', { class: 'doing', translate: 'no', text: agent.note }) : null,
    ((next) => (next ? commandLine(t('dashboard.nextCommand'), next.text, next.reason) : null))(nextCommand({ agent, features: day.features, tasks: day.tasks })),
    el('div', { class: 'kind', text: `${agent.feature ?? '전체'} · ${timeLabel(agent.lastActive)}${tasksFor(agent.author).length ? ` · 맡은 업무 ${tasksFor(agent.author).length}` : ''}` })))
    : [el('li', { class: 'empty', text: t('dashboard.noAiSessionsHave') })]));
  const names = day.agents.filter((agent) => agent.kind !== 'human').map((agent) => agent.author);
  const selected = $('assign-to').value;
  if (JSON.stringify(names) !== $('assign-to').dataset.names) {
    clear($('assign-to')).append(el('option', { value: '', text: names.length ? t('dashboard.selectJoinedAi') : t('dashboard.noAiHasJoined') }), ...names.map((author) => el('option', { value: author, text: author })));
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
    el('div', { class: 'detail', translate: 'no', text: task.note }),
    task.updates.at(-1)?.note ? el('div', { class: 'doing' }, `${TASK_LABELS[task.updates.at(-1).status]}: `, el('span', { translate: 'no', text: task.updates.at(-1).note })) : null,
    el('div', { class: 'kind', text: t('dashboard.assigned', task.id, timeLabel(task.at)) }),
    ((text) => text ? commandLine(t('dashboard.runInSession', task.to), text, t('dashboard.startSessionsThatDont')) : null)(commandFor(day.agents.find((a) => a.author === task.to)?.kind, 'work', task.id)),
    isPm() ? el('button', { type: 'button', class: 'link', onclick: () => cancelTask(task) }, t('dashboard.cancelAssignment')) : null);
}

function renderAssignHint() {
  const hint = $('assign-hint');
  if (!hint || !day) return;
  const name = $('assign-to').value.trim();
  const agent = day.agents.find((a) => a.author === name);
  const text = agent && assignmentCommand(agent.kind);
  clear(hint).append(...(text ? [commandLine(t('dashboard.afterAssignmentInThe', name), text, t('dashboard.acceptTheAssignedTask'))]
    : name ? [el('span', { class: 'kind', text: t('dashboard.ifTheSessionIsnt') })] : []));
}

function renderTasks() {
  $('tasks-count').textContent = day.tasks.length ? t('dashboard.remainingTasks', day.tasks.length) : '';
  const groups = new Map();
  for (const task of day.tasks) groups.set(task.to, [...(groups.get(task.to) ?? []), task]);
  clear($('tasks')).append(...(groups.size ? [...groups].map(([author, tasks]) => el('div', { class: 'task-group' },
    el('h3', { text: author }), el('ul', { class: 'task-list' }, tasks.map(taskNode))))
    : [el('p', { class: 'empty', text: day.pm ? t('dashboard.noTasksAssignedBy') : t('dashboard.assignAPmTo') })]));
  $('assign').hidden = !isPm();
  if (isPm()) {
    const current = $('assign-feature').value;
    const open = day.features.filter((f) => f.phase !== 'done');
    const signature = JSON.stringify(open.map((f) => [f.id, f.title]));
    if ($('assign-feature').dataset.signature !== signature) {
      clear($('assign-feature')).append(...open.map((f) => el('option', { value: f.id, translate: 'no', text: `${f.id} — ${f.title}` })));
      $('assign-feature').dataset.signature = signature;
    }
    $('assign-empty').hidden = open.length > 0;
    $('assign-feature').disabled = !open.length;
    $('assign').querySelector('button[type="submit"]').disabled = !open.length || Boolean($('assign').dataset.pending);
    if (current && open.some((f) => f.id === current)) $('assign-feature').value = current;
    else if (focus && day.features.some((f) => f.id === focus && f.phase !== 'done')) $('assign-feature').value = focus;
    renderAssignHint();
    if (!$('assign-phase').options.length) $('assign-phase').append(el('option', { value: 'any', text: t('dashboard.currentStage') }), ...PHASE_ORDER.map((p) => el('option', { value: p, text: phaseLabel(p) })));
  }
}

function renderFeatures() {
  clear($('features')).append(...(day.features.length ? day.features.map((feature) => {
    const index = feature.phase === 'done' ? PHASE_ORDER.length : PHASE_ORDER.indexOf(feature.phase);
    return el('li', { class: feature.id === focus ? 'focused' : '' },
      el('div', { class: 'agent-head' }, el('button', { type: 'button', class: 'link', onclick: () => setFocus(feature.id), text: feature.id }), el('span', { class: 'kind', translate: 'no', text: feature.title }),
        el('button', { type: 'button', class: 'link trace-open', 'aria-label': t('dashboard.traceOpenFor', feature.id), onclick: () => { setFocus(feature.id); openTrace(feature.id); } }, t('dashboard.runTrace'))),
      el('ol', { class: 'stepper', 'aria-label': t('dashboard.currentStage2', feature.id, phaseLabel(feature.phase)) }, PHASE_ORDER.map((phase, i) => el('li', {
        class: i < index ? 'done' : i === index ? 'current' : '',
      }, icon(phase, 14), phaseLabel(phase)))),
      durationLine(feature.durations));
  }) : [el('li', { class: 'empty', text: t('dashboard.noWaxTasks') })]));
}

function durationLine(durations) {
  const items = durationItems(durations);
  if (!items.length) return null;
  return el('p', { class: 'phase-durations', 'aria-label': t('dashboard.phaseDurations') }, items.flatMap((item, i) => [
    i ? ' · ' : null,
    el('span', { class: item.inProgress ? 'current' : null }, ...(item.phase === 'total' ? [] : [phaseLabel(item.phase), ' ']), el('span', { text: item.text })),
  ]));
}

function renderQuestions() {
  clear($('questions')).append(...(day.openQuestions.length ? day.openQuestions.map((q) => el('li', { dataset: { recordId: q.id } },
    el('div', { class: 'agent-head' }, el('span', { class: 'badge type-question', text: t('dashboard.question') }), el('strong', { text: q.author }), el('span', { class: 'kind', text: `${q.feature} · ${q.id}` })),
    el('div', { class: 'body' }, richText(q.body)), recordActions({ ...q, type: 'note' }))) : [el('li', { class: 'empty', text: t('dashboard.noUnresolvedQuestions') })]));
}

function renderReports() {
  clear($('reports')).append(...(day.reports.length ? day.reports.map((report) => el('li', {},
    el('button', { type: 'button', class: 'link', onclick: () => openReport(report) }, `${String(report.number).padStart(2, '0')}. ${report.author}`),
    el('span', { class: 'kind', text: ` ${timeLabel(report.at)} · ${report.path}` }))) : [el('li', { class: 'empty', text: t('dashboard.noDailyReportYet', day.date) })]));
}

let traceFeature = focus, traceGeneration = 0, traceMarkdown = '';
async function loadTrace() {
  const panel = $('trace-panel');
  panel.hidden = !traceFeature;
  if (!traceFeature) return;
  const id = traceFeature, version = ++traceGeneration;
  $('trace-feature').textContent = id;
  if (!$('trace-body').childElementCount) $('trace-body').append(el('p', { class: 'kind', text: t('dashboard.traceLoading') }));
  try {
    const trace = await api(`/api/features/${encodeURIComponent(id)}/trace?lang=${globalThis.waxLocale?.language === 'en' ? 'en' : 'ko'}`);
    if (version !== traceGeneration) return;
    const opened = [...$('trace-body').querySelectorAll('.trace-visit > details')].map((node) => node.open);
    const view = traceView(trace, phaseLabel);
    traceMarkdown = trace.markdown;
    $('trace-summary').textContent = view.summary;
    clear($('trace-body')).append(...view.body.filter(Boolean));
    $('trace-body').querySelectorAll('.trace-visit > details').forEach((node, index) => { if (index < opened.length - 1) node.open = opened[index]; });
  } catch (error) {
    if (version !== traceGeneration) return;
    clear($('trace-body')).append(el('p', { class: 'error', text: error.message }));
  }
}
function openTrace(id) {
  if (traceFeature !== id) { traceMarkdown = ''; clear($('trace-body')); }
  traceFeature = id;
  loadTrace().then(() => goTo('trace-panel'));
}
$('trace-close').addEventListener('click', () => { traceFeature = null; traceGeneration++; $('trace-panel').hidden = true; });
$('trace-download').addEventListener('click', () => {
  if (!traceMarkdown || !traceFeature) return;
  const link = el('a', { href: URL.createObjectURL(new Blob([traceMarkdown], { type: 'text/markdown;charset=utf-8' })), download: `wax-trace-${traceFeature}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

let rulesGeneration = 0;
async function loadRules() {
  const version = ++rulesGeneration;
  try {
    const data = await api('/api/rules');
    if (version !== rulesGeneration) return;
    const { items, summary } = rulesView(data, decideRule);
    $('rules-count').textContent = summary;
    clear($('rules')).append(...items);
  } catch (error) { if (version === rulesGeneration) showError(error); }
}
let wikiGeneration = 0;
async function loadWiki() {
  const version = ++wikiGeneration;
  try {
    const data = await api('/api/wiki');
    if (version !== wikiGeneration) return;
    const { items, summary } = wikiView(data, openWikiPage);
    $('wiki-count').textContent = summary;
    clear($('wiki')).append(...items);
  } catch (error) { if (version === wikiGeneration) showError(error); }
}
async function openWikiPage(page) {
  try { const { markdown } = await api(`/api/wiki/${page.slug}`); openDoc(page.title, markdown, `${page.slug}.md`); }
  catch (error) { showError(error); }
}
async function decideRule(rule, action) {
  try { await api(`/api/rules/${rule.id}/${action}`, { method: 'POST', token: config.token, body: {} }); }
  catch (error) { showError(error); }
  await loadRules();
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
    $('timeline-updates').textContent = added ? t('dashboard.newRecords', added) : '';
    showError(null);
    render();
    loadRules();
    loadWiki();
    $('updated-at').dataset.state = 'live';
    $('updated-at').textContent = t('dashboard.recordsUpdatedTasksAnd', requestedDate, timeLabel(new Date().toISOString()));
  },
  onError: (error) => {
    showError(error);
    $('updated-at').dataset.state = 'stale';
    $('updated-at').textContent = day ? t('dashboard.showingTheLastRecord', day.date) : t('dashboard.couldntLoadRecords');
  },
  onPending: (busy) => {
    $('refresh-dashboard').disabled = busy;
    $('refresh-dashboard').textContent = busy ? t('dashboard.updating') : t('dashboard.refresh');
    document.querySelector('.dash').setAttribute('aria-busy', String(busy));
  },
};
let refreshState = createLatestRefresh(refreshOptions);
function refresh() { return refreshState.refresh(date); }
$('refresh-dashboard').addEventListener('click', refresh);

let pending;
const scheduleRefresh = () => { clearTimeout(pending); pending = setTimeout(() => refreshState.invalidate(date), 400); };
const panelTimers = {};
const schedulePanel = (name, load) => () => { clearTimeout(panelTimers[name]); panelTimers[name] = setTimeout(load, 300); };

function openDoc(title, markdown, filename) {
  $('doc-title').textContent = title;
  $('doc-body').textContent = markdown;
  $('doc-download').onclick = () => {
    const link = el('a', { href: URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' })), download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  $('doc-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(markdown); $('doc-copy').textContent = t('dashboard.copied'); }
    catch { $('doc-copy').textContent = t('dashboard.copyFailed'); }
    setTimeout(() => { $('doc-copy').textContent = t('dashboard.copy'); }, 1500);
  };
  $('doc-dialog').showModal();
}

async function openReport(report) {
  const version = ++inspectGeneration;
  try { const markdown = await api(`/api/daily/reports/${report.date}/${report.number}`); if (version !== inspectGeneration) return; openDoc(t('dashboard.dailyReport2', report.date, String(report.number).padStart(2, '0')), markdown, `wax-daily-${report.date}-${report.number}.md`); }
  catch (error) { showError(error); }
}

async function setPm(self, replace = false) {
  try { await api('/api/team/pm', { method: 'POST', token: config.token, body: self ? { self: true, replace } : {} }); await refresh(); }
  catch (error) { showError(error); }
}

async function cancelTask(task) {
  try { await api(`/api/tasks/${task.id}/cancel`, { method: 'POST', token: config.token, body: { body: t('dashboard.canceledByThePm') } }); await refresh(); }
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
    if (version === inspectGeneration) openDoc(t('dashboard.dailyReportDraftSummary', requestedDate), markdown, `wax-daily-draft-${requestedDate}.md`);
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
  const source = openEvents();
  let connection = 0;
  source.onopen = async () => {
    const version = ++connection;
    $('status').dataset.state = 'sync'; $('status').textContent = t('dashboard.syncingRecords');
    try {
      const nextConfig = await api('/api/config');
      if (version !== connection) return;
      config = nextConfig;
      const result = await refresh();
      if (version !== connection) return;
      $('status').dataset.state = result.status === 'error' ? 'down' : 'live';
      $('status').textContent = result.status === 'error' ? t('dashboard.connectedRecordsNeedRefresh') : t('dashboard.connectedLive');
    } catch (error) { if (version !== connection) return; showError(error); $('status').dataset.state = 'down'; $('status').textContent = t('dashboard.connectedSessionNeedsRefresh'); }
  };
  source.onerror = () => { connection++; $('status').dataset.state = 'down'; $('status').textContent = t('dashboard.disconnectedReconnecting'); };
  for (const name of ['message', 'note', 'report', 'presence', 'features', 'daily', 'tasks', 'resync']) source.addEventListener(name, scheduleRefresh);
  source.addEventListener('rules', schedulePanel('rules', loadRules));
  source.addEventListener('features', schedulePanel('trace', loadTrace));
  source.addEventListener('wiki', schedulePanel('wiki', loadWiki));
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
  document.title = t('dashboard.waxDashboard', config.project);
  $('project').textContent = `${config.project} · v${config.version}`;
  $('date').value = date;
  await refresh();
  loadTrace();
  startLive();
} catch (error) { showError(error); }
