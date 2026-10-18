import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { postNote } from '../src/chat/board.mjs';
import { createFeature } from '../src/workflow.mjs';
import { DEMO_DESIGN } from '../web/office/studio-demo.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const screenshots = process.env.WAX_SCREENSHOT_DIR || process.argv[4];
const root = await mkdtemp(join(tmpdir(), 'wax i18n browser-'));
const WRITTEN = '사람이 쓴 메모 그대로';
const SENTENCE = DEMO_DESIGN.jobs[0].feedback[0].text, SENTENCE_EN = 'Make the upload button bigger';
const PAGES = ['/', '/manage', '/manage?feature=lookbook-upload', '/chat', '/search', '/search?q=%EB%A9%94%EB%AA%A8', '/office', '/office?studio=1', '/help', '/demo'];
let server, browser;
try {
  await createFeature(root, { id: 'lookbook-upload', title: '룩북 업로드 화면', description: '디자인 인계 후 구현합니다.' });
  await createFeature(root, { id: 'original-title', title: '결정', description: 'Original title preservation' });
  await createFeature(root, { id: 'original-sentence', title: SENTENCE, description: SENTENCE });
  await postMessage(root, 'original-sentence', { author: 'codex-app', kind: 'codex', body: SENTENCE });
  await postMessage(root, 'general', { author: '대표', kind: 'human', body: `${WRITTEN} 1` });
  await postMessage(root, 'lookbook-upload', { author: 'claude-app', kind: 'claude', body: `${WRITTEN} 2` });
  await postNote(root, 'lookbook-upload', { author: 'codex-app', kind: 'codex', type: 'decision', body: `${WRITTEN} 3` });
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3], headless: true });
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const report = {};
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'en-US' });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
    for (const path of PAGES) {
      await page.goto(`${base}${path}`);
      await page.waitForTimeout(1500);
      const left = await page.evaluate(() => {
        const out = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!parent || parent.closest('script, style, [translate="no"], [hidden], template, dialog:not([open])')) continue;
          if (/[가-힣]/.test(node.data) && parent.getClientRects().length) out.add(node.data.trim().slice(0, 120));
        }
        for (const el of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
          if (el.closest('[translate="no"]')) continue;
          for (const attr of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(attr); if (v && /[가-힣]/.test(v)) out.add(`@${attr}: ${v.slice(0, 120)}`); }
        }
        return [...out];
      });
      const written = await page.evaluate((text) => [...document.querySelectorAll('[translate="no"]')].some((el) => el.textContent.includes(text)), WRITTEN);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      report[`${path} @${width}`] = { lang: await page.evaluate(() => document.documentElement.lang), left, written, overflow };
      if (screenshots) await page.screenshot({ path: join(screenshots, `${path.replace(/\W+/g, '_') || 'home'}-${width}.png`), fullPage: false });
    }
    assert.deepEqual(errors, [], `page errors at ${width}px`);
    await page.close();
  }
  const page = await browser.newPage({ locale: 'en-US' });
  await page.goto(`${base}/chat`);
  await Promise.all([page.waitForEvent('load'), page.locator('.language-picker').selectOption('ko')]);
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko');
  await page.goto(`${base}/search`);
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko', 'the choice is kept');
  assert.ok(await page.getByRole('link', { name: '팀 채널' }).count(), 'Korean stays Korean');
  await page.goto(`${base}/manage?lang=en`);
  const feature = page.locator('#features > li').filter({ has: page.getByRole('button', { name: 'original-title', exact: true }) });
  await feature.waitFor();
  assert.equal(await feature.locator('.agent-head .kind').textContent(), '결정');
  assert.equal((await (await page.request.get(`${base}/api/features`)).json()).find(f => f.id === 'original-title').title, '결정');
  await page.route('**/api/design', route => route.fulfill({ json: { ...DEMO_DESIGN, demo: false } }));
  await page.goto(`${base}/office?lang=en`);
  await page.locator('#open-studio').click();
  const feedback = page.locator('#studio-dialog .studio-job details').first();
  await feedback.locator('summary').click();
  assert.equal(await feedback.locator('li').first().textContent(), `v1: ${DEMO_DESIGN.jobs[0].feedback[0].text}`);
  if (screenshots) await page.locator('#studio-dialog').screenshot({ path: join(screenshots, 'original-design-feedback.png') });
  const translated = () => page.evaluate((english) => {
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data.includes(english)) hits.push(`${node.parentElement.tagName}.${node.parentElement.className}: ${node.data.slice(0, 80)}`);
    for (const el of document.querySelectorAll('[alt], [aria-label], [title], [placeholder]')) for (const attr of ['alt', 'aria-label', 'title', 'placeholder']) if (el.getAttribute(attr)?.includes(english)) hits.push(`@${attr} ${el.tagName}`);
    return hits;
  }, SENTENCE_EN);
  const written = JSON.parse(JSON.stringify({ ...DEMO_DESIGN, demo: false }));
  for (const target of written.targets) target.label = SENTENCE;
  for (const job of written.jobs) { job.title = SENTENCE; job.brief = SENTENCE; for (const v of job.versions) v.changes = SENTENCE; }
  await page.unroute('**/api/design');
  await page.route('**/api/design', route => route.fulfill({ json: written }));
  for (const path of ['/manage', '/manage?feature=original-sentence', '/chat?channel=original-sentence', '/search', '/office', '/office?studio=1']) {
    await page.goto(`${base}${path}${path.includes('?') ? '&' : '?'}lang=en`);
    await page.waitForTimeout(1200);
    if (path === '/office?studio=1') { await page.locator('#studio-dialog[open]').waitFor(); await page.locator('#studio-dialog details summary').evaluateAll((all) => all.forEach((s) => s.click())); }
    assert.deepEqual(await translated(), [], `${path}: people's writing was translated`);
  }
  await page.close();
  const blocked = await browser.newContext({ locale: 'en-US' });
  await blocked.addInitScript(() => {
    Object.defineProperty(Storage.prototype, 'setItem', { value() { throw new DOMException('Storage blocked', 'SecurityError'); } });
  });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(`${base}/chat`);
  for (const code of ['ko', 'en']) {
    await Promise.all([blockedPage.waitForEvent('load'), blockedPage.locator('.language-picker').selectOption(code)]);
    assert.equal(await blockedPage.locator('html').getAttribute('lang'), code);
    assert.equal(new URL(blockedPage.url()).searchParams.get('lang'), code);
  }
  await blocked.close();
  console.log('PASS original feature titles, channel and search titles, office list, design titles, labels, feedback and previews, and language switching with storage blocked.');
  console.log(JSON.stringify(report, null, 1));
  const failures = Object.entries(report).filter(([, r]) => r.lang !== 'en' || r.left.length);
  console.log(failures.length ? `Korean left on ${failures.length} page views` : 'All pages fully in English outside people’s writing.');
  if (process.argv.includes('--strict')) assert.deepEqual(failures.map(([key]) => key), []);
} finally {
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(root, { recursive: true, force: true });
}
