import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { chatDir } from '../src/chat/paths.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { takeSnapshot } from '../src/snapshots.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-snapshots-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
let server, browser;
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  await writeFile(join(root, '.gitignore'), '.wax/\n');
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'notes.txt'), 'keep me\n');
  await writeFile(join(root, 'app.js'), 'export const total = (a, b) => a - b;\nexport const name = "<img src=x onerror=alert(1)>";\n');
  git('add', '-A'); git('-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  const id = 'sum';
  await createFeature(root, { id, title: 'Fix the sum' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: phase === 'plan' ? '- AC-1: total adds — check: test' : '# design' });
    await updateFeature(root, id, 'complete', { phase, evidence: 'scope checked', author: 'codex-a', tool: 'codex' });
  }
  const goal = await createGoal(root, { title: 'Snapshots', features: [id] }, { author: '대표' });
  const worker = 'pw-0000a001';
  const meta = { run: worker, goal: goal.id, worker, feature: id, phase: 'implement', iteration: 0, tool: 'claude' };
  const log = join(await chatDir(root, 'pm-loop'), `${goal.id}.jsonl`);
  const base = { kind: 'worker', worker, tool: 'claude', feature: id, phase: 'implement', iteration: 0, task: 't-000001-aaaaaa', to: 'wax-worker-claude', by: '대표' };
  await appendRecord(log, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...base, outcome: 'launched', at: new Date().toISOString() }));
  const before = await takeSnapshot(root, { ...meta, point: 'before' });
  await writeFile(join(root, 'app.js'), 'export const total = (a, b) => a + b;\nexport const name = "<img src=x onerror=alert(1)>";\nexport const double = (a) => total(a, a);\n');
  await rm(join(root, 'notes.txt'));
  await writeFile(join(root, 'src-helper-with-a-very-long-name-for-the-phone-width-check.js'), 'export const helper = 1;\n');
  const after = await takeSnapshot(root, { ...meta, point: 'after' });
  await appendRecord(log, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...base, outcome: 'exited', result: 'done', reason: 'done', usage: null,
    snapshots: { before: before.id, after: after.id }, at: new Date().toISOString() }));
  await writeFile(join(root, 'src-helper-with-a-very-long-name-for-the-phone-width-check.js'), 'export const helper = 2; // person\n');

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off', WAX_CHAT_USER: '대표' }, requestTools: async () => [] });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'en'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const fits = async (label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: no horizontal scroll at 390px`);

  await page.goto(`${url}/manage?feature=${id}&lang=en`);
  const run = page.locator(`#trace-panel .trace-run[data-run="${worker}"]`);
  await run.waitFor();
  assert.match(await run.locator('h4').textContent(), /Files this run changed \(including uncommitted\)/);
  assert.deepEqual(await run.locator('.trace-run-file').evaluateAll((nodes) => nodes.map((node) => [node.dataset.path, node.className.match(/state-(\w+)/)[1]])),
    [['app.js', 'modify'], ['notes.txt', 'delete'], ['src-helper-with-a-very-long-name-for-the-phone-width-check.js', 'new']]);
  assert.match(await run.locator('.trace-run-file[data-path="app.js"]').textContent(), /Modified file.*\+2 −1/);
  await fits('run list');

  await run.locator('.trace-run-file[data-path="app.js"] .trace-run-toggle').click();
  const diff = run.locator('.trace-run-file[data-path="app.js"] .trace-run-diff');
  await diff.waitFor();
  const diffText = await diff.textContent();
  assert.match(diffText, /-export const total = \(a, b\) => a - b;/);
  assert.match(diffText, /\+export const total = \(a, b\) => a \+ b;/);
  assert.match(diffText, /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#trace-panel img').count(), 0, 'diff text stays text');
  assert.equal(await run.locator('.trace-run-file[data-path="app.js"] .trace-run-toggle').getAttribute('aria-expanded'), 'true');
  await fits('diff expanded');

  await run.locator('.trace-restore-open').click();
  const preview = run.locator('.trace-restore-preview');
  await preview.waitFor();
  assert.match(await preview.locator('.trace-restore-summary').textContent(), /2 files will be restored and 1 left alone\./);
  assert.deepEqual(await preview.locator('.restore-write li').evaluateAll((nodes) => nodes.map((node) => node.dataset.path)), ['app.js', 'notes.txt']);
  assert.deepEqual(await preview.locator('.restore-skip li').evaluateAll((nodes) => nodes.map((node) => [node.dataset.path, node.dataset.reason])),
    [['src-helper-with-a-very-long-name-for-the-phone-width-check.js', 'changed']]);
  assert.match(await preview.locator('.restore-skip').textContent(), /changed after the run \(by a person or another worker\)/);
  assert.match(await preview.textContent(), /Files matched by \.gitignore .* are not restored/);
  assert.match(await preview.textContent(), /do not push \.wax\/ to a public repository/);
  assert.doesNotMatch(await run.textContent(), /[가-힣]/, 'English screen');
  await fits('preview');
  if (screenshots) await run.screenshot({ path: join(screenshots, 'snapshots-preview-390-en.png') });
  await preview.locator('.trace-restore-cancel').click();
  assert.equal(await run.locator('.trace-restore-preview').count(), 0);
  assert.match(await readFile(join(root, 'app.js'), 'utf8'), /a \+ b/);

  await run.locator('.trace-restore-open').click();
  await run.locator('.trace-restore-preview .trace-restore-confirm').click();
  const result = page.locator(`#trace-panel .trace-run[data-run="${worker}"] .trace-restore-result`);
  await result.waitFor();
  assert.match(await result.textContent(), /Restored 2 files\. Left 1 alone\./);
  assert.match(await result.textContent(), /rs-[a-f0-9]{8}/);
  assert.match(await readFile(join(root, 'app.js'), 'utf8'), /a - b;\n.*\n$/);
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'keep me\n');
  assert.equal(await readFile(join(root, 'src-helper-with-a-very-long-name-for-the-phone-width-check.js'), 'utf8'), 'export const helper = 2; // person\n');
  const restoreRun = page.locator('#trace-panel .trace-run.run-restore');
  await restoreRun.waitFor();
  assert.match(await restoreRun.locator('h4').textContent(), /Restore rs-[a-f0-9]{8}/);
  assert.equal(await restoreRun.locator('.trace-restore-open').textContent(), 'Undo this restore');
  await page.locator('#trace-panel .trace-pm li', { hasText: 'Restored to before the run' }).first().waitFor();
  await fits('result');
  if (screenshots) await page.locator('#trace-panel').screenshot({ path: join(screenshots, 'snapshots-result-390-en.png') });
  await restoreRun.locator('.trace-restore-open').click();
  await restoreRun.locator('.trace-restore-preview').waitFor();
  assert.deepEqual(await restoreRun.locator('.restore-write li').evaluateAll((nodes) => nodes.map((node) => node.dataset.path)), ['app.js', 'notes.txt']);
  await fits('undo preview');

  assert.deepEqual(errors, []);
  console.log('PASS browser: run snapshot diff expand, restore preview (restored / left alone), cancel, confirm, result, undo-restore preview, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
