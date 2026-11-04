import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';
import { runAgentSession } from '../src/agent-session.mjs';
import { listApprovals } from '../src/approvals.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];
const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));

const root = await mkdtemp(join(tmpdir(), 'wax-goal-allow-'));
await setPm(root, { author: '대표', kind: 'human' });
await mkdir(join(root, '.wax', 'recipes'), { recursive: true });
await writeFile(join(root, '.wax', 'recipes', 'quick-fix.json'), JSON.stringify({ schema: 1, id: 'quick-fix', title: '빠른 수정', input: { label: '무엇을 고치나요?' },
  goal: '{input} 고치기', tasks: [{ id: 'quick-{slug}', title: '{input} 고치기', ac: ['재현 테스트가 있다'] }], allow: ['wax', 'test', 'write'] }));
await createFeature(root, { id: 'fix-sum', title: 'sumTo 고치기' });

function fakeClaude(requests) {
  return () => {
    const child = new EventEmitter();
    for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
    const emit = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    let index = 0;
    const next = () => (index < requests.length ? emit({ type: 'control_request', request_id: `perm-${index}`, request: { subtype: 'can_use_tool', ...requests[index] } })
      : emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session', structured_output: { outcome: 'blocked', report: '확인용 가짜 작업자' } }));
    child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); };
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const m = JSON.parse(line);
        if (m.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        else if (m.type === 'user') { emit({ type: 'system', subtype: 'init', session_id: 'fake-session' }); next(); }
        else if (m.type === 'control_response') { index++; next(); }
      }
    });
    return child;
  };
}
const status = { tool_name: 'Bash', input: { command: `node "${CLI}" status fix-sum` } };
const executeWorker = (dir, input) => runAgentSession(dir, { ...input, executable: 'fake.js', launch: fakeClaude([status, status]) });
const requestTools = async () => [{ id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }];
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
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${base}${path}`);
  return page;
};
async function until(check, what, timeoutMs = 10_000) {
  for (const started = Date.now(); !(await check()); await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const checked = (scope) => scope.locator('input[name="allow"]').evaluateAll((nodes) => nodes.map((node) => `${node.value}:${node.checked}:${node.disabled}`));

try {
  const manage = await open('/manage');
  const panel = manage.locator('#pm-loop-panel');
  await panel.getByRole('button', { name: '레시피로 시작' }).click();
  await panel.locator('.pm-recipe[data-recipe="quick-fix"]').getByRole('button', { name: '이 레시피로 시작' }).click();
  const start = panel.locator('.pm-recipe-start');
  await start.locator('input[name="recipe-input"]').fill('sum');
  await start.getByRole('button', { name: '채우기' }).click();
  const allow = start.locator('.pm-allow');
  await allow.waitFor();
  assert.match(await allow.innerText(), /이 목표 동안 같은 요청 허용[\s\S]*체크한 종류만 켜집니다/);
  assert.deepEqual(await checked(allow), ['wax:false:false', 'test:false:true', 'write:false:false', 'read:false:false'], 'every kind starts unchecked, even the suggested ones');
  assert.deepEqual(await allow.locator('.pm-allow-kind:has(.pm-allow-suggested)').evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ['wax', 'test', 'write']);
  assert.match(await allow.innerText(), /셸 특수 문자[\s\S]*wax test <작업 ID> -- <아래 검사 명령>만/);
  await allow.locator('input[name="allow-test"]').fill('npm run lint && npm test');
  await allow.locator('input[name="allow"][value="test"]').check();
  await start.getByRole('button', { name: '목표 만들기' }).click();
  await panel.locator('p.error[role="alert"]', { hasText: '셸 특수 문자' }).waitFor({ timeout: 10_000 });
  assert.equal(await panel.locator('.pm-goal').count(), 0, 'no goal is created');
  await allow.locator('input[name="allow"][value="test"]').uncheck();
  await allow.locator('input[name="allow-test"]').fill('node --test');
  assert.equal(await allow.locator('input[name="allow"][value="test"]').isDisabled(), false);
  await allow.locator('input[name="allow"][value="wax"]').check();
  await allow.locator('input[name="allow"][value="test"]').check();
  const phone = await open('/manage', { width: 390, height: 844 });
  const phonePanel = phone.locator('#pm-loop-panel');
  await phonePanel.getByRole('button', { name: '레시피로 시작' }).click();
  await phonePanel.locator('.pm-recipe[data-recipe="quick-fix"]').getByRole('button', { name: '이 레시피로 시작' }).click();
  await phonePanel.locator('input[name="recipe-input"]').fill('sum');
  await phonePanel.getByRole('button', { name: '채우기' }).click();
  await phonePanel.locator('.pm-recipe-start .pm-allow input[name="allow-test"]').fill(`node --test ${'test/very-long-name.test.mjs '.repeat(6).trim()}`);
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the allowance fields');
  await start.getByRole('button', { name: '목표 만들기' }).click();
  await panel.locator('.pm-goal').waitFor();
  const goal = panel.locator(`.pm-goal[data-goal="${await panel.locator('.pm-goal').getAttribute('data-goal')}"]`);
  const state = goal.locator('.pm-allow-state');
  await state.waitFor();
  assert.equal(await state.getAttribute('data-allow'), 'on');
  assert.match(await state.innerText(), /이 목표 동안 같은 요청 허용[\s\S]*켜짐[\s\S]*대표[\s\S]*wax 명령[\s\S]*검사 명령[\s\S]*node --test/);
  assert.deepEqual(await state.locator('.pm-allow-kinds li').evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ['wax', 'test']);
  await phone.reload();
  await phone.locator('#pm-loop-panel .pm-allow-state[data-allow="on"]').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the goal allowance on');
  await state.getByRole('button', { name: '허용 끄기' }).click();
  await goal.locator('.pm-allow-state[data-allow="off"]').waitFor();
  assert.match(await goal.locator('.pm-allow-state').innerText(), /꺼짐[\s\S]*실행 승인 화면/);
  assert.match(await goal.locator('.pm-decisions').textContent(), /목표 허용 · 끔/);

  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  const form = panel.locator('form.pm-form');
  assert.deepEqual(await checked(form.locator('.pm-allow')), ['wax:false:false', 'test:false:true', 'write:false:false', 'read:false:false']);
  await form.locator('input[name="title"]').fill('sumTo 고치기');
  await form.locator('input[name="feature"][value="fix-sum"]').check();
  await form.getByRole('button', { name: '목표 만들기' }).click();
  const second = panel.locator('.pm-goal', { hasText: 'sumTo 고치기' });
  await second.locator('.pm-allow-state[data-allow="off"]').waitFor();

  await second.getByRole('button', { name: '계획 확인하고 시작' }).click();
  const workerCard = second.locator('.pm-card[data-kind="start-worker"]');
  await workerCard.waitFor({ timeout: 10_000 });
  await workerCard.getByRole('button', { name: 'Claude Code 작업자 시작' }).click();
  const approvals = manage.locator('#approvals');
  const card = approvals.locator('.approval-list .approval-card');
  await card.waitFor({ timeout: 10_000 });
  assert.match(await card.innerText(), /goal-[a-f0-9]{8} 목표의 작업자 요청/);
  const keep = card.locator('.approval-goal-allow');
  assert.equal(await keep.innerText(), '허용하고 이 목표 동안 같은 요청 허용 (wax 명령(status·save·complete))');
  await phone.reload();
  await phone.locator('#approvals .approval-goal-allow').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the approval card');
  await keep.click();
  await until(async () => (await listApprovals(root)).requests.some((item) => item.allowKind === 'wax'), 'the second request to be allowed by the goal allowance');
  const auto = approvals.locator('.approval-goal-allowed');
  await auto.locator('summary', { hasText: '목표 허용으로 허용됨 1번' }).waitFor({ timeout: 10_000 });
  await second.locator('.pm-allow-state[data-allow="on"]').waitFor({ timeout: 10_000 });
  assert.deepEqual(await second.locator('.pm-allow-kinds li').evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ['wax']);
  await second.locator('.pm-allow-used', { hasText: '목표 허용으로 허용됨 1번' }).waitFor({ timeout: 10_000 });
  assert.equal(await goal.locator('.pm-allow-state').getAttribute('data-allow'), 'off', 'the first goal stays off');

  const english = await open('/manage?lang=en');
  const englishPanel = english.locator('#pm-loop-panel');
  await englishPanel.locator('.pm-allow-state').first().waitFor();
  assert.match(await englishPanel.locator('.pm-goal', { hasText: 'sumTo' }).locator('.pm-allow-state').innerText(), /Allow the same requests during this goal[\s\S]*On[\s\S]*wax commands[\s\S]*Allowed by the goal allowance 1 times/);
  await englishPanel.getByRole('button', { name: '＋ New goal' }).click();
  assert.match(await englishPanel.locator('form.pm-form .pm-allow').innerText(), /Only the kinds you check are turned on[\s\S]*shell metacharacters[\s\S]*Test command[\s\S]*Only wax test <task ID> -- <the test command below>[\s\S]*Writes under \.wax\/tmp[\s\S]*Reading project files/);
  assert.deepEqual(errors, []);
  console.log('goal allowance browser check passed');
} finally {
  await browser.close();
  await server.shutdown();
  await rm(root, { recursive: true, force: true });
}
