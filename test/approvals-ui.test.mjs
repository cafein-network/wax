import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.events = {}; this.attributes = {}; this.text = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'disabled') this.disabled = true; }
  addEventListener(type, callback) { this.events[type] = callback; }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
}
const walk = (node) => [node, ...node.children.flatMap(walk)];
const button = (root, label) => walk(root).find((node) => node.tag === 'button' && node.textContent === label);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const request = () => ({ id: 'request-1', fingerprint: 'fingerprint-1', tool: 'claude', action: 'Bash', session: 'session-1',
  callId: 'call-1', project: '/project', expiresAt: Date.now() + 120_000, status: 'pending', details: { command: '<img src=x onerror=alert(1)>' } });

async function fixture(fetch) {
  const events = {}, streams = [], timers = new Set();
  const document = { hidden: false, getElementById() { return null; }, createElement: (tag) => new Element(tag),
    createTextNode(text) { const node = new Element('#text'); node.textContent = text; return node; } };
  class EventSource {
    constructor() { this.events = {}; streams.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({ Node: Element, document, window: { addEventListener: (type, callback) => { events[type] = callback; } },
    EventSource, fetch, console, queueMicrotask, setInterval: (fn) => { timers.add(fn); return fn; }, clearInterval: (fn) => timers.delete(fn) });
  const dom = (await readFile(new URL('../web/dom.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const source = (await readFile(new URL('../web/approvals.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/m, '').replace(/^export /gm, '');
  vm.runInContext(`${dom}\n${source}\nglobalThis.mount = mountApprovals;`, context);
  const root = new Element('section'), view = context.mount(root);
  await tick();
  return { root, view, events, streams, timers };
}
const response = (value) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => structuredClone(value) });

test('approval UI submits one exact decision and reconciles a lost HTTP response without replay', async () => {
  const record = request(); let posts = 0, release;
  const f = await fixture(async (path, options) => {
    if (path === '/api/config') return response({ token: 'token-1' });
    if (path === '/api/approvals') return response({ requests: [record], issues: [] });
    posts++;
    assert.equal(options.headers['x-chat-token'], 'token-1');
    assert.deepEqual(JSON.parse(options.body), { decision: 'allow', fingerprint: record.fingerprint });
    await new Promise((resolve) => { release = resolve; });
    record.status = 'decided'; record.decision = 'allow';
    throw new Error('response lost');
  });
  try {
    assert.match(f.root.textContent, /<img/);
    assert.equal(walk(f.root).some((node) => node.tag === 'img'), false);
    const allow = button(f.root, '이번만 허용');
    const first = allow.events.click();
    assert.equal(button(f.root, '이번만 허용').disabled, true);
    await allow.events.click();
    assert.equal(posts, 1, 'double click must not post twice');
    release(); await first;
    assert.match(f.root.textContent, /응답 전달 대기/);
    assert.equal(button(f.root, '이번만 허용'), undefined);
    await f.view.refresh();
    assert.equal(posts, 1, 'refresh must not replay a saved decision');
  } finally { f.view.stop(); }
});

test('approval UI disables offline actions, reloads server tokens and rejects stale page snapshots', async () => {
  const record = request(); let token = 'old-token', block = false, release;
  const f = await fixture(async (path, options) => {
    if (path === '/api/config') return response({ token });
    if (path === '/api/approvals') {
      if (block) { block = false; await new Promise((resolve) => { release = resolve; }); }
      return response({ requests: [record], issues: [] });
    }
    assert.equal(options.headers['x-chat-token'], 'new-token', 'restart requires a fresh server token');
    record.status = 'decided'; record.decision = 'deny'; return response(record);
  });
  try {
    f.streams[0].onerror();
    assert.equal(button(f.root, '이번만 허용').disabled, true);
    token = 'new-token'; await f.view.refresh();
    assert.ok(!button(f.root, '이번만 허용').disabled);
    block = true; const refreshing = f.view.refresh(); await tick();
    f.events.pagehide(); release(); await refreshing;
    assert.equal(button(f.root, '이번만 허용').disabled, true, 'stopped page cannot become online from an old response');
    f.events.pageshow({ persisted: true }); await tick();
    assert.equal(f.streams.length, 2); assert.equal(f.streams[0].closed, true); assert.equal(f.timers.size, 1);
    await button(f.root, '거부').events.click();
    assert.match(f.root.textContent, /요청 거부/);
  } finally { f.view.stop(); }
});
