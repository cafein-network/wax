import { t } from '../messages-catalog.mjs';
import { CLI_NEWS } from './cli-news.mjs';
import { DEMO_DESIGN } from './studio-demo.mjs';
import { DEMO_PHASE_KEYS, demoOfficeSnapshot, normalizeDemoOptions } from '../workflow-demo-model.mjs';

const DEMO_PHASE_LABELS = { plan: t('office.demo.plan'), design: t('office.demo.design'), implement: t('office.demo.implement'), review: t('office.demo.review'), report: t('office.demo.report') };
export function demoSkillMap(snapshot) {
  const { team, step } = snapshot.view;
  const finished = (phase) => step.done || phase < step.phase;
  const people = team.map((person) => {
    const cells = {};
    for (const phase of person.phases) if (finished(phase)) cells[`phase:${DEMO_PHASE_KEYS[phase]}`] = { count: 1, failed: 0 };
    return { author: person.author, kind: person.kind, total: Object.keys(cells).length, cells };
  }).sort((a, b) => b.total - a.total);
  const columns = Object.entries(DEMO_PHASE_LABELS).map(([id, label]) => {
    const owners = people.filter((p) => p.cells[`phase:${id}`]);
    return { key: `phase:${id}`, group: 'phase', label, holders: owners.length, total: owners.length, only: owners.length === 1 ? owners[0].author : null };
  });
  return { groups: { phase: t('office.demo.stage'), check: t('office.demo.checks'), area: t('office.demo.codeArea') }, columns, people, unattributed: 0, hiddenAreas: 0,
    gaps: { empty: columns.filter((c) => !c.holders).map((c) => c.label), single: columns.filter((c) => c.only).map((c) => ({ label: c.label, author: c.only })) } };
}

const DEMO_NOTE_TITLES = { opinion: t('office.demo.whiteboardOpinion'), question: t('office.demo.whiteboardQuestion'), answer: t('office.demo.whiteboardAnswer'), decision: t('office.demo.whiteboardDecision') };
export function demoWorkNotes(snapshot, author) {
  const entries = snapshot.notes.filter((note) => note.author === author)
    .map((note) => ({ at: note.at, type: 'note', messageType: note.type, feature: 'demo-work', id: note.id, title: DEMO_NOTE_TITLES[note.type] ?? t('office.demo.whiteboardNotes'), detail: note.body }));
  const mine = snapshot.tasks.filter((task) => task.to === author);
  const date = new Date().toISOString().slice(0, 10);
  return { author, kind: snapshot.agents.find((agent) => agent.author === author)?.kind ?? 'other', days: 7, generatedAt: new Date().toISOString(),
    open: mine.filter((task) => task.status !== 'done').map(({ id, feature, phase, status, note, at }) => ({ id, feature, phase, status, note, at })), lastMemo: null,
    dayList: entries.length ? [{ date, entries, counts: { tasksDone: mine.filter((task) => task.status === 'done').length, tasksBlocked: 0, testsPassed: 0, testsFailed: 0, commits: 0, messages: entries.length, memos: 0 } }] : [] };
}

export function readDemoOfficeApi(snapshot, path) {
  const url = new URL(path, 'http://demo.local');
  const route = url.pathname;
  if (route === '/api/config') return { project: t('office.demo.uxDemo'), description: snapshot.view.task.title, awayAfterMs: 600_000, user: t('office.demo.visitor'), labels: { plan: t('office.demo.plan'), design: t('office.demo.design'), implement: t('office.demo.implement'), review: t('office.demo.review'), report: t('office.demo.report'), done: t('office.demo.done') } };
  if (route === '/api/presence') return snapshot.agents;
  if (route === '/api/features') return snapshot.features;
  if (route === '/api/channels') return [{ id: 'demo-work', count: snapshot.messages.length }];
  if (route === '/api/team') return { pm: { author: 'PM', kind: 'human' }, tasks: snapshot.tasks };
  if (route === '/api/profiles') return { profiles: snapshot.profiles };
  if (route === '/api/skills/map') return demoSkillMap(snapshot);
  if (route.startsWith('/api/work-notes/')) return demoWorkNotes(snapshot, decodeURIComponent(route.slice('/api/work-notes/'.length)));
  if (route === '/api/tools/news') return { ...CLI_NEWS, mode: 'bundled' };
  if (route === '/api/tools') return { tools: [] };
  if (route === '/api/design') return DEMO_DESIGN;
  if (route === '/api/usage') return { claude: { limits: [{ kind: 'five_hour', percentUsed: Math.min(75, 20 + snapshot.view.index * 2) }], sessions: [], limitsAt: new Date().toISOString() } };
  if (route === '/api/channels/demo-work/messages') return { messages: snapshot.messages };
  if (route === '/api/board/demo-work') return { notes: snapshot.notes, reports: snapshot.reports };
  if (route === '/api/board/demo-work/digest') return { markdown: `# 가상 데모 집계\n\n${snapshot.notes.map((note) => `- ${note.author}: ${note.body}`).join('\n')}` };
  if (/^\/api\/board\/demo-work\/reports\/\d+$/.test(route)) return `# [가상 데모] ${snapshot.view.task.title}\n\n## 완료한 변경\n${snapshot.view.events.map((event) => `- ${event.title}: ${event.detail}`).join('\n')}\n\n## 검증\n통과 ${snapshot.view.passed}회 / 실패 이력 ${snapshot.view.failed}회\n\n실제 실행 결과가 아닌 UX 체험용 보고서입니다.`;
  throw new Error(t('office.demo.thatRouteIsNot'));
}
export function createOfficeDemo(win) {
  let options = normalizeDemoOptions(), position = 0, rate = 1, jumped = false, initialized = false, lastCast = [];
  const demo = {
    onStep: null, onAction: null,
    api: async (path, request = {}) => {
      if (request.method && request.method !== 'GET') throw new Error(t('office.demo.theDemoDoesNot'));
      return structuredClone(readDemoOfficeApi(demoOfficeSnapshot(position, options), path));
    },
    get rate() { return rate; },
    get jumped() { return jumped; },
    get snapshot() { return demoOfficeSnapshot(position, options); },
    cast(cast) { lastCast = cast; win.parent.postMessage({ type: 'wax-demo-cast', cast }, win.location.origin); },
    failed() { win.parent.postMessage({ type: 'wax-demo-error' }, win.location.origin); },
    ready() { initialized = true; win.parent.postMessage({ type: 'wax-demo-ready' }, win.location.origin); },
    interacted() { win.parent.postMessage({ type: 'wax-demo-interaction' }, win.location.origin); },
  };
  const receive = (event) => {
    if (event.source !== win.parent || event.origin !== win.location.origin || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'wax-demo-ping') {
      if (initialized) { demo.cast(lastCast); demo.ready(); }
    } else if (event.data.type === 'wax-demo-step') {
      const next = normalizeDemoOptions(event.data.options), index = demoOfficeSnapshot(event.data.position, next).view.index;
      rate = [1, 2, 4].includes(event.data.rate) ? event.data.rate : 1;
      const changed = JSON.stringify(options) !== JSON.stringify(next);
      if (position === index && !changed) return;
      jumped = changed || index === 0 || Math.abs(position - index) > 1;
      position = index; options = next;
      Promise.resolve().then(() => demo.onStep?.()).catch(() => demo.failed());
    } else if (event.data.type === 'wax-demo-action' && ['agent', 'board', 'report'].includes(event.data.action)) {
      if (event.data.action === 'agent' && !demo.snapshot.agents.some((agent) => agent.author === event.data.author)) return;
      demo.onAction?.(event.data);
    }
  };
  win.addEventListener('message', receive);
  win.addEventListener('pagehide', () => win.removeEventListener('message', receive));
  win.addEventListener('pageshow', (event) => { if (event.persisted) { win.addEventListener('message', receive); demo.cast(lastCast); if (initialized) demo.ready(); } });
  return demo;
}
