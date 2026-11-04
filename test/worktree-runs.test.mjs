import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, project } from './chat-helpers.mjs';
import { activeWorktrees } from '../src/worktrees.mjs';
import { getFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { takeSnapshot } from '../src/snapshots.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { chatDir } from '../src/chat/paths.mjs';
import { appendRecord, makeId } from '../src/chat/store.mjs';
import { judgeRequest, literalFolder, matchAllow } from '../src/goal-allow.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const GOAL = 'goal-0000000a', OTHER = 'goal-0000000b';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const head = (root) => git(root, 'rev-parse', 'HEAD').trim();

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
  const record = { schema: 1, seq: ++seq, base: null, port: null, env: [], setup: null, state: 'active', at: new Date().toISOString(), by: 'pm-loop', ...entry };
  await appendFile(join(root, '.wax', 'chat', 'worktrees.jsonl'), `${JSON.stringify(record)}\n`);
  return record;
}
async function worktree(root, { goal = GOAL, feature = 'f1', n = 1, state = 'active', base = 'HEAD' } = {}) {
  const real = await realpath(root);
  const id = `${goal}-${n}`, branch = `wax/${goal}/${feature}-${n}`, path = join(real, '.wax', 'worktrees', id);
  git(root, 'worktree', 'add', '-q', '-b', branch, path, base);
  const record = await register(root, { id, goal, feature, branch, path, state, base: git(root, 'rev-parse', base).trim() });
  return { id, branch, path, goal, feature, base: record.base };
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
async function stage(root, id, phase, extra = {}) {
  await updateFeature(root, id, 'save', { phase, content: phase === 'plan' ? '- AC-1: 된다 — 테스트' : `# ${phase}` });
  return updateFeature(root, id, 'complete', { phase, evidence: '확인', ...extra });
}


test('run trace: a visit completed in a registered worktree diffs that worktree\'s commits, and an open visit there diffs up to the worktree HEAD; project .git is not written', async (t) => {
  const root = await repo(t, ['f1']);
  await stage(root, 'f1', 'plan');
  const p0 = head(root);
  const wt = await worktree(root);
  await writeFile(join(root, 'main.txt'), 'person\n'); commit(root, 'person on main');
  await stage(root, 'f1', 'design');
  await mkdir(join(wt.path, 'src'), { recursive: true });
  await writeFile(join(wt.path, 'src', 'x.js'), 'one\ntwo\n'); commit(wt.path, 'worker');
  const w1 = head(wt.path);
  const { proof } = await runTestProof(root, 'f1', [process.execPath, '-e', '0'], { worktree: wt.path });
  await updateFeature(root, 'f1', 'save', { phase: 'implement', content: '# implement' });
  await updateFeature(root, 'f1', 'complete', { phase: 'implement', evidence: '워크트리', proofIds: [proof.id], runFolder: wt.path });
  await writeFile(join(wt.path, 'src', 'y.js'), 'y\n'); commit(wt.path, 'reviewer');
  const w2 = head(wt.path), p1 = head(root);
  const before = await gitState(root);

  const trace = await buildRunTrace(root, 'f1', { language: 'en' });
  const [, design, implement, review] = trace.visits;
  assert.deepEqual(design.files.files, [{ path: 'main.txt', added: 1, deleted: 0 }]);
  assert.equal(design.worktree, null);
  assert.deepEqual(implement.worktree, { id: wt.id, branch: wt.branch });
  assert.deepEqual([implement.files.from, implement.files.to, implement.files.files], [p0, w1, [{ path: 'src/x.js', added: 2, deleted: 0 }]]);
  assert.notEqual(p0, p1);
  assert.equal(review.open, true);
  assert.deepEqual(review.worktree, { id: wt.id, branch: wt.branch });
  assert.deepEqual([review.files.from, review.files.to, review.files.live, review.files.files], [w1, w2, true, [{ path: 'src/y.js', added: 1, deleted: 0 }]]);
  assert.match(trace.markdown, new RegExp(`worktree branch \`${wt.branch.replaceAll('/', '\\/')}\``));
  assert.deepEqual(await gitState(root), before);

  await register(root, { id: wt.id, goal: GOAL, feature: 'f1', branch: wt.branch, path: wt.path, base: wt.base, state: 'removed' });
  const later = (await buildRunTrace(root, 'f1', { language: 'en' })).visits;
  assert.deepEqual([later[3].files.unknown, later[3].files.to], [true, null]);
  assert.deepEqual(later[2].files.files, [{ path: 'src/x.js', added: 2, deleted: 0 }]);
});

test('run trace: an open visit whose worker runs in a worktree (from its snapshot) diffs that worktree from the run\'s before HEAD', async (t) => {
  const root = await repo(t, ['f1']);
  await setPm(root, { author: '대표', kind: 'human' });
  const goal = await createGoal(root, { title: '워크트리', features: ['f1'] }, { author: '대표' });
  for (const phase of ['plan', 'design']) await stage(root, 'f1', phase);
  const real = await realpath(root);
  const wt = await worktree(root, { goal: goal.id });
  await writeFile(join(root, 'main.txt'), 'person\n'); commit(root, 'person on main');
  const log = join(await chatDir(root, 'pm-loop'), `${goal.id}.jsonl`);
  await appendRecord(log, (n) => ({ schema: 1, record: 'decision', id: makeId('pd', n), seq: n, goal: goal.id, kind: 'worker', outcome: 'launched', worker: 'pw-0000000a', tool: 'codex', feature: 'f1', phase: 'implement', iteration: 0, at: new Date().toISOString() }));
  await takeSnapshot(root, { run: 'pw-0000000a', point: 'before', goal: goal.id, worker: 'pw-0000000a', feature: 'f1', phase: 'implement', iteration: 0, tool: 'codex', worktree: wt.id });
  const start = head(wt.path);
  await writeFile(join(wt.path, 'w.txt'), 'w\n'); commit(wt.path, 'worker');
  const trace = await buildRunTrace(real, 'f1', { language: 'en' });
  const implement = trace.visits.at(-1);
  assert.deepEqual([implement.phase, implement.open], ['implement', true]);
  assert.deepEqual(implement.worktree, { id: wt.id, branch: wt.branch });
  assert.deepEqual([implement.files.from, implement.files.to, implement.files.files], [start, head(wt.path), [{ path: 'w.txt', added: 1, deleted: 0 }]]);
});


function server(t, root, cwd) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--project', root], { cwd, env: { ...process.env, WAX_MCP: 'on', WAX_LANG: 'en', WAX_REVIEW_SEPARATION: '', WAX_TASK_DONE_CHECK: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buffer = '';
  child.stderr.resume();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
      const message = JSON.parse(buffer.slice(0, end));
      waiting.get(JSON.stringify(message.id))?.(message);
    }
  });
  const exited = new Promise((done) => child.on('close', done));
  t.after(() => { child.kill(); return exited; });
  let next = 1;
  const rpc = (method, params) => { const id = next++; const answer = new Promise((done) => waiting.set(JSON.stringify(id), done)); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return answer; };
  return { initialize: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } }), call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result };
}

test('MCP wax_complete: from a worker in a registered worktree it records that worktree\'s head; from the project or another task\'s worktree it records the project; records stay in the project', async (t) => {
  const root = await repo(t, ['f1', 'f2']);
  const wt = await worktree(root);
  const other = await worktree(root, { feature: 'f2', n: 2 });
  await writeFile(join(wt.path, 'a.txt'), 'worktree\n'); commit(wt.path, 'worktree commit');
  const worktreeHead = head(wt.path), projectHead = head(root);
  await mkdir(join(wt.path, 'sub'), { recursive: true });
  const s = server(t, root, join(wt.path, 'sub'));
  await s.initialize();
  await s.call('wax_join', { name: 'codex-작업자' });
  await updateFeature(root, 'f1', 'save', { phase: 'plan', content: '- AC-1: 된다' });
  const done = await s.call('wax_complete', { id: 'f1', phase: 'plan', evidence: '워크트리에서 완료' });
  assert.equal(done.isError, false, done.content[0].text);
  const last = (await getFeature(root, 'f1')).history.at(-1);
  assert.deepEqual([last.action, last.head, last.via, last.worktree], ['complete', worktreeHead, 'mcp', { id: wt.id, branch: wt.branch }]);
  await updateFeature(root, 'f2', 'save', { phase: 'plan', content: '- AC-1: 된다' });
  await s.call('wax_complete', { id: 'f2', phase: 'plan', evidence: '다른 작업' });
  const foreign = (await getFeature(root, 'f2')).history.at(-1);
  assert.deepEqual([foreign.head, foreign.worktree], [projectHead, undefined]);
  const p = server(t, root, root);
  await p.initialize();
  await p.call('wax_join', { name: 'claude-작업자' });
  await updateFeature(root, 'f1', 'save', { phase: 'design', content: '# design' });
  await p.call('wax_complete', { id: 'f1', phase: 'design', evidence: '프로젝트' });
  const plain = (await getFeature(root, 'f1')).history.at(-1);
  assert.deepEqual([plain.head, plain.worktree], [projectHead, undefined]);
  for (const dir of [wt.path, other.path]) await assert.rejects(lstat(join(dir, '.wax')), { code: 'ENOENT' });
});


test('goal allow: a Codex command or file change whose cwd is exactly the worker\'s own active worktree of this goal and task matches; near misses go to a person', async (t) => {
  const root = await repo(t, ['f1']);
  const real = await realpath(root);
  await mkdir(join(real, '.wax', 'tmp'), { recursive: true });
  const mine = await worktree(root);
  const otherGoal = await worktree(root, { goal: OTHER, n: 1 });
  const otherTask = await worktree(root, { feature: 'f2', n: 2 });
  const gone = await worktree(root, { n: 3 });
  await register(root, { id: gone.id, goal: GOAL, feature: 'f1', branch: gone.branch, path: gone.path, state: 'removed' });
  const imported = await worktree(root, { n: 4 });
  await register(root, { id: imported.id, goal: GOAL, feature: 'f1', branch: imported.branch, path: imported.path, state: 'imported' });
  const discarded = await worktree(root, { n: 5 });
  await register(root, { id: discarded.id, goal: GOAL, feature: 'f1', branch: discarded.branch, path: discarded.path, state: 'discarded' });
  await mkdir(join(mine.path, 'src'), { recursive: true });
  const link = `${real}-wt-link`;
  const linked = await symlink(mine.path, link, process.platform === 'win32' ? 'junction' : 'dir').then(() => true, () => false);
  if (linked) t.after(() => rm(link, { force: true }));
  await mkdir(join(real, '.wax', 'worktrees', 'loose'), { recursive: true });
  const worktrees = (await activeWorktrees(root, { goal: GOAL, feature: 'f1' })).map((item) => item.path);
  assert.deepEqual(worktrees, [mine.path]);
  const q = JSON.stringify;
  const command = `node ${q(CLI)} --project ${q(real)} status f1`;
  const ctx = { root, cli: CLI, feature: 'f1', phase: 'implement', author: 'wax-worker-codex', test: 'node --test', worktrees, cwd: mine.path };
  const relativeMine = relative(real, mine.path);
  assert.equal(isAbsolute(relativeMine), false, relativeMine);
  const codex = (cwd, extra = {}, line = command) => matchAllow({ tool: 'codex', method: 'item/commandExecution/requestApproval', details: { command: line, cwd } }, ['wax', 'test'], { ...ctx, ...extra });
  assert.equal(await codex(real), 'wax');
  assert.equal(await codex(mine.path), 'wax');
  assert.equal(await codex(`${mine.path}/`), 'wax');
  assert.equal(await codex(mine.path, {}, `node ${q(CLI)} test f1 --project ${q(real)} --worktree ${q(mine.path)} -- node --test`), 'test');
  assert.equal(await codex(mine.path, { platform: 'win32' }), 'wax');
  for (const [cwd, extra] of [
    [otherGoal.path], [otherTask.path], [gone.path], [imported.path], [discarded.path], [join(mine.path, 'src')], ...(linked ? [[link]] : []), [join(real, '.wax', 'worktrees', 'loose')],
    [dirname(real)], [join(real, '.wax')], [join(real, '.wax', 'worktrees')], [relativeMine],
    [mine.path, { cwd: undefined }], [mine.path, { worktrees: [] }], [mine.path, { cwd: otherTask.path, worktrees: [mine.path, otherTask.path] }],
    [otherTask.path, { cwd: otherTask.path }],
    [otherGoal.path, { platform: 'win32' }], [otherTask.path, { platform: 'win32' }], [mine.path, { platform: 'win32', cwd: otherGoal.path, worktrees: [mine.path, otherGoal.path] }],
  ]) assert.equal(await codex(cwd, extra), null, `${cwd} ${JSON.stringify(extra ?? {})}`);
  for (const line of [`node ${q(CLI)} --project ${q(real)} status f2`, `${command}; rm -rf .`, `node ${q(CLI)} --project ${q(otherGoal.path)} status f1`]) assert.equal(await codex(mine.path, {}, line), null, line);
  assert.equal(await codex(mine.path, {}, `node ${q(CLI)} --project ${q(real)} save implement f1 --file .wax/tmp/x.md`), null);
  assert.equal(await codex(mine.path, {}, `node ${q(CLI)} --project ${q(real)} save implement f1 --file ${q(`${real.replaceAll('\\', '/')}/.wax/tmp/x.md`)}`), 'wax');
  assert.equal(await codex(real, {}, `node ${q(CLI)} --project ${q(real)} save implement f1 --file .wax/tmp/x.md`), 'wax');
  assert.equal(await codex(real, {}, `node ${q(CLI)} --project ${q(real)} save implement f1 --file ../../tmp/x.md`), null);
  const change = (cwd, path, extra = {}) => matchAllow({ tool: 'codex', method: 'item/fileChange/requestApproval', details: { cwd }, item: { changes: { [path]: { type: 'add' } } } }, ['write'], { ...ctx, ...extra });
  assert.equal(await change(mine.path, join(real, '.wax', 'tmp', 'plan.md')), 'write');
  assert.equal(await change(mine.path, '.wax/tmp/plan.md'), null);
  assert.equal(await change(mine.path, join(mine.path, 'src', 'a.js')), null);
  assert.equal(await change(otherTask.path, join(real, '.wax', 'tmp', 'plan.md')), null);
  assert.equal(await change(real, '.wax/tmp/plan.md'), 'write');
  const verdict = await judgeRequest({ tool: 'codex', method: 'item/commandExecution/requestApproval', details: { command, cwd: otherGoal.path } }, { kinds: [], ...ctx });
  assert.equal(verdict?.candidate, undefined);
});

test('literalFolder: the Codex cwd spelling must be the real folder itself; Windows spellings (simulated) compare by shape and case only', () => {
  const wt = 'C:\\Users\\a\\proj\\.wax\\worktrees\\goal-0000000a-1';
  for (const given of [wt, 'C:/Users/a/proj/.wax/worktrees/goal-0000000a-1', 'c:\\users\\a\\proj\\.wax\\worktrees\\GOAL-0000000A-1', `${wt}\\`, `${wt}\\.`, `${wt}\\src\\..`])
    assert.equal(literalFolder(given, wt, 'win32'), true, given);
  for (const given of [`${wt}\\src`, 'C:\\Users\\a\\proj', 'C:\\Users\\a\\proj\\.wax\\worktrees\\goal-0000000a-2', 'C:\\Users\\RUNNER~1\\proj\\.wax\\worktrees\\goal-0000000a-1',
    'D:\\Users\\a\\proj\\.wax\\worktrees\\goal-0000000a-1', '.wax\\worktrees\\goal-0000000a-1', '', null])
    assert.equal(literalFolder(given, wt, 'win32'), false, String(given));
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\wax-x\\.wax\\worktrees\\goal-0000000a-1';
  const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wax-x\\.wax\\worktrees\\goal-0000000a-1';
  assert.equal(literalFolder(long, long, 'win32'), true);
  assert.equal(literalFolder(short, long, 'win32'), false);
  assert.equal(literalFolder(long, short, 'win32'), false);
  assert.equal(literalFolder(long.replace(/^C:/, 'c:'), long, 'win32'), true);
  assert.equal(literalFolder(long, long.replace(/^C:/, 'c:'), 'win32'), true);
  assert.equal(literalFolder(long.replace(/^C:/, 'D:'), long, 'win32'), false);
  const otherGoal = long.replace('goal-0000000a-1', 'goal-0000000b-1');
  assert.equal(literalFolder(otherGoal, long, 'win32'), false);
  assert.equal(literalFolder(otherGoal.toUpperCase(), long, 'win32'), false);
  assert.equal(literalFolder(long, otherGoal, 'win32'), false);
  assert.equal(literalFolder('C:Users\\runneradmin', 'C:\\Users\\runneradmin', 'win32'), false);
  const posix = '/home/a/proj/.wax/worktrees/goal-0000000a-1';
  assert.equal(literalFolder(`${posix}/`, posix, 'linux'), true);
  assert.equal(literalFolder(`${posix}/src/..`, posix, 'darwin'), true);
  for (const given of [posix.toUpperCase(), `${posix}/src`, '/home/a/proj', 'proj/.wax/worktrees/goal-0000000a-1', posix.replace('goal-0000000a-1', 'goal-0000000b-1'), 'C:\\home\\a\\proj']) assert.equal(literalFolder(given, posix, 'linux'), false, given);
  assert.equal(literalFolder(long, long, 'linux'), false);
  assert.equal(literalFolder('proj', 'proj', 'linux'), false);
  assert.equal(literalFolder('proj', 'proj', 'win32'), false);
});
