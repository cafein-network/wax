import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, getFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { startBeat } from '../src/chat/listeners.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];
const BIN = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const run = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'wax-pm-loop-'));
const wax = (...args) => run(process.execPath, [BIN, '--project', root, ...args], { cwd: root, env: { ...process.env, WAX_LANG: 'ko' } });
await createFeature(root, { id: 'login', title: '로그인 화면' });
await setPm(root, { author: '대표', kind: 'human' });
const sessions = {};
const beats = [];
for (const [author, kind] of [['codex-a', 'codex'], ['claude-a', 'claude']]) {
  sessions[author] = (await joinPresence(root, { author, kind })).session;
  beats.push(await startBeat(root, author, null, 10_000, () => {}));
}
const workerRuns = [];
const AUTO_FREE = new Set(['refund']);
async function executeWorker(dir, input) {
  const author = input.prompt.match(/작업자 이름: ([^.]+)\./)[1];
  const phase = input.prompt.match(/단계: ([a-z]+), 업무/)[1];
  const feature = input.prompt.match(/작업: ([^,]+), 단계/)[1];
  let release;
  const gate = new Promise((done) => { release = done; });
  workerRuns.push({ tool: input.tool, author, phase, feature, release });
  if (!AUTO_FREE.has(feature)) await Promise.race([gate, new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))]);
  const doc = join(root, `${feature}-${phase}.md`);
  await writeFile(doc, `# ${phase}\n\n가짜 headless 작업자가 남긴 문서입니다.\n`);
  await wax('save', phase, feature, '--file', doc);
  await wax('complete', phase, feature, '--evidence', `${phase} 완료(가짜 작업자)`, '--author', author, ...(['implement', 'review'].includes(phase) ? ['--no-proof', '브라우저 검사의 가짜 작업자'] : []), ...(phase === 'review' ? ['--verdict', 'pass'] : []));
  return { threadId: 'fake-worker', status: 'completed', message: JSON.stringify({ outcome: 'done', report: `${phase} 단계를 끝냈습니다.` }) };
}
const judgeRuns = [];
async function executeJudge(dir, input) {
  judgeRuns.push({ tool: input.tool, prompt: input.prompt, schema: input.outputSchema });
  return { threadId: 'fake-judge', status: 'completed', message: JSON.stringify({ tasks: [{ id: 'pay', title: '결제 화면', ac: ['카드 결제가 된다'] }, { id: 'pay-api', title: '결제 API', ac: ['영수증을 돌려준다', '실패 이유를 알린다'] }], reason: '화면과 API로 나눔' }) };
}
const requestTools = async () => [{ id: 'codex', label: 'Codex', installed: true, approval: 'dashboard' }, { id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }];
const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 50, executeWorker, executeJudge, requestTools });
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
async function until(check, what, timeoutMs = 10_000) {
  for (const started = Date.now(); !(await check()); await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function finish(phase, taskId, author) {
  const doc = join(root, `${phase}.md`);
  await writeFile(doc, `# ${phase}\n\n가짜 작업자가 남긴 문서입니다.\n`);
  await wax('save', phase, 'login', '--file', doc);
  await wax('complete', phase, 'login', '--evidence', `${phase} 완료`, '--author', author, ...(['implement', 'review'].includes(phase) ? ['--no-proof', '브라우저 검사의 가짜 작업자'] : []), ...(phase === 'review' ? ['--verdict', 'pass'] : []));
  await wax('chat', 'task', 'done', taskId, '--author', author, '--session', sessions[author]);
}

try {
  const manage = await open('/manage');
  const panel = manage.locator('#pm-loop-panel');
  await panel.locator('.empty').waitFor();
  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('로그인 화면 마무리');
  await panel.locator('input[name="feature"][value="login"]').check();
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const goal = panel.locator('.pm-goal');
  await goal.waitFor();
  const goalId = await goal.getAttribute('data-goal');
  assert.match(goalId, /^goal-[a-f0-9]{8}$/);
  assert.equal(await goal.getAttribute('data-state'), 'planning');
  await goal.getByRole('button', { name: '계획 확인하고 시작' }).click();

  const assignedTo = {};
  for (const phase of ['plan', 'design', 'implement', 'review', 'report']) {
    const card = goal.locator(`.pm-card[data-kind="assign"][data-key^="login:0:${phase}:assign"]`);
    let to;
    for (const started = Date.now(); !to; await new Promise((done) => setTimeout(done, 50))) {
      const { goals } = await (await fetch(`${base}/api/pm-loop`)).json();
      to = goals.find((item) => item.id === goalId)?.suggestions.find((item) => item.kind === 'assign' && item.phase === phase)?.to;
      if (Date.now() - started > 10_000) throw new Error(`no ${phase} assignment card`);
    }
    assert.ok(sessions[to], `${phase} → ${to}`);
    const button = card.getByRole('button', { name: `${to}에게 배정` });
    await button.waitFor({ timeout: 10_000 });
    assert.equal(await goal.locator('.pm-card[data-kind="assign"]').count(), 1, 'only the current phase is suggested');
    await button.click();
    await goal.locator(`.pm-feature[data-feature="login"]`, { hasText: to }).waitFor();
    await card.waitFor({ state: 'detached' });
    const { tasks } = await (await fetch(`${base}/api/team`)).json();
    const task = tasks.find((item) => item.feature === 'login' && item.phase === phase);
    assert.deepEqual([task.to, task.by], [to, '대표']);
    assignedTo[phase] = to;
    await finish(phase, task.id, to);
  }
  const kinds = { 'codex-a': 'codex', 'claude-a': 'claude' };
  assert.notEqual(kinds[assignedTo.review], kinds[assignedTo.implement], 'review goes to a different tool than implement');

  const draft = goal.locator('.pm-card[data-kind="pr-body"]');
  await draft.waitFor({ timeout: 10_000 });
  assert.match(await draft.innerText(), /사람 결정[\s\S]*PR을 만들지는 사람이 정합니다/);
  assert.equal(await goal.getAttribute('data-state'), 'waiting-human');
  await draft.getByRole('button', { name: 'PR 초안 만들기' }).click();
  const waiting = goal.locator('.pm-card[data-kind="await-pr"]');
  await waiting.waitFor();
  assert.match(await waiting.innerText(), new RegExp(`\\.wax/chat/pm-loop/${goalId}\\.login\\.pr-body\\.md`));
  assert.match(await readFile(join(root, '.wax', 'chat', 'pm-loop', `${goalId}.login.pr-body.md`), 'utf8'), /로그인 화면/);
  await goal.locator('.pm-decisions summary').click();
  assert.match(await goal.locator('.pm-decisions').innerText(), /PR 초안 · 실행함[\s\S]*배정 제안 · 실행함/);

  const trace = await (await fetch(`${base}/api/features/login/trace`)).json();
  assert.equal(trace.visits.find((visit) => visit.phase === 'review').pm[0].to, assignedTo.review);

  await goal.getByRole('button', { name: '목표 정지' }).click();
  await panel.locator('.pm-goal[data-state="stopped"]').waitFor();
  assert.equal(await goal.locator('.pm-card').count(), 0, 'a stopped goal shows no cards');
  assert.match(await goal.innerText(), /사람이 정지했습니다/);
  await goal.getByRole('button', { name: '목표 재개' }).click();
  await panel.locator('.pm-goal[data-state="waiting-human"] .pm-card[data-kind="await-pr"]').waitFor();
  await goal.locator('.pm-card[data-kind="await-pr"]').getByRole('button', { name: 'PR 결정함' }).click();
  await panel.locator('.pm-goal[data-state="done"]').waitFor();

  while (beats.length) await beats.pop()();
  await createFeature(root, { id: 'signup', title: '가입 화면' });
  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('가입 화면');
  await panel.locator('input[name="feature"][value="signup"]').check();
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const signup = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="signup"]') });
  await signup.getByRole('button', { name: '계획 확인하고 시작' }).click();
  const workerCard = signup.locator('.pm-card[data-kind="start-worker"][data-key^="signup:0:plan:start-worker"]');
  await workerCard.waitFor({ timeout: 10_000 });
  assert.match(await workerCard.innerText(), /듣고 있는 세션이 없습니다[\s\S]*실행 승인 화면/);
  await workerCard.locator('select[name="tool"]').selectOption('claude');
  await workerCard.getByRole('button', { name: 'Claude Code 작업자 시작' }).click();
  const runningWorker = signup.locator('.pm-worker[data-tool="claude"]');
  await runningWorker.waitFor({ timeout: 10_000 });
  assert.match(await runningWorker.innerText(), /Claude Code[\s\S]*signup[\s\S]*wax-worker-claude[\s\S]*\d+초 경과/);
  assert.equal(await signup.locator('.pm-card').count(), 0, 'no new card while the worker runs (dedupe)');
  await until(() => workerRuns.length === 1, 'the fake worker to be called');
  assert.deepEqual([workerRuns[0].tool, workerRuns[0].phase], ['claude', 'plan']);

  const phone = await open('/manage', { width: 390, height: 844 });
  await phone.locator('#pm-loop-panel .pm-worker').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with a running worker');
  await phone.locator('#pm-loop-panel').getByRole('button', { name: '＋ 새 목표' }).click();
  await phone.locator('#pm-loop-panel .pm-form').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px');

  workerRuns[0].release();
  const nextCard = signup.locator('.pm-card[data-kind="start-worker"][data-key^="signup:0:design:start-worker"]');
  await nextCard.waitFor({ timeout: 10_000 });
  await runningWorker.waitFor({ state: 'detached' });
  const { tasks: afterWorker } = await (await fetch(`${base}/api/team?all=1`)).json();
  assert.ok(!afterWorker.some((item) => item.feature === 'signup' && item.phase === 'plan' && ['open', 'accepted', 'blocked'].includes(item.status)), 'the worker closed its assignment');
  await nextCard.getByRole('button', { name: /작업자 시작$/ }).click();
  const second = signup.locator('.pm-worker');
  await second.waitFor({ timeout: 10_000 });
  await second.getByRole('button', { name: '작업자 멈추기' }).click();
  await second.waitFor({ state: 'detached', timeout: 10_000 });
  await signup.locator('.pm-decisions summary').click();
  assert.match(await signup.locator('.pm-decisions').innerText(), /작업자 · 정지함[\s\S]*작업자 · 종료함[\s\S]*작업자 · 시작함/);

  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('결제 기능');
  await panel.locator('textarea[name="create"]').fill('pay 결제 화면');
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const pay = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="pay"]') });
  const judgeCard = pay.locator('.pm-card[data-kind="judge"]');
  await judgeCard.waitFor({ timeout: 10_000 });
  assert.match(await judgeCard.innerText(), /계획 초안[\s\S]*읽기 전용/);
  assert.equal(judgeRuns.length, 0, 'nothing is called before a person confirms');
  await judgeCard.getByRole('button', { name: 'PM 판단 받기 (Codex)' }).click();
  const proposalCard = pay.locator('.pm-card[data-kind="judge-proposal"]');
  await proposalCard.waitFor({ timeout: 10_000 });
  assert.deepEqual([judgeRuns.length, judgeRuns[0].tool, judgeRuns[0].schema.required], [1, 'codex', ['tasks', 'reason']]);
  assert.match(judgeRuns[0].prompt, /읽기 전용입니다[\s\S]*> {5}"title": "결제 기능"/);
  assert.match(await proposalCard.innerText(), /화면과 API로 나눔/);
  const phoneJudge = await open('/manage', { width: 390, height: 844 });
  await phoneJudge.locator('#pm-loop-panel .pm-card[data-kind="judge-proposal"] .pm-plan-task').first().waitFor();
  assert.equal(await noHorizontalScroll(phoneJudge), true, '/manage at 390px with a PM judgment proposal');
  await proposalCard.locator('.pm-plan-task[data-task="pay-api"] input[name="judge-title"]').fill('결제 API 서버');
  await proposalCard.getByRole('button', { name: '계획 초안 반영' }).click();
  await pay.locator('.pm-feature[data-feature="pay-api"]').waitFor({ timeout: 10_000 });
  await proposalCard.waitFor({ state: 'detached' });
  const payApi = await getFeature(root, 'pay-api');
  assert.equal(payApi.title, '결제 API 서버');
  assert.match(payApi.artifacts.plan, /- AC-2: 실패 이유를 알린다/);
  assert.equal(await pay.getAttribute('data-state'), 'planning', 'plan confirmation stays with a person');
  await pay.locator('.pm-card[data-kind="confirm-plan"]').waitFor();
  await pay.locator('.pm-decisions summary').click();
  assert.match(await pay.locator('.pm-decisions').innerText(), /PM 판단 제안 · 실행함[\s\S]*PM 판단 기록 · 제안 받음[\s\S]*PM 판단 기록 · 요청함/);
  const payTrace = await (await fetch(`${base}/api/features/pay/trace`)).json();
  assert.deepEqual(payTrace.visits[0].pm.filter((item) => item.kind === 'judgment').map((item) => item.outcome), ['requested', 'proposed']);

  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('환불 자동 진행');
  await panel.locator('textarea[name="create"]').fill('refund 환불 화면');
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const refund = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="refund"]') });
  const mode = refund.locator('.pm-mode');
  await mode.waitFor({ timeout: 10_000 });
  assert.equal(await mode.getAttribute('data-mode'), 'suggest', 'suggest is the default');
  await mode.locator('summary').click();
  assert.match(await mode.innerText(), /auto가 카드 없이 하는 일[\s\S]*auto가 하지 않는 일[\s\S]*PR 만들기·push·병합/);
  await mode.getByRole('button', { name: 'auto 켜기' }).click();
  await refund.locator('.pm-mode[data-mode="auto"]').waitFor({ timeout: 10_000 });
  assert.match(await refund.locator('.pm-mode').innerText(), /auto 켜짐 · 대표/);
  const before = workerRuns.length;
  await refund.getByRole('button', { name: '계획 확인하고 시작' }).click();
  const autoDraft = refund.locator('.pm-card[data-kind="pr-body"]');
  await autoDraft.waitFor({ timeout: 30_000 });
  const autoRuns = workerRuns.slice(before);
  assert.deepEqual(autoRuns.map((item) => `${item.phase}:${item.tool}`), ['plan:codex', 'design:codex', 'implement:codex', 'review:claude', 'report:codex'], 'review uses a different tool');
  assert.equal(await refund.getAttribute('data-state'), 'waiting-human');
  assert.match(await autoDraft.innerText(), /사람 결정/);
  assert.equal(judgeRuns.length, 1, 'auto runs neither the plan draft nor the CEO report judgment');
  await assert.rejects(readFile(join(root, '.wax', 'chat', 'pm-loop', `${await refund.getAttribute('data-goal')}.refund.pr-body.md`)), 'auto does not write the PR draft');
  assert.match(await refund.locator('.pm-auto-usage').innerText(), /지난 1시간 auto 행동 5\/12/);
  assert.ok(await refund.locator('.pm-auto-activity li[data-rule="start-worker-review"]').count() > 0, 'the review worker started by auto shows with its rule');
  await refund.locator('.pm-decisions summary').click();
  assert.match(await refund.locator('.pm-decisions').innerText(), /작업자 필요 · 실행함 · refund · auto start-worker/);
  const refundTrace = await (await fetch(`${base}/api/features/refund/trace`)).json();
  assert.ok(refundTrace.visits.find((visit) => visit.phase === 'review').pm.some((item) => item.by === 'auto' && /start-worker-review/.test(item.reason)));
  const phoneAuto = await open('/manage', { width: 390, height: 844 });
  await phoneAuto.locator('#pm-loop-panel .pm-mode[data-mode="auto"] .pm-auto-activity').waitFor();
  await phoneAuto.locator('#pm-loop-panel .pm-mode[data-mode="auto"] summary').first().click();
  assert.equal(await noHorizontalScroll(phoneAuto), true, '/manage at 390px with auto mode and its activity');

  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('취소 흐름');
  await panel.locator('textarea[name="create"]').fill('cancel-flow 취소 흐름');
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const cancel = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="cancel-flow"]') });
  await cancel.getByRole('button', { name: 'auto 켜기' }).click();
  await cancel.locator('.pm-mode[data-mode="auto"]').waitFor({ timeout: 10_000 });
  await cancel.getByRole('button', { name: '계획 확인하고 시작' }).click();
  const autoWorker = cancel.locator('.pm-worker');
  await autoWorker.waitFor({ timeout: 10_000 });
  assert.equal(await cancel.locator('.pm-card').count(), 0, 'auto started the worker without a card');
  await until(() => workerRuns.some((item) => item.feature === 'cancel-flow'), 'the cancel-flow worker call');
  await cancel.getByRole('button', { name: '목표 정지' }).click();
  await panel.locator('.pm-goal[data-state="stopped"]', { has: manage.locator('.pm-feature[data-feature="cancel-flow"]') }).waitFor({ timeout: 10_000 });
  await autoWorker.waitFor({ state: 'detached', timeout: 10_000 });
  await cancel.locator('.pm-decisions summary').click();
  assert.match(await cancel.locator('.pm-decisions').innerText(), /작업자 · 정지함 · cancel-flow · 대표[\s\S]*작업자 · 시작함 · cancel-flow · auto/);
  const cancelId = await cancel.getAttribute('data-goal');
  const launches = async () => (await (await fetch(`${base}/api/pm-loop/${cancelId}`)).json()).decisions.filter((item) => item.kind === 'worker' && item.outcome === 'launched').length;
  server.pmLoop.poke();
  await server.pmLoop.tick();
  assert.equal(await launches(), 1, 'nothing new starts after the stop');
  assert.equal(workerRuns.filter((item) => item.feature === 'cancel-flow').length, 1);

  const english = await open('/manage?lang=en');
  await english.locator(`#pm-loop-panel .pm-goal[data-goal="${goalId}"]`).waitFor();
  assert.equal(await english.locator('#pm-loop-heading').innerText(), 'PM loop');
  assert.match(await english.locator(`#pm-loop-panel .pm-goal[data-goal="${goalId}"] .pm-state`).innerText(), /Done/);
  assert.deepEqual(errors, []);
  console.log('pm loop browser check passed');
} finally {
  await browser.close();
  await server.shutdown();
  for (const stop of beats) await stop();
  await rm(root, { recursive: true, force: true });
}
