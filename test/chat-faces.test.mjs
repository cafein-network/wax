import test from 'node:test';
import assert from 'node:assert/strict';
import { assignPersonas } from '../web/office/faces.mjs';

const assets = {
  personas: ['ann', 'bob', 'cid', 'dee'],
  characters: { ann: { recolor: false }, bob: { recolor: true }, cid: { recolor: true }, dee: { recolor: false } },
  variants: { codex: { h: 170 } },
};

test('채팅 얼굴: 참여 순서와 상관없이 이름순으로 같은 캐릭터를 주고, 사람은 캐릭터를 받지 않는다', () => {
  const agents = [{ author: 'codex-app', kind: 'codex' }, { author: '사용자', kind: 'human' }, { author: 'claude-app', kind: 'claude' }, { author: 'claude-b', kind: 'claude' }];
  const a = assignPersonas(agents, assets), b = assignPersonas([...agents].reverse(), assets);
  assert.deepEqual([...a], [...b]);
  assert.equal(a.has('사용자'), false);
  assert.notEqual(a.get('claude-app').persona, a.get('claude-b').persona, '같은 화면에서 겹치지 않는다');
  assert.equal(assets.characters[a.get('codex-app').persona].recolor, true, 'claude가 아닌 도구는 재킷 색을 바꿀 수 있는 캐릭터');
  assert.deepEqual(a.get('codex-app').look, { jacket: { h: 170 } });
  assert.equal(assignPersonas(agents, null).size, 0);
});

test('채팅 얼굴: 지난 글쓴이는 참여자의 캐릭터를 비워 둔 채 정해, 서로 다른 사람에게 같은 얼굴을 주지 않는다', () => {
  const two = { ...assets, personas: ['ann', 'dee'] };
  const known = assignPersonas([{ author: 'z-active', kind: 'claude' }], two);
  const all = assignPersonas([{ author: 'a-retired-0', kind: 'claude' }], two, known);
  assert.equal(all.get('z-active').persona, known.get('z-active').persona, '참여자의 캐릭터는 그대로');
  assert.notEqual(all.get('a-retired-0').persona, all.get('z-active').persona);
});

test('사무실 배정: AI 세션을 먼저 정하고 사람은 그 뒤에 정해, AI 세션 얼굴은 채팅창과 같다', async () => {
  const { reservedFrom } = await import('../web/office/faces.mjs');
  const agents = [{ author: '대표', kind: 'human' }, { author: 'claude-app', kind: 'claude' }, { author: 'codex-app', kind: 'codex' }];
  const chat = assignPersonas(agents, assets);
  let office = assignPersonas(agents, assets);
  office = assignPersonas(agents, assets, office, { humans: true });
  for (const name of ['claude-app', 'codex-app']) assert.equal(office.get(name).persona, chat.get(name).persona);
  assert.ok(office.get('대표'), '사무실은 사람도 캐릭터로 그린다');
  assert.equal(new Set([...office.values()].map((f) => f.persona)).size, 3);
  const sent = [...office].map(([author, f]) => ({ author, persona: f.persona, kind: f.kind })).concat([{ author: 'x', persona: 'nope' }, null]);
  const reserved = reservedFrom(sent, assets);
  assert.deepEqual([...reserved.keys()].sort(), ['claude-app', 'codex-app', '대표'].sort());
  assert.deepEqual(assignPersonas(agents, assets, reserved).get('codex-app'), office.get('codex-app'));
});

test('리뷰 반영: 새 참여자가 들어와도 이미 정한 얼굴은 바뀌지 않고, 사무실 배정이 먼저다', async () => {
  const { keepFaces } = await import('../web/office/faces.mjs');
  const many = { ...assets, personas: ['ann', 'dee'] };
  let faces = assignPersonas([{ author: 'm-claude', kind: 'claude' }], many);
  const first = faces.get('m-claude').persona;
  faces = assignPersonas([{ author: 'a-claude', kind: 'claude' }, { author: 'm-claude', kind: 'claude' }], many, keepFaces(faces));
  assert.equal(faces.get('m-claude').persona, first);
  assert.notEqual(faces.get('a-claude').persona, first);
  const office = new Map([['a-claude', { persona: first, kind: 'claude', look: null }]]);
  const merged = assignPersonas([{ author: 'a-claude', kind: 'claude' }, { author: 'm-claude', kind: 'claude' }], many, keepFaces(faces, office));
  assert.equal(merged.get('a-claude').persona, first);
  assert.notEqual(merged.get('m-claude').persona, first);
});

test('리뷰 반영: 도구 종류가 바뀌면 캐릭터는 그대로 두고 재킷 색만 지금 종류로 바꾼다', () => {
  const first = assignPersonas([{ author: 'codex-app', kind: 'codex' }], assets);
  const persona = first.get('codex-app').persona;
  const now = assignPersonas([{ author: 'codex-app', kind: 'gemini' }], assets, first);
  assert.equal(now.get('codex-app').persona, persona);
  assert.equal(now.get('codex-app').kind, 'gemini');
  assert.deepEqual(now.get('codex-app').look, null, '변형이 없는 종류는 원래 색(테스트 자료에는 gemini 변형이 없다)');
});
