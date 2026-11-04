import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createChatServer } from '../src/chat/server.mjs';
import { createApproval } from '../src/approvals.mjs';

const modulePath = process.env.WAX_PUPPETEER_MODULE || process.argv[2];
if (!modulePath) throw new Error('WAX_PUPPETEER_MODULE 또는 첫 인수에 설치된 puppeteer 모듈 경로를 지정하세요.');
const { default: puppeteer } = await import(pathToFileURL(modulePath).href);
const root = await realpath(await mkdtemp(join(tmpdir(), 'wax-approval-diff-')));
let server, browser;
try {
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'sum.js'), `export function sumTo(n) {\n  let total = 0;\n  for (let i = 0; i < n; i++) total += i;\n  return total;\n}\n// ${'long comment '.repeat(30)}\n`);
  await writeFile(join(root, '.env'), 'TOKEN=secret\n');
  const edit = await createApproval(root, { tool: 'claude', session: 'diff-session', callId: 'edit', action: 'Edit',
    details: { tool_name: 'Edit', input: { file_path: join(root, 'src', 'sum.js'), old_string: 'i < n; i++', new_string: 'i <= n; i++' } } });
  const markup = await createApproval(root, { tool: 'claude', session: 'diff-session', callId: 'write', action: 'Write',
    details: { cwd: root, tool: 'Write', input: { file_path: 'src/page.html', content: '<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n' } } });
  const env = await createApproval(root, { tool: 'claude', session: 'diff-session', callId: 'env', action: 'Write',
    details: { tool_name: 'Write', input: { file_path: join(root, '.env'), content: 'TOKEN=changed\n' } } });
  const codex = await createApproval(root, { tool: 'codex', session: 'diff-thread', callId: 'patch', action: '파일 변경',
    details: { threadId: 'diff-thread', turnId: 't', itemId: 'patch', cwd: root, item: { changes: [{ path: join(root, 'src', 'sum.js'), kind: { type: 'update', move_path: null },
      diff: '@@ -1,2 +1,2 @@\n-export function sumTo(n) {\n+export function sumTo(n = 0) {\n   let total = 0;\n' }] } } });

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, intervalMs: 50 });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, pipe: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3], args: process.env.WAX_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const errors = [];
  const open = async (language, width) => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((value) => localStorage.setItem('wax.language', value), language);
    await page.setViewport({ width, height: 900 });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/manage`);
    await page.waitForSelector(`#approvals [data-request="${codex.request.id}"] .approval-preview`);
    return page;
  };
  const card = (id) => `#approvals [data-request="${id}"]`;

  const page = await open('ko', 1200);
  const summary = (id) => page.$eval(`${card(id)} .approval-preview > summary`, (node) => node.textContent);
  assert.equal(await summary(edit.request.id), '변경 미리보기 · 파일 1개 · +1 −1');
  assert.equal(await summary(markup.request.id), '변경 미리보기 · 파일 1개 · +2 −0');
  assert.equal(await summary(env.request.id), '변경 미리보기 · 파일 1개 · 미리보기 없음');
  assert.equal(await summary(codex.request.id), '변경 미리보기 · 파일 1개 · +1 −1');
  assert.equal(await page.$eval(`${card(edit.request.id)} .approval-preview`, (node) => node.open), false, 'collapsed by default');
  assert.equal(await page.$eval(`${card(edit.request.id)} .approval-diff`, (node) => node.checkVisibility()), false, 'the diff is hidden while collapsed');
  for (const request of [edit, markup, env, codex]) await page.click(`${card(request.request.id)} .approval-preview > summary`);
  assert.deepEqual(await page.$$eval(`${card(edit.request.id)} .approval-diff > span`, (nodes) => nodes.map((node) => `${node.className}|${node.textContent.trimEnd()}`)).then((lines) => lines.filter((line) => !line.startsWith('d-ctx'))),
    ['d-hunk|@@ -1,6 +1,6 @@', 'd-del|-  for (let i = 0; i < n; i++) total += i;', 'd-add|+  for (let i = 0; i <= n; i++) total += i;']);
  assert.equal(await page.$eval(`${card(edit.request.id)} .approval-preview`, (node) => node.open), true);
  const markupLines = await page.$$eval(`${card(markup.request.id)} .approval-diff > span`, (nodes) => nodes.map((node) => node.textContent.trimEnd()));
  assert.deepEqual(markupLines.slice(1), ['+<img src=x onerror=alert(1)>', '+<script>alert(2)</script>']);
  assert.equal(await page.$(`${card(markup.request.id)} .approval-preview img`), null, 'diff text is never markup');
  assert.equal(await page.$(`${card(markup.request.id)} .approval-preview script`), null);
  assert.match(await page.$eval(`${card(env.request.id)} .approval-preview`, (node) => node.textContent), /\.env 미리보기 없음: \.git\/·\.wax\/chat\/·\.env\* 파일은 읽지 않습니다\./);
  assert.match(await page.$eval(`${card(codex.request.id)} .approval-preview`, (node) => node.textContent), /도구가 보낸 변경[\s\S]*지금 파일로 계산함/);
  await page.evaluate(() => [...document.querySelectorAll('#approvals button')].find((node) => node.textContent === '새로고침').click());
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(await page.$eval(`${card(edit.request.id)} .approval-preview`, (node) => node.open), true, 'stays open after a refresh');

  const phone = await open('ko', 390);
  await phone.click(`${card(edit.request.id)} .approval-preview > summary`);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, '390px: no page horizontal scroll');
  const box = await phone.$eval(`${card(edit.request.id)} .approval-diff`, (node) => ({ scroll: node.scrollWidth, client: node.clientWidth, right: node.getBoundingClientRect().right }));
  assert.ok(box.scroll > box.client, 'the long line scrolls inside the diff box');
  assert.ok(box.right <= 390, 'the diff box fits the phone width');

  const english = await open('en', 1200);
  assert.equal(await english.$eval(`${card(edit.request.id)} .approval-preview > summary`, (node) => node.textContent), 'Change preview · 1 files · +1 −1');
  await english.click(`${card(env.request.id)} .approval-preview > summary`);
  assert.match(await english.$eval(`${card(env.request.id)} .approval-preview`, (node) => node.textContent), /No preview: \.git\/, \.wax\/chat\/ and \.env\* files are not read\.[\s\S]*Computed at .* from the current file/);
  await english.click(`${card(codex.request.id)} .approval-preview > summary`);
  assert.match(await english.$eval(`${card(codex.request.id)} .approval-preview`, (node) => node.textContent), /Change sent by the tool/);
  assert.equal(await english.$eval(`${card(edit.request.id)} .approval-diff`, (node) => node.textContent.includes('i <= n')), true, 'diff text is not translated');
  assert.deepEqual(errors, []);
  console.log('PASS approval diff browser: collapsed counts, expand, literal markup, no-preview reason, stays open, 390px, English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
