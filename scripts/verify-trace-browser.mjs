import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { chatDir } from '../src/chat/paths.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { claudeUsage } from '../src/tool-usage.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-trace-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
let server, browser;
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = () => { git('add', '-A'); git('-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'); };
  git('init', '-q');
  await writeFile(join(root, '.gitignore'), '.wax/\n'); await writeFile(join(root, 'README.md'), '# fixture\n'); commit();
  const id = 'login';
  await createFeature(root, { id, title: '로그인 개선' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: phase === 'plan' ? '- AC-1: 로그인하면 홈으로 간다 — 검증: 테스트' : '# 설계' });
    await updateFeature(root, id, 'complete', { phase, evidence: '범위 확인', author: 'codex-a', tool: 'codex' });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  const deep = join(root, 'src', 'features', 'authentication', 'very-long-directory-name-for-wrapping-checks');
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'login-session-refresh-token-handler-with-a-very-long-file-name.js'), 'export const a = 1;\n'); commit();
  const proof = (await runTestProof(root, id, [process.execPath, '-e', 'process.exit(0)'], { author: 'codex-a' })).proof;
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '토큰 갱신 구현 <img src=x onerror=alert(1)>', proofIds: [proof.id], author: 'codex-a', tool: 'codex' });
  await updateFeature(root, id, 'iterate', { reason: '만료 토큰 처리가 빠짐', author: 'claude-b', defects: [{ title: '만료 토큰이 <b>통과</b>된다' }] });
  await createFeature(root, { id: 'other', title: '다른 작업' });
  const goal = await createGoal(root, { title: '사용량', features: [id] }, { author: '대표' });
  const usage = claudeUsage(JSON.parse(JSON.parse(await readFile(new URL('../test/fixtures/usage/claude-result.json', import.meta.url), 'utf8')).line));
  const log = join(await chatDir(root, 'pm-loop'), `${goal.id}.jsonl`);
  for (const [worker, tool, value] of [['pw-00000001', 'claude', usage], ['pw-00000002', 'codex', null]]) {
    const base = { kind: 'worker', worker, tool, feature: id, phase: 'implement', iteration: 1, task: 't-000001-aaaaaa', to: `wax-worker-${tool}`, by: '대표' };
    await appendRecord(log, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...base, outcome: 'launched', at: new Date().toISOString() }));
    await appendRecord(log, (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal: goal.id, ...base, outcome: 'exited', result: 'blocked', reason: '막힘', usage: value, at: new Date().toISOString() }));
  }

  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'ko'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${base}/manage?feature=${id}`);
  await page.locator('#trace-panel:not([hidden]) .trace-visit').first().waitFor();
  const visits = page.locator('#trace-panel .trace-visit');
  assert.equal(await visits.count(), 5);
  assert.deepEqual(await visits.evaluateAll((nodes) => nodes.map((node) => [node.dataset.phase, node.className.match(/outcome-(\w+)/)[1], node.querySelector('details').open])),
    [['plan', 'complete', false], ['design', 'complete', false], ['implement', 'complete', false], ['review', 'iterate', false], ['implement', 'open', true]]);
  assert.match(await visits.nth(3).locator('summary').textContent(), /구현으로 되돌림/);
  assert.match(await visits.nth(4).textContent(), /다시 방문한 이유만료 토큰 처리가 빠짐/);
  assert.match(await visits.nth(3).textContent(), /이 검토에서 기록한 결함D-1 만료 토큰이 <b>통과<\/b>된다/);
  assert.equal(await page.locator('#trace-panel b').count(), 0, 'defect titles stay text');
  await visits.nth(2).locator('summary').click();
  const implement = visits.nth(2);
  await implement.locator('.trace-proofs li').first().waitFor();
  assert.match(await implement.locator('.trace-proofs').textContent(), /실행 당시 통과 · 완료에 연결함/);
  assert.match(await implement.locator('.trace-files').textContent(), /login-session-refresh-token-handler-with-a-very-long-file-name\.js/);
  assert.match(await implement.textContent(), /codex-a/);
  assert.match(await implement.textContent(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#trace-panel img').count(), 0, 'record text stays text');
  assert.match(await page.textContent('#trace-summary'), /주기 1 · 단계 방문 5번/);
  const usageRow = await visits.nth(4).locator('.trace-usage').textContent();
  assert.match(usageRow, /Claude Code 입력 2 · 출력 4 · 캐시 읽기 11384 · 캐시 쓰기 10300 · 추론 0 · 비용 \$0\.0847648 · 차례 1 · 실행 1번/);
  assert.match(usageRow, /사용량을 알리지 않은 실행 1번/);
  assert.match(await visits.nth(4).textContent(), /사용량\(도구가 알린 값\)/);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#trace-download')]);
  assert.equal(download.suggestedFilename(), `wax-trace-${id}.md`);
  const markdown = await readFile(await download.path(), 'utf8');
  assert.match(markdown, /^# 실행 기록: 로그인 개선/);
  assert.match(markdown, /## 4\. 검토 · 주기 0/);
  assert.match(markdown, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markdown, /- 사용량\(도구가 알린 값\): Claude Code 입력 2 · 출력 4 .* · 실행 1번; 사용량을 알리지 않은 실행 1번/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile layout fits');
  const panel = await page.locator('#trace-panel').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390, 'the panel stays inside the phone width');
  if (screenshots) await page.locator('#trace-panel').screenshot({ path: join(screenshots, 'trace-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.click('#features button.trace-open[aria-label="other 실행 기록 보기"]');
  await page.locator('#trace-feature', { hasText: 'other' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#trace-panel .trace-visit').length === 1);
  assert.match(await page.textContent('#trace-panel .trace-visit'), /진행 중인 단계/);
  assert.match(page.url(), /feature=other/);
  await page.click('#trace-close');
  assert.equal(await page.locator('#trace-panel').isHidden(), true);

  const english = await context.newPage();
  english.on('pageerror', (error) => errors.push(error.message));
  await english.goto(`${base}/manage?feature=${id}&lang=en`);
  await english.locator('#trace-panel:not([hidden]) .trace-visit').first().waitFor();
  assert.equal(await english.textContent('#trace-heading'), 'Run trace');
  assert.match(await english.locator('#trace-panel .trace-visit').nth(3).locator('summary').textContent(), /Sent back to implement/);
  assert.match(await english.locator('#trace-panel .trace-visit').nth(3).textContent(), /Defects logged by this review/);
  assert.match(await english.locator('#trace-panel .trace-visit').nth(4).locator('.trace-usage').textContent(), /Claude Code Input 2 · Output 4 .*Cost \$0\.0847648 · Turns 1 · Runs 1.*Runs that did not report usage: 1/);
  await english.setViewportSize({ width: 390, height: 844 });
  await english.waitForTimeout(100);
  assert.equal(await english.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'English mobile layout fits');
  if (screenshots) await english.locator('#trace-panel').screenshot({ path: join(screenshots, 'trace-mobile-en.png') });
  const [englishDownload] = await Promise.all([english.waitForEvent('download'), english.click('#trace-download')]);
  assert.match(await readFile(await englishDownload.path(), 'utf8'), /^# Run trace: /);
  if (screenshots) await english.screenshot({ path: join(screenshots, 'trace-desktop-en.png'), fullPage: true });

  assert.deepEqual(errors, []);
  console.log('PASS browser: run trace timeline, iteration revisit, expand, usage per visit (ko/en), Markdown download (ko/en), feature switch, close, 390px width (ko/en).');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
}
