import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { completePhase, createFeature, getFeature, updateFeature } from '../src/workflow.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-plan-steps-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
const HEAD = 'a'.repeat(40);
let clock = Date.now() - 60_000;
const at = () => new Date(clock += 1000).toISOString();
const CHECK = ['node', '--test', 'test/invoice-total-with-a-long-name-for-narrow-screens.test.mjs'];
const PLAN = `# Plan
- AC-1: Total includes the discount
- AC-2: Usage example
- S-1: Apply the discount — files: src/invoice.mjs — check: \`${CHECK.join(' ')}\` — done: discount test passes — AC: AC-1
- S-2: Round to cents — files: src/money.mjs — check: \`node --test test/money.test.mjs\` — done: rounding passes — AC: AC-1
- S-3: README <img src=x onerror=alert(1)> — files: README.md — check: none(docs only) — AC: AC-2
`;
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command: CHECK, commit: HEAD, dirty: true, durationMs: 5,
  exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: { head: HEAD, files: { 'src/invoice.mjs': 'b'.repeat(40) } }, ...extra });
const attach = (id, item) => getFeature(root, id).then((feature) => updateFeature(root, id, 'attach-evidence', { proof: item, revision: feature.revision }));
let server, browser;
try {
  await createFeature(root, { id: 'invoice', title: 'Invoice total', projectType: 'general' });
  await updateFeature(root, 'invoice', 'save', { phase: 'plan', content: PLAN });
  await completePhase(root, 'invoice', 'plan', { evidence: 'plan done', planSteps: 'warn' });
  await updateFeature(root, 'invoice', 'save', { phase: 'design', content: '# design' });
  await updateFeature(root, 'invoice', 'complete', { phase: 'design', evidence: 'design done' });
  await updateFeature(root, 'invoice', 'save', { phase: 'implement', content: '# implement' });
  await attach('invoice', proof({ exitCode: 1, tree: { head: HEAD, files: {} } }));
  await attach('invoice', proof({ step: 'S-1' }));

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off', WAX_CHAT_USER: '대표' }, intervalMs: 50, executeWorker: async () => { throw new Error('no worker'); }, executeJudge: async () => { throw new Error('no judgment'); } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'en'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const fits = async (label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${label}: no horizontal scroll at 390px`);
  const open = async () => {
    await page.goto(`${url}/manage?feature=invoice&lang=en`);
    await page.locator('#trace-panel:not([hidden]) .trace-visit').first().waitFor();
    const implement = page.locator('#trace-panel .trace-visit[data-phase="implement"]');
    if (!await implement.locator('details').evaluate((node) => node.open)) await implement.locator('summary').click();
    const block = implement.locator('.trace-steps');
    await block.waitFor();
    return block;
  };
  const rows = (block) => block.locator('.trace-step-list li').evaluateAll((nodes) => nodes.map((node) => [node.dataset.step, node.dataset.state, node.querySelector('.badge')?.textContent ?? null]));

  let block = await open();
  assert.equal(await block.locator('h4').innerText(), 'Plan steps');
  assert.equal(await block.locator('.plan-steps-line').innerText(), 'Plan steps 1/2 done (1 red→green) · 1 without a check');
  assert.deepEqual(await rows(block), [['S-1', 'passed', 'check passed · Red→green'], ['S-2', 'pending', 'not checked yet'], ['S-3', 'noCheck', 'No check (docs only)']]);
  assert.match(await block.innerText(), /S-1 Apply the discount/);
  assert.match(await block.innerText(), /node --test test\/invoice-total-with-a-long-name-for-narrow-screens\.test\.mjs/);
  assert.match(await block.innerText(), /S-3 README <img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#trace-panel img').count(), 0, 'plan text stays text');
  assert.equal(await block.locator('[translate="no"]').count() >= 4, true, 'plan text is not translated');
  assert.doesNotMatch(await block.innerText(), /[가-힣]/, 'English screen');
  await fits('run trace steps');
  if (screenshots) { await block.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'plan-steps-trace-en.png') }); }

  await attach('invoice', proof({ command: ['node', '--test', 'test/money.test.mjs'], step: 'S-2' }));
  block = await open();
  assert.equal(await block.locator('.plan-steps-line').innerText(), 'Plan steps 2/2 done (1 red→green) · 1 without a check');
  assert.deepEqual((await rows(block)).map(([id, state]) => [id, state]), [['S-1', 'passed'], ['S-2', 'passed'], ['S-3', 'noCheck']]);
  await fits('run trace steps after progress');

  assert.deepEqual(errors, []);
  console.log('PASS browser: plan steps in the run trace (progress line, per-step check and state, red→green, no check reason), plan text as text, progress updates, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
