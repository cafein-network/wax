import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createChatServer } from '../src/chat/server.mjs';
import { cli, project } from './chat-helpers.mjs';

async function setup(t, features = ['chatbot']) {
  const root = await project(t, features);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '관리자' }, intervalMs: 100 });
  await server.startWatching();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  const post = (path, data, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': config.token, ...headers }, body: JSON.stringify(data) });
  return { root, server, base, config, post };
}

function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

async function nextEvent(base, name, match = () => true, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (event === name && data && match(JSON.parse(data))) return JSON.parse(data);
      }
    }
  } finally { clearTimeout(timer); controller.abort(); }
  throw new Error(`${name} 이벤트를 받지 못했습니다.`);
}

test('127.0.0.1에만 바인딩하고 API가 CLI와 같은 저장소를 쓴다 (AC6)', async (t) => {
  const { root, server, base, post } = await setup(t);
  assert.equal(server.address().address, '127.0.0.1');
  await cli(root, ['post', 'chatbot', '--author', 'claude-impl', '--kind', 'claude', '--message', 'CLI에서 씀']);
  const created = await post('/api/channels/chatbot/messages', { body: '웹에서 씀', type: 'opinion' });
  assert.equal(created.status, 201);
  const message = await created.json();
  assert.deepEqual([message.author, message.kind, message.type, message.phase], ['관리자', 'human', 'opinion', 'plan']);
  const { messages } = await (await fetch(`${base}/api/channels/chatbot/messages`)).json();
  assert.deepEqual(messages.map((m) => m.body), ['CLI에서 씀', '웹에서 씀']);
  const read = await cli(root, ['read', 'chatbot', '--json']);
  assert.equal(JSON.parse(read.stdout).messages.length, 2);
  const channels = await (await fetch(`${base}/api/channels`)).json();
  assert.deepEqual(channels.map((c) => [c.id, c.count]), [['general', 0], ['chatbot', 2]]);
});

test('호스트·출처·토큰을 검사하고 보안 헤더를 붙인다', async (t) => {
  const { server, base, post } = await setup(t);
  const port = server.address().port;
  assert.equal(await rawGet(port, '/api/channels', `evil.example:${port}`), 403);
  assert.equal(await rawGet(port, '/api/channels', `localhost:${port}`), 200);
  assert.equal((await post('/api/channels/chatbot/messages', { body: 'x' }, { 'x-chat-token': 'wrong' })).status, 403);
  assert.equal((await post('/api/channels/chatbot/messages', { body: 'x' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/channels/nope/messages', { body: 'x' })).status, 404);
  assert.equal((await post('/api/channels/chatbot/messages', { body: '' })).status, 400);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/office/side/..%2F..%2Fsrc%2Fserver.mjs`)).status, 404);
});

test('CLI로 쓴 메시지가 SSE로 전달된다 (AC7)', async (t) => {
  const { root, base } = await setup(t);
  const waiting = nextEvent(base, 'message', (data) => data.message.body === '<img src=x onerror=alert(1)>');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const posted = await cli(root, ['post', 'chatbot', '--author', 'codex', '--kind', 'codex', '--message', '<img src=x onerror=alert(1)>']);
  assert.equal(posted.code, 0, posted.stderr);
  const event = await waiting;
  assert.equal(event.channel, 'chatbot');
  assert.equal(event.message.author, 'codex');
});

test('노트·보고서·presence 이벤트와 보드 API (AC14, AC16, AC17)', async (t) => {
  const { root, base, post } = await setup(t);
  const noteEvent = nextEvent(base, 'note');
  const presenceEvent = nextEvent(base, 'presence');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const created = await post('/api/board/chatbot/notes', { type: 'question', body: '웹 질문' });
  assert.equal(created.status, 201);
  assert.equal((await noteEvent).note.body, '웹 질문');
  assert.ok((await presenceEvent).agents.some((a) => a.author === '관리자'));

  const before = await readdir(root);
  const digest = await (await fetch(`${base}/api/board/chatbot/digest`)).json();
  assert.match(digest.markdown, /## 미해결 질문[\s\S]*웹 질문/);
  assert.deepEqual(await readdir(root), before, 'digest 조회는 파일을 만들지 않는다');

  const reportEvent = nextEvent(base, 'report');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, 'r.md'), '# 요약\n결정 없음');
  const saved = await cli(root, ['board', 'report', 'chatbot', '--author', 'claude-impl', '--kind', 'claude', '--file', 'r.md']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal((await reportEvent).report.number, 1);
  const text = await fetch(`${base}/api/board/chatbot/reports/1`);
  assert.match(text.headers.get('content-type'), /text\/markdown/);
  assert.equal(await text.text(), '# 요약\n결정 없음\n');
  const board = await (await fetch(`${base}/api/board/chatbot`)).json();
  assert.deepEqual([board.notes.length, board.reports.length], [1, 1]);
  assert.equal((await fetch(`${base}/api/board/chatbot/reports/2`)).status, 404);
});

test('정적 파일: 채널·사무실 페이지와 생성된 에셋을 제공한다', async (t) => {
  const { base } = await setup(t);
  for (const path of ['/', '/chat', '/office', '/help', '/help.mjs', '/office/chatter.mjs', '/dashboard.mjs', '/app.mjs', '/dom.mjs', '/style.css', '/office/office.mjs', '/office/model.mjs', '/office/side/manifest.json', '/office/side/bg-dev.png', '/office/side/side-m01-front.png', '/office/side/side-m01-front-mask.png', '/office/side-render.mjs', '/office/paint.mjs']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
  }
  assert.match((await fetch(`${base}/office/office.mjs`)).headers.get('content-type'), /javascript/);
  const features = await (await fetch(`${base}/api/features`)).json();
  assert.deepEqual(features.map((f) => [f.id, f.phase]), [['chatbot', 'plan']]);
});

test('프로젝트 소개는 package.json description, 없으면 README 첫 소개 문단(로컬 파일만)', async (t) => {
  const { projectDescription } = await import('../src/chat/server.mjs');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await project(t);
  assert.equal(await projectDescription(root), null);
  await writeFile(join(root, 'README.md'), '# 상점\n\n[![ci](x)](y)\n\n작은 **온라인** [상점](https://example.com)입니다.\n\n- 목록\n');
  assert.equal(await projectDescription(root), '작은 온라인 상점입니다.');
  await writeFile(join(root, 'package.json'), JSON.stringify({ description: '패키지 설명' }));
  assert.equal(await projectDescription(root), '패키지 설명');
});
