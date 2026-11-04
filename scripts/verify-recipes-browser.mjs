import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { getFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('Playwright 모듈 경로를 WAX_PLAYWRIGHT_MODULE 또는 첫 번째 인수로 지정하세요.');
const { chromium: browserType } = await import(pathToFileURL(resolve(modulePath)).href);
const chromium = process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3];

const root = await mkdtemp(join(tmpdir(), 'wax-recipes-'));
await setPm(root, { author: '대표', kind: 'human' });
const workerRuns = [];
async function executeWorker(dir, input) {
  workerRuns.push({ tool: input.tool, prompt: input.prompt });
  await new Promise((done, reject) => input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  return { threadId: 'fake-worker', status: 'completed', message: JSON.stringify({ outcome: 'blocked', report: '멈춤' }) };
}
const judgeRuns = [];
async function executeJudge(dir, input) { judgeRuns.push(input); throw new Error('no judgment in this check'); }
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
const personal = {
  schema: 1, id: 'quick-fix', title: '빠른 수정', description: '작은 버그 하나', input: { label: '무엇을 고치나요?', example: '버튼이 안 눌림', details: { label: '어떻게 재현하나요?' } },
  goal: '{input} 빠르게 고치기', tasks: [{ id: 'quick-{slug}', title: '{input} 고치기', description: '재현: {details}', ac: ['재현 테스트가 있다', '기존 테스트가 통과한다'] }],
  workers: { plan: 'claude' }, budgets: { phaseRuns: 6, hours: 2 }, mode: 'auto', notes: { plan: '@codex-a 계획은 짧게 쓴다' },
};

try {
  const manage = await open('/manage');
  const panel = manage.locator('#pm-loop-panel');
  await panel.locator('.empty').waitFor();
  await panel.getByRole('button', { name: '레시피로 시작' }).click();
  const recipes = panel.locator('.pm-recipes');
  await recipes.locator('.pm-recipe[data-recipe="bugfix"]').waitFor();
  assert.deepEqual(await recipes.locator('.pm-recipe').evaluateAll((nodes) => nodes.map((node) => `${node.dataset.recipe}:${node.dataset.source}`)), ['bugfix:builtin', 'feature:builtin', 'refactor:builtin']);
  assert.match(await recipes.locator('.pm-recipe[data-recipe="bugfix"]').innerText(), /버그 수정[\s\S]*내장[\s\S]*재현 테스트를 먼저/);
  await recipes.getByRole('button', { name: '＋ 새 레시피' }).click();
  const editor = recipes.locator('.pm-recipe-editor');
  await editor.locator('textarea[name="recipe-json"]').fill(JSON.stringify({ ...personal, mode: 'yolo' }));
  await editor.getByRole('button', { name: '저장' }).click();
  await recipes.locator('.error', { hasText: 'mode: suggest|auto 중 하나가 아닙니다' }).waitFor();
  await editor.locator('textarea[name="recipe-json"]').fill(JSON.stringify(personal));
  await editor.getByRole('button', { name: '저장' }).click();
  const mine = recipes.locator('.pm-recipe[data-recipe="quick-fix"]');
  await mine.waitFor();
  assert.match(await mine.innerText(), /빠른 수정[\s\S]*개인[\s\S]*auto 권장/);

  await mine.getByRole('button', { name: '이 레시피로 시작' }).click();
  const start = recipes.locator('.pm-recipe-start');
  await start.waitFor();
  assert.match(await start.innerText(), /레시피로 시작: 빠른 수정[\s\S]*무엇을 고치나요\?[\s\S]*어떻게 재현하나요\?/);
  await start.locator('input[name="recipe-input"]').fill('Save button stuck');
  await start.locator('textarea[name="recipe-details"]').fill('1. 저장을 누른다\n2. 아무 일도 없다');
  await start.getByRole('button', { name: '채우기' }).click();
  const task = start.locator('.pm-recipe-task');
  await task.waitFor();
  assert.equal(await start.locator('input[name="recipe-slug"]').inputValue(), 'save-button-stuck');
  assert.equal(await task.locator('input[name="recipe-task-id"]').inputValue(), 'quick-save-button-stuck');
  assert.equal(await start.locator('input[name="recipe-title"]').inputValue(), 'Save button stuck 빠르게 고치기');
  assert.equal(await start.locator('select[name="worker-plan"]').inputValue(), 'claude');
  assert.equal(await start.locator('input[name="phaseRuns"]').inputValue(), '6');
  assert.match(await start.innerText(), /auto를 권장합니다[\s\S]*suggest로 만들어지고/);
  assert.match(await start.locator('.pm-recipe-notes').innerText(), /계획은 짧게 쓴다/);
  const phone = await open('/manage', { width: 390, height: 844 });
  const phonePanel = phone.locator('#pm-loop-panel');
  await phonePanel.getByRole('button', { name: '레시피로 시작' }).click();
  await phonePanel.locator('.pm-recipe[data-recipe="quick-fix"]').getByRole('button', { name: '이 레시피로 시작' }).click();
  await phonePanel.locator('input[name="recipe-input"]').fill('a very long input line '.repeat(8).trim());
  await phonePanel.getByRole('button', { name: '채우기' }).click();
  await phonePanel.locator('.pm-recipe-task').waitFor();
  assert.equal(await noHorizontalScroll(phone), true, '/manage at 390px with the recipe start form');
  await task.locator('input[name="recipe-task-title"]').fill('저장 버튼 고치기');
  await task.locator('textarea[name="recipe-task-ac"]').fill('재현 테스트가 있다\n저장 버튼이 눌린다');
  await start.getByRole('button', { name: '목표 만들기' }).click();
  const goal = panel.locator('.pm-goal');
  await goal.waitFor();
  assert.equal(await recipes.isHidden(), true, 'the recipe panel closes');
  assert.equal(await goal.getAttribute('data-state'), 'planning');
  assert.match(await goal.locator('.pm-goal-recipe').innerText(), /레시피: 빠른 수정[\s\S]*개인[\s\S]*시작할 때 고친 칸: tasks[\s\S]*auto 권장/);
  assert.equal(await goal.locator('.pm-mode').getAttribute('data-mode'), 'suggest', 'a recipe never turns auto on');
  await goal.locator('.pm-card[data-kind="confirm-plan"]').waitFor();
  assert.deepEqual(await goal.locator('.pm-card').evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ['confirm-plan'], 'no plan-draft judgment card');
  const feature = await getFeature(root, 'quick-save-button-stuck');
  assert.equal(feature.title, '저장 버튼 고치기');
  assert.match(feature.artifacts.plan, /- AC-1: 재현 테스트가 있다\n- AC-2: 저장 버튼이 눌린다/);
  assert.equal(feature.description, '재현: 1. 저장을 누른다\n2. 아무 일도 없다', 'the details box fills the task description');

  await goal.getByRole('button', { name: '계획 확인하고 시작' }).click();
  const workerCard = goal.locator('.pm-card[data-kind="start-worker"][data-key^="quick-save-button-stuck:0:plan:start-worker"]');
  await workerCard.waitFor({ timeout: 10_000 });
  assert.match(await workerCard.innerText(), /레시피 기본 도구: plan 단계[\s\S]*빠른 수정[\s\S]*Claude Code/);
  assert.equal(await workerCard.locator('select[name="tool"]').inputValue(), 'claude');
  await workerCard.getByRole('button', { name: 'Claude Code 작업자 시작' }).click();
  await goal.locator('.pm-worker[data-tool="claude"]').waitFor({ timeout: 10_000 });
  await until(() => workerRuns.length === 1, 'the fake worker to be called');
  assert.equal(workerRuns[0].tool, 'claude');
  const quoted = workerRuns[0].prompt.split('\n\n').find((part) => part.startsWith('> {'));
  assert.match(quoted, /"recipeNote"[\s\S]*`@codex-a` 계획은 짧게 쓴다/);
  assert.equal(workerRuns[0].prompt.replace(quoted, '').includes('계획은 짧게'), false, 'the note is only quoted data');
  assert.equal(judgeRuns.length, 0, 'no PM judgment ran');
  const trace = await (await fetch(`${base}/api/features/quick-save-button-stuck/trace`)).json();
  assert.equal(trace.recipes[0].title, '빠른 수정');
  const decisions = (await (await fetch(`${base}/api/pm-loop/${await goal.getAttribute('data-goal')}`)).json()).decisions;
  assert.ok(decisions.some((item) => item.kind === 'start-worker' && item.outcome === 'executed' && /레시피 기본 도구/.test(item.reason)), 'the decision reason names the recipe tool');
  const phoneGoal = await open('/manage', { width: 390, height: 844 });
  await phoneGoal.locator('#pm-loop-panel .pm-goal .pm-goal-recipe').waitFor();
  assert.equal(await noHorizontalScroll(phoneGoal), true, '/manage at 390px with a recipe goal');
  await goal.getByRole('button', { name: '작업자 멈추기' }).click();
  await goal.locator('.pm-worker').waitFor({ state: 'detached', timeout: 10_000 });

  const english = await open('/manage?lang=en');
  await english.locator('#pm-loop-panel').getByRole('button', { name: 'Start from a recipe' }).click();
  await english.locator('.pm-recipe[data-recipe="bugfix"]').waitFor();
  assert.match(await english.locator('.pm-recipe[data-recipe="bugfix"]').innerText(), /Bug fix[\s\S]*Built-in/);
  assert.match(await english.locator('.pm-recipe[data-recipe="quick-fix"]').innerText(), /빠른 수정[\s\S]*Personal/);

  await panel.getByRole('button', { name: '레시피로 시작' }).click();
  await recipes.locator('.pm-recipe[data-recipe="quick-fix"]').getByRole('button', { name: '지우기' }).click();
  await recipes.locator('.pm-recipe[data-recipe="quick-fix"]').waitFor({ state: 'detached' });
  assert.equal(await panel.locator('.pm-goal').count(), 1);

  await goal.getByRole('button', { name: '목표 정지' }).click();
  await panel.locator('.pm-goal[data-state="stopped"]').waitFor();
  await goal.getByRole('button', { name: '레시피로 저장' }).click();
  const draftEditor = recipes.locator('.pm-recipe-editor');
  await draftEditor.locator('.pm-recipe-draft-hint').waitFor();
  const goalId = await goal.getAttribute('data-goal');
  assert.match(await draftEditor.innerText(), new RegExp(`목표 ${goalId}을\\(를\\) 개인 레시피로 저장`));
  const draft = JSON.parse(await draftEditor.locator('textarea[name="recipe-json"]').inputValue());
  assert.deepEqual([draft.id, draft.goal, draft.tasks[0].id, draft.tasks[0].ac, draft.notes], [`from-${goalId}`, 'Save button stuck 빠르게 고치기', 'quick-save-button-stuck-{slug}',
    ['재현 테스트가 있다', '저장 버튼이 눌린다'], {}]);
  assert.equal(draft.budgets.phaseRuns, 2, 'one phase run used → 1.5 rounded up');
  await draftEditor.getByRole('button', { name: '저장' }).click();
  await recipes.locator('.error', { hasText: '{input}이 있어야' }).waitFor();
  await draftEditor.locator('textarea[name="recipe-json"]').fill(JSON.stringify({ ...draft, id: 'saved-fix', title: '저장한 수정', goal: '{input} 다시 고치기' }));
  await draftEditor.getByRole('button', { name: '저장' }).click();
  const saved = recipes.locator('.pm-recipe[data-recipe="saved-fix"]');
  await saved.waitFor();
  const audit = (await readFile(join(root, '.wax', 'chat', 'recipes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.find((item) => item.recipe === 'saved-fix').from, goalId, 'the record names the goal');

  await saved.getByRole('button', { name: '공유로 내보내기' }).click();
  await recipes.locator('.pm-recipe-notice', { hasText: 'docs/wax/recipes/saved-fix.json에 썼습니다' }).waitFor();
  assert.match(await readFile(join(root, 'docs', 'wax', 'recipes', 'saved-fix.json'), 'utf8'), /\{input\} 다시 고치기/);
  assert.match(await recipes.locator('.pm-recipe[data-recipe="saved-fix"][data-source="shared"]').innerText(), /공유[\s\S]*승인됨[\s\S]*개인 레시피가 먼저 쓰임/);

  await mkdir(join(root, 'docs', 'wax', 'recipes'), { recursive: true });
  const team = { schema: 1, id: 'team-fix', title: '팀 수정', input: { label: '무엇?' }, goal: '{input} 팀 수정', tasks: [{ id: 'team-{slug}', title: '{input}', ac: ['된다'] }], workers: { plan: 'claude' } };
  await writeFile(join(root, 'docs', 'wax', 'recipes', 'team-fix.json'), JSON.stringify(team));
  await panel.locator('.pm-recipe-open').click();
  await panel.locator('.pm-recipe-open').click();
  const teamRow = recipes.locator('.pm-recipe[data-recipe="team-fix"]');
  await teamRow.waitFor();
  assert.match(await teamRow.innerText(), /팀 수정[\s\S]*공유[\s\S]*승인 필요/);
  assert.equal(await teamRow.getByRole('button', { name: '이 레시피로 시작' }).count(), 0, 'no start before approval');
  await teamRow.getByRole('button', { name: '검토' }).click();
  const review = recipes.locator('.pm-recipe-review');
  await review.waitFor();
  assert.match(await review.locator('.pm-recipe-normalized').innerText(), /"plan": "claude"/);
  assert.match(await review.innerText(), /승인한 적이 없습니다/);
  const phoneReview = await open('/manage', { width: 390, height: 844 });
  await phoneReview.locator('#pm-loop-panel').getByRole('button', { name: '레시피로 시작' }).click();
  await phoneReview.locator('.pm-recipe[data-recipe="team-fix"]').getByRole('button', { name: '검토' }).click();
  await phoneReview.locator('.pm-recipe-review .pm-recipe-normalized').waitFor();
  assert.equal(await noHorizontalScroll(phoneReview), true, '/manage at 390px with the shared recipe review');
  await review.getByRole('button', { name: '이 내용 승인' }).click();
  await teamRow.locator('[data-approval="approved"]').waitFor();
  await teamRow.getByRole('button', { name: '이 레시피로 시작' }).click();
  await start.locator('input[name="recipe-input"]').fill('Team bug');
  assert.equal(await start.locator('.pm-recipe-details').isHidden(), true, 'no details box for a recipe without {details}');
  await start.getByRole('button', { name: '채우기' }).click();
  await start.locator('.pm-recipe-task').waitFor();
  await start.getByRole('button', { name: '목표 만들기' }).click();
  await panel.locator('.pm-goal .pm-goal-recipe[data-recipe="team-fix"]').waitFor();
  assert.match(await panel.locator('.pm-goal-recipe[data-recipe="team-fix"]').innerText(), /레시피: 팀 수정[\s\S]*공유/);
  await writeFile(join(root, 'docs', 'wax', 'recipes', 'team-fix.json'), JSON.stringify({ ...team, workers: { plan: 'codex' } }));
  await panel.locator('.pm-recipe-open').click();
  await teamRow.locator('[data-approval="changed"]').waitFor();
  assert.equal(await teamRow.getByRole('button', { name: '이 레시피로 시작' }).count(), 0);
  await teamRow.getByRole('button', { name: '검토' }).click();
  await review.locator('.pm-recipe-diff').waitFor();
  assert.deepEqual(await review.locator('.pm-diff-del, .pm-diff-add').evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())), ['- "plan": "claude"', '+ "plan": "codex"']);
  assert.deepEqual(errors, []);
  console.log('recipes browser check passed');
} finally {
  await browser.close();
  await server.shutdown();
  await rm(root, { recursive: true, force: true });
}
