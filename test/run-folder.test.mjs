import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, createTestSymlink, project } from './chat-helpers.mjs';
import { activeWorktrees, checkWorktree, readWorktrees, runFolder, validWorktreeRecord, worktreeContaining } from '../src/worktrees.mjs';
import { runAgentSession } from '../src/agent-session.mjs';
import { runCodexSession } from '../src/codex-session.mjs';
import { decideApproval, listApprovals } from '../src/approvals.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { evidenceFreshness } from '../src/freshness.mjs';
import { getFeature, updateFeature } from '../src/workflow.mjs';
import { judgeRequest, matchAllow } from '../src/goal-allow.mjs';
import { listRuns, previewRestore, readSnapshots, restoreSnapshot, runSummary, takeSnapshot, concurrentRuns } from '../src/snapshots.mjs';
import { createGoal, createPmLoop, executeSuggestion, goalOverview, readDecisions, shellPath, workerPrompt } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { RULING_NOT_ALONE } from '../src/rulings.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const GOAL = 'goal-0000000a', OTHER = 'goal-0000000b';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);

async function repo(t, features = []) {
  const root = await project(t, features);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n');
  await writeFile(join(root, 'a.txt'), 'a\n');
  commit(root);
  return root;
}
let seq = 0;
async function register(root, entry) {
  await mkdir(join(root, '.wax', 'chat'), { recursive: true });
  const record = { schema: 1, seq: ++seq, base: null, port: null, env: [], setup: null, state: 'active', at: new Date().toISOString(), by: '대표', ...entry };
  await appendFile(join(root, '.wax', 'chat', 'worktrees.jsonl'), `${JSON.stringify(record)}\n`);
  return record;
}
async function worktree(root, { goal = GOAL, feature = 'f1', n = 1, state = 'active', add = true } = {}) {
  const real = await realpath(root);
  const id = `${goal}-${n}`, branch = `wax/${goal}/${feature}-${n}`, path = join(real, '.wax', 'worktrees', id);
  if (add) git(root, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
  await register(root, { id, goal, feature, branch, path, state });
  return { id, branch, path };
}
async function gitState(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const info = await lstat(path); out.push(`${relative(root, path)} ${info.size} ${info.mtimeMs}`); }
    }
  };
  await walk(join(root, '.git'));
  return out.sort();
}
function fakeClaude(requests, launches = []) {
  return (command, args, options) => {
    launches.push(options);
    const child = new EventEmitter();
    for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
    const emit = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    const answers = [];
    let index = 0;
    const next = () => {
      if (index < requests.length) { emit({ type: 'control_request', request_id: `perm-${index}`, request: { subtype: 'can_use_tool', ...requests[index] } }); return; }
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', structured_output: { outcome: 'blocked', report: JSON.stringify(answers) } });
    };
    child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); };
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const m = JSON.parse(line);
        if (m.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        else if (m.type === 'user') { emit({ type: 'system', subtype: 'init', session_id: 'session-1' }); next(); }
        else if (m.type === 'control_response') { answers.push(m.response.response.behavior); index++; next(); }
      }
    });
    return child;
  };
}
function fakeAcp(sessions, launches = []) {
  return (command, args, options) => {
    launches.push(options);
    const child = new EventEmitter();
    for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
    const emit = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); };
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const m = JSON.parse(line);
        if (m.method === 'initialize') emit({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        if (m.method === 'session/new') { sessions.push(m.params.cwd); emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's-1' } }); }
        if (m.method === 'session/prompt') {
          emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"outcome":"done","report":"ok"}' } } } });
          emit({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
        }
      }
    });
    return child;
  };
}
function fakeCodex(starts, launches = []) {
  return (command, args, options) => {
    launches.push(options);
    const child = new EventEmitter();
    for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
    const send = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    child.kill = () => { child.stdout.end(); child.stderr.end(); };
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ id: m.id, result: {} });
        if (m.method === 'thread/start') { starts.push(m.params.cwd); send({ id: m.id, result: { thread: { id: 'thread' } } }); }
        if (m.method === 'turn/start') {
          send({ id: m.id, result: { turn: { id: 'turn' } } });
          send({ id: 17, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'npm test', cwd: options.cwd } });
        }
        if (m.id === 17) send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
      }
    });
    return child;
  };
}
async function pending(root) {
  for (let i = 0; i < 400; i++) {
    const request = (await listApprovals(root)).requests.find((item) => item.status === 'pending');
    if (request) return request;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('approval not received');
}
const bash = (command) => ({ tool_name: 'Bash', input: { command } });
const claudeRequest = (command) => ({ tool: 'claude', details: { tool_name: 'Bash', input: { command } } });


test('registry: the latest line per worktree wins, only active entries under <project>/.wax/worktrees/<id> are accepted, links and other folders are refused', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  const a = await worktree(root, { n: 1 });
  const b = await worktree(root, { goal: OTHER, feature: 'f2', n: 1 });
  assert.deepEqual((await activeWorktrees(root)).map((item) => item.id), [a.id, b.id]);
  assert.deepEqual((await activeWorktrees(root, { goal: GOAL })).map((item) => item.id), [a.id]);
  assert.deepEqual((await activeWorktrees(root, { goal: GOAL, feature: 'f2' })).map((item) => item.id), []);
  await register(root, { id: b.id, goal: OTHER, feature: 'f2', branch: b.branch, path: b.path, state: 'removed' });
  assert.deepEqual((await activeWorktrees(root)).map((item) => item.id), [a.id]);
  assert.equal((await readWorktrees(root)).find((item) => item.id === b.id).state, 'removed');
  const base = { schema: 1, seq: 1, id: `${GOAL}-2`, goal: GOAL, feature: 'f1', branch: `wax/${GOAL}/f1-2`, path: join(real, '.wax', 'worktrees', `${GOAL}-2`), state: 'active', at: new Date().toISOString() };
  assert.equal(validWorktreeRecord(base), true);
  for (const bad of [{ branch: `wax/${OTHER}/f1-2` }, { branch: `wax/${GOAL}/f1-3` }, { id: `${OTHER}-2` }, { path: '.wax/worktrees/x' }, { state: 'open' }, { env: ['secrets.txt'] }, { seq: undefined }]) {
    assert.equal(validWorktreeRecord({ ...base, ...bad }), false, JSON.stringify(bad));
  }
  await mkdir(join(real, 'elsewhere'), { recursive: true });
  assert.equal(await checkWorktree(root, { ...base, path: join(real, 'elsewhere') }), null);
  assert.equal(await checkWorktree(root, { ...base, path: a.path }), null, 'a path that is not .wax/worktrees/<id>');
  const outside = await project(t);
  if (await createTestSymlink(t, outside, join(real, '.wax', 'worktrees', `${GOAL}-2`), 'dir')) {
    assert.equal(await checkWorktree(root, base), null, 'a link out of the project');
  }
  assert.equal((await checkWorktree(root, { ...base, id: a.id, branch: a.branch, path: a.path })).path, a.path);
  assert.deepEqual(await runFolder(root), { root: real, cwd: real, worktree: null });
  assert.equal((await runFolder(root, root)).cwd, real);
  assert.equal((await runFolder(root, a.path)).worktree.id, a.id);
  await mkdir(join(a.path, 'sub'), { recursive: true });
  for (const path of [join(a.path, 'sub'), b.path, join(real, 'elsewhere'), outside, join(real, '.wax'), join(real, '.wax', 'worktrees')]) assert.equal(await runFolder(root, path), null, path);
  assert.equal((await worktreeContaining(root, join(a.path, 'sub'), { feature: 'f1' })).id, a.id);
  assert.equal(await worktreeContaining(root, join(a.path, 'sub'), { feature: 'f2' }), null);
  assert.equal(await worktreeContaining(root, real), null);
});

test('registry: a linked .wax/worktrees folder or a linked list file is not read', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  const away = await project(t);
  await mkdir(join(away, `${GOAL}-1`), { recursive: true });
  await mkdir(join(real, '.wax'), { recursive: true });
  if (!(await createTestSymlink(t, away, join(real, '.wax', 'worktrees'), 'dir'))) return;
  await register(root, { id: `${GOAL}-1`, goal: GOAL, feature: 'f1', branch: `wax/${GOAL}/f1-1`, path: join(real, '.wax', 'worktrees', `${GOAL}-1`) });
  assert.deepEqual(await activeWorktrees(root), [], 'the worktrees folder is a link');
  const other = await repo(t);
  const list = join(away, 'list.jsonl');
  await writeFile(list, `${JSON.stringify({ schema: 1, seq: 1, id: `${GOAL}-1`, goal: GOAL, feature: 'f1', branch: `wax/${GOAL}/f1-1`, path: join(await realpath(other), '.wax', 'worktrees', `${GOAL}-1`), state: 'active', at: new Date().toISOString() })}\n`);
  await mkdir(join(other, '.wax', 'chat'), { recursive: true });
  await mkdir(join(other, '.wax', 'worktrees', `${GOAL}-1`), { recursive: true });
  if (!(await createTestSymlink(t, list, join(other, '.wax', 'chat', 'worktrees.jsonl'), 'file'))) return;
  assert.deepEqual(await readWorktrees(other), [], 'the list file is a link');
});


test('runner: Claude Code starts in the worktree while its approvals stay in the project; without cwd it starts in the project as before', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  const wt = await worktree(root);
  const launches = [];
  const running = runAgentSession(root, { tool: 'claude', executable: 'fake.js', prompt: 'fixture', outputSchema: { type: 'object' }, cwd: wt.path,
    launch: fakeClaude([{ tool_name: 'Write', input: { file_path: join(wt.path, 'a.txt'), content: 'b' } }], launches) });
  const request = await pending(root);
  assert.equal(request.project, real, 'the approval belongs to the project');
  assert.equal(await exists(join(wt.path, '.wax')), false, 'nothing is written in the worktree');
  await decideApproval(root, request.id, { decision: 'deny', fingerprint: request.fingerprint, actor: '사람' });
  const result = await running;
  assert.deepEqual(JSON.parse(JSON.parse(result.message).report), ['deny']);
  assert.equal(launches[0].cwd, wt.path);
  await runAgentSession(root, { tool: 'claude', executable: 'fake.js', prompt: 'fixture', outputSchema: { type: 'object' }, launch: fakeClaude([], launches) });
  assert.equal(launches[1].cwd, real);
  await runAgentSession(root, { tool: 'claude', executable: 'fake.js', prompt: 'fixture', outputSchema: { type: 'object' }, cwd: root, launch: fakeClaude([], launches) });
  assert.equal(launches[2].cwd, real);
});

test('runner: an unregistered, removed or nested run folder is refused before any tool starts', async (t) => {
  const root = await repo(t);
  const wt = await worktree(root);
  const gone = await worktree(root, { n: 2 });
  await register(root, { id: gone.id, goal: GOAL, feature: 'f1', branch: gone.branch, path: gone.path, state: 'removed' });
  await mkdir(join(wt.path, 'sub'), { recursive: true });
  const outside = await project(t);
  const launches = [];
  for (const cwd of [outside, gone.path, join(wt.path, 'sub'), join(root, 'missing')]) {
    for (const tool of ['claude', 'gemini']) {
      await assert.rejects(runAgentSession(root, { tool, executable: 'fake.js', prompt: 'fixture', outputSchema: { type: 'object' }, cwd, launch: fakeClaude([], launches) }), /실행 폴더/, `${tool} ${cwd}`);
    }
    await assert.rejects(runCodexSession(root, { prompt: 'fixture', executable: 'fake.js', cwd, launch: fakeCodex([], launches), output() {}, log() {} }), /실행 폴더/);
  }
  assert.equal(launches.length, 0);
});

test('runner: ACP tools open their session in the worktree and Codex starts its thread there; approvals stay in the project', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  const wt = await worktree(root);
  const sessions = [], launches = [];
  await runAgentSession(root, { tool: 'gemini', executable: 'fake.js', prompt: 'fixture', outputSchema: { type: 'object' }, cwd: wt.path, launch: fakeAcp(sessions, launches) });
  await runAgentSession(root, { tool: 'copilot', executable: 'fake.js', prompt: 'fixture', outputSchema: { type: 'object' }, launch: fakeAcp(sessions, launches) });
  assert.deepEqual(sessions, [wt.path, real]);
  assert.deepEqual(launches.map((item) => item.cwd), [wt.path, real]);
  const starts = [], codex = [];
  const running = runCodexSession(root, { prompt: 'fixture', executable: 'fake.js', cwd: wt.path, launch: fakeCodex(starts, codex), output() {}, log() {} });
  const request = await pending(root);
  assert.equal(request.project, real);
  assert.equal(request.details.cwd, wt.path);
  await decideApproval(root, request.id, { decision: 'deny', fingerprint: request.fingerprint, actor: '사람' });
  await running;
  assert.deepEqual([starts, codex.map((item) => item.cwd)], [[wt.path], [wt.path]]);
  await assert.doesNotReject(exists(join(wt.path, '.wax', 'approvals')).then((found) => assert.equal(found, false)));
});


test('wax test --worktree: the command, commit and fingerprint come from the registered worktree, the proof is kept in the project with worktree { id, branch }', async (t) => {
  const root = await repo(t, ['f1', 'f2']);
  const real = await realpath(root);
  const wt = await worktree(root);
  await writeFile(join(wt.path, 'a.txt'), 'changed in the worktree\n');
  commit(wt.path, 'worktree commit');
  await writeFile(join(wt.path, 'wip.txt'), 'uncommitted\n');
  const head = git(wt.path, 'rev-parse', 'HEAD').trim();
  assert.notEqual(head, git(root, 'rev-parse', 'HEAD').trim());
  const before = await gitState(root);
  const { stdout } = await run(process.execPath, [BIN, '--project', root, 'test', 'f1', '--worktree', wt.path, '--', process.execPath, '-e', 'console.log(process.cwd())'], { cwd: wt.path });
  const result = JSON.parse(stdout);
  assert.equal(result.recorded, true);
  const proof = (await getFeature(root, 'f1')).proofs.at(-1);
  assert.equal(proof.id, result.proof.id, 'the proof is stored in the project');
  assert.deepEqual(proof.worktree, { id: wt.id, branch: wt.branch });
  assert.equal(proof.commit, head);
  assert.equal(proof.dirty, true);
  assert.deepEqual(Object.keys(proof.tree.files), ['wip.txt'], 'the fingerprint is the worktree tree');
  assert.equal(await realpath(proof.output.trim()), wt.path, 'the command ran in the worktree');
  assert.equal(await exists(join(wt.path, '.wax')), false, 'nothing is recorded in the worktree');
  assert.deepEqual(await gitState(root), before, 'the project .git (with the worktree index) is not written');
  assert.equal((await evidenceFreshness(root, { ...(await getFeature(root, 'f1')), proofs: [{ ...proof, exitCode: 0, phase: 'implement' }] })).state, 'unchanged');
  await writeFile(join(wt.path, 'more.txt'), 'x\n');
  assert.deepEqual((await evidenceFreshness(root, { ...(await getFeature(root, 'f1')), proofs: [{ ...proof, exitCode: 0, phase: 'implement' }] })).files, ['more.txt']);
  const plain = await runTestProof(root, 'f1', [process.execPath, '-e', 'console.log(process.cwd())']);
  assert.equal(await realpath(plain.proof.output.trim()), real);
  assert.equal(plain.proof.worktree, undefined);
  assert.equal(plain.proof.commit, git(root, 'rev-parse', 'HEAD').trim());
});

test('wax test --worktree: only an active worktree registered to that task is accepted; other folders, tasks, removed entries and other commands are refused', async (t) => {
  const root = await repo(t, ['f1', 'f2']);
  const real = await realpath(root);
  const wt = await worktree(root);
  const other = await worktree(root, { feature: 'f2', n: 2 });
  const gone = await worktree(root, { n: 3 });
  await register(root, { id: gone.id, goal: GOAL, feature: 'f1', branch: gone.branch, path: gone.path, state: 'removed' });
  await mkdir(join(real, '.wax', 'worktrees', 'loose'), { recursive: true });
  await mkdir(join(wt.path, 'sub'), { recursive: true });
  const command = [process.execPath, '-e', '0'];
  for (const path of [other.path, gone.path, join(real, '.wax', 'worktrees', 'loose'), join(wt.path, 'sub'), real, await project(t)]) {
    await assert.rejects(runTestProof(root, 'f1', command, { worktree: path }), /--worktree/, path);
  }
  assert.equal((await getFeature(root, 'f1')).proofs?.length ?? 0, 0, 'no proof was recorded');
  assert.equal((await runTestProof(root, 'f1', command, { worktree: wt.path })).proof.worktree.id, wt.id);
  const refused = await run(process.execPath, [BIN, '--project', root, 'status', 'f1', '--worktree', wt.path]).then(() => null, (error) => error);
  assert.match(refused.stderr, /--worktree는 test 명령에서만/);
});


test('stage history: completing or iterating from a registered worktree records that worktree\'s head and dirty state; from the project or another task\'s worktree it records the project', async (t) => {
  const root = await repo(t, ['f1', 'f2']);
  const wt = await worktree(root);
  const other = await worktree(root, { feature: 'f2', n: 2 });
  await writeFile(join(wt.path, 'a.txt'), 'worktree\n');
  commit(wt.path, 'worktree commit');
  const worktreeHead = git(wt.path, 'rev-parse', 'HEAD').trim(), projectHead = git(root, 'rev-parse', 'HEAD').trim();
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  await writeFile(join(root, '.wax', 'tmp', 'plan.md'), '# plan\n\n- AC-1: 된다');
  const cli = (cwd, ...args) => run(process.execPath, [BIN, '--project', root, ...args], { cwd });
  await cli(wt.path, 'save', 'plan', 'f1', '--file', join(root, '.wax', 'tmp', 'plan.md'));
  await cli(join(wt.path), 'complete', 'plan', 'f1', '--evidence', '워크트리에서 완료', '--author', 'wax-worker-claude');
  const done = (await getFeature(root, 'f1')).history.at(-1);
  assert.deepEqual([done.action, done.head, done.dirty, done.worktree], ['complete', worktreeHead, false, { id: wt.id, branch: wt.branch }]);
  await cli(root, 'save', 'plan', 'f2', '--file', join(root, '.wax', 'tmp', 'plan.md'));
  await cli(root, 'complete', 'plan', 'f2', '--evidence', '프로젝트에서 완료');
  const plain = (await getFeature(root, 'f2')).history.at(-1);
  assert.deepEqual([plain.head, plain.worktree], [projectHead, undefined]);
  await updateFeature(root, 'f1', 'save', { phase: 'design', content: '# design' });
  await updateFeature(root, 'f1', 'complete', { phase: 'design', evidence: '다른 작업 폴더', runFolder: other.path });
  const foreign = (await getFeature(root, 'f1')).history.at(-1);
  assert.deepEqual([foreign.head, foreign.worktree], [projectHead, undefined]);
  await updateFeature(root, 'f1', 'save', { phase: 'implement', content: '# implement' });
  const proof = (await runTestProof(root, 'f1', [process.execPath, '-e', '0'], { worktree: wt.path })).proof;
  await writeFile(join(wt.path, 'wip.txt'), 'dirty\n');
  await mkdir(join(wt.path, 'sub'), { recursive: true });
  await updateFeature(root, 'f1', 'complete', { phase: 'implement', evidence: '워크트리 근거', proofIds: [proof.id], runFolder: join(wt.path, 'sub') });
  const implemented = (await getFeature(root, 'f1')).history.at(-1);
  assert.deepEqual([implemented.head, implemented.dirty, implemented.worktree?.id], [worktreeHead, true, wt.id]);
  await updateFeature(root, 'f1', 'iterate', { reason: '다시', runFolder: wt.path });
  const back = (await getFeature(root, 'f1')).history.at(-1);
  assert.deepEqual([back.action, back.head, back.dirty, back.worktree], ['iterate', worktreeHead, true, { id: wt.id, branch: wt.branch }]);
  await register(root, { id: wt.id, goal: GOAL, feature: 'f1', branch: wt.branch, path: wt.path, state: 'removed' });
  await updateFeature(root, 'f1', 'save', { phase: 'implement', content: '# again' });
  const again = (await runTestProof(root, 'f1', [process.execPath, '-e', '0'])).proof;
  await updateFeature(root, 'f1', 'complete', { phase: 'implement', evidence: '지운 워크트리', proofIds: [again.id], runFolder: wt.path });
  assert.deepEqual([(await getFeature(root, 'f1')).history.at(-1).worktree, (await getFeature(root, 'f1')).history.at(-1).head], [undefined, projectHead]);
});


test('goal allow: --project matches only this project and --worktree only a worktree registered to this goal and task; everything else is still refused', async (t) => {
  const root = await repo(t, ['f1']);
  const real = await realpath(root);
  await mkdir(join(real, '.wax', 'tmp'), { recursive: true });
  const mine = await worktree(root);
  const otherGoal = await worktree(root, { goal: OTHER, n: 1 });
  const otherTask = await worktree(root, { feature: 'f2', n: 2 });
  const gone = await worktree(root, { n: 3 });
  await register(root, { id: gone.id, goal: GOAL, feature: 'f1', branch: gone.branch, path: gone.path, state: 'removed' });
  await mkdir(join(real, '.wax', 'worktrees', 'loose'), { recursive: true });
  await mkdir(join(real, 'src'), { recursive: true });
  const otherProject = await realpath(await repo(t, ['f1']));
  const worktrees = (await activeWorktrees(root, { goal: GOAL, feature: 'f1' })).map((item) => item.path);
  assert.deepEqual(worktrees, [mine.path]);
  const ctx = { root, cli: CLI, feature: 'f1', phase: 'implement', author: 'wax-worker-claude', test: 'node --test', worktrees };
  const check = (command, kinds = ['wax', 'test'], extra = {}) => matchAllow(claudeRequest(command), kinds, { ...ctx, ...extra });
  const q = JSON.stringify;
  for (const command of [
    `node ${q(CLI)} --project ${q(real)} status f1`,
    `node ${q(CLI)} status f1 --project ${q(real)}`,
    `node ${q(CLI)} --project ${q(root)} save implement f1 --file .wax/tmp/x.md`,
    `node ${q(CLI)} save implement f1 --file ${q(shellPath(join(real, '.wax/tmp/x.md')))} --project ${q(real)}`,
    `node ${q(CLI)} --project ${q(real)} complete implement f1 --author wax-worker-claude --evidence "ok"`,
    `node ${q(CLI)} --project ${q(shellPath(root))} status f1`,
    `node ${q(CLI)} --project ${q(shellPath(real))} status f1`,
    `node ${q(CLI)} --project '${real}' status f1`,
  ]) assert.equal(await check(command), 'wax', command);
  for (const command of [
    `node ${q(CLI)} --project ${q(real)} test f1 -- node --test`,
    `node ${q(CLI)} test f1 --project ${q(real)} --worktree ${q(mine.path)} -- node --test`,
    `node ${q(CLI)} --project ${q(real)} test f1 --worktree ${q(mine.path)} --revision 3 --author wax-worker-claude -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(mine.path)} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(shellPath(mine.path))} -- node --test`,
    `node ${q(CLI)} --project '${real}' test f1 --worktree '${mine.path}' -- node --test`,
  ]) assert.equal(await check(command), 'test', command);
  for (const command of [
    `node ${q(CLI)} --project ${q(otherProject)} status f1`,
    `node ${q(CLI)} --project . status f1`,
    `node ${q(CLI)} --project ${q(join(real, 'src'))} status f1`,
    `node ${q(CLI)} --project ${q(mine.path)} status f1`,
    `node ${q(CLI)} --project ${q(real)} status f1 --project ${q(real)}`,
    `node ${q(CLI)} --project=${real} status f1`,
    `node ${q(CLI)} status f1 --worktree ${q(mine.path)}`,
    `node ${q(CLI)} --project ${q(otherProject)} test f1 -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(otherGoal.path)} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(otherTask.path)} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(gone.path)} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(join(real, '.wax', 'worktrees', 'loose'))} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(join(mine.path, '.'))}/src -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(real)} -- node --test`,
    `node ${q(CLI)} test f1 --worktree .wax/worktrees/${mine.id} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(mine.path)} --worktree ${q(mine.path)} -- node --test`,
    `node ${q(CLI)} test f1 --worktree ${q(mine.path)} -- node --test --watch`,
  ]) assert.equal(await check(command), null, command);
  assert.equal(await check(`node ${q(CLI)} test f1 --worktree ${q(mine.path)} -- node --test`, ['test'], { worktrees: [] }), null);
  await mkdir(join(mine.path, '.wax', 'tmp'), { recursive: true });
  assert.equal(await check(`node ${q(CLI)} --project ${q(real)} save implement f1 --file .wax/tmp/x.md`, ['wax'], { cwd: mine.path }), null);
  assert.equal(await check(`node ${q(CLI)} --project ${q(real)} save implement f1 --file ${q(shellPath(join(real, '.wax/tmp/x.md')))}`, ['wax'], { cwd: mine.path }), 'wax');
  const write = (path, extra = {}) => matchAllow({ tool: 'claude', details: { tool_name: 'Write', input: { file_path: path } } }, ['write'], { ...ctx, ...extra });
  assert.equal(await write(join(real, '.wax/tmp/x.md'), { cwd: mine.path }), 'write');
  assert.equal(await write(join(mine.path, '.wax/tmp/x.md'), { cwd: mine.path }), null);
  assert.equal(await write(join(mine.path, 'a.txt'), { cwd: mine.path }), null);
  const codex = (cwd) => matchAllow({ tool: 'codex', method: 'item/commandExecution/requestApproval', details: { command: `node ${q(CLI)} --project ${q(real)} status f1`, cwd } }, ['wax'], ctx);
  assert.equal(await codex(real), 'wax');
  assert.equal(await codex(mine.path), null);
  const doc = await judgeRequest({ tool: 'claude', details: { tool_name: 'Write', input: { file_path: join(mine.path, 'src', 'a.js') } } }, { kinds: [], ...ctx, phase: 'plan', cwd: mine.path });
  assert.deepEqual(doc.outOfStage, { phase: 'plan', paths: [`.wax/worktrees/${mine.id}/src/a.js`] });
  const docOk = await judgeRequest({ tool: 'claude', details: { tool_name: 'Write', input: { file_path: join(mine.path, 'docs', 'wax', 'a.md') } } }, { kinds: [], ...ctx, phase: 'plan', cwd: mine.path });
  assert.equal(docOk?.outOfStage, undefined);
});


test('snapshots: a run in a registered worktree is captured, diffed and restored inside that worktree only; the project tree and .git stay as they are', async (t) => {
  const root = await repo(t, ['f1']);
  const wt = await worktree(root);
  await writeFile(join(root, 'project-only.txt'), 'project\n');
  const meta = { run: 'pw-0000000a', goal: GOAL, worker: 'pw-0000000a', feature: 'f1', phase: 'implement', iteration: 0, tool: 'claude', worktree: wt.id };
  const gitBefore = await gitState(root);
  const before = await takeSnapshot(root, { ...meta, point: 'before' });
  await writeFile(join(wt.path, 'a.txt'), 'worker\n');
  await writeFile(join(wt.path, 'new.txt'), 'new\n');
  await writeFile(join(root, 'a.txt'), 'person in the project\n');
  const after = await takeSnapshot(root, { ...meta, point: 'after' });
  assert.deepEqual([before.state, before.worktree, Object.keys(before.files)], ['ok', wt.id, []], 'the project-only file is not in the worktree snapshot');
  assert.deepEqual(Object.keys(after.files).sort(), ['a.txt', 'new.txt']);
  const [item] = await listRuns(root);
  assert.equal(item.worktree, wt.id);
  const summary = await runSummary(root, item, { runs: [item] });
  assert.deepEqual(summary.files.map((file) => [file.path, file.state]), [['a.txt', 'modify'], ['new.txt', 'new']]);
  const preview = await previewRestore(root, 'pw-0000000a');
  assert.deepEqual(preview.restore.map((entry) => [entry.path, entry.action]), [['a.txt', 'write'], ['new.txt', 'delete']]);
  const result = await restoreSnapshot(root, 'pw-0000000a', { by: '대표', fingerprint: preview.fingerprint });
  assert.deepEqual(result.restored.sort(), ['a.txt', 'new.txt']);
  assert.equal(await readFile(join(wt.path, 'a.txt'), 'utf8'), 'a\n', 'restored in the worktree');
  assert.equal(await exists(join(wt.path, 'new.txt')), false);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'person in the project\n', 'the project file is not touched');
  assert.equal(await readFile(join(root, 'project-only.txt'), 'utf8'), 'project\n');
  const restoreSnaps = (await readSnapshots(root)).filter((snap) => snap.run === result.restoreRun);
  assert.deepEqual(restoreSnaps.map((snap) => [snap.point, snap.worktree]), [['pre-restore', wt.id], ['post-restore', wt.id]]);
  assert.deepEqual(await gitState(root), gitBefore, 'the project .git is not written');
  const runs = await listRuns(root);
  assert.equal(concurrentRuns(runs[0], [...runs, { ...runs[0], run: 'pw-0000000b', worktree: null }]), 0);
  assert.equal(concurrentRuns(runs[0], [...runs, { ...runs[0], run: 'pw-0000000b' }]), 1);
  await register(root, { id: wt.id, goal: GOAL, feature: 'f1', branch: wt.branch, path: wt.path, state: 'removed' });
  await assert.rejects(previewRestore(root, 'pw-0000000a'), { status: 409 });
  const missing = await takeSnapshot(root, { ...meta, run: 'pw-0000000c', point: 'before' });
  assert.deepEqual([missing.state, missing.reason], ['unknown', 'worktree-missing']);
  assert.equal(await takeSnapshot(root, { ...meta, run: 'pw-0000000d', point: 'before', worktree: '../x' }), null, 'a malformed worktree ID is not recorded');
});


test('engine: a worker spec with a registered worktree runs the tool there, tells the worker --project and --worktree, auto-allows exactly those forms and snapshots the worktree', async (t) => {
  const root = await repo(t, ['f1', 'f2']);
  const real = await realpath(root);
  await setPm(root, { author: '대표', kind: 'human' });
  const prompts = [], launches = [], reports = [];
  let wt = null;
  const execute = async (dir, input) => {
    prompts.push(input.prompt);
    const author = input.prompt.match(/작업자 이름: ([^.]+)\./)[1];
    const requests = [
      bash(`node ${JSON.stringify(CLI)} --project ${JSON.stringify(root)} test f1 --worktree ${JSON.stringify(wt.path)} -- node --test`),
      bash(`node ${JSON.stringify(CLI)} --project ${JSON.stringify(shellPath(root))} status f1`),
      bash(`node ${JSON.stringify(CLI)} --project ${JSON.stringify(root)} complete plan f1 --author ${author} --evidence "ok"`),
    ];
    const result = await runAgentSession(dir, { ...input, executable: 'fake.js', launch: fakeClaude(requests, launches) });
    await writeFile(join(wt.path, 'worker.txt'), 'by the worker\n');
    reports.push(JSON.parse(JSON.parse(result.message).report));
    return result;
  };
  const listTools = async () => [{ id: 'claude', installed: true, approval: 'dashboard' }];
  const engine = createPmLoop({ root, execute, listTools, user: '대표', intervalMs: 10_000 });
  t.after(() => engine.close());
  const goal = await createGoal(root, { title: '워크트리', features: ['f1'] }, { author: '대표' });
  wt = await worktree(root, { goal: goal.id });
  await engine.allow.set(goal.id, { kinds: ['wax', 'test'], test: 'node --test' }, '대표');
  await executeSuggestion(root, goal.id, 'goal:confirm-plan', { author: '대표' });
  const card = (await goalOverview(root, goal.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  const workers = { ...engine.workers, run: (spec) => engine.workers.run({ ...spec, worktree: wt.id }) };
  await executeSuggestion(root, goal.id, card.key, { author: '대표', tools: await engine.tools(), workers });
  await engine.workers.settled();
  assert.equal(launches[0].cwd, wt.path, 'the tool started in the worktree');
  assert.deepEqual(reports[0], ['allow', 'allow', 'allow'], 'the --project and --worktree forms matched without a person');
  assert.deepEqual((await listApprovals(root)).requests.map((item) => [item.project, item.allowKind]).sort(), [[real, 'test'], [real, 'wax'], [real, 'wax']]);
  assert.ok(prompts[0].includes(`--worktree ${JSON.stringify(shellPath(wt.path))}`));
  assert.ok(prompts[0].includes(`CLI는 늘 --project ${JSON.stringify(shellPath(root))}를 붙여 부르세요`));
  assert.ok(prompts[0].includes(`--file ${shellPath(real)}/.wax/tmp/<문서>`), 'stage documents go to the project .wax/tmp by absolute path');
  const snaps = await readSnapshots(root);
  assert.deepEqual(snaps.map((snap) => [snap.point, snap.worktree, snap.state]), [['before', wt.id, 'ok'], ['after', wt.id, 'ok']]);
  assert.deepEqual(Object.keys(snaps[1].files), ['worker.txt']);
  const second = await createGoal(root, { title: '지운 워크트리', features: ['f2'] }, { author: '대표' });
  const removed = await worktree(root, { goal: second.id, feature: 'f2' });
  await register(root, { id: removed.id, goal: second.id, feature: 'f2', branch: removed.branch, path: removed.path, state: 'removed' });
  await executeSuggestion(root, second.id, 'goal:confirm-plan', { author: '대표' });
  const card2 = (await goalOverview(root, second.id, { user: '대표', tools: await engine.tools() })).suggestions.find((item) => item.kind === 'start-worker');
  const workers2 = { ...engine.workers, run: (spec) => engine.workers.run({ ...spec, worktree: removed.id }) };
  await executeSuggestion(root, second.id, card2.key, { author: '대표', tools: await engine.tools(), workers: workers2 });
  await engine.workers.settled();
  assert.equal(launches.length, 1, 'no tool was started for a removed worktree');
  const end = (await readDecisions(root, second.id)).filter((item) => item.kind === 'worker' && item.outcome === 'failed').at(-1);
  assert.match(end.reason, /워크트리/);
});

test('worker prompt: without a worktree it only adds --project; with one it names the worktree, --worktree and the project .wax/tmp by absolute path', async (t) => {
  const root = await project(t, ['f1']);
  const goal = { title: '목표' };
  const feature = { id: 'f1', title: 'f1', description: '', phase: 'implement', iteration: 0, artifacts: {}, completed: {}, proofs: [] };
  const allow = { on: true, kinds: ['wax', 'test', 'write'], test: 'node --test' };
  const base = { root, goal, feature, task: { id: 'task-1', phase: 'implement', note: '' }, author: 'wax-worker-claude', allow };
  const plain = workerPrompt(base);
  assert.ok(plain.includes(`CLI는 늘 --project ${JSON.stringify(shellPath(root))}를 붙여 부르세요`));
  assert.ok(plain.includes(`save implement f1 --file .wax/tmp/<문서>`));
  assert.doesNotMatch(plain.replace(RULING_NOT_ALONE[0], ''), /워크트리|--worktree/);
  const path = join(root, '.wax', 'worktrees', `${GOAL}-1`);
  const inTree = workerPrompt({ ...base, worktree: { id: `${GOAL}-1`, branch: `wax/${GOAL}/f1-1`, path } });
  assert.ok(inTree.includes(`등록된 워크트리 ${JSON.stringify(shellPath(path))}(브랜치 wax/${GOAL}/f1-1)`));
  assert.ok(inTree.includes(`test f1 --worktree ${JSON.stringify(shellPath(path))} [--revision <n>]`));
  assert.ok(inTree.includes(`--file ${shellPath(root)}/.wax/tmp/<문서>`));
  assert.match(inTree, /이미 워크트리 폴더에서 돕니다/);
});
