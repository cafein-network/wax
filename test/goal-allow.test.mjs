import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestSymlink, project } from './chat-helpers.mjs';
import { ALLOW_KINDS, createGoalAllow, judgeRequest, leadingCli, matchAllow, parseAllow, pathSpellings, realTarget, shellWords, unwrapShell } from '../src/goal-allow.mjs';
import { decideApproval, listApprovals } from '../src/approvals.mjs';
import { handleClaudeApproval, handleCodexApproval } from '../src/approval-hosts.mjs';
import { runAgentSession } from '../src/agent-session.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { allowPrompt, lapsedAllow, readDecisions, shellPath, stopGoal } from '../src/chat/pm-loop.mjs';
import { setPm } from '../src/chat/team.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { fillRecipe, validateRecipe } from '../src/recipes.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const AUTHOR = 'wax-worker-claude';
async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(20); }
  throw new Error('test timed out');
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wax-goal-allow-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), outside = join(base, 'outside');
  for (const dir of [join(root, '.wax', 'tmp'), join(root, 'src'), join(root, '.git'), join(root, '.wax', 'chat'), outside]) await mkdir(dir, { recursive: true });
  for (const [file, text] of [['src/a.js', 'x'], ['.env', 'SECRET=1'], ['.env.local', 'SECRET=2'], ['.git/config', '[core]'], ['.wax/chat/x.jsonl', '{}'], ['.wax/tmp/plan.md', '# p']]) await writeFile(join(root, file), text);
  await writeFile(join(outside, 'secret.txt'), 'x');
  for (const [target, path, type] of [
    [outside, join(root, '.wax', 'tmp', 'out'), 'dir'],
    [join(outside, 'new.txt'), join(root, '.wax', 'tmp', 'dangling.md'), 'file'],
    [join(root, '.env'), join(root, 'src', 'env-link'), 'file'],
    [join(outside, 'secret.txt'), join(root, 'src', 'out-link'), 'file'],
  ]) if (!await createTestSymlink(t, target, path, type)) return null;
  return { root, outside, ctx: { root, cli: CLI, feature: 'fix-sum', phase: 'implement', author: AUTHOR, test: 'node --test' } };
}
const bash = (command, extra = {}) => ({ tool: 'claude', details: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command, ...extra } } });
const claudeFile = (tool_name, file_path) => ({ tool: 'claude', details: { subtype: 'can_use_tool', tool_name, input: { file_path, content: 'x' } } });
const codexCommand = (command, cwd, extra = {}) => ({ tool: 'codex', method: 'item/commandExecution/requestApproval', details: { threadId: 'th', turnId: 'tu', itemId: 'i', command, cwd, ...extra } });
const codexFiles = (changes, cwd) => ({ tool: 'codex', method: 'item/fileChange/requestApproval', details: { threadId: 'th', turnId: 'tu', itemId: 'i', cwd }, item: { changes } });

test('leadingCli: a Windows wax CLI path in double, single or no quotes becomes wax; other spellings stay', () => {
  const cli = 'D:\\a\\wax\\wax\\bin\\wax.mjs', doubled = cli.replaceAll('\\', '\\\\'), slash = cli.replaceAll('\\', '/');
  for (const lead of [`node "${cli}"`, `node '${cli}'`, `node ${cli}`, `node "${doubled}"`, `node ${doubled}`, `node '${slash}'`, `node "${slash}"`, `'${cli}'`, `"${cli}"`]) {
    assert.equal(leadingCli(`${lead} status fix-sum`, cli), 'wax status fix-sum', lead);
  }
  for (const command of [`node '${doubled}' status fix-sum`, `node '${cli}x' status fix-sum`, `node "${cli}"status fix-sum`, `echo '${cli}' status`]) {
    assert.equal(leadingCli(command, cli), command, command);
  }
});

test('pathSpellings: only win32 gets backslash spellings of a known path, and only the forms a shell reads back as that path', () => {
  const root = 'C:\\Users\\a\\proj', doubled = 'C:\\\\Users\\\\a\\\\proj', slash = 'C:/Users/a/proj';
  assert.deepEqual(pathSpellings(root, 'win32').sort(), [`"${root}"`, `"${doubled}"`, `"${slash}"`, `'${root}'`, `'${slash}'`, doubled, slash].sort());
  assert.deepEqual(pathSpellings(root, 'linux'), [], 'POSIX paths need no extra spellings (a backslash is a file name character there)');
  assert.deepEqual(pathSpellings(root, 'darwin'), []);
  assert.deepEqual(pathSpellings('C:\\Program Files\\p', 'win32').every((item) => /^["']/.test(item)), true);
  assert.ok(pathSpellings('C:\\Users\\RUNNER~1\\p', 'win32').includes('C:/Users/RUNNER~1/p'));
  assert.ok(!pathSpellings('\\\\server\\share\\p', 'win32').includes('"\\\\server\\share\\p"'));
  assert.ok(pathSpellings('\\\\server\\share\\p', 'win32').includes("'\\\\server\\share\\p'"));
  assert.deepEqual(pathSpellings('C:\\a$b\\p', 'win32').filter((item) => item.startsWith('"') || !/^'/.test(item)), []);
  assert.deepEqual(pathSpellings("C:\\it's\\p", 'win32').filter((item) => item.startsWith("'")), []);
  for (const bad of ['relative\\p', '', null, 'C:\\a\u0000b']) assert.deepEqual(pathSpellings(bad, 'win32'), [], String(bad));
});

test('shellWords with known option paths: an exact spelling right after --project/--worktree is one word; near misses are refused', () => {
  const root = 'C:\\Users\\a\\proj', wt = 'C:\\Users\\a\\proj\\.wax\\worktrees\\goal-0000000a-1';
  const known = { '--project': { spellings: pathSpellings(root, 'win32'), mark: 'P' }, '--worktree': { spellings: pathSpellings(wt, 'win32'), mark: 'W' } };
  const words = (command) => shellWords(command, { known });
  for (const spelling of pathSpellings(root, 'win32')) {
    assert.deepEqual(words(`wax --project ${spelling} status f1`), ['wax', '--project', 'P', 'status', 'f1'], spelling);
    assert.deepEqual(words(`wax status f1 --project ${spelling}`), ['wax', 'status', 'f1', '--project', 'P'], spelling);
  }
  for (const spelling of pathSpellings(wt, 'win32')) assert.deepEqual(words(`wax test f1 --worktree ${spelling}`), ['wax', 'test', 'f1', '--worktree', 'W'], spelling);
  for (const command of [
    'wax --project "C:\\Users\\a\\proj2" status f1',
    'wax --project "C:\\Users\\a" status f1',
    'wax --project "D:\\Users\\a\\proj" status f1',
    'wax --project "c:\\users\\a\\proj" status f1',
    'wax --project "C:\\Users\\a\\proj\\src" status f1',
    'wax --project "C:\\Users\\a\\proj"\\src status f1',
    'wax --project C:\\\\Users\\\\a\\\\proj\\\\src status f1',
    'wax --project C:\\Users\\a\\proj status f1',
    "wax --project 'C:\\\\Users\\\\a\\\\proj' status f1",
    'wax --project "C:\\Users\\a\\proj";id status f1',
    'wax --project "C:\\Users\\a\\proj" status f1; id',
    'wax --project "C:\\Users\\a\\proj" status f1 | id',
    'wax --project "C:\\Users\\a\\proj" status $(id)',
    'wax --file "C:\\Users\\a\\proj" status f1',
    `wax --project "${wt}" status f1`,
    `wax test f1 --worktree "${root}"`,
    'wax --project="C:\\Users\\a\\proj" status f1',
    'wax complete plan f1 --evidence "x --project "C:\\Users\\a\\proj" --no-proof "y"',
  ]) assert.equal(words(command), null, command);
  for (const name of ['constructor', '__proto__', 'toString']) assert.deepEqual(words(`wax ${name} x`), ['wax', name, 'x'], name);
  assert.equal(shellWords('wax --project "C:\\Users\\a\\proj" status f1'), null);
});

test('goal allow on win32 (simulated): --project and --worktree accept the backslash spellings of exactly this project and its registered worktree', { skip: process.platform === 'win32' && 'a backslash cannot be in a Windows file name; run-folder.test.mjs covers real Windows paths' }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'wax-win-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(await realpath(base), 'p\\proj'), wt = join(root, '.wax\\worktrees\\goal-0000000a-1');
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  await mkdir(wt, { recursive: true });
  await mkdir(`${root}2`, { recursive: true });
  const cli = '/x/bin/wax.mjs';
  const ctx = { root, cli, feature: 'f1', phase: 'implement', author: 'wax-worker-claude', test: 'node --test', worktrees: [wt], platform: 'win32' };
  const check = (command, extra = {}) => matchAllow(bash(command), ['wax', 'test'], { ...ctx, ...extra });
  const doubled = (path) => path.replaceAll('\\', '\\\\');
  for (const value of [`"${root}"`, `"${doubled(root)}"`, `'${root}'`, doubled(root)]) {
    assert.equal(await check(`node ${cli} --project ${value} status f1`), 'wax', value);
    assert.equal(await check(`node ${cli} --project ${value} complete implement f1 --author wax-worker-claude --evidence "ok"`), 'wax', value);
    assert.equal(await check(`node ${cli} --project ${value} test f1 --worktree "${doubled(wt)}" -- node --test`), 'test', value);
  }
  for (const value of [`"${wt}"`, `"${doubled(wt)}"`, `'${wt}'`, doubled(wt)]) assert.equal(await check(`node ${cli} test f1 --worktree ${value} -- node --test`), 'test', value);
  for (const command of [
    `node ${cli} --project "${root}2" status f1`,
    `node ${cli} --project "${root}\\src" status f1`,
    `node ${cli} --project "${root}" status f1 --project "${root}"`,
    `node ${cli} --project "${root}" status f2`,
    `node ${cli} --project "${root}" status f1 --worktree "${wt}"`,
    `node ${cli} --project "${wt}" status f1`,
    `node ${cli} test f1 --worktree "${root}" -- node --test`,
    `node ${cli} test f1 --worktree "${wt}\\src" -- node --test`,
    `node ${cli} --project "${root}" complete implement f1 --author wax-worker-claude --evidence "a\\b"`,
    `node ${cli} --project "${root}" save implement f1 --file "${root}\\.wax\\tmp\\x.md"`,
  ]) assert.equal(await check(command), null, command);
  assert.equal(await check(`node ${cli} test f1 --worktree "${wt}" -- node --test`, { worktrees: [] }), null);
  assert.equal(await check(`node ${cli} --project "${root}" status f1`, { platform: 'linux' }), null);
});

test('wax kind: only status/save/complete of the worker\'s own task and phase, with no shell metacharacters and files only under .wax/tmp', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { root, ctx } = fx;
  const ok = async (command) => assert.equal(await matchAllow(bash(command), ['wax'], ctx), 'wax', command);
  const no = async (command) => assert.equal(await matchAllow(bash(command), ['wax'], ctx), null, command);
  await ok(`node "${CLI}" status fix-sum`);
  await ok(`node '${CLI}' status fix-sum`);
  await ok('wax status fix-sum');
  await ok('wax save implement fix-sum --file .wax/tmp/plan.md');
  const absolute = join(root, '.wax/tmp/new-doc.md').replaceAll('\\', '/');
  await ok(`wax save implement fix-sum --file ${absolute} --revision 3`);
  await ok(`wax save implement fix-sum --file "${absolute}" --revision 3`);
  await no(`wax save implement fix-sum --file ${absolute.replaceAll('/', '\\')} --revision 3`);
  await no('wax save implement fix-sum --file .wax\\tmp\\plan.md');
  await ok(`wax complete implement fix-sum --author ${AUTHOR} --evidence "재현 테스트가 고친 뒤 통과" --proofs p-1,p-2`);
  await ok(`wax complete implement fix-sum --author ${AUTHOR} --evidence 'ran it' --checks-file .wax/tmp/checks.json`);
  for (const command of [
    'wax status fix-sum; rm -rf src', 'wax status fix-sum | tee out', 'wax status fix-sum && echo hi', 'wax status fix-sum > .wax/tmp/o', 'wax status fix-sum >> x',
    'wax status $(echo fix-sum)', 'wax status `id`', 'wax status "fix-sum;"', 'wax status fix-sum\nrm x', 'wax status other-task', 'wax status', 'wax status fix-sum extra',
    'wax save plan fix-sum --file .wax/tmp/plan.md',
    'wax save implement other --file .wax/tmp/plan.md',
    'wax save implement fix-sum --file src/a.js',
    'wax save implement fix-sum --file /etc/passwd',
    'wax save implement fix-sum --file .wax/tmp/../../src/a.js',
    'wax save implement fix-sum --file .wax/tmp/out/secret.txt',
    'wax save implement fix-sum --file=.wax/tmp/plan.md',
    'wax save implement fix-sum',
    'wax save implement fix-sum --file .wax/tmp/plan.md --project /elsewhere',
    `wax complete implement fix-sum --author ${AUTHOR} --no-proof "skip"`,
    `wax complete implement fix-sum --author ${AUTHOR} --ac-unverified "skip"`,
    'wax complete implement fix-sum --author 대표 --evidence x',
    'wax complete implement fix-sum --evidence x',
    `wax complete implement fix-sum --author ${AUTHOR} --checks-file /tmp/c.json`,
    'wax test fix-sum -- node --test',
    'wax iterate fix-sum', 'wax archive fix-sum', 'wax doctor',
    `node /elsewhere/wax.mjs status fix-sum`, 'npx wax status fix-sum', 'WAX=1 wax status fix-sum',
  ]) await no(command);
  await no('wax status fix​-sum');
  await no('wax status "fix-sum');
  assert.equal(await matchAllow(bash('wax status fix-sum', { dangerouslyDisableSandbox: true }), ['wax'], ctx), null);
  assert.equal(await matchAllow(bash('wax status fix-sum', { run_in_background: true }), ['wax'], ctx), null);
  assert.equal(await matchAllow(bash('wax status fix-sum'), [], ctx), null, 'no kind on, no match');
});

test('test kind: only wax test <task> -- <the human-typed command>; the bare command is no longer auto-allowed', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { ctx } = fx;
  const check = async (command, expected, extra = ctx) => assert.equal(await matchAllow(bash(command), ['test'], extra), expected, command);
  await check('node --test', null);
  await check('  node --test  ', null);
  await check('node --test ', null);
  await check('node  --test', null);
  await check('node --tests', null);
  await check('node --test test/a.test.mjs', null);
  await check('node --test; rm -rf .', null);
  await check('node --test && curl x', null);
  await check('wax test fix-sum -- node --test', 'test');
  await check('  wax test fix-sum -- node --test  ', 'test');
  await check(`node "${CLI}" test fix-sum --revision 4 --author ${AUTHOR} -- node --test`, 'test');
  await check(`node "${CLI}" test fix-sum --revision 0 -- node --test`, null);
  await check('wax test fix-sum -- node  --test', null);
  await check('wax test other -- node --test', null);
  await check('wax test fix-sum -- node --test2', null);
  await check('wax test fix-sum -- node --test | cat', null);
  await check('wax test fix-sum --author 대표 -- node --test', null);
  await check('wax test fix-sum --project /x -- node --test', null);
  await check('wax test fix-sum -- node --test', null, { ...ctx, test: '' });
  const piped = { ...ctx, test: 'npm run lint && npm test' };
  await check('npm run lint && npm test', null, piped);
  await check('wax test fix-sum -- npm run lint && npm test', null, piped);
  assert.equal(await matchAllow(bash('node --test'), ['wax'], ctx), null, 'the test command is not the wax kind');
});

test('write kind: only files under the project .wax/tmp, after resolving symbolic links', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { root, outside, ctx } = fx;
  const check = async (tool, path, expected) => assert.equal(await matchAllow(claudeFile(tool, path), ['write'], ctx), expected, `${tool} ${path}`);
  await check('Write', '.wax/tmp/new.md', 'write');
  await check('Edit', join(root, '.wax/tmp/plan.md'), 'write');
  await check('MultiEdit', join(root, '.wax/tmp/deep/new/file.md'), 'write');
  await check('Write', 'src/a.js', null);
  await check('Write', join(root, '.wax/tmp'), null);
  await check('Write', '.wax/tmp/../../src/a.js', null);
  await check('Write', '.wax/tmp/out/x.md', null);
  await check('Write', '.wax/tmp/dangling.md', null);
  await check('Write', join(outside, 'x.md'), null);
  await check('Write', '.wax/chat/x.jsonl', null);
  await check('NotebookEdit', '.wax/tmp/x.ipynb', null);
  assert.equal(await matchAllow(claudeFile('Write', '.wax/tmp/new.md'), ['read'], ctx), null, 'reads do not allow writes');
  const other = await fixture(t);
  await rm(join(other.root, '.wax', 'tmp'), { recursive: true });
  if (!await createTestSymlink(t, other.outside, join(other.root, '.wax', 'tmp'), 'dir')) return;
  assert.equal(await matchAllow(claudeFile('Write', '.wax/tmp/x.md'), ['write'], other.ctx), null);
  assert.equal(await matchAllow(codexFiles([{ path: join(root, '.wax/tmp/a.md'), kind: { type: 'add' }, diff: '+a' }], root), ['write'], ctx), 'write');
  assert.equal(await matchAllow(codexFiles({ [join(root, '.wax/tmp/a.md')]: { type: 'update' } }, root), ['write'], ctx), 'write');
  assert.equal(await matchAllow(codexFiles([{ path: join(root, '.wax/tmp/a.md'), kind: { type: 'add' } }, { path: join(root, 'src/a.js'), kind: { type: 'update' } }], root), ['write'], ctx), null);
  assert.equal(await matchAllow(codexFiles([{ path: join(root, '.wax/tmp/plan.md'), kind: { type: 'delete' } }], root), ['write'], ctx), null);
  assert.equal(await matchAllow(codexFiles([{ path: join(root, '.wax/tmp/plan.md'), kind: { type: 'update', move_path: join(root, 'src/b.js') } }], root), ['write'], ctx), null);
  assert.equal(await matchAllow(codexFiles([{ path: join(root, '.wax/tmp/a.md'), kind: { type: 'add' } }], outside), ['write'], ctx), null);
  assert.equal(await realTarget(join(root, '.wax/tmp/dangling.md')), null);
});

test('read kind: project files except .git/, .wax/chat/ and .env*, after resolving symbolic links', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { root, outside, ctx } = fx;
  const check = async (path, expected) => assert.equal(await matchAllow(claudeFile('Read', path), ['read'], ctx), expected, path);
  await check('src/a.js', 'read');
  await check(join(root, '.wax/tmp/plan.md'), 'read');
  for (const path of ['.env', '.env.local', 'src/.env.test', '.git/config', join(root, '.git/HEAD'), '.wax/chat/x.jsonl', 'src/env-link', 'src/out-link', join(outside, 'secret.txt'), '../outside/secret.txt']) await check(path, null);
  assert.equal(await matchAllow(claudeFile('Glob', 'src'), ['read'], ctx), null, 'only Read');
});

test('commands from Codex: one shell wrapper is unwrapped, the working directory must be the project, network requests never match', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { root, outside, ctx } = fx;
  assert.equal(await matchAllow(codexCommand(`/bin/zsh -lc 'node "${CLI}" status fix-sum'`, root), ['wax'], ctx), 'wax');
  assert.equal(await matchAllow(codexCommand("bash -lc 'wax test fix-sum -- node --test'", root), ['test'], ctx), 'test');
  assert.equal(await matchAllow(codexCommand('wax test fix-sum -- node --test', root), ['test'], ctx), 'test');
  assert.equal(await matchAllow(codexCommand("bash -lc 'node --test'", root), ['test'], ctx), null, 'the bare test command goes to a person');
  assert.equal(await matchAllow(codexCommand('node --test', root), ['test'], ctx), null);
  assert.equal(await matchAllow(codexCommand("bash -lc 'wax status fix-sum; id'", root), ['wax'], ctx), null);
  assert.equal(await matchAllow(codexCommand("bash -lc 'wax status fix-sum' && id", root), ['wax'], ctx), null);
  assert.equal(await matchAllow(codexCommand('wax status fix-sum', outside), ['wax'], ctx), null, 'other working directory');
  assert.equal(await matchAllow(codexCommand('wax status fix-sum', undefined), ['wax'], ctx), null, 'no working directory');
  assert.equal(await matchAllow(codexCommand('wax status fix-sum', root, { networkApprovalContext: { host: 'x' } }), ['wax'], ctx), null);
  assert.equal(unwrapShell("sh -c 'a b'"), 'a b');
  assert.equal(unwrapShell('python -c x'), 'python -c x');
  assert.deepEqual(shellWords(`a "b c" 'd' e"f"`), ['a', 'b c', 'd', 'ef']);
  for (const bad of ['a;b', 'a|b', 'a&b', 'a>b', 'a<b', 'a$b', 'a`b`', 'a\\b', 'a*', 'a?', '~/a', 'a #b', "a 'b;c'"]) assert.equal(shellWords(bad), null, bad);
});

test('judgeRequest: a kind that is on allows, a kind that is off is only offered as a candidate; parseAllow is strict', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { ctx } = fx;
  assert.deepEqual(await judgeRequest(bash('wax status fix-sum'), { ...ctx, kinds: ['wax'] }), { allow: 'wax' });
  assert.deepEqual(await judgeRequest(bash('wax status fix-sum'), { ...ctx, kinds: ['write'] }), { candidate: 'wax' });
  assert.deepEqual(await judgeRequest(bash('wax test fix-sum -- node --test'), { ...ctx, kinds: [] }), { candidate: 'test' });
  assert.equal(await judgeRequest(bash('wax test fix-sum -- node --test'), { ...ctx, test: '', kinds: [] }), null, 'no test command, no test candidate');
  assert.equal(await judgeRequest(bash('node --test'), { ...ctx, kinds: [] }), null);
  assert.equal(await judgeRequest(bash('node --test'), { ...ctx, kinds: ['test'] }), null);
  assert.equal(await judgeRequest(bash('rm -rf /'), { ...ctx, kinds: ALLOW_KINDS }), null);
  assert.deepEqual(parseAllow({ kinds: ['write', 'wax'], test: '' }), { kinds: ['wax', 'write'], test: '' });
  assert.deepEqual(parseAllow(undefined), { kinds: [], test: '' });
  for (const bad of [{ kinds: ['shell'] }, { kinds: ['wax', 'wax'] }, { kinds: 'wax' }, { kinds: ['test'] }, { kinds: ['test'], test: '   ' }, { kinds: ['test'], test: 'a\nb' },
    { kinds: ['test'], test: 'x'.repeat(501) }, { kinds: [], pattern: 'rm *' }, ['wax']]) assert.throws(() => parseAllow(bad), (error) => error.status === 400, JSON.stringify(bad));
  for (const test of ['npm run lint && npm test', 'npm test | tee x', 'npm test; true', 'npm test > out', 'FOO=$BAR npm test', "npm test -- 'a;b'", 'node --test "unclosed']) {
    assert.throws(() => parseAllow({ kinds: ['test'], test }), (error) => error.status === 400 && /셸 특수 문자/.test(error.message), test);
  }
  assert.deepEqual(parseAllow({ kinds: ['wax'], test: 'npm run lint && npm test' }), { kinds: ['wax'], test: 'npm run lint && npm test' });
  assert.deepEqual(parseAllow({ kinds: ['test'], test: 'npm test -- --grep "sum works"' }), { kinds: ['test'], test: 'npm test -- --grep "sum works"' });
  assert.throws(() => createGoalAllow().set('goal-0000000a', { kinds: ['test'], test: 'a && b' }, '대표'), (error) => error.status === 400);
  const state = createGoalAllow();
  state.set('goal-0000000a', { kinds: ['wax'] }, '대표');
  assert.deepEqual(state.view('goal-0000000a').kinds, ['wax']);
  state.add('goal-0000000a', 'write', '대표');
  assert.deepEqual(state.view('goal-0000000a').kinds, ['wax', 'write']);
  state.offer('11111111-1111-4111-8111-111111111111', 'goal-0000000a', 'read');
  assert.equal(state.end('goal-0000000a', 'done'), true);
  assert.deepEqual([state.view('goal-0000000a').on, Boolean(state.view('goal-0000000a').ended), state.offerFor('11111111-1111-4111-8111-111111111111')], [false, true, null]);
  assert.equal(state.view('goal-0000000b').on, false);
});


function fakeClaude(requests) {
  return () => {
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
const bashInput = (command) => ({ tool_name: 'Bash', input: { command } });

async function dashboard(t, root, executeWorker) {
  await setPm(root, { author: '대표', kind: 'human' });
  const server = createChatServer({ root, env: { WAX_CHAT_USER: '대표', WAX_TOOL_NEWS: 'off' }, intervalMs: 30, executeWorker,
    executeJudge: async () => { throw new Error('no judgment'); }, requestTools: async () => [{ id: 'claude', installed: true, approval: 'dashboard' }] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body, withToken = true) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(withToken ? { 'x-chat-token': token } : {}) }, body: JSON.stringify(body) });
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const start = async (goal) => {
    assert.equal((await post(`/api/pm-loop/${goal}/execute`, { key: 'goal:confirm-plan' })).status, 200);
    const card = (await get(`/api/pm-loop/${goal}`)).suggestions.find((item) => item.kind === 'start-worker');
    assert.equal((await post(`/api/pm-loop/${goal}/execute`, { key: card.key, tool: 'claude' })).status, 200);
  };
  return { server, post, get, start };
}

test('engine: only the goal\'s own headless worker is auto-allowed, logged as goal-allow:<goal> with the kind; another goal is not, and the approval screen can turn a kind on', async (t) => {
  const root = await project(t, ['f1', 'f2']);
  const real = await realpath(root);
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  const script = (feature) => [bashInput(`node "${CLI}" status ${feature}`), { tool_name: 'Write', input: { file_path: join(real, '.wax/tmp/plan.md'), content: '# plan' } }, bashInput(`node "${CLI}" status other-task`)];
  const reports = new Map();
  const executeWorker = async (dir, input) => {
    const feature = input.prompt.match(/작업: ([a-z0-9-]+),/)[1];
    const result = await runAgentSession(dir, { ...input, executable: 'fake.js', launch: fakeClaude(script(feature)) });
    reports.set(feature, JSON.parse(JSON.parse(result.message).report));
    return result;
  };
  const { post, get, start } = await dashboard(t, root, executeWorker);
  assert.equal((await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['wax'] } }, false)).status, 403);
  assert.equal((await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['shell'] } })).status, 400);
  assert.equal((await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['test'], test: '' } })).status, 400);
  assert.equal((await get('/api/pm-loop')).goals.length, 0, 'a refused allowance creates no goal');
  const a = await (await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['wax', 'write'] } })).json();
  const b = await (await post('/api/pm-loop', { title: 'B', features: ['f2'] })).json();
  assert.deepEqual([a.allow.on, a.allow.kinds, a.allow.by, b.allow.on], [true, ['wax', 'write'], '대표', false]);
  await start(a.id);
  const pendingA = await until(async () => (await get('/api/approvals')).requests.find((item) => item.status === 'pending'));
  assert.deepEqual([pendingA.goal, pendingA.goalAllowOffer, pendingA.allowCandidate, pendingA.goalAllow.on], [a.id, undefined, undefined, true]);
  assert.match(pendingA.details.input.command, /status other-task/);
  assert.equal((await post(`/api/approvals/${pendingA.id}/decision`, { decision: 'allow', fingerprint: pendingA.fingerprint, goalAllow: true })).status, 409, 'no offer for a request that matches no kind');
  assert.equal((await post(`/api/approvals/${pendingA.id}/decision`, { decision: 'deny', fingerprint: pendingA.fingerprint })).status, 200);
  await until(() => reports.get('f1'));
  assert.deepEqual(reports.get('f1'), ['allow', 'allow', 'deny']);
  const auto = (await listApprovals(root)).requests.filter((item) => item.allowKind);
  assert.deepEqual(auto.map((item) => [item.allowKind, item.decision, item.decidedBy, item.goal, item.status]).sort(),
    [['wax', 'allow', `goal-allow:${a.id}`, a.id, 'delivered'], ['write', 'allow', `goal-allow:${a.id}`, a.id, 'delivered']]);
  const used = (await readDecisions(root, a.id)).filter((item) => item.kind === 'allow' && item.outcome === 'used');
  assert.deepEqual(used.map((item) => [item.allowKind, item.by, item.feature]).sort(), [['wax', `goal-allow:${a.id}`, 'f1'], ['write', `goal-allow:${a.id}`, 'f1']]);
  const viewA = await get(`/api/pm-loop/${a.id}`);
  assert.deepEqual([viewA.allowUsed.total, viewA.allow.used.wax, viewA.decisions.some((item) => item.outcome === 'used')], [2, 1, false]);
  const trace = await buildRunTrace(root, 'f1');
  assert.deepEqual(trace.goalAllows.map((item) => [item.goal, item.total]), [[a.id, 2]]);
  assert.match(trace.markdown, /목표 허용으로 허용됨 2번/);

  await start(b.id);
  const first = await until(async () => (await get('/api/approvals')).requests.find((item) => item.status === 'pending'));
  assert.deepEqual([first.goal, first.allowCandidate, first.goalAllowOffer], [b.id, 'wax', { goal: b.id, kind: 'wax' }]);
  assert.equal((await post(`/api/approvals/${first.id}/decision`, { decision: 'allow', fingerprint: first.fingerprint, goalAllow: true }, false)).status, 403);
  assert.equal((await post(`/api/approvals/${first.id}/decision`, { decision: 'deny', fingerprint: first.fingerprint, goalAllow: true })).status, 400);
  const enabled = await (await post(`/api/approvals/${first.id}/decision`, { decision: 'allow', fingerprint: first.fingerprint, goalAllow: true })).json();
  assert.deepEqual([enabled.decision, enabled.decidedBy, enabled.goalAllowEnabled], ['allow', '대표', { goal: b.id, kind: 'wax' }]);
  assert.deepEqual((await get(`/api/pm-loop/${b.id}`)).allow.kinds, ['wax']);
  assert.deepEqual((await get(`/api/pm-loop/${a.id}`)).allow.kinds, ['wax', 'write'], 'goal A is unchanged');
  for (const expected of ['write', undefined]) {
    const next = await until(async () => (await get('/api/approvals')).requests.find((item) => item.status === 'pending'));
    assert.equal(next.allowCandidate, expected);
    assert.equal((await post(`/api/approvals/${next.id}/decision`, { decision: 'deny', fingerprint: next.fingerprint })).status, 200);
  }
  await until(() => reports.get('f2'));
  assert.deepEqual(reports.get('f2'), ['allow', 'deny', 'deny']);
  assert.equal((await listApprovals(root)).requests.filter((item) => item.decidedBy === `goal-allow:${b.id}`).length, 0, 'the human allowed the first B request');
});

test('engine: in a fresh project without .wax/tmp the first stage document and wax save still match; the worker prompt states the allowed shapes only when on', async (t) => {
  const root = await project(t, ['f1', 'f2']);
  const real = await realpath(root);
  await assert.rejects(lstat(join(root, '.wax', 'tmp')), { code: 'ENOENT' }, 'a fresh project has no .wax/tmp');
  const scripts = { f1: [{ tool_name: 'Write', input: { file_path: join(real, '.wax/tmp/plan.md'), content: '# plan' } }, bashInput(`node "${CLI}" save plan f1 --file .wax/tmp/plan.md`)], f2: [] };
  const reports = new Map(), prompts = new Map();
  const executeWorker = async (dir, input) => {
    const feature = input.prompt.match(/작업: ([a-z0-9-]+),/)[1];
    prompts.set(feature, input.prompt);
    const result = await runAgentSession(dir, { ...input, executable: 'fake.js', launch: fakeClaude(scripts[feature]) });
    reports.set(feature, JSON.parse(JSON.parse(result.message).report));
    return result;
  };
  const { post, get, start } = await dashboard(t, root, executeWorker);
  const a = await (await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['wax', 'test', 'write'], test: 'node --test' } })).json();
  const b = await (await post('/api/pm-loop', { title: 'B', features: ['f2'] })).json();
  await start(a.id);
  await until(() => reports.get('f1'));
  assert.deepEqual(reports.get('f1'), ['allow', 'allow'], 'both matched without a person');
  assert.deepEqual((await listApprovals(root)).requests.map((item) => item.allowKind).sort(), ['wax', 'write']);
  assert.equal((await get(`/api/pm-loop/${a.id}`)).allowUsed.total, 2);
  const prompt = prompts.get('f1');
  assert.match(prompt, /목표 허용\(wax, test, write\)/);
  assert.match(prompt, /&&·;·파이프/);
  const flag = ` --project ${JSON.stringify(shellPath(root))}`;
  assert.ok(prompt.includes(`CLI는 늘 --project ${JSON.stringify(shellPath(root))}를 붙여 부르세요`));
  assert.ok(prompt.includes(`node ${JSON.stringify(CLI)}${flag} complete plan f1 --author wax-worker-claude --evidence "<근거>"`));
  assert.ok(prompt.includes(`node ${JSON.stringify(CLI)}${flag} test f1 [--revision <n>] [--author wax-worker-claude] -- node --test.`));
  assert.doesNotMatch(prompt, /--worktree/, 'a worker in the project folder is not told about worktrees');
  assert.match(prompt, /고치는 중에 다시 돌릴 때도 늘 이 모양으로 실행하세요\. "node --test"만 따로 실행하면 근거가 남지 않고 사람이 하나하나 승인해야 합니다/);
  assert.doesNotMatch(prompt, /"node --test" 그대로/);
  assert.match(prompt, /고치는 중에 검사를 다시 돌릴 때도 검사 명령만 따로 실행하지 말고 매번 CLI test로 실행하세요/);
  await start(b.id);
  await until(() => reports.get('f2'));
  assert.doesNotMatch(prompts.get('f2'), /목표 허용/);
  assert.match(prompts.get('f2'), /매번 CLI test로 실행하세요/);
});

test('engine: turning the allowance off and ending the goal stop auto-allow at once; the worker cannot turn it on', async (t) => {
  const root = await project(t, ['f1', 'f2']);
  const captured = new Map();
  const executeWorker = (dir, input) => new Promise((resolve, reject) => {
    captured.set(input.goalAllow.goal, input.goalAllow);
    input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
  const { server, post, get, start } = await dashboard(t, root, executeWorker);
  const a = await (await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['wax'] } })).json();
  const b = await (await post('/api/pm-loop', { title: 'B', features: ['f2'], allow: { kinds: ['wax'] } })).json();
  await start(a.id); await start(b.id);
  const allowA = await until(() => captured.get(a.id)), allowB = await until(() => captured.get(b.id));
  const request = (feature) => ({ tool: 'claude', details: bashInput(`node "${CLI}" status ${feature}`) });
  assert.deepEqual(await allowA.check(request('f1')), { allow: 'wax' });
  assert.deepEqual(await allowA.check(request('f2')), null, 'another goal\'s task is not this worker\'s');
  assert.equal((await post(`/api/pm-loop/${a.id}/allow/off`, {}, false)).status, 403);
  const off = await (await post(`/api/pm-loop/${a.id}/allow/off`, {})).json();
  assert.equal(off.allow.on, false);
  assert.deepEqual(await allowA.check(request('f1')), { candidate: 'wax' });
  assert.deepEqual(await allowB.check(request('f2')), { allow: 'wax' }, 'goal B keeps its allowance');
  const goalFile = join(root, '.wax', 'chat', 'pm-loop', `${a.id}.json`);
  const { readFile } = await import('node:fs/promises');
  const stored = JSON.parse(await readFile(goalFile, 'utf8'));
  assert.equal('allow' in stored, false, 'the goal file holds no allowance');
  await writeFile(goalFile, JSON.stringify({ ...stored, allow: { kinds: ['wax', 'write', 'read', 'test'], test: 'rm -rf /' } }));
  assert.deepEqual(await allowA.check(request('f1')), { candidate: 'wax' });
  assert.equal((await get(`/api/pm-loop/${a.id}`)).allow.on, false);
  await stopGoal(root, b.id, { author: '대표' });
  assert.equal(await allowB.check(request('f2')), null);
  const viewB = await until(async () => { const view = await get(`/api/pm-loop/${b.id}`); return view.allow.ended && view; });
  assert.equal(viewB.allow.on, false);
  assert.ok((await readDecisions(root, b.id)).some((item) => item.kind === 'allow' && item.outcome === 'ended'));
  assert.equal((await post(`/api/pm-loop/${b.id}/resume`, {})).status, 200);
  assert.equal((await get(`/api/pm-loop/${b.id}`)).allow.on, false);
  assert.equal((await post(`/api/pm-loop/${b.id}/allow/off`, {})).status, 200);
  void server;
});

test('wax and test kinds: a Windows CLI path at the start matches in backslash or slash spelling; anything else stays strict', async (t) => {
  const root = await realpath(await project(t));
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  await writeFile(join(root, '.wax', 'tmp', 'plan.md'), '# p');
  const cli = 'C:\\Users\\me\\wax\\bin\\wax.mjs', slash = 'C:/Users/me/wax/bin/wax.mjs';
  const ctx = { root, cli, feature: 'fix-sum', phase: 'implement', author: AUTHOR, test: 'node --test' };
  const ok = async (command, kind = 'wax') => assert.equal(await matchAllow(bash(command), [kind], ctx), kind, command);
  const no = async (command, kind = 'wax') => assert.equal(await matchAllow(bash(command), [kind], ctx), null, command);
  await ok(`node "${cli}" status fix-sum`);
  await ok(`node ${cli} status fix-sum`);
  await ok(`node "${slash}" status fix-sum`);
  await ok(`"${process.execPath}" "${cli}" status fix-sum`);
  await ok(`"${cli}" status fix-sum`);
  await ok(`node "${cli}" complete implement fix-sum --author ${AUTHOR} --evidence "재현 테스트 추가"`);
  await ok(`node "${cli}" save implement fix-sum --file .wax/tmp/plan.md --revision 4`);
  await ok(`node "${cli}" test fix-sum -- node --test`, 'test');
  const doubled = cli.replaceAll('\\', '\\\\');
  await ok(`node "${doubled}" save implement fix-sum --file .wax/tmp/plan.md`);
  await ok(`node ${doubled} status fix-sum`);
  await ok(`node "${doubled}" test fix-sum -- node --test`, 'test');
  await no(`node "${doubled}" status fix-sum && calc`);
  await no(`node "${cli.replace('\\', '\\\\\\')}" status fix-sum`);
  await no(`node "${cli}" status fix-sum && calc`);
  await no(`node "${cli}" status fix-sum; calc`);
  await no(`node "${cli}" save implement fix-sum --file .wax\\tmp\\plan.md`);
  await no(`node "${cli}.evil" status fix-sum`);
  await no(`node "C:\\Users\\other\\wax.mjs" status fix-sum`);
  await no(`node "${cli}" status other-task`);
  await no(`calc "${cli}" status fix-sum`);
  await no(`node "${cli}" test fix-sum -- node --test && calc`, 'test');
});

test('lapsedAllow: the last on without a later off or end, only when the engine that turned it on is gone', () => {
  const on = (extra = {}) => ({ kind: 'allow', outcome: 'on', kinds: ['wax', 'test'], test: 'node --test', engine: { pid: 1, instance: 'a' }, at: '2026-11-02T03:37:28.000Z', ...extra });
  const dead = () => false, alive = () => true;
  assert.deepEqual(lapsedAllow([on(), { kind: 'allow', outcome: 'used', allowKind: 'wax' }], { alive: dead }), { kinds: ['wax', 'test'], test: 'node --test', at: '2026-11-02T03:37:28.000Z' });
  assert.deepEqual(lapsedAllow([on(), { kind: 'allow', outcome: 'lapsed', kinds: ['wax', 'test'] }], { alive: dead })?.kinds, ['wax', 'test'], 'a second restart still finds it');
  assert.equal(lapsedAllow([on(), { kind: 'allow', outcome: 'off' }], { alive: dead }), null);
  assert.equal(lapsedAllow([on(), { kind: 'allow', outcome: 'ended' }], { alive: dead }), null);
  assert.equal(lapsedAllow([on()], { alive }), null, 'another running dashboard still holds it');
  assert.equal(lapsedAllow([on({ kinds: ['wax', 'everything'] })], { alive: dead }), null, 'a record that does not parse is not shown');
  assert.equal(lapsedAllow([], { alive: dead }), null);
});

test('engine: after a dashboard restart the allowance stays off, the goal screen says it lapsed, and only a person can turn it on again', async (t) => {
  const root = await project(t, ['f1']);
  const executeWorker = () => new Promise(() => {});
  const first = await dashboard(t, root, executeWorker);
  const goal = await (await first.post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['wax', 'test'], test: 'node --test' } })).json();
  assert.equal(goal.allow.on, true);
  await first.server.shutdown();

  const second = await dashboard(t, root, executeWorker);
  const view = await until(async () => { const item = await second.get(`/api/pm-loop/${goal.id}`); return item.allow.lapsed && item; });
  assert.equal(view.allow.on, false, 'a restart never turns the allowance back on by itself');
  assert.deepEqual(view.allow.lapsed.kinds, ['wax', 'test']);
  assert.equal(view.allow.lapsed.test, 'node --test');
  assert.ok((await readDecisions(root, goal.id)).some((item) => item.kind === 'allow' && item.outcome === 'lapsed'));
  assert.equal((await second.post(`/api/pm-loop/${goal.id}/allow/on`, { kinds: ['wax'] }, false)).status, 403);
  assert.equal((await second.post(`/api/pm-loop/${goal.id}/allow/on`, { kinds: [] })).status, 400);
  assert.equal((await second.post(`/api/pm-loop/${goal.id}/allow/on`, { kinds: ['wax'], at: 'x' })).status, 400);
  assert.equal((await second.post(`/api/pm-loop/${goal.id}/allow/on`, { kinds: ['test'] })).status, 400, 'test needs its command');
  const again = await (await second.post(`/api/pm-loop/${goal.id}/allow/on`, { kinds: ['wax', 'test'], test: 'node --test' })).json();
  assert.equal(again.allow.on, true);
  assert.deepEqual(again.allow.kinds, ['wax', 'test']);
  assert.equal((await second.get(`/api/pm-loop/${goal.id}`)).allow.lapsed, undefined);
});

test('engine: an "on" record a worker writes into the decision log is only shown as lapsed, never turned on', async (t) => {
  const root = await project(t, ['f1']);
  const first = await dashboard(t, root, () => new Promise(() => {}));
  const goal = await (await first.post('/api/pm-loop', { title: 'A', features: ['f1'] })).json();
  await first.server.shutdown();
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(root, '.wax', 'chat', 'pm-loop', `${goal.id}.jsonl`), `${JSON.stringify({ schema: 1, record: 'decision', id: 'pd-000099-aaaaaa', seq: 99, goal: goal.id, kind: 'allow', outcome: 'on', kinds: ['read', 'write'], by: '대표', at: new Date().toISOString() })}
`);
  const second = await dashboard(t, root, () => new Promise(() => {}));
  const view = await until(async () => { const item = await second.get(`/api/pm-loop/${goal.id}`); return item.allow.lapsed && item; });
  assert.equal(view.allow.on, false);
  assert.deepEqual(view.allow.lapsed.kinds, ['write', 'read']);
});

test('the interactive hook path and other sessions are never auto-allowed, even with a goal allowance on', async (t) => {
  const root = await project(t, ['f1']);
  const { post } = await dashboard(t, root, async () => { throw new Error('unused'); });
  const goal = await (await post('/api/pm-loop', { title: 'A', features: ['f1'], allow: { kinds: ['wax', 'read'] } })).json();
  assert.equal(goal.allow.on, true);
  const input = { hook_event_name: 'PermissionRequest', cwd: root, session_id: 'interactive', tool_name: 'Bash', tool_input: { command: `node "${CLI}" status f1` } };
  let emitted = 0;
  assert.equal(await handleClaudeApproval(input, { env: { WAX_APPROVALS: 'on' }, dashboard: async () => ({ root }), timeoutMs: 150, log() {}, emit: () => { emitted++; } }), false);
  assert.equal(emitted, 0);
  const session = runAgentSession(root, { tool: 'claude', prompt: 'x', executable: 'fake.js', approvalTimeoutMs: 150, launch: fakeClaude([bashInput(`node "${CLI}" status f1`)]) });
  const result = await session;
  assert.deepEqual(JSON.parse(JSON.parse(result.message).report), ['deny']);
  const records = (await listApprovals(root)).requests;
  assert.equal(records.length, 2);
  assert.ok(records.every((item) => !item.allowKind && !item.goal && item.decidedBy === undefined), 'nothing was decided by a goal allowance');
});

test('Codex worker requests use the same check before createApproval', async (t) => {
  const fx = await fixture(t);
  if (!fx) return;
  const { root, ctx } = fx;
  const offers = [], used = [];
  const goalAllow = { goal: 'goal-0000000c', check: (request) => judgeRequest(request, { ...ctx, kinds: ['wax'] }), used: (kind, record) => used.push([kind, record.decidedBy]), offer: (id, kind) => offers.push(kind) };
  const replies = [];
  const message = { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'th', turnId: 'tu', itemId: 'cmd', command: `/bin/zsh -lc 'node "${CLI}" status fix-sum'`, cwd: root } };
  assert.equal(await handleCodexApproval(root, message, { goalAllow, emit: async (reply) => replies.push(reply) }), true);
  assert.deepEqual(replies, [{ id: 9, result: { decision: 'accept' } }]);
  assert.deepEqual(used, [['wax', 'goal-allow:goal-0000000c']]);
  const [record] = (await listApprovals(root)).requests;
  assert.deepEqual([record.allowKind, record.goal, record.status, record.action], ['wax', 'goal-0000000c', 'delivered', '명령 실행']);
  const write = { id: 10, method: 'item/fileChange/requestApproval', params: { threadId: 'th', turnId: 'tu', itemId: 'patch', cwd: root } };
  const waiting = handleCodexApproval(root, write, { goalAllow, item: { changes: [{ path: join(root, '.wax/tmp/a.md'), kind: { type: 'add' }, diff: '+a' }] }, timeoutMs: 5000, emit: async (reply) => replies.push(reply) });
  const pending = await until(async () => (await listApprovals(root)).requests.find((item) => item.status === 'pending'));
  assert.deepEqual([pending.goal, pending.allowCandidate, offers], ['goal-0000000c', 'write', ['write']]);
  await decideApproval(root, pending.id, { decision: 'deny', fingerprint: pending.fingerprint, actor: '대표' });
  await waiting;
  assert.deepEqual(replies.at(-1), { id: 10, result: { decision: 'decline' } });
});

test('recipes only suggest kinds: unknown kinds are refused, the suggestion is filled for the start screen and never turns anything on', async (t) => {
  const recipe = { schema: 1, id: 'fix', title: '고치기', input: { label: '무엇' }, goal: '{input} 고치기', tasks: [{ id: 'fix-{slug}', title: '{input}', ac: ['통과'] }] };
  assert.deepEqual(validateRecipe({ ...recipe, allow: ['write', 'wax', 'test'] }).recipe.allow, ['wax', 'test', 'write']);
  assert.deepEqual(validateRecipe(recipe).recipe.allow, []);
  for (const allow of [['shell'], ['wax', 'wax'], 'wax', ['wax', 'test', 'write', 'read', 'wax'], [1]]) assert.equal(validateRecipe({ ...recipe, allow }).ok, false, JSON.stringify(allow));
  const ok = validateRecipe({ ...recipe, allow: ['wax'] }).recipe;
  assert.deepEqual(fillRecipe(ok, { input: 'sum' }).allow, ['wax']);
  const root = await project(t);
  await mkdir(join(root, '.wax', 'recipes'), { recursive: true });
  await writeFile(join(root, '.wax', 'recipes', 'fix.json'), JSON.stringify({ ...recipe, allow: ['wax', 'test', 'write'] }));
  const { post, get } = await dashboard(t, root, async () => { throw new Error('unused'); });
  const filled = await get('/api/recipes/fix/fill?input=sum');
  assert.deepEqual(filled.allow, ['wax', 'test', 'write']);
  const goal = await (await post('/api/pm-loop', { recipe: { id: 'fix', hash: filled.hash, input: 'sum', slug: filled.slug } })).json();
  assert.equal(goal.allow.on, false);
  const checked = await (await post('/api/pm-loop', { recipe: { id: 'fix', hash: filled.hash, input: 'other', slug: 'other' }, allow: { kinds: ['wax'] } })).json();
  assert.deepEqual(checked.allow.kinds, ['wax'], 'only what the person checked');
});

test('the review prompt shows the complete shape with --verdict pass, and that shape is allowed (real-tool round, 2026-11-04)', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wax-goal-allow-review-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  const ctx = { root, cli: CLI, feature: 'fix-sum', phase: 'review', author: AUTHOR, test: 'node --test' };
  const allow = { on: true, kinds: ['wax'] };
  const line = (phase) => allowPrompt(allow, { feature: { id: 'fix-sum' }, phase, author: AUTHOR }).split('\n').find((text) => text.startsWith('허용되는 wax 명령'));
  assert.match(line('review'), new RegExp(`complete review fix-sum --author ${AUTHOR} --verdict pass --evidence`));
  assert.doesNotMatch(line('implement'), /--verdict/, 'only review needs a verdict');
  assert.equal(await matchAllow(bash(`wax complete review fix-sum --author ${AUTHOR} --verdict pass --evidence "AC 2개 확인" --proofs p-1`), ['wax'], ctx), 'wax');
});
