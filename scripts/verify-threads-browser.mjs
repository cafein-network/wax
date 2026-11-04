import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { setPm, assignTask, updateTask } from '../src/chat/team.mjs';
import { createApproval } from '../src/approvals.mjs';
import { createRequestRunner } from '../src/chat/requests.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { getFeature } from '../src/workflow.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];
const shots = process.env.WAX_SCREENSHOT_DIR || process.argv[4];
const shot = (page, name, options = {}) => shots ? page.screenshot({ path: join(shots, name), ...options }) : null;

const root = await mkdtemp(join(tmpdir(), 'wax-threads-'));
await createFeature(root, { id: 'login', title: '이메일 로그인' });
await setPm(root, { author: 'wax-pm', kind: 'codex' });
const task = await assignTask(root, { author: 'wax-pm', kind: 'codex', feature: 'login', to: 'codex-app', phase: 'plan', body: '로그인 API 범위 정리\n토큰 만료 포함' });
await updateTask(root, task.id, 'accept', { author: 'codex-app', kind: 'codex' });
await updateTask(root, task.id, 'block', { author: 'codex-app', kind: 'codex', body: 'SMTP 키가 없습니다' });
const root1 = await postMessage(root, 'general', { author: '대표', kind: 'human', body: '결제 모듈은 어떤 걸로 할까?' });
await postMessage(root, 'general', { author: 'claude-1', kind: 'claude', body: '자료 조사 중 1' , replyTo: root1.id });
await postMessage(root, 'general', { author: 'claude-1', kind: 'claude', body: '자료 조사 중 2', replyTo: root1.id });
await postMessage(root, 'general', { author: 'claude-1', kind: 'claude', body: '토스와 스트라이프 중 어느 쪽이 좋을까요?', type: 'question', replyTo: root1.id });
await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '단발 메시지: 빌드 통과' });
await createApproval(root, { tool: 'claude', session: 's-1', callId: 'c-1', action: 'command', details: { command: 'rm -rf dist' } });
const runner = createRequestRunner({ root, execute: async (root, input) => {
  const id = input.prompt.match(/현재 작업: ([a-z0-9-]+),/)[1], feature = await getFeature(root, id);
  const proofIds = [];
  if (['implement', 'review'].includes(feature.phase)) proofIds.push((await runTestProof(root, id, [process.execPath, '-e', '1'], { revision: feature.revision })).proof.id);
  return { threadId: 'fixture', message: JSON.stringify({ outcome: 'complete', report: `${feature.phase} 보고`, document: `# ${feature.phase}`, evidence: '픽스처 검증', proofIds }) };
} });
const done = await runner.submit({ author: '대표', body: '로그인 오류 고쳐줘', tool: 'claude' });
await runner.settled(); await runner.close();

const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' } });
await server.startWatching();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await browserType.launch({ executablePath: chromium });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?lang=ko`);
  await page.locator('#timeline .message').first().waitFor();
  assert.equal(await page.locator('#timeline .message').count(), 5, 'full conversation shows every message');
  await page.locator('#work-count:not([hidden])').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#work-count').innerText(), '3', 'attention badge: blocked task, question, approval');
  await page.click('#tab-work');
  await page.locator('#threads .thread-item').first().waitFor();
  const titles = await page.locator('#threads .thread-item strong').allInnerTexts();
  assert.deepEqual(titles.sort(), ['Claude Code 실행 승인', '결제 모듈은 어떤 걸로 할까?', '로그인 API 범위 정리'].sort());
  await shot(page, 'threads-list.png');

  await page.click('#threads .thread-item:has-text("결제 모듈")');
  await page.locator('#thread-head h2').waitFor();
  assert.doesNotMatch(await page.locator('#thread-head').innerText(), /null/);
  assert.equal(await page.locator('#timeline .progress-fold').count(), 1, 'two progress updates fold');
  assert.equal(await page.locator('#timeline > .message').count(), 2, 'root question and latest question stay open');
  assert.match(page.url(), /thread=m%3Am-/);
  await shot(page, 'thread-conversation.png');
  await page.fill('#body', '토스로 갑시다');
  await page.click('#composer [type=submit]');
  await page.locator('#timeline .message:has-text("토스로 갑시다")').waitFor();
  const sent = await (await fetch(`${base}/api/channels/general/messages?limit=10`)).json();
  const reply = sent.messages.at(-1);
  assert.equal(reply.body, '토스로 갑시다'); assert.ok(reply.replyTo, 'sent as a reply in the thread');
  assert.equal(await page.locator('#work-count').innerText(), '2', 'the answered question leaves "needs an answer"');

  await page.click('#threads .thread-item:has-text("로그인 API")').catch(async () => {
    await page.click('.work-filter.state-attention'); await page.click('#threads .thread-item:has-text("로그인 API")');
  });
  await page.locator('#thread-head:has-text("PM 업무 배정에서 열기")').waitFor();
  assert.equal(await page.locator('#timeline .message').count(), 3, 'assignment, accept and block');
  await shot(page, 'thread-task.png');

  await page.click('#threads .thread-item:has-text("실행 승인")');
  await page.locator('#thread-head .approval-card').waitFor();
  assert.equal(await page.locator('#composer').isVisible(), false, 'approvals are answered on the card');
  await shot(page, 'thread-approval.png');

  await page.click('#thread-head .link');
  await page.locator('#timeline .message').first().waitFor();
  assert.equal(await page.locator('#thread-head').isVisible(), false);
  assert.equal(await page.locator('#timeline .message').count(), 6, 'back to the full conversation, including the new reply');
  assert.doesNotMatch(page.url(), /thread=/);

  await page.fill('#work-search', '로그인');
  await page.locator('#threads .thread-item:has-text("로그인 오류 고쳐줘")').waitFor();
  assert.deepEqual((await page.locator('#threads .thread-item strong').allInnerTexts()).sort(), ['로그인 API 범위 정리', '로그인 오류 고쳐줘']);
  assert.ok((await page.locator('#threads .thread-group').allInnerTexts()).includes('오늘'));
  await page.click('#threads .thread-row:has-text("로그인 오류") .pin-toggle');
  await page.fill('#work-search', '');
  await page.locator('#threads .thread-group:has-text("고정")').waitFor();
  assert.equal(await page.locator('#threads .thread-row').first().locator('strong').innerText(), '로그인 오류 고쳐줘', 'the pinned done request leads the attention list');
  await shot(page, 'threads-pinned.png');
  await page.reload();
  await page.click('#tab-work');
  await page.locator('#threads .thread-group:has-text("고정")').waitFor();

  await page.click('#threads .thread-item:has-text("로그인 오류 고쳐줘")');
  await page.locator('#timeline .phase-section').first().waitFor();
  assert.deepEqual(await page.locator('#timeline .phase-section > summary strong').allInnerTexts(), ['접수·분석', '영향 확인', '수정', '회귀 검증', '처리 보고']);
  assert.deepEqual(await page.locator('#timeline .phase-section').evaluateAll((nodes) => nodes.map((node) => node.open)), [false, false, false, false, true]);
  await page.locator('#timeline .phase-section:nth-child(3) .proof-card.proof-pass').waitFor({ state: 'attached' });
  assert.match(await page.locator('#timeline .phase-section:nth-child(3) > summary').innerText(), /테스트 1\/1 통과/);
  await page.click('#timeline .phase-section:nth-child(3) > summary');
  assert.match(await page.locator('#timeline .phase-section:nth-child(3) .proof-card').innerText(), /테스트 통과/);
  assert.equal(await page.locator('#timeline .phase-section:nth-child(3) .proof-card').getAttribute('href'), `/manage?feature=${done.id}`);
  await shot(page, 'thread-request-phases.png');

  await page.click('#body'); await page.keyboard.type('/rev');
  await page.locator('#complete:not([hidden]) .complete-item').first().waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#body'), `wax review ${done.id} `);
  await page.keyboard.type(' #');
  await page.locator('#complete:not([hidden])').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#complete').isHidden(), true);
  await page.fill('#body', '');
  await page.click('#thread-head .link');
  await page.locator('#timeline .message').first().waitFor();
  await page.click('#body'); await page.keyboard.type('확인 부탁 #log');
  await page.locator('#complete .complete-item:has-text("#login")').waitFor();
  await shot(page, 'composer-complete.png');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#body'), '확인 부탁 #login ');
  await page.fill('#body', '');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto(`${base}/?lang=ko&thread=${encodeURIComponent(`t:${task.id}`)}`);
  await mobile.locator('#thread-head h2').waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal scroll on a phone');
  await shot(mobile, 'thread-mobile.png', { fullPage: true });

  const english = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  english.on('pageerror', (e) => errors.push(e.message));
  await english.goto(`${base}/?lang=en`);
  await english.click('#tab-work');
  await english.locator('#threads .thread-item').first().waitFor();
  const side = await english.locator('aside').innerText();
  assert.doesNotMatch(side.replace(/codex-app: SMTP 키가 없습니다|claude-1: 토스와 스트라이프 중 어느 쪽이 좋을까요\?|대표: 토스로 갑시다|로그인 API 범위 정리|결제 모듈은 어떤 걸로 할까\?|codex-app|claude-1|대표/g, ''), /[가-힣]/, side);
  await shot(english, 'threads-en.png');
  assert.deepEqual(errors, []);
  console.log('PASS channel work threads');
} finally {
  await browser.close();
  await server.shutdown();
  await rm(root, { recursive: true, force: true });
}
