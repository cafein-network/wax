import { ROOMS } from './rooms.mjs';

export const WALK_SPEED = 220;
export const STEP_MS = 260;
export const ZZ_MS = 2400;

const DEV = ROOMS.dev;
const graphs = new WeakMap();
function graphOf(room) {
  if (!graphs.has(room)) {
    const graph = new Map(Object.keys(room.NODES).map((name) => [name, []]));
    for (const [a, b] of room.EDGES) { graph.get(a).push(b); graph.get(b).push(a); }
    graphs.set(room, graph);
  }
  return graphs.get(room);
}

export const point = (name, room = DEV) => ({ x: room.NODES[name][0], y: room.NODES[name][1] });

export function findPath(from, to, room = DEV) {
  if (from === to) return [to];
  const graph = graphOf(room);
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const node = queue.shift();
    for (const next of graph.get(node) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, node);
      if (next === to) {
        const path = [to];
        for (let at = node; at !== null; at = previous.get(at)) path.unshift(at);
        return path;
      }
      queue.push(next);
    }
  }
  return [to];
}

export function nearestNode(x, y, room = DEV) {
  let best = null, bestDistance = Infinity;
  for (const [name, [nx, ny]] of Object.entries(room.NODES)) {
    const distance = Math.hypot(nx - x, ny - y);
    if (distance < bestDistance) { best = name; bestDistance = distance; }
  }
  return best;
}

export function routeTo(x, y, target, room = DEV) {
  const start = nearestNode(x, y, room);
  const nodes = findPath(start, target, room);
  const points = [{ x, y }, ...nodes.map((name) => point(name, room))];
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
}

export const routeLength = (points) => points.reduce((sum, p, i) => i ? sum + Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) : 0, 0);

export function positionAt(points, distance) {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= segment) {
      const t = segment ? left / segment : 1;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: b.x - a.x, dy: b.y - a.y, done: false };
    }
    left -= segment;
  }
  const last = points.at(-1), prev = points.at(-2) ?? last;
  return { x: last.x, y: last.y, dx: last.x - prev.x, done: true };
}

export const SIP_MS = 4000;
export const SIT_MS = 300;

export function sipAt(t) {
  const p = ((t % SIP_MS) + SIP_MS) % SIP_MS;
  if (p < 2400) return 0;
  if (p < 2800) return (p - 2400) / 400;
  if (p < 3600) return 1;
  return 1 - (p - 3600) / 400;
}

export function poseAt({ walking, activity, t, reduced = false }) {
  if (reduced) return { dy: 0, tilt: 0, leg: 0, shadow: 1, ...(activity === 'coffee' && !walking ? { sip: 0, steam: 0 } : {}), ...(activity === 'sleep' && !walking ? { zz: null } : {}) };
  if (activity === 'coffee' && !walking) {
    return { dy: Math.round(Math.sin(t / 1000 * Math.PI)), tilt: 0, leg: 0, shadow: 1, sip: sipAt(t), steam: Math.floor(t / 300) % 3 };
  }
  if (walking) {
    const phase = (t % STEP_MS) / STEP_MS;
    const step = Math.floor(t / STEP_MS) % 2;
    const lift = Math.sin(phase * Math.PI);
    const stride = Math.sin(((t % (2 * STEP_MS)) / (2 * STEP_MS)) * Math.PI * 2);
    return { dy: -Math.round(lift * 3), tilt: (step ? 1 : -1) * 0.035 * lift, leg: step ? 2 : -2, stride, shadow: 1 - lift * 0.15 };
  }
  switch (activity) {
    case 'typing': return { dy: Math.floor(t / 125) % 2 ? -1 : 0, tilt: 0, leg: 0, shadow: 1 };
    case 'talking': return { dy: Math.floor(t / 400) % 3 === 0 ? -2 : 0, tilt: 0, leg: 0, shadow: 1 };
    case 'posting': return { dy: Math.floor(t / 300) % 2 ? -2 : 0, tilt: 0.02, leg: 0, shadow: 1 };
    case 'sleep': return { dy: Math.round(Math.sin(t / 2000 * Math.PI)), tilt: 0, leg: 0, shadow: 1, zz: (t % ZZ_MS) / ZZ_MS };
    default: return { dy: Math.round(Math.sin(t / 1000 * Math.PI) * 1), tilt: 0, leg: 0, shadow: 1 };
  }
}