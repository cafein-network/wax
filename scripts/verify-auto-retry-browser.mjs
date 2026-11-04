import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createGoal, executeSuggestion } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];

const fixture = JSON.parse(await readFile(fileURLToPath(new URL('../test/fixtures/tool-failures/codex.json', import.meta.url)), 'utf8')).cases.find((item) => item.rule === 'usage-limit');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const roots = [];
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'wax-auto-retry-'));
  roots.push(root);
  git(root, 'init', '-q');
  await writeFile(join(root, '.gitignore'), '.wax/\n');
  await writeFile(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  await setPm(root, { author: '대표', kind: 'human' });
  await createFeature(root, { id: 'login', title: '로그인 화면' });
  const goal = await createGoal(root, { title: '로그인', features: ['login'] }, { author: '대표' });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  return root;
}
const workerRuns = [];
async function executeWorker(dir, input) {
  workerRuns.push(input.tool);
  if (input.tool === 'codex') throw Object.assign(new Error('Codex failed'), { toolOutput: { [fixture.stream]: fixture.text } });
  const author = input.prompt.match(/작업자 이름: ([^.]+)\./)[1];
  await updateFeature(dir, 'login', 'save', { phase: 'plan', content: '# plan\n\n- AC-1: 열린다' });
  await updateFeature(dir, 'login', 'complete', { phase: 'plan', evidence: '가짜 작업자', author });
  return { threadId: 'fake', status: 'completed', message: JSON.stringify({ outcome: 'done', report: '끝' }) };
}
const executeJudge = async () => { throw new Error('no judgment in this check'); };
const requestTools = async () => [{ id: 'codex', label: 'Codex', installed: true, approval: 'dashboard' }, { id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }];
async function start(stuck) {
  const root = await repo();
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off', WAX_STUCK_CHECK: stuck }, intervalMs: 50, executeWorker, executeJudge, requestTools });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const browser = await browserType.launch({ executablePath: chromium });
const errors = [];
const servers = [];
const open = async (base, viewport = { width: 1280, height: 900 }) => {
  const context = await browser.newContext({ viewport, locale: 'ko-KR' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/manage`);
  return page;
};
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  const stop = await start('stop');
  servers.push(stop.server);
  const page = await open(stop.base);
  const goal = page.locator('#pm-loop-panel .pm-goal');
  const first = goal.locator('.pm-card[data-kind="start-worker"]');
  await first.waitFor({ timeout: 10_000 });
  await first.getByRole('button', { name: 'Codex 작업자 시작' }).click();
  const retry = goal.locator('.pm-card[data-kind="auto-retry"]');
  await retry.waitFor({ timeout: 15_000 });
  assert.match(await retry.innerText(), /다시 시도\(규칙\)[\s\S]*Codex[\s\S]*Claude Code/);
  assert.equal(await goal.locator('.pm-card[data-kind="judge"]').count(), 0, 'no judgment card for a fixed failure');
  const phone = await open(stop.base, { width: 390, height: 844 });
  await phone.locator('#pm-loop-panel .pm-card[data-kind="auto-retry"]').waitFor({ timeout: 10_000 });
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the retry card');
  await retry.getByRole('button', { name: '다시 시도' }).click();
  const next = goal.locator('.pm-card[data-kind="start-worker"]', { hasText: 'switch-unhealthy' });
  await next.waitFor({ timeout: 10_000 });
  assert.equal(await next.locator('select[name="tool"]').inputValue(), 'claude');
  await next.getByRole('button', { name: 'Claude Code 작업자 시작' }).click();
  await goal.locator('.pm-card[data-kind="start-worker"][data-key^="login:0:design:"]').waitFor({ timeout: 15_000 });
  assert.deepEqual(workerRuns, ['codex', 'claude']);

  workerRuns.length = 0;
  const warn = await start('warn');
  servers.push(warn.server);
  const plain = await open(warn.base);
  const plainGoal = plain.locator('#pm-loop-panel .pm-goal');
  await plainGoal.locator('.pm-card[data-kind="start-worker"]').getByRole('button', { name: 'Codex 작업자 시작' }).click();
  await plainGoal.locator('.pm-card[data-kind="blocked"]').waitFor({ timeout: 15_000 });
  assert.equal(await plainGoal.locator('.pm-card[data-kind="auto-retry"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('auto retry browser check passed');
} finally {
  await browser.close();
  for (const server of servers) await server.shutdown();
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
