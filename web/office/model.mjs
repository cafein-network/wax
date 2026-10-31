import { t } from '../messages-catalog.mjs';
import { SEATS, SIZE, SPOTS } from './layout.mjs';
import { ROOMS } from './rooms.mjs';

export const MEETING_WINDOW_MS = 5 * 60 * 1000;
export const BOARD_VISIT_MS = 8000;
export const STATE_LABELS = { working: t('office.model.working'), discussing: t('office.model.discussing'), reviewing: t('office.model.reviewing'), idle: t('office.model.resting'), away: t('office.model.away') };
export const KIND_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', copilot: 'GitHub Copilot', grok: 'Grok', human: t('office.model.ceo'), other: t('office.model.other') };

export function effectiveState(entry, now, awayAfterMs) {
  return now - Date.parse(entry.lastActive) > awayAfterMs ? 'away' : entry.state;
}

export const DESK_RELEASE_MS = 60 * 60 * 1000;
const DESK_NEED = { working: 0, reviewing: 0, discussing: 0, away: 1, idle: 2 };
const deskOwners = (agents, order, now, skip = []) => {
  const recent = new Set(agents.filter((agent) => now - Date.parse(agent.lastActive) <= DESK_RELEASE_MS).map((agent) => agent.author));
  return order.filter((author) => recent.has(author) && !skip.includes(author));
};

export const QUIET_AFTER_MS = 3 * 60 * 1000;
export function isQuiet(entry, now, awayAfterMs, quietAfterMs = Math.min(QUIET_AFTER_MS, awayAfterMs / 2)) {
  const silent = now - Date.parse(entry.lastActive);
  return silent >= quietAfterMs && silent <= awayAfterMs;
}

export function groupMeetings(events, now, windowMs = MEETING_WINDOW_MS) {
  const byChannel = new Map();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (now - at > windowMs || at > now + 1000) continue;
    const group = byChannel.get(event.channel) ?? { channel: event.channel, last: new Map(), lastAt: 0 };
    group.last.set(event.author, Math.max(group.last.get(event.author) ?? 0, at));
    group.lastAt = Math.max(group.lastAt, at);
    byChannel.set(event.channel, group);
  }
  const groups = [...byChannel.values()].filter((group) => group.last.size >= 2).sort((a, b) => b.lastAt - a.lastAt || a.channel.localeCompare(b.channel));
  const taken = new Set();
  const result = [];
  for (const group of groups) {
    const authors = [...group.last.keys()].filter((author) => !taken.has(author)).sort();
    if (authors.length < 2) continue;
    authors.forEach((author) => taken.add(author));
    result.push({ channel: group.channel, authors, lastAt: group.lastAt });
  }
  return result;
}

export function assignSeats(order, needOf = () => 0) {
  const seats = new Map();
  const free = new Set(SPOTS.desks);
  const overflow = [];
  const byNeed = order.map((author, i) => [author, i]).sort((a, b) => needOf(a[0]) - needOf(b[0]) || a[1] - b[1]).map(([author]) => author);
  for (const author of byNeed) {
    const start = hashName(author) % SPOTS.desks.length;
    const desk = SPOTS.desks.map((_, i) => SPOTS.desks[(start + i) % SPOTS.desks.length]).find((d) => free.has(d));
    if (desk) { free.delete(desk); seats.set(author, desk); } else overflow.push(author);
  }
  overflow.map((author, i) => [author, i]).sort((a, b) => needOf(a[0]) - needOf(b[0]) || a[1] - b[1])
    .forEach(([author], i) => seats.set(author, SPOTS.extras[i] ?? null));
  return seats;
}

const ACTIVITY = { working: 'typing', reviewing: 'reading', discussing: 'talking', idle: 'coffee', away: 'sleep' };
const poseFor = (spot, activity) => (Object.hasOwn(SEATS, spot) && activity !== 'posting' ? 'sit' : 'stand');

export function sceneFor({ agents, order, events = [], lastNoteAt = new Map(), now, awayAfterMs, seats: fixedSeats = null, stay = false }) {
  const states = new Map(agents.map((agent) => [agent.author, effectiveState(agent, now, awayAfterMs)]));
  const listed = order.filter((author) => states.has(author));
  const seats = fixedSeats ?? assignSeats(deskOwners(agents, listed, now), (author) => DESK_NEED[states.get(author)] ?? 2);
  const present = (author) => states.has(author) && states.get(author) !== 'away' && seats.get(author);
  const groups = stay ? [] : groupMeetings(events, now).map((group) => ({ ...group, authors: group.authors.filter((author) => present(author) && states.get(author) === 'discussing') }))
    .filter((group) => group.authors.length >= 2);
  const meetingSeat = new Map();
  const boardQueue = [...SPOTS.board];
  let seatIndex = 0;
  for (const group of groups) {
    for (const author of group.authors) {
      if (seatIndex < SPOTS.meeting.length) meetingSeat.set(author, { spot: SPOTS.meeting[seatIndex++], group: group.channel });
      else if (boardQueue.length) meetingSeat.set(author, { spot: boardQueue.shift(), group: group.channel });
    }
  }
  const restTaken = new Set();
  return agents.map((agent) => {
    const item = place(agent);
    return { ...item, pose: item.spot ? poseFor(item.spot, item.activity) : null };
  });
  function place(agent) {
    const state = states.get(agent.author);
    const base = { author: agent.author, kind: agent.kind ?? 'other', state, feature: agent.feature ?? null, group: null };
    const seat = seats.get(agent.author);
    if (!seat) return { ...base, spot: null, activity: null, seated: false };
    if (state === 'away') return SPOTS.desks.includes(seat) ? { ...base, spot: seat, activity: 'sleep', seated: true } : { ...base, spot: null, activity: null, seated: true };
    const noteAt = lastNoteAt.get(agent.author);
    if (!stay && noteAt && now - Date.parse(noteAt) < BOARD_VISIT_MS && boardQueue.length) {
      return { ...base, spot: boardQueue.shift(), activity: 'posting', seated: true };
    }
    if (meetingSeat.has(agent.author)) {
      const { spot, group } = meetingSeat.get(agent.author);
      return { ...base, spot, activity: 'talking', seated: true, group };
    }
    if (state === 'idle') {
      const spot = restSpot(agent.author, now, restTaken);
      if (spot) { restTaken.add(spot); return { ...base, spot, activity: 'coffee', seated: true }; }
    }
    if (!Object.hasOwn(SEATS, seat)) {
      const sofa = SPOTS.rest.find((spot) => Object.hasOwn(SEATS, spot) && !restTaken.has(spot));
      if (sofa) { restTaken.add(sofa); return { ...base, spot: sofa, activity: ACTIVITY[state] ?? 'idle', seated: true }; }
    }
    return { ...base, spot: seat, activity: ACTIVITY[state] ?? 'idle', seated: true };
  }
}

export const VISIT_MS = 2 * 60 * 1000;

export function officeScene({ agents, order, events = [], lastNoteAt = new Map(), now, awayAfterMs, pm = null, lab = null, roof = null, studio = null, features = [], stay = false }) {
  const states = new Map(agents.map((agent) => [agent.author, effectiveState(agent, now, awayAfterMs)]));
  const present = (author) => states.has(author) && states.get(author) !== 'away';
  const placed = new Map();
  const meetingSpots = [...ROOMS.meeting.SPOTS.meeting];
  const groups = stay ? [] : groupMeetings(events, now).map((group) => ({ ...group, authors: group.authors.filter((author) => present(author) && states.get(author) === 'discussing' && author !== pm) }))
    .filter((group) => group.authors.length >= 2);
  for (const group of groups) {
    for (const author of group.authors) {
      const spot = meetingSpots.shift();
      if (spot) placed.set(author, { room: 'meeting', spot, activity: 'talking', group: group.channel });
    }
  }
  const boss = ROOMS.boss.SPOTS;
  const kindOf = new Map(agents.map((agent) => [agent.author, agent.kind]));
  const ceo = order.find((author) => kindOf.get(author) === 'human' && states.has(author)) ?? null;
  if (ceo) {
    const state = states.get(ceo);
    placed.set(ceo, state === 'away' ? { room: 'boss', spot: null, activity: null, ceo: true }
      : { room: 'boss', spot: boss.desk, activity: state === 'idle' ? 'coffee' : ACTIVITY[state] ?? 'typing', ceo: true });
  }
  if (pm && pm !== ceo && states.has(pm)) {
    const state = states.get(pm);
    placed.set(pm, state === 'away' ? { room: 'boss', spot: boss.pmDesk, activity: 'sleep' }
      : state === 'idle' ? { room: 'boss', spot: boss.rest[0], activity: 'coffee' }
      : { room: 'boss', spot: boss.pmDesk, activity: ACTIVITY[state] ?? 'typing' });
  }
  const bosses = [pm, ceo].filter((author) => author && states.has(author));
  if (bosses.length && !stay) {
    const visitSpots = [...boss.visit];
    const reported = (author, to) => events.some((event) => event.author === author && to.some((name) => event.to?.includes(name)) && now - Date.parse(event.at) < VISIT_MS && Date.parse(event.at) <= now + 1000);
    if (pm && ceo && pm !== ceo && present(pm) && reported(pm, [ceo])) placed.set(pm, { room: 'boss', spot: visitSpots.shift(), activity: 'talking' });
    for (const author of order) {
      if (placed.has(author) || !present(author)) continue;
      const spot = reported(author, bosses) && visitSpots.shift();
      if (spot) placed.set(author, { room: 'boss', spot, activity: 'talking' });
    }
  }
  const studioSpots = studio ? [...studio.SPOTS.design] : [];
  if (studio && !stay) {
    const featureById = new Map(features.map(feature => [feature.id, feature]));
    for (const agent of agents) {
      if (placed.has(agent.author) || !['working', 'discussing'].includes(states.get(agent.author)) || featureById.get(agent.feature)?.phase !== 'design') continue;
      const spot = studioSpots.shift();
      if (spot) placed.set(agent.author, { room: 'studio', spot, activity: 'reading' });
    }
  }
  const labSpots = lab ? [...lab.SPOTS.bench, ...lab.SPOTS.monitor] : [];
  const roofSpots = roof ? [...roof.SPOTS.rest] : [];
  if (lab && !stay) {
    for (const author of order) {
      if (placed.has(author) || states.get(author) !== 'reviewing' || author === pm) continue;
      const spot = labSpots.shift();
      if (!spot) break;
      placed.set(author, { room: 'lab', spot, activity: 'reading' });
    }
  }
  if (roof) {
    for (const author of order) {
      if (placed.has(author) || states.get(author) !== 'idle' || author === pm) continue;
      const spot = roofSpots.shift();
      if (!spot) break;
      placed.set(author, { room: 'roof', spot, activity: 'chat' });
    }
  }
  const elsewhere = [pm, ceo, ...placed.keys()];
  const seats = assignSeats(deskOwners(agents, order, now, elsewhere), (author) => DESK_NEED[states.get(author)] ?? 2);
  const devScene = sceneFor({
    agents: agents.filter((agent) => !placed.has(agent.author)), order: order.filter((author) => !placed.has(author)),
    events: events.filter((event) => !placed.has(event.author)), lastNoteAt, now, awayAfterMs, seats, stay,
  });
  const byAuthor = new Map(devScene.map((item) => [item.author, { ...item, room: 'dev' }]));
  for (const agent of agents) {
    const place = placed.get(agent.author);
    if (!place) continue;
    const room = place.room === 'studio' ? studio : place.room === 'lab' ? lab : place.room === 'roof' ? roof : ROOMS[place.room];
    byAuthor.set(agent.author, {
      author: agent.author, kind: agent.kind ?? 'other', state: states.get(agent.author), feature: agent.feature ?? null,
      group: place.group ?? null, room: place.room, spot: place.spot, activity: place.activity, seated: true,
      pose: place.spot && Object.hasOwn(room.SEATS, place.spot) ? 'sit' : 'stand', ...(place.ceo ? { ceo: true } : {}),
    });
  }
  const room = (id) => (id === 'lab' ? lab : id === 'roof' ? roof : ROOMS[id]);
  const meetingSeats = meetingSpots.filter((spot) => Object.hasOwn(ROOMS.meeting.SEATS, spot)), meetingStand = meetingSpots.filter((spot) => !Object.hasOwn(ROOMS.meeting.SEATS, spot));
  const pools = { meeting: meetingSeats.concat(meetingStand), lab: labSpots, roof: roofSpots };
  const PREFER = { idle: ['roof', 'meeting', 'lab'], reviewing: ['lab', 'meeting', 'roof'] };
  for (const agent of agents) {
    const item = byAuthor.get(agent.author), state = states.get(agent.author);
    if (!item || item.spot || state === 'away' || item.ceo) continue;
    const to = (PREFER[state] ?? ['meeting', 'lab', 'roof']).find((id) => pools[id].length);
    if (!to) continue;
    const spot = pools[to].shift();
    const activity = to === 'roof' ? 'chat' : state === 'idle' ? 'coffee' : ACTIVITY[state] ?? 'typing';
    byAuthor.set(agent.author, { ...item, room: to, spot, activity, seated: true, pose: Object.hasOwn(room(to).SEATS, spot) ? 'sit' : 'stand' });
  }
  return agents.filter((agent) => byAuthor.has(agent.author))
    .map((agent) => ({ ...byAuthor.get(agent.author), quiet: isQuiet(agent, now, awayAfterMs) }));
}

export function roomCounts(scene) {
  const counts = Object.fromEntries(Object.keys(ROOMS).map((id) => [id, 0]));
  for (const item of scene) if (item.spot) counts[item.room ?? 'dev'] = (counts[item.room ?? 'dev'] ?? 0) + 1;
  return counts;
}

export const REST_SWAP_MS = 45_000;
export function restSpot(author, now, taken = new Set()) {
  const spots = SPOTS.rest;
  const start = (hashName(author) + Math.floor(now / REST_SWAP_MS)) % spots.length;
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[(start + i) % spots.length];
    if (!taken.has(spot)) return spot;
  }
  return null;
}

export const scaleFor = (width) => Math.min(1, width / SIZE.width);

export function personaFor(author, personas, taken = null, prefer = null) {
  if (!personas?.length) return null;
  const start = hashName(author) % personas.length;
  const ring = personas.map((_, i) => personas[(start + i) % personas.length]);
  const free = (pick) => !taken?.has(pick);
  return (prefer && ring.find((pick) => prefer(pick) && free(pick))) ?? ring.find(free) ?? personas[start];
}

export function lookFor(character, kind, variants = {}) {
  if (!character?.recolor) return null;
  const jacket = Object.hasOwn(variants, kind) ? variants[kind] : variants.other;
  return jacket ? { jacket } : null;
}

export function pickPersona(author, kind, personas, characters, used = new Map()) {
  const pick = personaFor(author, personas, new Set(used.keys()), prefersPersona(kind, characters));
  if (kind === 'claude' || !pick || characters?.[pick]?.recolor) return pick;
  const recolor = personas.filter((id) => characters?.[id]?.recolor);
  if (!recolor.length) return pick;
  const start = hashName(author) % recolor.length;
  const ring = recolor.map((_, i) => recolor[(start + i) % recolor.length]);
  const kinds = (id) => used.get(id) ?? [];
  return ring.find((id) => !kinds(id).includes(kind) && kinds(id).length < 2) ?? ring.reduce((a, b) => (kinds(b).length < kinds(a).length ? b : a));
}

export const prefersPersona = (kind, characters) => (id) => Boolean(characters?.[id]?.recolor) === (kind !== 'claude');

function hashName(name) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash;
}

export function summaryLabel(scene) {
  const visible = scene.filter((actor) => actor.spot);
  if (!scene.length) return t('office.model.virtualOfficeNoAgents');
  const counts = {};
  for (const actor of scene) counts[actor.state] = (counts[actor.state] ?? 0) + 1;
  const parts = Object.entries(counts).map(([state, count]) => `${STATE_LABELS[state] ?? state} ${count}`);
  return t('office.model.virtualOfficeAgentsIn', scene.length, visible.length, parts.join(', '));
}

export function stackDown(items, gap = 2, limit = Infinity) {
  const order = items.map((item, i) => [item, i]).sort(([a], [b]) => a.top - b.top || a.x - b.x);
  const placed = [], tops = new Array(items.length);
  for (const [item, i] of order) {
    let top = item.top;
    for (let moved = true; moved;) {
      moved = false;
      for (const box of placed) {
        const overlapX = Math.abs(item.x - box.x) < (item.width + box.width) / 2 + gap;
        const overlapY = top < box.top + box.height + gap && top + item.height > box.top - gap;
        if (overlapX && overlapY) { top = box.top + box.height + gap; moved = true; }
      }
    }
    if (top + item.height > limit) {
      top = item.top;
      for (let moved = true; moved;) {
        moved = false;
        for (const box of placed) {
          const overlapX = Math.abs(item.x - box.x) < (item.width + box.width) / 2 + gap;
          const overlapY = top < box.top + box.height + gap && top + item.height > box.top - gap;
          if (overlapX && overlapY) { top = box.top - item.height - gap; moved = true; }
        }
      }
    }
    placed.push({ x: item.x, top, width: item.width, height: item.height });
    tops[i] = top;
  }
  return tops;
}
