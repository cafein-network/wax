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
  const document = { hidden: false, documentElement: { lang: 'ko' }, getElementById() { return null; }, createElement: (tag) => new Element(tag),
    createTextNode(text) { const node = new Element('#text'); node.textContent = text; return node; } };
  class EventSource {
    constructor() { this.events = {}; streams.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    removeEventListener(name, callback) { if (this.events[name] === callback) delete this.events[name]; }
    close() { this.closed = true; }
  }
  const context = vm.createContext({ Node: Element, document, window: { addEventListener: (type, callback) => { events[type] = callback; } },
    EventSource, fetch, console, queueMicrotask, setInterval: (fn) => { timers.add(fn); return fn; }, clearInterval: (fn) => timers.delete(fn) });
  const dom = (await readFile(new URL('../web/dom.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const shared = (await readFile(new URL('../web/events.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const catalog = (await readFile(new URL('../web/messages-catalog.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const source = (await readFile(new URL('../web/approvals.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${dom}\n${catalog}\n${shared}\n${source}\nglobalThis.mount = mountApprovals;`, context);
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
    f.streams[0].events.error();
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

test('approval UI shows a collapsed change preview with counts, escaped diff lines and keeps it open across refreshes', async () => {
  const record = { ...request(), action: 'Write', details: { tool_name: 'Write', input: { file_path: '/project/a.html', content: '<script>alert(1)</script>' } },
    preview: { computedAt: Date.now(), files: [
      { path: 'a.html', state: 'modify', added: 1, removed: 2, lines: [['@', '@@ -1,2 +1,1 @@'], ['-', 'old'], ['-', 'older'], ['+', '<script>alert(1)</script>']], omitted: 3 },
      { path: '.env', none: 'sensitive' },
      { path: 'b.js', none: 'ambiguous', edit: 2, count: 3 }] } };
  const f = await fixture(async (path) => {
    if (path === '/api/config') return response({ token: 'token-1' });
    return response({ requests: [record], issues: [] });
  });
  try {
    const details = walk(f.root).find((node) => node.tag === 'details' && node.className === 'approval-preview');
    assert.ok(details);
    assert.equal(details.attributes.open, undefined, 'collapsed by default');
    assert.deepEqual([details.dataset.added, details.dataset.removed], ['1', '2']);
    assert.equal(walk(details).find((node) => node.tag === 'summary').textContent, '변경 미리보기 · 파일 3개 · +1 −2');
    const box = walk(details).find((node) => node.tag === 'pre');
    assert.equal(box.attributes.translate, 'no');
    assert.equal(walk(box).some((node) => node.tag === 'script'), false, 'diff text is never markup');
    assert.deepEqual(box.children.map((line) => [line.className, line.textContent]), [['d-hunk', '@@ -1,2 +1,1 @@\n'], ['d-del', '-old\n'], ['d-del', '-older\n'], ['d-add', '+<script>alert(1)</script>\n']]);
    assert.match(details.textContent, /… 3줄 더 있음/);
    assert.match(details.textContent, /\.env 미리보기 없음: \.git\/·\.wax\/chat\/·\.env\* 파일은 읽지 않습니다\./);
    assert.match(details.textContent, /2번째 고칠 글\(old_string\)이 지금 파일에 3곳 있어/);
    details.open = true; details.events.toggle({ target: details });
    record.expiresAt += 1000;
    await f.view.refresh();
    const again = walk(f.root).find((node) => node.tag === 'details' && node.className === 'approval-preview');
    assert.notEqual(again, details);
    assert.equal(again.attributes.open, '', 'an opened preview stays open after a refresh');
  } finally { f.view.stop(); }
});

test('approval UI sends an optional deny reason, keeps the draft across refreshes and shows it on the decided card', async () => {
  const claude = request(), codex = { ...request(), id: 'request-2', fingerprint: 'fingerprint-2', tool: 'codex', action: '명령 실행' };
  const bodies = [];
  const f = await fixture(async (path, options) => {
    if (path === '/api/config') return response({ token: 'token-1' });
    if (path === '/api/approvals') return response({ requests: [claude, codex], issues: [] });
    const body = JSON.parse(options.body); bodies.push([path, body]);
    const record = path.includes('request-1') ? claude : codex;
    Object.assign(record, { status: 'decided', decision: body.decision, decidedBy: '사람' },
      body.denyReason ? { denyReason: body.denyReason, denyReasonSent: record.tool === 'claude' } : {});
    return response(record);
  });
  const card = (id) => walk(f.root).find((node) => node.tag === 'article' && node.dataset.request === id);
  const field = (id) => walk(card(id)).find((node) => node.tag === 'details' && node.className === 'approval-deny-reason');
  try {
    const details = field('request-1');
    assert.equal(details.attributes.open, undefined, 'the reason field starts collapsed');
    assert.equal(walk(details).find((node) => node.tag === 'summary').textContent, '거부 이유 남기기(선택)');
    const input = walk(details).find((node) => node.tag === 'textarea');
    assert.equal(input.attributes.maxlength, '500');
    assert.equal(walk(details).find((node) => node.className?.includes('approval-deny-note')).dataset.delivered, 'true');
    assert.equal(walk(field('request-2')).find((node) => node.className?.includes('approval-deny-note')).textContent, '이유는 기록만 됨(이 도구에는 전달되지 않음)');
    details.open = true; details.events.toggle({ target: details });
    input.events.input({ target: { value: '  테스트 폴더 밖은 쓰지 마세요 ' } });
    claude.expiresAt += 1000; await f.view.refresh();
    const again = field('request-1');
    assert.notEqual(again, details);
    assert.equal(again.attributes.open, '');
    assert.equal(walk(again).find((node) => node.tag === 'textarea').value, '  테스트 폴더 밖은 쓰지 마세요 ', 'the draft survives a re-render');
    await walk(card('request-1')).find((node) => node.tag === 'button' && node.textContent === '거부').events.click();
    assert.deepEqual(bodies[0], ['/api/approvals/request-1/decision', { decision: 'deny', fingerprint: 'fingerprint-1', denyReason: '테스트 폴더 밖은 쓰지 마세요' }]);
    const shown = walk(card('request-1')).find((node) => node.className === 'approval-deny-reason-shown');
    assert.equal(walk(shown).find((node) => node.tag === 'q').attributes.translate, 'no');
    assert.match(shown.textContent, /^거부 이유: 테스트 폴더 밖은 쓰지 마세요$/);
    await walk(card('request-2')).find((node) => node.tag === 'button' && node.textContent === '거부').events.click();
    assert.deepEqual(bodies[1][1], { decision: 'deny', fingerprint: 'fingerprint-2' });
    assert.equal(walk(card('request-2')).find((node) => node.className === 'approval-deny-reason-shown'), undefined);
  } finally { f.view.stop(); }
});

test('approval UI marks a Codex deny reason as recorded only', async () => {
  const record = { ...request(), tool: 'codex', status: 'delivered', decision: 'deny', decidedBy: '사람', denyReason: '다른 폴더를 쓰세요', denyReasonSent: false };
  const f = await fixture(async (path) => response(path === '/api/config' ? { token: 'token-1' } : { requests: [record], issues: [] }));
  try {
    const shown = walk(f.root).find((node) => node.className === 'approval-deny-reason-shown');
    assert.equal(shown.dataset.sent, 'false');
    assert.match(shown.textContent, /거부 이유: 다른 폴더를 쓰세요 이유는 기록만 됨\(이 도구에는 전달되지 않음\)/);
  } finally { f.view.stop(); }
});

test('approval UI marks a command a worker should not run and still offers both decisions', async () => {
  const record = { ...request(), tool: 'copilot', action: 'Run a command', workerForbidden: { command: 'wax chat join' } };
  const f = await fixture(async (path) => response(path === '/api/config' ? { token: 'token-1' } : { requests: [record], issues: [] }));
  try {
    const note = walk(f.root).find((node) => node.className === 'approval-worker-forbidden');
    assert.equal(note.attributes.role, 'note');
    assert.match(note.textContent, /^작업자가 부를 일이 아닌 명령: .+ wax chat join$/);
    assert.equal(walk(note).find((node) => node.tag === 'code').attributes.translate, 'no');
    assert.ok(button(f.root, '이번만 허용') && button(f.root, '거부'), 'the person still decides');
    const plain = await fixture(async (path) => response(path === '/api/config' ? { token: 'token-1' } : { requests: [request()], issues: [] }));
    try { assert.equal(walk(plain.root).find((node) => node.className === 'approval-worker-forbidden'), undefined); } finally { plain.view.stop(); }
  } finally { f.view.stop(); }
});
