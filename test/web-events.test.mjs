import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function page(parent) {
  const streams = [];
  class EventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); streams.push(this); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type) { for (const listener of this.listeners.get(type) ?? []) listener({ type }); }
    count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
    close() { this.readyState = 2; }
  }
  const window = {};
  if (parent) window.parent = parent;
  window.window = window;
  const context = vm.createContext({ window, EventSource, Event: class { constructor(type) { this.type = type; } }, queueMicrotask });
  const source = (await readFile(new URL('../web/events.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.openEvents = openEvents;`, context);
  return { window, streams, openEvents: context.openEvents };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('modules on one page share a single event stream and close it with the last user', async () => {
  const p = await page();
  const a = p.openEvents(), b = p.openEvents();
  assert.equal(p.streams.length, 1);
  assert.equal(p.streams[0].url, '/api/events');
  const seen = [];
  a.addEventListener('approvals', () => seen.push('a'));
  b.addEventListener('approvals', () => seen.push('b'));
  b.onerror = () => seen.push('b-error');
  p.streams[0].emit('approvals'); p.streams[0].emit('error');
  assert.deepEqual(seen, ['a', 'b', 'b-error']);
  a.close(); a.close();
  assert.equal(p.streams[0].readyState, 0, 'the stream stays open while another module listens');
  assert.equal(p.streams[0].count(), 2, 'closing removes only that handle\'s listeners');
  b.close();
  assert.equal(p.streams[0].readyState, 2);
  p.openEvents();
  assert.equal(p.streams.length, 2, 'a later user opens a fresh stream');
});

test('a late subscriber hears that the shared stream is already open', async () => {
  const p = await page();
  const first = p.openEvents();
  p.streams[0].readyState = 1;
  const late = p.openEvents(); let opened = 0;
  late.onopen = () => { opened++; };
  await tick();
  assert.equal(opened, 1);
  const closed = p.openEvents(); let missed = 0;
  closed.onopen = () => { missed++; };
  closed.close(); await tick();
  assert.equal(missed, 0, 'a handle closed before the microtask stays silent');
  first.close(); late.close();
});

test('assigning onopen or onerror again replaces the previous listener, like EventSource', async () => {
  const p = await page();
  const handle = p.openEvents(), seen = [];
  handle.onerror = () => seen.push('first');
  handle.onerror = () => seen.push('second');
  handle.addEventListener('error', () => seen.push('added'));
  p.streams[0].emit('error');
  assert.deepEqual(seen, ['second', 'added']);
  handle.onerror = null;
  p.streams[0].emit('error');
  assert.deepEqual(seen, ['second', 'added', 'added'], 'null clears only the property listener');
  handle.close();
  assert.equal(p.streams[0].count(), 0, 'close removes everything that is left');
});

test('a same-origin frame reuses its parent page stream', async () => {
  const top = await page();
  const parentHandle = top.openEvents();
  const frame = await page(top.window);
  const frameHandle = frame.openEvents();
  assert.equal(frame.streams.length, 0);
  assert.equal(top.window.__waxEvents.users, 2);
  frameHandle.close(); parentHandle.close();
  assert.equal(top.streams[0].readyState, 2);
});
