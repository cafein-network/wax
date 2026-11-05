import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../src/chat/server.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { readWorktrees } from '../src/worktrees.mjs';

const modulePath = process.env.WAX_PLAYWRIGHT_MODULE || process.argv[2];
if (!modulePath) throw new Error('설치된 Playwright index.mjs 경로를 첫 인수로 지정하세요.');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const root = await mkdtemp(join(tmpdir(), 'wax-review-pr-browser-'));
const outside = await mkdtemp(join(tmpdir(), 'wax-review-pr-remote-'));
const screenshots = process.env.WAX_SCREENSHOT_DIR;
const exists = (path) => lstat(path).then(() => true, () => false);
let server, browser;
try {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (cwd, message) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n');
  await writeFile(join(root, 'app.txt'), 'one\n');
  commit(root, 'fixture');
  const bare = join(outside, 'app.git');
  git(outside, 'clone', '-q', '--bare', root, bare);
  const fork = join(outside, 'fork');
  git(outside, 'clone', '-q', bare, fork);
  await mkdir(join(fork, 'scripts'));
  await writeFile(join(fork, 'app.txt'), 'one\npr change\n');
  await writeFile(join(fork, 'scripts', 'build.sh'), 'echo build\n');
  commit(fork, 'PR change');
  git(fork, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  const head = git(fork, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(root, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, 'https://github.com/acme/app.git');
  await createFeature(root, { id: 'login-review', title: 'Review the login PR' });
  for (const phase of ['plan', 'design', 'implement']) {
    await updateFeature(root, 'login-review', 'save', { phase, content: `# ${phase}\n확인된 작업 내역` });
    await updateFeature(root, 'login-review', 'complete', { phase, evidence: '실제 검증 결과 기록', ...(phase === 'implement' ? { waiver: '단계 진행만 확인' } : {}) });
  }
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: 'Review PR 7', features: ['login-review'] }, { author: '대표' });
  const gh = async () => ({ stdout: JSON.stringify({ number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Add <b>login</b> @team', state: 'OPEN', headRefOid: head, headRefName: 'login',
    isCrossRepository: true, headRepositoryOwner: { login: 'someone' }, author: { login: 'someone' }, baseRefName: 'main', files: [{ path: 'app.txt' }, { path: 'scripts/build.sh' }] }), stderr: '' });
  const requestTools = async () => [{ id: 'claude', label: 'Claude Code', installed: true, approval: 'dashboard' }];
  server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off', WAX_CHAT_USER: '대표' }, intervalMs: 50, executeWorker: async () => { throw new Error('no worker'); },
    executeJudge: async () => { throw new Error('no judgment'); }, requestTools, gh });
  await server.startWatching(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.WAX_CHROMIUM_EXECUTABLE || process.argv[3] });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('wax.language', 'en'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const fits = async (label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${label}: no horizontal scroll at 390px`);
  const noKorean = async (locator, label) => assert.doesNotMatch((await locator.innerText()).replaceAll('대표', ''), /[가-힣]/, `${label}: English screen`);

  await page.goto(`${url}/manage?lang=en`);
  const section = page.locator(`#pm-loop-panel .pm-goal[data-goal="${goal.id}"] .pm-worktrees`);
  const box = section.locator('.pm-review-pr');
  await box.waitFor();
  assert.match(await box.innerText(), /Review a PR in a worktree[\s\S]*not run until you allow it for each head commit/);
  await noKorean(box, 'review PR field');
  await fits('review PR field');

  await box.locator('input[name="review-pr-number"]').fill('7');
  await box.locator('.pm-review-pr-read').click();
  const info = box.locator('.pm-review-pr-info');
  await info.waitFor();
  const infoText = await info.innerText();
  assert.match(infoText, /#7 Add <b>login<\/b> @team/, 'the title is plain text');
  assert.equal(await info.locator('b').count(), 0, 'no HTML from the PR');
  assert.match(infoText, /This PR comes from a fork/);
  assert.match(infoText, /1 of 2 changed files affect what runs[\s\S]*scripts\/build\.sh script/);
  assert.match(infoText, /Fetch from remote origin · acme\/app/);
  await noKorean(info, 'PR info');
  await fits('PR info');

  await box.locator('.pm-review-pr-fetch-open').click();
  const confirm = box.locator('.pm-review-pr-confirm');
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /refs\/wax\/review\/pr-7[\s\S]*Not written: FETCH_HEAD, commit-graph, tags/);
  await noKorean(confirm, 'fetch confirm');
  await fits('fetch confirm');
  if (screenshots) await box.screenshot({ path: join(screenshots, 'review-pr-fetch-390-en.png') });
  await confirm.locator('.pm-review-pr-fetch').click();
  const item = section.locator('.pm-worktree-list li[data-kind="review"]');
  await item.waitFor();
  const [entry] = await readWorktrees(root);
  assert.deepEqual([entry.kind, entry.branch, entry.pr.head], ['review', null, head]);
  assert.equal(git(root, 'rev-parse', 'refs/wax/review/pr-7'), head);
  assert.equal(git(entry.path, 'rev-parse', 'HEAD'), head);
  assert.match(await item.innerText(), /PR #7[\s\S]*task login-review · head [a-f0-9]{12} · active[\s\S]*Fork[\s\S]*no import/);
  assert.equal(await item.locator('.pm-worktree-import-open').count(), 0, 'no import button for a review worktree');
  await box.locator('.pm-review-pr-result').waitFor();

  await item.locator('.pm-review-run-open').click();
  const allow = item.locator('.pm-review-run-confirm');
  await allow.waitFor();
  assert.match(await allow.innerText(), /This PR comes from a fork[\s\S]*This runs code from commit [a-f0-9]{12} of this PR, from a fork, on this computer[\s\S]*only this head commit/);
  await noKorean(allow, 'allow running');
  await fits('allow running');
  if (screenshots) await item.screenshot({ path: join(screenshots, 'review-pr-allow-390-en.png') });
  await allow.locator('.pm-review-run-confirm-button').click();
  await item.locator('.pm-review-run[data-run="allowed"]').waitFor();
  assert.match(await item.locator('.pm-review-run').innerText(), /Running head commit [a-f0-9]{12} allowed/);

  await item.locator('.pm-worktree-discard-open').click();
  await item.locator('.pm-worktree-discard').click();
  await section.locator('.pm-worktree-cleanup-open').click();
  await section.locator('.pm-worktree-cleanup').click();
  await section.locator('.pm-worktree-cleanup-result').waitFor();
  assert.equal(await exists(entry.path), false, 'the review worktree folder is gone');
  assert.equal(git(root, 'for-each-ref', '--format=%(refname)', 'refs/wax/'), '', 'refs/wax/review/pr-7 is deleted');
  await noKorean(section, 'after cleanup');
  await fits('after cleanup');
  assert.deepEqual(errors, []);
  console.log('PASS browser: PR review worktree — read PR (plain-text title, fork warning, risky files, remote) → fetch confirm (.git writes listed) → detached review worktree row (PR #7, fork, no import) → allow running this head (fork wording) → discard → cleanup removes the folder and refs/wax/review/pr-7, 390px English.');
} finally {
  await browser?.close(); await server?.shutdown();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
