import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { readWorktrees } from '../src/worktrees.mjs';
import { pickFreePort, portFree, prepareWorktree } from '../src/worktree-make.mjs';
import { decideSetup, runSetup, setupRuns, setupReview } from '../src/worktree-setup.mjs';
import { BASELINE_LIMITS, readBaseline } from '../src/worktree-baseline.mjs';
import { mergeTreeSupported, previewImport } from '../src/worktree-import.mjs';
import { createGoal, createPmLoop, executeSuggestion, goalOverview, importWorktree, previewWorktreeImport, readDecisions, readGoal } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const modern = mergeTreeSupported(git(process.cwd(), '--version').match(/(\d+\.\d+)/)[1]);
const person = '대표';
const zombie = (pid) => { try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return !zombie(pid); } catch (error) { return error.code === 'EPERM'; } };
const until = async (check, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((done) => setTimeout(done, 25)); } return false; };

async function repo(t, features = ['f1', 'f2']) {
  const root = await project(t, features);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'line\n');
  commit(root);
  return root;
}
async function withSetup(root, script, { approve = true } = {}) {
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'setup.mjs'), script);
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ setup: [process.execPath, 'scripts/setup.mjs'] }));
  commit(root, 'setup');
  if (approve) await decideSetup(root, { author: person, hash: (await setupReview(root)).hash });
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
const goalOn = async (root, extra = {}) => createGoal(root, { title: '격리', features: ['f1', 'f2'], worktrees: true, ...extra }, { author: person });
const free = { portProbe: async () => 'free' };


test('stop during setup: aborting ends the whole setup process tree (a grandchild too) and the run counts as stopped', async (t) => {
  const root = await project(t);
  const pidFile = join(root, 'grandchild.pid');
  const script = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); console.log('installing'); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const running = runSetup(root, [process.execPath, '-e', script], { signal: controller.signal });
  assert.ok(await until(() => exists(pidFile)), 'the setup started its grandchild');
  const grandchild = Number(await readFile(pidFile, 'utf8'));
  assert.equal(alive(grandchild), true);
  controller.abort();
  const result = await running;
  assert.equal(result.outcome, 'stopped');
  assert.ok(await until(() => !alive(grandchild), 10_000), 'the grandchild was ended with the setup');
  let spawned = 0;
  const early = await runSetup(root, ['npm', 'ci'], { signal: AbortSignal.abort(), spawn: () => { spawned++; throw new Error('should not spawn'); } });
  assert.deepEqual([early.outcome, spawned], ['stopped', 0]);
});

test('stop during setup on Windows (simulated): the tree is ended with taskkill /T /F, the child is not detached, and the timeout uses the same tree kill', async () => {
  const calls = [];
  const options = [];
  const fake = (command, args, opts) => {
    options.push(opts);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = (signal) => { calls.push(['kill', signal]); };
    return child;
  };
  const taskkill = (args) => { calls.push(['taskkill', ...args]); };
  const controller = new AbortController();
  const running = runSetup(process.cwd(), ['npm.cmd', 'ci'], { spawn: fake, platform: 'win32', taskkill, signal: controller.signal });
  controller.abort();
  const stopped = await running;
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(options[0].detached, false, 'Windows: not detached (taskkill /T finds the tree)');
  assert.equal(options[0].shell, false);
  assert.deepEqual(calls[0], ['taskkill', '/pid', '4242', '/T', '/F']);
  calls.length = 0;
  const timers = { set: (fn) => setTimeout(fn, 5), clear: clearTimeout };
  const late = await runSetup(process.cwd(), ['npm.cmd', 'ci'], { spawn: fake, platform: 'win32', taskkill, timers });
  assert.equal(late.outcome, 'timeout');
  assert.deepEqual(calls[0], ['taskkill', '/pid', '4242', '/T', '/F']);
  calls.length = 0;
  const broken = new AbortController();
  const again = runSetup(process.cwd(), ['npm.cmd', 'ci'], { spawn: fake, platform: 'win32', taskkill: () => { throw new Error('no taskkill'); }, signal: broken.signal });
  broken.abort();
  assert.equal((await again).outcome, 'stopped');
  assert.deepEqual(calls, [['kill', 'SIGKILL']]);
  options.length = 0;
  const posixStop = new AbortController();
  const posixRun = runSetup(process.cwd(), ['npm', 'ci'], { spawn: fake, platform: 'linux', taskkill, signal: posixStop.signal });
  posixStop.abort();
  assert.equal((await posixRun).outcome, 'stopped');
  assert.equal(options[0].detached, true);
});

test('stop during setup: prepareWorktree throws a stopped setup error, records the stopped run, leaves the worktree active with setup "stopped", and the next start runs setup again', async (t) => {
  const root = await repo(t);
  await withSetup(root, 'import fs from "node:fs"; fs.writeFileSync("setup-ran.txt", "x");\n');
  const goal = await goalOn(root);
  const controller = new AbortController();
  const hang = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => controller.abort());
    return child;
  };
  await assert.rejects(prepareWorktree(root, goal, 'f1', { spawn: hang, signal: controller.signal, ...free }), (error) => error.worktree === true && error.setupOutcome === 'stopped');
  const entry = (await readWorktrees(root)).find((item) => item.goal === goal.id);
  assert.deepEqual([entry.state, entry.setup.outcome], ['active', 'stopped']);
  assert.equal((await setupRuns(root)).at(-1).outcome, 'stopped');
  assert.equal(await readBaseline(root, entry).then((found) => found.state), 'none', 'no baseline from a stopped setup');
  const again = await prepareWorktree(root, goal, 'f1', free);
  assert.equal(again.created, false);
  assert.equal(again.setup.outcome, 'ok');
  assert.equal(await exists(join(again.entry.path, 'setup-ran.txt')), true);
  await assert.rejects(prepareWorktree(root, goal, 'f2', { signal: AbortSignal.abort(), ...free }), (error) => error.setupOutcome === 'stopped' || /aborted|멈춤|stopped/i.test(error.message));
});

test('engine: a person stopping the worker while its setup runs ends the setup, the worker is never started, and the end record says stopped', async (t) => {
  const root = await repo(t);
  await setPm(root, { author: person, kind: 'human' });
  await withSetup(root, 'setInterval(() => {}, 1000);\n');
  const launches = [];
  let spawned = null;
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    spawned = { command, opts };
    return child;
  };
  const execute = async (dir, input) => { launches.push(input); return { message: JSON.stringify({ outcome: 'done', report: 'x' }) }; };
  const engine = createPmLoop({ root, execute, listTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }], user: person, intervalMs: 10_000, snapshots: false,
    worktreeOptions: { spawn, ...free } });
  t.after(() => engine.close());
  const goal = await goalOn(root, { features: ['f1'] });
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: person });
  const card = (await goalOverview(root, goal.id, { user: person, tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  await executeSuggestion(root, goal.id, card.key, { author: person, tools: await engine.tools(), workers: engine.workers });
  assert.ok(await until(() => spawned !== null), 'setup started');
  const [running] = engine.workers.list();
  await engine.workers.stop(running.worker, person);
  await engine.workers.settled();
  assert.equal(launches.length, 0, 'the worker was not started after the stop');
  const decisions = await readDecisions(root, goal.id);
  const end = decisions.filter((item) => item.kind === 'worker').at(-1);
  assert.deepEqual([end.outcome, end.by], ['stopped', person]);
  assert.equal(decisions.find((item) => item.kind === 'worktree').outcome, 'setup-stopped');
  const entry = (await readWorktrees(root)).find((item) => item.goal === goal.id);
  assert.deepEqual([entry.state, entry.setup.outcome], ['active', 'stopped']);
});


test('ports: a port held on this computer (loopback or all addresses) is busy, a free one is free; busy ports are skipped; a failing probe falls back to the list and says so', async (t) => {
  const hold = (host) => new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen({ port: 0, ...(host ? { host } : {}) }, () => done(server)); });
  for (const host of ['127.0.0.1', null]) {
    const server = await hold(host);
    t.after(() => new Promise((done) => server.close(done)));
    const { port } = server.address();
    assert.equal(await portFree(port), 'busy', `held on ${host ?? 'all addresses'}`);
  }
  const probe = await hold('127.0.0.1');
  const { port: spare } = probe.address();
  await new Promise((done) => probe.close(done));
  assert.equal(await portFree(spare), 'free');
  const busy = new Set([41001, 41002]);
  const seen = [];
  const fake = async (port) => { seen.push(port); return busy.has(port) ? 'busy' : 'free'; };
  assert.deepEqual(await pickFreePort([{ state: 'active', port: 41000 }], { probe: fake }), { port: 41003, checked: true });
  assert.deepEqual(seen, [41001, 41002, 41003]);
  assert.deepEqual(await pickFreePort([], { range: [41000, 41002], probe: async () => 'busy' }), { port: null, checked: true });
  assert.deepEqual(await pickFreePort([{ state: 'active', port: 41000 }], { probe: async () => 'unknown' }), { port: 41001, checked: false });
  assert.deepEqual(await pickFreePort([], { probe: async () => { throw new Error('boom'); } }), { port: 41000, checked: false });
  const root = await repo(t);
  const made = await prepareWorktree(root, await goalOn(root, { features: ['f1'] }), 'f1', { portProbe: async (port) => (port < 41005 ? 'busy' : 'free') });
  assert.equal(made.entry.port, 41005);
  assert.equal(made.portChecked, true);
});


const SETUP_OUTPUT = `import fs from "node:fs";
fs.mkdirSync("node_modules/pkg", { recursive: true });
fs.writeFileSync("node_modules/pkg/index.js", "module.exports = 1;\\n");
fs.writeFileSync("node_modules/pkg/package.json", "{}\\n");
fs.mkdirSync("gen", { recursive: true });
fs.writeFileSync("gen/out.txt", "generated\\n");
`;

test('baseline: right after setup the worktree untracked files are recorded (paths and blob ids, digest in the registry); the project .git is not written', async (t) => {
  const root = await repo(t);
  await withSetup(root, SETUP_OUTPUT);
  const goal = await goalOn(root);
  const before = await gitFiles(root);
  const made = await prepareWorktree(root, goal, 'f1', free);
  const entry = (await readWorktrees(root)).find((item) => item.id === made.entry.id);
  assert.equal(entry.setup.outcome, 'ok');
  assert.equal(entry.setup.baseline.state, 'ok');
  assert.equal(entry.setup.baseline.count, 3);
  assert.match(entry.setup.baseline.digest, /^[a-f0-9]{64}$/);
  const found = await readBaseline(root, entry);
  assert.equal(found.state, 'ok');
  assert.deepEqual(Object.keys(found.paths).sort(), ['gen/out.txt', 'node_modules/pkg/index.js', 'node_modules/pkg/package.json']);
  assert.equal(found.paths['gen/out.txt'], git(made.entry.path, 'hash-object', 'gen/out.txt'));
  const after = await gitFiles(root);
  const added = Object.keys(after).filter((path) => !(path in before));
  assert.ok(added.every((path) => path.startsWith(`worktrees/${made.entry.id}/`) || path.startsWith('refs/heads/wax/') || path.startsWith('logs/')), added.join(', '));
  assert.ok(!added.some((path) => path.startsWith('objects/')), 'no objects written');
});

test('import: setup output unchanged since setup is left out (uncommitted or committed in the branch) and listed with the reason; changed setup files and worker files are imported', { skip: !modern }, async (t) => {
  const root = await repo(t);
  await withSetup(root, SETUP_OUTPUT);
  const goal = await goalOn(root);
  const made = await prepareWorktree(root, await readGoal(root, goal.id), 'f1', free);
  const w = made.entry.path;
  await writeFile(join(w, 'gen', 'out.txt'), 'generated and edited\n');
  await mkdir(join(w, 'src'), { recursive: true });
  await writeFile(join(w, 'src', 'new.txt'), 'worker\n');
  git(w, 'add', 'node_modules/pkg/package.json');
  git(w, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'worker commit');
  const before = await gitFiles(root);
  const preview = await previewWorktreeImport(root, goal.id, made.entry.id, { author: person });
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.files.map((file) => file.path).sort(), ['gen/out.txt', 'src/new.txt']);
  assert.equal(preview.excluded.count, 2);
  assert.deepEqual(preview.excluded.groups, [{ path: 'node_modules', count: 2 }]);
  assert.deepEqual(preview.excluded.paths.sort(), ['node_modules/pkg/index.js', 'node_modules/pkg/package.json']);
  assert.equal(preview.baseline.state, 'ok');
  assert.deepEqual(await gitFiles(root), before, 'the preview wrote nothing to the project .git');
  const result = await importWorktree(root, goal.id, made.entry.id, { author: person, fingerprint: preview.fingerprint });
  assert.deepEqual(result.imported.sort(), ['gen/out.txt', 'src/new.txt']);
  assert.equal(await exists(join(root, 'node_modules')), false, 'setup output was not imported');
  assert.equal(await readFile(join(root, 'gen', 'out.txt'), 'utf8'), 'generated and edited\n');
  assert.equal(result.excluded, 2);
});

test('import refuses with a clear message when the baseline cannot be trusted (missing, edited) or could not be recorded (too many files)', { skip: !modern }, async (t) => {
  const root = await repo(t);
  await withSetup(root, SETUP_OUTPUT);
  const goal = await goalOn(root);
  const made = await prepareWorktree(root, await readGoal(root, goal.id), 'f1', free);
  await writeFile(join(made.entry.path, 'src.txt'), 'worker\n');
  const entry = (await readWorktrees(root)).find((item) => item.id === made.entry.id);
  const file = join(root, '.wax', 'chat', 'worktree-baselines', `${entry.id}.json`);
  const original = await readFile(file, 'utf8');
  const edited = JSON.parse(original);
  edited.paths['src.txt'] = git(made.entry.path, 'hash-object', 'src.txt');
  await writeFile(file, JSON.stringify(edited));
  let preview = await previewImport(root, goal.id, entry.id);
  assert.equal(preview.ready, false);
  assert.equal(preview.baseline.state, 'mismatch');
  assert.ok(preview.commands?.length, 'shows the commands to merge by hand');
  await assert.rejects(importWorktree(root, goal.id, entry.id, { author: person, fingerprint: preview.fingerprint }), (error) => error.status === 409 && /setup|준비/.test(error.message));
  await rm(file);
  preview = await previewImport(root, goal.id, entry.id);
  assert.deepEqual([preview.ready, preview.baseline.state], [false, 'missing']);
  const root2 = await repo(t);
  await withSetup(root2, SETUP_OUTPUT);
  const goal2 = await goalOn(root2);
  const big = await prepareWorktree(root2, await readGoal(root2, goal2.id), 'f1', { ...free, baselineLimits: { ...BASELINE_LIMITS, paths: 2 } });
  assert.equal((await readWorktrees(root2)).find((item) => item.id === big.entry.id).setup.baseline.state, 'tooLarge');
  await writeFile(join(big.entry.path, 'src.txt'), 'worker\n');
  preview = await previewImport(root2, goal2.id, big.entry.id);
  assert.deepEqual([preview.ready, preview.baseline.state], [false, 'tooLarge']);
});

test('baseline when setup runs later on a reused worktree: only files the setup made or changed count, so earlier worker files are still imported', { skip: !modern }, async (t) => {
  const root = await repo(t);
  await withSetup(root, SETUP_OUTPUT, { approve: false });
  const goal = await goalOn(root);
  const first = await prepareWorktree(root, await readGoal(root, goal.id), 'f1', free);
  assert.equal(first.setup.outcome, 'pending');
  await writeFile(join(first.entry.path, 'worker.txt'), 'worker\n');
  await mkdir(join(first.entry.path, 'gen'), { recursive: true });
  await writeFile(join(first.entry.path, 'gen', 'out.txt'), 'worker version\n');
  await decideSetup(root, { author: person, hash: (await setupReview(root)).hash });
  const again = await prepareWorktree(root, await readGoal(root, goal.id), 'f1', free);
  assert.equal(again.setup.outcome, 'ok');
  const entry = (await readWorktrees(root)).find((item) => item.id === first.entry.id);
  const found = await readBaseline(root, entry);
  assert.deepEqual(Object.keys(found.paths).sort(), ['gen/out.txt', 'node_modules/pkg/index.js', 'node_modules/pkg/package.json'], 'worker.txt was there before the setup');
  const preview = await previewImport(root, goal.id, entry.id);
  assert.deepEqual(preview.files.map((file) => file.path), ['worker.txt']);
  assert.equal(preview.excluded.count, 3);
});
