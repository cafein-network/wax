import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { completePhase, createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-red-green-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
const HEAD = 'a'.repeat(40);
let clock = Date.now() - 60_000;
const at = () => new Date(clock += 1000).toISOString();
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command: ['node', '--test', '--test-reporter=tap', 'test/invoice-total-with-a-long-name.test.mjs'],
  commit: HEAD, dirty: true, durationMs: 5, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: { head: HEAD, files: { 'src/invoice.mjs': 'b'.repeat(40) } }, ...extra });
const attach = (id, item) => getFeature(root, id).then((feature) => updateFeature(root, id, 'attach-evidence', { proof: item, revision: feature.revision }));
async function toImplement(id, title) {
  await createFeature(root, { id, title, projectType: 'general' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, id, 'complete', { phase, evidence: `${phase} done` });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# implement' });
}
let server, browser;
try {
  await toImplement('invoice', 'Invoice total');
  const red = proof({ exitCode: 1, output: 'TAP version 13\nnot ok 1 - subtracts the discount\n# tests 1\n', tree: { head: HEAD, files: {} } });
  const green = proof({ output: 'TAP version 13\nok 1 - adds tax\n# tests 1\n' });
  await attach('invoice', red); await attach('invoice', green);
  await completePhase(root, 'invoice', 'implement', { evidence: 'tests pass', proofIds: [green.id], redGreen: 'warn' });
  await toImplement('config', 'Config value');
  const only = proof();
  await attach('config', only);
  await completePhase(root, 'config', 'implement', { evidence: 'config', proofIds: [only.id], redGreen: 'warn', redWaiver: 'Only a config value <img src=x onerror=alert(1)>' });
  for (const id of ['header', 'footer']) await createFeature(root, { id, title: `Edit ${id}` });
  await setPm(root, { author: '대표', kind: 'human' });

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off', WAX_CHAT_USER: '대표' }, intervalMs: 50, executeWorker: async () => { throw new Error('no worker'); }, executeJudge: async () => { throw new Error('no judgment'); } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'en'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const fits = async (label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${label}: no horizontal scroll at 390px`);
  const noKorean = async (locator, label) => assert.doesNotMatch((await locator.innerText()).replaceAll('대표', ''), /[가-힣]/, `${label}: English screen`);

  await page.goto(`${url}/manage?lang=en`);
  const panel = page.locator('#pm-loop-panel');
  await panel.locator('button.pm-new').click();
  const form = panel.locator('form.pm-form');
  const field = form.locator('.pm-red-green-field');
  await field.waitFor();
  assert.match(await field.innerText(), /Require red→green/);
  assert.equal(await field.locator('input[name="red-green"]').isChecked(), false, 'unchecked by default');
  await noKorean(field, 'start screen checkbox');
  await fits('new goal form');
  await form.locator('input[name="title"]').fill('Header and footer');
  for (const id of ['header', 'footer']) await form.locator(`input[name="feature"][value="${id}"]`).check();
  await field.locator('input[name="red-green"]').check();
  await form.locator('button[type="submit"]').click();
  const goal = panel.locator('.pm-goal').first();
  await goal.waitFor();
  for (const id of ['header', 'footer']) assert.equal((await getFeature(root, id)).discipline?.redGreen, 'enforce', `${id} records enforce`);

  const section = goal.locator('.pm-red-green');
  await section.waitFor();
  assert.equal(await section.getAttribute('data-red-green'), 'on');
  assert.match(await section.innerText(), /Red→green\s*Required/);
  await noKorean(section, 'goal screen red→green section');
  await fits('goal screen');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'red-green-goal-en.png'), fullPage: true });
  await section.locator('.pm-red-green-toggle input').uncheck();
  await page.locator('#pm-loop-panel .pm-red-green[data-red-green="off"]').waitFor();
  assert.equal((await getFeature(root, 'header')).discipline, undefined, 'turned off in the task record');
  await page.locator('#pm-loop-panel .pm-red-green .pm-red-green-toggle input').check();
  await page.locator('#pm-loop-panel .pm-red-green[data-red-green="on"]').waitFor();
  assert.equal((await getFeature(root, 'footer')).discipline?.redGreen, 'enforce', 'turned on again');

  await page.goto(`${url}/manage?feature=invoice&lang=en`);
  await page.locator('#trace-panel:not([hidden]) .trace-visit').first().waitFor();
  const implement = page.locator('#trace-panel .trace-visit[data-phase="implement"]');
  await implement.locator('summary').click();
  const block = implement.locator('.trace-red-green');
  await block.waitFor();
  assert.equal(await block.locator('h4').innerText(), 'Failure seen first');
  assert.equal(await block.locator('.red-green-line').innerText(), 'Red→green: 1 pair · 1 warning');
  assert.match(await block.innerText(), /A different test failed first\./);
  assert.deepEqual(await implement.locator('.trace-proof').evaluateAll((nodes) => nodes.map((node) => [node.dataset.redGreen ?? null, node.querySelector('.red-green-mark')?.textContent ?? null])),
    [['red', 'Red'], ['green', 'Green']]);
  await noKorean(block, 'trace red→green block');
  await fits('run trace');
  if (screenshots) { await implement.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'red-green-trace-en.png') }); }

  await page.goto(`${url}/manage?feature=config&lang=en`);
  await page.locator('#trace-panel:not([hidden]) .trace-visit').first().waitFor();
  const waived = page.locator('#trace-panel .trace-visit[data-phase="implement"]');
  await waived.locator('summary').click();
  await waived.locator('.trace-red-green').waitFor();
  assert.equal(await waived.locator('.red-green-line').innerText(), 'No red→green · reason given');
  assert.match(await waived.locator('.trace-red-green').innerText(), /Reason for completing without red→green: Only a config value <img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#trace-panel img').count(), 0, 'record text stays text');
  await fits('run trace with a reason');

  assert.deepEqual(errors, []);
  console.log('PASS browser: red→green start checkbox (off by default) writes enforce into tasks, goal toggle off/on, trace pair line, warning and Red/Green marks, reason as text, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
