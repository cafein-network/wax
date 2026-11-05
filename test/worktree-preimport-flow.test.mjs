import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { decideSetup, setupReview } from '../src/worktree-setup.mjs';
import { mergeTreeSupported, worktreeState } from '../src/worktree-import.mjs';
import { PREIMPORT_AUTHOR, lastPreimport, preimportKey, preimportRuns } from '../src/worktree-preimport.mjs';
import { createGoal, createPmLoop, executeSuggestion, goalOverview, readDecisions, readGoal, startWorktreeChecks, stopWorktreeChecks, worktreeChecksStatus } from '../src/chat/pm-loop.mjs';
import { getFeature } from '../src/workflow.mjs';
import { setPm } from '../src/chat/team.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const modern = mergeTreeSupported(git(process.cwd(), '--version').match(/(\d+\.\d+)/)[1]);
const person = '대표';
const free = { portProbe: async () => 'free' };
const REPORT = 'console.log(JSON.stringify({ cwd: process.cwd(), preimport: process.env.WAX_PREIMPORT ?? null, worker: process.env.WAX_WORKER ?? null, port: process.env.WAX_PORT ?? null, gitDir: process.env.GIT_DIR ?? null }));\n';
const SCRIPTS = {
  'checks/fail.mjs': `${REPORT}console.error("one test failed"); process.exit(1);\n`,
  'checks/pass.mjs': 'console.log("all good");\n',
  'checks/hang.mjs': 'console.log("waiting"); setInterval(() => {}, 1000);\n',
  'checks/dirty.mjs': 'import { writeFileSync } from "node:fs"; writeFileSync("coverage.json", "{}");\n',
};

const DEFAULT_CHECKS = [[process.execPath, 'checks/fail.mjs'], [process.execPath, 'checks/pass.mjs']];
async function repo(t, checks) {
  const root = await project(t, ['f1', 'f2']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'line\n');
  await mkdir(join(root, 'checks'));
  for (const [path, text] of Object.entries(SCRIPTS)) await writeFile(join(root, path), text);
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  if (checks) await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ checks }));
  commit(root);
  return root;
}
const approve = async (root) => decideSetup(root, { author: person, hash: (await setupReview(root)).hash });
async function setup(t, checks = DEFAULT_CHECKS) {
  const root = await repo(t, checks);
  if (checks) await approve(root);
  const goal = await readGoal(root, (await createGoal(root, { title: '검사', features: ['f1', 'f2'], worktrees: true }, { author: person })).id);
  const one = (await prepareWorktree(root, goal, 'f1', free)).entry;
  return { root, goal, one };
}
async function gitFiles(root) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const info = await lstat(path); out[relative(join(root, '.git'), path).split(sep).join('/')] = `${info.size} ${info.mtimeMs}`; }
    }
  };
  await walk(join(root, '.git'));
  return out;
}
async function runningWorker(root, goal, feature = 'f1') {
  await appendRecord(join(root, '.wax', 'chat', 'pm-loop', `${goal}.jsonl`), (seq) => ({ schema: 1, record: 'decision', id: makeId('pd', seq), seq, goal, kind: 'worker', outcome: 'launched',
    worker: 'pw-0000aaaa', tool: 'claude', feature, phase: 'implement', iteration: 0, by: person, at: new Date().toISOString() }));
}

test('approved checks run in the worktree without a shell, all of them even after a failure; the record has wax test proof shape and stays out of the task evidence; the project .git is unchanged', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'changed by the worker\n');
  const before = await gitFiles(root);
  const evidence = (await getFeature(root, 'f1')).evidence?.length ?? 0;
  const started = await startWorktreeChecks(root, goal.id, one.id, { author: person });
  assert.equal(started.started.worktree, one.id);
  assert.equal(started.started.source, 'config');
  const record = await started.job;
  assert.equal(record.kind, 'preimport');
  assert.equal(record.outcome, 'failed');
  assert.equal(record.source, 'config');
  assert.equal(record.hash, (await setupReview(root)).hash);
  assert.equal(record.by, person);
  assert.equal(record.behind, 0);
  assert.deepEqual(record.results.map((item) => [item.outcome, item.exitCode]), [['failed', 1], ['passed', 0]], 'the second command ran after the first failed (W11)');
  const first = record.results[0];
  assert.equal(first.kind, 'test');
  assert.equal(first.author, PREIMPORT_AUTHOR);
  assert.deepEqual(first.worktree, { id: one.id, branch: one.branch });
  assert.deepEqual(first.command, [process.execPath, 'checks/fail.mjs']);
  assert.equal(first.commit, git(one.path, 'rev-parse', 'HEAD'));
  assert.equal(first.dirty, true);
  assert.deepEqual(Object.keys(first.tree.files), ['shared.txt']);
  const seen = JSON.parse(first.output.split('\n')[0]);
  assert.deepEqual(seen, { cwd: await realpath(one.path), preimport: '1', worker: null, port: String(one.port), gitDir: null });
  assert.match(first.output, /one test failed/);
  assert.equal((await readFile(join(root, '.wax', 'chat', 'preimport', `${one.id}.jsonl`), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await getFeature(root, 'f1')).evidence?.length ?? 0, evidence, 'not attached to the task evidence');
  assert.deepEqual(await gitFiles(root), before, 'the project .git did not change');
  const scratch = await mkdtemp(join(tmpdir(), 'wax-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'objects'));
  const state = await worktreeState(root, one, scratch);
  assert.equal(record.key, preimportKey({ worktree: one.id, tip: state.tip, commit: state.commit, head: state.head, source: 'config', hash: record.hash, commands: record.commands }));
  assert.equal(record.commit, state.commit);
  const log = (await readDecisions(root, goal.id)).find((item) => item.kind === 'worktree' && item.outcome === 'checks');
  assert.deepEqual(log.checks, { seq: record.seq, key: record.key, outcome: 'failed' });
  const view = await goalOverview(root, goal.id, { user: person });
  assert.deepEqual(view.worktrees.entries.find((entry) => entry.id === one.id).checks.last, { outcome: 'failed', source: 'config', commands: 2, at: record.at, seq: record.seq, passed: 1 });
  const status = await worktreeChecksStatus(root, goal.id, one.id);
  assert.equal(status.source, 'config');
  assert.equal(status.running, null);
  assert.equal(status.last.seq, record.seq);
});

test('a check that changes the worktree is changedTree (counted as a failure) with the changed path; main moving ahead is kept as behind', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t, [[process.execPath, 'checks/pass.mjs'], [process.execPath, 'checks/dirty.mjs']]);
  await writeFile(join(root, 'later.txt'), 'main moved\n');
  commit(root, 'main moves');
  const record = await (await startWorktreeChecks(root, goal.id, one.id, { author: person })).job;
  assert.equal(record.outcome, 'changedTree');
  assert.deepEqual(record.changed, ['coverage.json']);
  assert.deepEqual(record.results.map((item) => item.outcome), ['passed', 'passed']);
  assert.equal(record.behind, 1);
});

test('sources: no checks means 409 with the hint (W10); the start-screen command is used when worktree.json has none; shell characters and changed checks are refused', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t, null);
  await assert.rejects(startWorktreeChecks(root, goal.id, one.id, { author: person }), (error) => error.status === 409 && /가져오기 전 검사가 없습니다/.test(error.message));
  await assert.rejects(startWorktreeChecks(root, goal.id, one.id, { author: person, testCommand: 'node checks/pass.mjs | tail' }), (error) => error.status === 409 && /셸 없이 나눌 수 없는/.test(error.message));
  const record = await (await startWorktreeChecks(root, goal.id, one.id, { author: person, testCommand: 'node checks/pass.mjs' })).job;
  assert.equal(record.source, 'start');
  assert.equal(record.hash, null);
  assert.equal(record.outcome, 'passed');
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ checks: [[process.execPath, 'checks/pass.mjs']] }));
  await assert.rejects(startWorktreeChecks(root, goal.id, one.id, { author: person }), (error) => error.status === 409 && /승인 전이거나/.test(error.message));
  await approve(root);
  await mkdir(join(one.path, 'docs', 'wax'), { recursive: true });
  await writeFile(join(one.path, 'docs', 'wax', 'worktree.json'), JSON.stringify({ checks: [['rm', '-rf', '.']] }));
  const differs = await (await startWorktreeChecks(root, goal.id, one.id, { author: person })).job;
  assert.deepEqual(differs.commands, [[process.execPath, 'checks/pass.mjs']]);
  assert.equal(differs.configDiffers, true);
  assert.equal((await preimportRuns(root, one.id)).length, 2);
});

test('people only (403), a running worker in the goal blocks the start (409), one run per project (W18), stopping records stopped', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t, [[process.execPath, 'checks/hang.mjs']]);
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) {
    await assert.rejects(startWorktreeChecks(root, goal.id, one.id, { author }), (error) => error.status === 403, author);
    await assert.rejects(stopWorktreeChecks(root, goal.id, one.id, { author }), (error) => error.status === 403, author);
  }
  const two = (await prepareWorktree(root, await readGoal(root, goal.id), 'f2', free)).entry;
  const running = await startWorktreeChecks(root, goal.id, one.id, { author: person });
  await assert.rejects(startWorktreeChecks(root, goal.id, two.id, { author: person }), (error) => error.status === 409 && error.message.includes(one.id), 'one run per project');
  assert.equal((await worktreeChecksStatus(root, goal.id, two.id)).busy, one.id);
  assert.equal((await worktreeChecksStatus(root, goal.id, one.id)).running.worktree, one.id);
  await assert.rejects(stopWorktreeChecks(root, goal.id, two.id, { author: person }), (error) => error.status === 409);
  const stopped = await stopWorktreeChecks(root, goal.id, one.id, { author: person });
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(stopped.stoppedBy, person);
  assert.equal((await running.job).seq, stopped.seq);
  assert.equal(stopped.results[0].outcome, 'stopped');
  await runningWorker(root, goal.id);
  await assert.rejects(startWorktreeChecks(root, goal.id, one.id, { author: person }), (error) => error.status === 409 && error.message.includes(goal.id), 'a worker is running');
  assert.equal((await lastPreimport(root, one.id)).seq, stopped.seq);
});

test('while checks run in a worktree the engine does not start a worker there (a card for a person); the dashboard API starts, reads and stops checks with the token only', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t, [[process.execPath, 'checks/hang.mjs']]);
  await setPm(root, { author: person, kind: 'human' });
  const launches = [];
  const execute = async (dir, input) => { launches.push(input); return { message: JSON.stringify({ outcome: 'done', report: 'x' }) }; };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: person, intervalMs: 10_000, snapshots: false });
  t.after(() => engine.close());
  const running = await startWorktreeChecks(root, goal.id, one.id, { author: person });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: person });
  const card = (await goalOverview(root, goal.id, { user: person, tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker' && item.key.startsWith('f1:'));
  await executeSuggestion(root, goal.id, card.key, { author: person, tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  assert.equal(launches.length, 0, 'the worker was not started');
  const end = (await readDecisions(root, goal.id)).filter((item) => item.kind === 'worker').at(-1);
  assert.equal(end.outcome, 'failed');
  assert.match(end.reason, /가져오기 전 검사가 돌고 있어/);
  assert.equal((await goalOverview(root, goal.id, { user: person })).worktrees.entries.find((entry) => entry.id === one.id).checks.running.total, 1);
  await stopWorktreeChecks(root, goal.id, one.id, { author: person });
  await running.job;

  const server = createChatServer({ root, env: { WAX_CHAT_USER: person, WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: async () => [] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let open = true;
  t.after(() => (open ? server.shutdown() : null));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const route = `/api/pm-loop/${goal.id}/worktrees/${one.id}/checks`;
  assert.equal((await post(route, {}, {})).status, 403);
  assert.equal((await post(`${route}/stop`, {}, {})).status, 403);
  const start = await post(route, { commands: [['rm', '-rf', '/']] });
  assert.equal(start.status, 202);
  const body = await start.json();
  assert.deepEqual(body.commands, [[process.execPath, 'checks/hang.mjs']], 'commands in the request body are ignored');
  const status = await (await fetch(`${base}${route}`)).json();
  assert.equal(status.running.worktree, one.id);
  const stopped = await (await post(`${route}/stop`, {})).json();
  assert.equal(stopped.outcome, 'stopped');
  assert.equal((await (await fetch(`${base}${route}`)).json()).last.seq, stopped.seq);
  assert.equal((await post(route, {})).status, 202);
  open = false;
  await server.shutdown();
  assert.equal((await lastPreimport(root, one.id)).outcome, 'stopped');
});
