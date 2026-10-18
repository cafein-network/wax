import { api as liveApi, clear, commandLine, el, richText, storage as liveStorage, store as liveStore, timeLabel } from '/dom.mjs';
import { COMMANDS, TOOLS, commandFor, nextCommand } from '/commands.mjs';
import { createDialogSurface } from '/dialog-surface.mjs';
import { createOfficeDemo } from './demo.mjs';
import { icon } from '/icons.mjs';
import { carriesChair, strollNodes, restingChairs, createSnapshotRetry } from './behavior.mjs';
const demo = new URLSearchParams(location.search).get('demo') === '1' ? createOfficeDemo(window) : null;
const api = demo ? demo.api : liveApi;
const storage = (key, fallback) => demo ? fallback : liveStorage(key, fallback);
const store = (key, value) => { if (!demo) liveStore(key, value); };
import { BUILDING, EXTRA_SEATS, FLOOR_HEIGHT, SCALE, SIDE_ROOMS, SIDE_ROOM_ORDER } from './side-rooms.mjs';
import { actorBox, render } from './side-render.mjs';
import { KIND_LABELS, STATE_LABELS, BOARD_VISIT_MS, lookFor, stackDown, officeScene, roomCounts, summaryLabel } from './model.mjs';
import { SIT_MS, WALK_SPEED, point, poseAt, positionAt, routeLength, routeTo } from './animate.mjs';
import { CHATTER_MS, CHATTER_PER_ROOM, EMOTE_MS, EMOTE_PER_FLOOR, emoteGap, pickEmote, bubbleMs, npcGuide, NPCS, NPC_MS, REPLY_DELAY_MS, canChatter, chatterAllowed, chatterGap, npcGap, npcLine, pickChatter, pickReaction } from './chatter.mjs';
import { loadSideAssets } from './sprites.mjs';
import { planStroll, strollGap } from './stroll.mjs';
import { cardTabs, ceoCard, faceShot, profileCard } from './card.mjs';
import { isPlaying, startMusic, stopMusic } from './music.mjs';
import { createOfficeMessenger } from './messenger.mjs';
import { assignPersonas, faceThumb, loadFaceAssets } from './faces.mjs';
import { PROJECT_TYPES } from '/project-types.mjs';
import { renderStudioCollab } from './studio.mjs';

const ROOMS = SIDE_ROOMS;
const ROOM_ORDER = SIDE_ROOM_ORDER;
const roomOf = (id) => ROOMS[id] ?? ROOMS.dev;
const stageRoom = () => BUILDING;
const viewing = () => 'building';
const placeOf = (room, spot) => ({ room: 'building', spot: spot ? `${room ?? 'dev'}:${spot}` : null });
const dialogSurface = createDialogSurface(window);
const $ = (id) => dialogSurface.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d'), overlay = $('overlay'), stage = $('stage');
canvas.width = BUILDING.SIZE.width; canvas.height = BUILDING.SIZE.height; stage.style.aspectRatio = `${BUILDING.SIZE.width} / ${BUILDING.SIZE.height}`; stage.dataset.view = 'side';
const debug = new URLSearchParams(location.search).get('debug') === '1';
if (new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embed');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
const PHASE_COLUMNS = ['plan', 'design', 'implement', 'review', 'report', 'done'];
const TYPE_LABELS = { message: '메시지', opinion: '의견', question: '질문', answer: '답변', decision: '결정' };
const BUBBLE_MS = 6000;
const OUTFIT_COLORS = { claude: '#d9774b', codex: '#4a515c', gemini: '#2f63b8', antigravity: '#a8364e', copilot: '#7b55b8', human: '#8c96a3', other: '#6b7a3a' };
const NPC_STAND_UP = { dx: Math.round(34 * SCALE), dy: 0 };

const state = {
  config: null, assets: null, faces: null, assetError: null, agents: [], order: [], events: [], lastNoteAt: new Map(), boards: new Map(),
  features: [], channels: [], recent: new Map(), bubbles: new Map(), currentBoard: null, scene: [], pm: null,
  skills: new Map(), auras: new Map(),
  usage: null,
  toolNews: null,
  tools: [],
  room: ROOMS[new URLSearchParams(location.search).get('room')] ? new URLSearchParams(location.search).get('room') : storage('wax.office.room', 'dev'),
};
const messenger = createOfficeMessenger({
  dialog: $('messenger-dialog'), launcher: $('open-messenger'), frame: $('messenger-frame'), count: $('message-count'),
  api, getConfig: () => state.config, getChannels: () => state.channels,
  getFaces: () => { for (const agent of state.agents) personaOf(agent.author); return [...personaMap].map(([author, face]) => ({ author, persona: face.persona, kind: face.kind })); },
  faceFor: (author, kind) => {
    const node = faceOf(author, kind, 28);
    node.classList.add('message-avatar');
    return node;
  },
  onChange: () => {
    for (const [author, bubble] of state.bubbles) {
      if (bubble.kind === 'message' && bubble.message && !messenger.isUnread(bubble.message.channel, bubble.message.id)) state.bubbles.delete(author);
    }
    requestFrame();
  },
});
if (!ROOMS[state.room]) state.room = 'dev';
const actors = new Map();
let view = storage('wax-chat.office.view', 'office');
let chatterOn = !demo && storage('wax.office.chatter', 'on') !== 'off';
if (demo) document.body.classList.add('office-demo');


function remember(author, item) {
  const list = state.recent.get(author) ?? [];
  list.push(item);
  list.sort((a, b) => a.at.localeCompare(b.at));
  state.recent.set(author, list.slice(-20));
}

function addMessage(channel, message) {
  state.events.push({ channel, author: message.author, at: message.at, to: message.to ?? [] });
  remember(message.author, { channel, at: message.at, text: message.body, label: TYPE_LABELS[message.type] ?? '메시지' });
}

function addNote(board, note) {
  const entry = state.boards.get(board) ?? { notes: [], reports: [] };
  if (!entry.notes.some((existing) => existing.id === note.id)) entry.notes.push(note);
  state.boards.set(board, entry);
  state.events.push({ channel: board, author: note.author, at: note.at });
  const previous = state.lastNoteAt.get(note.author);
  if (!previous || previous < note.at) state.lastNoteAt.set(note.author, note.at);
  remember(note.author, { channel: board, at: note.at, text: note.body, label: `보드 ${TYPE_LABELS[note.type]}` });
}

function pickCurrentBoard() {
  const wanted = new URLSearchParams(location.search).get('board');
  if (wanted && state.features.some((feature) => feature.id === wanted)) { state.currentBoard = wanted; return; }
  let best = null, bestAt = '';
  for (const [id, board] of state.boards) {
    const at = board.notes.at(-1)?.at ?? '';
    if (at > bestAt) { best = id; bestAt = at; }
  }
  state.currentBoard = best ?? state.features[0]?.id ?? 'general';
}

function addToOrder(authors) {
  for (const author of authors) if (!state.order.includes(author)) state.order.push(author);
}

async function loadSnapshot() {
  const [agents, features, channels, team] = await Promise.all([api('/api/presence'), api('/api/features'), api('/api/channels'), api('/api/team').catch(() => ({ pm: null }))]);
  Object.assign(state, { agents, features, channels, pm: team.pm?.author ?? null, tasks: team.tasks ?? [], events: [], recent: new Map(), lastNoteAt: new Map(), boards: new Map() });
  const now = Date.now();
  const active = agents.filter((a) => now - Date.parse(a.lastActive) <= state.config.awayAfterMs).map((a) => a.author);
  addToOrder([...active, ...agents.map((a) => a.author)]);
  await Promise.all(channels.map(async (channel) => {
    if (channel.count) {
      const { messages } = await api(`/api/channels/${encodeURIComponent(channel.id)}/messages?limit=50`);
      messages.forEach((message) => addMessage(channel.id, message));
    }
    const board = await api(`/api/board/${encodeURIComponent(channel.id)}`);
    state.boards.set(channel.id, { notes: [], reports: board.reports });
    board.notes.forEach((note) => addNote(channel.id, note));
  }));
  pickCurrentBoard();
}


function faceOf(author, kind, size) {
  const persona = personaOf(author);
  const thumb = faceThumb(state.faces, persona, kind, author);
  if (thumb) { thumb.classList.add('card-face'); return thumb; }
  const sprite = state.assets?.characters?.[persona];
  return faceShot(sprite, lookFor(sprite, kind, state.assets?.variants), author, size);
}

let personaMap = new Map();
function personaOf(author) {
  const agent = state.agents.find((item) => item.author === author);
  if (state.assets && (!personaMap.has(author) || (agent && personaMap.get(author).kind !== agent.kind))) {
    const agents = agent ? state.agents : [...state.agents, { author, kind: 'other' }];
    personaMap = assignPersonas(agents, state.assets, personaMap);
    personaMap = assignPersonas(agents, state.assets, personaMap, { humans: true });
    messenger.syncFaces();
  }
  return personaMap.get(author)?.persona ?? null;
}

function updateScene({ instant = false } = {}) {
  if (!state.config) return;
  const now = Date.now();
  state.events = state.events.filter((event) => now - Date.parse(event.at) < 10 * 60 * 1000);
  state.scene = officeScene({ agents: state.agents, order: state.order, events: state.events, lastNoteAt: state.lastNoteAt, now, awayAfterMs: state.config.awayAfterMs, pm: state.pm, lab: SIDE_ROOMS.lab, roof: SIDE_ROOMS.roof, studio: SIDE_ROOMS.studio, features: state.features });
  const walk = (actor, target, leaving) => walkTo(actor, target, leaving, instant);
  for (const item of state.scene) {
    const place = placeOf(item.room, item.spot);
    const room = stageRoom(place.room);
    for (const [key, other] of actors) {
      if (other.author !== item.author || other.room === place.room || other.leaving) continue;
      if (other.visible) walk(other, stageRoom(other.room).SPOTS.entrance, true); else actors.delete(key);
    }
    const key = `${place.room}:${item.author}`;
    let actor = actors.get(key);
    if (!actor) {
      if (!place.spot) continue;
      const start = instant ? point(place.spot, room) : point(room.SPOTS.entrance, room);
      actor = { author: item.author, room: place.room, x: start.x, y: start.y, route: null, dist: 0, target: null, visible: true, leaving: false, phase: Math.random() * 2000, arrivedAt: -Infinity };
      actors.set(key, actor);
    }
    Object.assign(actor, { kind: item.kind, activity: item.activity, state: item.state, item });
    const target = place.spot ?? (item.seated ? room.SPOTS.entrance : null);
    if (target === null) { actor.visible = false; actor.target = null; actor.route = null; actor.stroll = null; continue; }
    if (keepStroll(actor, target)) continue;
    if (target === actor.target && !actor.leaving) continue;
    walk(actor, target, !place.spot);
  }
  const taken = new Map();
  for (const item of state.scene) if (item.spot) taken.set(item.room ?? 'dev', (taken.get(item.room ?? 'dev') ?? new Set()).add(item.spot));
  for (const npc of NPCS) {
    const npcRoom = stageRoom(npc.room);
    const npcPlace = (spot) => placeOf(npc.room, spot).spot;
    const used = taken.get(npc.room) ?? new Set();
    taken.set(npc.room, used);
    const key = `${npc.room}:npc:${npc.id}`;
    const free = chatterOn ? npc.spots.find((candidate) => !used.has(candidate)) ?? null : null;
    if (free) used.add(free);
    const spot = free ? npcPlace(free) : null;
    let actor = actors.get(key);
    if (!actor) {
      if (!spot) continue;
      const start = instant ? point(spot, npcRoom) : point(npcRoom.SPOTS.entrance, npcRoom);
      actor = { author: npc.name, npc: npc.id, persona: npc.side, height: npc.height ?? 1, jacket: npc.jacket, color: npc.color, room: 'building', kind: 'other', activity: 'npc', state: 'npc', item: null, x: start.x, y: start.y, route: null, dist: 0, target: null, visible: true, leaving: false, phase: Math.random() * 2000, arrivedAt: -Infinity };
      actors.set(key, actor);
    }
    actor.item = { pose: spot && Object.hasOwn(npcRoom.SEATS, spot) ? 'sit' : 'stand', quiet: false };
    const target = spot ?? npcRoom.SPOTS.entrance;
    if (keepStroll(actor, target)) continue;
    if (target === actor.target && !actor.leaving) continue;
    walk(actor, target, !spot);
  }
  for (const [key, actor] of actors) {
    if (!actor.npc && !state.scene.some((item) => item.author === actor.author)) actor.visible = false;
    if (!actor.visible && actor.leaving) actors.delete(key);
  }
  renderRoomTabs();
  canvas.setAttribute('aria-label', `${roomOf(state.room).label} — ${summaryLabel(state.scene.filter((item) => (item.room ?? 'dev') === state.room))}`);
  const hidden = state.scene.filter((item) => !item.seated);
  $('notice').hidden = !state.assetError && !hidden.length;
  $('notice').textContent = state.assetError || (hidden.length ? `자리가 부족해 사무실에 표시하지 못한 에이전트: ${hidden.map((item) => item.author).join(', ')} (목록 보기에서 확인)` : '');
  renderList();
  requestFrame();
}

function walkTo(actor, target, leaving, instant = false) {
  const room = stageRoom(actor.room);
  actor.target = target;
  actor.leaving = leaving;
  actor.visible = true;
  const extra = !actor.npc && EXTRA_SEATS.includes(target);
  if (instant) {
    Object.assign(actor, point(target, room), { route: null, arrivedAt: -Infinity, chair: extra, chairAt: null });
    if (leaving) actor.visible = false;
    return;
  }
  const take = extra && !actor.chair, give = !extra && actor.chair && !actor.stroll;
  if ((take || give) && room.NODES?.['meeting:stack']) {
    const first = routeTo(actor.x, actor.y, 'meeting:stack', room), at = point('meeting:stack', room);
    actor.route = [...first, ...routeTo(at.x, at.y, target, room).slice(1)];
    actor.chairAt = { dist: routeLength(first), chair: Boolean(take) };
  } else {
    actor.route = routeTo(actor.x, actor.y, target, room);
    actor.chairAt = null;
  }
  actor.length = routeLength(actor.route);
  actor.dist = 0;
}

function keepStroll(actor, target) {
  actor.home = target;
  if (!actor.stroll) return false;
  if (chatterOn && actor.stroll.home === target && !actor.leaving) return true;
  actor.stroll = null;
  return false;
}


let frameRequested = false, lastTime = performance.now(), lastDraw = 0;
function requestFrame() {
  if (frameRequested || document.hidden) return;
  frameRequested = true;
  requestAnimationFrame(tick);
}

function tick(time) {
  frameRequested = false;
  const dt = Math.min(0.1, (time - lastTime) / 1000);
  lastTime = time;
  const reduced = reducedQuery.matches;
  let walking = false, settling = false;
  for (const actor of actors.values()) {
    if (!actor.route) continue;
    actor.dist += WALK_SPEED * dt * (demo ? 4 * demo.rate : 1);
    if (actor.chairAt && actor.dist >= actor.chairAt.dist) { actor.chair = actor.chairAt.chair; actor.chairAt = null; }
    const pos = positionAt(actor.route, actor.dist);
    actor.x = pos.x; actor.y = pos.y;
    if (Math.abs(pos.dx) > 0.5) actor.walkFacing = pos.dx < 0 ? 'left' : 'right';
    actor.riding = !pos.done && Math.abs(pos.dx ?? 0) < 0.5 && Math.abs(pos.dy ?? 0) > 100;
    if (pos.done) {
      actor.route = null;
      actor.arrivedAt = time;
      if (actor.stroll?.returning) actor.stroll = null;
      if (actor.leaving) actor.visible = false;
    } else if (actor.room === viewing()) walking = true;
  }
  for (const actor of actors.values()) if (!actor.route && time - actor.arrivedAt < SIT_MS) settling = true;
  const animated = !reduced && (isPlaying() || [...actors.values()].some((actor) => actor.visible && actor.room === viewing()));
  if (walking || settling || !animated || time - lastDraw >= 120 || lastDraw === 0) {
    draw(time);
    lastDraw = time;
  }
  if (walking || settling || animated) requestFrame();
}

async function toggleMusic() {
  if (isPlaying()) stopMusic();
  else if (!(await startMusic())) return;
  requestFrame();
}

let assetsSettled = false;
function draw(time) {
  if (!assetsSettled) {
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#efe8d8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const reduced = reducedQuery.matches;
  const room = stageRoom(state.room);
  const drawn = [...actors.values()].filter((actor) => actor.visible && actor.room === viewing()).map((actor) => {
    const riding = Boolean(actor.route && actor.riding);
    const walking = Boolean(actor.route) && !riding;
    const seat = !actor.route && !actor.leaving && actor.item?.pose === 'sit' && !(actor.standUntil > Date.now()) ? room.SEATS[actor.target] : null;
    const sit = Boolean(seat) && (reduced || time - actor.arrivedAt >= SIT_MS);
    const up = !sit && !walking && actor.npc && actor.item?.pose === 'sit' && room.SEATS[actor.target] ? NPC_STAND_UP : { dx: 0, dy: 0 };
    const activity = actor.route ? null : actor.stroll ? (actor.stroll.facing ? 'chat' : null) : actor.activity;
    actor.drawn = {
      x: sit ? seat.x : actor.x + up.dx, y: sit ? seat.y : actor.y + up.dy, sit, seatKind: sit ? seat.kind ?? null : null, front: Boolean(sit && seat.front), speaking: (state.bubbles.get(actor.author)?.until ?? 0) > Date.now(), occluder: sit ? seat.occluder ?? null : null, backShift: sit ? seat.back ?? null : null, sleepShift: sit ? seat.sleep ?? null : null,
      kind: actor.kind, look: actor.npc ? { jacket: actor.jacket ?? null } : lookFor(state.assets?.characters?.[personaOf(actor.author)], actor.kind, state.assets?.variants), persona: actor.persona && (state.assets?.personas?.includes(actor.persona) || state.assets?.characters?.[actor.persona]) ? actor.persona : personaOf(actor.author), walking, riding, activity, carry: carriesChair(actor, walking),
      cup: !walking && (actor.activity === 'coffee' || (actor.item?.room === 'roof' && actor.activity === 'chat')),
      facing: walking ? actor.walkFacing : sit ? seat.facing : actor.stroll?.facing ?? room.NODES[actor.target]?.[2] ?? 'right', scale: room.scale * SCALE * (actor.height ?? 1) * 150 / (state.assets?.characterHeight ?? 150),
      pose: poseAt({ walking, activity, t: time + actor.phase, reduced }),
    };
    return actor.drawn;
  });
  const board = state.boards.get(state.currentBoard);
  const feature = state.features.find((f) => f.id === state.currentBoard);
  if (debug) globalThis.__waxDrawn = [...actors.values()].filter((a) => a.drawn).map((a) => ({ author: a.author, x: a.drawn.x, y: a.drawn.y, walking: a.drawn.walking, facing: a.drawn.facing, wf: a.walkFacing, persona: a.drawn.persona, seg: a.route ? positionAt(a.route, a.dist).dx : null }));
  render(ctx, {
    assets: state.assets, actors: drawn, debug, room,
    board: board ? { notes: board.notes, reports: board.reports.length, phase: feature?.phase ?? null } : null,
    music: isPlaying() && !reduced ? { t: time } : null,
    chairs: restingChairs(actors.values(), EXTRA_SEATS),
  });
  positionOverlay(time);
}


const overlayNodes = new Map();
function overlayFor(key, create) {
  if (!overlayNodes.has(key)) { const node = create(); overlay.append(node); overlayNodes.set(key, node); }
  return overlayNodes.get(key);
}

function positionOverlay(time) {
  const scale = stage.clientWidth / BUILDING.SIZE.width;
  stage.dataset.compact = String(scale < 0.45);
  const now = Date.now();
  const seen = new Set();
  const placed = [];
  const tags = [];
  const hitArea = stageRoom(state.room).WHITEBOARD_HIT;
  if (hitArea) {
    seen.add('board');
    const boardButton = overlayFor('board', () => el('button', { type: 'button', class: 'hit', 'aria-label': '화이트보드 열기', onclick: () => openBoard() }));
    Object.assign(boardButton.style, { left: `${hitArea.x * scale}px`, top: `${hitArea.y * scale}px`, width: `${hitArea.width * scale}px`, height: `${hitArea.height * scale}px` });
  }
  const speaker = stageRoom(state.room).SPEAKER_HIT;
  const studio = stageRoom(state.room).STUDIO_HIT;
  if (studio) {
    seen.add('studio');
    const button = overlayFor('studio', () => el('button', { type: 'button', class: 'hit', 'aria-label': '디자인실 제작물 보기', onclick: openStudio }));
    Object.assign(button.style, { left: `${studio.x * scale}px`, top: `${studio.y * scale}px`, width: `${studio.width * scale}px`, height: `${studio.height * scale}px` });
  }
  if (speaker) {
    seen.add('speaker');
    const button = overlayFor('speaker', () => el('button', { type: 'button', class: 'hit', onclick: toggleMusic }));
    button.setAttribute('aria-label', isPlaying() ? '스피커: 음표 연출 끄기 (소리 없음)' : '스피커: 음표 연출 켜기 (소리 없음)');
    button.setAttribute('aria-pressed', String(isPlaying()));
    button.title = button.getAttribute('aria-label');
    Object.assign(button.style, { left: `${speaker.x * scale}px`, top: `${speaker.y * scale}px`, width: `${speaker.width * scale}px`, height: `${speaker.height * scale}px` });
  }
  placeUsageMonitor(scale, seen);
  for (const actor of actors.values()) {
    if (!actor.visible || !actor.drawn || actor.room !== viewing()) continue;
    const sprite = state.assets && (state.assets.characters[actor.drawn.persona] ?? state.assets.characters[state.assets.personas[0]]);
    const box = actorBox(actor.drawn, sprite ?? undefined);
    const label = actor.npc ? `${actor.author}, 안내 NPC(세션이 아니며 기록되지 않음)` : `${actor.author}, ${KIND_LABELS[actor.kind] ?? actor.kind}, ${STATE_LABELS[actor.state] ?? actor.state}${actor.item?.feature ? `, ${actor.item.feature}` : ''}`;
    const hitKey = `hit:${actor.author}`, tagKey = `tag:${actor.author}`, bubbleKey = `bubble:${actor.author}`;
    seen.add(hitKey); seen.add(tagKey);
    const hit = overlayFor(hitKey, () => el('button', { type: 'button', class: 'hit', onclick: () => (actor.npc ? openNpc(actor) : openAgent(actor.author)) }));
    hit.setAttribute('aria-label', label);
    Object.assign(hit.style, { left: `${box.left * scale}px`, top: `${box.top * scale}px`, width: `${(box.right - box.left) * scale}px`, height: `${(box.bottom - box.top + 6) * scale}px` });
    const tag = overlayFor(tagKey, () => el('span', { class: 'nametag' }, el('span', { class: 'dot' }), el('span', { class: 'name' })));
    tag.querySelector('.name').textContent = actor.author;
    tag.classList.toggle('npc', Boolean(actor.npc));
    tag.classList.toggle('ceo', Boolean(actor.item?.ceo));
    const tone = actor.color ?? OUTFIT_COLORS[actor.kind] ?? OUTFIT_COLORS.other;
    tag.querySelector('.dot').style.background = tone;
    Object.assign(tag.style, { left: `${actor.drawn.x * scale}px`, top: `${(box.bottom + 8) * scale}px` });
    const floorTop = Math.max(...Object.values(BUILDING.floorTop).filter((y) => y <= actor.drawn.y));
    tags.push({ node: tag, x: actor.drawn.x * scale, top: (box.bottom + 8) * scale, limit: (floorTop + FLOOR_HEIGHT - 16) * scale });
    const unread = !actor.npc && actor.kind !== 'human' ? messenger.count(actor.author) : 0;
    const said = state.bubbles.get(actor.author);
    const messageToast = unread > 0 && said?.kind === 'message' && said.until > now && said.message && messenger.isUnread(said.message.channel, said.message.id);
    if (messageToast) {
      const key = `message:${actor.author}`;
      seen.add(key);
      const button = overlayFor(key, () => el('button', {
        type: 'button', class: 'agent-message', 'aria-haspopup': 'dialog',
        onclick: () => messenger.open({ author: actor.author, channel: actor.item?.feature }),
      }, icon('message', 16)));
      const label = `${actor.author}의 새 메시지 · 대화 열기`;
      button.setAttribute('aria-label', label); button.title = label;
      button.dataset.unread = String(unread > 0);
      Object.assign(button.style, {
        left: `${Math.min(stage.clientWidth - 32, Math.max(4, actor.drawn.x * scale - 14))}px`,
        top: `${Math.max(4, box.top * scale - 34)}px`,
      });
    }
    const aura = !actor.npc && state.auras.get(actor.author);
    if (aura && aura.until > now) {
      const auraKey = `aura:${actor.author}`;
      seen.add(auraKey);
      const node = overlayFor(auraKey, () => el('div', { class: 'aura', 'aria-hidden': 'true' }, el('span', { class: 'aura-label' })));
      node.dataset.axis = aura.key;
      node.querySelector('.aura-label').textContent = `${aura.label} ↑`;
      const height = box.bottom - box.top;
      const size = Math.max(28, height * 0.42 * scale);
      Object.assign(node.style, { left: `${actor.drawn.x * scale}px`, top: `${(box.top + height * 0.17) * scale}px`, width: `${size}px`, height: `${size}px` });
    }
    const quiet = actor.item?.quiet && !actor.route && actor.activity !== 'sleep';
    const bubble = said && said.until > now ? said
      : quiet ? { text: reducedQuery.matches ? '…' : '.'.repeat(1 + Math.floor(time / 500) % 3), kind: 'quiet' } : null;
    if (bubble) {
      seen.add(bubbleKey);
      const node = overlayFor(bubbleKey, () => el('div', { class: 'bubble', 'aria-hidden': 'true' }));
      node.textContent = bubble.text;
      node.dataset.kind = bubble.kind;
      node.style.setProperty('--tone', tone);
      const bottom = messageToast ? Math.max(4, box.top * scale - 34) - 12 : (box.top - 12) * scale;
      Object.assign(node.style, { left: `${actor.drawn.x * scale}px`, top: `${bottom}px` });
      placed.push({ node, x: actor.drawn.x * scale, y: bottom });
    }
  }
  for (const [key, node] of overlayNodes) if (!seen.has(key)) { node.remove(); overlayNodes.delete(key); }
  stackBubbles(placed);
  for (const limit of new Set(tags.map((t) => t.limit))) {
    const floor = tags.filter((t) => t.limit === limit);
    const tops = stackDown(floor.map((t) => ({ x: t.x, top: t.top, width: t.node.offsetWidth, height: t.node.offsetHeight })), 2, limit);
    floor.forEach((t, i) => { if (tops[i] !== t.top) t.node.style.top = `${tops[i]}px`; });
  }
}


const MONITOR = { x: 506, y: 8, width: 416, height: 114 };
const LIMIT_LABELS = { five_hour: '5시간', seven_day: '주간', spend_limit: '지출 한도' };
const gaugeTone = (percent) => (percent >= 85 ? 'high' : percent >= 60 ? 'mid' : 'low');
const resetLabel = (iso, kind) => {
  if (!iso) return '';
  const at = new Date(iso);
  return kind === 'five_hour' ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 초기화` : `${at.getMonth() + 1}/${at.getDate()} 초기화`;
};

function placeUsageMonitor(scale, seen) {
  seen.add('usage-monitor');
  const node = overlayFor('usage-monitor', () => el('button', { type: 'button', class: 'usage-monitor', onclick: () => openUsage() }));
  const top = BUILDING.floorTop.boss + MONITOR.y;
  Object.assign(node.style, { left: `${MONITOR.x * scale}px`, top: `${top * scale}px`, width: `${MONITOR.width * scale}px`, height: `${MONITOR.height * scale}px`, fontSize: `${Math.max(9, 15 * scale)}px` });
  const claude = state.usage?.claude;
  const key = JSON.stringify([claude?.limits, claude?.sessions?.length, Math.max(0, ...(claude?.sessions ?? []).map((x) => x.context?.percent ?? 0))]);
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  const limits = (claude?.limits ?? []).filter((limit) => limit.kind !== 'spend_limit' || claude.limits.length === 1);
  node.setAttribute('aria-label', limits.length ? `Claude 사용량 모니터: ${limits.map((l) => `${LIMIT_LABELS[l.kind] ?? l.kind} ${l.percentUsed}%`).join(', ')}. 눌러서 자세히 보기` : 'Claude 사용량 모니터: 아직 기록이 없습니다. 눌러서 안내 보기');
  clear(node).append(
    el('span', { class: 'um-title', text: 'CLAUDE 사용량' }),
    ...(limits.length ? limits.map((limit) => el('span', { class: 'um-row' },
      el('span', { class: 'um-label', text: LIMIT_LABELS[limit.kind] ?? limit.kind }),
      el('span', { class: 'um-bar' }, el('span', { class: `um-fill ${gaugeTone(limit.percentUsed)}`, style: { width: `${Math.min(100, limit.percentUsed)}%` } })),
      el('span', { class: 'um-value', text: `${limit.percentUsed}%` }),
    )) : [el('span', { class: 'um-empty', text: '기록 없음 · Claude Code 2.1.287+' })]),
    ...(claude?.sessions?.length ? [el('span', { class: 'um-foot', text: `세션 ${claude.sessions.length} · 컨텍스트 최대 ${Math.max(0, ...claude.sessions.map((x) => x.context?.percent ?? 0))}%` })] : []),
  );
}

async function refreshTools({ fresh = false } = {}) {
  const data = await api(`/api/tools${fresh ? '?fresh=1' : ''}`).catch(() => null);
  if (data?.tools) state.tools = data.tools;
  return Boolean(data?.tools);
}

async function refreshToolNews({ fresh = false } = {}) {
  const data = await api(`/api/tools/news${fresh ? '?fresh=1' : ''}`).catch(() => null);
  if (data?.tools) state.toolNews = data;
  return Boolean(data?.tools);
}

async function refreshUsage() {
  if (document.hidden) return;
  const usage = await api('/api/usage').catch(() => null);
  if (!usage) return;
  state.usage = usage;
  requestFrame();
}

function openUsage() {
  const claude = state.usage?.claude ?? { limits: [], sessions: [] };
  $('agent-title').textContent = 'Claude 사용량';
  const content = [];
  if (claude.limits.length) {
    content.push(el('h3', { text: '플랜 사용량(계정 전체)' }), el('dl', { class: 'dl' }, claude.limits.flatMap((limit) => [
      el('dt', { text: LIMIT_LABELS[limit.kind] ?? limit.kind }),
      el('dd', { text: `${limit.percentUsed}%${limit.resetsAt ? ` · ${new Date(limit.resetsAt).toLocaleString('ko-KR')} 초기화` : ''}` }),
    ])), el('p', { class: 'kind', text: `${claude.limitsAt ? new Date(claude.limitsAt).toLocaleString('ko-KR') : ''}에 읽은 값입니다. 같은 계정의 모든 Claude Code 세션이 함께 씁니다.` }));
  } else {
    content.push(el('p', { class: 'empty', text: '아직 기록이 없습니다.' }));
  }
  content.push(el('h3', { text: '세션' }), claude.sessions.length
    ? el('div', { class: 'table-wrap' }, el('table', { class: 'agent-table' },
      el('thead', {}, el('tr', {}, ['세션', '모델', '컨텍스트', '비용', '마지막 기록'].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, claude.sessions.map((x) => el('tr', {},
        el('td', {}, el('code', { text: x.session.slice(0, 8) })), el('td', { text: x.model ?? '-' }),
        el('td', { text: x.context?.percent !== null && x.context?.percent !== undefined ? `${x.context.percent}%${x.context.tokens ? ` (${Math.round(x.context.tokens / 1000)}k)` : ''}` : '-' }),
        el('td', { text: x.costUsd !== null && x.costUsd !== undefined ? `$${x.costUsd.toFixed(2)}` : '-' }),
        el('td', { text: `${timeLabel(x.at)}${x.ended ? ' · 끝남' : ''}` }))))))
    : el('p', { class: 'empty', text: '살아 있는 Claude Code 세션 기록이 없습니다.' }));
  content.push(el('p', { class: 'kind', text: 'Claude Code 2.1.287 이상에서 wax 플러그인을 쓰면 wax 모드가 턴마다 숫자만(플랜 사용량·컨텍스트·비용) 이 프로젝트의 .wax/usage에 남깁니다. 대화 내용은 읽지도 남기지도 않습니다. 다른 도구(Codex·GitHub Copilot CLI·Gemini CLI·Antigravity CLI)의 사용량은 아직 표시하지 않습니다.' }));
  const target = $('agent-content');
  delete target.dataset.npc;
  clear(target).append(...content);
  $('agent-dialog').showModal();
}


function stackBubbles(placed) {
  const gap = 4;
  const boxes = [];
  for (const item of placed.sort((a, b) => b.y - a.y)) {
    const width = item.node.offsetWidth, height = item.node.offsetHeight;
    const headX = item.x;
    item.x = Math.max(width / 2 + gap, Math.min(stage.clientWidth - width / 2 - gap, headX));
    item.node.style.left = `${item.x}px`;
    item.node.style.setProperty('--tail-x', `${Math.max(8, Math.min(width - 8, headX - item.x + width / 2))}px`);
    let bottom = item.y;
    for (let moved = true; moved;) {
      moved = false;
      for (const box of boxes) {
        const overlapX = Math.abs(item.x - box.x) < (width + box.width) / 2 + gap;
        const overlapY = bottom > box.bottom - box.height - gap && bottom - height < box.bottom + gap;
        if (overlapX && overlapY) { bottom = box.bottom - box.height - gap; moved = true; }
      }
    }
    if (bottom !== item.y) item.node.style.top = `${bottom}px`;
    boxes.push({ x: item.x, bottom, width, height });
  }
}

const AURA_MS = 4000;
let skillsTimer = null;
function refreshSkills({ initial = false } = {}) {
  clearTimeout(skillsTimer);
  skillsTimer = setTimeout(async () => {
    const data = await api('/api/profiles').catch(() => null);
    if (!data) return;
    const now = Date.now();
    for (const profile of data.profiles) {
      const before = state.skills.get(profile.author);
      state.skills.set(profile.author, profile.axes);
      if (initial || !before) continue;
      const grown = profile.axes.map((axis, i) => ({ axis, gain: axis.value - (before[i]?.value ?? 0) })).filter((g) => g.gain > 0).sort((a, b) => b.gain - a.gain)[0];
      if (!grown) continue;
      state.auras.set(profile.author, { key: grown.axis.key, label: grown.axis.label, until: now + AURA_MS });
      announce(`${profile.author}: ${grown.axis.label} 능력 발휘`);
      requestFrame();
      setTimeout(requestFrame, AURA_MS + 50);
    }
  }, initial ? 0 : 600);
}

function showBubble(author, text, kind, ms = BUBBLE_MS, message = null) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const max = kind === 'npc' ? 120 : 60;
  const shown = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  ms = kind === 'emote' ? ms : bubbleMs(shown, ms);
  state.bubbles.set(author, { text: shown, kind, until: Date.now() + ms, message });
  setTimeout(requestFrame, ms + 50);
}


const floorOfActor = (actor) => (actor.npc ? NPCS.find((item) => item.id === actor.npc)?.room : actor.item?.room) ?? 'dev';
const sameFloor = (a, b) => floorOfActor(a) === floorOfActor(b);

const ownEvents = (actor) => state.events.filter((event) => event.author === actor.author);

function chatterTick() {
  if (!chatterOn || document.hidden || view === 'list') return;
  const now = Date.now();
  const talking = (actor) => (state.bubbles.get(actor.author)?.until ?? 0) > now;
  const here = [...actors.values()].filter((actor) => actor.visible && actor.room === viewing());
  let showing = here.filter((actor) => talking(actor) && state.bubbles.get(actor.author)?.kind !== 'emote').length;
  const busy = !chatterAllowed(state.events, now);
  for (const actor of here) {
    if (actor.npc || actor.kind === 'human' || actor.route || actor.item?.quiet || !canChatter(actor.activity) || talking(actor)) continue;
    if (!chatterAllowed(ownEvents(actor), now, actor.author)) continue;
    actor.chatterAt ??= now + 3000 + Math.floor(Math.random() * 15_000);
    if (now < actor.chatterAt || showing >= (busy ? 1 : CHATTER_PER_ROOM)) continue;
    actor.chatterAt = now + chatterGap();
    const peers = busy ? [] : here.filter((other) => other !== actor && !other.npc && sameFloor(other, actor)).map((other) => other.author);
    const text = pickChatter({ activity: actor.activity, feature: actor.item?.feature, peers });
    if (!text) continue;
    showBubble(actor.author, text, 'chatter', CHATTER_MS);
    showing += 1;
    requestFrame();
  }
  emoteTick(here, now, talking);
  npcTick(here, now, talking);
}

function emoteTick(here, now, talking) {
  const shown = new Map();
  for (const actor of here) if (state.bubbles.get(actor.author)?.kind === 'emote' && talking(actor)) shown.set(floorOfActor(actor), (shown.get(floorOfActor(actor)) ?? 0) + 1);
  for (const actor of here) {
    if (actor.npc || actor.kind === 'human' || actor.route || actor.item?.quiet || talking(actor)) continue;
    actor.emoteAt ??= now + 1500 + Math.floor(Math.random() * 12_000);
    const floor = floorOfActor(actor);
    if (now < actor.emoteAt || (shown.get(floor) ?? 0) >= EMOTE_PER_FLOOR) continue;
    actor.emoteAt = now + emoteGap();
    const emote = pickEmote({ activity: actor.stroll?.facing ? 'chat' : actor.activity });
    if (!emote) continue;
    showBubble(actor.author, emote, 'emote', EMOTE_MS);
    shown.set(floor, (shown.get(floor) ?? 0) + 1);
    requestFrame();
  }
}

function npcTick(here, now, talking) {
  const npcs = here.filter((actor) => actor.npc && !actor.route && !actor.leaving);
  for (const npc of npcs) {
    const spec = NPCS.find((item) => item.id === npc.npc);
    npc.nextAt ??= now + (spec?.every ? 3000 : 4000 + Math.floor(Math.random() * 8000));
    if (now < npc.nextAt) continue;
    if (talking(npc) || npcs.some((other) => other !== npc && talking(other))) { npc.nextAt = now + 2500; continue; }
    npc.nextAt = now + (spec?.every ?? npcGap());
    npcSpeak(npc, here, now, talking);
  }
}

function npcContext(now = Date.now()) {
  const live = state.features.filter((feature) => !feature.archivedAt);
  return {
    hour: new Date(now).getHours(),
    project: state.config.project,
    description: state.config.description ?? null,
    features: live.map((feature) => ({ id: feature.id, title: feature.title, phase: feature.phase })),
    labels: state.config.labels,
    active: live.filter((feature) => feature.phase !== 'done').length,
    working: state.scene.filter((item) => item.state === 'working').length,
    pm: state.pm,
    meetings: [...new Set(state.scene.filter((item) => item.room === 'meeting' && item.group).map((item) => (item.group === 'general' ? state.config.project : item.group)))],
    agents: state.scene.map((item) => ({ name: item.author, kind: item.kind, model: state.agents.find((a) => a.author === item.author)?.model ?? null, state: item.state, feature: item.feature })),
    tasks: state.tasks ?? [],
    limits: state.usage?.claude?.limits ?? [],
    tools: state.tools,
    toolNews: state.toolNews,
  };
}

function npcSpeak(npc, here, now, talking) {
  const context = { ...npcContext(now), turn: npc.turn = (npc.turn ?? -1) + 1 };
  const { text, topic, subject } = npcLine(npc.npc, context);
  npc.standUntil = now + NPC_MS;
  showBubble(npc.author, text, 'npc', NPC_MS);
  requestFrame();
  const canReply = (actor) => !actor.npc && actor.kind !== 'human' && !actor.route && !actor.item?.quiet && canChatter(actor.activity) && chatterAllowed(state.events, now) && chatterAllowed(state.events, now, actor.author);
  let responder = null;
  if (topic === 'intro') {
    const self = here.find((actor) => actor.author === subject && sameFloor(actor, npc));
    if (self && canReply(self) && Math.random() < 0.4) responder = self;
  } else {
    const candidates = here.filter((actor) => canReply(actor) && sameFloor(actor, npc));
    if (candidates.length && (!['guide', 'project'].includes(topic) || Math.random() < 0.4)) responder = candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (!responder) return;
  setTimeout(() => {
    if (!chatterOn || talking(responder) || !responder.visible) return;
    showBubble(responder.author, pickReaction(topic), 'chatter', CHATTER_MS);
    requestFrame();
  }, REPLY_DELAY_MS);
}


const strollNext = new Map();
const homeFloor = (actor) => String(actor.home ?? actor.target ?? '').split(':')[0];

function strollTick() {
  const now = Date.now();
  const talking = (actor) => (state.bubbles.get(actor.author)?.until ?? 0) > Date.now();
  const here = [...actors.values()].filter((actor) => actor.visible && !actor.leaving && actor.room === viewing());
  for (const actor of here) {
    const stroll = actor.stroll;
    if (!stroll || actor.route) continue;
    if (!stroll.until) { stroll.until = now + stroll.ms; groupTalk(stroll.group, here, talking); continue; }
    if (now >= stroll.until && !talking(actor) && !stroll.returning) { actor.stroll.returning = true; actor.strollAgain = now + 25_000; walkTo(actor, actor.home, false); requestFrame(); }
  }
  if (!chatterOn || document.hidden || view === 'list' || !state.config) return;
  for (const floor of ROOM_ORDER) {
    if (!strollNext.has(floor)) strollNext.set(floor, now + 3000 + Math.floor(Math.random() * 9000));
    if (now < strollNext.get(floor)) continue;
    strollNext.set(floor, now + strollGap());
    const people = here.filter((actor) => homeFloor(actor) === floor);
    if (people.some((actor) => actor.stroll)) continue;
    const room = ROOMS[floor];
    const used = new Set(here.flatMap((actor) => [actor.target, actor.home]));
    const nodes = strollNodes(room, used, floor);
    const candidates = people.filter((actor) => !actor.route && actor.target === actor.home && !(actor.strollAgain > now) && !talking(actor) && !(actor.standUntil > now))
      .map((actor) => ({ author: actor.author, activity: actor.activity, npc: Boolean(actor.npc), human: actor.kind === 'human', quiet: Boolean(actor.item?.quiet), x: actor.x }));
    const plan = planStroll({ actors: candidates, nodes });
    if (debug) console.log('[wax stroll]', floor, JSON.stringify(plan));
    if (!plan) continue;
    const group = { talk: plan.kind === 'gather', members: plan.moves.map((move) => move.author), said: false };
    for (const move of plan.moves) {
      const actor = people.find((item) => item.author === move.author);
      actor.stroll = { home: actor.home, facing: move.facing, ms: move.ms, until: 0, group };
      walkTo(actor, `${floor}:${move.spot}`, false);
    }
    requestFrame();
  }
}

function groupTalk(group, here, talking) {
  if (!group?.talk || group.said) return;
  const members = group.members.map((name) => here.find((actor) => actor.author === name && actor.stroll?.group === group)).filter(Boolean);
  if (members.length < 2 || members.some((actor) => !actor.stroll.until)) return;
  group.said = true;
  if (debug) console.log('[wax stroll] talk', group.members.join(', '));
  if (!chatterOn) return;
  const speakers = members.filter((actor) => actor.npc || (actor.kind !== 'human' && chatterAllowed(ownEvents(actor), Date.now(), actor.author)));
  speakers.forEach((actor, i) => setTimeout(() => {
    if (!chatterOn || !actor.visible || actor.stroll?.group !== group || talking(actor)) return;
    if (actor.npc) {
      npcSpeak(actor, [...actors.values()].filter((item) => item.visible && item.room === viewing()), Date.now(), talking);
      actor.nextAt = Date.now() + (NPCS.find((item) => item.id === actor.npc)?.every ?? npcGap());
    } else {
      const peers = members.filter((other) => other !== actor).map((other) => other.author);
      const emote = i > 0 && Math.random() < 0.5 ? pickEmote({ reaction: true }) : null;
      const text = emote ?? pickChatter({ activity: 'chat', peers });
      if (text) showBubble(actor.author, text, emote ? 'emote' : 'chatter', emote ? EMOTE_MS + 600 : CHATTER_MS);
      actor.chatterAt = Date.now() + chatterGap();
    }
    if (actor.stroll) actor.stroll.until = Math.max(actor.stroll.until, Date.now() + 4000);
    requestFrame();
  }, 600 + i * (REPLY_DELAY_MS + 1700)));
}

function applyChatter() {
  $('chatter-toggle').setAttribute('aria-pressed', String(chatterOn));
  $('chatter-toggle').textContent = chatterOn ? 'NPC·잡담 켜짐' : 'NPC·잡담 꺼짐';
  if (state.config) updateScene();
  if (chatterOn) return;
  const now = Date.now();
  for (const [author, bubble] of state.bubbles) if (bubble.kind === 'chatter' && bubble.until > now) state.bubbles.delete(author);
  requestFrame();
}


function selectRoom(id) {
  if (!ROOMS[id]) return;
  state.room = id;
  store('wax.office.room', id);
  renderRoomTabs();
  scrollToFloor(id);
}

function scrollToFloor(id, behavior = 'smooth') {
  const top = BUILDING.floorTop[id];
  if (top === undefined) return;
  const rect = stage.getBoundingClientRect();
  const scale = rect.width / BUILDING.SIZE.width;
  window.scrollTo({ top: window.scrollY + rect.top + top * scale - 80, behavior: reducedQuery.matches ? 'instant' : behavior });
}

function renderRoomTabs() {
  const counts = roomCounts(state.scene);
  const tabs = clear($('room-tabs'));
  for (const id of ROOM_ORDER) {
    const room = ROOMS[id];
    const names = state.scene.filter((item) => item.spot && (item.room ?? 'dev') === id).map((item) => item.author);
    tabs.append(el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.room === id), tabindex: state.room === id ? '0' : '-1',
      title: names.join(', ') || '비어 있음', onclick: () => selectRoom(id),
      onkeydown: (event) => {
        const index = ROOM_ORDER.indexOf(id);
        const next = event.key === 'ArrowRight' ? ROOM_ORDER[(index + 1) % ROOM_ORDER.length] : event.key === 'ArrowLeft' ? ROOM_ORDER[(index + ROOM_ORDER.length - 1) % ROOM_ORDER.length] : null;
        if (next) { event.preventDefault(); selectRoom(next); $('room-tabs').querySelector('[aria-selected="true"]')?.focus(); }
      },
    }, el('span', { class: 'room-name', text: room.label }), el('span', { class: 'room-count', text: `${counts[id] ?? 0}명` })));
  }
}


function renderList() {
  const rows = state.scene.map((item) => {
    const agent = state.agents.find((a) => a.author === item.author);
    const last = state.recent.get(item.author)?.at(-1);
    return el('tr', {},
      el('td', {}, el('button', { type: 'button', class: 'link', onclick: () => openAgent(item.author), text: item.author })),
      el('td', { text: KIND_LABELS[item.kind] ?? item.kind }),
      el('td', { text: `${STATE_LABELS[item.state] ?? item.state}${item.spot ? '' : item.seated ? '' : ' (자리 없음)'}` }),
      el('td', { text: item.spot ? roomOf(item.room).label : '-' }),
      el('td', { text: item.feature ?? '-' }),
      el('td', { text: agent ? timeLabel(agent.lastActive) : '-' }),
      el('td', {}, last ? `[${last.channel}] ${last.text.slice(0, 80)}` : '-'),
    );
  });
  clear($('agent-rows')).append(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 7, class: 'empty', text: '참여한 AI 세션이 없습니다. 쓰는 도구에서 /wax:init(처음) 또는 /wax:join(다른 세션)을 실행하면 들어옵니다. Codex는 $wax:join, Antigravity CLI는 /join입니다.' }))]));
}

function applyView() {
  const list = view === 'list';
  $('list-view').hidden = !list;
  $('office-view').hidden = list;
  $('view-toggle').setAttribute('aria-pressed', String(list));
  $('view-toggle').textContent = list ? '사무실 보기' : '목록 보기';
  if (!list) requestFrame();
}


function npcFace(actor, sprite) {
  const thumb = faceThumb(state.faces, actor.persona, 'npc', actor.author);
  if (thumb) { thumb.classList.add('card-face'); return thumb; }
  return faceShot(sprite, { jacket: actor.jacket ?? null }, actor.author, 80);
}

function openNpc(actor) {
  const guide = npcGuide(actor.npc, npcContext());
  $('agent-title').textContent = guide.title;
  const sprite = state.assets?.characters?.[actor.persona];
  const tabs = guide.sections.map((section) => ({ label: section.heading, content: el('ul', { class: 'note-list' }, section.items.map((item) => el('li', { text: item }))) }));
  if (guide.commandTable) {
    const head = el('tr', {}, el('th', { scope: 'col', text: '명령' }), TOOLS.map((tool) => el('th', { scope: 'col', text: tool.label })));
    const rows = COMMANDS.map((c) => el('tr', {}, el('th', { scope: 'row', text: `${c.label} (${c.name})` }), TOOLS.map((tool) => el('td', {}, el('code', { text: commandFor(tool.kind, c.name, c.args.startsWith('<작업ID>') ? 'login' : '') })))));
    tabs.push({ label: '도구별 명령', content: el('div', {}, el('p', { class: 'kind', text: '작업 ID 자리에는 예시로 login을 넣었어요.' }),
      el('div', { class: 'table-wrap' }, el('table', { class: 'agent-table' }, el('thead', {}, head), el('tbody', {}, rows)))) });
  }
  const content = [
    el('header', { class: 'npc-head' }, npcFace(actor, sprite),
      el('div', {}, el('strong', { class: 'npc-name', text: `${actor.author} · 안내 NPC` }), el('p', { class: 'kind', text: guide.role }))),
    el('div', { class: 'npc-section' }, cardTabs(tabs)),
    el('p', { class: 'kind' }, '더 자세한 내용은 ', el('a', { href: '/help', text: '도움말' }), '에 있어요. NPC 대화는 프로젝트 기록으로 저장하지 않아요.'),
  ];
  const target = $('agent-content');
  target.dataset.npc = actor.npc;
  clear(target).append(...content);
  if (actor.npc === 'design') target.append(el('button', {
    type: 'button', text: '디자인실 제작물 열기', onclick: () => { $('agent-dialog').close(); openStudio(); },
  }));
  if (actor.npc === 'tools') {
    const button = el('button', { type: 'button', text: '설치 버전 다시 확인' });
    const check = async () => {
      button.disabled = true; button.textContent = '설치 버전 확인 중…';
      const ok = await refreshTools({ fresh: true });
      if (!$('agent-dialog').open || target.dataset.npc !== 'tools' || !target.contains(button)) return;
      if (ok) openNpc(actor);
      else { button.disabled = false; button.textContent = '버전 확인 실패 · 다시 확인'; }
    };
    button.addEventListener('click', check);
    const newsButton = el('button', { type: 'button', text: '공식 소식 다시 확인' });
    newsButton.addEventListener('click', async () => {
      newsButton.disabled = true; newsButton.textContent = '공식 소식 확인 중…';
      const ok = await refreshToolNews({ fresh: true });
      if (!$('agent-dialog').open || target.dataset.npc !== 'tools' || !target.contains(newsButton)) return;
      if (ok) openNpc(actor);
      else { newsButton.disabled = false; newsButton.textContent = '소식 확인 실패 · 다시 확인'; }
    });
    target.append(el('div', { class: 'row' }, button, newsButton));

  }
  $('agent-dialog').showModal();
}


function teamSummary() {
  const ai = state.scene.filter((item) => item.kind !== 'human');
  const live = state.features.filter((feature) => !feature.archivedAt);
  const tasks = state.tasks ?? [];
  return {
    ai: ai.length, working: ai.filter((item) => item.state === 'working').length,
    active: live.filter((feature) => feature.phase !== 'done').length, done: live.filter((feature) => feature.phase === 'done').length,
    openTasks: tasks.filter((task) => ['open', 'accepted', 'blocked'].includes(task.status ?? 'open')).length, blocked: tasks.filter((task) => task.status === 'blocked').length,
    pm: state.pm,
  };
}

async function openAgent(author) {
  const agent = state.agents.find((a) => a.author === author);
  const item = state.scene.find((s) => s.author === author);
  $('agent-title').textContent = author;
  const recent = (state.recent.get(author) ?? []).slice(-5).reverse();
  const kind = agent?.kind ?? 'other';
  const chatAction = kind === 'human' ? null : el('button', {
    type: 'button', class: 'hr-chat-button icon-label',
    onclick: () => { $('agent-dialog').close(); void messenger.open({ author, channel: agent?.feature }); },
  }, icon('message', 15), '채팅');
  const nowInfo = el('dl', { class: 'dl' },
    el('dt', { text: '종류' }), el('dd', { text: KIND_LABELS[agent?.kind] ?? agent?.kind ?? '-' }),
    el('dt', { text: '상태' }), el('dd', { text: STATE_LABELS[item?.state] ?? '-' }),
    el('dt', { text: '위치' }), el('dd', { text: item?.spot ? `${roomOf(item.room).label}${item.ceo ? ' (대표)' : state.pm === author ? ' (PM)' : ''}` : '-' }),
    el('dt', { text: '작업' }), el('dd', {}, agent?.feature ? (demo ? el('button', { type: 'button', class: 'link', text: '데모 화이트보드 열기', onclick: () => { $('agent-dialog').close(); openBoard('demo-work'); } }) : el('a', { href: `/chat?channel=${encodeURIComponent(agent.feature)}`, text: `${agent.feature} 채널 열기` })) : '-'),
    el('dt', { text: '메모' }), el('dd', { text: agent?.note ?? '-' }),
    el('dt', { text: '마지막 활동' }), el('dd', { text: agent ? new Date(agent.lastActive).toLocaleString('ko-KR') : '-' }),
    );
  const recentList = recent.length ? el('ul', { class: 'note-list' }, recent.map((r) => el('li', {},
    el('div', {}, el('span', { class: 'badge', text: r.label }), ' ', el('span', { class: 'kind', text: `${r.channel === 'general' ? state.config.project : r.channel} · ${timeLabel(r.at)}` })),
    el('div', { class: 'body' }, richText(r.text)),
    ))) : el('p', { class: 'empty', text: '최근 메시지가 없습니다.' });
  const tabs = [{ label: '지금', content: nowInfo }, { label: `최근 메시지 ${recent.length}`, content: recentList }];
  const card = el('div', { class: 'hr-slot' }, el('p', { class: 'kind', text: '인사기록 카드를 불러오는 중…' }));
  api('/api/profiles').then(({ profiles }) => {
    const profile = profiles.find((p) => p.author === author) ?? null;
    if (kind === 'human') { clear(card).append(ceoCard({ author, profile, face: faceOf(author, kind, 112), team: teamSummary(), department: state.config.project, tabs })); return; }
    clear(card).append(profileCard({ author, kindLabel: agent?.model ? `${KIND_LABELS[profile?.kind ?? kind] ?? kind} · ${agent.model}` : KIND_LABELS[profile?.kind ?? kind] ?? kind, profile, face: faceOf(author, kind, 112), department: state.config.project, lead: state.pm === author, extra: chatAction, tabs }));
  }).catch(() => clear(card).append(el('p', { class: 'kind', text: '인사기록 카드를 불러오지 못했습니다.' }), ...(chatAction ? [chatAction] : []), cardTabs(tabs)));
  const next = el('div', { class: 'hr-next' });
  if (agent) api('/api/team').then(({ tasks }) => {
    const cmd = nextCommand({ agent, features: state.features, tasks: tasks ?? [] });
    if (cmd) clear(next).append(commandLine('다음 명령', cmd.text, cmd.reason));
  }).catch(() => {});
  clear($('agent-content')).append(card, next);
  $('agent-dialog').showModal();
}

let boardTab = 'notes', noteFilter = 'all', designData = null;
async function refreshDesign() {
  try { designData = await api('/api/design'); } catch { designData ??= { targets: [], jobs: [] }; }
  if ($('studio-dialog').open) openStudio({ fetch: false });
}
function openStudio({ fetch = true } = {}) {
  const panel = clear($('studio-content'));
  const collab = el('div', { class: 'studio-collab' });
  renderStudioCollab(collab, { data: designData ?? { targets: [], jobs: [] }, features: state.features.filter((f) => f.phase !== 'done'), api, token: state.config?.token, refresh: refreshDesign, demo: Boolean(demo || designData?.demo) });
  if (fetch) refreshDesign();
  const features = state.features.filter(feature => feature.phase === 'design' || feature.designPreview);
  panel.append(collab, el('h3', { text: '워크플로우 시안' }), el('p', { text: '브리프 → 시안 제작 → 실제 화면·실행 환경 확인 → 개발 인계' }),
    el('p', { text: '화면 설계는 Figma, 이미지·배경·소품은 Midjourney·이미지 도구, 착용 이미지는 FASHN, 3D 모델은 Blender 등 작업에 맞는 도구를 사용합니다. 실제 연결 여부는 담당 AI가 워크플로우에서 확인합니다.' }));
  if (!features.length) panel.append(el('p', { class: 'empty', text: '현재 설계 중이거나 시안이 등록된 작업이 없습니다. 대시보드에서 만들고 싶은 결과를 요청하세요.' }));
  for (const feature of features) {
    const preview = feature.designPreview;
    const card = el('section', { class: 'card' }, el('h3', { text: feature.title }), el('p', { class: 'kind', text: `${PROJECT_TYPES[feature.projectType]?.label || '프로젝트'} · ${state.config.labels?.[feature.phase] || feature.phase}` }));
    if (preview) {
      card.append(el('p', { text: `개발 인계 시안: ${preview.file}` }));
      if (/\.(png|jpe?g|webp|gif)$/i.test(preview.file)) card.append(el('img', { src: preview.url, alt: `${feature.title} 설계 시안`, class: 'studio-preview-image' }));
      else if (/\.html$/i.test(preview.file)) card.append(el('iframe', { src: preview.url, sandbox: '', title: `${feature.title} 시안`, class: 'studio-preview-frame' }));
      card.append(el('a', { href: preview.url, target: '_blank', rel: 'noopener', text: '등록 시안 열기 ↗' }));
    } else card.append(el('p', { text: '시안을 제작하고 있습니다. 설명 문서만으로 시안을 완료 처리하지 않습니다.' }));
    card.append(el('p', {}, el('a', { href: feature.id.startsWith('request-') ? `/?request=${encodeURIComponent(feature.id)}` : `/manage?feature=${encodeURIComponent(feature.id)}`, text: '현재 미션과 검증 기록 보기 ↗' })));
    panel.append(card);
  }
  if (!$('studio-dialog').open) $('studio-dialog').showModal();
}
function openBoard(id = state.currentBoard) {
  const select = clear($('board-select'));
  const ids = [...new Set([...state.channels.map((c) => c.id), ...state.boards.keys()])];
  for (const channelId of ids) select.append(el('option', { value: channelId, text: channelId, selected: channelId === id }));
  select.value = id ?? ids[0] ?? '';
  renderBoard();
  if (!$('board-dialog').open) $('board-dialog').showModal();
}

function renderBoard() {
  for (const url of digestUrls) URL.revokeObjectURL(url); digestUrls.clear();
  const id = $('board-select').value;
  const board = state.boards.get(id) ?? { notes: [], reports: [] };
  for (const tab of $('board-dialog').querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === boardTab));
  const panel = clear($('panel-board'));
  panel.setAttribute('aria-labelledby', `tab-${boardTab}`);
  if (boardTab === 'notes') {
    const filters = el('div', { class: 'filters', role: 'group', 'aria-label': '노트 유형 필터' },
      ['all', 'opinion', 'question', 'answer', 'decision'].map((type) => el('button', {
        type: 'button', 'aria-pressed': String(noteFilter === type), text: type === 'all' ? '전체' : TYPE_LABELS[type],
        onclick: () => { noteFilter = type; renderBoard(); },
      })));
    const byId = new Map(board.notes.map((note) => [note.id, note]));
    const notes = board.notes.filter((note) => noteFilter === 'all' || note.type === noteFilter).slice().reverse();
    panel.append(filters, notes.length ? el('ul', { class: 'note-list' }, notes.map((note) => el('li', {},
      el('div', {},
        el('span', { class: `badge type-${note.type}`, text: TYPE_LABELS[note.type] }), ' ',
        note.stance ? el('span', { class: 'badge', text: note.stance === 'disagree' ? '이견' : '동의' }) : null, ' ',
        el('strong', { text: note.author }), ' ', el('span', { class: 'kind', text: `${note.kind} · ${note.phase ?? '-'} · ${timeLabel(note.at)} · ${note.id}` })),
      note.replyTo ? el('div', { class: 'kind', text: `↳ ${note.replyTo} ${byId.get(note.replyTo)?.author ?? ''}: ${(byId.get(note.replyTo)?.body ?? '').slice(0, 60)}` }) : null,
      el('div', { class: 'body' }, richText(note.body)),
    ))) : el('p', { class: 'empty', text: '노트가 없습니다. 에이전트가 wax chat board post로 노트를 붙입니다.' }),
    digestSection(id));
  } else if (boardTab === 'phases') {
    panel.append(el('div', { class: 'kanban' }, PHASE_COLUMNS.map((phase) => el('section', {},
      el('h3', {}, icon(phase === 'done' ? 'passed' : phase), ' ', state.config.labels?.[phase] ?? phase),
      state.features.filter((f) => f.phase === phase).map((f) => el('div', { class: 'card' }, el('strong', { text: f.id }), el('div', { class: 'kind', text: f.title }))),
    ))));
  } else {
    const viewer = el('div');
    panel.append(board.reports.length ? el('ul', { class: 'note-list' }, board.reports.slice().reverse().map((report) => el('li', {},
      el('button', { type: 'button', text: `보고서 ${String(report.number).padStart(3, '0')}`, onclick: async () => {
        try { clear(viewer).append(el('pre', { class: 'markdown', text: await api(`/api/board/${encodeURIComponent(id)}/reports/${report.number}`) })); }
        catch (error) { clear(viewer).append(el('p', { class: 'error', text: error.message })); }
      } }), ' ',
      el('span', { class: 'kind', text: `${report.author} · ${new Date(report.at).toLocaleString('ko-KR')} · 노트 ${report.noteCount}개 · ${report.path}` }),
    ))) : el('p', { class: 'empty', text: '아직 보고서가 없습니다.' }), viewer);
  }
}

const digestUrls = new Set();
window.addEventListener('pagehide', () => { for (const url of digestUrls) URL.revokeObjectURL(url); digestUrls.clear(); });
function digestSection(id) {
  let downloadUrl;
  const out = el('div');
  const button = el('button', { type: 'button', class: 'primary', text: '집계 초안 만들기', onclick: async () => {
    try {
      const digest = await api(`/api/board/${encodeURIComponent(id)}/digest`);
      if (downloadUrl) { URL.revokeObjectURL(downloadUrl); digestUrls.delete(downloadUrl); }
      const blob = downloadUrl = URL.createObjectURL(new Blob([digest.markdown], { type: 'text/markdown' }));
      digestUrls.add(blob);
      clear(out).append(
        el('div', { class: 'row' },
          el('button', { type: 'button', text: '복사', onclick: () => navigator.clipboard?.writeText(digest.markdown) }), ' ',
          el('a', { href: blob, download: `${id}-digest.md`, text: '다운로드' })),
        el('pre', { class: 'markdown', text: digest.markdown }));
    } catch (error) { clear(out).append(el('p', { class: 'error', text: error.message })); }
  } });
  return el('section', {}, el('h3', { text: '요약 보고서' }),
    el('p', { class: 'kind', text: '집계 초안은 화면에만 표시하고 파일을 만들지 않습니다. 에이전트에게 wax chat board report로 보고서 작성을 요청하세요.' }),
    button, out);
}


function announce(text) { $('live').textContent = text; }

function connect({ resync = false } = {}) {
  if (demo) { $('status').textContent = '가상 데모'; return; }
  const source = new EventSource('/api/events');
  let wasDown = resync;
  const retry = createSnapshotRetry({
    load: loadSnapshot,
    onSynced: () => { wasDown = false; updateScene(); $('status').dataset.state = 'live'; $('status').textContent = '실시간 연결됨'; },
    onError: (error) => { $('status').dataset.state = 'down'; $('status').textContent = `기록 동기화 재시도 중: ${error.message}`; },
  });
  source.onopen = () => {
    $('status').dataset.state = 'live';
    $('status').textContent = '실시간 연결됨';
    if (wasDown) retry.start();
  };
  source.onerror = () => { retry.stop(); wasDown = true; $('status').dataset.state = 'down'; $('status').textContent = '연결 끊김 — 다시 연결 중'; };
  source.addEventListener('message', (event) => {
    const { channel, message } = JSON.parse(event.data);
    const unread = messenger.receive(channel, message);
    addMessage(channel, message);
    addToOrder([message.author]);
    if (unread || message.author === state.config.user) showBubble(message.author, message.body, 'message', BUBBLE_MS, unread ? { channel, id: message.id } : null);
    refreshSkills();
    announce(`${message.author}: ${channel} 채널에 메시지`);
    updateScene();
  });
  source.addEventListener('note', (event) => {
    const { board, note } = JSON.parse(event.data);
    addNote(board, note);
    addToOrder([note.author]);
    state.currentBoard = board;
    showBubble(note.author, `[${TYPE_LABELS[note.type]}] ${note.body}`, 'note');
    refreshSkills();
    announce(`${note.author}: ${board} 화이트보드에 ${TYPE_LABELS[note.type]}`);
    updateScene();
    setTimeout(() => updateScene(), BOARD_VISIT_MS + 100);
    if ($('board-dialog').open) renderBoard();
  });
  source.addEventListener('report', (event) => {
    const { board, report } = JSON.parse(event.data);
    const entry = state.boards.get(board) ?? { notes: [], reports: [] };
    if (!entry.reports.some((r) => r.id === report.id)) entry.reports.push(report);
    state.boards.set(board, entry);
    announce(`${report.author}: ${board} 요약 보고서 ${report.number} 등록`);
    refreshSkills();
    if ($('board-dialog').open) renderBoard();
    requestFrame();
  });
  source.addEventListener('presence', (event) => {
    state.agents = JSON.parse(event.data).agents;
    addToOrder(state.agents.map((a) => a.author));
    updateScene();
  });
  source.addEventListener('tasks', async () => {
    refreshSkills();
    const team = await api('/api/team').catch(() => null);
    if (team) state.tasks = team.tasks ?? [];
    if (team && (team.pm?.author ?? null) !== state.pm) { state.pm = team.pm?.author ?? null; updateScene(); }
  });
  source.addEventListener('design', () => { if ($('studio-dialog').open) refreshDesign(); });
  source.addEventListener('features', (event) => {
    state.features = JSON.parse(event.data).features;
    updateScene();
    if ($('studio-dialog').open) openStudio({ fetch: false });
    refreshSkills();
    if ($('board-dialog').open) renderBoard();
    requestFrame();
  });
  return () => { retry.stop(); source.close(); };
}

let disconnectOffice;
window.addEventListener('pagehide', () => { disconnectOffice?.(); disconnectOffice = null; });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && state.config && !demo) { disconnectOffice = connect({ resync: true }); }
});


for (const dialog of dialogSurface.dialogs) {
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.closest('[data-close]')) dialog.close(); });
}
for (const tab of $('board-dialog').querySelectorAll('[data-tab]')) tab.addEventListener('click', () => { boardTab = tab.dataset.tab; renderBoard(); });
$('board-select').addEventListener('change', renderBoard);
$('open-board').addEventListener('click', () => openBoard());
$('open-studio').addEventListener('click', () => openStudio());
if (new URLSearchParams(location.search).get('studio') === '1' && !demo) addEventListener('load', () => setTimeout(() => { if (state.config) openStudio(); }, 300), { once: true });
$('chatter-toggle').addEventListener('click', () => { chatterOn = !chatterOn; store('wax.office.chatter', chatterOn ? 'on' : 'off'); applyChatter(); });
applyChatter();
setInterval(chatterTick, 2000);
setInterval(strollTick, 1000);
setInterval(refreshUsage, 30_000);
setInterval(() => { if (!document.hidden) refreshTools(); }, 10 * 60_000);
setInterval(() => { if (!document.hidden) refreshToolNews(); }, 60_000);
$('view-toggle').addEventListener('click', () => { view = view === 'list' ? 'office' : 'list'; store('wax-chat.office.view', view); applyView(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastTime = performance.now(); requestFrame(); } });
new ResizeObserver(() => requestFrame()).observe(stage);
reducedQuery.addEventListener('change', () => updateScene({ instant: true }));
setInterval(() => updateScene(), 5000);

try {
  state.config = await api('/api/config');
  document.title = `${state.config.project} · wax 가상 사무실`;
  [state.assets, state.faces] = await Promise.all([loadSideAssets(), loadFaceAssets(), loadSnapshot()]);
  if (!state.assets || !state.assets.personas?.length || !Object.keys(state.assets.characters ?? {}).length || BUILDING.floors.some((id) => !state.assets.backgrounds?.[BUILDING.rooms[id].background])) {
    state.assetError = '건물·캐릭터 이미지를 불러오지 못했습니다. 이미지 경로를 확인한 뒤 새로고침해 주세요. 목록 보기와 채팅은 계속 사용할 수 있습니다.';
    state.assets = null;
  }
  refreshSkills({ initial: true });
  refreshUsage();
  refreshTools();
  refreshToolNews();
  assetsSettled = Boolean(state.assets);
  applyView();
  updateScene({ instant: true });
  disconnectOffice = connect();
  if (!demo && new URLSearchParams(location.search).has('room')) requestAnimationFrame(() => scrollToFloor(state.room, 'instant'));
  if (demo) {
    const publishCast = () => demo.cast(state.agents.map((agent) => {
      const portrait = faceOf(agent.author, agent.kind, 64);
      return { author: agent.author, portrait: portrait instanceof HTMLCanvasElement ? portrait.toDataURL('image/png') : null };
    }));
    const applyDemo = async () => {
      await loadSnapshot();
      refreshSkills(); refreshUsage();
      updateScene({ instant: demo.jumped }); publishCast();
      const snapshot = demo.snapshot;
      state.room = snapshot.room;
      renderRoomTabs(); scrollToFloor(snapshot.room, 'instant');
      if (snapshot.view.index > 0) showBubble(snapshot.view.step.actor, snapshot.view.step.detail, 'message');
      if ($('board-dialog').open) renderBoard();
    };
    demo.onStep = applyDemo;
    demo.onAction = ({ action, author }) => {
      if (action === 'agent') void openAgent(author);
      else { boardTab = action === 'report' ? 'reports' : 'notes'; openBoard('demo-work'); }
    };
    document.addEventListener('click', (event) => { if (event.target.closest('button')) demo.interacted(); }, true);
    state.room = demo.snapshot.room; renderRoomTabs();
    scrollToFloor(demo.snapshot.room, 'instant');
    publishCast();
    demo.ready();
  }
} catch (error) {
  $('notice').hidden = false;
  $('notice').textContent = `사무실을 불러오지 못했습니다: ${error.message}`;
}
