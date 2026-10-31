import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { captureArtifact } from '../src/capture.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const screenshots = process.env.WAX_SCREENSHOT_DIR;

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0); return Buffer.concat([head, data, tail]); };
function png(width, height, rgba, paint = () => null) {
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0, ...Array.from({ length: width }, (_, x) => paint(x, y) ?? rgba).flat()]));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const root = await mkdtemp(join(tmpdir(), 'wax-compare-browser-'));
let server, browser;
try {
  const id = 'site';
  await createFeature(root, { id, title: '홈 화면' });
  const shoot = async (check, file, image, labels) => { await writeFile(join(root, file), image); return captureArtifact(root, id, { check, file, ...labels }); };
  await updateFeature(root, id, 'save', { phase: 'plan', content: '- AC-1: 홈이 보인다 — 검증: 캡처' });
  await updateFeature(root, id, 'complete', { phase: 'plan', evidence: '범위' });
  const blue = [40, 90, 200, 255], desktop = { viewport: '1280x800', scroll: 'top', state: 'default' }, phone = { viewport: '390x844', scroll: 'top', state: 'default' };
  await shoot('design-preview', 'd-desktop.png', png(160, 100, blue), desktop);
  await shoot('design-preview', 'd-phone.png', png(39, 84, blue), phone);
  await shoot('design-preview', 'd-wide.png', png(192, 108, blue), { viewport: '1920x1080', scroll: 'bottom' });
  await updateFeature(root, id, 'save', { phase: 'design', content: '# 설계' });
  await updateFeature(root, id, 'complete', { phase: 'design', evidence: '시안 캡처' });
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  const proof = (await runTestProof(root, id, [process.execPath, '-e', 'process.exit(0)'])).proof;
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현', proofIds: [proof.id] });
  await shoot('ui-review', 'r-desktop.png', png(160, 100, blue, (x, y) => (y < 25 ? [250, 250, 250, 255] : null)), desktop);
  await shoot('ui-review', 'r-phone.png', png(39, 90, blue), phone);
  await shoot('ui-review', 'r-error.png', png(77, 102, [200, 40, 40, 255]), { viewport: '768x1024', state: 'error' });

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'ko'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${base}/manage?feature=${id}`);
  const section = page.locator('#trace-panel .trace-visit[data-phase="review"] .trace-compare');
  await section.waitFor();
  const pairs = section.locator('.compare-pair');
  assert.equal(await pairs.count(), 2);
  assert.match(await section.locator('h4').textContent(), /시안 비교/);
  assert.match(await section.textContent(), /같은 조건 짝 2개 · 시안 없음 1개 · 다시 캡처하지 않은 시안 1개/);
  assert.match(await pairs.nth(0).textContent(), /390x844 · 스크롤 top · default · 크기가 다름: 시안 39x84 \/ 구현 39x90/);
  assert.match(await pairs.nth(1).textContent(), /1280x800 · 스크롤 top · default · 다른 픽셀 25\.00% \(160x100\)/);
  assert.match(await section.locator('.compare-unpaired').textContent(), /시안 없음 768x1024 · error/);
  assert.match(await section.locator('.compare-unpaired').textContent(), /다시 캡처하지 않은 시안 1920x1080 · 스크롤 bottom/);
  assert.match(await section.textContent(), /일치 판정이 아닙니다/);
  const images = section.locator('.compare-pair img');
  assert.equal(await images.count(), 4);
  await page.waitForFunction(() => [...document.querySelectorAll('.trace-compare .compare-pair img')].every((img) => img.complete && img.naturalWidth > 0));
  const sources = await images.evaluateAll((nodes) => nodes.map((node) => new URL(node.src).pathname));
  assert.ok(sources.every((path) => /^\/api\/features\/site\/captures\/(design|review)-0\/(design-preview|ui-review)-[^/]+\.png$/.test(path)), sources.join(', '));
  assert.deepEqual(await images.evaluateAll((nodes) => nodes.map((node) => node.alt)), ['시안', '구현 화면', '시안', '구현 화면']);
  const [left, right] = await Promise.all([pairs.nth(1).locator('figure').nth(0).boundingBox(), pairs.nth(1).locator('figure').nth(1).boundingBox()]);
  assert.ok(Math.abs(left.y - right.y) < 2 && right.x > left.x + left.width - 1, 'side by side on desktop');
  if (screenshots) await section.screenshot({ path: join(screenshots, 'compare-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile layout fits');
  const [top, bottom] = await Promise.all([pairs.nth(1).locator('figure').nth(0).boundingBox(), pairs.nth(1).locator('figure').nth(1).boundingBox()]);
  assert.ok(bottom.y >= top.y + top.height - 1, 'stacked at 390px');
  assert.ok(top.x >= 0 && top.x + top.width <= 390, 'the thumbnail stays inside the phone width');
  if (screenshots) await section.screenshot({ path: join(screenshots, 'compare-mobile.png') });

  const english = await context.newPage();
  english.on('pageerror', (error) => errors.push(error.message));
  await english.goto(`${base}/manage?feature=${id}&lang=en`);
  const en = english.locator('#trace-panel .trace-visit[data-phase="review"] .trace-compare');
  await en.waitFor();
  assert.match(await en.locator('h4').textContent(), /Visual comparison/);
  const text = await en.textContent();
  for (const phrase of ['2 same-condition pairs · 1 without baseline · 1 baselines not re-captured', '25.00% of pixels differ (160x100)', 'size differs: design 39x84 / implementation 39x90',
    'No baseline', 'Baseline not re-captured', 'scroll bottom', 'not a match verdict']) assert.ok(text.includes(phrase), `${phrase} in: ${text}`);
  assert.doesNotMatch(text, /[가-힣]/, 'no Korean left in the English view');
  assert.deepEqual(errors, []);
  console.log('PASS browser: visual comparison in the review visit — paired thumbnails, labels, ratio, unpaired list (ko/en), 390px stacking.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
