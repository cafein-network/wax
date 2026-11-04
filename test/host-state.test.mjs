import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestSymlink, project } from './chat-helpers.mjs';
import {
  ENDED_AFTER_MS, MAX_FILES, POST_TOOL_EVERY_MS, STALE_AFTER_MS, hostSessionHash, hostView, markHostSeen, readHostState, recordHostEvent, stateFor,
} from '../src/chat/host-state.mjs';
import { joinPresence, listPresence, markPresenceSeen, setPresence } from '../src/chat/presence.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const HOOK = fileURLToPath(new URL('../bin/wax-host-hook.mjs', import.meta.url));
const T0 = Date.parse('2026-11-02T10:00:00Z');
const env = {};
const SESSION = 'cc-session-1';

async function waxProject(t) {
  const root = await project(t);
  await joinPresence(root, { author: 'someone-else', kind: 'codex' }, { now: new Date(T0) });
  return root;
}
const hostFile = (root, session = SESSION) => join(root, '.wax', 'chat', 'host', `${hostSessionHash(session)}.json`);
const record = (root, event, at, extra = {}) => recordHostEvent(root, { session: SESSION, event, ...extra }, { now: at, env });

test('each hook event sets the documented state; other notifications change nothing', () => {
  assert.equal(stateFor('SessionStart'), 'idle');
  assert.equal(stateFor('UserPromptSubmit'), 'working');
  assert.equal(stateFor('PostToolUse'), 'working');
  assert.equal(stateFor('PermissionRequest'), 'blocked');
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) assert.equal(stateFor('Notification', { notificationType: type }), 'blocked', type);
  for (const type of ['idle_prompt', 'auth_success', 'plugin_notification', undefined]) assert.equal(stateFor('Notification', { notificationType: type }), null, String(type));
  assert.equal(stateFor('Stop'), 'done');
  assert.equal(stateFor('SessionEnd'), 'idle');
  assert.equal(stateFor('PreToolUse'), null);
});

test('a hook writes one small record per session, keeps only names, and a stale seq never wins', async (t) => {
  const root = await waxProject(t);
  const first = await record(root, 'UserPromptSubmit', T0);
  assert.equal(first.state, 'working');
  const blocked = await record(root, 'PermissionRequest', T0 + 1000, { toolName: 'Bash' });
  assert.deepEqual([blocked.state, blocked.detail], ['blocked', 'Bash']);
  const raw = await readFile(hostFile(root), 'utf8');
  assert.ok(raw.length < 1024, 'record stays under 1 KB');
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['at', 'detail', 'event', 'schema', 'seen', 'seq', 'state', 'tool']);
  const stored = JSON.parse(raw);
  await writeFile(hostFile(root), JSON.stringify({ ...stored, seq: Number.MAX_SAFE_INTEGER }));
  assert.deepEqual(await record(root, 'Stop', T0 + 2000), { skipped: 'stale' });
  assert.equal((await readHostState(root, hostSessionHash(SESSION))).state, 'blocked');
});

test('PostToolUse writes at most once a minute while working, but always after another state', async (t) => {
  const root = await waxProject(t);
  await record(root, 'UserPromptSubmit', T0);
  assert.deepEqual(await record(root, 'PostToolUse', T0 + POST_TOOL_EVERY_MS - 1), { skipped: 'recent' });
  assert.equal((await record(root, 'PostToolUse', T0 + POST_TOOL_EVERY_MS + 1)).state, 'working');
  await record(root, 'PermissionRequest', T0 + POST_TOOL_EVERY_MS + 2, { toolName: 'Write' });
  assert.equal((await record(root, 'PostToolUse', T0 + POST_TOOL_EVERY_MS + 3)).state, 'working');
});

test('WAX_WORKER=1, WAX_HOST_STATE=off and folders that are not wax projects write nothing', async (t) => {
  const root = await waxProject(t);
  assert.deepEqual(await recordHostEvent(root, { session: SESSION, event: 'Stop' }, { now: T0, env: { WAX_WORKER: '1' } }), { skipped: 'worker' });
  assert.deepEqual(await recordHostEvent(root, { session: SESSION, event: 'Stop' }, { now: T0, env: { WAX_HOST_STATE: 'off' } }), { skipped: 'off' });
  await assert.rejects(readFile(hostFile(root)), { code: 'ENOENT' });
  const plain = await mkdtemp(join(tmpdir(), 'wax-host-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  assert.deepEqual(await recordHostEvent(plain, { session: SESSION, event: 'Stop' }, { now: T0, env }), { skipped: 'not-a-wax-project' });
  assert.deepEqual(await readdir(plain), [], 'no .wax folder is created in other projects');
  await assert.rejects(recordHostEvent(root, { session: '../x', event: 'Stop' }, { now: T0, env }), /host session ID/);
});

test('a linked host folder or file is refused', async (t) => {
  const root = await waxProject(t);
  const outside = await mkdtemp(join(tmpdir(), 'wax-host-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  if (!await createTestSymlink(t, outside, join(root, '.wax', 'chat', 'host'), 'dir')) return;
  await assert.rejects(record(root, 'Stop', T0), /not a plain directory/);
  assert.deepEqual(await readdir(outside), []);
});

test('the folder keeps at most 200 records and drops records silent for a day', async (t) => {
  const root = await waxProject(t);
  const dir = join(root, '.wax', 'chat', 'host');
  await mkdir(dir, { recursive: true });
  const old = new Date(T0 - 2 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < MAX_FILES + 5; i++) {
    const file = join(dir, `${hostSessionHash(`s-${i}`)}.json`);
    await writeFile(file, '{}');
    const when = i < 3 ? old : new Date(T0 - (MAX_FILES + 5 - i) * 1000);
    await utimes(file, when, when);
  }
  await record(root, 'Stop', T0);
  const names = await readdir(dir);
  assert.ok(names.length <= MAX_FILES, `${names.length} files`);
  assert.ok(names.includes(`${hostSessionHash(SESSION)}.json`), 'the session that just reported stays');
  for (let i = 0; i < 3; i++) assert.ok(!names.includes(`${hostSessionHash(`s-${i}`)}.json`), 'day-old record removed');
});

test('display: quiet working or blocked become unknown, seen done becomes idle, ended or two quiet hours mean away', () => {
  const base = { schema: 1, tool: 'claude', seq: 1, at: new Date(T0).toISOString(), seen: false };
  assert.equal(hostView({ ...base, state: 'working', event: 'PostToolUse' }, T0 + STALE_AFTER_MS).state, 'working');
  assert.equal(hostView({ ...base, state: 'working', event: 'PostToolUse' }, T0 + STALE_AFTER_MS + 1).state, 'unknown');
  assert.equal(hostView({ ...base, state: 'blocked', event: 'PermissionRequest' }, T0 + STALE_AFTER_MS + 1).state, 'unknown');
  assert.equal(hostView({ ...base, state: 'done', event: 'Stop' }, T0 + STALE_AFTER_MS + 1).state, 'done', 'done waits for a person');
  assert.equal(hostView({ ...base, state: 'done', event: 'Stop', seen: true }, T0).state, 'idle');
  assert.equal(hostView({ ...base, state: 'idle', event: 'SessionEnd', ended: true }, T0).ended, true);
  assert.equal(hostView({ ...base, state: 'done', event: 'Stop' }, T0 + ENDED_AFTER_MS + 1).ended, true);
  assert.equal(hostView({ ...base, state: 'done', event: 'Stop' }, T0 + ENDED_AFTER_MS).ended, false);
});

test('hooks before join show up once join links the host session; the 10-minute away rule no longer applies', async (t) => {
  const root = await waxProject(t);
  await record(root, 'SessionStart', T0);
  await record(root, 'UserPromptSubmit', T0 + 1000);
  const joined = await joinPresence(root, { author: 'claude-a', kind: 'claude', hostSession: SESSION }, { now: new Date(T0 + 2000) });
  assert.equal(joined.hostLinked, true);
  assert.equal(joined.hostSessionHash, undefined, 'the hash stays private');
  await record(root, 'Stop', T0 + 3000);
  let [entry] = (await listPresence(root, { now: new Date(T0 + 30 * 60 * 1000) })).filter((e) => e.author === 'claude-a');
  assert.deepEqual([entry.host.state, entry.effectiveState], ['done', 'idle']);
  await setPresence(root, { author: 'claude-a', session: joined.session, state: 'working', feature: 'chatbot' }, { now: new Date(T0 + 31 * 60 * 1000) });
  assert.equal((await markPresenceSeen(root, 'claude-a', { now: new Date(T0 + 32 * 60 * 1000) })).state, 'idle');
  [entry] = (await listPresence(root, { now: new Date(T0 + 33 * 60 * 1000) })).filter((e) => e.author === 'claude-a');
  assert.equal(entry.host.state, 'idle');
  await record(root, 'SessionEnd', T0 + 34 * 60 * 1000);
  [entry] = (await listPresence(root, { now: new Date(T0 + 35 * 60 * 1000) })).filter((e) => e.author === 'claude-a');
  assert.equal(entry.effectiveState, 'away');
  const other = (await listPresence(root, { now: new Date(T0 + 35 * 60 * 1000) })).find((e) => e.author === 'someone-else');
  assert.deepEqual([other.host, other.effectiveState], [undefined, 'away']);
});

test('seen only applies to an unseen done turn and never overwrites a newer report', async (t) => {
  const root = await waxProject(t);
  const hash = hostSessionHash(SESSION);
  await record(root, 'UserPromptSubmit', T0);
  assert.equal((await markHostSeen(root, hash)).seen, false, 'working is not marked seen');
  await record(root, 'Stop', T0 + 1000);
  assert.equal((await markHostSeen(root, hash)).seen, true);
  assert.equal(hostView(await record(root, 'UserPromptSubmit', T0 + 2000), T0 + 2000).state, 'working');
  assert.equal(await markHostSeen(root, 'not-a-hash'), null);
});

async function runHook(input, hookEnv = {}) {
  const child = spawn(process.execPath, [HOOK], { env: { ...process.env, WAX_WORKER: '', WAX_HOST_STATE: '', WAX_PROJECT: '', CLAUDE_ENV_FILE: '', ...hookEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('the hook script records quietly, links the session through CLAUDE_ENV_FILE and never fails the host', async (t) => {
  const root = await waxProject(t);
  const envFile = join(root, 'claude-env.sh');
  await writeFile(envFile, '');
  const nested = join(root, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const start = await runHook({ session_id: SESSION, hook_event_name: 'SessionStart', cwd: nested, source: 'startup' }, { CLAUDE_ENV_FILE: envFile });
  assert.deepEqual([start.code, start.stdout, start.stderr], [0, '', '']);
  assert.equal(await readFile(envFile, 'utf8'), `export WAX_HOST_SESSION=${SESSION}\n`);
  const prompt = await runHook({ session_id: SESSION, hook_event_name: 'UserPromptSubmit', cwd: root, prompt: 'SECRET-PROMPT-TEXT' });
  assert.deepEqual([prompt.code, prompt.stdout], [0, '']);
  const tool = await runHook({ session_id: SESSION, hook_event_name: 'PermissionRequest', cwd: root, tool_name: 'Bash', tool_input: { command: 'cat SECRET-INPUT' } });
  assert.equal(tool.code, 0);
  const raw = await readFile(hostFile(root), 'utf8');
  assert.doesNotMatch(raw, /SECRET/);
  assert.equal(JSON.parse(raw).state, 'blocked');
  const fallback = await runHook({ session_id: 'cc-session-2', hook_event_name: 'SessionStart', cwd: root });
  assert.match(JSON.parse(fallback.stdout).hookSpecificOutput.additionalContext, /--host-session cc-session-2/);
  for (const [input, hookEnv] of [['not json', {}], [{ session_id: SESSION, hook_event_name: 'Stop', cwd: tmpdir() }, {}], [{ session_id: SESSION, hook_event_name: 'Stop', cwd: root }, { WAX_WORKER: '1' }]]) {
    const result = await runHook(input, hookEnv);
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], JSON.stringify(input));
  }
  assert.equal(JSON.parse(await readFile(hostFile(root), 'utf8')).state, 'blocked', 'the worker Stop was not recorded');
});

test('chat join reads WAX_HOST_SESSION or --host-session, and who shows the auto state', async (t) => {
  const root = await waxProject(t);
  await record(root, 'Stop', Date.now());
  const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/wax.mjs', import.meta.url)), '--project', root, 'chat', ...args], { env: { ...process.env, WAX_LANG: 'en', WAX_HOST_SESSION: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const joined = await run(['join', '--author', 'claude-b', '--kind', 'claude'], { WAX_HOST_SESSION: SESSION });
  assert.equal(joined.code, 0, joined.stderr);
  assert.match(joined.stdout, /Linked to the session state hook/);
  const who = await run(['who']);
  assert.match(who.stdout.split('\n').find((line) => line.startsWith('claude-b')), /Auto state Done \(unseen\)/);
  assert.match(who.stdout.split('\n').find((line) => line.startsWith('someone-else')), /No auto state/);
  const flagged = await run(['join', '--author', 'claude-c', '--kind', 'claude', '--host-session', 'cc-session-9']);
  assert.match(flagged.stdout, /Linked to the session state hook/);
  const bad = await run(['join', '--author', 'claude-d', '--host-session', '../x']);
  assert.notEqual(bad.code, 0);
});

test('POST /api/presence/<name>/seen marks a done turn seen and refreshes presence', async (t) => {
  const root = await waxProject(t);
  await joinPresence(root, { author: 'claude-a', kind: 'claude', hostSession: SESSION });
  await record(root, 'Stop', Date.now());
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '관리자' }, intervalMs: 100 });
  await server.startWatching();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  const before = (await (await fetch(`${base}/api/presence`)).json()).find((e) => e.author === 'claude-a');
  assert.equal(before.host.state, 'done');
  const denied = await fetch(`${base}/api/presence/claude-a/seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  const seen = await fetch(`${base}/api/presence/${encodeURIComponent('claude-a')}/seen`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': config.token }, body: '{}' });
  assert.equal(seen.status, 200);
  assert.equal((await seen.json()).host.state, 'idle');
  const after = (await (await fetch(`${base}/api/presence`)).json()).find((e) => e.author === 'claude-a');
  assert.equal(after.host.state, 'idle');
});

test('chat wait counts only reports after it started, follows --until, times out and stops when the session ends', async (t) => {
  const { waitPresenceHost } = await import('../src/chat/presence.mjs');
  const root = await waxProject(t);
  await joinPresence(root, { author: 'claude-a', kind: 'claude', hostSession: SESSION });
  let clock = T0;
  const sleep = async (ms) => { clock += ms; };
  await record(root, 'Stop', clock);
  let script = [];
  const run = (options) => waitPresenceHost(root, 'claude-a', { clock: () => clock, sleep: async (ms) => { await sleep(ms); const next = script.shift(); if (next) await next(); }, pollMs: 1000, ...options });
  script = [() => record(root, 'UserPromptSubmit', clock), () => record(root, 'PermissionRequest', clock, { toolName: 'Bash' }), () => record(root, 'Stop', clock)];
  const done = await run({ until: 'done', timeoutMs: 60_000 });
  assert.deepEqual([done.matched, done.state], [true, 'done']);
  script = [() => record(root, 'UserPromptSubmit', clock), () => record(root, 'PermissionRequest', clock, { toolName: 'Bash' })];
  assert.equal((await run({ until: 'blocked', timeoutMs: 60_000 })).state, 'blocked');
  script = [];
  const timedOut = await run({ until: 'done', timeoutMs: 5000 });
  assert.deepEqual([timedOut.matched, timedOut.timedOut], [false, true]);
  script = [() => record(root, 'SessionEnd', clock)];
  assert.equal((await run({ until: 'done', timeoutMs: 60_000 })).ended, true);
  await assert.rejects(run({ until: 'later' }), /--until/);
  await assert.rejects(waitPresenceHost(root, 'someone-else', { timeoutMs: 0 }), /not linked|이어져 있지 않습니다/);
});

test('an assignment to an ended, away or never-joined session is kept with a warning; a reachable session gets none', async (t) => {
  const { assignTask, setPm } = await import('../src/chat/team.mjs');
  const { createFeature } = await import('../src/workflow.mjs');
  const root = await project(t);
  await createFeature(root, { id: 'login', title: '로그인' });
  const now = Date.now();
  await setPm(root, { author: 'pm', kind: 'claude' });
  await joinPresence(root, { author: 'claude-live', kind: 'claude', hostSession: 'live-1' }, { now: new Date(now) });
  await joinPresence(root, { author: 'claude-gone', kind: 'claude', hostSession: 'gone-1' }, { now: new Date(now) });
  await joinPresence(root, { author: 'codex-idle', kind: 'codex' }, { now: new Date(now - 20 * 60 * 1000) });
  await recordHostEvent(root, { session: 'live-1', event: 'UserPromptSubmit' }, { now, env });
  await recordHostEvent(root, { session: 'gone-1', event: 'SessionEnd' }, { now, env });
  const assign = (to) => assignTask(root, { author: 'pm', feature: 'login', to, phase: 'plan', body: '기획' }, { now: new Date(now) });
  assert.equal((await assign('claude-live')).warning, undefined);
  assert.equal((await assign('claude-gone')).warning, 'ended');
  assert.equal((await assign('codex-idle')).warning, 'away');
  const missing = await assign('nobody');
  assert.deepEqual([missing.warning, typeof missing.id], ['notJoined', 'string'], 'the assignment is still created');
});
