import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-approach-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
const WORKER = 'wax-worker-claude';
let server, browser;
try {
  await createFeature(root, { id: 'invoice', title: 'Invoice total', projectType: 'general' });
  await updateFeature(root, 'invoice', 'save', { phase: 'plan', content: '# plan' });
  await updateFeature(root, 'invoice', 'complete', { phase: 'plan', evidence: 'plan done' });
  await updateFeature(root, 'invoice', 'save', { phase: 'design', content: '# design draft' });
  await updateFeature(root, 'invoice', 'approach-propose', { author: WORKER, approach: [
    { title: 'Compute on the server', summary: 'Sum in the API', tradeoffs: 'One more request', cost: 'S', risk: 'low' },
    { title: 'Compute in the browser', summary: 'Sum on screen <img src=x onerror=alert(1)>', tradeoffs: 'Same math in two places', cost: 'M', risk: 'medium' },
    { title: 'Precompute nightly', summary: 'A batch job', tradeoffs: 'Stale for a day', cost: 'L', risk: 'high' },
  ] });
  await setPm(root, { author: '대표', kind: 'human' });
  await createGoal(root, { title: 'Invoices', features: ['invoice'], approach: 'ask' }, { author: '대표' });

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off', WAX_CHAT_USER: '대표' }, intervalMs: 50, executeWorker: async () => { throw new Error('no worker'); }, executeJudge: async () => { throw new Error('no judgment'); } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'en'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  const fits = async (label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${label}: no horizontal scroll at 390px`);
  const noKorean = async (locator, label) => assert.doesNotMatch((await locator.innerText()).replaceAll('대표', ''), /[가-힣]/, `${label}: English screen`);

  await page.goto(`${url}/manage?lang=en`);
  const panel = page.locator('#pm-loop-panel');
  await panel.locator('.pm-new').click();
  const field = panel.locator('.pm-form .pm-approach-field');
  await field.waitFor();
  assert.deepEqual(await field.locator('option').allInnerTexts(), ['Default (WAX_APPROACH, warn only)', 'A person picks (the worker may skip with a reason if there is only one)', 'A person always picks', 'Off']);
  await noKorean(field, 'start screen approach field');
  await fits('start screen');
  await panel.locator('.pm-form button[type="button"]').last().click();

  const goal = panel.locator('.pm-goal').first();
  await goal.locator('.pm-card[data-kind="confirm-plan"] .proposal-actions .primary').click();
  const card = goal.locator('.pm-card[data-kind="pick-approach"]');
  await card.waitFor({ timeout: 10_000 });
  const text = await card.innerText();
  assert.match(text, /Pick a design approach[\s\S]*Human decision[\s\S]*The design worker proposed 3 approaches \(round 1\)/);
  assert.match(text, /Sum on screen <img src=x onerror=alert\(1\)>/);
  assert.match(text, /Cost S · Risk Low \(worker’s estimate\)[\s\S]*Cost L · Risk High/);
  assert.equal(await card.locator('img').count(), 0, 'worker text stays text');
  assert.deepEqual(await card.locator('.proposal-actions button').count(), 0, 'no dismiss button');
  assert.deepEqual(await card.locator('.approach-use').allInnerTexts(), ['Use this', 'Use this', 'Use this']);
  assert.equal(await goal.locator('.pm-card[data-kind="start-worker"]').count(), 0, 'no worker until a person picks');
  await noKorean(card, 'pick-approach card');
  await fits('pick-approach card');
  if (screenshots) await card.screenshot({ path: join(screenshots, 'approach-card-en.png') });

  await card.locator('.approach-item[data-index="1"] .approach-use').click();
  const confirm = card.locator('.approach-item[data-index="1"] .approach-confirm');
  await confirm.waitFor();
  assert.match(await confirm.locator('.approach-rewrite').innerText(), /The design document must be rewritten/);
  await confirm.locator('textarea').fill('The API deploy is frozen @team');
  await noKorean(confirm, 'pick confirm step');
  await fits('pick confirm step');
  await confirm.locator('.approach-confirm-pick').click();
  await card.waitFor({ state: 'detached', timeout: 10_000 });
  await goal.locator('.pm-card[data-kind="start-worker"]').waitFor({ timeout: 10_000 });
  let invoice = await getFeature(root, 'invoice');
  assert.deepEqual([invoice.approach.pick.index, invoice.approach.pick.by, invoice.approach.pick.via, invoice.approach.pick.reason], [1, '대표', 'dashboard', 'The API deploy is frozen @team']);

  await page.goto(`${url}/manage?feature=invoice&lang=en`);
  const box = page.locator('#trace-panel:not([hidden]) #trace-approach .approach');
  await box.waitFor();
  assert.equal(await box.locator('h3').innerText(), 'Design approach');
  assert.match(await box.locator('.approach-line').innerText(), /^Chosen: Compute in the browser · 대표 · Reason: The API deploy is frozen @team$/);
  assert.equal(await box.locator('.approach-item[data-index="1"] .approach-chosen-badge').innerText(), 'Chosen');
  await box.locator('.approach-again').click();
  const againBox = box.locator('.approach-again-box');
  await againBox.waitFor();
  assert.equal(await againBox.locator('.approach-again-send').isDisabled(), true, 'no note, no send');
  await againBox.locator('textarea').fill('Try one that needs no new endpoint');
  assert.equal(await againBox.locator('.approach-again-send').isDisabled(), false);
  await noKorean(box, 'task screen approach section');
  await fits('task screen approach section');
  if (screenshots) await box.screenshot({ path: join(screenshots, 'approach-task-en.png') });
  await againBox.locator('.approach-again-send').click();
  await page.locator('#trace-approach .approach[data-state="again"]').waitFor({ timeout: 10_000 });
  assert.match(await page.locator('#trace-approach .approach-again-note').innerText(), /Note asking for new approaches: Try one that needs no new endpoint/);
  invoice = await getFeature(root, 'invoice');
  assert.deepEqual([invoice.approach.again.round, invoice.approach.again.by, invoice.approach.again.via], [1, '대표', 'dashboard']);

  assert.deepEqual(errors, []);
  console.log('PASS browser: approach setting on the start screen, pick-approach card (worker text as text, estimates, no dismiss), pick confirm step with the rewrite notice and reason, task screen chosen line, propose again with a required note, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
