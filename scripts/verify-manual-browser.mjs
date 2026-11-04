import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { setPm } from '../src/chat/team.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];

const root = await mkdtemp(join(tmpdir(), 'wax-manual-'));
await setPm(root, { author: '대표', kind: 'human' });
const noAi = async () => { throw new Error('no AI in this check'); };
const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 50, executeWorker: noAi, executeJudge: noAi, requestTools: async () => [] });
await server.startWatching();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await browserType.launch({ executablePath: chromium });
const errors = [];
const open = async (path, viewport = { width: 1280, height: 900 }) => {
  const context = await browser.newContext({ viewport, locale: 'ko-KR' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${base}${path}`);
  return page;
};
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const writeManual = async (text) => { await mkdir(join(root, 'docs', 'wax'), { recursive: true }); await writeFile(join(root, 'docs', 'wax', 'manual.md'), text); };
const MANUAL = `---\nchecks: ["npm test", "npm run lint"]\n---\n# 작업 규칙\n\n- 화면을 바꾸면 390px 캡처를 남긴다.\n- ${'아주 긴 규칙 문장 '.repeat(20)}\n`;

try {
  const manage = await open('/manage');
  const panel = manage.locator('#pm-loop-panel');
  await panel.locator('.pm-recipe-open').click();
  const line = panel.locator('.pm-manual');
  await line.getByText('docs/wax/manual.md가 없습니다').waitFor();
  assert.equal(await line.getByRole('button', { name: '검토' }).count(), 0);

  await writeManual(MANUAL);
  await panel.locator('.pm-recipe-open').click();
  await panel.locator('.pm-recipe-open').click();
  await line.locator('[data-approval="pending"]').waitFor();
  assert.match(await line.innerText(), /프로젝트 매뉴얼[\s\S]*승인 필요[\s\S]*작업자에게 들어가지 않음/);
  await line.getByRole('button', { name: '검토' }).click();
  const review = panel.locator('.pm-manual-review');
  await review.locator('.pm-manual-body').waitFor();
  assert.match(await review.locator('.pm-manual-body').innerText(), /# 작업 규칙[\s\S]*390px 캡처/);
  assert.doesNotMatch(await review.locator('.pm-manual-body').innerText(), /checks:/, 'the body shown is what workers get, without the checks block');
  assert.deepEqual(await review.locator('.pm-manual-checks code').allInnerTexts(), ['npm test', 'npm run lint']);
  await review.locator('.pm-recipe-first').waitFor();
  const phone = await open('/manage', { width: 390, height: 844 });
  const phonePanel = phone.locator('#pm-loop-panel');
  await phonePanel.locator('.pm-recipe-open').click();
  await phonePanel.locator('.pm-manual').getByRole('button', { name: '검토' }).click();
  await phonePanel.locator('.pm-manual-review .pm-manual-body').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the manual review');
  await review.getByRole('button', { name: '이 내용 승인' }).click();
  await line.locator('[data-approval="approved"]').waitFor();
  assert.equal(await line.locator('.pm-manual-use').getAttribute('data-used'), 'yes');
  assert.equal(await review.isHidden(), true);

  await panel.locator('.pm-recipe-open').click();
  await panel.locator('.pm-new').click();
  const form = panel.locator('.pm-form');
  const offers = form.locator('.pm-allow-manual-check');
  await offers.first().waitFor();
  assert.deepEqual(await offers.allInnerTexts(), ['npm test', 'npm run lint']);
  assert.equal(await form.locator('input[name="allow-test"]').inputValue(), '', 'nothing is filled until a person clicks');
  await offers.nth(1).click();
  assert.equal(await form.locator('input[name="allow-test"]').inputValue(), 'npm run lint');
  assert.deepEqual(await form.locator('input[name="allow"]:checked').count(), 0, 'no allowance is turned on');
  assert.equal(await form.locator('input[name="allow"][value="test"]').isDisabled(), false, 'the test allowance can now be chosen by a person');
  await form.getByRole('button', { name: '닫기' }).click();

  await writeManual(MANUAL.replace('390px', '1280px'));
  await panel.locator('.pm-recipe-open').click();
  await line.locator('[data-approval="changed"]').waitFor();
  assert.equal(await line.locator('.pm-manual-use').getAttribute('data-used'), 'no');
  await line.getByRole('button', { name: '검토' }).click();
  await review.locator('.pm-recipe-diff').waitFor();
  const changes = await review.locator('.pm-diff-del, .pm-diff-add').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
  assert.deepEqual(changes, ['- - 화면을 바꾸면 390px 캡처를 남긴다.', '+ - 화면을 바꾸면 1280px 캡처를 남긴다.']);
  await review.getByRole('button', { name: '닫기' }).click();
  await panel.locator('.pm-recipe-open').click();
  await panel.locator('.pm-new').click();
  await form.locator('input[name="allow-test"]').waitFor();
  assert.equal(await form.locator('.pm-allow-manual-check').count(), 0, 'no suggestions from an unapproved manual');
  assert.deepEqual(errors, []);
  console.log('manual browser check passed');
} finally {
  await browser.close();
  await server.shutdown();
  await rm(root, { recursive: true, force: true });
}
