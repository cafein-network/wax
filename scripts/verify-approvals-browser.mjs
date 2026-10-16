import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createChatServer } from '../src/chat/server.mjs';
import { createApproval, listApprovals, waitForApproval, finishDelivery } from '../src/approvals.mjs';

const modulePath = process.env.WAX_PUPPETEER_MODULE || process.argv[2];
if (!modulePath) throw new Error('WAX_PUPPETEER_MODULE 또는 첫 인수에 설치된 puppeteer 모듈 경로를 지정하세요.');
const { default: puppeteer } = await import(pathToFileURL(modulePath).href);
const root = await mkdtemp(join(tmpdir(), 'wax-approval-browser-'));
let server, browser;
try {
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, intervalMs: 50 });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('Starting headless browser…');
  browser = await puppeteer.launch({ headless: true, pipe: true, dumpio: process.env.WAX_BROWSER_DEBUG === '1', executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  console.log('Opening approvals page…');
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 950 });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/chat`);
  await page.waitForFunction(() => document.querySelector('#approvals')?.textContent.includes('대기 0개'));
  for (const decision of ['allow', 'deny']) {
    const pending = await createApproval(root, { tool: 'claude', session: 'browser-session', callId: decision, action: 'Bash',
      details: { command: 'npm test', cwd: root, note: '<img src=x onerror=alert(1)>' } });
    const selector = `[data-request="${pending.request.id}"]`;
    await page.waitForSelector(`${selector} button:not([disabled])`);
    assert.equal(await page.$eval(`${selector} .approval-details`, (el) => el.textContent.includes('<img')), true);
    assert.equal(await page.$(`${selector} img`), null, 'payload is text, never markup');
    if (decision === 'allow') {
      await page.reload();
      await page.waitForSelector(`${selector} button:not([disabled])`);
      if (process.env.WAX_APPROVAL_SCREENSHOT) await page.screenshot({ path: process.env.WAX_APPROVAL_SCREENSHOT, fullPage: true });
    }
    const received = waitForApproval(root, pending);
    await page.$eval(selector, (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label).click(), decision === 'allow' ? '이번만 허용' : '거부');
    assert.equal(await received, decision);
    await finishDelivery(root, pending.request.id, pending.secret);
    await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.textContent.includes('도구 연결에 응답 전달됨'), {}, pending.request.id);
    assert.equal(await page.$(`${selector} button`), null, 'closed requests cannot be approved again');
  }
  const expires = await createApproval(root, { tool: 'codex', session: 'browser-session', callId: 'expires', action: '명령 실행', details: { command: 'npm test' } }, { timeoutMs: 200 });
  await waitForApproval(root, expires, { pollMs: 30 });
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.textContent.includes('대기 만료'), {}, expires.request.id);
  assert.equal((await listApprovals(root)).requests.find((r) => r.id === expires.request.id).decision, undefined);
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile layout fits');
  assert.deepEqual(errors, []);
  console.log('PASS browser: allow, deny, delivered status, expiry, reload, literal payload, mobile width.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
