import { CHATTER_MS, CHATTER_PER_ROOM, EMOTE_MS, EMOTE_PER_FLOOR, NPCS, NPC_MS, REPLY_DELAY_MS, canChatter, chatterAllowed, chatterGap, emoteGap, npcGap, npcLine, pickChatter, pickEmote, pickReaction } from './chatter.mjs';
import { npcContext } from './scene-state.mjs';
import { strollNodes } from './behavior.mjs';
import { planStroll, strollGap } from './stroll.mjs';
import { SIDE_ROOMS, SIDE_ROOM_ORDER } from './side-rooms.mjs';

export const floorOfActor = (actor) => (actor.npc ? NPCS.find((item) => item.id === actor.npc)?.room : actor.item?.room) ?? 'dev';
export const sameFloor = (a, b) => floorOfActor(a) === floorOfActor(b);
const homeFloor = (actor) => String(actor.home ?? actor.target ?? '').split(':')[0];

export function createAmbient({ actors, state, showBubble, requestFrame, walkTo, chatterOn, listView = () => false, stayPut = false, debug = false, doc = document, later = setTimeout, rooms = SIDE_ROOMS, order = SIDE_ROOM_ORDER }) {
  const visible = () => [...actors.values()].filter((actor) => actor.visible && actor.room === 'building');
  const ownEvents = (actor) => state.events.filter((event) => event.author === actor.author);

  function chatterTick() {
    if (!chatterOn() || doc.hidden || listView()) return;
    const now = Date.now();
    const talking = (actor) => (state.bubbles.get(actor.author)?.until ?? 0) > now;
    const here = visible();
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

  function npcSpeak(npc, here, now, talking) {
    const context = { ...npcContext(state, now), turn: npc.turn = (npc.turn ?? -1) + 1 };
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
    later(() => {
      if (!chatterOn() || talking(responder) || !responder.visible) return;
      showBubble(responder.author, pickReaction(topic), 'chatter', CHATTER_MS);
      requestFrame();
    }, REPLY_DELAY_MS);
  }


  const strollNext = new Map();

  function strollTick() {
    if (stayPut) return;
    const now = Date.now();
    const talking = (actor) => (state.bubbles.get(actor.author)?.until ?? 0) > Date.now();
    const here = visible().filter((actor) => !actor.leaving);
    for (const actor of here) {
      const stroll = actor.stroll;
      if (!stroll || actor.route) continue;
      if (!stroll.until) { stroll.until = now + stroll.ms; groupTalk(stroll.group, here, talking); continue; }
      if (now >= stroll.until && !talking(actor) && !stroll.returning) { actor.stroll.returning = true; actor.strollAgain = now + 25_000; walkTo(actor, actor.home, false); requestFrame(); }
    }
    if (!chatterOn() || doc.hidden || listView() || !state.config) return;
    for (const floor of order) {
      if (!strollNext.has(floor)) strollNext.set(floor, now + 3000 + Math.floor(Math.random() * 9000));
      if (now < strollNext.get(floor)) continue;
      strollNext.set(floor, now + strollGap());
      const people = here.filter((actor) => homeFloor(actor) === floor);
      if (people.some((actor) => actor.stroll)) continue;
      const room = rooms[floor];
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
    if (!chatterOn()) return;
    const speakers = members.filter((actor) => actor.npc || (actor.kind !== 'human' && chatterAllowed(ownEvents(actor), Date.now(), actor.author)));
    speakers.forEach((actor, i) => later(() => {
      if (!chatterOn() || !actor.visible || actor.stroll?.group !== group || talking(actor)) return;
      if (actor.npc) {
        npcSpeak(actor, visible(), Date.now(), talking);
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

  return { chatterTick, strollTick };
}
