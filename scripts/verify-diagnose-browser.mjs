import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { createGoal, stopGoal } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-diagnose-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
const SECRET = ['gh', 'p_', 'c3'.repeat(18)].join('');
const PLAN = ['# Plan', '- AC-1: total', '- AC-2: rounding',
  '- S-1: discount — files: src/a.js — check: `node --test test/a.test.js` — done: ok — AC: AC-1',
  '- S-2: rounding — files: src/b.js — check: `node --test test/b.test.js` — done: ok — AC: AC-2',
  '- S-3: docs — files: README.md — check: none(docs only) — done: ok — AC: AC-1'].join('\n');
let server, browser;
try {
  await createFeature(root, { id: 'invoice', title: 'Invoice total', projectType: 'general' });
  await updateFeature(root, 'invoice', 'save', { phase: 'plan', content: PLAN });
  await updateFeature(root, 'invoice', 'complete', { phase: 'plan', evidence: 'plan done', redGreen: 'off' });
  for (const phase of ['design', 'implement']) {
    await updateFeature(root, 'invoice', 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, 'invoice', 'complete', { phase, evidence: `${phase} done`, ...(phase === 'implement' ? { waiver: 'fixture only <img src=x onerror=alert(1)>' } : {}), redGreen: 'off' });
  }
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: 'Invoices', features: ['invoice'] }, { author: '대표' });
  await stopGoal(root, goal.id, { author: '대표', reason: `waiting for keys ${SECRET}` });
  const before = await readFile(join(root, '.wax', 'features', 'invoice.json'), 'utf8');

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
  const box = page.locator('#trace-panel:not([hidden]) #trace-diagnose .diagnose');
  await box.waitFor();
  assert.equal(await box.locator('.diagnose-run').innerText(), 'Diagnose');
  assert.equal(await box.locator('.diagnose-body').count(), 0, 'closed until pressed');
  await box.locator('.diagnose-run').click();
  const report = box.locator('.diagnose-report');
  await report.waitFor();
  assert.equal(await box.locator('.diagnose-run').innerText(), 'Diagnose again');
  assert.match(await report.locator('.diagnose-summary').innerText(), /^In one line: Goal goal-[a-f0-9]{8} is stopped \(by 대표\)\. Reason: waiting for keys <secret:[a-z-]+>$/);
  const steps = report.locator('.diagnose-finding[data-code="diagnose.plan.stepsNoGreen"]');
  assert.match(await steps.locator('.diagnose-text').innerText(), /implement was completed, but 2 of 2 plan steps with a check have no passing proof in this cycle: S-1, S-2/);
  assert.equal(await steps.getAttribute('data-severity'), 'warn');
  const noProof = report.locator('.diagnose-finding[data-code="diagnose.evidence.noProof"] .diagnose-text');
  assert.match(await noProof.innerText(), /fixture only <img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#trace-diagnose img').count(), 0, 'record text stays text');
  assert.doesNotMatch(await report.innerText(), new RegExp(SECRET), 'scrubbed');
  assert.equal(await report.locator('.diagnose-dimension').count(), 8);
  await noKorean(box, 'task diagnosis');
  await fits('task diagnosis');
  if (screenshots) { await box.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'diagnose-task-en.png') }); }

  const cite = steps.locator('.diagnose-cite').first();
  assert.equal(await cite.getAttribute('data-pointer'), '/artifacts/plan');
  await cite.click();
  const view = steps.locator('.diagnose-cite-view pre');
  await view.waitFor();
  assert.equal(await view.innerText(), PLAN);
  assert.equal(await cite.getAttribute('aria-expanded'), 'true');
  await fits('cited record');
  const stopCite = report.locator('.diagnose-finding[data-code="diagnose.stop.goalStopped"] .diagnose-cite[data-file$=".jsonl"]');
  await stopCite.click();
  const stopView = report.locator('.diagnose-finding[data-code="diagnose.stop.goalStopped"] .diagnose-cite-view pre');
  await stopView.waitFor();
  assert.match(await stopView.innerText(), /"outcome": "stopped"/);
  assert.doesNotMatch(await stopView.innerText(), new RegExp(SECRET));
  await cite.click();
  await page.locator('#trace-diagnose .diagnose-finding[data-code="diagnose.plan.stepsNoGreen"] .diagnose-cite-view').waitFor({ state: 'detached' });
  assert.match(await box.locator('.diagnose-cli code').innerText(), /^wax diagnose invoice --bundle \.\.\/wax-diagnose-invoice$/);
  await noKorean(box, 'cited record');
  if (screenshots) { await stopView.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'diagnose-cite-en.png') }); }

  await page.goto(`${url}/manage?lang=en`);
  const goalBox = page.locator(`#pm-loop-panel .pm-goal[data-goal="${goal.id}"] .diagnose`);
  await goalBox.waitFor();
  await goalBox.locator('.diagnose-run').click();
  await goalBox.locator('.diagnose-report').waitFor();
  assert.match(await goalBox.locator('.diagnose-summary').innerText(), /^In one line: Goal .* is stopped/);
  assert.match(await goalBox.locator('.diagnose-text').allInnerTexts().then((list) => list.join('\n')), /Task invoice is in review/);
  await createGoal(root, { title: 'Other', features: ['invoice'] }, { author: '대표' });
  await page.locator('#pm-loop-panel .pm-goal').nth(1).waitFor();
  assert.equal(await page.locator(`#pm-loop-panel .pm-goal[data-goal="${goal.id}"] .diagnose-report`).count(), 1, 'kept open across re-render');
  await noKorean(goalBox, 'goal diagnosis');
  await fits('goal diagnosis');
  if (screenshots) { await goalBox.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'diagnose-goal-en.png') }); }

  const korean = await browser.newContext({ locale: 'ko-KR', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const ko = await korean.newPage();
  ko.on('pageerror', (error) => errors.push(error.message));
  await ko.goto(`${url}/manage?feature=invoice&lang=ko`);
  const koBox = ko.locator('#trace-panel:not([hidden]) #trace-diagnose .diagnose');
  await koBox.locator('.diagnose-run').click();
  await koBox.locator('.diagnose-report').waitFor();
  assert.match(await koBox.locator('.diagnose-summary').innerText(), /^한 줄 요약: 목표 goal-[a-f0-9]{8}이\(가\) 멈춤 상태입니다/);
  assert.match(await koBox.locator('.diagnose-finding[data-code="diagnose.plan.stepsNoGreen"] .diagnose-text').innerText(), /구현을 끝냈지만 이 주기에 통과 근거가 없는 계획 단계 2개/);
  await korean.close();

  assert.equal(await readFile(join(root, '.wax', 'features', 'invoice.json'), 'utf8'), before, 'diagnosis only reads');
  assert.deepEqual(errors, []);
  console.log('PASS browser: diagnose button on the task and goal screens (report in the screen language from code/args, plan steps without a passing proof, record text as text, scrubbed), cited records open and close, kept open across re-render, Korean screen, read-only, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
