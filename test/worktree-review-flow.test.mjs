import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { project } from './chat-helpers.mjs';
import { updateFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';
import { allowReviewRun, cleanupGoalWorktrees, createGoal, createPmLoop, executeSuggestion, fetchReviewPr, goalOverview, readDecisions, readGoal, readReviewPr,
  setWorktrees, startWorktreeChecks, workerPrompt } from '../src/chat/pm-loop.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { readWorktrees } from '../src/worktrees.mjs';
import { decideSetup, readSetup } from '../src/worktree-setup.mjs';
import { judgeRequest } from '../src/goal-allow.mjs';
import { untrustedReviewPaths } from '../src/worktree-review.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, message = 'fixture') => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const person = '대표';
const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const waiver = '이 테스트는 단계 진행만 확인';

async function toReview(root, id) {
  for (const phase of ['plan', 'design', 'implement']) {
    await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n확인된 작업 내역` });
    await updateFeature(root, id, 'complete', { phase, evidence: '실제 검증 결과 기록', verdict: 'pass', ...(phase === 'implement' ? { waiver } : {}) });
  }
}

async function fixture(t) {
  const root = await project(t, ['f1', 'f2']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env\nsetup-ran.txt\n');
  await writeFile(join(root, '.env'), 'SECRET=1\n');
  await writeFile(join(root, 'app.txt'), 'one\n');
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), `${JSON.stringify({ setup: [process.execPath, '-e', 'require("fs").writeFileSync("setup-ran.txt", "x")'] })}\n`);
  commit(root);
  const outside = await mkdtemp(join(tmpdir(), 'wax-review-flow-'));
  t.after(() => rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const bare = join(outside, 'app.git');
  git(outside, 'clone', '-q', '--bare', root, bare);
  const fork = join(outside, 'fork');
  git(outside, 'clone', '-q', bare, fork);
  const push = async (text) => {
    await writeFile(join(fork, 'app.txt'), text);
    commit(fork, 'PR change');
    git(fork, 'push', '-q', '--force', 'origin', 'HEAD:refs/pull/7/head');
    return git(fork, 'rev-parse', 'HEAD');
  };
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(root, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, 'https://github.com/acme/app.git');
  await toReview(root, 'f1');
  await decideSetup(root, { author: person, hash: (await readSetup(await realpath(root))).hash });
  const state = { head: await push('one\npr change\n'), calls: [] };
  const gh = async (args, options) => {
    state.calls.push({ args, cwd: options?.cwd });
    return { stdout: JSON.stringify({ number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Add @team things', state: 'OPEN', headRefOid: state.head, headRefName: 'feature/x', isCrossRepository: true,
      headRepositoryOwner: { login: 'someone' }, author: { login: 'someone' }, baseRefName: 'main', files: [{ path: 'app.txt' }, { path: 'docs/wax/worktree.json' }] }), stderr: '' };
  };
  return { root, state, gh, push };
}

const bash = (command) => ({ tool: 'claude', details: { tool_name: 'Bash', input: { command } } });

test('people only: read, fetch and allow-run refuse the engine, auto and worker names (403); the read shows the PR, the remote and the risky files', async (t) => {
  const { root, gh, state } = await fixture(t);
  const goal = await createGoal(root, { title: 'PR 검토', features: ['f1'] }, { author: person });
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) {
    await assert.rejects(readReviewPr(root, goal.id, { author, number: 7, gh }), (error) => error.status === 403, author);
    await assert.rejects(fetchReviewPr(root, goal.id, { author, feature: 'f1', number: 7, head: state.head, gh }), (error) => error.status === 403, author);
    await assert.rejects(allowReviewRun(root, goal.id, `${goal.id}-1`, { author, head: state.head }), (error) => error.status === 403, author);
  }
  assert.equal(state.calls.length, 0, 'gh was not called for refused callers');
  const info = await readReviewPr(root, goal.id, { author: person, number: '7', gh });
  assert.deepEqual([info.pr.number, info.pr.head, info.pr.cross, info.pr.repo, info.remote, info.shallow, info.ready, info.setupChanged], [7, state.head, true, 'acme/app', 'origin', false, true, true]);
  assert.deepEqual(info.risky, [{ path: 'docs/wax/worktree.json', why: 'setup' }]);
  assert.deepEqual(info.entries, []);
  assert.equal(state.calls[0].cwd, await realpath(root), 'gh runs in the project folder');
});

test('fetch: only for a task in review, only when the head matches what the person saw; no .env copy, no setup; a new push needs a new fetch and the old worktree is discarded', async (t) => {
  const { root, gh, state, push } = await fixture(t);
  const goal = await createGoal(root, { title: 'PR 검토', features: ['f1', 'f2'], worktrees: true }, { author: person });
  await setWorktrees(root, goal.id, { author: person, env: ['.env'] });
  await assert.rejects(fetchReviewPr(root, goal.id, { author: person, feature: 'f2', number: 7, head: state.head, gh }), (error) => error.status === 409, 'f2 is not in review');
  await assert.rejects(fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: 'a'.repeat(40), gh }), (error) => error.status === 409, 'stale head on screen');
  const first = await fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: state.head, gh });
  const entry = (await readWorktrees(root)).find((item) => item.id === first.worktree);
  assert.deepEqual([entry.kind, entry.branch, entry.pr.head, entry.state], ['review', null, state.head, 'active']);
  assert.equal(await exists(join(entry.path, '.env')), false, '.env is never copied into a review worktree');
  assert.equal(await exists(join(entry.path, 'setup-ran.txt')), false, 'the setup script does not run');
  await assert.rejects(fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: state.head, gh }), (error) => error.status === 409, 'same head again');
  await assert.rejects(startWorktreeChecks(root, goal.id, entry.id, { author: person, testCommand: 'node -e 0' }), (error) => error.status === 409, 'no pre-import checks');
  const made = await prepareWorktree(root, await readGoal(root, goal.id), 'f1');
  assert.notEqual(made.entry.id, entry.id);
  assert.match(made.entry.branch, /^wax\/goal-[a-f0-9]{8}\/f1-2$/);
  state.head = await push('one\nnewer\n');
  const info = await readReviewPr(root, goal.id, { author: person, number: 7, gh });
  assert.deepEqual(info.entries.map((item) => [item.id, item.stale]), [[entry.id, true]]);
  const second = await fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: state.head, gh });
  assert.deepEqual(second.replaced, [entry.id]);
  const list = await readWorktrees(root);
  assert.equal(list.find((item) => item.id === entry.id).state, 'discarded');
  assert.equal(git(list.find((item) => item.id === second.worktree).path, 'rev-parse', 'HEAD'), state.head);
  const log = (await readDecisions(root, goal.id)).filter((item) => item.kind === 'worktree' && item.outcome === 'review-fetched');
  assert.equal(log.length, 2);
});

test('run allowance is per head commit and worktree.json hash: before it the test kind does not match in the review worktree, after it it does, a new head needs it again', async (t) => {
  const { root, gh, state, push } = await fixture(t);
  const goal = await createGoal(root, { title: 'PR 검토', features: ['f1'] }, { author: person });
  const { worktree } = await fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: state.head, gh });
  let entry = (await readWorktrees(root)).find((item) => item.id === worktree);
  const ctx = (entries, extra = {}) => ({ kinds: ['test'], test: 'node --test', root, cli: '/wax.mjs', feature: 'f1', phase: 'review', author: 'wax-worker-claude', cwd: entry.path,
    worktrees: entries.map((item) => item.path), ...extra });
  const request = bash(`node /wax.mjs test f1 --worktree ${JSON.stringify(entry.path)} -- node --test`);
  let untrusted = await untrustedReviewPaths(root, [entry]);
  assert.deepEqual(untrusted, [entry.path]);
  assert.equal((await judgeRequest(request, ctx([entry], { untrusted })))?.allow, undefined, 'not allowed before the person allows running');
  assert.equal((await judgeRequest(request, ctx([entry])))?.allow, 'test', 'without the narrowing it would match (the narrowing is what blocks it)');
  const view = (await goalOverview(root, goal.id, { user: person })).worktrees.entries.find((item) => item.id === worktree);
  assert.deepEqual([view.kind, view.run.allowed, view.reviewDone], ['review', false, false]);
  await assert.rejects(allowReviewRun(root, goal.id, worktree, { author: person, head: 'b'.repeat(40), hash: view.run.hash }), (error) => error.status === 409, 'stale head');
  await assert.rejects(allowReviewRun(root, goal.id, worktree, { author: person, head: state.head, hash: 'c'.repeat(64) }), (error) => error.status === 409, 'stale worktree.json hash');
  const allowed = await allowReviewRun(root, goal.id, worktree, { author: person, head: state.head, hash: view.run.hash });
  assert.deepEqual([allowed.pr, allowed.head, allowed.by], [7, state.head, person]);
  assert.deepEqual(await untrustedReviewPaths(root, [entry]), []);
  assert.equal((await goalOverview(root, goal.id, { user: person })).worktrees.entries.find((item) => item.id === worktree).run.allowed, true);
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), `${JSON.stringify({ setup: [process.execPath, '-e', '1'] })}\n`);
  assert.deepEqual(await untrustedReviewPaths(root, [entry]), [entry.path]);
  git(root, 'checkout', '-q', '--', 'docs/wax/worktree.json');
  assert.deepEqual(await untrustedReviewPaths(root, [entry]), []);
  state.head = await push('one\nnewer\n');
  const again = await fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: state.head, gh });
  entry = (await readWorktrees(root)).find((item) => item.id === again.worktree);
  untrusted = await untrustedReviewPaths(root, [entry]);
  assert.deepEqual(untrusted, [entry.path]);
});

test('engine: the review worker starts in the review worktree, its prompt quotes the PR as data, and goal allow does not match its test runs until a person allows running', async (t) => {
  const { root, gh, state } = await fixture(t);
  await setPm(root, { author: person, kind: 'human' });
  const launches = [];
  const execute = async (dir, input) => {
    const where = input.cwd;
    const run = `node ${JSON.stringify(CLI)} test f1 --worktree ${JSON.stringify(where)} -- node --test`;
    launches.push({ cwd: where, prompt: input.prompt, test: await input.goalAllow.check(bash(run)) });
    return { message: JSON.stringify({ outcome: 'blocked', report: 'needs a person' }) };
  };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: person, intervalMs: 10_000, snapshots: false });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: 'PR 검토', features: ['f1'] }, { author: person });
  await engine.allow.set(goal.id, { kinds: ['test'], test: 'node --test' }, person);
  const { worktree } = await fetchReviewPr(root, goal.id, { author: person, feature: 'f1', number: 7, head: state.head, gh });
  const entry = (await readWorktrees(root)).find((item) => item.id === worktree);
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: person });
  const start = async () => {
    const card = (await goalOverview(root, goal.id, { user: person, tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker' || item.kind === 'blocked');
    await executeSuggestion(root, goal.id, card.key, { author: person, tools: await engine.tools(), workers: engine.workers });
    await engine.workers.settled();
  };
  await start();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, entry.path, 'the review worker ran in the review worktree');
  assert.equal(launches[0].test?.allow, undefined, 'goal allow test did not match before the run allowance');
  assert.match(launches[0].prompt, /PR 검토 워크트리/);
  assert.match(launches[0].prompt, />\s+"reviewPr": \{/, 'the PR is quoted data');
  assert.doesNotMatch(launches[0].prompt, /@team/, 'the PR title is not in the prompt');
  assert.equal((await readDecisions(root, goal.id)).some((item) => item.kind === 'worktree' && item.outcome === 'review-used'), true);
  const view = (await goalOverview(root, goal.id, { user: person })).worktrees.entries.find((item) => item.id === worktree);
  await allowReviewRun(root, goal.id, worktree, { author: person, head: state.head, hash: view.run.hash });
  const prompt = workerPrompt({ root, goal: await readGoal(root, goal.id), feature: { id: 'f1', title: 'f1', description: '', phase: 'review', iteration: 0, artifacts: {}, completed: {}, proofs: [] },
    task: { id: 'task-1', phase: 'review', note: '' }, author: 'wax-worker-claude', worktree: entry, realRoot: root });
  assert.match(prompt, /"fromFork": true/);
});

test('cleanup: a discarded review worktree or one whose task left review is removed with its ref; the server routes need the token and a person', async (t) => {
  const { root, gh, state } = await fixture(t);
  const goal = await createGoal(root, { title: 'PR 검토', features: ['f1'] }, { author: person });
  const server = createChatServer({ root, env: { WAX_CHAT_USER: person, WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: async () => [], gh });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(`/api/pm-loop/${goal.id}/review-pr`, { number: 7 }, {})).status, 403, 'no token');
  const info = await (await post(`/api/pm-loop/${goal.id}/review-pr`, { number: 7 })).json();
  assert.equal(info.pr.head, state.head);
  const fetched = await post(`/api/pm-loop/${goal.id}/review-pr/fetch`, { feature: 'f1', number: 7, head: info.pr.head });
  assert.equal(fetched.status, 200);
  const { worktree } = await fetched.json();
  const entry = (await readWorktrees(root)).find((item) => item.id === worktree);
  assert.equal((await post(`/api/pm-loop/${goal.id}/worktrees/${worktree}/allow-run`, { head: 'd'.repeat(40) })).status, 409);
  const board = await (await fetch(`${base}/api/worktree-board`)).json();
  const row = board.rows.find((item) => item.id === worktree);
  assert.deepEqual([row.kind, row.pr.number, row.branch, row.issue], ['review', 7, null, null]);
  const tier3 = await (await fetch(`${base}/api/worktree-board/${worktree}?tier=3`)).json();
  assert.deepEqual(tier3.integration, { integrated: null, reason: 'review' });
  assert.equal(tier3.cleanup, undefined, 'no cleanup suggestion for review worktrees');
  await updateFeature(root, 'f1', 'save', { phase: 'review', content: '# review\n확인된 작업 내역' });
  await updateFeature(root, 'f1', 'complete', { phase: 'review', evidence: '수용 기준 확인', verdict: 'pass', waiver });
  assert.equal((await goalOverview(root, goal.id, { user: person })).worktrees.cleanable, true);
  const cleaned = await cleanupGoalWorktrees(root, goal.id, { author: person });
  assert.deepEqual([cleaned.removed, cleaned.refs], [[worktree], { [worktree]: 'deleted' }]);
  assert.equal(await exists(entry.path), false);
  assert.throws(() => git(root, 'rev-parse', '--verify', '-q', 'refs/wax/review/pr-7'));
});
