import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';
import { createGoal, executeSuggestion } from '../src/chat/pm-loop.mjs';
import { noteToolRun, readToolHealth, readToolSwitches } from '../src/chat/tool-health.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];

const root = await mkdtemp(join(tmpdir(), 'wax-tool-health-'));
await setPm(root, { author: '대표', kind: 'human' });
await createFeature(root, { id: 'fix-sum', title: 'sumTo 고치기' });
for (const [phase, content] of [['plan', '# 계획\n\n- AC-1: 고치기 전에는 실패하고 고친 뒤 통과하는 재현 테스트가 있다\n- AC-2: 관련 기존 테스트가 모두 통과한다\n'], ['design', '설계'], ['implement', '구현']]) {
  await updateFeature(root, 'fix-sum', 'save', { phase, content });
  await updateFeature(root, 'fix-sum', 'complete', { phase, evidence: '확인함', author: 'wax-worker-claude', tool: 'claude', ...(phase === 'implement' ? { waiver: '브라우저 검사용' } : {}) });
}
const goal = await createGoal(root, { title: 'sumTo 고치기', features: ['fix-sum'] }, { author: '대표' });
await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
const fixtures = JSON.parse(await readFile(fileURLToPath(new URL('../test/fixtures/tool-failures/codex.json', import.meta.url)), 'utf8'));
const refused = fixtures.cases.find((item) => item.rule === 'model-not-found');
const hit = await noteToolRun(root, { tool: 'codex', phase: 'implement', ok: false, error: Object.assign(new Error('x'), { toolOutput: { error: refused.text } }), source: 'worker' });
assert.equal(hit?.shape, 'config');

const workerRuns = [];
async function executeWorker(dir, input) {
  workerRuns.push(input.tool);
  await new Promise((done, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'blocked', report: '멈춤' }) };
}
const requestTools = async () => [{ id: 'codex', label: 'Codex', installed: true, approval: 'dashboard' }, { id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }];
const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 50, executeWorker, executeJudge: async () => { throw new Error('no judgment'); }, requestTools });
await server.startWatching();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await browserType.launch({ executablePath: chromium });
const errors = [];
const open = async (path, viewport = { width: 1280, height: 900 }) => {
  const context = await browser.newContext({ viewport, locale: 'ko-KR' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}${path}`);
  return page;
};
let firstPassed = false;
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  const manage = await open('/manage');
  const panel = manage.locator('#pm-loop-panel');
  const health = panel.locator('.pm-tool-health');
  await health.waitFor();
  assert.match(await health.innerText(), /도구 상태[\s\S]*Codex[\s\S]*최근 실패: Codex 모델·인증 거부\(한 번 성공하거나/);
  assert.match(await health.locator('.pm-detail').innerText(), /model_not_found/);
  const card = panel.locator('.pm-card[data-kind="self-review"]');
  await card.waitFor();
  const text = await card.innerText();
  assert.match(text, /직접 검토[\s\S]*fix-sum[\s\S]*최근에 고정 실패[\s\S]*수용 기준[\s\S]*AC-1[\s\S]*재현 테스트[\s\S]*AC-2/);
  assert.deepEqual(await card.locator('.pm-self-commands code').allInnerTexts(), ['wax status fix-sum', 'wax test fix-sum -- <test-command>', 'wax save review fix-sum --file .wax/tmp/review-fix-sum.md',
    'wax complete review fix-sum --verdict pass --evidence "<what-you-checked>" --proofs <proof-id> --checks-file .wax/tmp/review-checks-fix-sum.json --author 대표']);
  assert.equal(await card.locator('.pm-self-commands .copy-cmd').count(), 4);
  assert.equal(await card.locator('button', { hasText: /검토 완료|완료하기/ }).count(), 0, 'no dashboard button completes the review');
  assert.equal(await card.locator('select[name="tool"]').inputValue(), '');
  assert.equal(await card.locator('button.primary').isHidden(), true, 'nothing starts by default');
  await card.locator('select[name="tool"]').selectOption('codex');
  assert.match(await card.locator('.pm-tool-warning').innerText(), /최근 실패: Codex 모델·인증 거부/);
  assert.equal(await card.locator('button.primary').innerText(), 'Codex 작업자 시작');
  await card.locator('select[name="tool"]').selectOption('');
  assert.equal(await card.locator('button.primary').isHidden(), true);
  const phone = await open('/manage', { width: 390, height: 844 });
  await phone.locator('#pm-loop-panel .pm-card[data-kind="self-review"] .pm-self-commands').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with tool health and the self-review card');
  const english = await open('/manage?lang=en');
  const englishCard = english.locator('#pm-loop-panel .pm-card[data-kind="self-review"]');
  await englishCard.waitFor();
  assert.match(await englishCard.innerText(), /Review it yourself[\s\S]*Acceptance criteria[\s\S]*Commands to run/);
  assert.match(await english.locator('#pm-loop-panel .pm-tool-health').innerText(), /Tools and cost[\s\S]*Recent failure: Codex model or sign-in refused/);
  await health.getByRole('button', { name: '다시 시도' }).click();
  await health.locator('.pm-tool-health-item').waitFor({ state: 'detached' });
  const worker = panel.locator('.pm-card[data-kind="start-worker"]');
  await worker.waitFor();
  assert.match(await worker.innerText(), /검토는 구현 도구\(claude\)와 다른 도구인 Codex/);
  assert.equal((await readToolHealth(root)).at(-1).kind, 'retry');
  const codexSwitch = health.locator('.pm-tool-switch[data-tool="codex"]');
  assert.deepEqual(await health.locator('.pm-tool-switch').evaluateAll((nodes) => nodes.map((node) => `${node.dataset.tool}:${node.dataset.disabled}`)), ['codex:off', 'claude:off']);
  await codexSwitch.getByLabel('쓰지 않기').check();
  await health.locator('.pm-tool-switch[data-tool="codex"][data-disabled="on"]').waitFor();
  assert.match(await health.locator('.pm-tool-switch[data-tool="codex"]').innerText(), /쓰지 않기: Codex\(대표이\(가\) .*에 켬, 사람이 끌 때까지\)/);
  await card.waitFor();
  assert.match(await card.innerText(), /쓰지 않기로 되어 있거나/);
  await card.locator('select[name="tool"]').selectOption('codex');
  assert.match(await card.locator('.pm-tool-warning').innerText(), /쓰지 않기: Codex/);
  assert.equal(await card.locator('button.primary').innerText(), 'Codex 작업자 시작', 'a person can still pick it');
  assert.deepEqual((await readToolSwitches(root)).map((item) => [item.tool, item.disabled, item.by]), [['codex', true, '대표']]);
  const phoneSwitch = await open('/manage', { width: 390, height: 844 });
  await phoneSwitch.locator('#pm-loop-panel .pm-tool-switch[data-tool="codex"][data-disabled="on"]').waitFor();
  assert.equal(await noHorizontalScroll(phoneSwitch), true, '/manage at 390px with the "Don\'t use" switches');
  const englishSwitch = await open('/manage?lang=en');
  await englishSwitch.locator('#pm-loop-panel .pm-tool-switch[data-tool="codex"][data-disabled="on"]').waitFor();
  assert.match(await englishSwitch.locator('#pm-loop-panel .pm-tool-switch[data-tool="codex"]').innerText(), /Not used: Codex \(turned on by (대표|CEO) at [\s\S]*Don’t use/);
  await health.locator('.pm-tool-switch[data-tool="codex"]').getByLabel('쓰지 않기').uncheck();
  await health.locator('.pm-tool-switch[data-tool="codex"][data-disabled="off"]').waitFor();
  await worker.waitFor();
  assert.deepEqual((await readToolSwitches(root)).map((item) => item.disabled), [true, false]);
  await panel.getByRole('button', { name: '레시피로 시작' }).click();
  await panel.locator('.pm-recipe[data-recipe="bugfix"]').getByRole('button', { name: '이 레시피로 시작' }).click();
  const start = panel.locator('.pm-recipe-start');
  await start.locator('input[name="recipe-input"]').fill('sumTo');
  await start.getByRole('button', { name: '채우기' }).click();
  const allow = start.locator('.pm-allow');
  await allow.waitFor();
  assert.deepEqual(await allow.locator('input[name="allow"]').evaluateAll((nodes) => nodes.map((node) => `${node.value}:${node.checked}`)), ['wax:false', 'test:false', 'write:false', 'read:false']);
  assert.deepEqual(await allow.locator('.pm-allow-kind:has(.pm-allow-suggested)').evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ['wax', 'test', 'write']);
  assert.match(await allow.locator('.pm-allow-kind[data-kind="wax"]').innerText(), /레시피 제안/);
  assert.deepEqual(workerRuns, []);
  console.log('tool health browser check: the "Don\'t use" switch and the builtin recipe suggestion passed');
  firstPassed = true;
} finally {
  if (!firstPassed) await browser.close();
  await server.shutdown();
  await rm(root, { recursive: true, force: true });
}

const fresh = await mkdtemp(join(tmpdir(), 'wax-tool-health-fresh-'));
await setPm(fresh, { author: '대표', kind: 'human' });
await createFeature(fresh, { id: 'fix-sum', title: 'sumTo 고치기' });
for (const [phase, content] of [['plan', '# 계획\n\n- AC-1: 재현 테스트가 있다\n'], ['design', '설계'], ['implement', '구현']]) {
  await updateFeature(fresh, 'fix-sum', 'save', { phase, content });
  await updateFeature(fresh, 'fix-sum', 'complete', { phase, evidence: '확인함', author: 'wax-worker-claude', tool: 'claude', ...(phase === 'implement' ? { waiver: '브라우저 검사용' } : {}) });
}
const freshGoal = await createGoal(fresh, { title: 'sumTo 고치기', features: ['fix-sum'] }, { author: '대표' });
await executeSuggestion(fresh, freshGoal.id, 'goal:confirm-plan', { author: '대표' });
const freshServer = createChatServer({ root: fresh, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 50, executeWorker, executeJudge: async () => { throw new Error('no judgment'); },
  requestTools: async () => [{ id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }, { id: 'antigravity', label: 'Antigravity CLI', installed: true, approval: 'dashboard' }] });
await freshServer.startWatching();
await new Promise((done) => freshServer.listen(0, '127.0.0.1', done));
const freshBase = `http://127.0.0.1:${freshServer.address().port}`;
try {
  const openFresh = async (viewport) => {
    const context = await browser.newContext({ viewport, locale: 'ko-KR' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${freshBase}/manage`);
    return page;
  };
  const page = await openFresh({ width: 1280, height: 900 });
  const self = page.locator('#pm-loop-panel .pm-card[data-kind="self-review"]');
  await self.waitFor();
  assert.match(await self.innerText(), /직접 검토[\s\S]*headless에서 명령 실행을 거부할 수 있습니다/);
  assert.equal(await self.locator('select[name="tool"]').inputValue(), '');
  await self.locator('select[name="tool"]').selectOption('antigravity');
  assert.match(await self.locator('.pm-tool-warning').innerText(), /permissions\.allow/);
  assert.equal(await page.locator('#pm-loop-panel .pm-card[data-kind="start-worker"]').count(), 0, 'no review worker card before any failure');
  assert.match(await self.locator('.pm-checks-example').innerText(), /"id": "ac-1"[\s\S]*"status": "pass"/);
  const phone = await openFresh({ width: 390, height: 844 });
  await phone.locator('#pm-loop-panel .pm-card[data-kind="self-review"] .pm-checks-example').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the fresh-project self-review card');
  assert.deepEqual(workerRuns, []);
  assert.deepEqual(errors, []);
  console.log('tool health browser check passed');
} finally {
  await browser.close();
  await freshServer.shutdown();
  await rm(fresh, { recursive: true, force: true });
}
