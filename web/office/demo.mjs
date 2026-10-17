import { CLI_NEWS } from './cli-news.mjs';
import { DEMO_DESIGN } from './studio-demo.mjs';
import { demoOfficeSnapshot, normalizeDemoOptions } from '../workflow-demo-model.mjs';

export function readDemoOfficeApi(snapshot, path) {
  const url = new URL(path, 'http://demo.local');
  const route = url.pathname;
  if (route === '/api/config') return { project: '가상 UX 데모', description: snapshot.view.task.title, awayAfterMs: 600_000, user: '방문자', labels: { plan: '기획', design: '설계', implement: '구현', review: '검토', report: '보고', done: '완료' } };
  if (route === '/api/presence') return snapshot.agents;
  if (route === '/api/features') return snapshot.features;
  if (route === '/api/channels') return [{ id: 'demo-work', count: snapshot.messages.length }];
  if (route === '/api/team') return { pm: { author: 'PM', kind: 'human' }, tasks: snapshot.tasks };
  if (route === '/api/profiles') return { profiles: snapshot.profiles };
  if (route === '/api/tools/news') return { ...CLI_NEWS, mode: 'bundled' };
  if (route === '/api/tools') return { tools: [] };
  if (route === '/api/design') return DEMO_DESIGN;
  if (route === '/api/usage') return { claude: { limits: [{ kind: 'five_hour', percentUsed: Math.min(75, 20 + snapshot.view.index * 2) }], sessions: [], limitsAt: new Date().toISOString() } };
  if (route === '/api/channels/demo-work/messages') return { messages: snapshot.messages };
  if (route === '/api/board/demo-work') return { notes: snapshot.notes, reports: snapshot.reports };
  if (route === '/api/board/demo-work/digest') return { markdown: `# 가상 데모 집계\n\n${snapshot.notes.map((note) => `- ${note.author}: ${note.body}`).join('\n')}` };
  if (/^\/api\/board\/demo-work\/reports\/\d+$/.test(route)) return `# [가상 데모] ${snapshot.view.task.title}\n\n## 완료한 변경\n${snapshot.view.events.map((event) => `- ${event.title}: ${event.detail}`).join('\n')}\n\n## 검증\n통과 ${snapshot.view.passed}회 / 실패 이력 ${snapshot.view.failed}회\n\n실제 실행 결과가 아닌 UX 체험용 보고서입니다.`;
  throw new Error('데모에서 제공하지 않는 경로입니다.');
}
export function createOfficeDemo(win) {
  let options = normalizeDemoOptions(), position = 0, rate = 1, jumped = false, initialized = false, lastCast = [];
  const demo = {
    onStep: null, onAction: null,
    api: async (path, request = {}) => {
      if (request.method && request.method !== 'GET') throw new Error('데모는 실제 데이터를 변경하지 않습니다.');
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
