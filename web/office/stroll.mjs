
export const STROLL_MIN_GAP_MS = 9000;
export const STROLL_MAX_GAP_MS = 22_000;
const WANDER_MS = [6000, 11_000];
const STRETCH_MS = [4000, 7000];
const GATHER_MS = [13_000, 19_000];
const GATHER_CHANCE = 0.5;
const STRETCH_CHANCE = 0.35;
const PAIR_GAP = [45, 140];

const WEIGHT = { coffee: 3, chat: 3, npc: 3, idle: 2, typing: 0.5, reading: 0.5 };
const SOCIAL = new Set(['coffee', 'chat', 'npc', 'idle']);

export const strollGap = (random = Math.random()) => STROLL_MIN_GAP_MS + Math.floor(random * (STROLL_MAX_GAP_MS - STROLL_MIN_GAP_MS));
const span = ([min, max], random) => min + Math.floor(random() * (max - min));

export const strollWeight = (actor) => (actor.quiet ? 0 : WEIGHT[actor.npc ? 'npc' : actor.activity] ?? 0);

export function planStroll({ actors, nodes, random = Math.random }) {
  const able = actors.filter((actor) => strollWeight(actor) > 0);
  if (!able.length || !nodes.length) return null;
  const social = able.filter((actor) => SOCIAL.has(actor.npc ? 'npc' : actor.activity));
  if (social.length >= 2 && random() < GATHER_CHANCE) {
    const plan = gather(social, nodes, random);
    if (plan) return plan;
  }
  const actor = weighted(able, random);
  const near = nodes.filter((node) => Math.abs(node.x - actor.x) <= 420 && Math.abs(node.x - actor.x) >= 30);
  const pool = near.length ? near : nodes;
  const node = pool[Math.floor(random() * pool.length) % pool.length];
  const stretch = !SOCIAL.has(actor.npc ? 'npc' : actor.activity);
  if (stretch && random() >= STRETCH_CHANCE) return null;
  return { kind: 'wander', moves: [{ author: actor.author, spot: node.name, facing: null, ms: span(stretch ? STRETCH_MS : WANDER_MS, random) }] };
}

function weighted(list, random) {
  const total = list.reduce((sum, actor) => sum + strollWeight(actor), 0);
  let pick = random() * total;
  for (const actor of list) { pick -= strollWeight(actor); if (pick < 0) return actor; }
  return list.at(-1);
}

function gather(social, nodes, random) {
  const first = weighted(social, random);
  const others = social.filter((actor) => actor !== first).sort((a, b) => Math.abs(a.x - first.x) - Math.abs(b.x - first.x));
  const size = others.length >= 2 && random() < 0.35 ? 3 : 2;
  const group = [first, ...others.slice(0, size - 1)];
  const middle = group.reduce((sum, actor) => sum + actor.x, 0) / group.length;
  const sorted = [...nodes].sort((a, b) => Math.abs(a.x - middle) - Math.abs(b.x - middle));
  for (const anchor of sorted) {
    const spots = [anchor];
    for (const node of sorted) {
      if (spots.length === group.length) break;
      if (spots.includes(node)) continue;
      const gaps = spots.map((spot) => Math.abs(spot.x - node.x));
      if (gaps.every((gap) => gap >= PAIR_GAP[0]) && Math.max(...spots.map((spot) => spot.x), node.x) - Math.min(...spots.map((spot) => spot.x), node.x) <= PAIR_GAP[1] * (group.length - 1)) spots.push(node);
    }
    if (spots.length < group.length) continue;
    spots.sort((a, b) => a.x - b.x);
    const center = spots.reduce((sum, spot) => sum + spot.x, 0) / spots.length;
    const people = [...group].sort((a, b) => a.x - b.x);
    const ms = span(GATHER_MS, random);
    return { kind: 'gather', moves: people.map((actor, i) => ({ author: actor.author, spot: spots[i].name, facing: spots[i].x <= center ? 'right' : 'left', ms })) };
  }
  return null;
}
