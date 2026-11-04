import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { DEMO_DESIGN } from '../web/office/studio-demo.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const screenshots = process.env.WAX_SCREENSHOT_DIR || process.argv[4];
const root = await mkdtemp(join(tmpdir(), 'wax-design-browser-'));
let server, browser;
try {
  browser = await chromium.launch({ executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3], headless: true });
  const shooter = await browser.newPage({ locale: 'ko-KR', viewport: { width: 360, height: 640 } });
  const shots = [];
  for (const version of DEMO_DESIGN.jobs[0].versions) { await shooter.goto(version.previewUrl); shots.push(await shooter.screenshot()); }
  await shooter.close();
  let produced = 0;
  const figma = { name: 'figma', runtime: 'connected', auth: 'oAuth', tools: ['get_metadata', 'get_screenshot', 'use_figma'], schemas: { get_metadata: ['fileKey', 'nodeId'], get_screenshot: ['fileKey', 'nodeId'] } };
  const designMcp = { codex: async () => ({
    async servers() { return [figma]; },
    async call(name, tool) {
      if (tool === 'get_metadata') return { isError: false, content: [{ type: 'text', text: '<frame id="12:34" />' }] };
      return { isError: false, content: [{ type: 'image', mimeType: 'image/png', data: shots[Math.min(produced, shots.length) - 1].toString('base64') }] };
    },
    close() {},
  }) };
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, designMcp, executeDesign: async (r, { prompt }) => {
    produced++;
    if (produced === 2) assert.match(prompt, /업로드 버튼을 더 크게/);
    await new Promise((done) => setTimeout(done, 300));
    return { threadId: 'fixture', message: JSON.stringify({ outcome: 'complete', report: '로컬 픽스처 결과', changes: produced === 1 ? '업로드 영역과 버튼 배치' : '버튼을 키우고 실패 안내를 위로', nodeId: '12:99', objects: [], render: '', exported: '' }) };
  } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/office`);
  await page.click('#open-studio');
  const dialog = page.locator('#studio-dialog');
  await dialog.getByText('연결한 디자인 대상이 없습니다.').waitFor();
  await dialog.getByText('연결 검사를 통과한 대상이 없어 제작을 요청할 수 없습니다.', { exact: false }).waitFor();
  await page.fill('#studio-new-url', 'https://www.figma.com/design/AbCdEfGhIjKl123/Lookbook');
  await dialog.getByRole('button', { name: '연결 대상 추가' }).click();
  const notice = dialog.locator('.studio-status');
  await notice.getByText('node-id', { exact: false }).waitFor();
  await page.waitForTimeout(800);
  assert.match(await notice.textContent(), /선택 항목 링크 복사/, 'the fix stays visible');
  assert.equal(await page.inputValue('#studio-new-url'), 'https://www.figma.com/design/AbCdEfGhIjKl123/Lookbook', 'the typed link is kept to correct');
  await page.fill('#studio-new-url', 'https://www.figma.com/design/AbCdEfGhIjKl123/Lookbook?node-id=12-34&t=shareToken');
  await page.fill('#studio-new-label', '룩북 업로드 화면');
  await dialog.getByRole('button', { name: '연결 대상 추가' }).click();
  await dialog.getByText('Figma · 룩북 업로드 화면').waitFor();
  assert.equal(await dialog.getByText('shareToken').count(), 0, 'share tokens are not shown');
  const checks = dialog.locator('.studio-checks li');
  await checks.nth(0).getByRole('button', { name: '연결 검사' }).click();
  await dialog.getByText('Codex: 읽기·쓰기 가능').waitFor();
  await checks.nth(1).getByRole('button', { name: '연결 검사' }).click();
  await dialog.getByText('Claude Code: 지원 안 함').waitFor();
  await dialog.getByText('다음 행동: Figma 작업은 실행 도구를 Codex로 선택하세요.').waitFor();
  assert.deepEqual(await page.locator('#studio-job-agent option').evaluateAll((o) => o.map((x) => x.value)), ['codex'], 'only a passing execution tool is offered');
  await page.fill('#studio-job-title', '룩북 업로드 화면');
  await page.fill('#studio-job-brief', '상품 사진을 올리는 모바일 첫 화면, 실패 안내 포함');
  const request = dialog.getByRole('button', { name: '제작 요청' });
  await request.dblclick();
  const job = dialog.locator('.studio-job');
  await job.getByText('다음 행동: v1 미리보기를 확인하고', { exact: false }).waitFor({ timeout: 15_000 });
  assert.equal(await job.count(), 1, 'a double click makes one job');
  const current = job.locator('img.studio-preview-image');
  await current.waitFor();
  assert.ok(await current.evaluate((img) => img.complete && img.naturalWidth > 0), 'v1 preview is the image wax received');
  await page.fill(`#studio-feedback-${(await server.design.list()).jobs[0].id}`, '업로드 버튼을 더 크게, 실패 안내는 위로');
  const feedback = page.locator('.studio-actions textarea');
  await feedback.focus(); await feedback.press('End'); await feedback.type(' 올려 주세요');
  await checks.nth(0).getByRole('button', { name: '연결 검사' }).click();
  await dialog.getByText('Codex: 읽기·쓰기 가능').waitFor();
  assert.equal(await feedback.inputValue(), '업로드 버튼을 더 크게, 실패 안내는 위로 올려 주세요');
  await job.getByRole('button', { name: '수정 요청 → v2' }).click();
  await job.getByText('다음 행동: v2 미리보기를 확인하고', { exact: false }).waitFor({ timeout: 15_000 });
  assert.equal(await job.locator('img.studio-thumb').count(), 1, 'v1 stays in the history');
  await job.getByText('바뀐 점: 버튼을 키우고 실패 안내를 위로').waitFor();
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await dialog.screenshot({ path: join(screenshots, 'design-review.png') }); }
  await job.getByRole('button', { name: 'v2 확정' }).click();
  await job.getByRole('button', { name: '확정 v2 개발에 인계' }).click();
  await job.getByText('개발 인계: v2', { exact: false }).waitFor();
  const saved = (await server.design.list()).jobs[0];
  assert.equal(saved.status, 'handed-off'); assert.equal(saved.handoff.version, 2);
  assert.deepEqual(errors, []);

  const demo = await context.newPage();
  await demo.goto(`${base}/office?demo=1`);
  await demo.click('#open-studio');
  await demo.getByText('데모 예시 화면입니다. 실제 Figma·Blender MCP 실행이나 연결 검사 결과가 아닙니다.').waitFor();
  assert.ok(await demo.locator('#studio-dialog button:not([data-close])').evaluateAll((list) => list.length > 0 && list.every((b) => b.disabled)), 'demo buttons are disabled');
  await demo.locator('#studio-dialog img.studio-preview-image').waitFor();
  if (screenshots) await demo.locator('#studio-dialog').screenshot({ path: join(screenshots, 'design-demo.png') });
  await demo.setViewportSize({ width: 390, height: 844 });
  assert.ok(await demo.locator('#studio-dialog').evaluate((d) => d.scrollWidth <= d.clientWidth + 1), 'no horizontal scroll on a phone');
  console.log('PASS: design target link and real-check states, unsupported tool guidance, one job per double click, v1 → feedback → v2 on the same frame, draft kept across server events, approve → handoff, sandboxed demo, phone width.');
} finally {
  await browser?.close();
  await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
