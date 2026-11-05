import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { checkEnv, overallOutcome, pickSource, preimportKey, runCheck, runChecks } from '../src/worktree-preimport.mjs';
import { killTree } from '../src/process-tree.mjs';
import { gitEnv } from '../src/git-read.mjs';

const found = (checks, extra = {}) => ({ state: 'found', hash: 'h1', config: { setup: null, env: [], portEnv: null, copy: [], checks, ...extra } });
const approved = [{ hash: 'h1' }];
const exists = (path) => lstat(path).then(() => true, () => false);
const zombie = (pid) => { try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return !zombie(pid); } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((done) => setTimeout(done, 20)); }
  return false;
}
function fakeSpawn(plan = []) {
  const calls = [];
  const spawn = (command, args, options) => {
    const index = calls.length;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 5000 + index;
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); setImmediate(() => child.emit('close', null, signal)); };
    calls.push({ command, args, options, child });
    const step = plan[index];
    if (step?.throws) throw Object.assign(new Error(step.throws), { code: 'EINVAL' });
    if (step) process.nextTick(() => { if (step.out) child.stdout.emit('data', step.out); if (step.error) child.emit('error', new Error(step.error)); else if (step.code !== undefined) child.emit('close', step.code, null); });
    return child;
  };
  return { spawn, calls };
}
const noState = async () => ({ commit: 'c', dirty: false, tree: null });
const deadKill = () => { throw Object.assign(new Error('no group'), { code: 'ESRCH' }); };

test('source: approved worktree.json checks first; pending or changed checks fall back to the start-screen command; shell characters are refused; nothing means no checks (W10)', () => {
  assert.deepEqual(pickSource(found([['npm', 'test'], ['node', '--test']]), approved, 'npm run lint'),
    { source: 'config', commands: [['npm', 'test'], ['node', '--test']], hash: 'h1', configState: 'approved' });
  assert.deepEqual(pickSource(found([['npm', 'test']]), [], 'node --test "test/a b.mjs"'), { source: 'start', commands: [['node', '--test', 'test/a b.mjs']], hash: null, configState: 'pending' });
  assert.deepEqual(pickSource(found([['npm', 'test']]), [{ hash: 'old' }], 'npm test'), { source: 'start', commands: [['npm', 'test']], hash: null, configState: 'changed' });
  assert.deepEqual(pickSource(found([['npm', 'test']]), [{ hash: 'old' }], ''), { source: null, reason: 'unapproved', configState: 'changed' });
  for (const text of ['npm test && rm -rf x', 'npm test | tail', 'node -e "a;b"', 'echo $HOME', 'npm test > out.txt']) assert.deepEqual(pickSource({ state: 'none' }, [], text).reason, 'shell', text);
  assert.deepEqual(pickSource({ state: 'none' }, [], ''), { source: null, reason: 'none', configState: 'none' });
  assert.equal(pickSource(found([]), approved, 'npm test').source, 'start');
  const key = { worktree: 'goal-1a2b3c4d-1', tip: 'a', commit: 'c', head: 'h', source: 'config', hash: 'h1', commands: [['npm', 'test']] };
  assert.equal(preimportKey(key), preimportKey({ ...key }));
  for (const change of [{ tip: 'b' }, { commit: 'd' }, { head: 'i' }, { source: 'start' }, { hash: 'h2' }, { commands: [['npm', 'test', '--x']] }]) assert.notEqual(preimportKey({ ...key, ...change }), preimportKey(key), JSON.stringify(change));
});

test('environment: location variables are stripped, WAX_PREIMPORT=1 and the worktree port (plus the approved portEnv) are set, WAX_WORKER is never passed', () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, WAX_WORKER: process.env.WAX_WORKER };
  process.env.GIT_DIR = '/elsewhere/.git'; process.env.WAX_WORKER = '1';
  try {
    const env = checkEnv({ port: 4123 }, found([['npm', 'test']], { portEnv: 'VITE_PORT' }), approved, gitEnv());
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.WAX_WORKER, undefined);
    assert.equal(env.WAX_PREIMPORT, '1');
    assert.equal(env.WAX_PORT, '4123');
    assert.equal(env.VITE_PORT, '4123');
    assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
    assert.equal(checkEnv({ port: 4123 }, found([['npm', 'test']], { portEnv: 'VITE_PORT' }), [{ hash: 'old' }], gitEnv()).VITE_PORT, undefined);
    assert.equal(checkEnv({ port: null }, { state: 'none' }, [], gitEnv()).WAX_PORT, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('runner: no shell, in the worktree, one at a time; a failing command does not stop the next ones (W11); output keeps the head and tail', async () => {
  const big = `${'a'.repeat(15_000)}${'b'.repeat(15_000)}`;
  const { spawn, calls } = fakeSpawn([{ out: 'fail\n', code: 1 }, { out: big, code: 0 }, { code: 0 }]);
  const progress = [];
  const results = await runChecks('/work/tree', [['npm', 'test'], ['node', '--test'], ['node', 'x.mjs']], { env: { A: '1' }, spawn, stateOf: noState, platform: 'linux',
    onProgress: (index, result) => progress.push([index, result?.outcome ?? null]) });
  assert.deepEqual(results.map((item) => item.result.outcome), ['failed', 'passed', 'passed']);
  assert.deepEqual(calls.map((call) => [call.command, call.args, call.options.cwd, call.options.shell, call.options.detached, call.options.env.A]),
    [['npm', ['test'], '/work/tree', false, true, '1'], ['node', ['--test'], '/work/tree', false, true, '1'], ['node', ['x.mjs'], '/work/tree', false, true, '1']]);
  assert.deepEqual(progress, [[0, null], [0, 'failed'], [1, null], [1, 'passed'], [2, null], [2, 'passed']]);
  assert.equal(results[0].result.exitCode, 1);
  assert.equal(results[1].result.truncated, true);
  assert.equal(results[1].result.output.length, 20_000);
  assert.ok(results[1].result.output.startsWith('a') && results[1].result.output.endsWith('b'));
  assert.deepEqual(results[0].state, { commit: 'c', dirty: false, tree: null });
  assert.equal(overallOutcome(results.map((item) => item.result)), 'failed');
});

test('runner: per-command and overall time limits; when the overall limit hits, the rest is skipped; a command that cannot start is an error with the Windows hint', async () => {
  const delays = [];
  const timers = { set: (fn, ms) => { delays.push(ms); return setTimeout(fn, 1); }, clear: clearTimeout };
  const first = fakeSpawn([null, { code: 0 }]);
  const late = await runChecks('/w', [['node', 'hang.mjs'], ['node', 'ok.mjs']], { spawn: first.spawn, timers, stateOf: noState, platform: 'linux', kill: deadKill, commandMs: 600_000, totalMs: 1_800_000 });
  assert.deepEqual(late.map((item) => item.result.outcome), ['timeout', 'passed']);
  assert.equal(late[0].result.timedOut, true);
  assert.equal(delays[0], 600_000, 'the per-command limit');
  assert.deepEqual(first.calls[0].child.killed, ['SIGKILL'], 'no process group: the child itself is killed');
  let clock = 0;
  const now = () => clock;
  const total = fakeSpawn([null, { code: 0 }]);
  const slow = { set: (fn, ms) => setTimeout(() => { clock += ms; fn(); }, 1), clear: clearTimeout };
  const over = await runChecks('/w', [['node', 'hang.mjs'], ['node', 'never.mjs']], { spawn: total.spawn, timers: slow, now, stateOf: noState, platform: 'linux', kill: deadKill, commandMs: 600_000, totalMs: 1000 });
  assert.deepEqual(over.map((item) => item.result.outcome), ['timeout', 'skipped']);
  assert.equal(total.calls.length, 1, 'the skipped command never started');
  assert.equal(overallOutcome(over.map((item) => item.result)), 'timeout');
  const broken = fakeSpawn([{ throws: 'spawn EINVAL' }, { error: 'spawn wax-none ENOENT' }, { code: 0 }]);
  const errors = await runChecks('/w', [['npm', 'test'], ['wax-none'], ['node', 'ok.mjs']], { spawn: broken.spawn, stateOf: noState, platform: 'win32', taskkill: () => {} });
  assert.deepEqual(errors.map((item) => item.result.outcome), ['error', 'error', 'passed']);
  assert.match(errors[0].result.output, /EINVAL[\s\S]*node/);
  assert.equal(broken.calls[2].options.detached, false, 'Windows: not detached (taskkill /T finds the tree)');
  assert.equal(overallOutcome(errors.map((item) => item.result)), 'error');
});

test('runner: stopping ends the running command (stopped) and skips the rest; an already aborted signal starts nothing', async () => {
  const { spawn, calls } = fakeSpawn([null, { code: 0 }]);
  const controller = new AbortController();
  const running = runChecks('/w', [['node', 'hang.mjs'], ['node', 'next.mjs']], { spawn, signal: controller.signal, stateOf: noState, platform: 'win32', taskkill: (args) => calls.push({ taskkill: args }),
    closeWaitMs: 10, onProgress: (index, result) => { if (index === 0 && !result) setImmediate(() => controller.abort()); } });
  const results = await running;
  assert.deepEqual(results.map((item) => item.result.outcome), ['stopped', 'skipped']);
  assert.deepEqual(calls.find((call) => call.taskkill).taskkill, ['/pid', '5000', '/T', '/F']);
  assert.equal(overallOutcome(results.map((item) => item.result)), 'stopped');
  let spawned = 0;
  const early = await runChecks('/w', [['node', 'a.mjs']], { spawn: () => { spawned++; throw new Error('no'); }, signal: AbortSignal.abort(), stateOf: noState });
  assert.deepEqual([early[0].result.outcome, spawned], ['skipped', 0]);
  assert.equal(overallOutcome([{ outcome: 'passed' }], ['coverage/x.json']), 'changedTree');
  assert.equal(overallOutcome([{ outcome: 'passed' }, { outcome: 'passed' }]), 'passed');
});

test('tree kill (one function for setup, wax test and pre-import checks): SIGTERM to the group, a check every 20ms for 200ms, then SIGKILL; Windows uses taskkill /T /F', async () => {
  const sent = [];
  let living = true;
  const kill = (pid, signal) => { sent.push([pid, signal]); if (signal === 0 && !living) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  const delays = [];
  const timers = { set: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); }, clear: clearTimeout };
  assert.equal(await killTree({ pid: 77, kill: () => {} }, { platform: 'linux', kill, timers }), 'kill');
  assert.deepEqual(sent[0], [-77, 'SIGTERM']);
  assert.deepEqual(sent.at(-1), [-77, 'SIGKILL']);
  assert.equal(sent.filter((item) => item[1] === 0).length, 11);
  assert.ok(delays.every((ms) => ms === 20));
  sent.length = 0; living = false;
  assert.equal(await killTree({ pid: 78 }, { platform: 'darwin', kill, timers }), 'term');
  assert.deepEqual(sent.map((item) => item[1]), ['SIGTERM', 0]);
  const own = [];
  assert.equal(await killTree({ pid: 79, kill: (signal) => own.push(signal) }, { platform: 'linux', kill: deadKill }), 'child');
  assert.deepEqual(own, ['SIGKILL']);
  const calls = [];
  assert.equal(await killTree({ pid: 80, kill: (signal) => calls.push(['kill', signal]) }, { platform: 'win32', taskkill: (args) => calls.push(['taskkill', ...args]) }), 'taskkill');
  assert.equal(await killTree({ pid: 81, kill: (signal) => calls.push(['kill', signal]) }, { platform: 'win32', taskkill: () => { throw new Error('no taskkill'); } }), 'child');
  assert.deepEqual(calls, [['taskkill', '/pid', '80', '/T', '/F'], ['kill', 'SIGKILL']]);
  assert.equal(await killTree(null), 'child');
});

test('stop during a real check ends the whole process tree (a grandchild too)', async (t) => {
  const root = await project(t);
  const pidFile = join(root, 'grandchild.pid');
  const script = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('checking'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const running = runCheck(root, [process.execPath, '-e', script], { env: { ...process.env }, timeoutMs: 60_000, signal: controller.signal });
  assert.ok(await until(() => exists(pidFile)), 'the check started its grandchild');
  const grandchild = Number(await readFile(pidFile, 'utf8'));
  assert.equal(alive(grandchild), true);
  controller.abort();
  const result = await running;
  assert.equal(result.outcome, 'stopped');
  assert.match(result.output, /checking/);
  assert.ok(await until(() => !alive(grandchild), 10_000), 'the grandchild was ended with the check');
});
