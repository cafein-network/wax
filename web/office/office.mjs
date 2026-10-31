import { t } from '../messages-catalog.mjs';
import { api as liveApi, clear, commandLine, dateLocale, el, richText, storage as liveStorage, store as liveStore, timeLabel, tr, trFill } from '/dom.mjs';
import { COMMANDS, TOOLS, commandFor, nextCommand } from '/commands.mjs';
import { createDialogSurface } from '/dialog-surface.mjs';
import { createOfficeDemo } from './demo.mjs';
import { createBoardDialog } from './board-dialog.mjs';
import { createSkillMapDialog } from './skill-map.mjs';
import { workNotesPanel } from './work-notes.mjs';
import { createUsageMonitor } from './usage-monitor.mjs';
import { icon } from '/icons.mjs';
import { openEvents } from '/events.mjs';
import { carriesChair, restingChairs, createSnapshotRetry } from './behavior.mjs';
const demo = new URLSearchParams(location.search).get('demo') === '1' ? createOfficeDemo(window) : null;
const api = demo ? demo.api : liveApi;
const storage = (key, fallback) => demo ? fallback : liveStorage(key, fallback);
const store = (key, value) => { if (!demo) liveStore(key, value); };
import { BUILDING, EXTRA_SEATS, FLOOR_HEIGHT, SCALE, SIDE_ROOMS } from './side-rooms.mjs';
import { actorBox, render } from './side-render.mjs';
import { KIND_LABELS, STATE_LABELS, BOARD_VISIT_MS, lookFor, officeScene, summaryLabel } from './model.mjs';
import { SIT_MS, WALK_SPEED, point, poseAt, positionAt, routeLength, routeTo } from './animate.mjs';
import { npcGuide, NPCS } from './chatter.mjs';
import { assetProgress, loadSideAssets } from './sprites.mjs';
import { drawNotes } from './notes.mjs';
import { cardTabs, ceoCard, faceShot, profileCard } from './card.mjs';
import { isPlaying, startMusic, stopMusic } from './music.mjs';
import { createOfficeMessenger } from './messenger.mjs';
import { assignPersonas, faceThumb, loadFaceAssets } from './faces.mjs';
import { PROJECT_TYPES } from '/project-types.mjs';
import { renderStudioCollab } from './studio.mjs';
import { TYPE_LABELS, addMessage, addNote, addToOrder, loadSnapshot as loadRecords, npcContext, teamSummary } from './scene-state.mjs';
import { OUTFIT_COLORS, createFlights } from './flights.mjs';
import { BUBBLE_MS, bubbleText, stackBubbles, stackTags } from './bubble-layout.mjs';
import { createRoomTabs } from './room-tabs.mjs';
import { createListView } from './list-view.mjs';
import { createAmbient } from './ambient.mjs';

const ROOMS = SIDE_ROOMS;
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
const STAY_PUT = true;
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
let chatterOn = !demo && storage('wax.office.chatter', 'on') !== 'off';
if (demo) document.body.classList.add('office-demo');


async function loadSnapshot() {
  await loadRecords(state, api, { wanted: new URLSearchParams(location.search).get('board') });
  boardDialog.reload();
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
  state.scene = officeScene({ agents: state.agents, order: state.order, events: state.events, lastNoteAt: state.lastNoteAt, now, awayAfterMs: state.config.awayAfterMs, pm: state.pm, lab: SIDE_ROOMS.lab, roof: SIDE_ROOMS.roof, studio: SIDE_ROOMS.studio, features: state.features, stay: true });
  const walk = (actor, target, leaving) => walkTo(actor, target, leaving, instant || STAY_PUT);
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
      const start = instant || STAY_PUT ? point(place.spot, room) : point(room.SPOTS.entrance, room);
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
      const start = instant || STAY_PUT ? point(spot, npcRoom) : point(npcRoom.SPOTS.entrance, npcRoom);
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
  roomTabs.render();
  canvas.setAttribute('aria-label', `${tr(roomOf(state.room).label)} — ${tr(summaryLabel(state.scene.filter((item) => (item.room ?? 'dev') === state.room)))}`);
  const hidden = state.scene.filter((item) => !item.seated);
  $('notice').hidden = !state.assetError && !hidden.length;
  $('notice').textContent = state.assetError || (hidden.length ? t('office.office.agentsNotShownIn', hidden.map((item) => item.author).join(', ')) : '');
  listView.render();
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


const noteFlights = createFlights({ actors, state, requestFrame, rate: () => (demo ? demo.rate : 1) });
if (debug) globalThis.__waxFlights = noteFlights.flights;


let frameRequested = false, lastTime = performance.now(), lastDraw = 0, idleTimer = null;
function requestFrame() {
  if (frameRequested || document.hidden) return;
  clearTimeout(idleTimer);
  frameRequested = true;
  requestAnimationFrame(tick);
}
const IDLE_FRAME_MS = 120;

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
  if (noteFlights.move(dt, time)) walking = true;
  const animated = !reduced && (isPlaying() || [...actors.values()].some((actor) => actor.visible && actor.room === viewing()));
  if (walking || settling || !animated || time - lastDraw >= IDLE_FRAME_MS || lastDraw === 0) {
    draw(time);
    lastDraw = time;
  }
  if (walking || settling) requestFrame();
  else if (animated) { clearTimeout(idleTimer); idleTimer = setTimeout(requestFrame, Math.max(0, IDLE_FRAME_MS - (time - lastDraw))); }
}

async function toggleMusic() {
  if (isPlaying()) stopMusic();
  else if (!(await startMusic())) return;
  requestFrame();
}

let assetsSettled = false;
let assetsLoaded;
const assetsReady = new Promise((resolve) => { assetsLoaded = resolve; });
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
  drawNotes(ctx, noteFlights.flights, time, reduced);
  positionOverlay(time);
}


const overlayNodes = new Map();
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const setData = (node, name, value) => { if (node.dataset[name] !== value) node.dataset[name] = value; };
const setStyle = (node, styles) => { for (const [name, value] of Object.entries(styles)) if (node.style[name] !== value) node.style[name] = value; };
function overlayFor(key, create) {
  if (!overlayNodes.has(key)) { const node = create(); overlay.append(node); overlayNodes.set(key, node); }
  return overlayNodes.get(key);
}

function positionOverlay(time) {
  const scale = stage.clientWidth / BUILDING.SIZE.width;
  setData(stage, 'compact', String(scale < 0.45));
  const now = Date.now();
  const seen = new Set();
  const placed = [];
  const tags = [];
  const hitArea = stageRoom(state.room).WHITEBOARD_HIT;
  if (hitArea) {
    seen.add('board');
    const boardButton = overlayFor('board', () => el('button', { type: 'button', class: 'hit', 'aria-label': t('office.office.openWhiteboard'), onclick: () => boardDialog.open() }));
    setStyle(boardButton, { left: `${hitArea.x * scale}px`, top: `${hitArea.y * scale}px`, width: `${hitArea.width * scale}px`, height: `${hitArea.height * scale}px` });
  }
  const speaker = stageRoom(state.room).SPEAKER_HIT;
  const studio = stageRoom(state.room).STUDIO_HIT;
  if (studio) {
    seen.add('studio');
    const button = overlayFor('studio', () => el('button', { type: 'button', class: 'hit', 'aria-label': t('office.office.viewDesignDeliverables'), onclick: openStudio }));
    setStyle(button, { left: `${studio.x * scale}px`, top: `${studio.y * scale}px`, width: `${studio.width * scale}px`, height: `${studio.height * scale}px` });
  }
  if (speaker) {
    seen.add('speaker');
    const button = overlayFor('speaker', () => el('button', { type: 'button', class: 'hit', onclick: toggleMusic }));
    const speakerLabel = isPlaying() ? t('office.office.speakerTurnNoteAnimation') : t('office.office.speakerTurnNoteAnimationOn');
    setAttr(button, 'aria-label', speakerLabel);
    setAttr(button, 'aria-pressed', String(isPlaying()));
    setAttr(button, 'title', speakerLabel);
    setStyle(button, { left: `${speaker.x * scale}px`, top: `${speaker.y * scale}px`, width: `${speaker.width * scale}px`, height: `${speaker.height * scale}px` });
  }
  usageMonitor.place(scale, seen);
  for (const actor of actors.values()) {
    if (!actor.visible || !actor.drawn || actor.room !== viewing()) continue;
    const sprite = state.assets && (state.assets.characters[actor.drawn.persona] ?? state.assets.characters[state.assets.personas[0]]);
    const box = actorBox(actor.drawn, sprite ?? undefined);
    const label = actor.npc ? `${actor.author}, 안내 NPC(세션이 아니며 기록되지 않음)` : `${actor.author}, ${KIND_LABELS[actor.kind] ?? actor.kind}, ${STATE_LABELS[actor.state] ?? actor.state}${actor.item?.feature ? `, ${actor.item.feature}` : ''}`;
    const hitKey = `hit:${actor.author}`, tagKey = `tag:${actor.author}`, bubbleKey = `bubble:${actor.author}`;
    seen.add(hitKey); seen.add(tagKey);
    const hit = overlayFor(hitKey, () => el('button', { type: 'button', class: 'hit', onclick: () => (actor.npc ? openNpc(actor) : openAgent(actor.author)) }));
    setAttr(hit, 'aria-label', label);
    setStyle(hit, { left: `${box.left * scale}px`, top: `${box.top * scale}px`, width: `${(box.right - box.left) * scale}px`, height: `${(box.bottom - box.top + 6) * scale}px` });
    const tag = overlayFor(tagKey, () => el('span', { class: 'nametag' }, el('span', { class: 'dot' }), el('span', { class: 'name' })));
    setText(tag.querySelector('.name'), actor.author);
    tag.classList.toggle('npc', Boolean(actor.npc));
    tag.classList.toggle('ceo', Boolean(actor.item?.ceo));
    const tone = actor.color ?? OUTFIT_COLORS[actor.kind] ?? OUTFIT_COLORS.other;
    const dot = tag.querySelector('.dot');
    if (dot.dataset.tone !== tone) { dot.dataset.tone = tone; dot.style.background = tone; }
    setStyle(tag, { left: `${actor.drawn.x * scale}px` });
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
      setAttr(button, 'aria-label', label); setAttr(button, 'title', label);
      setData(button, 'unread', String(unread > 0));
      setStyle(button, {
        left: `${Math.min(stage.clientWidth - 32, Math.max(4, actor.drawn.x * scale - 14))}px`,
        top: `${Math.max(4, box.top * scale - 34)}px`,
      });
    }
    const aura = !actor.npc && state.auras.get(actor.author);
    if (aura && aura.until > now) {
      const auraKey = `aura:${actor.author}`;
      seen.add(auraKey);
      const node = overlayFor(auraKey, () => el('div', { class: 'aura', 'aria-hidden': 'true' }, el('span', { class: 'aura-label' })));
      setData(node, 'axis', aura.key);
      setText(node.querySelector('.aura-label'), `${aura.label} ↑`);
      const height = box.bottom - box.top;
      const size = Math.max(28, height * 0.42 * scale);
      setStyle(node, { left: `${actor.drawn.x * scale}px`, top: `${(box.top + height * 0.17) * scale}px`, width: `${size}px`, height: `${size}px` });
    }
    const quiet = actor.item?.quiet && !actor.route && actor.activity !== 'sleep';
    const bubble = said && said.until > now ? said
      : quiet ? { text: reducedQuery.matches ? '…' : '.'.repeat(1 + Math.floor(time / 500) % 3), kind: 'quiet' } : null;
    if (bubble) {
      seen.add(bubbleKey);
      const node = overlayFor(bubbleKey, () => el('div', { class: 'bubble', 'aria-hidden': 'true', translate: 'no' }));
      setText(node, bubble.text);
      setData(node, 'kind', bubble.kind);
      if (node.style.getPropertyValue('--tone') !== tone) node.style.setProperty('--tone', tone);
      const bottom = messageToast ? Math.max(4, box.top * scale - 34) - 12 : (box.top - 12) * scale;
      placed.push({ node, x: actor.drawn.x * scale, y: bottom });
    }
  }
  for (const [key, node] of overlayNodes) if (!seen.has(key)) { node.remove(); overlayNodes.delete(key); }
  for (const item of [...placed, ...tags]) { item.width = item.node.offsetWidth; item.height = item.node.offsetHeight; }
  for (const item of stackBubbles(placed, stage.clientWidth)) {
    setStyle(item.node, { left: `${item.x}px` });
    if (item.node.style.getPropertyValue('--tail-x') !== item.tail) item.node.style.setProperty('--tail-x', item.tail);
    setStyle(item.node, { top: `${item.bottom}px` });
  }
  stackTags(tags).forEach((top, i) => setStyle(tags[i].node, { top: `${top}px` }));
}


const usageMonitor = createUsageMonitor({ $, api, state, demo: Boolean(demo), overlayFor, setStyle, requestFrame });

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
  const shown = bubbleText(text, kind, ms, tr);
  state.bubbles.set(author, { text: shown.text, kind, until: Date.now() + shown.ms, message });
  setTimeout(requestFrame, shown.ms + 50);
}


const ambient = createAmbient({ actors, state, showBubble, requestFrame, walkTo, chatterOn: () => chatterOn, listView: () => listView.isList(), stayPut: STAY_PUT, debug });

function applyChatter() {
  $('chatter-toggle').setAttribute('aria-pressed', String(chatterOn));
  $('chatter-toggle').textContent = chatterOn ? t('office.office.npcChatterOn') : t('office.office.npcChatterOff');
  if (state.config) updateScene();
  if (chatterOn) return;
  const now = Date.now();
  for (const [author, bubble] of state.bubbles) if (bubble.kind === 'chatter' && bubble.until > now) state.bubbles.delete(author);
  requestFrame();
}


const roomTabs = createRoomTabs({ $, state, store, stage, reduced: () => reducedQuery.matches });
const listView = createListView({ $, state, view: storage('wax-chat.office.view', 'office'), store, openAgent, requestFrame });


function npcFace(actor, sprite) {
  const thumb = faceThumb(state.faces, actor.persona, 'npc', actor.author);
  if (thumb) { thumb.classList.add('card-face'); return thumb; }
  return faceShot(sprite, { jacket: actor.jacket ?? null }, actor.author, 80);
}

function openNpc(actor) {
  const guide = npcGuide(actor.npc, npcContext(state));
  $('agent-title').textContent = guide.title;
  const sprite = state.assets?.characters?.[actor.persona];
  const tabs = guide.sections.map((section) => ({ label: section.heading, content: el('ul', { class: 'note-list' }, section.items.map((item) => el('li', { text: item }))) }));
  if (guide.commandTable) {
    const head = el('tr', {}, el('th', { scope: 'col', text: t('office.office.command') }), TOOLS.map((tool) => el('th', { scope: 'col', text: tool.label })));
    const rows = COMMANDS.map((c) => el('tr', {}, el('th', { scope: 'row', text: `${c.label} (${c.name})` }), TOOLS.map((tool) => el('td', {}, el('code', { text: commandFor(tool.kind, c.name, c.args.startsWith('<작업ID>') ? 'login' : '') })))));
    tabs.push({ label: t('office.office.commandsByTool'), content: el('div', {}, el('p', { class: 'kind', text: t('office.office.theExampleTaskId') }),
      el('div', { class: 'table-wrap' }, el('table', { class: 'agent-table' }, el('thead', {}, head), el('tbody', {}, rows)))) });
  }
  const content = [
    el('header', { class: 'npc-head' }, npcFace(actor, sprite),
      el('div', {}, el('strong', { class: 'npc-name', text: `${actor.author} · 안내 NPC` }), el('p', { class: 'kind', text: guide.role }))),
    el('div', { class: 'npc-section' }, cardTabs(tabs)),
    el('p', { class: 'kind' }, '더 자세한 내용은 ', el('a', { href: '/help', text: t('office.office.help') }), t('office.office.forMoreDetailsNpc')),
  ];
  const target = $('agent-content');
  target.dataset.npc = actor.npc;
  clear(target).append(...content);
  if (actor.npc === 'design') target.append(el('button', {
    type: 'button', text: t('office.office.openDesignDeliverables'), onclick: () => { $('agent-dialog').close(); openStudio(); },
  }));
  if (actor.npc === 'tools') {
    const button = el('button', { type: 'button', text: t('office.office.recheckInstalledVersions') });
    const check = async () => {
      button.disabled = true; button.textContent = t('office.office.checkingInstalledVersions');
      const ok = await usageMonitor.refreshTools({ fresh: true });
      if (!$('agent-dialog').open || target.dataset.npc !== 'tools' || !target.contains(button)) return;
      if (ok) openNpc(actor);
      else { button.disabled = false; button.textContent = t('office.office.versionCheckFailedRetry'); }
    };
    button.addEventListener('click', check);
    const newsButton = el('button', { type: 'button', text: t('office.office.recheckOfficialNews') });
    newsButton.addEventListener('click', async () => {
      newsButton.disabled = true; newsButton.textContent = t('office.office.checkingOfficialNews');
      const ok = await usageMonitor.refreshToolNews({ fresh: true });
      if (!$('agent-dialog').open || target.dataset.npc !== 'tools' || !target.contains(newsButton)) return;
      if (ok) openNpc(actor);
      else { newsButton.disabled = false; newsButton.textContent = t('office.office.newsCheckFailedRetry'); }
    });
    target.append(el('div', { class: 'row' }, button, newsButton));

  }
  $('agent-dialog').showModal();
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
  }, icon('message', 15), t('office.office.chat'));
  const nowInfo = el('dl', { class: 'dl' },
    el('dt', { text: t('office.office.type') }), el('dd', { text: KIND_LABELS[agent?.kind] ?? agent?.kind ?? '-' }),
    el('dt', { text: t('office.office.status') }), el('dd', { text: STATE_LABELS[item?.state] ?? '-' }),
    el('dt', { text: t('office.office.location') }), el('dd', { text: item?.spot ? `${roomOf(item.room).label}${item.ceo ? ' (대표)' : state.pm === author ? ' (PM)' : ''}` : '-' }),
    el('dt', { text: t('office.office.task') }), el('dd', {}, agent?.feature ? (demo ? el('button', { type: 'button', class: 'link', text: t('office.office.openDemoWhiteboard'), onclick: () => { $('agent-dialog').close(); boardDialog.open('demo-work'); } }) : el('a', { href: `/chat?channel=${encodeURIComponent(agent.feature)}`, text: `${agent.feature} 채널 열기` })) : '-'),
    el('dt', { text: t('office.office.note') }), el('dd', { text: agent?.note ?? '-' }),
    el('dt', { text: t('office.office.lastActive') }), el('dd', { text: agent ? new Date(agent.lastActive).toLocaleString(dateLocale()) : '-' }),
    );
  const recentList = recent.length ? el('ul', { class: 'note-list' }, recent.map((r) => el('li', {},
    el('div', {}, el('span', { class: 'badge', text: r.label }), ' ', el('span', { class: 'kind', text: `${r.channel === 'general' ? state.config.project : r.channel} · ${timeLabel(r.at)}` })),
    el('div', { class: 'body' }, richText(r.text)),
    ))) : el('p', { class: 'empty', text: t('office.office.noRecentMessages') });
  const tabs = [{ label: t('office.office.now'), content: nowInfo }, { label: t('office.office.workNotes'), content: workNotesPanel({ api, author }) }, { label: `최근 메시지 ${recent.length}`, content: recentList }];
  const card = el('div', { class: 'hr-slot' }, el('p', { class: 'kind', text: t('office.office.loadingHrCard') }));
  api('/api/profiles').then(({ profiles }) => {
    const profile = profiles.find((p) => p.author === author) ?? null;
    if (kind === 'human') { clear(card).append(ceoCard({ author, profile, face: faceOf(author, kind, 112), team: teamSummary(state), department: state.config.project, tabs })); return; }
    clear(card).append(profileCard({ author, kindLabel: agent?.model ? `${KIND_LABELS[profile?.kind ?? kind] ?? kind} · ${agent.model}` : KIND_LABELS[profile?.kind ?? kind] ?? kind, profile, face: faceOf(author, kind, 112), department: state.config.project, lead: state.pm === author, extra: chatAction, tabs }));
  }).catch(() => clear(card).append(el('p', { class: 'kind', text: t('office.office.couldNotLoadThe') }), ...(chatAction ? [chatAction] : []), cardTabs(tabs)));
  const next = el('div', { class: 'hr-next' });
  if (agent) api('/api/team').then(({ tasks }) => {
    const cmd = nextCommand({ agent, features: state.features, tasks: tasks ?? [] });
    if (cmd) clear(next).append(commandLine(t('office.office.nextCommand'), cmd.text, cmd.reason));
  }).catch(() => {});
  clear($('agent-content')).append(card, next);
  if (!$('agent-dialog').open) $('agent-dialog').showModal();
  if (!state.assets) void assetsReady.then(() => { if (state.assets && $('agent-dialog').open && $('agent-title').textContent === author) void openAgent(author); });
}

let designData = null;
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
  panel.append(collab, el('h3', { text: t('office.office.workflowPreviews') }), el('p', { text: t('office.office.briefDesignPreviewCheck') }),
    el('p', { text: t('office.office.useToolsSuitedTo') }));
  if (!features.length) panel.append(el('p', { class: 'empty', text: t('office.office.noTasksAreBeing') }));
  for (const feature of features) {
    const preview = feature.designPreview;
    const card = el('section', { class: 'card' }, el('h3', { translate: 'no', text: feature.title }), el('p', { class: 'kind', text: `${PROJECT_TYPES[feature.projectType]?.label || '프로젝트'} · ${state.config.labels?.[feature.phase] || feature.phase}` }));
    if (preview) {
      card.append(el('p', { text: `개발 인계 시안: ${preview.file}` }));
      if (/\.(png|jpe?g|webp|gif)$/i.test(preview.file)) card.append(el('img', { src: preview.url, alt: trFill('{0} 설계 시안', feature.title), translate: 'no', class: 'studio-preview-image' }));
      else if (/\.html$/i.test(preview.file)) card.append(el('iframe', { src: preview.url, sandbox: '', title: trFill('{0} 시안', feature.title), translate: 'no', class: 'studio-preview-frame' }));
      card.append(el('a', { href: preview.url, target: '_blank', rel: 'noopener', text: t('office.office.openRegisteredPreview') }));
    } else card.append(el('p', { text: t('office.office.designPreviewsAreIn') }));
    card.append(el('p', {}, el('a', { href: feature.id.startsWith('request-') ? `/start?request=${encodeURIComponent(feature.id)}` : `/manage?feature=${encodeURIComponent(feature.id)}`, text: t('office.office.viewMissionAndVerification') })));
    panel.append(card);
  }
  if (!$('studio-dialog').open) $('studio-dialog').showModal();
}
const boardDialog = createBoardDialog({ $, api, state });
const skillMap = createSkillMapDialog({ $, api });


function announce(text) { $('live').textContent = text; }

function connect({ resync = false } = {}) {
  if (demo) { $('status').textContent = t('office.office.demo'); return; }
  const source = openEvents();
  let wasDown = resync;
  const retry = createSnapshotRetry({
    load: loadSnapshot,
    onSynced: () => { wasDown = false; updateScene(); $('status').dataset.state = 'live'; $('status').textContent = t('office.office.connectedLive'); },
    onError: (error) => { $('status').dataset.state = 'down'; $('status').textContent = `기록 동기화 재시도 중: ${error.message}`; },
  });
  source.onopen = () => {
    $('status').dataset.state = 'live';
    $('status').textContent = t('office.office.connectedLive');
    if (wasDown) retry.start();
  };
  source.addEventListener('resync', () => retry.start());
  source.onerror = () => { retry.stop(); wasDown = true; $('status').dataset.state = 'down'; $('status').textContent = t('office.office.disconnectedReconnecting'); };
  source.addEventListener('message', (event) => {
    const { channel, message } = JSON.parse(event.data);
    const unread = messenger.receive(channel, message);
    noteFlights.deliverMessage(channel, message);
    addMessage(state, channel, message);
    addToOrder(state, [message.author]);
    if (unread || message.author === state.config.user) showBubble(message.author, message.body, 'message', BUBBLE_MS, unread ? { channel, id: message.id } : null);
    refreshSkills();
    announce(`${message.author}: ${channel} 채널에 메시지`);
    updateScene();
  });
  source.addEventListener('note', (event) => {
    const { board, note } = JSON.parse(event.data);
    addNote(state, board, note);
    addToOrder(state, [note.author]);
    noteFlights.deliverNote(note.author);
    state.currentBoard = board;
    showBubble(note.author, `[${tr(TYPE_LABELS[note.type])}] ${note.body}`, 'note');
    refreshSkills();
    announce(`${note.author}: ${board} 화이트보드에 ${TYPE_LABELS[note.type]}`);
    updateScene();
    setTimeout(() => updateScene(), BOARD_VISIT_MS + 100);
    boardDialog.refresh();
  });
  source.addEventListener('report', (event) => {
    const { board, report } = JSON.parse(event.data);
    const entry = state.boards.get(board) ?? { notes: [], reports: [] };
    if (!entry.reports.some((r) => r.id === report.id)) entry.reports.push(report);
    state.boards.set(board, entry);
    announce(t('office.office.registeredSummaryReport', report.author, board, report.number));
    refreshSkills();
    boardDialog.refresh();
    requestFrame();
  });
  source.addEventListener('presence', (event) => {
    state.agents = JSON.parse(event.data).agents;
    addToOrder(state, state.agents.map((a) => a.author));
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
    boardDialog.refresh();
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
for (const tab of $('board-dialog').querySelectorAll('[data-tab]')) tab.addEventListener('click', () => boardDialog.showTab(tab.dataset.tab));
$('board-select').addEventListener('change', () => boardDialog.choose());
$('open-board').addEventListener('click', () => boardDialog.open());
$('open-skills').addEventListener('click', () => skillMap.open());
$('open-studio').addEventListener('click', () => openStudio());
if (new URLSearchParams(location.search).get('studio') === '1' && !demo) addEventListener('load', () => setTimeout(() => { if (state.config) openStudio(); }, 300), { once: true });
$('chatter-toggle').addEventListener('click', () => { chatterOn = !chatterOn; store('wax.office.chatter', chatterOn ? 'on' : 'off'); applyChatter(); });
applyChatter();
setInterval(ambient.chatterTick, 2000);
setInterval(ambient.strollTick, 1000);
setInterval(usageMonitor.refreshUsage, 30_000);
setInterval(() => { if (!document.hidden) usageMonitor.refreshTools(); }, 10 * 60_000);
setInterval(() => { if (!document.hidden) usageMonitor.refreshToolNews(); }, 60_000);
$('view-toggle').addEventListener('click', () => listView.toggle());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastTime = performance.now(); requestFrame(); } });
new ResizeObserver(() => requestFrame()).observe(stage);
reducedQuery.addEventListener('change', () => updateScene({ instant: true }));
setInterval(() => updateScene(), 5000);

try {
  state.config = await api('/api/config');
  document.title = `${state.config.project} · wax 가상 사무실`;
  const showProgress = ({ detail }) => { if (!state.assets) $('status').textContent = t('office.office.loadingImages', detail.loaded, detail.total); };
  assetProgress.addEventListener('progress', showProgress);
  [state.assets, state.faces] = await Promise.all([loadSideAssets(), loadFaceAssets(), loadSnapshot()]);
  assetProgress.removeEventListener('progress', showProgress);
  assetsLoaded();
  if ($('status').dataset.state === 'down') $('status').textContent = t('office.office.connecting');
  if (!state.assets || !state.assets.personas?.length || !Object.keys(state.assets.characters ?? {}).length || BUILDING.floors.some((id) => !state.assets.backgrounds?.[BUILDING.rooms[id].background])) {
    state.assetError = t('office.office.couldNotLoadTheBuilding');
    state.assets = null;
  }
  refreshSkills({ initial: true });
  usageMonitor.refreshUsage();
  usageMonitor.refreshTools();
  usageMonitor.refreshToolNews();
  assetsSettled = Boolean(state.assets);
  listView.apply();
  updateScene({ instant: true });
  disconnectOffice = connect();
  if (!demo && new URLSearchParams(location.search).has('room')) requestAnimationFrame(() => roomTabs.scrollToFloor(state.room, 'instant'));
  if (demo) {
    const publishCast = () => demo.cast(state.agents.map((agent) => {
      const portrait = faceOf(agent.author, agent.kind, 64);
      return { author: agent.author, portrait: portrait instanceof HTMLCanvasElement ? portrait.toDataURL('image/png') : null };
    }));
    let demoSeen = new Set([...demo.snapshot.messages, ...demo.snapshot.notes].map((item) => item.id));
    const applyDemo = async () => {
      const seenEvents = state.events.slice(), seen = new Set(demoSeen);
      await loadSnapshot();
      refreshSkills(); usageMonitor.refreshUsage();
      updateScene({ instant: demo.jumped }); publishCast();
      const snapshot = demo.snapshot;
      if (!demo.jumped) {
        requestAnimationFrame(() => {
          for (const message of snapshot.messages.filter((m) => !seen.has(m.id))) noteFlights.deliverMessage('demo-work', message, seenEvents);
          for (const note of snapshot.notes.filter((n) => !seen.has(n.id))) noteFlights.deliverNote(note.author);
        });
      }
      demoSeen = new Set([...snapshot.messages, ...snapshot.notes].map((item) => item.id));
      state.room = snapshot.view.index > 0 && !snapshot.view.step.done ? state.scene.find((item) => item.author === snapshot.view.step.actor && item.spot)?.room ?? snapshot.room : snapshot.room;
      roomTabs.render(); roomTabs.scrollToFloor(state.room, 'instant');
      if (snapshot.view.index > 0) showBubble(snapshot.view.step.actor, snapshot.view.step.detail, 'message');
      boardDialog.refresh();
    };
    demo.onStep = applyDemo;
    demo.onAction = ({ action, author }) => {
      if (action === 'agent') void openAgent(author);
      else boardDialog.open('demo-work', action === 'report' ? 'reports' : 'notes');
    };
    document.addEventListener('click', (event) => { if (event.target.closest('button')) demo.interacted(); }, true);
    state.room = demo.snapshot.room; roomTabs.render();
    roomTabs.scrollToFloor(state.room, 'instant');
    publishCast();
    demo.ready();
  }
} catch (error) {
  $('notice').hidden = false;
  $('notice').textContent = `사무실을 불러오지 못했습니다: ${error.message}`;
}
