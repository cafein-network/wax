import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPE_LABELS, addMessage, addNote, addToOrder, loadSnapshot, npcContext, pickCurrentBoard, teamSummary } from '../web/office/scene-state.mjs';
import { MAX_FLIGHTS, OUTFIT_COLORS, createFlights } from '../web/office/flights.mjs';
import { bubbleText, stackBubbles, stackTags } from '../web/office/bubble-layout.mjs';
import { createAmbient, floorOfActor, sameFloor } from '../web/office/ambient.mjs';
import { BUILDING } from '../web/office/side-rooms.mjs';
import { LAND_MS } from '../web/office/notes.mjs';

const empty = () => ({ agents: [], features: [], channels: [], events: [], recent: new Map(), lastNoteAt: new Map(), boards: new Map(), order: [], scene: [], bubbles: new Map(), config: { project: 'wax', awayAfterMs: 60_000, labels: {} } });
const at = (minute) => `2026-10-31T01:${String(minute).padStart(2, '0')}:00Z`;

test('scene state keeps recent posts in order, de-duplicates notes and tracks the latest note per author', () => {
  const state = empty();
  addMessage(state, 'general', { author: 'codex', at: at(5), body: '둘째', type: 'question', to: ['claude'] });
  addMessage(state, 'general', { author: 'codex', at: at(1), body: '첫째' });
  assert.deepEqual(state.recent.get('codex').map((r) => [r.text, r.label]), [['첫째', '메시지'], ['둘째', TYPE_LABELS.question]]);
  assert.deepEqual(state.events[0].to, ['claude']);
  const note = { id: 'n1', author: 'claude', at: at(3), body: '결정', type: 'decision' };
  addNote(state, 'login', note); addNote(state, 'login', note);
  assert.equal(state.boards.get('login').notes.length, 1, 'the same note is kept once');
  addNote(state, 'login', { ...note, id: 'n0', at: at(2) });
  assert.equal(state.lastNoteAt.get('claude'), at(3), 'an older note does not move the latest note time back');
  assert.equal(state.recent.get('claude')[0].label, '보드 결정');
  for (let i = 0; i < 25; i++) addMessage(state, 'general', { author: 'gemini', at: at(10 + i), body: `${i}` });
  assert.equal(state.recent.get('gemini').length, 20);
  addToOrder(state, ['a', 'b']); addToOrder(state, ['b', 'c']);
  assert.deepEqual(state.order, ['a', 'b', 'c']);
});

test('the current board is the requested feature, else the board with the newest note, else the first feature', () => {
  const state = { ...empty(), features: [{ id: 'login' }, { id: 'search' }] };
  pickCurrentBoard(state);
  assert.equal(state.currentBoard, 'login');
  state.boards.set('general', { notes: [{ at: at(1) }], reports: [] }); state.boards.set('search', { notes: [{ at: at(4) }], reports: [] });
  pickCurrentBoard(state);
  assert.equal(state.currentBoard, 'search');
  pickCurrentBoard(state, 'login');
  assert.equal(state.currentBoard, 'login');
  pickCurrentBoard(state, 'gone');
  assert.equal(state.currentBoard, 'search', 'an unknown ?board= falls back');
  const none = empty(); pickCurrentBoard(none);
  assert.equal(none.currentBoard, 'general', 'with no features or notes the general board opens');
});

test('loading a snapshot reads every channel and board, orders active sessions first and survives a missing team', async () => {
  const state = empty();
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === '/api/presence') return [{ author: 'old', lastActive: at(0) }, { author: 'new', lastActive: at(30) }];
    if (path === '/api/features') return [{ id: 'login' }];
    if (path === '/api/channels') return [{ id: 'general', count: 1 }, { id: 'login', count: 0 }];
    if (path === '/api/team') throw new Error('없음');
    if (path.startsWith('/api/channels/general/messages')) return { messages: [{ author: 'new', at: at(29), body: '안녕' }] };
    if (path === '/api/board/login') return { notes: [{ id: 'n1', author: 'old', at: at(20), body: '노트', type: 'opinion' }], reports: [{ id: 'r1' }] };
    return { notes: [], reports: [] };
  };
  await loadSnapshot(state, api, { now: Date.parse(at(30)) });
  assert.deepEqual(state.order, ['new', 'old']);
  assert.equal(state.pm, null);
  assert.deepEqual(state.tasks, []);
  assert.ok(!calls.includes('/api/channels/login/messages?limit=50'), 'an empty channel is not read');
  assert.equal(state.boards.get('login').reports.length, 1);
  assert.equal(state.currentBoard, 'login');
  assert.equal(state.recent.get('new')[0].text, '안녕');
});

test('NPC context and the CEO card summary count only live work from the scene', () => {
  const state = { ...empty(), pm: 'claude', features: [{ id: 'a', phase: 'plan' }, { id: 'b', phase: 'done' }, { id: 'c', phase: 'plan', archivedAt: at(0) }],
    scene: [{ author: 'claude', kind: 'claude', state: 'working', room: 'meeting', group: 'general' }, { author: 'codex', kind: 'codex', state: 'idle', room: 'meeting', group: 'a' }, { author: 'ceo', kind: 'human', state: 'working' }],
    agents: [{ author: 'claude', model: 'opus' }], tasks: [{ status: 'blocked' }, { status: 'done' }, {}] };
  const context = npcContext(state, Date.parse(at(0)));
  assert.deepEqual(context.features.map((f) => f.id), ['a', 'b']);
  assert.equal(context.active, 1);
  assert.equal(context.working, 2);
  assert.deepEqual(context.meetings, ['wax', 'a']);
  assert.equal(context.agents[0].model, 'opus');
  assert.deepEqual(context.limits, []);
  assert.deepEqual(teamSummary(state), { ai: 2, working: 1, active: 1, done: 1, openTasks: 2, blocked: 1, pm: 'claude' });
});

const drawnActor = (author, kind, room, x) => {
  const y = BUILDING.floorTop[room] + 200;
  return { author, kind, visible: true, leaving: false, x, y, drawn: { x, y, persona: 'm1', scale: 1, sit: false, pose: {} } };
};

test('note flights fly between drawn sessions or to the whiteboard, never to NPCs or oneself, and land', () => {
  const actors = new Map([['a', drawnActor('codex', 'codex', 'dev', 300)], ['b', drawnActor('claude', 'claude', 'meeting', 500)], ['n', { ...drawnActor('써니', 'other', 'dev', 400), npc: 'guide' }]]);
  let frames = 0;
  const state = { assets: null, events: [] };
  const flights = createFlights({ actors, state, requestFrame: () => { frames++; }, later: (fn) => fn() });
  assert.equal(flights.launch('codex', { to: 'claude' }), true);
  assert.equal(flights.flights[0].tone, OUTFIT_COLORS.codex);
  assert.ok(flights.flights[0].points.length >= 2);
  assert.equal(flights.launch('codex', { to: '써니' }), false, 'an NPC does not receive notes');
  assert.equal(flights.launch('codex', { to: 'codex' }), false);
  assert.equal(flights.launch('nobody', { to: 'claude' }), false);
  flights.deliverNote('claude');
  assert.equal(flights.flights.length, 2, 'a board note flies to the whiteboard');
  assert.equal(frames, 2);
  flights.deliverMessage('general', { author: 'claude', at: at(1), to: ['codex', 'claude'] });
  assert.equal(flights.flights.length, 3, 'a message flies to each addressee except the author');
  assert.equal(flights.move(0.01, 0), true);
  assert.equal(flights.move(100, 1000), true, 'a landed note stays until its landing mark fades');
  assert.equal(flights.move(0, 1000 + LAND_MS), false);
  for (let i = 0; i < MAX_FLIGHTS + 3; i++) flights.launch('codex', { to: 'claude' });
  assert.equal(flights.flights.length, MAX_FLIGHTS);
});

test('demo speed scales how far a note flies', () => {
  const actors = new Map([['a', drawnActor('codex', 'codex', 'dev', 300)], ['b', drawnActor('claude', 'claude', 'dev', 900)]]);
  const fast = createFlights({ actors, state: { assets: null, events: [] }, requestFrame() {}, rate: () => 4 });
  const slow = createFlights({ actors, state: { assets: null, events: [] }, requestFrame() {} });
  fast.launch('codex', { to: 'claude' }); slow.launch('codex', { to: 'claude' });
  fast.move(0.01, 0); slow.move(0.01, 0);
  assert.ok(Math.abs(fast.flights[0].dist - 4 * slow.flights[0].dist) < 1e-9);
});

test('bubble text is flattened, translated only for chatter and cut by kind', () => {
  const upper = (text) => text.toUpperCase();
  assert.equal(bubbleText('a  b\nc', 'message', 6000, upper).text, 'a b c', 'messages are shown as written');
  assert.equal(bubbleText('hi', 'chatter', 6000, upper).text, 'HI');
  assert.equal(bubbleText('x'.repeat(70), 'chatter').text, `${'x'.repeat(60)}…`);
  assert.equal(bubbleText('x'.repeat(70), 'npc').text.length, 70, 'NPC guides keep longer lines');
  assert.equal(bubbleText('🧠', 'emote', 1200).ms, 1200, 'emotes keep their own time');
  assert.equal(bubbleText('짧음', 'message').ms, 3000);
});

test('bubbles stack upward without overlap and stay inside the stage; name tags stack per floor', () => {
  const items = [{ id: 'low', x: 100, y: 300, width: 80, height: 30 }, { id: 'high', x: 110, y: 290, width: 80, height: 30 }, { id: 'edge', x: 2, y: 100, width: 60, height: 20 }];
  const placed = stackBubbles(items, 400);
  assert.deepEqual(placed.map((item) => item.id), ['low', 'high', 'edge'], 'the lowest bubble claims its place first');
  assert.equal(placed[0].bottom, 300);
  assert.equal(placed[1].bottom, 300 - 30 - 4, 'the overlapping bubble moves above');
  assert.equal(placed[2].x, 34, 'a bubble at the edge is pulled inside');
  assert.equal(placed[2].tail, '8px', 'its tail still points toward the head');
  const tags = [{ x: 10, top: 100, width: 50, height: 20, limit: 200 }, { x: 12, top: 100, width: 50, height: 20, limit: 200 }, { x: 10, top: 100, width: 50, height: 20, limit: 900 }];
  assert.deepEqual(stackTags(tags), [100, 122, 100], 'tags on another floor do not push each other');
});

test('ambient chatter: AI sessions talk, people and busy writers stay quiet, NPCs speak on their schedule', () => {
  const said = [];
  const ai = { author: 'codex', kind: 'codex', activity: 'typing', visible: true, room: 'building', item: { room: 'dev' }, chatterAt: 0, emoteAt: Infinity };
  const human = { author: 'ceo', kind: 'human', activity: 'typing', visible: true, room: 'building', item: { room: 'dev' }, chatterAt: 0, emoteAt: Infinity };
  const npc = { author: '써니', npc: 'guide', kind: 'other', visible: true, room: 'building', item: { pose: 'stand' }, nextAt: 0 };
  const actors = new Map([['a', ai], ['h', human], ['n', npc]]);
  const state = { ...empty(), tools: [], toolNews: null };
  let on = true, list = false;
  const ambient = createAmbient({ actors, state, showBubble: (author, text, kind) => { said.push([author, kind]); state.bubbles.set(author, { text, kind, until: Date.now() + 5000 }); }, requestFrame() {}, walkTo() {}, chatterOn: () => on, listView: () => list, doc: { hidden: false }, later() {} });
  ambient.chatterTick();
  assert.deepEqual(said.map(([author]) => author).sort(), ['codex', '써니']);
  assert.equal(said.find(([author]) => author === '써니')[1], 'npc');
  assert.ok(npc.standUntil > Date.now(), 'the NPC stands up while speaking');
  said.length = 0; state.bubbles.clear(); ai.chatterAt = 0; npc.nextAt = 0;
  state.events.push({ author: 'codex', at: new Date().toISOString(), channel: 'general' });
  ambient.chatterTick();
  assert.ok(!said.some(([author]) => author === 'codex'), 'someone who just wrote focuses on work');
  said.length = 0; list = true; ambient.chatterTick(); on = false; list = false; ambient.chatterTick();
  assert.equal(said.length, 0, 'the list view and the chatter switch silence the office');
  assert.equal(floorOfActor(npc), 'dev');
  assert.ok(sameFloor(ai, npc));
});
