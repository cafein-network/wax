import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createEventHub } from '../src/chat/event-hub.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { project } from './chat-helpers.mjs';

const client = () => ({ frames: [], writableLength: 0, write(frame) { this.frames.push(frame); }, end(frame) { this.ended = frame ?? true; }, destroy() { this.destroyed = true; } });
const ids = (res) => res.frames.map((frame) => /^id: (\S+)/.exec(frame)?.[1]).filter(Boolean);
const types = (res) => res.frames.map((frame) => /event: (\S+)/.exec(frame)?.[1]).filter(Boolean);

test('events carry ids; a reconnecting tab gets what it missed, or resync when that is gone', () => {
  const hub = createEventHub({ replay: 3 });
  const first = client();
  hub.connect(first);
  for (const n of [1, 2, 3, 4, 5]) hub.broadcast('message', { n });
  const seen = ids(first);
  assert.equal(seen.length, 5);
  assert.match(seen[0], /^[a-f0-9]{8}-1$/);
  const recent = client();
  hub.connect(recent, seen[2]);
  assert.deepEqual(ids(recent), seen.slice(3), 'events after the last one seen are replayed');
  const current = client();
  hub.connect(current, seen[4]);
  assert.deepEqual(types(current), [], 'nothing missed, nothing sent');
  for (const last of [seen[0], 'ffffffff-4', 'garbage', `${seen[0].split('-')[0]}-99`]) {
    const stale = client();
    hub.connect(stale, last);
    assert.deepEqual(types(stale), ['resync'], last);
  }
  assert.equal(client().frames.length, 0);
});

test('a tab that stops reading is dropped instead of buffering forever, and the cap evicts the oldest', () => {
  const hub = createEventHub({ backlogBytes: 100, maxClients: 2 });
  const slow = client(), fast = client();
  hub.connect(slow); hub.connect(fast);
  slow.writableLength = 101;
  hub.broadcast('message', { n: 1 });
  assert.equal(slow.destroyed, true);
  assert.equal(hub.size, 1);
  assert.equal(ids(fast).length, 1);
  hub.ping();
  assert.equal(fast.frames.at(-1), ': ping\n\n');
  const third = client(), fourth = client();
  hub.connect(third); hub.connect(fourth);
  assert.equal(fast.ended, 'retry: 30000\n\n');
  const leave = hub.connect(client());
  leave();
  hub.close();
  assert.equal(hub.size, 0);
});

test('the dashboard stream sends ids and replays a missed channel message after reconnecting', async (t) => {
  const root = await project(t);
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, intervalMs: 50 });
  await server.startWatching();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (headers = {}, until) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    const timer = setTimeout(() => controller.abort(), 5000);
    try { while (!until(text)) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); } }
    catch {   } finally { clearTimeout(timer); controller.abort(); }
    return text;
  };
  const live = read({}, (text) => /event: message/.test(text));
  await new Promise((done) => setTimeout(done, 200));
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '첫 메시지' });
  const first = await live;
  const lastId = /id: (\S+)\nevent: message/.exec(first)[1];
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '끊긴 사이 메시지' });
  await new Promise((done) => setTimeout(done, 300));
  const again = await read({ 'last-event-id': lastId }, (text) => /끊긴 사이 메시지/.test(text));
  assert.match(again, /끊긴 사이 메시지/);
  const restarted = await read({ 'last-event-id': '00000000-1' }, (text) => /event: resync/.test(text));
  assert.match(restarted, /event: resync/);
});
