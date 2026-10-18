import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { setPm, assignTask } from '../src/chat/team.mjs';
import { createFeature, listFeatures } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { qualityRequirements } from '../web/project-types.mjs';
import { BUILDING, FLOOR_HEIGHT } from '../web/office/side-rooms.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-request-browser-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR || process.argv[4];
let server, browser, executions = 0, toolsInstalled = false, projectExecutions = 0, failTypedReview = false;
try {
  await joinPresence(root, { author: 'codex-app', kind: 'codex' });
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, requestTools: async () => ['codex', 'claude', 'gemini', 'copilot', 'antigravity'].map((id) => ({ id, label: id, installed: toolsInstalled && id !== 'gemini' })), executeRequest: async (root, { signal, tool, prompt }) => {
    assert.equal(tool, 'claude');
    if (prompt.includes('프로젝트 모드입니다')) {
      projectExecutions++;
      let feature = (await listFeatures(root)).find((f) => prompt.includes(`현재 작업: ${f.id},`));
      const proofIds = [], checks = [];
      for (const rule of qualityRequirements(feature.projectType, feature.phase, feature.workMode)) {
        let artifact = '', ids = [];
        if (rule.kind === 'preview') {
          artifact = 'preview.html';
          await writeFile(join(root, artifact), '<h1>디자인 시안 · 브라우저 테스트 픽스처</h1><script>parent.fixturePreviewRan=true</script>');
        } else {
          const result = await runTestProof(root, feature.id, [process.execPath, '-e', 'require("node:assert/strict").equal(1+1,2)'], { revision: feature.revision, verification: rule.kind, checks: [rule.id] });
          feature = result.feature; proofIds.push(result.proof.id); ids = [result.proof.id];
          if (rule.kind === 'visual') { artifact = 'capture.png'; await writeFile(join(root, artifact), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')); }
        }
        checks.push({ id: rule.id, artifact, proofIds: ids, status: feature.phase === 'review' && failTypedReview && checks.length === 0 ? 'fail' : 'pass', detail: '실제 도메인 실행이 아닌 로컬 브라우저 테스트 픽스처' });
      }
      if (['implement', 'review'].includes(feature.phase) && !proofIds.length) {
        const proof = await runTestProof(root, feature.id, [process.execPath, '-e', 'require("node:assert/strict").equal(1+1,2)'], { revision: feature.revision });
        assert.equal(proof.recorded, true); proofIds.push(proof.proof.id);
      }
      const failed = checks.some(check => check.status === 'fail');
      if (failed) failTypedReview = false;
      return { threadId: 'project-browser-thread', message: JSON.stringify({ outcome: failed ? 'blocked' : 'complete', report: `${feature.phase} 결과 보고 · 로컬 픽스처${failed ? ' 검증 실패' : ''}`, document: '# 프로젝트 워크플로우\n\n목표: 예약 서비스\n\n1. 기획 · 범위와 완료 기준\n2. 설계 · 데이터와 화면\n3. 구현 · 예약 기능\n4. 검토 · 회귀 검사\n5. 보고 · 결과와 검증', evidence: '로컬 브라우저 픽스처 확인', proofIds, checks }) };
    }
    executions++;
    if (executions === 1) return { threadId: 'browser-thread', message: JSON.stringify({ outcome: 'question', report: '어떤 화면에서 발생하나요? <img src=x onerror=alert(1)>', document: '', evidence: '', proofIds: [] }) };
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); });
  } });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const page = await browser.newPage({ locale: 'ko-KR', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.waitForSelector('#connection[data-online="true"]');
  await page.locator('#team-status').filter({ hasText: '1개 세션' }).waitFor();
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.match(await page.textContent('#guide-tool-detail'), /찾지 못/);
  assert.match(await page.textContent('#pm-guide'), /PM이 없어/);
  assert.match(await page.textContent('#session-guide'), /배정된 업무 없음/);
  assert.match(await page.textContent('#command-syntax'), /Codex CLI는 \$wax:work/);
  assert.equal(await page.locator('#terminal-guide').getAttribute('open'), '');
  await page.click('#guide-start');
  assert.equal(await page.locator('#request-body').evaluate((el) => el === document.activeElement), true);
  assert.equal(executions, 0);
  toolsInstalled = true;
  await page.click('#check-tools');
  await page.locator('#guide-tool[data-ready="true"]').waitFor();
  assert.equal(await page.locator('#send').isDisabled(), false);
  const pm = await joinPresence(root, { author: 'manager', kind: 'claude' });
  await setPm(root, { author: pm.author, kind: pm.kind });
  await createFeature(root, { id: 'login', title: '로그인 개선' });
  const task = await assignTask(root, { author: pm.author, session: pm.session, feature: 'login', to: 'codex-app', phase: 'plan', body: '로그인 범위와 수용 기준 작성' });
  await page.locator('#pm-guide').filter({ hasText: 'manager' }).waitFor();
  await page.locator('#session-guide').filter({ hasText: '$wax:work' }).waitFor();
  assert.match(await page.textContent('#session-guide'), new RegExp(task.id));
  assert.match(await page.textContent('#session-guide'), /배정됨 · 실행 확인 필요/);
  assert.equal(executions, 0, 'joining, designating a PM and assigning never claim an AI run started');
  await page.selectOption('#request-tool', 'gemini');
  assert.equal(await page.locator('#send').isDisabled(), true);
  await page.selectOption('#request-tool', 'claude');
  await page.check('input[name="mode"][value="sm"]');
  assert.match(await page.textContent('#guide-flow-detail'), /회귀 검증/);
  assert.equal(await page.locator('#approvals').isVisible(), false);
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'requests-desktop.png'), fullPage: true }); }
  await page.getByRole('button', { name: /오류 찾아 고치기/ }).click();
  assert.match(await page.inputValue('#request-body'), /오류/);
  await page.locator('#request-body').fill('회원가입을 고쳐줘');
  await page.locator('#request-body').press('Control+Enter');
  await page.locator('#request-status').filter({ hasText: '답변 필요' }).waitFor();
  assert.match(await page.textContent('#request-mode-label'), /SM/);
  assert.match(await page.textContent('#conversation'), /어떤 화면/);
  assert.match(await page.textContent('#request-next-title'), /답변을 기다리/);
  await page.click('#request-next-action');
  assert.equal(await page.locator('#request-body').evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.locator('#conversation img').count(), 0);
  assert.equal(await page.locator('#requests li').count(), 1);
  await page.reload();
  await page.locator('#request-status').filter({ hasText: '답변 필요' }).waitFor();
  assert.equal(await page.inputValue('#request-tool'), 'claude');
  assert.equal(await page.locator('#request-tool').isDisabled(), true);
  assert.equal(executions, 1, 'reload never starts an AI job');
  await page.fill('#request-body', '모바일 가입 화면이야');
  await page.click('#send');
  await page.locator('#request-status').filter({ hasText: '진행 중' }).waitFor();
  assert.equal(executions, 2);
  await page.click('#stop');
  await page.locator('#request-status').filter({ hasText: '일시 중지' }).waitFor();
  assert.match(await page.textContent('#request-next-title'), /멈춰/);
  await page.click('#new-request');
  assert.equal(await page.locator('#conversation article').count(), 0);
  await page.fill('#request-body', '새 요청의 작성 중 내용');
  await page.locator('#requests button').first().click();
  assert.equal(await page.inputValue('#request-body'), '');
  assert.equal(await page.locator('#conversation .user-message').count(), 2);
  assert.match(await page.textContent('#conversation'), /모바일 가입/);
  await page.click('#new-request');
  assert.equal(await page.inputValue('#request-body'), '새 요청의 작성 중 내용');
  await page.locator('#requests button').first().click();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px: no horizontal overflow`);
  }
  if (screenshots) {
    const mobile = await browser.newPage({ locale: 'ko-KR', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await mobile.goto(base + '/?mode=sm');
    await mobile.locator('#team-status').filter({ hasText: '2개 세션' }).waitFor();
    assert.equal(await mobile.locator('input[name="mode"][value="sm"]').isChecked(), true);
    await mobile.goto(base + '/?mode=project');
    await mobile.locator('#team-status').filter({ hasText: '2개 세션' }).waitFor();
    assert.equal(await mobile.locator('input[name="mode"][value="project"]').isChecked(), true, 'explicit init mode overrides a remembered mode');
    assert.equal(await mobile.locator('.home-header').count(), 1);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'startup guide fits a fresh mobile viewport');
    await mobile.screenshot({ path: join(screenshots, 'requests-mobile.png') });
    await mobile.close();
  }
  await server.requests.settled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#new-request');
  await page.check('input[name="mode"][value="project"]');
  assert.match(await page.textContent('#send'), /워크플로우 만들기/);
  await page.fill('#request-body', '예약 서비스 프로젝트를 만들어줘');
  await page.click('#send');
  await page.locator('#request-status').filter({ hasText: '워크플로우 확인' }).waitFor();
  assert.equal(projectExecutions, 1, 'project waits after workflow creation');
  assert.equal(await page.locator('#workflow-preview').isVisible(), true);
  assert.match(await page.textContent('#workflow-document'), /예약 서비스/);
  await page.reload();
  await page.locator('#request-status').filter({ hasText: '워크플로우 확인' }).waitFor();
  assert.equal(projectExecutions, 1, 'reload does not confirm a workflow');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'project-workflow.png'), fullPage: true });
  await page.click('#request-next-action');
  await page.locator('#request-status').filter({ hasText: /^완료$/ }).waitFor();
  assert.equal(projectExecutions, 5, 'confirmed project runs the remaining four phases');
  await page.goto(base + '/manage');
  await page.waitForSelector('#assign-to', { state: 'attached' });
  assert.equal(await page.locator('#assign-to').evaluate((el) => el.tagName), 'SELECT');
  await page.locator('#tasks').filter({ hasText: '$wax:work' }).waitFor();
  assert.match(await page.textContent('#tasks'), new RegExp(task.id));
  await page.goto(base + '/chat');
  assert.match(await page.textContent('.channel-start-hint'), /시작 가이드/);
  for (const type of ['roblox', 'lookbook']) {
    await page.goto(base);
    await page.locator('#connection[data-online="true"]').waitFor();
    await page.locator('#project-type').selectOption(type);
    await page.check('input[name="mode"][value="project"]');
    await page.fill('#request-body', `${type} 프로젝트의 작은 흐름을 완성해줘`);
    failTypedReview = true;
    await page.click('#send');
    await page.locator('#request-status').filter({ hasText: '워크플로우 확인' }).waitFor();
    assert.equal(await page.locator('#project-type').isDisabled(), true);
    await page.click('#request-next-action');
    await page.locator('#request-next-action').filter({ hasText: '수정 후 다시 검증' }).waitFor();
    assert.match(await page.textContent('#mission-checks'), /수정 필요/);
    const id = new URL(page.url()).searchParams.get('request');
    const artifactResponse = await fetch(`${base}/api/features/${id}/artifacts/design-preview`);
    assert.equal(artifactResponse.status, 200);
    assert.match(artifactResponse.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
    assert.equal((await fetch(`${base}/api/features/login/artifacts/design-preview`)).status, 404, 'unregistered project files are not served');
    await page.reload();
    await page.locator('#request-next-action').filter({ hasText: '수정 후 다시 검증' }).waitFor();
    if (screenshots) await page.screenshot({ path: join(screenshots, `${type}-quality-failed.png`), fullPage: true });
    await page.click('#request-next-action');
    await page.locator('#request-status').filter({ hasText: /^완료$/ }).waitFor();
    assert.ok((await listFeatures(root)).find(feature => feature.id === id).iteration === 1);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${type} ${width}px: mission fits`);
    }
  }
  await page.goto(base + '/office?room=studio');
  await page.locator('#notice[hidden]').waitFor({ state: 'attached' });
  await page.locator('#room-tabs button').filter({ hasText: '디자인실' }).waitFor();
  await page.locator('#room-tabs button').filter({ hasText: '디자인실' }).click();
  assert.equal(await page.locator('#room-tabs button').count(), 6);
  assert.ok(await page.evaluate(() => scrollY > 0), 'room selection moves to the requested floor immediately with reduced motion');
  if (screenshots) {
    await page.screenshot({ path: join(screenshots, 'studio-office.png') });
    const bounds = await page.locator('#stage').boundingBox();
    const scale = bounds.width / BUILDING.SIZE.width;
    await page.screenshot({ path: join(screenshots, 'studio-floor.png'), clip: { x: bounds.x, y: bounds.y + BUILDING.floorTop.studio * scale, width: bounds.width, height: FLOOR_HEIGHT * scale } });
  }
  await page.click('#open-studio');
  await page.locator('#studio-dialog[open]').waitFor();
  assert.match(await page.textContent('#studio-content'), /개발 인계 시안/);
  assert.equal(await page.locator('#studio-content iframe').first().getAttribute('sandbox'), '');
  assert.equal(await page.evaluate(() => window.fixturePreviewRan), undefined, 'preview scripts cannot reach the office');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'studio-deliverables.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: project/SM onboarding, workflow confirmation, stop/resume, Roblox/lookbook quality gates and repair iterations, six-floor office, sandboxed design previews, responsive layout.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
