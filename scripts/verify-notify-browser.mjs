import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { createApproval } from '../src/approvals.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];

const root = await mkdtemp(join(tmpdir(), 'wax-notify-'));
await createFeature(root, { id: 'login', title: '이메일 로그인' });
await postMessage(root, 'general', { author: 'claude-1', kind: 'claude', type: 'question', body: '예전 질문' });
const old = await createApproval(root, { tool: 'claude', session: 's-old', callId: 'c-old', action: 'Bash', details: { command: 'ls' } });

const recorder = ({ permission, supported }) => {
  window.__notices = []; window.__asked = 0; window.__permission = sessionStorage.getItem('test.permission') ?? permission;
  if (!supported) { delete window.Notification; return; }
  window.Notification = class {
    constructor(title, options = {}) { Object.assign(this, { title, ...options }); window.__notices.push(this); }
    close() {}
    static get permission() { return window.__permission; }
    static async requestPermission() { window.__asked++; window.__permission = 'granted'; sessionStorage.setItem('test.permission', 'granted'); return 'granted'; }
  };
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.hasFocus = () => !hidden;
  window.__setHidden = (value) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); if (!value) window.dispatchEvent(new Event('focus')); };
};

const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 50 });
await server.startWatching();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await browserType.launch({ executablePath: chromium });
const errors = [];
const pageWith = async (options, { lang = 'ko' } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.grantPermissions(['notifications'], { origin: base });
  await context.addInitScript(recorder, options);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?lang=${lang}`);
  await page.locator('.notify-toggle').waitFor();
  return page;
};
const notices = (page) => page.evaluate(() => window.__notices.map((n) => ({ title: n.title, body: n.body, tag: n.tag })));
const settle = (page) => page.waitForTimeout(400);
try {
  const page = await pageWith({ permission: 'default', supported: true });
  await page.locator('#timeline .message').first().waitFor();
  const toggle = page.locator('.notify-toggle');
  assert.equal(await toggle.innerText(), '알림 켜기');
  assert.equal(await page.evaluate(() => window.__asked), 0, 'no permission prompt on load');
  await toggle.click();
  await page.locator('.notify-toggle[aria-pressed="true"]').waitFor();
  assert.equal(await toggle.innerText(), '알림 켜짐');
  assert.equal(await page.evaluate(() => [window.__asked, localStorage.getItem('wax.notify')].join()), '1,on');
  await settle(page);

  await postMessage(root, 'general', { author: 'claude-1', kind: 'claude', type: 'question', body: '보는 중 질문' });
  await page.locator('#timeline .message:has-text("보는 중 질문")').waitFor();
  await settle(page);
  assert.deepEqual(await notices(page), [], 'visible tab, existing records');

  await page.evaluate(() => window.__setHidden(true));
  const asked = await postMessage(root, 'general', { author: 'claude-1', kind: 'claude', type: 'question', body: '토스와 스트라이프 중 어느 쪽이 좋을까요?' });
  await postMessage(root, 'general', { author: '대표', kind: 'human', type: 'question', body: '내 질문' });
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '진행 보고' });
  const pending = await createApproval(root, { tool: 'codex', session: 's-1', callId: 'c-1', action: 'Bash', details: { command: 'rm -rf dist' } });
  await updateFeature(root, 'login', 'save', { phase: 'plan', content: '# plan\n범위' });
  await updateFeature(root, 'login', 'complete', { phase: 'plan', evidence: '기획 확인' });
  await page.waitForFunction(() => window.__notices.length >= 3, null, { timeout: 10_000 });
  await settle(page);
  const got = await notices(page);
  assert.deepEqual(got.map((n) => n.title).sort(), ['claude-1의 질문', '기획 단계 완료', '실행 승인 요청'].sort());
  assert.ok(got.some((n) => n.tag === `m:${asked.id}`) && got.some((n) => n.tag === `a:${pending.request.id}`) && got.some((n) => n.tag.startsWith('p:login:plan:')), 'tags are the de-duplication keys');
  assert.ok(!got.some((n) => n.tag === `a:${old.request.id}`), 'approval waiting before load');
  assert.match(got.find((n) => n.tag.startsWith('a:')).body, /Codex · Bash\nrm -rf dist/);
  assert.match(await page.title(), /^\(3\) /);

  await page.evaluate(() => window.__setHidden(false));
  assert.doesNotMatch(await page.title(), /^\(\d+\)/);
  await Promise.all([page.waitForURL(/channel=general/), page.evaluate((tag) => window.__notices.find((n) => n.tag === tag).onclick(), `m:${asked.id}`)]);
  await page.locator(`#${asked.id}.search-target`).waitFor();
  assert.equal(new URL(page.url()).hash, `#${asked.id}`);

  await page.reload();
  await page.locator('.notify-toggle[aria-pressed="true"]').waitFor();
  await settle(page);
  assert.deepEqual(await notices(page), []);
  await page.locator('.notify-toggle').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('wax.notify')), 'off');
  await page.context().close();

  const blocked = await pageWith({ permission: 'denied', supported: true });
  assert.equal(await blocked.locator('.notify-toggle').innerText(), '알림 차단됨');
  assert.equal(await blocked.locator('.notify-toggle').isDisabled(), true);
  assert.match(await blocked.locator('.notify-toggle').getAttribute('title'), /사이트 설정/);
  await blocked.context().close();
  const unsupported = await pageWith({ permission: 'default', supported: false }, { lang: 'en' });
  assert.equal(await unsupported.locator('.notify-toggle').innerText(), 'Notifications unsupported');
  await unsupported.context().close();
  const english = await pageWith({ permission: 'default', supported: true }, { lang: 'en' });
  assert.equal(await english.locator('.notify-toggle').innerText(), 'Turn on notifications');
  await english.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/start', '/manage']) {
    await english.goto(`${base}${path}?lang=en`);
    await english.locator('.notify-toggle').waitFor();
    assert.equal(await english.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `phone width fits: ${path}`);
  }
  await english.context().close();
  assert.deepEqual(errors, []);
  console.log('PASS browser notifications: toggle and permission on click, remembered choice, visible/self/old records skipped, question·approval·phase notified once, title count, click opens message, blocked and unsupported states, English, phone width.');
} finally {
  await browser.close(); await server.shutdown();
  await rm(root, { recursive: true, force: true });
}
