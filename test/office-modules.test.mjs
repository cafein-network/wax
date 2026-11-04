import test from 'node:test';
import assert from 'node:assert/strict';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.text = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; this.text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  set className(value) { this.attributes.class = value; }
  querySelectorAll(selector) { return selector === '[data-tab]' ? walk(this).filter((node) => node.dataset.tab) : []; }
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
globalThis.Node = Node;
globalThis.document = { createElement: (tag) => new Node(tag), createElementNS: (ns, tag) => new Node(tag), createTextNode: (text) => { const node = new Node('#text'); node.text = String(text); return node; }, documentElement: { lang: 'ko' }, hidden: false };
const { createBoardDialog, TYPE_LABELS } = await import('../web/office/board-dialog.mjs');
const { createUsageMonitor, monitorLimits, gaugeTone } = await import('../web/office/usage-monitor.mjs');

function page() {
  const dialog = new Node('dialog');
  for (const tab of ['notes', 'phases', 'reports']) { const button = new Node('button'); button.dataset.tab = tab; dialog.append(button); }
  dialog.open = false; dialog.showModal = () => { dialog.open = true; };
  const nodes = { 'board-dialog': dialog, 'board-select': new Node('select'), 'panel-board': new Node('div'), 'agent-dialog': Object.assign(new Node('dialog'), { showModal() { this.open = true; } }), 'agent-title': new Node('h2'), 'agent-content': new Node('div') };
  return { $: (id) => nodes[id], nodes, win: { addEventListener() {} } };
}
const note = (id, type, extra = {}) => ({ id, type, author: 'codex-app', kind: 'codex', phase: 'plan', at: '2026-10-29T01:00:00Z', body: `${type} 본문`, ...extra });

test('the whiteboard dialog lists boards, filters notes by type and switches tabs', async () => {
  const { $, nodes, win } = page();
  const state = { channels: [{ id: 'general' }], boards: new Map([['login', { notes: [note('n1', 'opinion'), note('n2', 'question', { replyTo: 'n1' })], reports: [] }]]), features: [{ id: 'login', title: '로그인', phase: 'plan' }], config: { labels: { plan: '기획' } }, currentBoard: 'login' };
  const board = createBoardDialog({ $, api: async () => { throw new Error('집계 실패'); }, state, win });
  board.open();
  assert.equal(nodes['board-dialog'].open, true);
  assert.deepEqual(nodes['board-select'].children.map((option) => option.attributes.value), ['general', 'login']);
  assert.equal(nodes['board-select'].value, 'login');
  const panel = nodes['panel-board'];
  assert.match(panel.textContent, /question 본문/); assert.match(panel.textContent, /↳ n1 codex-app: opinion 본문/);
  walk(panel).find((node) => node.tag === 'button' && node.textContent === TYPE_LABELS.question).listeners.click();
  assert.equal(walk(panel).filter((node) => node.tag === 'li').length, 1, 'only the question remains');
  await walk(panel).find((node) => node.textContent === '집계 초안 만들기' && node.tag === 'button').listeners.click();
  assert.match(panel.textContent, /집계 실패/, 'a failed digest shows its reason');
  board.showTab('phases');
  assert.equal(panel.getAttribute('aria-labelledby'), 'tab-phases');
  assert.match(panel.textContent, /기획login로그인/);
  assert.equal(nodes['board-dialog'].children.find((tab) => tab.dataset.tab === 'phases').getAttribute('aria-selected'), 'true');
  board.open('login', 'reports');
  assert.match(panel.textContent, /아직 보고서가 없습니다/);
});

test('the board redraws only while it is open', () => {
  const { $, nodes, win } = page();
  const board = createBoardDialog({ $, api: async () => ({}), state: { channels: [], boards: new Map(), features: [], config: {} }, win });
  board.refresh();
  assert.equal(nodes['panel-board'].children.length, 0);
});

test('the usage monitor shows the spend limit only alone, colours gauges and re-checks tools with the page token', async () => {
  assert.deepEqual(monitorLimits({ limits: [{ kind: 'five_hour' }, { kind: 'spend_limit' }] }).map((l) => l.kind), ['five_hour']);
  assert.deepEqual(monitorLimits({ limits: [{ kind: 'spend_limit' }] }).map((l) => l.kind), ['spend_limit']);
  assert.deepEqual([gaugeTone(10), gaugeTone(60), gaugeTone(85)], ['low', 'mid', 'high']);
  const calls = [], state = { config: { token: 't0k' } };
  const api = async (path, options) => { calls.push([path, options?.method ?? 'GET', options?.token]); return { tools: [{ kind: 'claude' }] }; };
  const { $ } = page();
  const live = createUsageMonitor({ $, api, state, overlayFor() {}, setStyle() {}, requestFrame() {}, doc: document });
  assert.equal(await live.refreshTools({ fresh: true }), true);
  assert.equal(await live.refreshToolNews(), true);
  assert.deepEqual(calls, [['/api/tools/refresh', 'POST', 't0k'], ['/api/tools/news', 'GET', undefined]]);
  const demo = createUsageMonitor({ $, api, state, demo: true, overlayFor() {}, setStyle() {}, requestFrame() {}, doc: document });
  await demo.refreshTools({ fresh: true });
  assert.deepEqual(calls.at(-1), ['/api/tools', 'GET', undefined], 'the demo only reads');
});

test('the usage dialog explains an empty record and lists sessions', () => {
  const { $, nodes } = page();
  const state = { usage: { claude: { limits: [], sessions: [{ session: 'abcdef123456', model: 'opus', context: { percent: 42, tokens: 84000 }, costUsd: 1.5, at: '2026-10-29T01:00:00Z' }] } } };
  createUsageMonitor({ $, api: async () => null, state, overlayFor() {}, setStyle() {}, requestFrame() {}, doc: document }).open();
  assert.equal(nodes['agent-dialog'].open, true);
  const text = nodes['agent-content'].textContent;
  assert.match(text, /아직 기록이 없습니다/); assert.match(text, /abcdef12/); assert.match(text, /42% \(84k\)/); assert.match(text, /\$1\.50/);
});

test('reloading an open board keeps a board the person picked, otherwise follows the current board', () => {
  const { $, nodes, win } = page();
  const state = { channels: [{ id: 'general' }], boards: new Map(), features: [], config: {}, currentBoard: undefined };
  const board = createBoardDialog({ $, api: async () => ({}), state, win });
  board.open();
  assert.equal(nodes['board-select'].value, 'general');
  state.channels.push({ id: 'login' }); state.boards.set('login', { notes: [note('n1', 'decision')], reports: [] }); state.currentBoard = 'login';
  board.reload();
  assert.equal(nodes['board-select'].value, 'login');
  assert.match(nodes['panel-board'].textContent, /decision 본문/);
  nodes['board-select'].value = 'general'; board.choose();
  board.reload();
  assert.equal(nodes['board-select'].value, 'general', 'a picked board survives a reconnect');
});

const { createSkillMapDialog, shade, skillMapView } = await import('../web/office/skill-map.mjs');
const { demoSkillMap, readDemoOfficeApi } = await import('../web/office/demo.mjs');
const { demoOfficeSnapshot, normalizeDemoOptions } = await import('../web/workflow-demo-model.mjs');
const find = (node, test) => walk(node).filter(test);

test('skill map: draws server counts as a grid with gaps, failures and a pinned name column', async () => {
  const map = {
    groups: { phase: '단계', check: '검증', area: '코드 영역' }, unattributed: 2, hiddenAreas: 0,
    columns: [
      { key: 'phase:plan', group: 'phase', label: '기획', holders: 1 }, { key: 'phase:review', group: 'phase', label: '검토', holders: 0 },
      { key: 'check:test', group: 'check', label: '테스트', holders: 1 }, { key: 'area:src', group: 'area', label: 'src', holders: 1 },
    ],
    people: [{ author: 'codex', kind: 'codex', total: 7, cells: { 'phase:plan': { count: 1, failed: 0 }, 'check:test': { count: 6, failed: 2 }, 'area:src': { count: 3, failed: 0 } } }],
    gaps: { empty: ['검토'], single: [{ label: 'src', author: 'codex' }] },
  };
  const view = skillMapView(map);
  const groupHeads = find(view, (n) => n.attributes.scope === 'colgroup');
  assert.deepEqual(groupHeads.map((n) => [n.textContent, n.attributes.colspan]), [['단계', '2'], ['검증', '1'], ['코드 영역', '1']]);
  assert.equal(find(view, (n) => n.tag === 'th' && n.attributes.class === 'gap')[0].textContent, '검토');
  assert.equal(find(view, (n) => n.attributes.scope === 'row')[0].children[0].textContent, 'codex', 'the row header is the name');
  const cells = find(view, (n) => n.attributes.class?.startsWith('skill-cell'));
  assert.deepEqual(cells.map((n) => n.attributes.class), ['skill-cell level-1', 'skill-cell level-0', 'skill-cell level-3', 'skill-cell level-2']);
  assert.match(cells[2].attributes['aria-label'], /테스트: 6건, 실패 2건/);
  assert.match(cells[1].attributes['aria-label'], /기록 없음/);
  assert.match(view.textContent, /빈 분야 검토/);
  assert.match(view.textContent, /src\(codex\)/);
  assert.match(view.textContent, /작성자를 알 수 없는 근거 2개/);
  assert.deepEqual([0, 1, 2, 4, 5].map(shade), [0, 1, 2, 2, 3]);
  assert.match(skillMapView({ ...map, people: [] }).textContent, /아직 참여한 세션이나 기록이 없습니다/);
});

test('skill map dialog: opens at once, then shows the map or a load failure', async () => {
  const dialog = Object.assign(new Node('dialog'), { open: false, showModal() { this.open = true; } });
  const nodes = { 'skill-dialog': dialog, 'skill-content': new Node('div') };
  let answer = Promise.reject(new Error('down'));
  const skills = createSkillMapDialog({ $: (id) => nodes[id], api: () => answer });
  await skills.open();
  assert.equal(dialog.open, true);
  assert.match(nodes['skill-content'].textContent, /불러오지 못했습니다/);
  const snapshot = demoOfficeSnapshot(Number.MAX_SAFE_INTEGER, normalizeDemoOptions());
  answer = Promise.resolve(readDemoOfficeApi(snapshot, '/api/skills/map'));
  await skills.open();
  assert.match(nodes['skill-content'].textContent, /planner/);
  const demo = demoSkillMap(snapshot);
  assert.ok(demo.people.every((p) => p.total > 0 || p.author === 'PM'), 'a finished demo fills every worker’s phases');
  assert.deepEqual(demo.gaps.empty, []);
});

const { workNotesPanel, workNotesView } = await import('../web/office/work-notes.mjs');

test('work notes: draws open tasks, the last memo and one folded section per day, newest open', async () => {
  const entry = (type, title, extra = {}) => ({ at: '2026-10-30T01:00:00.000Z', type, title, detail: `${title} 내용`, feature: 'login', ...extra });
  const notes = {
    author: 'codex-app', days: 7,
    open: [{ id: 't-1', feature: 'login', phase: 'implement', status: 'blocked', note: 'SMTP 키' }],
    lastMemo: { at: '2026-10-30T02:00:00.000Z', body: '다음: 재시도' },
    dayList: [
      { date: '2026-10-30', counts: { tasksDone: 1, testsPassed: 2, testsFailed: 1, commits: 1, messages: 3 }, entries: [entry('test', '테스트 실패', { passed: false }), entry('memo', '메모'), entry('commit', '커밋 연결 abc1234')] },
      { date: '2026-10-29', counts: { tasksDone: 0, testsPassed: 0, testsFailed: 0, commits: 0, messages: 1 }, entries: [entry('message', '질문 #login')] },
    ],
  };
  const view = workNotesView(notes);
  const days = find(view, (n) => n.tag === 'details');
  assert.equal(days.length, 2);
  assert.equal(days[0].attributes.open, '', 'the newest day is open');
  assert.equal(days[1].attributes.open, undefined);
  assert.match(days[0].textContent, /업무 완료 1 · 테스트 2\/3 통과 · 커밋 1 · 메시지 3/);
  assert.deepEqual(find(days[0], (n) => n.tag === 'li').map((n) => n.attributes.class), ['worknote-test failed', 'worknote-memo', 'worknote-commit']);
  assert.match(view.textContent, /막힘 loginSMTP 키/);
  assert.match(view.textContent, /다음: 재시도/);
  assert.match(workNotesView({ ...notes, open: [], lastMemo: null, dayList: [] }).textContent, /지금 맡은 업무가 없습니다.*남긴 메모가 없습니다.*최근 7일 동안 남은 기록이 없습니다/);

  const asked = [];
  const panel = workNotesPanel({ api: async (path) => { asked.push(path); return notes; }, author: '사람 1' });
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(asked, ['/api/work-notes/%EC%82%AC%EB%9E%8C%201?days=7']);
  assert.match(panel.textContent, /다음: 재시도/);
  const failed = workNotesPanel({ api: async () => { throw new Error('down'); }, author: 'x' });
  await new Promise((done) => setTimeout(done, 0));
  assert.match(failed.textContent, /작업노트를 불러오지 못했습니다/);

  const snapshot = demoOfficeSnapshot(Number.MAX_SAFE_INTEGER, normalizeDemoOptions());
  const demo = readDemoOfficeApi(snapshot, '/api/work-notes/planner');
  assert.equal(demo.author, 'planner');
  assert.ok(demo.dayList[0].entries.length > 0);
  assert.match(workNotesView(demo).textContent, /가상 데모/);
});

const { rulesView } = await import('../web/rules-panel.mjs');

test('rules panel: pending rules first with approve and reject, applied rules with retire, closed ones folded', () => {
  const rule = (id, status, extra = {}) => ({ id, status, body: `${id} 규칙`, why: '이유', sources: ['iterate:login/3'], author: 'claude-pm', at: '2026-10-30T01:00:00.000Z', decidedBy: status === 'proposed' ? null : '대표', ...extra });
  const decided = [];
  const { items, summary } = rulesView({ rules: [rule('r-a', 'approved'), rule('r-p', 'proposed'), rule('r-x', 'rejected'), rule('r-y', 'retired')], candidates: 3 }, (r, action) => decided.push([r.id, action]));
  assert.equal(summary, '적용 1 · 대기 1');
  assert.deepEqual(items.map((n) => n.attributes.class), ['rule-item rule-proposed', 'rule-item rule-approved', 'rule-closed']);
  const buttons = (node) => find(node, (n) => n.tag === 'button');
  assert.deepEqual(buttons(items[0]).map((b) => b.textContent), ['승인', '거절']);
  assert.deepEqual(buttons(items[1]).map((b) => b.textContent), ['폐기']);
  assert.equal(buttons(items[2]).length, 0, 'closed rules have no actions');
  assert.match(items[2].textContent, /거절·폐기 2개/);
  const approve = buttons(items[0])[0];
  approve.listeners.click({ currentTarget: approve });
  assert.equal(approve.disabled, true, 'a click cannot be sent twice');
  assert.deepEqual(decided, [['r-p', 'approve']]);
  assert.match(items[0].textContent, /iterate:login\/3/);
  assert.match(rulesView({ rules: [], candidates: 2 }, () => {}).items[0].textContent, /실수 기록이 2개/);
  assert.match(rulesView({ rules: [], candidates: 0 }, () => {}).items[0].textContent, /AI 세션이 근거와 함께 제안/);
});

const { wikiView } = await import('../web/wiki-panel.mjs');

test('wiki panel: pages open on click and show lint problems; empty and pending states', () => {
  const opened = [];
  const page = { slug: 'auth', title: '인증', path: 'docs/wax/wiki/auth.md', errors: 1, warnings: 1, problems: [{ level: 'error', message: '찾을 수 없는 근거 doc:login/implement' }, { level: 'warning', message: '저장 뒤에 바뀐 파일' }] };
  const { items, summary } = wikiView({ pages: [page, { ...page, slug: 'ok', title: '정상', errors: 0, warnings: 0, problems: [] }], pending: 4 }, (p) => opened.push(p.slug));
  assert.equal(summary, '페이지 2 · 반영 대기 기록 4');
  assert.equal(items[0].attributes.class, 'wiki-item has-errors');
  assert.match(items[0].textContent, /오류 1 · 확인 1/);
  assert.match(items[1].textContent, /근거 확인됨/);
  find(items[0], (n) => n.tag === 'button')[0].listeners.click();
  assert.deepEqual(opened, ['auth']);
  assert.deepEqual(find(items[0], (n) => n.tag === 'li' && n !== items[0]).map((n) => n.attributes.class), ['error', 'warning']);
  const empty = wikiView({ pages: [], pending: 0 }, () => {});
  assert.equal(empty.summary, '페이지 0');
  assert.match(empty.items[0].textContent, /wax wiki ingest/);
});

test('room tabs: one tab per floor with head counts, redrawn only when they change; arrows wrap around', async () => {
  const { createRoomTabs, neighborRoom, floorScrollTop, roomTabsModel } = await import('../web/office/room-tabs.mjs');
  const { SIDE_ROOM_ORDER, BUILDING } = await import('../web/office/side-rooms.mjs');
  const tabs = Object.assign(new Node('div'), { contains: () => false, querySelector: () => null });
  const state = { room: 'dev', scene: [{ author: 'codex', spot: 'd1', room: 'dev' }, { author: 'claude', spot: null, room: 'meeting' }] };
  const stored = [], scrolled = [];
  const win = { scrollY: 100, scrollTo: (options) => scrolled.push(options) };
  const stage = { getBoundingClientRect: () => ({ top: 20, width: BUILDING.SIZE.width / 2 }) };
  const room = createRoomTabs({ $: () => tabs, state, store: (key, value) => stored.push([key, value]), stage, win, doc: { activeElement: null } });
  room.render();
  assert.equal(tabs.children.length, SIDE_ROOM_ORDER.length);
  const dev = tabs.children.find((tab) => tab.attributes['data-room'] === 'dev');
  assert.equal(dev.attributes['aria-selected'], 'true');
  assert.match(dev.textContent, /1명/);
  assert.equal(dev.attributes.title, 'codex');
  const first = tabs.children[0];
  room.render();
  assert.equal(tabs.children[0], first, 'an unchanged scene keeps the same tabs');
  room.select('meeting');
  assert.equal(state.room, 'meeting');
  assert.deepEqual(stored, [['wax.office.room', 'meeting']]);
  assert.deepEqual(scrolled, [{ top: floorScrollTop('meeting', { top: 20, width: BUILDING.SIZE.width / 2, scrollY: 100 }), behavior: 'smooth' }]);
  room.select('nowhere');
  assert.equal(state.room, 'meeting');
  assert.equal(floorScrollTop('dev', { top: 0, width: BUILDING.SIZE.width, scrollY: 0 }), BUILDING.floorTop.dev - 80);
  assert.equal(floorScrollTop('nowhere', { top: 0, width: 1, scrollY: 0 }), null);
  const last = SIDE_ROOM_ORDER.at(-1);
  assert.equal(neighborRoom(SIDE_ROOM_ORDER, last, 'ArrowRight'), SIDE_ROOM_ORDER[0]);
  assert.equal(neighborRoom(SIDE_ROOM_ORDER, SIDE_ROOM_ORDER[0], 'ArrowLeft'), last);
  assert.equal(neighborRoom(SIDE_ROOM_ORDER, 'dev', 'Enter'), null);
  assert.notEqual(roomTabsModel(state.scene, 'dev').key, roomTabsModel(state.scene, 'meeting').key);
});

test('list view: rows describe each session, an empty office explains how to join, hidden lists wait until shown', async () => {
  const { agentRow, createListView, EMPTY_LIST } = await import('../web/office/list-view.mjs');
  const nodes = { 'agent-rows': new Node('tbody'), 'list-view': new Node('section'), 'office-view': new Node('section'), 'view-toggle': new Node('button') };
  const state = { scene: [], agents: [{ author: 'codex', lastActive: '2026-10-31T01:00:00Z' }], recent: new Map([['codex', [{ channel: 'login', text: 'x'.repeat(100), at: '2026-10-31T01:00:00Z' }]]]) };
  const row = agentRow({ author: 'codex', kind: 'codex', state: 'working', spot: 'd1', room: 'meeting', feature: 'login' }, state);
  assert.equal(row.room, '회의실');
  assert.equal(row.last, `[login] ${'x'.repeat(80)}`);
  assert.match(agentRow({ author: 'x', kind: 'other', state: 'idle', spot: null, seated: false }, state).state, /\(자리 없음\)$/);
  const stored = [];
  let frames = 0;
  const list = createListView({ $: (id) => nodes[id], state, store: (key, value) => stored.push([key, value]), openAgent() {}, requestFrame: () => { frames++; } });
  list.render();
  assert.equal(nodes['agent-rows'].children.length, 0, 'the hidden list is not drawn');
  list.toggle();
  assert.equal(list.isList(), true);
  assert.deepEqual(stored, [['wax-chat.office.view', 'list']]);
  assert.equal(nodes['office-view'].hidden, true);
  assert.equal(nodes['view-toggle'].textContent, '사무실 보기');
  assert.equal(nodes['agent-rows'].textContent, EMPTY_LIST);
  list.toggle();
  assert.equal(frames, 1, 'going back to the office redraws it');
});
