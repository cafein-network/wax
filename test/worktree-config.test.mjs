import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createTestSymlink, project } from './chat-helpers.mjs';
import { COPY_LIMITS, blockedCopyPath, copyPathShape, copyStatus } from '../src/worktree-copy.mjs';
import { decideSetup, npmCiWipes, parseSetupConfig, readSetup, setupDecisions, setupHash, setupReview, setupRuns, setupState } from '../src/worktree-setup.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { t as tr } from '../web/messages-catalog.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const config = (root, value) => writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify(value));

async function repo(t) {
  const root = await project(t, ['f1']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\nnode_modules/\ndist\n');
  await writeFile(join(root, 'shared.txt'), 'line\n');
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
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

test('copy path shape: relative slash paths only, 1-6 parts, at most 200 characters; no dots, globs, backslashes, colons, control characters or trailing dots and spaces', () => {
  for (const good of ['node_modules', 'packages/web/node_modules', 'target', 'a/b/c/d/e/f', '.cache', 'build-out_1', 'x'.repeat(200)]) assert.equal(copyPathShape(good), true, good);
  for (const bad of ['', '/abs', 'a//b', 'a/', './a', 'a/./b', '../a', 'a/..', 'a\\b', 'C:/x', 'c:x', '**/node_modules', 'a*', 'a?', '[a]', '{a,b}', '!a', 'a\u0007', 'a\u200b',
    'a/b/c/d/e/f/g', 'x'.repeat(201), 'dir.', 'dir ', ' dir', 7, null]) assert.equal(copyPathShape(bad), false, JSON.stringify(bad));
  for (const blocked of ['.git', 'a/.wax', '.env', '.env.local', 'x/.ENV.prod', '.hg', '.svn', '.jj', '.bzr', '.pijul', '.sl', '.GIT', 'pkg/.Git/x']) {
    assert.equal(copyPathShape(blocked), true, blocked);
    assert.equal(blockedCopyPath(blocked), true, blocked);
  }
  for (const open of ['node_modules', '.cache', 'gitx', 'my.env', 'a/.github']) assert.equal(blockedCopyPath(open), false, open);
});

test('parser: copy (1-20 paths, duplicates merged) and checks (1-5 argument arrays of 1-50 arguments) are accepted; setup may be left out when either is there', () => {
  const full = parseSetupConfig(JSON.stringify({ setup: ['npm', 'install'], copy: ['node_modules', 'node_modules', 'packages/web/node_modules'], checks: [['npm', 'test'], ['node', '--test', 'test/']], portEnv: 'PORT' }));
  assert.deepEqual(full, { setup: ['npm', 'install'], env: [], portEnv: 'PORT', copy: ['node_modules', 'packages/web/node_modules'], checks: [['npm', 'test'], ['node', '--test', 'test/']] });
  assert.deepEqual(parseSetupConfig(JSON.stringify({ setup: ['npm', 'ci'] })), { setup: ['npm', 'ci'], env: [], portEnv: null, copy: [], checks: [] });
  assert.deepEqual(parseSetupConfig(JSON.stringify({ copy: ['target'] })).setup, null, 'copy only (W5)');
  assert.deepEqual(parseSetupConfig(JSON.stringify({ checks: [['node', '--test']] })).checks, [['node', '--test']], 'checks only');
  const reasons = [];
  for (const bad of [{}, { env: ['.env'] }, { portEnv: 'PORT' }, { copy: [] }, { copy: 'node_modules' }, { copy: ['**/node_modules'] }, { copy: ['../up'] }, { copy: Array.from({ length: COPY_LIMITS.entries + 1 }, (_, i) => `d${i}`) },
    { checks: [] }, { checks: ['npm test'] }, { checks: [[]] }, { checks: 'npm test' }, { checks: [['npm', '']] }, { checks: [['npm', 'a\u0007']] }, { checks: Array.from({ length: 6 }, () => ['node']) },
    { checks: [Array.from({ length: 51 }, () => 'x')] }, { setup: [], copy: ['target'] }, { setup: ['npm'], copy: ['a'], extra: 1 }]) {
    assert.throws(() => parseSetupConfig(JSON.stringify(bad)), (error) => { reasons.push(error.message); return true; }, JSON.stringify(bad));
  }
  assert.match(reasons[0], /setup, copy, checks/);
  assert.match(reasons.at(-1), /copy, checks/);
});

test('hash: files named in checks arguments and package files for a package manager check are in the hash; a file without copy and checks keeps its old hash', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'scripts', 'setup.mjs'), 'console.log(1)\n');
  await writeFile(join(root, 'test', 'unit.test.mjs'), 'ok\n');
  await writeFile(join(root, 'scripts', 'check.json'), '{}\n');
  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const plain = JSON.stringify({ setup: ['node', 'scripts/setup.mjs'] });
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), plain);
  const before = await readSetup(real);
  assert.equal(before.hash, setupHash(Buffer.from(plain), [{ path: 'scripts/setup.mjs', bytes: Buffer.from('console.log(1)\n') }]));
  await config(root, { setup: ['node', 'scripts/setup.mjs'], checks: [['node', '--test', 'test/unit.test.mjs'], ['node', 'x', '--config=scripts/check.json'], ['npm', 'test']] });
  const review = await setupReview(root);
  assert.equal(review.state, 'pending');
  assert.equal(review.packageManager, true, 'a package manager check counts');
  assert.deepEqual(review.refs.map((ref) => [ref.path, Boolean(ref.package)]),
    [['package-lock.json', true], ['package.json', true], ['scripts/check.json', false], ['scripts/setup.mjs', false], ['test/unit.test.mjs', false]]);
  const approved = await decideSetup(root, { author: '대표', hash: review.hash });
  assert.deepEqual(approved.files, ['docs/wax/worktree.json', 'package-lock.json', 'package.json', 'scripts/check.json', 'scripts/setup.mjs', 'test/unit.test.mjs']);
  const state = async () => setupState(await readSetup(real), await setupDecisions(root));
  assert.equal(await state(), 'approved');
  for (const [file, next] of [['test/unit.test.mjs', 'changed\n'], ['scripts/check.json', '{"a":1}\n'], ['package.json', '{"scripts":{"test":"node evil.js"}}\n']]) {
    const old = await readFile(join(root, file), 'utf8');
    await writeFile(join(root, file), next);
    assert.equal(await state(), 'changed', file);
    await writeFile(join(root, file), old);
    assert.equal(await state(), 'approved', `${file} back`);
  }
  await config(root, { setup: ['node', 'scripts/setup.mjs'], checks: [['node', '--test', 'test/unit.test.mjs'], ['node', 'x', '--config=scripts/check.json'], ['npm', 'test']], copy: ['node_modules'] });
  assert.equal(await state(), 'changed', 'adding copy');
  const outside = await project(t);
  await writeFile(join(outside, 'evil.mjs'), 'evil\n');
  if (!(await createTestSymlink(t, join(outside, 'evil.mjs'), join(root, 'test', 'link.mjs'), 'file'))) return;
  await config(root, { checks: [['node', 'test/link.mjs']] });
  const linked = await setupReview(root);
  assert.equal(linked.state, 'invalid');
  assert.match(linked.reason, /test\/link\.mjs/);
});

test('approval screen: each copy line shows its state in the project (ready, missing, not ignored, tracked, blocked, link); reading does not touch the project .git', async (t) => {
  const root = await repo(t);
  const real = await realpath(root);
  await mkdir(join(root, 'node_modules', 'a'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'a', 'i.js'), 'x\n');
  await mkdir(join(root, 'dist', 'x'), { recursive: true });
  await writeFile(join(root, 'dist', 'x', 'y.js'), 'x\n');
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'vendor', 'kept.js'), 'x\n');
  commit(root, 'vendor');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\nnode_modules/\ndist\nvendor/\n');
  await writeFile(join(root, 'vendor', 'new.js'), 'x\n');
  commit(root, 'ignore vendor');
  await mkdir(join(root, 'build'));
  await writeFile(join(root, 'build', 'out.js'), 'x\n');
  const lines = ['node_modules', 'dist/x', 'packages/web/node_modules', 'build', 'vendor', '.env.cache', 'a/.git'];
  await config(root, { setup: ['npm', 'install', '--prefer-offline'], copy: lines });
  const before = await gitFiles(root);
  const review = await setupReview(root);
  assert.deepEqual(review.copy, [{ path: 'node_modules', state: 'ready' }, { path: 'dist/x', state: 'ready' }, { path: 'packages/web/node_modules', state: 'missing' },
    { path: 'build', state: 'notIgnored' }, { path: 'vendor', state: 'tracked' }, { path: '.env.cache', state: 'blocked' }, { path: 'a/.git', state: 'blocked' }]);
  assert.equal(review.npmCiCopy, undefined, 'npm install keeps node_modules');
  assert.deepEqual(await gitFiles(root), before, 'the project .git is unchanged');
  const unknown = await copyStatus(real, ['node_modules', '.git', 'nope'], { run: async () => { throw new Error('no git'); } });
  assert.deepEqual(unknown.map((item) => item.state), ['unknown', 'blocked', 'missing']);
  const outside = await project(t);
  await mkdir(join(outside, 'mods'));
  if (!(await createTestSymlink(t, join(outside, 'mods'), join(root, 'linked'), 'dir'))) return;
  assert.deepEqual((await copyStatus(real, ['linked', 'linked/x'])).map((item) => item.state), ['link', 'link']);
});

test('npm ci with node_modules in copy is flagged on the approval screen (npm ci deletes node_modules first)', () => {
  const parsed = (value) => parseSetupConfig(JSON.stringify(value));
  assert.equal(npmCiWipes(parsed({ setup: ['npm', 'ci'], copy: ['node_modules'] })), true);
  assert.equal(npmCiWipes(parsed({ setup: ['npm.cmd', '--no-audit', 'clean-install'], copy: ['packages/web/node_modules'] })), true);
  assert.equal(npmCiWipes(parsed({ setup: ['npm', 'install'], copy: ['node_modules'] })), false);
  assert.equal(npmCiWipes(parsed({ setup: ['npm', 'ci'], copy: ['target'] })), false);
  assert.equal(npmCiWipes(parsed({ setup: ['pnpm', 'ci'], copy: ['node_modules'] })), false);
  assert.equal(npmCiWipes(parsed({ copy: ['node_modules'] })), false);
});

test('copy or checks only (W5): approvable, nothing runs in a new worktree (setup "none", no run record), and portEnv still reaches the worker once approved', async (t) => {
  const root = await repo(t);
  await config(root, { copy: ['node_modules'], checks: [['node', '--test']], portEnv: 'PORT' });
  commit(root, 'config');
  const review = await setupReview(root);
  assert.equal(review.state, 'pending');
  assert.equal(review.config.setup, null);
  assert.deepEqual(review.copy, [{ path: 'node_modules', state: 'missing' }]);
  await decideSetup(root, { author: '대표', hash: review.hash });
  const goal = await createGoal(root, { title: '복사만', features: ['f1'], worktrees: true }, { author: '대표' });
  const made = await prepareWorktree(root, goal, 'f1');
  assert.equal(made.setup.state, 'approved');
  assert.equal(made.setup.outcome, 'none');
  assert.deepEqual(made.env, { WAX_PORT: String(made.entry.port), PORT: String(made.entry.port) });
  assert.deepEqual(await setupRuns(root), []);
  assert.equal(await lstat(join(made.entry.path, 'node_modules')).then(() => true, () => false), false);
  if (process.platform !== 'win32') assert.deepEqual(made.setup.copy.entries, [{ path: 'node_modules', outcome: 'missing' }]);
});

test('catalog: every copy state has a Korean and an English line', () => {
  for (const state of ['ready', 'missing', 'notIgnored', 'tracked', 'blocked', 'link', 'unknown']) assert.notEqual(tr(`worktrees.copyState.${state}`), `worktrees.copyState.${state}`, state);
});
