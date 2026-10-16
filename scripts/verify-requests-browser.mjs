import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-request-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR || process.argv[4];
let server, browser, executions = 0;
try {
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, requestTools: async () => ['codex', 'claude', 'gemini', 'copilot', 'antigravity'].map((id) => ({ id, label: id, installed: id !== 'gemini' })), executeRequest: async (root, { signal, tool }) => {
    assert.equal(tool, 'claude');
    executions++;
    if (executions === 1) return { threadId: 'browser-thread', message: JSON.stringify({ outcome: 'question', report: '어떤 화면에서 발생하나요? <img src=x onerror=alert(1)>', document: '', evidence: '', proofIds: [] }) };
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); });
  } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.waitForSelector('#connection[data-online="true"]');
  assert.equal(executions, 0);
  await page.selectOption('#request-tool', 'gemini');
  assert.equal(await page.locator('#send').isDisabled(), true);
  await page.selectOption('#request-tool', 'claude');
  assert.equal(await page.locator('#approvals').isVisible(), false);
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'requests-desktop.png'), fullPage: true }); }
  await page.getByRole('button', { name: /오류 찾아 고치기/ }).click();
  assert.match(await page.inputValue('#request-body'), /오류/);
  await page.locator('#request-body').fill('회원가입을 고쳐줘');
  await page.locator('#request-body').press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#request-status').textContent === '답변 필요');
  assert.match(await page.textContent('#conversation'), /어떤 화면/);
  assert.equal(await page.locator('#conversation img').count(), 0);
  assert.equal(await page.locator('#requests li').count(), 1);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#request-status').textContent === '답변 필요');
  assert.equal(await page.inputValue('#request-tool'), 'claude');
  assert.equal(await page.locator('#request-tool').isDisabled(), true);
  assert.equal(executions, 1, 'reload never starts an AI job');
  await page.fill('#request-body', '모바일 가입 화면이야');
  await page.click('#send');
  await page.waitForFunction(() => document.querySelector('#request-status').textContent === '진행 중');
  assert.equal(executions, 2);
  await page.click('#stop');
  await page.waitForFunction(() => document.querySelector('#request-status').textContent === '일시 중지');
  await page.click('#new-request');
  assert.equal(await page.locator('#conversation article').count(), 0);
  await page.fill('#request-body', '새 요청의 작성 중 내용');
  await page.locator('#requests button').first().click();
  assert.equal(await page.inputValue('#request-body'), '');
  assert.equal(await page.locator('#conversation .user-message').count(), 2);
  assert.match(await page.textContent('#conversation'), /모바일 가입/);
  await page.click('#new-request');
  assert.equal(await page.inputValue('#request-body'), '새 요청의 작성 중 내용');
  await page.locator('#requests button').first().click();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px: no horizontal overflow`);
  }
  if (screenshots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, 'requests-mobile.png'), fullPage: true });
  }
  await page.goto(base + '/manage');
  await page.waitForSelector('#assign-to', { state: 'attached' });
  assert.equal(await page.locator('#assign-to').evaluate((el) => el.tagName), 'SELECT');
  assert.deepEqual(errors, []);
  console.log('PASS: one-line request, question/reply, stop, reload, selection, safe text, desktop/tablet/mobile, detailed view.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
