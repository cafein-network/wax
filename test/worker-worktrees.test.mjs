import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createTestSymlink, project } from './chat-helpers.mjs';
import { appendWorktree, readWorktrees, validWorktreeRecord, portEnv } from '../src/worktrees.mjs';
import { copyEnv, pickPort, prepareWorktree, worktreeBase } from '../src/worktree-make.mjs';
import { SETUP_LIMITS, decideSetup, readSetup, runSetup, setupDecisions, setupReview, setupRuns, setupState } from '../src/worktree-setup.mjs';
import { createGoal, createPmLoop, executeSuggestion, goalOverview, readDecisions, readGoal, setWorktrees } from '../src/chat/pm-loop.mjs';
import { listRuns, readSnapshots, runFileDiff, runSummary } from '../src/snapshots.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { setPm } from '../src/chat/team.mjs';
import { listTasks } from '../src/chat/team.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const posix = process.platform !== 'win32';

async function repo(t, features = ['f1', 'f2']) {
  const root = await project(t, features);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'line\n');
  commit(root);
  return root;
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
const goalOn = async (root, extra = {}) => createGoal(root, { title: '격리', features: ['f1', 'f2'], worktrees: true, ...extra }, { author: '대표' });

test('create and reuse: branch wax/<goal>/<feature>-<n> at .wax/worktrees/<goal>-<n> from the goal start HEAD; the same task reuses it, another task gets its own', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  const goal = await goalOn(root);
  const start = git(root, 'rev-parse', 'HEAD');
  assert.equal(goal.worktrees.base, start);
  await writeFile(join(root, 'later.txt'), 'later\n'); commit(root, 'later');
  const first = await prepareWorktree(root, await readGoal(root, goal.id), 'f1');
  assert.equal(first.created, true);
  assert.equal(first.entry.id, `${goal.id}-1`);
  assert.equal(first.entry.branch, `wax/${goal.id}/f1-1`);
  assert.equal(first.entry.path, join(real, '.wax', 'worktrees', `${goal.id}-1`));
  assert.equal(first.entry.base, start);
  assert.equal(git(first.entry.path, 'rev-parse', 'HEAD'), start);
  assert.equal(git(first.entry.path, 'rev-parse', '--abbrev-ref', 'HEAD'), `wax/${goal.id}/f1-1`);
  assert.equal(await exists(join(first.entry.path, 'later.txt')), false);
  const again = await prepareWorktree(root, await readGoal(root, goal.id), 'f1');
  assert.deepEqual([again.created, again.entry.id], [false, first.entry.id], 'the next phase of the same task reuses its worktree');
  const other = await prepareWorktree(root, await readGoal(root, goal.id), 'f2');
  assert.deepEqual([other.created, other.entry.id, other.entry.branch], [true, `${goal.id}-2`, `wax/${goal.id}/f2-2`]);
  await writeFile(join(first.entry.path, 'work.txt'), 'phase one\n'); commit(first.entry.path, 'phase one');
  const tip = git(first.entry.path, 'rev-parse', 'HEAD');
  await rm(first.entry.path, { recursive: true, force: true });
  const rebuilt = await prepareWorktree(root, await readGoal(root, goal.id), 'f1');
  assert.deepEqual([rebuilt.created, rebuilt.entry.id, rebuilt.entry.base], [true, `${goal.id}-3`, tip]);
  assert.equal(await readFile(join(rebuilt.entry.path, 'work.txt'), 'utf8'), 'phase one\n');
  const latest = await readWorktrees(root);
  assert.deepEqual(latest.map((entry) => [entry.id, entry.state]), [[`${goal.id}-2`, 'active'], [`${goal.id}-1`, 'removed'], [`${goal.id}-3`, 'active']]);
  const lines = (await readFile(join(root, '.wax', 'chat', 'worktrees.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.every((line) => line.schema === 1 && validWorktreeRecord(line)));
  assert.deepEqual(lines.map((line) => line.seq), lines.map((_, index) => index + 1));
  assert.ok(lines.every((line) => line.by === 'pm-loop'));
});

test('project .git: making a worktree adds only that branch (and its reflog) and one worktree entry; nothing else in .git changes, hooks do not run', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await writeFile(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho ran > "$GIT_DIR/../hook-ran"\ntouch hook-ran\n', { mode: 0o755 });
  const goal = await goalOn(root);
  const before = await gitFiles(root);
  const made = await prepareWorktree(root, goal, 'f1');
  const after = await gitFiles(root);
  const added = Object.keys(after).filter((path) => !(path in before)).sort();
  const changed = Object.keys(before).filter((path) => after[path] !== before[path]);
  assert.deepEqual(changed, [], 'no existing file in .git changed (index, HEAD, config, refs, logs)');
  const allowed = [`refs/heads/wax/${goal.id}/f1-1`, `logs/refs/heads/wax/${goal.id}/f1-1`];
  for (const path of added) assert.ok(allowed.includes(path) || path.startsWith(`worktrees/${made.entry.id}/`), `unexpected .git file ${path}`);
  assert.ok(added.includes(`refs/heads/wax/${goal.id}/f1-1`) || git(root, 'show-ref', `refs/heads/wax/${goal.id}/f1-1`));
  assert.ok(added.some((path) => path.startsWith(`worktrees/${made.entry.id}/`)));
  assert.equal(git(root, 'branch', '--list', 'wax/*').split('\n').length, 1);
  assert.equal(await exists(join(root, 'hook-ran')), false);
  assert.equal(await exists(join(made.entry.path, 'hook-ran')), false, 'post-checkout did not run');
  assert.equal(git(root, 'status', '--porcelain'), '');
  const reuse = await gitFiles(root);
  await prepareWorktree(root, goal, 'f1');
  assert.deepEqual(await gitFiles(root), reuse);
});

test('enabling: needs a Git repository top folder with a commit; the start screen value must be exactly true', async (t) => {
  const plain = await project(t, ['f1']);
  await assert.rejects(goalOn(plain, { features: ['f1'] }), (error) => error.status === 409 && /Git/.test(error.message));
  const empty = await project(t, ['f1']);
  git(empty, 'init', '-q');
  await assert.rejects(goalOn(empty, { features: ['f1'] }), (error) => error.status === 409 && /커밋/.test(error.message));
  const root = await repo(t);
  await mkdir(join(root, 'sub'));
  await assert.rejects(worktreeBase(join(root, 'sub')), (error) => error.status === 409);
  assert.equal((await createGoal(root, { title: '끔', features: ['f1'] }, { author: '대표' })).worktrees, undefined, 'default off');
  assert.equal((await createGoal(root, { title: '문자열', features: ['f2'], worktrees: 'yes' }, { author: '대표' })).worktrees, undefined, 'only true turns it on');
});

test('.env copy: only the names a person picked, regular files only, links not followed, never over an existing file, mode 0600, names recorded without contents', async (t) => {
  const root = await repo(t);
  const outside = await project(t);
  await writeFile(join(root, '.env'), 'SECRET=one\n');
  await writeFile(join(outside, 'secret'), 'OUTSIDE=1\n');
  if (!(await createTestSymlink(t, join(outside, 'secret'), join(root, '.env.local'), 'file'))) return;
  await writeFile(join(root, '.env.test'), 'TEST=1\n');
  await mkdir(join(root, '.env.dir'));
  const goal = await goalOn(root);
  await assert.rejects(setWorktrees(root, goal.id, { author: '대표', env: ['../.env'] }), (error) => error.status === 400);
  await assert.rejects(setWorktrees(root, goal.id, { author: '대표', env: ['.env/x'] }), (error) => error.status === 400);
  const saved = await setWorktrees(root, goal.id, { author: '대표', env: ['.env', '.env.local', '.env.missing', '.env.dir'] });
  assert.deepEqual(saved.worktrees.env, ['.env', '.env.local', '.env.missing', '.env.dir']);
  const made = await prepareWorktree(root, saved, 'f1');
  assert.deepEqual(made.copied, ['.env'], '.env.test was not picked; the link, the missing name and the folder are skipped');
  assert.deepEqual(made.skipped.map((item) => [item.name, item.reason]), [['.env.local', 'link'], ['.env.missing', 'missing'], ['.env.dir', 'notFile']]);
  assert.equal(await readFile(join(made.entry.path, '.env'), 'utf8'), 'SECRET=one\n');
  assert.equal(await exists(join(made.entry.path, '.env.local')), false);
  assert.equal(await exists(join(made.entry.path, '.env.test')), false);
  if (posix) assert.equal((await stat(join(made.entry.path, '.env'))).mode & 0o777, 0o600);
  const entry = (await readWorktrees(root)).find((item) => item.id === made.entry.id);
  assert.deepEqual(entry.env, ['.env']);
  const records = [await readFile(join(root, '.wax', 'chat', 'worktrees.jsonl'), 'utf8'), JSON.stringify(await readDecisions(root, goal.id))].join('\n');
  assert.doesNotMatch(records, /SECRET=one|OUTSIDE=1/, 'contents are not recorded');
  await writeFile(join(made.entry.path, '.env.test'), 'KEEP\n');
  await symlink(join(outside, 'secret'), join(made.entry.path, '.env.prod')).catch(() => {});
  await writeFile(join(root, '.env.prod'), 'PROD=1\n');
  const second = await copyEnv(root, made.entry.path, ['.env.test', '.env.prod']);
  assert.deepEqual(second.copied, []);
  assert.deepEqual(second.skipped.map((item) => item.reason), ['exists', 'exists']);
  assert.equal(await readFile(join(made.entry.path, '.env.test'), 'utf8'), 'KEEP\n');
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'OUTSIDE=1\n');
});

test('setup hash: worktree.json bytes plus repo files named in setup args; a change to either needs approval again; links are refused; approval is by hash', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  assert.equal((await readSetup(real)).state, 'none');
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'setup.mjs'), 'console.log("setup")\n');
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: ['node', 'scripts/setup.mjs', '--config=scripts/extra.json'], env: ['.env'], portEnv: 'PORT' }));
  await writeFile(join(root, 'scripts', 'extra.json'), '{}\n');
  const review = await setupReview(root);
  assert.equal(review.state, 'pending');
  assert.deepEqual(review.refs.map((ref) => ref.path), ['scripts/extra.json', 'scripts/setup.mjs']);
  assert.equal(review.refs[1].text, 'console.log("setup")\n');
  await assert.rejects(decideSetup(root, { author: '대표', hash: 'f'.repeat(64) }), (error) => error.status === 409);
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) await assert.rejects(decideSetup(root, { author, hash: review.hash }), (error) => error.status === 403, author);
  assert.equal((await setupDecisions(root)).length, 0);
  const decided = await decideSetup(root, { author: '대표', hash: review.hash });
  assert.equal(decided.state, 'approved');
  assert.equal((await setupReview(root)).state, 'approved');
  await writeFile(join(root, 'scripts', 'setup.mjs'), 'console.log("changed")\n');
  const changed = await setupReview(root);
  assert.equal(changed.state, 'changed');
  assert.notEqual(changed.hash, review.hash);
  await writeFile(join(root, 'scripts', 'setup.mjs'), 'console.log("setup")\n');
  assert.equal((await setupReview(root)).state, 'approved', 'same bytes, same hash');
  await writeFile(join(root, 'scripts', 'extra.json'), '{"x":1}\n');
  assert.equal((await setupReview(root)).state, 'changed', '--name=value arguments count too');
  await writeFile(join(root, 'scripts', 'extra.json'), '{}\n');
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: ['node', 'scripts/setup.mjs', '--config=scripts/extra.json'], env: ['.env'], portEnv: 'VITE_PORT' }));
  assert.equal((await setupReview(root)).state, 'changed');
  for (const bad of [{ setup: 'npm ci' }, { setup: ['npm'], shell: true }, { setup: ['npm'], portEnv: 'PATH' }, { setup: [] }, { setup: ['npm', 'a\u0007'] }]) {
    await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify(bad));
    const state = await setupReview(root);
    assert.equal(state.state, 'invalid', JSON.stringify(bad));
    await assert.rejects(decideSetup(root, { author: '대표', hash: state.hash }), (error) => error.status === 409);
  }
  const outside = await project(t);
  await writeFile(join(outside, 'evil.sh'), 'echo evil\n');
  if (!(await createTestSymlink(t, join(outside, 'evil.sh'), join(root, 'scripts', 'link.sh'), 'file'))) return;
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: ['sh', 'scripts/link.sh'] }));
  const linked = await setupReview(root);
  assert.equal(linked.state, 'invalid');
  assert.match(linked.reason, /scripts\/link\.sh/);
  assert.equal(setupState({ state: 'found', hash: 'a' }, [{ hash: 'b' }, { hash: 'a' }]), 'approved');
  assert.equal(setupState({ state: 'found', hash: 'b' }, [{ hash: 'b' }, { hash: 'a' }]), 'changed', 'only the last approval counts');
});

async function withSetup(root, script, { approve = true, portEnv: name = 'PORT' } = {}) {
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'setup.mjs'), script);
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: [process.execPath, 'scripts/setup.mjs'], ...(name ? { portEnv: name } : {}) }));
  commit(root, 'setup');
  if (approve) await decideSetup(root, { author: '대표', hash: (await setupReview(root)).hash });
}

test('setup run: an approved script runs once in the new worktree without a shell, with WAX_PORT and portEnv; unapproved is skipped and nothing else runs', async (t) => {
  const root = await repo(t);
  await withSetup(root, 'const fs = require("node:fs"); fs.writeFileSync("setup-ran.txt", process.cwd() + " " + process.env.WAX_PORT + " " + process.env.PORT); console.log("x".repeat(5000) + "END");\n'.replace('const fs = require("node:fs");', 'import fs from "node:fs";'));
  const goal = await goalOn(root);
  const made = await prepareWorktree(root, goal, 'f1');
  assert.equal(made.setup.outcome, 'ok');
  assert.deepEqual(made.env, { WAX_PORT: String(made.entry.port), PORT: String(made.entry.port) });
  assert.equal(await readFile(join(made.entry.path, 'setup-ran.txt'), 'utf8'), `${made.entry.path} ${made.entry.port} ${made.entry.port}`);
  assert.equal(await exists(join(root, 'setup-ran.txt')), false, 'the setup ran in the worktree, not the project');
  const [run] = await setupRuns(root);
  assert.deepEqual([run.worktree, run.outcome, run.code], [made.entry.id, 'ok', 0]);
  assert.equal(Array.from(run.output).length, SETUP_LIMITS.output, 'only the last 4000 characters are kept');
  assert.match(run.output, /END\n?$/);
  assert.equal((await readWorktrees(root)).find((item) => item.id === made.entry.id).setup.outcome, 'ok');
  await rm(join(made.entry.path, 'setup-ran.txt'));
  await prepareWorktree(root, goal, 'f1');
  assert.equal(await exists(join(made.entry.path, 'setup-ran.txt')), false);
  await writeFile(join(root, 'scripts', 'setup.mjs'), 'import fs from "node:fs"; fs.writeFileSync("changed-ran.txt", "x");\n');
  commit(root, 'change setup');
  const later = await createGoal(root, { title: '바뀐 준비', create: [{ id: 'f3' }], worktrees: true }, { author: '대표' });
  const skipped = await prepareWorktree(root, later, 'f3');
  assert.equal(skipped.setup.outcome, 'changed');
  assert.equal(await exists(join(skipped.entry.path, 'changed-ran.txt')), false);
  assert.deepEqual(skipped.env, { WAX_PORT: String(skipped.entry.port) });
});

test('setup failure: the worktree stays registered with the failure, the engine does not start the worker and the blocked task is a card for a person', async (t) => {
  const root = await repo(t);
  await setPm(root, { author: '대표', kind: 'human' });
  await withSetup(root, 'console.error("boom"); process.exit(3);\n');
  const launches = [];
  const execute = async (dir, input) => { launches.push(input); return { message: JSON.stringify({ outcome: 'done', report: 'x' }) }; };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: '대표', intervalMs: 10_000, snapshots: false });
  t.after(() => engine.close());
  const goal = await goalOn(root, { features: ['f1'] });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  assert.equal(launches.length, 0, 'the worker was not started');
  const decisions = await readDecisions(root, goal.id);
  const end = decisions.filter((item) => item.kind === 'worker').at(-1);
  assert.equal(end.outcome, 'failed');
  assert.match(end.reason, /준비 스크립트가 실패/);
  assert.equal(end.health, undefined, 'not recorded as a tool failure');
  assert.equal(decisions.find((item) => item.kind === 'worktree').outcome, 'setup-failed');
  const entry = (await readWorktrees(root)).find((item) => item.goal === goal.id);
  assert.equal(entry.setup.outcome, 'failed');
  const tasks = (await listTasks(root, { all: true })).filter((task) => task.feature === 'f1');
  assert.equal(tasks.at(-1).status, 'blocked');
  const view = await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() });
  assert.ok(view.suggestions.some((item) => item.kind === 'blocked' && item.human), 'a human card');
  assert.match((await setupRuns(root)).at(-1).output, /boom/);
});

test('setup cap: the run is stopped after 5 minutes (injected timer and runner) and counts as a timeout', async () => {
  const delays = [];
  const killed = [];
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = undefined;
    child.kill = (signal) => { killed.push(signal); };
    setImmediate(() => child.stdout.emit('data', Buffer.from('installing...')));
    return child;
  };
  const timers = { set: (fn, ms) => { delays.push(ms); return setTimeout(fn, 5); }, clear: clearTimeout };
  const result = await runSetup(process.cwd(), ['npm', 'ci'], { spawn: fake, timers });
  assert.deepEqual(delays, [5 * 60_000]);
  assert.equal(result.outcome, 'timeout');
  assert.deepEqual(killed, ['SIGKILL']);
  assert.match(result.output, /installing/);
  const missing = await runSetup(process.cwd(), ['wax-no-such-command-xyz']);
  assert.equal(missing.outcome, 'failed');
});

test('ports: each active worktree in the project gets a different port from 41000-41999; removed ones free theirs; only port names reach the worker env', async (t) => {
  assert.equal(pickPort([]), 41000);
  assert.equal(pickPort([{ state: 'active', port: 41000 }, { state: 'removed', port: 41001 }, { state: 'active', port: 41002 }]), 41001);
  assert.equal(pickPort([{ state: 'active', port: 41000 }], [41000, 41000]), null);
  const root = await repo(t);
  const one = await goalOn(root, { features: ['f1'] });
  const two = await goalOn(root, { features: ['f2'] });
  const probe = { portProbe: async () => 'free' };
  const a = await prepareWorktree(root, one, 'f1', probe);
  const b = await prepareWorktree(root, two, 'f2', probe);
  assert.deepEqual([a.entry.port, b.entry.port], [41000, 41001]);
  assert.deepEqual(portEnv({ WAX_PORT: 41000, PORT: '41000', PATH: '/x', NODE_OPTIONS: '1', VITE_PORT: 'abc', LOW_PORT: 80 }), { WAX_PORT: '41000', PORT: '41000' });
});

test('human only: turning isolated branches on, picking .env and approving the setup refuse worker, auto and engine names; on/off is locked once a worker started', async (t) => {
  const root = await repo(t);
  await setPm(root, { author: '대표', kind: 'human' });
  for (const author of ['auto', 'pm-loop', 'wax-worker-claude']) {
    await assert.rejects(createGoal(root, { title: 'x', features: ['f1'], worktrees: true }, { author }), (error) => error.status === 403, author);
  }
  const goal = await createGoal(root, { title: '나중에 켬', features: ['f1'] }, { author: '대표' });
  for (const author of ['auto', 'pm-loop', 'wax-worker-codex']) {
    await assert.rejects(setWorktrees(root, goal.id, { author, on: true }), (error) => error.status === 403, author);
  }
  await assert.rejects(setWorktrees(root, goal.id, { author: '대표', env: ['.env'] }), (error) => error.status === 409, 'env needs it on');
  const on = await setWorktrees(root, goal.id, { author: '대표', on: true });
  assert.equal(on.worktrees.on, true);
  assert.equal(on.worktrees.by, '대표');
  const off = await setWorktrees(root, goal.id, { author: '대표', on: false });
  assert.equal(off.worktrees.on, false);
  await setWorktrees(root, goal.id, { author: '대표', on: true });
  const execute = async () => ({ message: JSON.stringify({ outcome: 'blocked', report: 'stop' }) });
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: '대표', intervalMs: 10_000, snapshots: false });
  t.after(() => engine.close());
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  await assert.rejects(setWorktrees(root, goal.id, { author: '대표', on: false }), (error) => error.status === 409);
  assert.deepEqual((await setWorktrees(root, goal.id, { author: '대표', env: ['.env'] })).worktrees.env, ['.env']);
  const view = (await goalOverview(root, goal.id, { user: '대표' })).worktrees;
  assert.equal(view.locked, true);
  assert.deepEqual(view.candidates.map((item) => item.name), ['.env', '.env.local']);
  assert.equal(view.setup.state, 'none');
  assert.equal(view.entries.length, 1);
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: async () => [] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, headers = { 'x-chat-token': token }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const created = await (await post('/api/pm-loop', { title: 'api', create: [{ id: 'g1' }] })).json();
  assert.equal(created.worktrees, undefined, 'unchecked by default');
  assert.equal((await post(`/api/pm-loop/${created.id}/worktrees`, { on: true }, {})).status, 403);
  assert.equal((await post('/api/worktree-setup/approve', { hash: 'x' }, {})).status, 403);
  const turned = await (await post(`/api/pm-loop/${created.id}/worktrees`, { on: true })).json();
  assert.deepEqual([turned.worktrees.on, turned.worktrees.by], [true, '대표']);
  assert.equal((await post('/api/worktree-setup/approve', { hash: 'x' })).status, 404, 'no setup script');
  assert.equal((await (await fetch(`${base}/api/worktree-setup`)).json()).state, 'none');
  const checked = await (await post('/api/pm-loop', { title: 'api2', create: [{ id: 'g2' }], worktrees: true })).json();
  assert.equal(checked.worktrees.on, true);
});

test('engine: two workers on different tasks edit the same file at once in their own worktrees; each run sees only its own change and the project tree is untouched', async (t) => {
  const root = await repo(t);
  await setPm(root, { author: '대표', kind: 'human' });
  const seen = [];
  let release;
  const gate = new Promise((done) => { release = done; });
  const execute = async (dir, input) => {
    const feature = input.prompt.match(/작업: ([a-z0-9-]+), 단계/)[1];
    seen.push({ cwd: input.cwd, env: input.env, feature, dir });
    if (seen.length === 2) release();
    await gate;
    await writeFile(join(input.cwd, 'shared.txt'), `line\nby ${feature}\n`);
    return { message: JSON.stringify({ outcome: 'blocked', report: `edited by ${feature}` }) };
  };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const goal = await goalOn(root);
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const cards = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.filter((item) => item.kind === 'start-worker');
  assert.equal(cards.length, 2);
  for (const card of cards) await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  assert.equal(seen.length, 2);
  const byFeature = Object.fromEntries(seen.map((item) => [item.feature, item]));
  const entries = await readWorktrees(root);
  const f1 = entries.find((item) => item.feature === 'f1'), f2 = entries.find((item) => item.feature === 'f2');
  assert.equal(byFeature.f1.cwd, f1.path);
  assert.equal(byFeature.f2.cwd, f2.path);
  assert.notEqual(f1.port, f2.port);
  assert.deepEqual(byFeature.f1.env, { WAX_PORT: String(f1.port) });
  assert.equal(await readFile(join(f1.path, 'shared.txt'), 'utf8'), 'line\nby f1\n');
  assert.equal(await readFile(join(f2.path, 'shared.txt'), 'utf8'), 'line\nby f2\n');
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'line\n', 'the project working tree is untouched');
  assert.equal(git(root, 'status', '--porcelain'), '');
  const runs = (await readDecisions(root, goal.id)).filter((item) => item.kind === 'worker' && item.outcome === 'exited');
  assert.equal(runs.length, 2);
  const items = await listRuns(root, { goal: goal.id });
  assert.equal(items.length, 2);
  for (const run of runs) {
    const item = items.find((entry) => entry.run === run.worker);
    const summary = await runSummary(root, item, { runs: items });
    assert.deepEqual(summary.files.map((file) => [file.path, file.state]), [['shared.txt', 'modify']]);
    assert.equal(summary.concurrent, 0, 'the other worker ran in another worktree');
    const diff = JSON.stringify(await runFileDiff(root, run.worker, 'shared.txt'));
    assert.match(diff, new RegExp(`by ${run.feature}`));
    assert.doesNotMatch(diff, new RegExp(`by ${run.feature === 'f1' ? 'f2' : 'f1'}`));
  }
  const snaps = await readSnapshots(root);
  assert.deepEqual([...new Set(snaps.map((snap) => snap.worktree))].sort(), [f1.id, f2.id].sort());
  assert.deepEqual((await readDecisions(root, goal.id)).filter((item) => item.kind === 'worktree').map((item) => item.outcome), ['created', 'created']);
});

test('without isolated branches the engine runs workers in the project folder exactly as before (no cwd, no env, no worktree list)', async (t) => {
  const root = await repo(t);
  await setPm(root, { author: '대표', kind: 'human' });
  const seen = [];
  const execute = async (dir, input) => { seen.push(input); return { message: JSON.stringify({ outcome: 'blocked', report: 'x' }) }; };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: '대표', intervalMs: 10_000, snapshots: false });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '그대로', features: ['f1'] }, { author: '대표' });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers: engine.workers });
  await engine.workers.settled();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, undefined);
  assert.equal(seen[0].env, undefined);
  assert.equal(await exists(join(root, '.wax', 'chat', 'worktrees.jsonl')), false);
  assert.equal(await exists(join(root, '.wax', 'worktrees')), false);
  await assert.rejects(appendWorktree(root, { id: 'bad', goal: goal.id, state: 'active' }), /invalid worktree record/);
});

test('a worktree add failure on the Windows path length limit says how to fix it; other failures and other platforms stay as they were', async () => {
  const { addFailureDetail } = await import('../src/worktree-make.mjs');
  const long = "fatal: cannot create directory at 'src/dir-1/dir-2': Filename too long";
  const path = 'C:\p\.wax\worktrees\goal-00000001-1';
  assert.match(addFailureDetail(long, { path, platform: 'win32' }), /Filename too long .*core\.longpaths true/);
  assert.match(addFailureDetail(long, { path, platform: 'win32' }), /goal-00000001-1/);
  assert.equal(addFailureDetail(long, { path, platform: 'linux' }), long, 'not on other platforms');
  assert.equal(addFailureDetail('fatal: a branch named x already exists', { path, platform: 'win32' }), 'fatal: a branch named x already exists');
  assert.equal(addFailureDetail('x'.repeat(400), { platform: 'win32' }).length, 300);
});
