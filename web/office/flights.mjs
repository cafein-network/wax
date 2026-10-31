import { BUILDING } from './side-rooms.mjs';
import { actorBox } from './side-render.mjs';
import { nearestNode, routeLength, routeTo } from './animate.mjs';
import { LAND_MS, NOTE_GAP, NOTE_LIFT, NOTE_TRAIL, deliveryTargets, noteRoute, noteSpeed } from './notes.mjs';

export const OUTFIT_COLORS = { claude: '#d9774b', codex: '#4a515c', gemini: '#2f63b8', antigravity: '#a8364e', copilot: '#7b55b8', grok: '#2a8580', human: '#8c96a3', other: '#6b7a3a' };
export const MAX_FLIGHTS = 24;

export function chestOf(actor, assets) {
  const sprite = assets && (assets.characters[actor.drawn.persona] ?? assets.characters[assets.personas[0]]);
  const box = actorBox(actor.drawn, sprite ?? undefined);
  return { x: actor.drawn.x, y: box.top + (box.bottom - box.top) * 0.4 };
}

export function createFlights({ actors, state, requestFrame, rate = () => 1, building = BUILDING, later = setTimeout }) {
  const flights = [];
  const officeActor = (author) => [...actors.values()].find((actor) => actor.author === author && !actor.npc && actor.visible && !actor.leaving && actor.drawn);
  function launch(author, { to = null, board = false } = {}) {
    const from = officeActor(author);
    if (!from || flights.length >= MAX_FLIGHTS) return false;
    let node, end;
    if (board) {
      const hit = building.WHITEBOARD_HIT;
      if (!hit) return false;
      node = 'dev:b0'; end = { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 };
    } else {
      const target = officeActor(to);
      if (!target || target === from) return false;
      node = nearestNode(target.x, target.y, building); end = chestOf(target, state.assets);
    }
    const points = [chestOf(from, state.assets), ...noteRoute(routeTo(from.x, from.y, node, building), end, NOTE_LIFT)];
    const length = routeLength(points);
    flights.push({ points, length, speed: noteSpeed(length), dist: 0, tone: OUTFIT_COLORS[from.kind] ?? OUTFIT_COLORS.other, landedAt: null });
    requestFrame();
    return true;
  }
  return {
    flights,
    launch,
    deliverMessage(channel, message, events = state.events) {
      for (const name of deliveryTargets({ ...message, channel }, events, Date.now())) launch(message.author, { to: name });
    },
    deliverNote: (author) => later(() => launch(author, { board: true }), 350),
    move(dt, time) {
      for (let i = flights.length - 1; i >= 0; i--) {
        const flight = flights[i];
        flight.dist += flight.speed * dt * rate();
        if (flight.landedAt == null && flight.dist >= flight.length) flight.landedAt = time;
        if (flight.dist >= flight.length + (NOTE_TRAIL - 1) * NOTE_GAP && time - flight.landedAt >= LAND_MS) flights.splice(i, 1);
      }
      return flights.length > 0;
    },
  };
}
