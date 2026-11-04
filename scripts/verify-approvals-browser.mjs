import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createChatServer } from '../src/chat/server.mjs';
import { createApproval, decideApproval, listApprovals, waitForApproval, finishDelivery, cancelApproval } from '../src/approvals.mjs';

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
  browser = await puppeteer.launch({ headless: true, pipe: true, dumpio: process.env.WAX_BROWSER_DEBUG === '1', executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3], args: process.env.WAX_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  console.log('Opening approvals page…');
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('wax.language', 'ko'));
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
    if (decision === 'deny') {
      assert.equal(await page.$eval(`${selector} .approval-deny-reason`, (el) => el.open), false, 'the reason field starts collapsed');
      await page.$eval(`${selector} .approval-deny-reason summary`, (el) => el.click());
      assert.equal(await page.$eval(`${selector} .approval-deny-note`, (el) => el.dataset.delivered), 'true');
      await page.waitForSelector(`${selector} .approval-deny-input`, { visible: true });
      await page.type(`${selector} .approval-deny-input`, '테스트 폴더 밖은 쓰지 마세요');
      const other = await createApproval(root, { tool: 'claude', session: 'browser-session', callId: 'other', action: 'Bash', details: { command: 'ls' } });
      await page.waitForSelector(`[data-request="${other.request.id}"]`);
      assert.equal(await page.$eval(`${selector} .approval-deny-input`, (el) => el.value), '테스트 폴더 밖은 쓰지 마세요', 'draft survives a re-render');
      assert.equal(await page.$eval(`${selector} .approval-deny-reason`, (el) => el.open), true);
      await page.$eval(`${selector} .approval-deny-input`, (el) => { el.value += '\u202e!'; el.dispatchEvent(new Event('input')); });
      await cancelApproval(root, other.request.id, other.secret);
    }
    const received = waitForApproval(root, pending);
    await page.$eval(selector, (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label).click(), decision === 'allow' ? '이번만 허용' : '거부');
    assert.equal(await received, decision);
    await finishDelivery(root, pending.request.id, pending.secret);
    await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.textContent.includes('도구 연결에 응답 전달됨'), {}, pending.request.id);
    assert.equal(await page.$(`${selector} button`), null, 'closed requests cannot be approved again');
    const saved = (await listApprovals(root)).requests.find((r) => r.id === pending.request.id);
    if (decision === 'deny') {
      assert.equal(saved.denyReason, '테스트 폴더 밖은 쓰지 마세요!'); assert.equal(saved.denyReasonSent, true);
      assert.equal(await page.$eval(`${selector} .approval-deny-reason-shown q`, (el) => el.textContent), '테스트 폴더 밖은 쓰지 마세요!');
    } else assert.equal(saved.denyReason, undefined);
  }
  const expires = await createApproval(root, { tool: 'codex', session: 'browser-session', callId: 'expires', action: '명령 실행', details: { command: 'npm test' } }, { timeoutMs: 200 });
  await waitForApproval(root, expires, { pollMs: 30 });
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.textContent.includes('대기 만료'), {}, expires.request.id);
  assert.equal((await listApprovals(root)).requests.find((r) => r.id === expires.request.id).decision, undefined);
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile layout fits');
  assert.deepEqual(errors, []);
  const english = await browser.newPage();
  await english.evaluateOnNewDocument(() => localStorage.setItem('wax.language', 'en'));
  await english.setViewport({ width: 390, height: 844 });
  english.on('pageerror', (error) => errors.push(error.message));
  await english.goto(`${base}/chat`);
  const codex = await createApproval(root, { tool: 'codex', session: 'browser-session', callId: 'codex-deny', action: '명령 실행', details: { command: 'rm -rf build' } });
  const codexCard = `[data-request="${codex.request.id}"]`;
  await english.waitForSelector(`${codexCard} button:not([disabled])`);
  assert.equal(await english.$eval(`${codexCard} .approval-deny-reason summary`, (el) => el.textContent), 'Add a reason for denying (optional)');
  await english.$eval(`${codexCard} .approval-deny-reason summary`, (el) => el.click());
  assert.equal(await english.$eval(`${codexCard} .approval-deny-note`, (el) => el.textContent), 'Reason is recorded only (not delivered to this tool)');
  await english.waitForSelector(`${codexCard} .approval-deny-input`, { visible: true });
  await english.type(`${codexCard} .approval-deny-input`, 'Use the fixture folder instead');
  assert.equal(await english.$eval(`${codexCard} .approval-deny-input`, (el) => el.value), 'Use the fixture folder instead');
  assert.equal(await english.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'reason field fits 390px');
  if (process.env.WAX_APPROVAL_SCREENSHOT) await english.screenshot({ path: process.env.WAX_APPROVAL_SCREENSHOT.replace(/(\.png)?$/, '-reason.png'), fullPage: true });
  const declined = waitForApproval(root, codex);
  await english.$eval(codexCard, (card) => [...card.querySelectorAll('button')].find((b) => b.textContent === 'Deny').click());
  assert.equal(await declined, 'deny');
  await finishDelivery(root, codex.request.id, codex.secret);
  await english.waitForFunction((id) => document.querySelector(`[data-request="${id}"] .approval-deny-reason-shown`)?.textContent.includes('recorded only'), {}, codex.request.id);
  assert.equal(await english.$eval(`${codexCard} .approval-deny-reason-shown q`, (el) => el.textContent), 'Use the fixture folder instead');
  const codexSaved = (await listApprovals(root)).requests.find((r) => r.id === codex.request.id);
  assert.equal(codexSaved.denyReason, 'Use the fixture folder instead'); assert.equal(codexSaved.denyReasonSent, false);
  assert.equal(await english.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'decided card fits 390px');
  const repeatKey = 'b'.repeat(64);
  const repeatBase = { tool: 'claude', session: 'repeat-session', action: 'Bash', details: { input: { command: 'npm test -- --watch' } }, repeatKey };
  for (const [n, decision] of [[1, 'allow'], [2, 'deny']]) {
    const earlier = await createApproval(root, { ...repeatBase, callId: `repeat-${n}`, repeat: n });
    assert.equal(earlier.request.repeat, n);
    const decided = waitForApproval(root, earlier, { pollMs: 30 });
    await decideApproval(root, earlier.request.id, { decision, fingerprint: earlier.request.fingerprint, actor: '대표' });
    assert.equal(await decided, decision);
    await finishDelivery(root, earlier.request.id, earlier.secret);
  }
  const third = await createApproval(root, { ...repeatBase, callId: 'repeat-3', repeat: 3 });
  const thirdCard = `[data-request="${third.request.id}"]`;
  await page.waitForSelector(`${thirdCard} .approval-repeat-badge`);
  assert.equal(await page.$eval(`${thirdCard} .approval-repeat-badge`, (el) => el.textContent), '같은 요청 3번째');
  assert.equal(await page.$eval(`${thirdCard} .approval-repeat-previous`, (el) => el.textContent), '이전 같은 요청: 거부 · 대표');
  assert.equal(await page.$(`${thirdCard} button.primary:not([disabled])`) !== null, true, 'the person still decides');
  assert.equal(await page.$$eval('.approval-repeat-badge', (els) => els.length), 1);
  await english.waitForSelector(`${thirdCard} .approval-repeat-badge`);
  assert.equal(await english.$eval(`${thirdCard} .approval-repeat-badge`, (el) => el.textContent), 'Same request #3');
  assert.equal(await english.$eval(`${thirdCard} .approval-repeat-previous`, (el) => el.textContent), 'Previous same request: denied · CEO');
  assert.match(await english.$eval(`${thirdCard} .approval-repeat`, (el) => el.textContent), /sent the same request 3 times in this run/);
  assert.equal(await english.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'repeat card fits 390px');
  if (process.env.WAX_APPROVAL_SCREENSHOT) await english.screenshot({ path: process.env.WAX_APPROVAL_SCREENSHOT.replace(/(\.png)?$/, '-repeat.png'), fullPage: true });
  await cancelApproval(root, third.request.id, third.secret);
  const forbidden = await createApproval(root, { tool: 'copilot', session: 'forbidden-session', callId: 'forbidden', action: 'Run a command', goal: 'goal-0000000f',
    details: { sessionId: 'forbidden-session', options: [], toolCall: { toolCallId: 'c', title: 'Run a command', kind: 'execute', rawInput: { command: 'node E:/project/wax/bin/wax.mjs chat join --author wax-worker-copilot' } } } });
  const forbiddenCard = `[data-request="${forbidden.request.id}"]`;
  for (const [language, label, allowLabel] of [['ko', /^작업자가 부를 일이 아닌 명령: .+ wax chat join$/, '이번만 허용'], ['en', /^Not a command a worker should run: .+ wax chat join$/, 'Allow this time only']]) {
    const once = await browser.newPage();
    try {
      await once.evaluateOnNewDocument((value) => localStorage.setItem('wax.language', value), language);
      await once.setViewport({ width: 390, height: 844 });
      once.on('pageerror', (error) => errors.push(error.message));
      await once.goto(`${base}/chat`);
      await once.waitForSelector(`${forbiddenCard} .approval-worker-forbidden`);
      assert.match(await once.$eval(`${forbiddenCard} .approval-worker-forbidden`, (el) => el.textContent), label);
      assert.equal(await once.$eval(forbiddenCard, (card, text) => [...card.querySelectorAll('button')].some((b) => b.textContent === text && !b.disabled), allowLabel), true, 'the person still decides');
      assert.equal(await once.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `worker-forbidden card fits 390px (${language})`);
      if (process.env.WAX_APPROVAL_SCREENSHOT) await once.screenshot({ path: process.env.WAX_APPROVAL_SCREENSHOT.replace(/(\.png)?$/, `-forbidden-${language}.png`), fullPage: true });
    } finally { await once.close(); }
  }
  assert.equal((await listApprovals(root)).requests.find((r) => r.id === forbidden.request.id).status, 'pending', 'not denied or allowed automatically');
  await cancelApproval(root, forbidden.request.id, forbidden.secret);
  assert.deepEqual(errors, []);
  console.log('PASS browser: allow, deny with reason (draft kept, control characters removed), Codex record-only reason in English at 390px, delivered status, expiry, reload, literal payload, mobile width, "same request 3rd time" with the previous decision, "not a command a worker should run" in Korean and English at 390px.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
