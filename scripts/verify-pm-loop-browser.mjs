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
import { joinPresence, setPresence } from '../src/chat/presence.mjs';
import { startBeat } from '../src/chat/listeners.mjs';
import { claudeUsage } from '../src/tool-usage.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];
const BIN = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const run = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'wax-pm-loop-'));
await run('git', ['init', '-q'], { cwd: root });
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
const AUTO_FREE = new Set(['refund', 'metered', 'costed']);
const METERED = claudeUsage(JSON.parse(JSON.parse(await readFile(new URL('../test/fixtures/usage/claude-result.json', import.meta.url), 'utf8')).line));
async function executeWorker(dir, input) {
  const author = input.prompt.match(/작업자 이름: ([^.]+)\./)[1];
  const phase = input.prompt.match(/단계: ([a-z]+), 업무/)[1];
  const feature = input.prompt.match(/작업: ([^,]+), 단계/)[1];
  if (REPEATERS.has(feature)) return repeatWorker(input, { author, phase, feature });
  if (feature === 'rootcause') return rootCauseWorker(input, { author, feature });
  let release;
  const gate = new Promise((done) => { release = done; });
  workerRuns.push({ tool: input.tool, author, phase, feature, release });
  if (!AUTO_FREE.has(feature)) await Promise.race([gate, new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))]);
  const doc = join(root, `${feature}-${phase}.md`);
  await writeFile(doc, `# ${phase}\n\n가짜 headless 작업자가 남긴 문서입니다.\n`);
  await wax('save', phase, feature, '--file', doc);
  await wax('complete', phase, feature, '--evidence', `${phase} 완료(가짜 작업자)`, '--author', author, ...(['implement', 'review'].includes(phase) ? ['--no-proof', '브라우저 검사의 가짜 작업자'] : []), ...(phase === 'review' ? ['--verdict', 'pass'] : []));
  return { threadId: 'fake-worker', status: 'completed', message: JSON.stringify({ outcome: 'done', report: `${phase} 단계를 끝냈습니다.` }), ...(['metered', 'costed'].includes(feature) && input.tool === 'claude' ? { usage: METERED } : {}) };
}
const REPEATERS = new Set(['flaky', 'stuck']);
const FAIL = `console.log('took', Date.now() % 1000, 'ms in', require('os').tmpdir() + '/run-' + Math.random().toString(36).slice(2)); console.error('Expected sum to be three'); process.exit(1)`;
async function repeatWorker(input, { author, phase, feature }) {
  let release;
  const gate = new Promise((done) => { release = done; });
  workerRuns.push({ tool: input.tool, author, phase, feature, release });
  const aborted = new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  aborted.catch(() => {});
  for (let i = 0; i < 6 && !input.signal.aborted; i++) {
    await wax('test', feature, '--author', author, '--', process.execPath, '-e', FAIL).catch(() => {});
    input.activity({ approvals: 0 });
    await Promise.race([new Promise((done) => setTimeout(done, 150)), aborted]);
    if (feature === 'flaky' && i === 2) break;
  }
  await Promise.race([gate, aborted]);
  return { threadId: 'fake-worker', status: 'completed', message: JSON.stringify({ outcome: 'blocked', report: '같은 검사가 계속 실패합니다.' }) };
}
const rootCausePrompts = [];
async function rootCauseWorker(input, { author, feature }) {
  if (!input.prompt.startsWith('앞선 시도가 같은 검사를')) return repeatWorker(input, { author, phase: 'plan', feature });
  rootCausePrompts.push(input.prompt);
  await wax('test', feature, '--author', author, '--', process.execPath, '-e', FAIL).catch(() => {});
  const first = rootCausePrompts.length === 1;
  return { threadId: 'fake-worker', status: 'completed', message: JSON.stringify({ outcome: 'blocked', report: '가설을 확인했지만 고쳐지지 않았습니다.',
    rootCause: first ? { reproduced: true, hypothesis: '포트 3000을 낡은 시험 서버가 쥐고 있다', change: '시험 포트를 바꿈', result: 'not-fixed' } : null }) };
}
const judgeRuns = [];
async function executeJudge(dir, input) {
  judgeRuns.push({ tool: input.tool, prompt: input.prompt, schema: input.outputSchema });
  return { threadId: 'fake-judge', status: 'completed', message: JSON.stringify({ tasks: [{ id: 'pay', title: '결제 화면', ac: ['카드 결제가 된다'] }, { id: 'pay-api', title: '결제 API', ac: ['영수증을 돌려준다', '실패 이유를 알린다'] }], reason: '화면과 API로 나눔' }) };
}
const requestTools = async () => [{ id: 'codex', label: 'Codex', installed: true, approval: 'dashboard' }, { id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' },
  { id: 'antigravity', label: 'Antigravity CLI', installed: true, approval: 'configured' }];
delete process.env.WAX_STUCK_CHECK;
const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 50, executeWorker, executeJudge, requestTools, stuckPollMs: 0 });
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
async function openedText(details, pattern, what) {
  let text = '';
  await until(async () => {
    const open = await details.evaluate((node) => node.open).catch(() => false);
    if (!open) await details.locator(':scope > summary').click({ timeout: 2000 }).catch(() => {});
    text = await details.innerText().catch(() => '');
    return pattern.test(text);
  }, `${what} to show ${pattern}`);
  return text;
}
const closePages = (...pages) => Promise.all(pages.map((page) => page.context().close()));
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
  await openedText(goal.locator('.pm-decisions'), /PR 초안 · 실행함[\s\S]*배정 제안 · 실행함/, 'the login decision log');

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
  await closePages(phone);

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
  await openedText(signup.locator('.pm-decisions'), /작업자 · 정지함[\s\S]*작업자 · 종료함[\s\S]*작업자 · 시작함/, 'the signup decision log');
  await signup.locator('.pm-decisions').evaluate((node) => { node.dataset.before = '1'; });
  await setPresence(root, { author: 'codex-a', session: sessions['codex-a'], kind: 'codex', state: 'idle', note: '다시 그리기 확인' });
  await until(() => signup.locator('.pm-decisions').evaluate((node) => node.dataset.before !== '1').catch(() => false), 'the panel to re-render');
  assert.equal(await signup.locator('.pm-decisions').evaluate((node) => node.open), true, 'the decision log stays open across re-renders');

  await createFeature(root, { id: 'audit', title: '감사 로그' });
  for (const phase of ['plan', 'design']) {
    const doc = join(root, `audit-${phase}.md`);
    await writeFile(doc, `# ${phase}\n`);
    await wax('save', phase, 'audit', '--file', doc);
    await wax('complete', phase, 'audit', '--evidence', `${phase} 완료`, '--author', '대표');
  }
  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('감사 로그');
  await panel.locator('input[name="feature"][value="audit"]').check();
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const audit = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="audit"]') });
  await audit.getByRole('button', { name: '계획 확인하고 시작' }).click();
  const implementCard = audit.locator('.pm-card[data-kind="start-worker"][data-key^="audit:0:implement:start-worker"]');
  await implementCard.waitFor({ timeout: 10_000 });
  assert.equal(await implementCard.locator('.pm-tool-warning').isVisible(), false, 'no warning for the default tool');
  await implementCard.locator('select[name="tool"]').selectOption('antigravity');
  const warning = implementCard.locator('.pm-tool-warning');
  await warning.waitFor({ state: 'visible' });
  assert.match(await warning.innerText(), /Antigravity CLI은\(는\) headless에서 실행 권한을 물을 수 없어[\s\S]*permissions\.allow[\s\S]*implement 단계/);
  assert.equal(await implementCard.getByRole('button', { name: 'Antigravity CLI 작업자 시작' }).isVisible(), true, 'a person can still choose it');
  await implementCard.locator('select[name="tool"]').selectOption('codex');
  await warning.waitFor({ state: 'hidden' });
  await audit.getByRole('button', { name: '목표 정지' }).click();
  await panel.locator('.pm-goal[data-state="stopped"]', { has: manage.locator('.pm-feature[data-feature="audit"]') }).waitFor({ timeout: 10_000 });

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
  await closePages(phoneJudge);
  await proposalCard.locator('.pm-plan-task[data-task="pay-api"] input[name="judge-title"]').fill('결제 API 서버');
  await proposalCard.getByRole('button', { name: '계획 초안 반영' }).click();
  await pay.locator('.pm-feature[data-feature="pay-api"]').waitFor({ timeout: 10_000 });
  await proposalCard.waitFor({ state: 'detached' });
  const payApi = await getFeature(root, 'pay-api');
  assert.equal(payApi.title, '결제 API 서버');
  assert.match(payApi.artifacts.plan, /- AC-2: 실패 이유를 알린다/);
  assert.equal(await pay.getAttribute('data-state'), 'planning', 'plan confirmation stays with a person');
  await pay.locator('.pm-card[data-kind="confirm-plan"]').waitFor();
  await openedText(pay.locator('.pm-decisions'), /PM 판단 제안 · 실행함[\s\S]*PM 판단 기록 · 제안 받음[\s\S]*PM 판단 기록 · 요청함/, 'the pay decision log');
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
  await openedText(mode.locator('.pm-mode-help'), /auto가 카드 없이 하는 일[\s\S]*auto가 하지 않는 일[\s\S]*PR 만들기·push·병합/, 'the auto mode help');
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
  await openedText(refund.locator('.pm-decisions'), /작업자 필요 · 실행함 · refund · auto start-worker/, 'the refund decision log');
  const refundTrace = await (await fetch(`${base}/api/features/refund/trace`)).json();
  assert.ok(refundTrace.visits.find((visit) => visit.phase === 'review').pm.some((item) => item.by === 'auto' && /start-worker-review/.test(item.reason)));
  const phoneAuto = await open('/manage', { width: 390, height: 844 });
  await phoneAuto.locator('#pm-loop-panel .pm-mode[data-mode="auto"] .pm-auto-activity').waitFor();
  await phoneAuto.locator('#pm-loop-panel .pm-mode[data-mode="auto"] summary').first().click();
  assert.equal(await noHorizontalScroll(phoneAuto), true, '/manage at 390px with auto mode and its activity');
  await closePages(phoneAuto);

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
  await openedText(cancel.locator('.pm-decisions'), /작업자 · 정지함 · cancel-flow · 대표[\s\S]*작업자 · 시작함 · cancel-flow · auto/, 'the cancel-flow decision log');
  const cancelId = await cancel.getAttribute('data-goal');
  const launches = async () => (await (await fetch(`${base}/api/pm-loop/${cancelId}`)).json()).decisions.filter((item) => item.kind === 'worker' && item.outcome === 'launched').length;
  server.pmLoop.poke();
  await server.pmLoop.tick();
  assert.equal(await launches(), 1, 'nothing new starts after the stop');
  assert.equal(workerRuns.filter((item) => item.feature === 'cancel-flow').length, 1);

  for (const [id, title] of [['flaky', '불안정한 검사'], ['stuck', '고칠 수 없는 검사']]) await createFeature(root, { id, title });
  const startRepeat = async (id, title) => {
    await panel.getByRole('button', { name: '＋ 새 목표' }).click();
    await panel.locator('input[name="title"]').fill(title);
    await panel.locator(`input[name="feature"][value="${id}"]`).check();
    await panel.getByRole('button', { name: '목표 만들기' }).click();
    const box = panel.locator('.pm-goal', { has: manage.locator(`.pm-feature[data-feature="${id}"]`) });
    await box.getByRole('button', { name: '계획 확인하고 시작' }).click();
    const start = box.locator(`.pm-card[data-kind="start-worker"][data-key^="${id}:0:plan:start-worker"]`);
    await start.waitFor({ timeout: 10_000 });
    await start.getByRole('button', { name: /작업자 시작$/ }).click();
    return box;
  };
  const flaky = await startRepeat('flaky', '불안정한 검사');
  const warnedRow = flaky.locator('.pm-worker[data-repeat="3"]');
  await warnedRow.waitFor({ timeout: 20_000 });
  assert.match(await warnedRow.innerText(), /같은 실패 3번[\s\S]*같은 테스트가 같은 출력으로 3번 실패했습니다\(경고만, 작업자는 계속 돕니다\)/);
  assert.ok(await warnedRow.locator('.pm-worker-stop').isVisible(), 'warn keeps the worker running');
  const phoneRepeat = await open('/manage', { width: 390, height: 844 });
  await phoneRepeat.locator('#pm-loop-panel .pm-worker[data-repeat="3"]').waitFor();
  assert.equal(await noHorizontalScroll(phoneRepeat), true, '/manage at 390px with a repeat warning');
  await closePages(phoneRepeat);
  const englishRepeat = await open('/manage?lang=en', { width: 390, height: 844 });
  const englishRow = englishRepeat.locator('#pm-loop-panel .pm-worker[data-repeat="3"]');
  await englishRow.waitFor();
  assert.match(await englishRow.innerText(), /Same failure 3 times[\s\S]*The same test failed 3 times with the same output \(warning only, the worker keeps running\)/);
  assert.equal(await noHorizontalScroll(englishRepeat), true, 'English /manage at 390px with a repeat warning');
  await closePages(englishRepeat);
  workerRuns.find((item) => item.feature === 'flaky').release();
  await flaky.locator('.pm-card[data-kind="blocked"]').waitFor({ timeout: 10_000 });
  await openedText(flaky.locator('.pm-decisions'), /작업자 · 종료함[\s\S]*되풀이 감지 · 경고함 · flaky · pm-loop/, 'the flaky decision log');

  process.env.WAX_STUCK_CHECK = 'stop';
  const stuck = await startRepeat('stuck', '고칠 수 없는 검사');
  const stuckCard = stuck.locator('.pm-card[data-kind="blocked"]');
  await stuckCard.waitFor({ timeout: 20_000 });
  assert.equal(await stuck.locator('.pm-worker').count(), 0, 'the stuck worker is gone');
  assert.equal((await getFeature(root, 'stuck')).proofs.length, 3, 'stopped right after the third identical failure');
  await openedText(stuck.locator('.pm-decisions'), /작업자 · 되풀이로 멈춤 · stuck · pm-loop · 같은 테스트가 같은 출력으로 3번 실패해 멈췄습니다/, 'the stuck decision log');
  const phoneStuck = await open('/manage', { width: 390, height: 844 });
  await phoneStuck.locator('#pm-loop-panel .pm-card[data-kind="blocked"]').first().waitFor();
  assert.equal(await noHorizontalScroll(phoneStuck), true, '/manage at 390px with the stuck blocked card');
  await closePages(phoneStuck);
  const englishStuck = await open('/manage?lang=en');
  await englishStuck.locator(`#pm-loop-panel .pm-goal[data-goal="${await stuck.getAttribute('data-goal')}"] .pm-card[data-kind="blocked"]`).waitFor();
  const englishLog = englishStuck.locator(`#pm-loop-panel .pm-goal[data-goal="${await stuck.getAttribute('data-goal')}"] .pm-decisions`);
  await openedText(englishLog, /Stopped as stuck[\s\S]*The same test failed 3 times with the same output, so the worker was stopped/, 'the English stuck decision log');
  await closePages(englishStuck);
  const stuckTrace = await (await fetch(`${base}/api/features/stuck/trace`)).json();
  assert.ok(stuckTrace.visits[0].pm.some((item) => item.kind === 'worker' && item.outcome === 'stuck'));
  delete process.env.WAX_STUCK_CHECK;

  const summaryBox = panel.locator('.pm-review-summary');
  await summaryBox.waitFor();
  assert.match(await summaryBox.innerText(), /되풀이 경고 평가: 맞음 0 · 틀림 0 · 평가 안 함 2[\s\S]*stop 기본 전환 기준: 평가 10건 이상, 틀림 0건\(지금 평가 0건 · 틀림 0건\)[\s\S]*평가 안 한 것:/);
  const flakyReview = flaky.locator('.pm-review[data-subject="repeat-warned"]');
  await flakyReview.waitFor();
  assert.match(await flaky.locator('.pm-reviews > summary').innerText(), /되풀이 경고 평가 1건 · 평가 안 함 1건/);
  assert.match(await flakyReview.innerText(), /경고[\s\S]*flaky[\s\S]*같은 실패 3번[\s\S]*작업자 끝: 종료함/);
  await flakyReview.locator('input[name="review-note"]').fill('흔들리는 테스트');
  await flakyReview.getByRole('button', { name: '틀림' }).click();
  const flakyWrong = flaky.locator('.pm-review[data-subject="repeat-warned"][data-verdict="wrong"]');
  await flakyWrong.waitFor();
  assert.match(await flakyWrong.innerText(), /틀림 · \S+ · [\s\S]*흔들리는 테스트/);
  const stuckReview = stuck.locator('.pm-review[data-subject="repeat-stuck"]');
  await stuckReview.getByRole('button', { name: '맞음' }).click();
  await stuck.locator('.pm-review[data-subject="repeat-stuck"][data-verdict="right"]').waitFor();
  await panel.locator('.pm-review-summary[data-wrong="1"]').waitFor();
  assert.match(await summaryBox.innerText(), /맞음 1 · 틀림 1 · 평가 안 함 0/);
  await flakyWrong.getByRole('button', { name: '바꾸기' }).click();
  await flaky.locator('.pm-review[data-verdict="wrong"] .pm-review-right').click();
  const flakyRight = flaky.locator('.pm-review[data-subject="repeat-warned"][data-verdict="right"]');
  await flakyRight.waitFor();
  assert.match(await flakyRight.innerText(), /맞음 · [\s\S]*이전 평가 1개/);
  await panel.locator('.pm-review-summary[data-right="2"]').waitFor();
  const phoneReview = await open('/manage', { width: 390, height: 844 });
  await phoneReview.locator('#pm-loop-panel .pm-review-summary').waitFor();
  await phoneReview.locator('#pm-loop-panel .pm-reviews > summary').first().click();
  assert.equal(await noHorizontalScroll(phoneReview), true, '/manage at 390px with repeat reviews');
  const englishReview = await open('/manage?lang=en', { width: 390, height: 844 });
  const englishSummary = englishReview.locator('#pm-loop-panel .pm-review-summary');
  await englishSummary.waitFor();
  assert.match(await englishSummary.innerText(), /Repeat warning reviews: right 2 · wrong 0 · not reviewed 0/);
  assert.equal(await noHorizontalScroll(englishReview), true, 'English /manage at 390px with repeat reviews');
  if (process.env.WAX_SCREENSHOT_DIR) {
    await phoneReview.locator('#pm-loop-panel .pm-reviews').first().screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-review-ko-390.png') });
    await phoneReview.locator('#pm-loop-panel .pm-review-summary').screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-review-summary-ko-390.png') });
  }
  await closePages(phoneReview, englishReview);

  const flakyGoal = await flaky.getAttribute('data-goal');
  const flakyLog = join(root, '.wax', 'chat', 'pm-loop', `${flakyGoal}.jsonl`);
  const addLog = (record) => appendRecord(flakyLog, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: flakyGoal, ...record }));
  const fakeBase = { tool: 'claude', feature: 'flaky', phase: 'implement', iteration: 0, to: 'wax-worker-claude' };
  for (let i = 0; i < 10; i++) {
    const worker = `pw-f${String(i).padStart(7, '0')}`, at = Date.now() - 3 * 24 * 3600_000 + i * 60_000;
    await addLog({ kind: 'worker', outcome: 'launched', worker, task: `t-fake-${i}`, by: '대표', ...fakeBase, at: new Date(at).toISOString() });
    await addLog({ kind: 'repeat', outcome: 'warned', worker, by: 'pm-loop', ...fakeBase, at: new Date(at + 1000).toISOString(),
      repeat: { kind: 'test', key: 'f'.repeat(64), command: `node --test fake-${i}.test.js`, exitCode: 1, count: 3, proofIds: [`gone-${i}`] }, reason: 'fake' });
    await addLog({ kind: 'worker', outcome: 'exited', worker, ...fakeBase, at: new Date(at + 2000).toISOString() });
  }
  const listPage = await open('/manage');
  const listPanel = listPage.locator('#pm-loop-panel');
  await listPanel.locator('.pm-review-summary[data-unrated="10"]').waitFor();
  await listPanel.locator('.pm-review-open').click();
  const reviewList = listPanel.locator('.pm-review-list');
  const progress = reviewList.locator('.pm-review-progress p');
  await reviewList.waitFor();
  assert.match(await progress.innerText(), /^평가 2\/10 · 틀림 0 · 모르겠음 0 · 평가 안 함 10$/);
  assert.equal(await reviewList.locator('.pm-review-progress progress').getAttribute('value'), '2');
  assert.equal(await reviewList.locator('.pm-review-row').count(), 10, 'the default filter shows only the not-reviewed rows');
  await reviewList.getByRole('button', { name: '전부' }).click();
  const realRow = reviewList.locator(`.pm-review-row[data-goal="${flakyGoal}"][data-verdict="right"]`);
  await realRow.locator('.pm-review-toggle').click();
  await realRow.locator('.pm-review-normalized').first().waitFor();
  assert.match(await realRow.locator('.pm-review-normalized').first().innerText(), /took <duration> in <tmp>[\s\S]*Expected sum to be three/);
  assert.doesNotMatch(await realRow.locator('.pm-review-raw').first().innerText(), /<tmp>|<duration>/);
  assert.match(await realRow.locator('.pm-review-evidence').innerText(), /종료 코드 1 · 같은 실패 3번 · 같은 열쇠의 근거 3\/3개\s*같은 코드[\s\S]*트리\(커밋 없음\) · 바뀐 파일 \d+개/, 'the test project has no commit yet');
  await reviewList.getByRole('button', { name: '평가 안 한 것만' }).click();
  const current = reviewList.locator('.pm-review-row.current');
  await current.locator('.pm-review-proof[data-missing="true"]').waitFor();
  assert.match(await current.innerText(), /node --test fake-9\.test\.js[\s\S]*근거 없음[\s\S]*맞음 \(1\)[\s\S]*틀림 \(2\)[\s\S]*모르겠음 \(3\)/);
  await current.getByRole('button', { name: '맞음 (1)' }).click();
  await progress.filter({ hasText: '평가 3/10' }).waitFor();
  await reviewList.locator('.pm-review-row.current[data-target] .pm-review-toggle[aria-expanded="true"]').waitFor();
  assert.match(await reviewList.locator('.pm-review-row.current').innerText(), /fake-8\.test\.js/, 'the next not-reviewed row opens');
  await reviewList.locator('.pm-review-row.current input[name="review-note"]').fill('3');
  assert.match(await progress.innerText(), /평가 3\/10/);
  await reviewList.locator('.pm-review-row.current .pm-review-toggle').focus();
  await listPage.keyboard.press('3');
  await progress.filter({ hasText: '모르겠음 1' }).waitFor();
  for (let n = 4; n <= 10; n++) {
    await listPage.keyboard.press('1');
    await progress.filter({ hasText: `평가 ${n}/10` }).waitFor();
  }
  assert.match(await progress.innerText(), /^평가 10\/10 · 틀림 0 · 모르겠음 1 · 평가 안 함 1$/);
  const notSure = (await (await fetch(`${base}/api/pm-loop/${flakyGoal}`)).json()).repeatReviews.find((item) => item.review?.verdict === 'unsure');
  assert.equal(notSure.review.note, '3', 'the note typed in the box went with the not-sure review');
  const card = listPanel.locator('.pm-repeat-default[data-state="ask"]');
  await card.waitFor();
  assert.match(await card.innerText(), /되풀이 평가가 기준에 닿았습니다\(맞음 10 · 틀림 0\)\. 기본값을 stop으로 바꿀지 정해 주세요[\s\S]*설정을 바꾸지 않고 기록만 남깁니다/);
  const phoneCard = await open('/manage', { width: 390, height: 844 });
  await phoneCard.locator('#pm-loop-panel .pm-repeat-default[data-state="ask"]').waitFor();
  await phoneCard.locator('#pm-loop-panel .pm-review-open').click();
  await phoneCard.locator('#pm-loop-panel .pm-review-row.current .pm-review-proof').waitFor();
  assert.equal(await noHorizontalScroll(phoneCard), true, '/manage at 390px with the review list and the threshold card');
  if (process.env.WAX_SCREENSHOT_DIR) await phoneCard.locator('#pm-loop-panel .pm-review-summary-box').screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-review-card-ko-390.png') });
  await card.getByRole('button', { name: '바꾸기로 함' }).click();
  const decided = listPanel.locator('.pm-repeat-default[data-state="decided"]');
  await decided.waitFor();
  assert.match(await decided.innerText(), /stop으로 바꾸기로 함 · \S+ · [\s\S]*다음 배포에서 기본값을 바꿉니다[\s\S]*WAX_STUCK_CHECK=stop/);
  assert.equal(process.env.WAX_STUCK_CHECK, undefined, 'the switch changed no setting');
  assert.match(await readFile(join(root, '.wax', 'chat', 'repeat-default.jsonl'), 'utf8'), /"outcome":"decided","to":"stop"/);
  const englishList = await open('/manage?lang=en', { width: 390, height: 844 });
  await englishList.locator('#pm-loop-panel .pm-review-open').click();
  const englishProgress = englishList.locator('#pm-loop-panel .pm-review-progress p');
  await englishProgress.waitFor();
  assert.match(await englishProgress.innerText(), /^Reviewed 10\/10 · wrong 0 · not sure 1 · not reviewed 1$/);
  assert.match(await englishList.locator('#pm-loop-panel .pm-review-summary').innerText(), /right 10 · wrong 0 · not sure 1 · not reviewed 1[\s\S]*Decided to switch to stop[\s\S]*The default changes in the next release/);
  await englishList.locator('#pm-loop-panel .pm-review-row.current .pm-review-proof').waitFor();
  assert.match(await englishList.locator('#pm-loop-panel .pm-review-row.current').innerText(), /No evidence[\s\S]*Right \(1\)[\s\S]*Wrong \(2\)[\s\S]*Not sure \(3\)/);
  assert.equal(await englishList.locator('#pm-loop-panel .pm-review-row.current input[name="review-note"]').getAttribute('placeholder'), 'Note (optional, 300 characters)');
  assert.doesNotMatch(await englishList.locator('#pm-loop-panel .pm-review-list').innerText(), /null|undefined/);
  assert.equal(await noHorizontalScroll(englishList), true, 'English /manage at 390px with the review list');
  if (process.env.WAX_SCREENSHOT_DIR) await englishList.locator('#pm-loop-panel .pm-review-list').screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-review-list-en-390.png') });
  await closePages(listPage, phoneCard, englishList);

  await createFeature(root, { id: 'metered', title: '사용량 확인' });
  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('사용량 확인');
  await panel.locator('input[name="feature"][value="metered"]').check();
  const form = panel.locator('form', { has: manage.locator('input[name="feature"][value="metered"]') });
  await form.locator('summary', { hasText: '한도' }).click();
  assert.match(await form.innerText(), /토큰 한도\(비우면 없음\)[\s\S]*토큰 한도는 사용량을 알리는 도구\(Claude Code, Antigravity CLI\)에만 걸립니다/);
  await form.locator('input[name="tokens"]').fill('20000');
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const metered = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="metered"]') });
  await metered.getByRole('button', { name: '계획 확인하고 시작' }).click();
  assert.match(await metered.locator('.pm-usage').innerText(), /사용량\(도구가 알린 값\): 아직 headless 실행이 없습니다/);
  assert.match(await metered.locator('.pm-tokens').innerText(), /토큰 한도: 0\/20000/);
  const meteredCard = metered.locator('.pm-card[data-kind="start-worker"][data-key^="metered:0:plan:start-worker"]');
  await meteredCard.waitFor({ timeout: 10_000 });
  await meteredCard.locator('select[name="tool"]').selectOption('codex');
  const meteredWarning = meteredCard.locator('.pm-tool-warning');
  await meteredWarning.waitFor({ state: 'visible' });
  assert.match(await meteredWarning.innerText(), /Codex은\(는\) 사용량을 알리지 않아 이 목표의 토큰 한도에 세지 않습니다\. auto는 띄우지 않습니다/);
  await meteredCard.locator('select[name="tool"]').selectOption('claude');
  await meteredWarning.waitFor({ state: 'hidden' });
  await meteredCard.getByRole('button', { name: 'Claude Code 작업자 시작' }).click();
  const meteredGoal = await metered.getAttribute('data-goal');
  const stoppedMetered = panel.locator(`.pm-goal[data-goal="${meteredGoal}"][data-state="stopped"]`);
  await stoppedMetered.waitFor({ timeout: 15_000 });
  assert.match(await stoppedMetered.locator('p.error').innerText(), /토큰 한도 20000에 닿아 멈췄습니다\(도구가 알린 값\)/);
  assert.match(await stoppedMetered.locator('.pm-usage').innerText(), /사용량\(도구가 알린 값\): Claude Code 입력 2 · 출력 4 · 캐시 읽기 11384 · 캐시 쓰기 10300 · 추론 0 · 비용 \$0\.0847648 · 차례 1 · 실행 1번/);
  assert.match(await stoppedMetered.locator('.pm-tokens').innerText(), /토큰 한도: 21690\/20000\(사용량을 알리는 도구의 실행만 셉니다\)/);
  assert.equal(await stoppedMetered.locator('.pm-resume input[name="tokens"]').inputValue(), '20000', 'raising it is a person resuming');
  const meteredApi = await (await fetch(`${base}/api/pm-loop/${meteredGoal}`)).json();
  assert.deepEqual(meteredApi.decisions.find((item) => item.kind === 'worker' && item.outcome === 'exited').usage, METERED, 'the end record keeps what the tool reported');
  const phoneUsage = await open('/manage', { width: 390, height: 844 });
  await phoneUsage.locator(`#pm-loop-panel .pm-goal[data-goal="${meteredGoal}"] .pm-usage`).waitFor();
  assert.equal(await noHorizontalScroll(phoneUsage), true, '/manage at 390px with usage and a token limit');
  const englishUsage = await open('/manage?lang=en', { width: 390, height: 844 });
  const englishMetered = englishUsage.locator(`#pm-loop-panel .pm-goal[data-goal="${meteredGoal}"]`);
  await englishMetered.locator('.pm-usage').waitFor();
  assert.match(await englishMetered.locator('.pm-usage').innerText(), /Usage \(as reported by the tools\): Claude Code Input 2 · Output 4 · Cache read 11384 · Cache write 10300 · Reasoning 0 · Cost \$0\.0847648 · Turns 1 · Runs 1/);
  assert.match(await englishMetered.locator('.pm-tokens').innerText(), /Token limit: 21690\/20000 \(counts only runs by tools that report usage\)/);
  assert.match(await englishMetered.locator('p.error').innerText(), /Stopped at the token limit of 20000/);
  assert.match(await englishMetered.locator('.pm-tokens-hint').textContent(), /The token limit applies only to tools that report usage/);
  assert.equal(await noHorizontalScroll(englishUsage), true, 'English /manage at 390px with usage and a token limit');
  if (process.env.WAX_SCREENSHOT_DIR) {
    await englishMetered.locator('details.pm-resume > summary').click();
    await englishMetered.screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-usage-en-390.png') });
    await phoneUsage.locator(`#pm-loop-panel .pm-goal[data-goal="${meteredGoal}"]`).screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-usage-ko-390.png') });
  }
  await closePages(phoneUsage, englishUsage);

  await createFeature(root, { id: 'costed', title: '비용 확인' });
  await panel.getByRole('button', { name: '＋ 새 목표' }).click();
  await panel.locator('input[name="title"]').fill('비용 확인');
  await panel.locator('input[name="feature"][value="costed"]').check();
  const costForm = panel.locator('form', { has: manage.locator('input[name="feature"][value="costed"]') });
  await costForm.locator('details', { has: manage.locator('input[name="costUsd"]') }).evaluate((node) => { node.open = true; });
  assert.match(await costForm.innerText(), /비용 한도\(USD, 선택\)[\s\S]*비용 한도는 도구가 알린 비용\(지금은 Claude Code만\)의 합에 걸립니다/);
  await costForm.locator('input[name="costUsd"]').fill('0,05');
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const panelError = panel.locator('p.error[role="alert"]', { hasText: '비용 한도는' });
  await panelError.waitFor({ state: 'visible' });
  assert.match(await panelError.innerText(), /비용 한도는 \$0\.01~\$10000\.00 사이의 달러 금액이어야 합니다\(소수 둘째 자리까지, 소수점은 \. 예: 5\.50\)/);
  await costForm.locator('input[name="costUsd"]').fill('0.05');
  await panel.getByRole('button', { name: '목표 만들기' }).click();
  const costed = panel.locator('.pm-goal', { has: manage.locator('.pm-feature[data-feature="costed"]') });
  await costed.getByRole('button', { name: '계획 확인하고 시작' }).click();
  assert.match(await costed.locator('.pm-cost').innerText(), /비용 한도: \$0\.00 \/ \$0\.05 · 도구가 알린 비용\(실제 청구와 다를 수 있음\)/);
  const costCard = costed.locator('.pm-card[data-kind="start-worker"][data-key^="costed:0:plan:start-worker"]');
  await costCard.waitFor({ timeout: 10_000 });
  await costCard.locator('select[name="tool"]').selectOption('codex');
  const costWarning = costCard.locator('.pm-tool-warning');
  await costWarning.waitFor({ state: 'visible' });
  assert.match(await costWarning.innerText(), /Codex: 이 도구는 비용을 알리지 않습니다/);
  await costCard.locator('select[name="tool"]').selectOption('claude');
  await costWarning.waitFor({ state: 'hidden' });
  await costCard.getByRole('button', { name: 'Claude Code 작업자 시작' }).click();
  const costedGoal = await costed.getAttribute('data-goal');
  const stoppedCosted = panel.locator(`.pm-goal[data-goal="${costedGoal}"][data-state="stopped"]`);
  await stoppedCosted.waitFor({ timeout: 15_000 });
  assert.match(await stoppedCosted.locator('p.error').innerText(), /비용 한도 \$0\.05에 닿았습니다\(도구가 알린 비용\)/);
  assert.match(await stoppedCosted.locator('.pm-cost').innerText(), /비용 한도: \$0\.08 \/ \$0\.05 · 도구가 알린 비용\(실제 청구와 다를 수 있음\)/);
  assert.match(await stoppedCosted.locator('.pm-usage').innerText(), /도구가 알린 비용 \$0\.08\(실제 청구와 다를 수 있음\)/);
  assert.equal(await stoppedCosted.locator('.pm-resume input[name="costUsd"]').inputValue(), '0.05', 'raising it is a person resuming');
  assert.equal(await stoppedCosted.locator('.pm-resume-button').count(), 1);
  const phoneCost = await open('/manage?lang=en', { width: 390, height: 844 });
  const englishCosted = phoneCost.locator(`#pm-loop-panel .pm-goal[data-goal="${costedGoal}"]`);
  await englishCosted.locator('.pm-cost').waitFor();
  assert.match(await englishCosted.locator('.pm-cost').innerText(), /Cost limit: \$0\.08 \/ \$0\.05 · Cost reported by the tool, may differ from your bill/);
  assert.match(await englishCosted.locator('p.error').innerText(), /Reached the \$0\.05 cost limit \(cost reported by tools\)/);
  assert.equal(await noHorizontalScroll(phoneCost), true, 'English /manage at 390px with a cost limit');
  if (process.env.WAX_SCREENSHOT_DIR) await englishCosted.screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-cost-en-390.png') });
  await closePages(phoneCost);

  process.env.WAX_STUCK_CHECK = 'stop';
  await createFeature(root, { id: 'rootcause', title: '포트를 쥔 서버' });
  const rc = await startRepeat('rootcause', '원인 찾기');
  for (const attempt of [1, 2]) {
    const blockedCard = rc.locator('.pm-card[data-kind="blocked"]');
    await blockedCard.waitFor({ timeout: 20_000 });
    await blockedCard.getByRole('button', { name: '배정 회수' }).click();
    const rcCard = rc.locator(`.pm-card[data-kind="start-worker"]`, { has: manage.locator('.pm-root-cause-badge', { hasText: `원인 찾기 모드(${attempt}번째)` }) });
    await rcCard.waitFor({ timeout: 10_000 });
    await rcCard.getByRole('button', { name: /작업자 시작$/ }).click();
    await until(async () => rootCausePrompts.length === attempt, `root-cause attempt ${attempt}`, 15_000);
  }
  const doubtCard = rc.locator('.pm-card[data-kind="approach-doubt"]');
  await doubtCard.waitFor({ timeout: 15_000 });
  const doubtText = await doubtCard.innerText();
  assert.match(doubtText, /접근이 틀렸을 수 있음[\s\S]*사람 결정[\s\S]*같은 실패에 원인 찾기를 2번 했지만 고쳐지지 않았습니다\. 접근이 틀렸을 수 있습니다/);
  assert.match(doubtText, /가설: 포트 3000을 낡은 시험 서버가 쥐고 있다 · 고쳐지지 않음 · 한 변경: 시험 포트를 바꿈[\s\S]*가설 보고 없음/);
  assert.deepEqual(await doubtCard.locator('.proposal-actions button').allInnerTexts(), ['한 번 더 시도', '목표 정지'], 'no dismiss button');
  assert.match(rootCausePrompts[1], /> .*포트 3000을 낡은 시험 서버가 쥐고 있다/, 'the second attempt sees the first hypothesis as quoted data');
  assert.equal(await rc.locator('.pm-card[data-kind="judge"]').count(), 0, 'no blocker judgment card');
  await openedText(rc.locator('.pm-decisions'), /2번째 가설 보고 없음[\s\S]*1번째 가설: 포트 3000을 낡은 시험 서버가 쥐고 있다 · 고쳐지지 않음/, 'the root-cause decision log');
  const rcGoal = await rc.getAttribute('data-goal');
  const phoneDoubt = await open('/manage', { width: 390, height: 844 });
  await phoneDoubt.locator(`#pm-loop-panel .pm-goal[data-goal="${rcGoal}"] .pm-card[data-kind="approach-doubt"]`).waitFor();
  assert.equal(await noHorizontalScroll(phoneDoubt), true, '/manage at 390px with the approach-doubt card');
  await closePages(phoneDoubt);
  const englishDoubt = await open('/manage?lang=en', { width: 390, height: 844 });
  const englishCard = englishDoubt.locator(`#pm-loop-panel .pm-goal[data-goal="${rcGoal}"] .pm-card[data-kind="approach-doubt"]`);
  await englishCard.waitFor();
  assert.match(await englishCard.innerText(), /The approach may be wrong[\s\S]*2 root-cause attempts did not fix the same failure\. The approach may be wrong\.[\s\S]*Hypothesis: 포트 3000을 낡은 시험 서버가 쥐고 있다 · not fixed[\s\S]*No hypothesis reported[\s\S]*Try once more/);
  assert.equal(await noHorizontalScroll(englishDoubt), true, 'English /manage at 390px with the approach-doubt card');
  if (process.env.WAX_SCREENSHOT_DIR) await englishCard.screenshot({ path: join(process.env.WAX_SCREENSHOT_DIR, 'pm-approach-doubt-en-390.png') });
  await closePages(englishDoubt);
  await doubtCard.getByRole('button', { name: '한 번 더 시도' }).click();
  await rc.locator('.pm-card[data-kind="start-worker"] .pm-root-cause-badge', { hasText: '원인 찾기 모드(3번째)' }).waitFor({ timeout: 10_000 });
  delete process.env.WAX_STUCK_CHECK;

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
