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
const root = await mkdtemp(join(tmpdir(), 'wax-rulings-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
const WORKER = 'wax-worker-claude';
async function upTo(id, title, phases) {
  await createFeature(root, { id, title, projectType: 'general' });
  for (const phase of phases) {
    await updateFeature(root, id, 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, id, 'complete', { phase, evidence: `${phase} done`, ...(['implement', 'review'].includes(phase) ? { waiver: 'fixture only' } : {}), redGreen: 'off' });
  }
}
const rule = (id, ruling) => updateFeature(root, id, 'ruling', { ruling, author: WORKER });
let server, browser;
try {
  await upTo('invoice', 'Invoice total', ['plan', 'design']);
  await rule('invoice', { what: 'Round half up for cents', why: 'AC-1 does not say how to round', cost: 'Totals may differ by a cent', area: 'behavior' });
  await rule('invoice', { what: 'delete old draft rows', why: 'They are unused <img src=x onerror=alert(1)>', cost: 'Drafts cannot be restored' });
  await rule('invoice', { what: 'Name the helper totalCents', why: 'Matches the other helpers', cost: 'A rename', area: 'naming' });
  await upTo('shipping', 'Shipping fee', ['plan', 'design', 'implement']);
  await rule('shipping', { what: 'Free shipping from 50', why: 'The plan mentions 50', cost: 'Wrong threshold', area: 'behavior' });
  await setPm(root, { author: '대표', kind: 'human' });
  await createGoal(root, { title: 'Invoices', features: ['invoice'] }, { author: '대표' });

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

  await page.goto(`${url}/manage?feature=invoice&lang=en`);
  const box = page.locator('#trace-panel:not([hidden]) #trace-rulings .rulings');
  await box.waitFor();
  assert.equal(await box.locator('h3').innerText(), 'Rulings');
  assert.match(await box.locator('.agent-head .badge').first().innerText(), /3 rulings, 3 unacknowledged/);
  assert.deepEqual(await box.locator('.ruling').evaluateAll((nodes) => nodes.map((node) => node.dataset.ruling)), ['R-2', 'R-1', 'R-3']);
  const flagged = box.locator('.ruling[data-ruling="R-2"]');
  assert.match(await flagged.innerText(), /May need a person/);
  assert.match(await flagged.innerText(), /They are unused <img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#trace-rulings img').count(), 0, 'worker text stays text');
  await noKorean(box, 'rulings section');
  await fits('rulings section');
  if (screenshots) { await box.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'rulings-en.png') }); }

  await box.locator('.ruling[data-ruling="R-1"] .ruling-ack').click();
  await page.locator('#trace-rulings .ruling[data-ruling="R-1"][data-status="acknowledged"]').waitFor();
  assert.equal((await getFeature(root, 'invoice')).rulings.find((item) => item.id === 'R-1').marked.by, '대표');
  assert.equal(await page.locator('#trace-rulings .ruling[data-ruling="R-1"] .ruling-ack').count(), 0);

  await page.locator('#trace-rulings .ruling[data-ruling="R-3"] .ruling-override').click();
  const confirm = page.locator('#trace-rulings .ruling[data-ruling="R-3"] .ruling-confirm-box');
  await confirm.waitFor();
  assert.equal(await confirm.getAttribute('data-effect'), 'defect');
  assert.match(await confirm.locator('.ruling-effect').innerText(), /opens a defect in this cycle/);
  assert.equal(await confirm.locator('.ruling-confirm').isDisabled(), true, 'no note, no send');
  await confirm.locator('textarea').fill('Use the name invoiceTotal');
  assert.equal(await confirm.locator('.ruling-confirm').isDisabled(), false);
  await noKorean(confirm, 'override confirm step');
  await fits('override confirm step');
  await confirm.locator('.ruling-confirm').click();
  await page.locator('#trace-rulings .ruling[data-ruling="R-3"][data-status="overridden"]').waitFor();
  assert.match(await page.locator('#trace-rulings .rulings-message').innerText(), /Decided R-3 again and opened defect D-1\./);
  const invoice = await getFeature(root, 'invoice');
  assert.deepEqual([invoice.phase, invoice.defects?.[0]?.id, invoice.defects?.[0]?.source?.ruling, invoice.defects?.[0]?.detail], ['implement', 'D-1', 'R-3', 'Use the name invoiceTotal']);
  assert.match(await page.locator('#trace-rulings .ruling[data-ruling="R-3"]').innerText(), /Use the name invoiceTotal/);

  await page.goto(`${url}/manage?feature=shipping&lang=en`);
  await page.locator('#trace-panel:not([hidden]) #trace-rulings .ruling[data-ruling="R-1"]').waitFor();
  await page.locator('#trace-rulings .ruling[data-ruling="R-1"] .ruling-override').click();
  const back = page.locator('#trace-rulings .ruling-confirm-box');
  await back.waitFor();
  assert.equal(await back.getAttribute('data-effect'), 'iterate');
  assert.match(await back.locator('.ruling-effect').innerText(), /goes back to implement/);
  await back.locator('textarea').fill('The threshold is 40');
  await back.locator('.ruling-confirm').click();
  await page.locator('#trace-rulings .ruling[data-ruling="R-1"][data-status="overridden"]').waitFor();
  const shipping = await getFeature(root, 'shipping');
  assert.deepEqual([shipping.phase, shipping.iteration, shipping.defects?.[0]?.foundIteration], ['implement', 1, 0]);

  await page.goto(`${url}/manage?lang=en`);
  const line = page.locator('#pm-loop-panel .pm-feature[data-feature="invoice"] .pm-rulings');
  await line.waitFor();
  assert.match(await line.innerText(), /3 rulings, 1 unacknowledged · May need a person View rulings/);
  assert.equal(await line.locator('a').getAttribute('href'), '/manage?feature=invoice');
  await noKorean(line, 'goal screen rulings line');
  await fits('goal screen');

  assert.deepEqual(errors, []);
  console.log('PASS browser: rulings on the task screen (order, flag, worker text as text), acknowledge, decide again with the effect shown first and a required note (defect in this cycle; back to implement after review), goal screen count, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
