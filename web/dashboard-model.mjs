import { t } from './messages-catalog.mjs';
const matches = (record, feature) => !feature || record.feature === feature;
const oldest = (a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
const newest = (a, b) => -oldest(a, b);
const take = (items, limit) => items.slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0);

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify([item.kind, item.feature, item.recordId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function deriveAttention(day, { feature, limit = 5 } = {}) {
  const blocked = (day.tasks ?? []).filter((task) => task.status === 'blocked' && matches(task, feature)).map((task) => {
    const latest = task.updates?.at(-1);
    return {
      id: `blocked:${task.feature}:${task.id}`, kind: 'blocked', feature: task.feature,
      title: t('dashboardModel.blockedTask', task.to), detail: latest?.note || task.note || '',
      at: task.statusAt ?? latest?.at ?? task.at, target: 'tasks', recordId: task.id,
    };
  }).sort(oldest);
  const tests = (day.events ?? []).filter((event) => event.type === 'proof' && event.proof === 'test');
  const failed = tests.filter((event) => event.passed === false && matches(event, feature)
    && !tests.some((later) => later.passed === true && later.feature === event.feature && later.phase === event.phase && String(later.at) > String(event.at)))
    .slice().sort(newest).map((event) => ({
      id: `test:${event.feature}:${event.id}`, kind: 'test', feature: event.feature,
      title: `테스트 실패 기록${event.phase ? ` · ${event.phase}` : ''}`,
      detail: event.detail ?? '', at: event.at, target: 'timeline', recordId: event.id,
    }));
  const questions = (day.openQuestions ?? []).filter((question) => matches(question, feature)).slice().sort(oldest).map((question) => ({
    id: `question:${question.feature}:${question.id}`, kind: 'question', feature: question.feature,
    title: t('dashboardModel.unresolvedQuestion', question.author), detail: question.body ?? '',
    at: question.at, target: 'questions', recordId: question.id,
  }));
  return take(unique([...blocked, ...failed, ...questions]), limit);
}

export function deriveDecisions(day, { feature, limit = 3 } = {}) {
  const seen = new Set();
  return take((day.events ?? []).filter((event) => matches(event, feature)
    && (event.messageType === 'decision' || event.noteType === 'decision'))
    .slice().sort(newest).filter((event) => {
      const key = JSON.stringify([event.type, event.feature, event.id]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }), limit);
}

export function paginateTimeline(events, { page = 1, size = 20, recordId } = {}) {
  const pages = Math.max(1, Math.ceil(events.length / size));
  const index = recordId ? events.findIndex((event) => event.id === recordId) : -1;
  const current = index >= 0 ? Math.floor(index / size) + 1 : Math.min(pages, Math.max(1, Math.trunc(page) || 1));
  const start = (current - 1) * size;
  return { page: current, pages, total: events.length, start: events.length ? start + 1 : 0,
    end: Math.min(start + size, events.length), items: events.slice(start, start + size) };
}

const FLOW_PHASES = ['plan', 'design', 'implement', 'review', 'report'];
export function deriveTimelineFlow(events) {
  const groups = new Map();
  for (const event of events) {
    const feature = event.feature ?? null;
    if (!groups.has(feature)) groups.set(feature, { feature, stages: [...FLOW_PHASES, 'other'].map((phase) => ({ phase, events: [] })) });
    const phase = FLOW_PHASES.includes(event.phase) ? event.phase : 'other';
    groups.get(feature).stages.find((stage) => stage.phase === phase).events.push(event);
  }
  return [...groups.values()];
}

export function formatDuration(ms) {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (minutes < 1) return t('dashboard.durationUnderMinute');
  if (minutes < 60) return t('dashboard.durationMinutes', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('dashboard.durationHoursMinutes', hours, minutes % 60);
  return t('dashboard.durationDaysHours', Math.floor(hours / 24), hours % 24);
}

export function durationItems(durations) {
  const phases = durations?.phases ?? {};
  const open = (phase) => durations.inProgress === phase;
  const items = FLOW_PHASES.filter((phase) => phases[phase]?.visits > 0 && (phases[phase].ms > 0 || open(phase))).map((phase) => ({
    phase, inProgress: open(phase),
    text: !open(phase) ? formatDuration(phases[phase].ms) : phases[phase].ms < 60_000 ? t('dashboard.durationJustStarted') : t('dashboard.durationSoFar', formatDuration(phases[phase].ms)),
  }));
  return items.length ? [...items, { phase: 'total', text: t('dashboard.durationTotal', formatDuration(durations.totalMs)) }] : [];
}
