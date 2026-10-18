import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { createFeature } from '../src/workflow.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const screenshots = process.env.WAX_SCREENSHOT_DIR || process.argv[4];
const root = await mkdtemp(join(tmpdir(), 'wax 검색 browser-'));
let server, browser;
try {
  await createFeature(root, { id: 'lookbook-upload', title: '룩북 업로드 화면', description: '디자인 인계 후 구현합니다.' });
  for (let i = 1; i <= 30; i++) await postMessage(root, 'lookbook-upload', { author: 'claude-app', kind: 'claude', body: `디자인 인계 메모 ${i}: docs/wax/design/handoff-v2.md 확인 (Claude Code)` });
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '<script>alert(1)</script> 오류 리뷰가 필요합니다' });
  await postMessage(root, 'general', { author: '대표', kind: 'human', body: '대표가 남긴 결정 메모' });
  await postMessage(root, 'general', { author: '클로드 앱', kind: 'claude', body: '클로드 앱이 남긴 결정 메모' });
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3], headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.goto(`${base}/search`);
  const index = page.locator('#search-index');
  await index.getByText('검색 색인이 아직 없습니다', { exact: false }).waitFor();
  await index.getByRole('button', { name: '검색 색인 만들기' }).click();
  await index.getByText('색인 준비됨', { exact: false }).waitFor({ timeout: 20_000 });

  const box = page.locator('#search-q');
  await box.click();
  const started = Date.now();
  await box.type('인계');
  await page.locator('.search-item mark').first().waitFor();
  const responseMs = Date.now() - started;
  assert.equal(await box.inputValue(), '인계'); assert.equal(await box.evaluate((el) => el === document.activeElement), true);
  await page.locator('#search-summary').getByText('31건', { exact: false }).waitFor();
  assert.match(await page.locator('#search-summary').textContent(), /인계: 두 글자 조각/);
  assert.equal(await page.locator('.search-item').count(), 20);
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '입력 중에 도착한 인계' });
  await box.type(' 메모');
  await page.locator('#search-summary').getByText('30건', { exact: false }).waitFor();
  assert.equal(await box.inputValue(), '인계 메모');
  await page.locator('#search-more').click();
  await page.locator('.search-item').nth(29).waitFor();
  assert.equal(await page.locator('#search-more').isHidden(), true);
  assert.match(page.url(), /q=%EC%9D%B8%EA%B3%84/);

  await box.fill('오류'); await page.locator('#search-summary').getByText('1건', { exact: false }).waitFor();
  assert.equal(await page.locator('.search-item script').count(), 0);
  assert.match(await page.locator('.search-snippet').first().textContent(), /<script>alert\(1\)<\/script>/);
  await page.locator('#search-filters summary').click();
  await page.selectOption('#search-kind', 'feature');
  await page.locator('#search-summary').getByText('“오류”에 맞는 기록이 없습니다', { exact: false }).waitFor();
  assert.match(page.url(), /kind=feature/);
  await page.locator('#search-clear').click();
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await box.fill('handoff-v2.md'); await page.locator('.search-item', { hasText: 'handoff-v2.md' }).first().waitFor(); await page.locator('#search-filters summary').click(); await page.screenshot({ path: join(screenshots, 'search-results.png') }); }

  await box.fill('"메모 3:"');
  const hit = page.locator('.search-item', { hasText: '디자인 인계 메모 3:' });
  await hit.waitFor();
  await hit.locator('h3 a').click();
  await page.waitForURL(/\/chat\?channel=lookbook-upload#m-/);
  await page.locator('.message.search-target').waitFor();
  assert.match(await page.locator('.message.search-target').textContent(), /디자인 인계 메모 3:/);

  await writeFile(join(root, '.wax', 'search', 'index.db'), 'broken '.repeat(500));
  await rm(join(root, '.wax', 'search', 'index.db-wal'), { force: true });
  await page.goto(`${base}/search?q=${encodeURIComponent('인계')}`);
  await page.locator('#search-alert').getByText('--rebuild', { exact: false }).waitFor();
  await index.getByRole('button', { name: '색인 다시 만들기(복구)' }).click();
  await index.getByText('색인 준비됨', { exact: false }).waitFor({ timeout: 20_000 });
  await page.locator('.search-item').first().waitFor();

  await box.fill('결정 메모');
  await page.locator('#search-summary').getByText('2건', { exact: false }).waitFor();
  await page.locator('#search-filters summary').click();
  await page.fill('#search-author', '대표'); await page.locator('#search-author').dispatchEvent('change');
  await page.locator('#search-summary').getByText('1건', { exact: false }).waitFor();
  assert.match(await page.locator('.search-item .search-meta').first().textContent(), /대표/);
  await page.fill('#search-author', '클로드 앱'); await page.locator('#search-author').dispatchEvent('change');
  await page.locator('.search-item', { hasText: '클로드 앱이 남긴' }).waitFor();
  assert.equal(await page.locator('.search-item').count(), 1);
  assert.match(page.url(), /author=%ED%81%B4%EB%A1%9C%EB%93%9C\+%EC%95%B1/);
  await page.locator('#search-clear').click();

  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  await writeFile(join(root, '.wax', 'chat', 'channels', 'bulk.jsonl'), Array.from({ length: 40_000 }, (_, i) => `${JSON.stringify({ schema: 1, id: `m-${String(i + 1).padStart(6, '0')}-b0b0b0`, seq: i + 1, author: 'codex-app', kind: 'codex', type: 'message', body: `대량 개발 메모 ${i}`, at: '2026-10-01T00:00:00Z' })}\n`).join(''));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/wax.mjs', import.meta.url)), '--project', root, 'search', 'index', '--rebuild']);
  const closed = new Promise((done) => child.on('close', done));
  let builder = null;
  for (let i = 0; i < 400 && !builder; i++) { builder = await readFile(join(root, '.wax', 'search', 'rebuild.lock', 'owner.json'), 'utf8').then(JSON.parse, () => null); if (!builder) await new Promise((done) => setTimeout(done, 10)); }
  await new Promise((done) => setTimeout(done, 300));
  process.kill(builder.pid, 'SIGKILL'); await closed;
  await postMessage(root, 'general', { author: '대표', kind: 'human', body: '중단 뒤에 쓴 복구확인 메모' });
  await page.goto(`${base}/search`);
  await index.getByText('중간에 멈췄습니다', { exact: false }).waitFor();
  if (screenshots) await page.screenshot({ path: join(screenshots, 'search-interrupted.png') });
  await index.getByRole('button', { name: '색인 이어서 만들기' }).click();
  await index.getByText('색인 준비됨', { exact: false }).waitFor({ timeout: 30_000 });
  await page.locator('#search-q').fill('복구확인');
  await page.locator('.search-item', { hasText: '중단 뒤에 쓴 복구확인 메모' }).waitFor();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${base}/search?q=${encodeURIComponent('Claude Code')}`);
  await phone.locator('.search-item').first().waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshots) await phone.screenshot({ path: join(screenshots, 'search-phone.png') });

  await server.shutdown(); server = null;
  await box.fill('인계 오프라인');
  await page.locator('#search-alert').waitFor();
  assert.deepEqual(errors, []);
  console.log(`PASS: missing → build, Korean/mixed search with marks, focus and query kept across events, stable pages, filters in the URL, HTML stays text, result → original message, corrupt index recovery, author filter (대표, 클로드 앱), killed build → interrupted → resume, phone width, offline notice. Typing → first results: ${responseMs}ms (includes 350ms input pause).`);
} finally {
  await browser?.close();
  await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
