import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGES, NODES, SEATS, SPOTS } from '../web/office/layout.mjs';
import { QUIET_AFTER_MS, REST_SWAP_MS, assignSeats, groupMeetings, isQuiet, officeScene, restSpot, sceneFor, scaleFor, summaryLabel } from '../web/office/model.mjs';
import { ZZ_MS, findPath, poseAt, positionAt, routeLength, routeTo, point, sipAt } from '../web/office/animate.mjs';

const NOW = Date.parse('2026-10-13T07:00:00Z');
const AWAY = 10 * 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const agent = (author, state, msAgo = 0, kind = 'claude') => ({ author, kind, state, lastActive: iso(msAgo), feature: 'chatbot' });

test('상태별 지점과 연출 (AC11)', () => {
  const agents = [agent('a', 'working'), agent('b', 'reviewing'), agent('c', 'idle'), agent('d', 'working', AWAY + 1)];
  const scene = sceneFor({ agents, order: ['a', 'b', 'c', 'd'], now: NOW, awayAfterMs: AWAY });
  const by = Object.fromEntries(scene.map((s) => [s.author, s]));
  assert.ok(SPOTS.desks.includes(by.a.spot) && SPOTS.desks.includes(by.b.spot) && by.a.spot !== by.b.spot, '일하는 사람은 빈 자유석에 앉는다');
  assert.deepEqual([by.a.activity, by.a.pose, by.b.activity, by.b.pose], ['typing', 'sit', 'reading', 'sit']);
  assert.ok(SPOTS.rest.includes(by.c.spot));
  assert.deepEqual([by.c.activity, by.c.pose], ['coffee', by.c.spot === 'coffee' ? 'stand' : 'sit']);
  assert.equal(by.d.state, 'away');
  if (by.d.spot) assert.ok(SPOTS.desks.includes(by.d.spot) && by.d.activity === 'sleep');
});

test('커피: 소파에 앉아 마시거나 커피 머신 앞에서 서서 마시고, 시간에 따라 바뀌며 자리가 겹치지 않는다', () => {
  const seen = new Set();
  for (let k = 0; k < SPOTS.rest.length; k++) seen.add(restSpot('codex-docs', NOW + k * REST_SWAP_MS));
  assert.deepEqual([...seen].sort(), [...SPOTS.rest].sort());
  const taken = new Set(SPOTS.rest.slice(0, 2));
  assert.equal(restSpot('x', NOW, taken), SPOTS.rest[2]);
  assert.equal(restSpot('x', NOW, new Set(SPOTS.rest)), null);
  const scene = sceneFor({ agents: ['a', 'b', 'c', 'd'].map((n) => agent(n, 'idle')), order: ['a', 'b', 'c', 'd'], now: NOW, awayAfterMs: AWAY });
  const rest = scene.map((s) => s.spot).filter((spot) => SPOTS.rest.includes(spot));
  assert.deepEqual([rest.length, new Set(rest).size], [3, 3]);
});

test('자리 비움: 책상 주인은 책상에 엎드려 잔다', async () => {
  const scene = sceneFor({ agents: [agent('a', 'working', AWAY + 1)], order: ['a'], now: NOW, awayAfterMs: AWAY });
  assert.deepEqual([scene[0].state, scene[0].spot, scene[0].activity, scene[0].pose], ['away', assignSeats(['a']).get('a'), 'sleep', 'sit']);
});

test('최근 보드 노트를 쓴 에이전트는 화이트보드 앞에 선다 (AC17)', () => {
  const agents = [agent('a', 'working'), agent('b', 'working')];
  const lastNoteAt = new Map([['a', iso(3000)], ['b', iso(9000)]]);
  const scene = sceneFor({ agents, order: ['a', 'b'], lastNoteAt, now: NOW, awayAfterMs: AWAY });
  assert.deepEqual([scene[0].spot, scene[0].activity, scene[0].pose], ['b0', 'posting', 'stand']);
  assert.equal(scene[1].pose, 'sit');
  assert.equal(scene[1].spot, assignSeats(['a', 'b']).get('b'), '8초가 지나면 자기 자리로 돌아간다');
});

test('회의 그룹: 5분 안에 같은 채널 2명 이상, 한 사람은 최근 그룹 하나 (AC12)', () => {
  const events = [
    { channel: 'x', author: 'a', at: iso(60_000) }, { channel: 'x', author: 'b', at: iso(30_000) },
    { channel: 'y', author: 'b', at: iso(10_000) }, { channel: 'y', author: 'c', at: iso(5_000) },
    { channel: 'z', author: 'd', at: iso(1000) }, { channel: 'old', author: 'e', at: iso(5 * 60_000 + 1) }, { channel: 'old', author: 'f', at: iso(1000) },
  ];
  assert.deepEqual(groupMeetings(events, NOW).map((g) => [g.channel, g.authors]), [['y', ['b', 'c']]]);
  const agents = ['a', 'b', 'c'].map((name) => agent(name, 'discussing'));
  const scene = sceneFor({ agents, order: ['a', 'b', 'c'], events, now: NOW, awayAfterMs: AWAY });
  const by = Object.fromEntries(scene.map((s) => [s.author, s]));
  assert.ok(SPOTS.meeting.includes(by.b.spot) && SPOTS.meeting.includes(by.c.spot));
  assert.equal(by.b.group, 'y');
  assert.equal(by.a.spot, assignSeats(['a', 'b', 'c']).get('a'), '그룹이 없으면 자기 책상');
  assert.equal(by.a.activity, 'talking');
});

test('좌석: 자유석 5 → 보조 자리 7(빈 소파가 있으면 소파에 앉음) → 13번째부터 목록 전용', () => {
  const order = Array.from({ length: 13 }, (_, i) => `a${i}`);
  const seats = assignSeats(order);
  assert.deepEqual(order.slice(0, 5).map((name) => seats.get(name)).sort(), ['d0', 'd1', 'd2', 'd3', 'd4'], '먼저 온 다섯 명이 자유석 하나씩');
  assert.deepEqual(order.slice(5).map((name) => seats.get(name)), ['mid', 'q', 'rug', 's2', 'nook', 'lounge', 'front', null]);
  const scene = sceneFor({ agents: order.map((name) => agent(name, 'working')), order, now: NOW, awayAfterMs: AWAY });
  assert.deepEqual([scene[12].spot, scene[12].seated], [null, false]);
  assert.equal(scene.filter((actor) => actor.pose === 'sit').length, 7, '자유석 5에 더해 빈 소파 두 개에도 앉는다');
  assert.deepEqual(scene.filter((actor) => actor.spot?.startsWith('sofa')).map((actor) => actor.author), ['a5', 'a6'], '자리를 못 받은 여섯째·일곱째가 소파에 앉는다');
  assert.match(summaryLabel(scene), /에이전트 13명\(사무실 12명\)/);
});

test('경유점 그래프는 모두 이어져 있고 경로를 따라 걷는다 (AC11)', () => {
  for (const [a, b] of EDGES) assert.ok(NODES[a] && NODES[b], `${a}-${b}`);
  for (const name of Object.keys(NODES)) {
    const path = findPath('door', name);
    assert.equal(path.at(-1), name);
    if (name !== 'door') assert.equal(path[0], 'door', `${name}까지 이어져야 함`);
  }
  const route = routeTo(...Object.values(point('d0')), 'sofa1');
  assert.deepEqual(route[0], point('d0'));
  assert.deepEqual(route.at(-1), point('sofa1'));
  const length = routeLength(route);
  const half = positionAt(route, length / 2);
  assert.equal(half.done, false);
  assert.deepEqual(positionAt(route, length + 1), { ...point('sofa1'), dx: route.at(-1).x - route.at(-2).x, done: true });
});

test('걷기·제자리 연출과 동작 줄이기 (AC11, AC13)', () => {
  const steps = [0, 130, 260, 390].map((t) => poseAt({ walking: true, t }));
  assert.ok(steps.some((pose) => pose.dy < 0), '걸을 때 튄다');
  assert.notEqual(steps[0].leg, steps[2].leg, '걸음마다 다리가 엇갈린다');
  assert.deepEqual(poseAt({ walking: true, t: 130, reduced: true }), { dy: 0, tilt: 0, leg: 0, shadow: 1 });
  assert.notDeepEqual([0, 125].map((t) => poseAt({ walking: false, activity: 'typing', t }).dy), [0, 0]);
});

test('화면 배율: 360px에서 약 0.25배, 넓으면 1배 (AC13)', () => {
  assert.ok(Math.abs(scaleFor(360) - 360 / 1424) < 1e-9);
  assert.equal(scaleFor(2000), 1);
});

test('쉬는 에이전트는 소파 2자리에 앉고 세 번째는 커피 머신 앞에 서서 커피를 마신다', () => {
  const agents = ['a', 'b', 'c'].map((name) => agent(name, 'idle'));
  const scene = sceneFor({ agents, order: ['a', 'b', 'c'], now: NOW, awayAfterMs: AWAY });
  assert.deepEqual(scene.map((s) => [s.spot, s.activity, s.pose]), [['sofa0', 'coffee', 'sit'], ['sofa1', 'coffee', 'sit'], ['coffee', 'coffee', 'stand']]);
});

test('앉는 자리는 모두 바닥 지점과 연결되고, 자유석이 차면 소파, 그다음 서서 일한다', () => {
  for (const [spot, seat] of Object.entries(SEATS)) {
    assert.ok(NODES[spot], spot);
    assert.ok(Math.hypot(seat.x - NODES[spot][0], seat.y - NODES[spot][1]) < 80, `${spot} 의자가 바닥 지점 근처`);
  }
  for (const desk of SPOTS.desks) assert.ok(SEATS[desk], desk);
  const names = (n) => Array.from({ length: n }, (_, i) => `a${i}`);
  const run = (n) => sceneFor({ agents: names(n).map((name) => agent(name, 'working')), order: names(n), now: NOW, awayAfterMs: AWAY });
  assert.ok(run(5).every((item) => SPOTS.desks.includes(item.spot) && item.pose === 'sit'), '다섯 명까지는 자유석에 앉아 일한다');
  const six = run(6);
  assert.deepEqual([six[5].spot, six[5].pose, six[5].activity], ['sofa0', 'sit', 'typing'], '여섯째는 빈 소파에 앉아 일한다');
  assert.equal(run(8)[7].pose, 'stand', '소파까지 차면 보조 자리에서 서서 일한다');
});

test('커피 마시기: 4초 주기로 들고 있다가 입에 대고 내린다', () => {
  assert.deepEqual([0, 2400, 2600, 3000, 3800, 4000].map(sipAt), [0, 0, 0.5, 1, 0.5, 0]);
  const sipping = poseAt({ walking: false, activity: 'coffee', t: 3000 });
  assert.equal(sipping.sip, 1);
  assert.equal(poseAt({ walking: false, activity: 'coffee', t: 3000, reduced: true }).sip, 0, '동작 줄이기면 들고만 있다');
  assert.equal(poseAt({ walking: true, activity: 'coffee', t: 3000 }).sip, undefined, '걷는 동안에는 잔을 그리지 않는다');
});

test('캐릭터(페르소나)는 이름으로 고정 배정되고 고르게 나뉜다', async () => {
  const { personaFor } = await import('../web/office/model.mjs');
  assert.equal(personaFor('claude-impl', ['m']), 'm');
  assert.equal(personaFor('claude-impl', []), null);
  const names = Array.from({ length: 40 }, (_, i) => `agent-${i}`);
  const picks = names.map((name) => personaFor(name, ['f', 'm']));
  assert.deepEqual(picks, names.map((name) => personaFor(name, ['f', 'm'])), '같은 이름은 같은 캐릭터');
  assert.ok(picks.filter((p) => p === 'f').length >= 10 && picks.filter((p) => p === 'm').length >= 10);
});

test('이미 쓰는 캐릭터는 건너뛰어 같은 화면에 같은 인물이 둘 나오지 않는다', async () => {
  const { personaFor } = await import('../web/office/model.mjs');
  const personas = Array.from({ length: 40 }, (_, i) => `p${i}`);
  const taken = new Set();
  for (let i = 0; i < 40; i++) taken.add(personaFor(`agent-${i}`, personas, taken));
  assert.equal(taken.size, 40, '40명이면 40명 모두 다른 캐릭터');
  assert.equal(personaFor('agent-0', personas, new Set(personas)), personaFor('agent-0', personas), '모두 차면 이름으로 고른 캐릭터(겹침)');
});

test('재킷은 세션 종류 색(claude는 원래 주황)이고, 색이 묻어나는 캐릭터는 주황 그대로, 종류에 맞는 캐릭터를 먼저 고른다', async () => {
  const { lookFor, personaFor, prefersPersona } = await import('../web/office/model.mjs');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../web/office/side/manifest.json', import.meta.url), 'utf8'));
  const { variants, characters } = manifest;
  assert.equal(variants.claude, null, 'claude는 그림 원래의 주황');
  assert.deepEqual(lookFor({ recolor: true }, 'gemini', variants), { jacket: variants.gemini });
  assert.equal(lookFor({ recolor: true }, 'claude', variants), null);
  assert.equal(lookFor({}, 'gemini', variants), null, '색이 묻어나는 캐릭터는 주황 그대로');
  assert.deepEqual(lookFor({ recolor: true }, 'unknown', variants), { jacket: variants.other });
  const hues = Object.entries(variants).filter(([, v]) => v).map(([, v]) => `${v.hue}/${v.saturation}/${v.lightness}`);
  assert.equal(new Set(hues).size, hues.length, '종류마다 다른 색');
  const personas = Object.keys(characters).filter((id) => !characters[id].npc).sort();
  const recolor = personas.filter((id) => characters[id].recolor);
  assert.ok(recolor.length >= 10 && recolor.length < personas.length);
  const taken = new Set();
  for (let i = 0; i < 10; i++) taken.add(personaFor(`codex-${i}`, personas, taken, prefersPersona('codex', characters)));
  assert.ok([...taken].every((id) => characters[id].recolor), 'codex 세션은 색을 바꿀 수 있는 캐릭터를 먼저 받는다');
  assert.ok(!characters[personaFor('claude-1', personas, taken, prefersPersona('claude', characters))].recolor, 'claude 세션은 원래 주황 캐릭터를 먼저 받는다');
  const all = new Set();
  for (let i = 0; i < personas.length; i++) all.add(personaFor(`gemini-${i}`, personas, all, prefersPersona('gemini', characters)));
  assert.equal(all.size, personas.length, '선호 캐릭터가 차면 나머지 캐릭터도 겹치지 않게 준다');
  const { pickPersona } = await import('../web/office/model.mjs');
  const used = new Map();
  const kinds = ['codex', 'gemini', 'copilot', 'antigravity', 'human'];
  for (let i = 0; i < 35; i++) { const kind = kinds[i % kinds.length], id = pickPersona(`${kind}-${i}`, kind, personas, characters, used); assert.ok(characters[id].recolor, `${kind}-${i}는 도구 색 재킷을 입는다`); used.set(id, [...(used.get(id) ?? []), kind]); }
  assert.ok([...used.values()].every((list) => new Set(list).size === list.length), '같은 캐릭터를 나눠 써도 도구(재킷 색)는 서로 다르다');
});

test('책상 자리: 엎드려 잘 때는 뒷모습보다 덜 옮겨 엉덩이가 의자 방석에 남는다', () => {
  for (const desk of SPOTS.desks) {
    const { back, sleep } = SEATS[desk];
    assert.ok(back && sleep, desk);
    assert.ok(Math.abs(sleep.dy) < Math.abs(back.dy) && Math.abs(sleep.dy) <= 16, `${desk}: sleep.dy=${sleep.dy}`);
  }
});

test('방 배치: 같은 채널 논의 → 회의실, PM → 사장실, PM에게 보고한 사람 → 사장실 방문, 나머지 → 개발실', async () => {
  const { officeScene, roomCounts } = await import('../web/office/model.mjs');
  const { ROOMS } = await import('../web/office/rooms.mjs');
  const agents = [agent('pm', 'working'), agent('a', 'discussing'), agent('b', 'discussing'), agent('c', 'reviewing'), agent('d', 'working'), agent('e', 'idle', AWAY + 1)];
  const order = agents.map((x) => x.author);
  const events = [
    { channel: 'login', author: 'a', at: iso(20_000) }, { channel: 'login', author: 'b', at: iso(10_000) },
    { channel: 'login', author: 'c', at: iso(30_000), to: ['pm'] },
  ];
  const scene = officeScene({ agents, order, events, now: NOW, awayAfterMs: AWAY, pm: 'pm' });
  const where = Object.fromEntries(scene.map((item) => [item.author, [item.room, item.spot, item.pose]]));
  assert.deepEqual(where.pm, ['boss', 'pm', 'sit'], 'PM은 사장실 창가 책상(가운데 큰 책상은 대표 자리)');
  assert.deepEqual(where.a.slice(0, 1), ['meeting']);
  assert.deepEqual(where.b.slice(0, 1), ['meeting']);
  assert.ok(ROOMS.meeting.SPOTS.meeting.includes(where.a[1]));
  assert.deepEqual(where.c, ['boss', 'v0', 'stand']);
  assert.ok(where.d[0] === 'dev' && SPOTS.desks.includes(where.d[1]) && where.d[2] === 'sit', '개발실에서 일하는 사람은 빈 자유석에 앉는다');
  assert.equal(where.e[0], 'dev');
  assert.deepEqual(roomCounts(scene), { dev: 2, meeting: 2, boss: 2 });
  const later = officeScene({ agents, order, events, now: NOW + 3 * 60 * 1000, awayAfterMs: AWAY * 10, pm: 'pm' });
  assert.equal(later.find((item) => item.author === 'c').room, 'dev', '2분이 지나면 개발실로 돌아간다');
  const noPm = officeScene({ agents, order, events, now: NOW, awayAfterMs: AWAY, pm: null });
  assert.equal(noPm.find((item) => item.author === 'pm').room, 'dev');
  for (const room of Object.values(ROOMS)) {
    for (const [a, b] of room.EDGES) assert.ok(room.NODES[a] && room.NODES[b], `${room.id}: ${a}-${b}`);
    for (const spot of Object.keys(room.SEATS)) assert.ok(room.NODES[spot], `${room.id}: 자리 ${spot}에 바닥 지점이 있어야 한다`);
  }
});

test('한동안 말이 없으면 조용함(…), 더 지나면 자리 비움으로 엎드려 잔다', () => {
  assert.equal(isQuiet(agent('a', 'working', QUIET_AFTER_MS - 1), NOW, AWAY), false);
  assert.equal(isQuiet(agent('a', 'working', QUIET_AFTER_MS), NOW, AWAY), true);
  assert.equal(isQuiet(agent('a', 'working', AWAY + 1), NOW, AWAY), false, '자리 비움부터는 말풍선 대신 잔다');
  assert.equal(isQuiet(agent('a', 'working', 60_000), NOW, 90_000), true, '자리 비움 기준이 짧으면 그 절반부터 조용함');
  const agents = [agent('a', 'working'), agent('b', 'working', QUIET_AFTER_MS + 1), agent('c', 'working', AWAY + 1)];
  const by = Object.fromEntries(officeScene({ agents, order: ['a', 'b', 'c'], now: NOW, awayAfterMs: AWAY }).map((item) => [item.author, item]));
  assert.deepEqual([by.a.quiet, by.b.quiet, by.c.quiet], [false, true, false]);
  assert.deepEqual([by.c.activity, by.c.pose], ['sleep', 'sit']);
});

test('자는 동안 Z가 주기적으로 떠오르고, 동작 줄이기면 멈춘다', () => {
  const zz = [0, ZZ_MS / 2, ZZ_MS].map((t) => poseAt({ walking: false, activity: 'sleep', t }).zz);
  assert.deepEqual(zz, [0, 0.5, 0]);
  assert.equal(poseAt({ walking: false, activity: 'sleep', t: 100, reduced: true }).zz, null);
  assert.equal(poseAt({ walking: false, activity: 'typing', t: 100 }).zz, undefined);
});

test('잡담은 활동·작업·동료에 맞는 한마디이고, 자거나 걷는 중에는 없다', async () => {
  const { pickChatter, canChatter, chatterGap, CHATTER_MIN_GAP_MS, CHATTER_MAX_GAP_MS } = await import('../web/office/chatter.mjs');
  const seq = (...values) => () => values.length > 1 ? values.shift() : values[0];
  assert.equal(pickChatter({ activity: 'sleep' }), null);
  assert.equal(pickChatter({ activity: null }), null);
  assert.equal(canChatter('typing'), true);
  assert.match(pickChatter({ activity: 'coffee', peers: ['codex-1'], random: seq(0, 0, 0) }), /codex-1/);
  for (let i = 0; i < 20; i++) assert.doesNotMatch(pickChatter({ activity: 'typing', random: () => i / 20 }), /\{|undefined|null/);
  const lines = new Set(Array.from({ length: 40 }, (_, i) => pickChatter({ activity: 'reading', feature: 'chatbot', random: () => i / 40 })));
  assert.ok([...lines].some((line) => line.includes('chatbot')));
  assert.equal(chatterGap(0), CHATTER_MIN_GAP_MS);
  assert.ok(chatterGap(0.999) < CHATTER_MAX_GAP_MS);
});

test('실제 대화가 활발하면 잡담을 멈추고, 방금 글을 쓴 사람도 조용하다', async () => {
  const { chatterAllowed } = await import('../web/office/chatter.mjs');
  const ev = (author, msAgo) => ({ author, at: iso(msAgo) });
  assert.equal(chatterAllowed([], NOW), true);
  assert.equal(chatterAllowed([ev('a', 10_000), ev('b', 20_000)], NOW), true);
  assert.equal(chatterAllowed([ev('a', 10_000), ev('b', 20_000), ev('c', 60_000)], NOW), false, '3분에 3건이면 사무실 전체가 쉼');
  assert.equal(chatterAllowed([ev('a', 10_000), ev('b', 20_000), ev('c', 4 * 60_000)], NOW), true, '오래된 대화는 세지 않음');
  assert.equal(chatterAllowed([ev('a', 60_000)], NOW, 'a'), false, '방금 쓴 사람');
  assert.equal(chatterAllowed([ev('a', 60_000)], NOW, 'b'), true);
  assert.equal(chatterAllowed([ev('a', 3 * 60_000)], NOW, 'a'), true);
});

test('NPC는 사무실 안의 정보로만 말한다: 제이크는 진행 소식, 써니는 도움말·사무실 안내', async () => {
  const { NPCS, npcLine, pickReaction } = await import('../web/office/chatter.mjs');
  assert.deepEqual(NPCS.map((npc) => [npc.id, npc.room, npc.name]), [['news', 'dev', '제이크'], ['guide', 'dev', '써니'], ['meeting', 'meeting', '에밀리'], ['tools', 'lab', '리나'], ['qa', 'roof', '테스'], ['secretary', 'boss', '브라이언']]);
  const { npcGuide } = await import('../web/office/chatter.mjs');
  assert.match(npcLine('qa', { features: [{ id: 'pay', phase: 'review' }] }, () => 0).text, /pay/, '테스는 검토 단계 작업을 알려 준다');
  assert.equal(npcGuide('qa', {}).sections[1].heading, '검토 요령');
  assert.equal(new Set(NPCS.map((npc) => npc.side)).size, NPCS.length, 'NPC마다 다른 인물');
  assert.equal(new Set(NPCS.map((npc) => `${npc.side}:${npc.jacket.hue}`)).size, NPCS.length, '모습(그림·재킷 색)이 겹치지 않는다');
  const context = { hour: 11, features: [{ id: 'chatbot', phase: 'design' }, { id: 'login', phase: 'done' }], labels: { design: '설계' }, active: 1, working: 2, pm: 'dev5' };
  assert.deepEqual(npcLine('news', context, () => 0), { text: '📢 chatbot 작업은 지금 설계 단계예요', topic: 'news' });
  const news = new Set(Array.from({ length: 30 }, (_, i) => npcLine('news', context, () => i / 30).text));
  assert.ok([...news].some((text) => text.includes('끝낸 작업이 1건')));
  assert.ok([...news].some((text) => text.includes('PM은 dev5')));
  assert.equal(npcLine('news', { hour: 9 }, () => 0.99).topic, 'news', '작업이 없어도 말할 거리가 있다');
  const agents = [{ name: 'claude-front', kind: 'claude', state: 'working', feature: 'chatbot' }];
  const project = { ...context, project: 'shop', description: '작은 온라인 상점', features: [{ id: 'chatbot', title: '챗봇', phase: 'design' }, { id: 'login', title: '로그인', phase: 'done' }], agents };
  const say = (turn, extra = {}) => npcLine('guide', { ...project, ...extra, turn }, () => 0);
  assert.deepEqual(say(0), { text: '📘 shop: 작은 온라인 상점', topic: 'project' });
  assert.equal(say(1).text, '📘 shop에는 wax 작업이 2개 있어요(chatbot, login). 완료 1개, 진행 1개예요');
  assert.equal(say(2).text, '📘 chatbot(챗봇) 작업은 지금 설계 단계예요');
  assert.equal(say(3).text, '📘 login(로그인) 작업은 지금 완료 단계예요');
  assert.deepEqual(say(4), { text: '👋 claude-front님은 Claude Code 세션이에요. 지금 chatbot 작업 중!', topic: 'intro', subject: 'claude-front' });
  assert.deepEqual(say(5), { text: '▶️ claude-front님 다음 명령: /wax:design chatbot', topic: 'intro', subject: 'claude-front' }, '세션 소개 뒤에 그 도구 문법으로 다음 명령');
  assert.match(say(6).text, /^🆕 처음 세션은 init 한 번으로/);
  assert.match(say(13).text, /^🆕 같은 이름의 세션이 이미 있으면/);
  assert.deepEqual(say(27), { text: '🍚 곧 점심시간이에요', topic: 'time' });
  assert.match(say(0, { description: null, features: [] }).text, /^🧭 아직 작업이 없어요/);
  assert.match(say(1, { description: null, features: [] }).text, /아직 wax 작업이 없어요/);
  assert.equal(say(4, { agents: [{ name: 'q', kind: 'copilot', model: 'claude-opus-4-5', state: 'working', feature: 'chatbot' }] }).text, '👋 q님은 GitHub Copilot CLI(claude-opus-4-5) 세션이에요. 지금 chatbot 작업 중!');
  assert.equal(say(5, { agents: [{ name: 'q', kind: 'copilot', state: 'working', feature: 'chatbot' }] }).text, '▶️ q님 다음 명령: wax design 스킬로 chatbot 진행해줘');
  assert.ok(NPCS.find((npc) => npc.id === 'guide').every === 20_000, '써니는 20초마다');
  assert.equal(npcLine('meeting', { ...context, meetings: ['billing'] }, () => 0).text, '🗣️ 지금 billing 회의 중이에요');
  assert.equal(npcLine('secretary', context, () => 0).text, '🗂️ 이 프로젝트의 PM은 dev5님이에요');
  assert.match(npcLine('secretary', { hour: 9 }, () => 0).text, /아직 PM이 없어요/);
  assert.equal(typeof pickReaction('guide', () => 0), 'string');
  assert.equal(typeof pickReaction('unknown', () => 0), 'string');
});

test('책상은 참여 명단에 있는 사람에게만 준다(글만 남긴 이름은 자리를 차지하지 않는다)', () => {
  const agents = [agent('a', 'working'), agent('b', 'working')];
  const scene = sceneFor({ agents, order: ['ghost1', 'ghost2', 'ghost3', 'a', 'b'], now: NOW, awayAfterMs: AWAY });
  const seats = assignSeats(['a', 'b']);
  assert.deepEqual(scene.map((item) => [item.author, item.spot, item.pose]), [['a', seats.get('a'), 'sit'], ['b', seats.get('b'), 'sit']]);
  assert.ok(SPOTS.desks.includes(seats.get('a')) && SPOTS.desks.includes(seats.get('b')));
});

test('자유석: 쉬는 사람은 의자를 차지하지 않고 일하는 사람이 먼저 앉는다', () => {
  const agents = [agent('idle1', 'idle'), agent('idle2', 'idle'), agent('idle3', 'idle'), agent('w0', 'working'), agent('w1', 'working'), agent('w2', 'reviewing'), agent('w3', 'working')];
  const order = ['idle1', 'idle2', 'idle3', 'w0', 'w1', 'w2', 'w3'];
  const scene = sceneFor({ agents, order, now: NOW, awayAfterMs: AWAY });
  const by = Object.fromEntries(scene.map((item) => [item.author, item]));
  assert.equal(by.idle1.activity, 'coffee');
  const taken = scene.filter((item) => SPOTS.desks.includes(item.spot)).map((item) => item.author);
  assert.deepEqual(taken, ['w0', 'w1', 'w2', 'w3'], '먼저 온 쉬는 사람보다 일하는 네 명이 자유석에 앉는다');
});

test('사이드뷰 건물: 자리 배정에 쓰는 모든 자리와 NPC 자리가 층마다 있고, 입구에서 계단으로 이어진다', async () => {
  const { BUILDING, SIDE_ROOMS } = await import('../web/office/side-rooms.mjs');
  const { ROOMS } = await import('../web/office/rooms.mjs');
  const { NPCS } = await import('../web/office/chatter.mjs');
  const { findPath, routeTo, point } = await import('../web/office/animate.mjs');
  const spotsOf = (room) => [...Object.entries(room.SPOTS).filter(([k]) => k !== 'entrance').flatMap(([, v]) => [v].flat()), ...Object.keys(room.SEATS)];
  const needed = { dev: spotsOf({ SPOTS, SEATS }), meeting: spotsOf(ROOMS.meeting), boss: spotsOf(ROOMS.boss), lab: spotsOf(SIDE_ROOMS.lab), roof: spotsOf(SIDE_ROOMS.roof) };
  for (const npc of NPCS) needed[npc.room].push(...npc.spots);
  for (const [id, names] of Object.entries(needed)) {
    for (const name of new Set(names)) {
      const key = `${id}:${name}`;
      assert.ok(BUILDING.NODES[key], key);
      assert.ok(findPath(BUILDING.SPOTS.entrance, key, BUILDING).length >= 2, `입구 → ${key}`);
    }
  }
  const from = point('dev:d0', BUILDING);
  const up = routeTo(from.x, from.y, 'boss:chair', BUILDING);
  const vertical = up.slice(1).filter((p, i) => p.x === up[i].x && p.y !== up[i].y);
  assert.ok(vertical.length >= 1 && vertical.every((p) => p.x === 1350) && up.at(-1).y < from.y, '엘리베이터로 위층');
  const same = routeTo(from.x, from.y, 'dev:sofa1', BUILDING);
  assert.equal(new Set(same.map((p) => p.y)).size, 1, '같은 층은 한 줄');
});

test('사이드뷰 층 순서: 아래에서 위로 회의(기획·설계) → 개발(구현) → 연구(검토) → 사장실(보고), 맨 위는 옥상 정원이고 입구는 1층', async () => {
  const { BUILDING } = await import('../web/office/side-rooms.mjs');
  const { floorName } = await import('../web/office/side-render.mjs');
  assert.deepEqual(BUILDING.floors, ['meeting', 'dev', 'lab', 'boss', 'roof']);
  assert.deepEqual(BUILDING.floors.map((id) => floorName(BUILDING, id)), ['1F', '2F', '3F', '4F', 'RF']);
  assert.equal(BUILDING.SPOTS.entrance, 'meeting:door');
  const tops = BUILDING.floors.map((id) => BUILDING.floorTop[id]);
  assert.ok(tops.every((top, i) => i === 0 || top < tops[i - 1]), '위층일수록 화면 위');
  assert.equal(BUILDING.floorTop.roof, 0);
  assert.ok(BUILDING.WHITEBOARD_HIT.y > BUILDING.floorTop.dev && BUILDING.WHITEBOARD_HIT.y < BUILDING.floorTop.meeting, '화이트보드는 2층 개발실');
});

test('사이드뷰 옥상 정원: 쉬는 사람은 옥상에서 둘씩 마주 보고 담소를 나누고, 차면 개발실에서 쉬며, PM은 사장실에 남는다', async () => {
  const { officeScene } = await import('../web/office/model.mjs');
  const { SIDE_ROOMS } = await import('../web/office/side-rooms.mjs');
  const { canChatter, pickChatter } = await import('../web/office/chatter.mjs');
  const roof = SIDE_ROOMS.roof;
  const idle = Array.from({ length: roof.SPOTS.rest.length + 1 }, (_, i) => `i${i}`);
  const agents = [...idle.map((n) => agent(n, 'idle')), agent('pm', 'idle'), agent('w', 'working')];
  const order = agents.map((a) => a.author);
  const by = Object.fromEntries(officeScene({ agents, order, now: NOW, awayAfterMs: AWAY, pm: 'pm', lab: SIDE_ROOMS.lab, roof }).map((i) => [i.author, i]));
  assert.deepEqual([by.i0.room, by.i0.spot, by.i0.activity, by.i0.pose], ['roof', 'a0', 'chat', 'stand']);
  assert.deepEqual([roof.NODES[by.i0.spot][2], roof.NODES[by.i1.spot][2]], ['right', 'left'], '먼저 온 두 사람은 마주 본다');
  const bench = idle.map((n) => by[n]).find((item) => item.spot === 'bench0');
  assert.equal(bench.pose, 'sit');
  const extra = by[idle.at(-1)];
  assert.equal(extra.room, 'dev', '옥상이 차면 개발실에서 쉰다');
  assert.equal(by.pm.room, 'boss');
  assert.equal(by.w.room, 'dev');
  assert.ok(canChatter('chat') && pickChatter({ activity: 'chat', random: () => 0 }));
  const iso = officeScene({ agents, order, now: NOW, awayAfterMs: AWAY });
  assert.ok(iso.every((i) => i.room !== 'roof'), '옥상을 주지 않으면 예전처럼 개발실에서 쉰다');
});

test('사이드뷰 그림 선택: 걷기는 2프레임, 책상은 노트북·자리 비움은 졸기, 보드 옆은 옆모습, 그림이 없으면 서 있는 그림', async () => {
  const { sideImageFor } = await import('../web/office/side-render.mjs');
  const v = (n) => ({ name: n });
  const sprite = { views: { front: v('front'), side: v('side'), back: v('back') }, poses: { walk1: v('w1'), walk2: v('w2'), type: v('type'), doze: v('doze') } };
  const pick = (actor) => { const r = sideImageFor(sprite, actor); return [r.info.name, r.flip]; };
  assert.deepEqual(pick({ walking: true, pose: { leg: 2 }, facing: 'left' }), ['w1', true]);
  assert.deepEqual(pick({ walking: true, pose: { leg: -2 }, facing: 'right' }), ['w2', false]);
  assert.deepEqual(pick({ sit: true, activity: 'typing', facing: 'right' }), ['type', false]);
  assert.deepEqual(pick({ sit: true, activity: 'sleep', facing: 'left' }), ['doze', true]);
  assert.deepEqual(pick({ sit: true, activity: 'coffee', facing: 'right' }), ['front', false], '커피 그림이 없으면 정면');
  assert.deepEqual(pick({ activity: 'posting' }), ['side', false], '보드에 붙일 때는 등을 보이지 않고 옆모습으로 보드를 본다');
  assert.deepEqual(pick({ activity: 'npc' }), ['front', false]);
  assert.deepEqual(pick({ activity: 'chat', facing: 'left' }), ['side', true], '옥상 담소는 옆모습으로 마주 본다');
  const sipper = { ...sprite, poses: { ...sprite.poses, sip: v('sip') } };
  const sip = (actor) => { const r = sideImageFor(sipper, actor); return [r.info.name, r.flip]; };
  assert.deepEqual(sip({ activity: 'coffee', facing: 'right' }), ['sip', false], '서서 쉬는 사람은 커피를 든 그림');
  assert.deepEqual(sip({ activity: 'chat', cup: true, facing: 'left' }), ['sip', true], '쉬다가 이야기할 때도 커피를 든다');
  assert.deepEqual(sip({ activity: 'chat', facing: 'left' }), ['side', true], '쉬는 중이 아니면 옆모습으로 이야기한다');
  assert.deepEqual(pick({ activity: 'coffee', cup: true }), ['front', false], '서서 커피 그림이 없으면 정면');
  const leftType = { ...sprite, poses: { ...sprite.poses, type: { name: 'type', faces: 'left' } } };
  assert.equal(sideImageFor(leftType, { sit: true, activity: 'typing', facing: 'right' }).flip, true, '왼쪽을 보고 그려진 앉은 그림은 오른쪽 자리에서 뒤집는다');
  assert.equal(sideImageFor(leftType, { sit: true, activity: 'typing', facing: 'left' }).flip, false);
  const leftSide = { views: { ...sprite.views, side: { name: 'side', faces: 'left' } }, poses: {} };
  assert.equal(sideImageFor(leftSide, { walking: true, pose: { leg: 1 }, facing: 'right' }).flip, true, '왼쪽을 보고 그려진 옆모습은 오른쪽으로 걸을 때 뒤집는다(뒤로 걷지 않는다)');
  assert.equal(sideImageFor(leftSide, { walking: true, pose: { leg: 1 }, facing: 'left' }).flip, false);
  assert.equal(sideImageFor(leftSide, { activity: 'chat', facing: 'right' }).flip, true);
  const sofa = sideImageFor(sprite, { sit: true, seatKind: 'sofa', activity: 'coffee' });
  assert.deepEqual([sofa.info.name, sofa.sofa], ['front', true], '소파는 의자 그림 대신 정면 그림을 접어 앉힌다');
});

test('사이드뷰 연구소: 검토 중인 사람은 테스트 벤치 앞에 서고, 넘치면 모니터 앞에 서며, 연구소가 없으면 그대로 개발실', async () => {
  const { officeScene } = await import('../web/office/model.mjs');
  const { SIDE_ROOMS } = await import('../web/office/side-rooms.mjs');
  const agents = ['r1', 'r2', 'r3', 'r4'].map((n) => agent(n, 'reviewing')).concat(agent('w', 'working'));
  const order = agents.map((a) => a.author);
  const by = Object.fromEntries(officeScene({ agents, order, now: NOW, awayAfterMs: AWAY, lab: SIDE_ROOMS.lab }).map((i) => [i.author, i]));
  assert.deepEqual(['r1', 'r2', 'r3', 'r4'].map((n) => [by[n].room, by[n].spot, by[n].pose]), [['lab', 't0', 'stand'], ['lab', 't1', 'stand'], ['lab', 't2', 'stand'], ['lab', 'm0', 'stand']]);
  assert.equal(by.w.room, 'dev');
  const iso = officeScene({ agents, order, now: NOW, awayAfterMs: AWAY });
  assert.ok(iso.every((i) => i.room !== 'lab'));
});

test('사이드뷰 그리기: 배경·소품 그림이 있든 없든 건물 전체를 오류 없이 그리고, 엘리베이터 탄 사람 칸을 그린다', async () => {
  const { render } = await import('../web/office/side-render.mjs');
  const { BUILDING } = await import('../web/office/side-rooms.mjs');
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => { calls.push(k); }), set: (t, k, v) => { t[k] = v; return true; } });
  const image = { width: 10, height: 10 };
  const info = { image, mask: null, width: 10, height: 20, anchor: { x: 5, y: 20 } };
  const sprite = { views: { front: info, side: info, back: info }, poses: {} };
  const actors = [{ x: 1350, y: 900, riding: true, persona: 'p', pose: { dy: 0 }, scale: 1 }, { x: 250, y: 1632, sit: true, activity: 'typing', persona: 'p', pose: { dy: 0 }, scale: 1 }];
  render(ctx, { assets: null, actors: [], board: null, room: BUILDING });
  render(ctx, { assets: { props: { plant: { image, width: 10, height: 8 } } }, actors: [], board: null, room: BUILDING });
  const withArt = { characters: { p: sprite }, backgrounds: Object.fromEntries(BUILDING.floors.map((id) => [id, image])), props: { desk: { image, width: 10, height: 8 }, sofa: { image, width: 10, height: 8 }, chair: { image, width: 10, height: 8 } } };
  render(ctx, { assets: withArt, actors, board: { notes: [{ type: 'opinion' }] }, room: BUILDING });
  assert.ok(calls.includes('drawImage') && calls.includes('fillRect'));
});

test('사이드뷰 걷기 주기: 다리가 앞뒤로 반대로 오가고, 앞으로 나가는 다리만 든다', async () => {
  const { strideOffsets } = await import('../web/office/side-render.mjs');
  const { poseAt, STEP_MS } = await import('../web/office/animate.mjs');
  assert.deepEqual(strideOffsets(0), { front: 0, back: 0, frontLift: 0, backLift: 0 });
  const forward = strideOffsets(1);
  assert.ok(forward.front > 0 && forward.back < 0 && forward.frontLift > 0 && forward.backLift === 0);
  const strides = [0, STEP_MS / 2, STEP_MS, (STEP_MS * 3) / 2].map((t) => poseAt({ walking: true, t }).stride);
  assert.ok(Math.abs(strides[0]) < 1e-9 && strides[1] > 0.99 && Math.abs(strides[2]) < 1e-9 && strides[3] < -0.99);
});

test('소파 앉기: 다리를 접은 만큼 몸이 내려오고 발은 바닥에 그대로 있다', async () => {
  const { sofaLayout } = await import('../web/office/side-render.mjs');
  const { split, legs, folded, drop } = sofaLayout(180);
  assert.equal(split + legs, 180);
  assert.equal(drop + folded, legs, '내려온 만큼 + 접은 다리 = 원래 다리');
  assert.ok(folded < legs && drop > 0);
});

test('이름표 쌓기: 겹치는 이름표만 아래로 내리고, 떨어진 이름표는 그대로 둔다', async () => {
  const { stackDown } = await import('../web/office/model.mjs');
  const tops = stackDown([{ x: 100, top: 50, width: 80, height: 16 }, { x: 130, top: 50, width: 80, height: 16 }, { x: 400, top: 50, width: 80, height: 16 }, { x: 110, top: 52, width: 60, height: 16 }]);
  assert.deepEqual(tops, [50, 68, 50, 86]);
});

test('이름표 쌓기: 아래로 내리다 화면 밖으로 나가면 위로 쌓는다', async () => {
  const { stackDown } = await import('../web/office/model.mjs');
  const tops = stackDown([{ x: 100, top: 80, width: 80, height: 16 }, { x: 110, top: 80, width: 80, height: 16 }], 2, 100);
  assert.deepEqual(tops, [80, 62]);
});

test('사이드뷰 빈 의자·책상: 앉은 사람이 있는 자리만 찾고, 빈 의자는 개발실·회의실·사장실 자리마다 하나씩 있다', async () => {
  const { occupiedSeats } = await import('../web/office/side-render.mjs');
  const { BUILDING, SIDE_ROOMS } = await import('../web/office/side-rooms.mjs');
  const seat = BUILDING.SEATS['dev:d1'];
  const taken = occupiedSeats(BUILDING, [{ sit: true, x: seat.x, y: seat.y }, { sit: false, x: BUILDING.SEATS['dev:d0'].x, y: BUILDING.SEATS['dev:d0'].y }]);
  assert.deepEqual([...taken], ['dev:d1']);
  const chairs = (id) => SIDE_ROOMS[id].props.filter((prop) => prop.seatOf).map((prop) => prop.seatOf).sort();
  assert.deepEqual(chairs('dev'), ['d0', 'd1', 'd2', 'd3', 'd4']);
  assert.deepEqual(chairs('meeting'), ['c0', 'c1', 'c2', 'c3', 'f0', 'f1', 'f2']);
  assert.deepEqual(chairs('boss'), ['chair', 'pm']);
  for (const id of ['dev', 'meeting', 'boss']) for (const prop of SIDE_ROOMS[id].props.filter((item) => item.seatOf)) {
    assert.equal(prop.flip, SIDE_ROOMS[id].SEATS[prop.seatOf].facing === 'left', `${id}:${prop.seatOf} 의자는 자리 방향을 본다`);
  }
});

test('사이드뷰 그림 방향: 왼쪽을 보고 그려진 옆모습(NPC 브라이언·에밀리·제이크와 f05·f11·f12·f15~f18·m03·m07·m09·m12·m13·m15·m17)은 manifest faces로 표시한다', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../web/office/side/manifest.json', import.meta.url), 'utf8'));
  const left = Object.entries(manifest.characters).filter(([, c]) => c.views.side?.faces === 'left').map(([id]) => id);
  assert.deepEqual(left.sort(), ['brian', 'emily', 'f05', 'f11', 'f12', 'f15', 'f16', 'f17', 'f18', 'jake', 'm03', 'm07', 'm09', 'm12', 'm13', 'm15', 'm17']);
});

test('말풍선 시간: 짧은 말은 3초, 길면 최소 5초에서 글 길이만큼(최대 10초)', async () => {
  const { bubbleMs } = await import('../web/office/chatter.mjs');
  assert.equal(bubbleMs('좋아요'), 3000);
  assert.equal(bubbleMs('a'.repeat(15)), 3000);
  assert.equal(bubbleMs('a'.repeat(16), 4500), 5000);
  assert.equal(bubbleMs('a'.repeat(50), 6000), 8000);
  assert.equal(bubbleMs('a'.repeat(400)), 10000);
  assert.equal(bubbleMs('sss sss sss sss s'), 5000, '글자 s가 아니라 공백을 줄인다');
  assert.equal(bubbleMs('가  나\n\n다'), 3000);
});

test('개발실 자유석: 다른 층에 간 사람의 자리에도 남이 앉고, 모두 돌아오면 빈자리를 나눠 앉는다', async () => {
  const { officeScene } = await import('../web/office/model.mjs');
  const team = ['claude-front', 'codex-api', 'gemini-docs'];
  const deskOf = (scene) => Object.fromEntries(scene.filter((item) => item.room === 'dev' && SPOTS.desks.includes(item.spot)).map((item) => [item.author, item.spot]));
  const allWorking = deskOf(officeScene({ agents: team.map((n) => agent(n, 'working')), order: team, now: NOW, awayAfterMs: AWAY }));
  assert.equal(new Set(Object.values(allWorking)).size, 3, '세 명이 서로 다른 자리');
  const oneIdle = deskOf(officeScene({ agents: [agent('claude-front', 'idle'), agent('codex-api', 'working'), agent('gemini-docs', 'working')], order: team, now: NOW, awayAfterMs: AWAY }));
  assert.deepEqual(Object.keys(oneIdle).sort(), ['codex-api', 'gemini-docs']);
  const events = [{ channel: 'x', author: 'claude-front', at: iso(20_000) }, { channel: 'x', author: 'codex-api', at: iso(10_000) }];
  const meeting = deskOf(officeScene({ agents: [agent('claude-front', 'discussing'), agent('codex-api', 'discussing'), agent('gemini-docs', 'working'), agent('late', 'working')], order: [...team, 'late'], events, now: NOW, awayAfterMs: AWAY }));
  assert.deepEqual(Object.keys(meeting).sort(), ['gemini-docs', 'late']);
  const back = deskOf(officeScene({ agents: [...team, 'late'].map((n) => agent(n, 'working')), order: [...team, 'late'], now: NOW, awayAfterMs: AWAY }));
  assert.equal(new Set(Object.values(back)).size, 4, '모두 돌아오면 네 명이 서로 다른 자리');
});

test('고정 자리: 한 시간 넘게 활동이 없는 사람은 책상을 내놓고 사무실에서 보이지 않는다', async () => {
  const { officeScene, DESK_RELEASE_MS } = await import('../web/office/model.mjs');
  const order = ['old1', 'old2', 'old3', 'w1'];
  const agents = [agent('old1', 'working', DESK_RELEASE_MS + 1), agent('old2', 'working', DESK_RELEASE_MS + 1), agent('old3', 'idle', AWAY + 1), agent('w1', 'working')];
  const scene = officeScene({ agents, order, now: NOW, awayAfterMs: AWAY });
  const by = Object.fromEntries(scene.map((item) => [item.author, item]));
  assert.equal(by.old1.spot, null);
  assert.equal(by.old2.spot, null);
  assert.ok(SPOTS.desks.includes(by.w1.spot), '오래 비운 책상 대신 새 사람이 책상 주인');
  assert.equal(by.old3.activity, 'sleep', '한 시간이 안 된 자리 비움은 자기 책상에서 잔다');
});

test('자유석: 늦게 왔어도 일하는 사람이 의자에 먼저 앉는다(10명이 넘어도 일하는 사람은 보인다)', async () => {
  const { officeScene } = await import('../web/office/model.mjs');
  const order = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const agents = order.map((n, i) => agent(n, i >= 10 ? 'working' : 'idle'));
  const scene = officeScene({ agents, order, now: NOW, awayAfterMs: AWAY });
  const by = Object.fromEntries(scene.map((item) => [item.author, item]));
  assert.ok(SPOTS.desks.includes(by.p10.spot) && SPOTS.desks.includes(by.p11.spot), '일하는 두 사람이 자유석에 앉는다');
  assert.ok(order.slice(0, 10).every((n) => !SPOTS.desks.includes(by[n].spot)), '쉬는 사람은 의자를 차지하지 않는다');
});

test('NPC 안내: 말풍선은 도구 문법에 치우치지 않고, 누르면 지금 할 일·다음 명령·도구별 명령표를 펼친다', async () => {
  const { npcLine, npcGuide, nextSteps } = await import('../web/office/chatter.mjs');
  for (const id of ['news', 'guide', 'meeting', 'secretary']) {
    for (let i = 0; i < 40; i++) {
      const { text } = npcLine(id, { hour: 10, features: [], pm: null, tasks: [], agents: [], turn: i }, () => i / 40);
      assert.doesNotMatch(text, /\/wax:(work|pm|daily|dashboard)\b/, `${id}: ${text}`);
    }
  }
  assert.deepEqual(nextSteps({ features: [{ id: 'a', phase: 'plan' }], pm: 'p', tasks: [], agents: [{ kind: 'codex' }] }), [], '챙길 일이 없으면 비어 있다');
  const steps = nextSteps({ features: [], pm: null, tasks: [{ status: 'open' }], agents: [] });
  assert.equal(steps.length, 4);
  assert.match(steps.join(' '), /새 작업 만들기.*내가 PM 맡기.*배정 업무가 1건.*AI 세션이 없어요/);
  const context = { features: [{ id: 'login', title: '로그인', phase: 'design' }, { id: 'old', phase: 'done' }], labels: { design: '설계' }, pm: '사람',
    agents: [{ name: 'codex-api', kind: 'codex', model: 'gpt-5-codex', feature: 'login' }, { name: '사람', kind: 'human' }],
    tasks: [{ id: 't-1', to: 'codex-api', feature: 'login', phase: 'any', status: 'open', note: '기획 부탁' }], meetings: ['login'] };
  const sunny = npcGuide('guide', context);
  assert.equal(sunny.commandTable, true);
  assert.deepEqual(sunny.sections.map((x) => x.heading), ['지금 할 일', '세션별 다음 명령', '사무실 읽는 법']);
  assert.match(sunny.sections[0].items[0], /배정 업무가 1건/);
  assert.deepEqual(sunny.sections[1].items, ['codex-api (Codex · gpt-5-codex) — $wax:work t-1 · PM이 배정한 login 업무']);
  assert.ok(sunny.sections[2].items.length >= 5);
  const jake = npcGuide('news', context);
  assert.deepEqual(jake.sections[0].items, ['login (로그인) — 설계', 'old — 완료']);
  assert.match(jake.sections[1].items.join(' '), /진행 1건 · 완료 1건.*프로젝트 PM: 사람/);
  assert.deepEqual(npcGuide('meeting', context).sections[0].items, ['login 채널에서 논의 중']);
  const brian = npcGuide('secretary', context);
  assert.deepEqual(brian.sections[1].items, ['codex-api ← login 현재 단계: 기획 부탁']);
});

test('서성이기·모여서 이야기하기: 쉬는 사람·NPC가 빈 서 있는 자리로 잠깐 움직인다', async () => {
  const { planStroll, strollWeight } = await import('../web/office/stroll.mjs');
  const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
  const nodes = [{ name: 'b1', x: 915 }, { name: 'b0', x: 960 }, { name: 'lounge', x: 1040 }, { name: 'q', x: 175 }];
  assert.equal(strollWeight({ activity: 'talking' }), 0);
  assert.equal(strollWeight({ activity: 'sleep' }), 0);
  assert.equal(strollWeight({ activity: 'coffee', quiet: true }), 0);
  assert.ok(strollWeight({ npc: true, activity: 'npc' }) > strollWeight({ activity: 'typing' }));
  assert.equal(planStroll({ actors: [{ author: 'm', activity: 'talking', x: 500 }], nodes }), null);
  assert.equal(planStroll({ actors: [{ author: 'c', activity: 'coffee', x: 1110 }], nodes: [] }), null);
  const pair = planStroll({ actors: [{ author: '써니', npc: true, activity: 'npc', x: 1180 }, { author: 'c', activity: 'coffee', x: 1110 }], nodes, random: seq(0.1, 0.2, 0.9, 0.5) });
  assert.equal(pair.kind, 'gather');
  assert.equal(pair.moves.length, 2);
  const [left, right] = [...pair.moves].sort((a, b) => nodes.find((n) => n.name === a.spot).x - nodes.find((n) => n.name === b.spot).x);
  assert.deepEqual([left.facing, right.facing], ['right', 'left']);
  assert.notEqual(left.spot, right.spot);
  assert.equal(left.author, 'c', '왼쪽에 있던 사람이 왼쪽 자리로 가서 길을 건너지 않는다');
  assert.equal(planStroll({ actors: [{ author: 'w', activity: 'typing', x: 300 }], nodes, random: seq(0.5) }), null, '일하던 사람은 가끔만 일어난다');
  const alone = planStroll({ actors: [{ author: 'w', activity: 'typing', x: 300 }], nodes, random: seq(0.5, 0.5, 0.1, 0.5) });
  assert.equal(alone.kind, 'wander');
  assert.equal(alone.moves[0].facing, null);
  assert.ok(alone.moves[0].ms <= 7000);
  assert.ok(Math.abs(nodes.find((n) => n.name === alone.moves[0].spot).x - 300) <= 420, '멀리 가지 않는다');
});

test('이모티콘 말풍선: 활동에 맞는 이모티콘을 고르고, 자는 중에는 띄우지 않는다', async () => {
  const { pickEmote } = await import('../web/office/chatter.mjs');
  assert.equal(pickEmote({ activity: 'typing', random: () => 0.25 }), '🧠');
  assert.equal(pickEmote({ activity: 'reading', random: () => 0 }), '🔍');
  assert.equal(pickEmote({ activity: 'sleep' }), null);
  assert.ok(pickEmote({ reaction: true, random: () => 0.99 }));
});

test('대표(사람): 사장실 가운데 책상의 주인, PM은 창가 책상에서 일하고 대표에게 보고하면 대표 책상 앞으로 간다', async () => {
  const { officeScene } = await import('../web/office/model.mjs');
  const agents = [agent('pm', 'working'), agent('boss', 'idle', 0, 'human'), agent('w', 'working'), agent('r', 'idle')];
  const order = agents.map((x) => x.author);
  const at = (scene, name) => { const item = scene.find((x) => x.author === name); return [item.room, item.spot, item.activity]; };
  const scene = officeScene({ agents, order, now: NOW, awayAfterMs: AWAY, pm: 'pm' });
  assert.deepEqual(at(scene, 'boss'), ['boss', 'chair', 'coffee'], '쉬어도 옥상이 아니라 자기 책상에서 커피');
  assert.equal(scene.find((x) => x.author === 'boss').ceo, true);
  assert.deepEqual(at(scene, 'pm'), ['boss', 'pm', 'typing']);
  assert.ok(!scene.some((x) => x.room === 'dev' && x.author === 'boss'), '대표는 개발실 책상을 차지하지 않는다');
  const events = [{ channel: 'general', author: 'pm', at: iso(10_000), to: ['boss'] }, { channel: 'general', author: 'w', at: iso(5000), to: ['boss'] }];
  const report = officeScene({ agents, order, events, now: NOW, awayAfterMs: AWAY, pm: 'pm' });
  assert.deepEqual(at(report, 'pm'), ['boss', 'v0', 'talking']);
  assert.deepEqual(at(report, 'w'), ['boss', 'v1', 'talking']);
  const gone = officeScene({ agents: [agent('pm', 'working'), agent('boss', 'idle', AWAY + 1, 'human')], order: ['pm', 'boss'], now: NOW, awayAfterMs: AWAY, pm: 'pm' });
  assert.equal(gone.find((x) => x.author === 'boss').spot, null);
  const self = officeScene({ agents: [agent('boss', 'working', 0, 'human')], order: ['boss'], now: NOW, awayAfterMs: AWAY, pm: 'boss' });
  assert.deepEqual(at(self, 'boss'), ['boss', 'chair', 'typing']);
});

test('세션이 많으면 개발실에 못 들어간 사람도 다른 층 빈자리에서 보인다(40명 모두 사무실에)', async () => {
  const { officeScene } = await import('../web/office/model.mjs');
  const { SIDE_ROOMS } = await import('../web/office/side-rooms.mjs');
  const states = ['working', 'working', 'working', 'reviewing', 'idle', 'idle', 'discussing', 'working'];
  const order = Array.from({ length: 40 }, (_, i) => `s${i}`);
  const agents = order.map((n, i) => agent(n, states[i % states.length]));
  const scene = officeScene({ agents, order, now: NOW, awayAfterMs: AWAY, lab: SIDE_ROOMS.lab, roof: SIDE_ROOMS.roof });
  assert.equal(scene.filter((item) => item.spot).length, 40, '40명 모두 자리가 있다');
  const taken = scene.map((item) => `${item.room}:${item.spot}`);
  assert.equal(new Set(taken).size, taken.length, '두 사람이 같은 자리에 겹치지 않는다');
  assert.ok(scene.some((item) => item.room === 'meeting' && item.activity === 'typing'), '넘친 사람은 회의실 빈 의자에서 일한다');
  assert.ok(!scene.some((item) => item.room === 'meeting' && ['board', 'ne'].includes(item.spot)), '회의실 화이트보드 앞은 비워 둔다');
  const extra = scene.filter((item) => item.room === 'meeting' && ['w', 'sw', 's', 'se', 'e'].includes(item.spot));
  assert.ok(extra.length && extra.every((item) => item.pose === 'sit'), '회의실 테이블이 차도 양옆 노트북 자리에 앉아 일한다');
});
