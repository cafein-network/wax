import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { readWorktrees, validWorktreeRecord } from '../src/worktrees.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { decideSetup, setupReview, setupRuns } from '../src/worktree-setup.mjs';
import { mergeTreeSupported, previewImport } from '../src/worktree-import.mjs';
import { worktreeBoard } from '../src/worktree-board.mjs';
import { createGoal, goalOverview, importWorktree, readGoal } from '../src/chat/pm-loop.mjs';
import { copyResultText } from '../web/worktree-board-text.mjs';
import { t as tr } from '../web/messages-catalog.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const exists = (path) => lstat(path).then(() => true, () => false);
const modern = mergeTreeSupported(git(process.cwd(), '--version').match(/(\d+\.\d+)/)[1]);
const person = '대표';
const free = { portProbe: async () => 'free' };
const copyWay = process.platform === 'win32' ? { copyOptions: { platform: 'linux' } } : {};
const SETUP = 'import { existsSync, writeFileSync } from "node:fs";\nwriteFileSync(".setup-saw", existsSync("node_modules/dep/index.js") ? "copied" : "empty");\n';

async function repo(t, config = { setup: [process.execPath, 'scripts/setup.mjs'], copy: ['node_modules', 'dist'] }) {
  const root = await project(t, ['f1', 'f2']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\nnode_modules/\ndist/\n.setup-saw\n');
  await writeFile(join(root, 'shared.txt'), 'line\n');
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'setup.mjs'), SETUP);
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify(config));
  commit(root);
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'export default 1;\n');
  await writeFile(join(root, 'node_modules', '.package-lock.json'), '{}\n');
  return root;
}
const approve = async (root) => decideSetup(root, { author: person, hash: (await setupReview(root)).hash });
const goalOn = async (root) => readGoal(root, (await createGoal(root, { title: '복사', features: ['f1', 'f2'], worktrees: true }, { author: person })).id);
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

test('new worktree: approved copy lines are copied after .env and before setup; the list keeps a valid setup.copy summary; the project .git only gains the worktree entry', async (t) => {
  const root = await repo(t);
  await approve(root);
  const goal = await goalOn(root);
  const made = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  assert.equal(made.setup.outcome, 'ok');
  assert.equal(await readFile(join(made.entry.path, '.setup-saw'), 'utf8'), 'copied', 'the setup started with node_modules already there');
  assert.equal(await readFile(join(made.entry.path, 'node_modules', 'dep', 'index.js'), 'utf8'), 'export default 1;\n');
  const { copy } = made.setup;
  assert.ok(['ok'].includes(copy.state), copy.state);
  assert.deepEqual(copy.entries.map((item) => [item.path, item.outcome === 'cloned' || item.outcome === 'copied' ? 'done' : item.outcome, item.files]), [['node_modules', 'done', 2], ['dist', 'missing', undefined]]);
  const entry = (await readWorktrees(root)).find((item) => item.id === made.entry.id);
  assert.deepEqual(entry.setup.copy, copy, 'the list keeps the summary');
  assert.equal(validWorktreeRecord(entry), true);
  assert.equal(entry.setup.baseline.count, 0);
  assert.equal(git(made.entry.path, 'status', '--porcelain'), '', 'copied and setup files are ignored');
  await fsp.rm(join(made.entry.path, 'node_modules'), { recursive: true });
  const again = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  assert.equal(again.created, false);
  assert.equal(await exists(join(made.entry.path, 'node_modules')), false);
  const view = (await goalOverview(root, goal.id, { user: person })).worktrees;
  assert.deepEqual(view.entries.find((item) => item.id === made.entry.id).copy, { state: 'ok', entries: 1 });
  const board = await worktreeBoard(root, { tiers: 0 });
  assert.deepEqual(board.rows.find((row) => row.id === made.entry.id).setup.copy, { state: 'ok', entries: 1 });
  assert.equal(copyResultText({ state: 'ok', entries: 1 }, (id, ...values) => tr(id, ...values)), tr('worktrees.copyResult.ok', 1));
});

test('copy only when approved: pending or changed worktree.json copies nothing; approving later copies on the next start of that worktree; copy-only files work (W5)', async (t) => {
  const root = await repo(t, { copy: ['node_modules'] });
  const goal = await goalOn(root);
  const pending = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  assert.equal(pending.setup.outcome, 'pending');
  assert.equal(pending.setup.copy, undefined);
  assert.equal(await exists(join(pending.entry.path, 'node_modules')), false);
  await approve(root);
  const later = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  assert.equal(later.created, false);
  assert.equal(later.setup.outcome, 'none', 'copy only: no setup to run');
  assert.equal(later.setup.copy.state, 'ok');
  assert.equal(await exists(join(pending.entry.path, 'node_modules', 'dep', 'index.js')), true);
  assert.deepEqual(await setupRuns(root), []);
  const before = (await setupReview(root)).hash;
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ copy: ['node_modules', 'dist'] }));
  commit(root, 'more copy');
  assert.notEqual((await setupReview(root)).hash, before);
  const changed = await prepareWorktree(root, { ...goal, worktrees: { ...goal.worktrees, base: git(root, 'rev-parse', 'HEAD') } }, 'f2', { ...free, ...copyWay });
  assert.equal(changed.setup.outcome, 'changed');
  assert.equal(await exists(join(changed.entry.path, 'node_modules')), false);
});

test('stop during copy: the partial copy is removed, setup does not run, the worker is not started; the next start copies again and runs setup', async (t) => {
  const root = await repo(t);
  await approve(root);
  const goal = await goalOn(root);
  const controller = new AbortController();
  const stopping = { copyOptions: { ...copyWay.copyOptions, platform: 'linux', fs: { copyFile: async (from, to, mode) => { controller.abort(); return fsp.copyFile(from, to, mode); } } } };
  await assert.rejects(prepareWorktree(root, goal, 'f1', { ...free, ...stopping, signal: controller.signal }), (error) => error.setupOutcome === 'stopped' && error.worktree === true);
  const entry = (await readWorktrees(root)).find((item) => item.feature === 'f1');
  assert.equal(entry.state, 'active');
  assert.equal(entry.setup.outcome, 'stopped');
  assert.equal(entry.setup.copy.state, 'stopped');
  assert.equal(await exists(join(entry.path, 'node_modules')), false, 'the partial copy is gone');
  assert.equal(await exists(join(entry.path, '.setup-saw')), false, 'setup did not run');
  assert.deepEqual(await setupRuns(root), []);
  const next = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  assert.equal(next.created, false);
  assert.equal(next.setup.outcome, 'ok');
  assert.equal(next.setup.copy.state, 'ok');
  assert.equal(await readFile(join(entry.path, '.setup-saw'), 'utf8'), 'copied');
});

test('Windows (simulated): no fast copy (unsupported), the setup installs from scratch and the worker starts; the approval screen says so', async (t) => {
  const root = await repo(t);
  await approve(root);
  const made = await prepareWorktree(root, await goalOn(root), 'f1', { ...free, copyOptions: { platform: 'win32' } });
  assert.equal(made.setup.outcome, 'ok');
  assert.deepEqual(made.setup.copy, { state: 'unsupported', method: null, ms: 0, entries: [] });
  assert.equal(await readFile(join(made.entry.path, '.setup-saw'), 'utf8'), 'empty');
  assert.equal((await setupReview(root, { platform: 'win32' })).copyUnsupported, true);
  assert.equal((await setupReview(root, { platform: 'linux' })).copyUnsupported, undefined);
  assert.equal(copyResultText({ state: 'unsupported', entries: 0 }), tr('worktrees.copyResult.unsupported'));
});

test('import leaves out paths under copied folders, uncommitted (ignore undone) or committed on the branch, lists them as copied and binds them in the fingerprint', { skip: !modern }, async (t) => {
  const root = await repo(t);
  await approve(root);
  const goal = await goalOn(root);
  const made = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  const w = made.entry.path;
  await writeFile(join(w, '.gitignore'), '.wax/\n.env*\ndist/\n.setup-saw\n');
  await writeFile(join(w, 'node_modules', 'dep', 'index.js'), 'export default 2;\n');
  git(w, 'add', 'node_modules/.package-lock.json');
  git(w, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'worker commits a copied file');
  await writeFile(join(w, 'shared.txt'), 'line\nworker\n');
  const before = await gitFiles(root);
  const preview = await previewImport(root, goal.id, made.entry.id);
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.files.map((file) => file.path).sort(), ['.gitignore', 'shared.txt']);
  assert.equal(preview.copied.count, 2);
  assert.deepEqual(preview.copied.groups, [{ path: 'node_modules', count: 2 }]);
  assert.deepEqual(preview.copied.paths, ['node_modules/.package-lock.json', 'node_modules/dep/index.js']);
  assert.deepEqual(await gitFiles(root), before, 'the preview wrote nothing to the project .git');
  const list = join(root, '.wax', 'chat', 'worktrees.jsonl');
  const text = await readFile(list, 'utf8');
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  const last = lines.findLast((line) => line.id === made.entry.id);
  await writeFile(list, `${text}${JSON.stringify({ ...last, seq: last.seq + 100, setup: { ...last.setup, copy: undefined } })}\n`);
  const without = await previewImport(root, goal.id, made.entry.id);
  assert.notEqual(without.fingerprint, preview.fingerprint);
  assert.ok(without.files.some((file) => file.path.startsWith('node_modules/')), 'without the copy record the files would come in');
  await writeFile(list, text);
  const result = await importWorktree(root, goal.id, made.entry.id, { author: person, fingerprint: preview.fingerprint });
  assert.deepEqual(result.imported.sort(), ['.gitignore', 'shared.txt']);
  assert.equal(result.copied, 2);
  assert.equal(await readFile(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'export default 1;\n', 'the project copy is untouched');
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'line\nworker\n');
});

test('board and goal summary: uncommitted counts and lines leave out copied folders even when the worker undid the ignore', { skip: !modern }, async (t) => {
  const root = await repo(t);
  await approve(root);
  const goal = await goalOn(root);
  const made = await prepareWorktree(root, goal, 'f1', { ...free, ...copyWay });
  await writeFile(join(made.entry.path, '.gitignore'), '.wax/\n.env*\ndist/\n.setup-saw\n');
  await writeFile(join(made.entry.path, 'shared.txt'), 'line\nworker\n');
  const board = await worktreeBoard(root, { probe: async () => false, tiers: 3 });
  const row = board.rows.find((item) => item.id === made.entry.id);
  assert.equal(row.git.uncommitted, 2, '.gitignore and shared.txt only');
  assert.deepEqual([row.git.lines.added, row.git.lines.removed], [1, 1]);
  const summary = (await goalOverview(root, goal.id, { user: person })).worktrees.entries.find((item) => item.id === made.entry.id).summary;
  assert.deepEqual(summary, { files: 2, commits: 0, uncommitted: 2 });
});

test('list record: a malformed setup.copy is not accepted (unknown state or outcome, bad path, extra keys, too many lines)', () => {
  const base = { schema: 1, seq: 1, id: 'goal-1a2b3c4d-1', goal: 'goal-1a2b3c4d', feature: 'f1', branch: 'wax/goal-1a2b3c4d/f1-1', path: '/p/.wax/worktrees/goal-1a2b3c4d-1', state: 'active', at: new Date(0).toISOString() };
  const good = { state: 'ok', method: 'clone', ms: 10, entries: [{ path: 'node_modules', outcome: 'cloned', files: 2, bytes: 3, cloned: 2, written: 0 }, { path: 'dist', outcome: 'missing' }] };
  assert.equal(validWorktreeRecord({ ...base, setup: { hash: null, outcome: 'ok', copy: good } }), true);
  assert.equal(validWorktreeRecord({ ...base, setup: { outcome: 'ok', copy: { state: 'unsupported', method: null, ms: 0, entries: [] } } }), true);
  for (const bad of [{ ...good, state: 'great' }, { ...good, method: 'rsync' }, { ...good, ms: -1 }, { ...good, extra: 1 }, { ...good, entries: 'x' },
    { ...good, entries: [{ path: '../up', outcome: 'cloned' }] }, { ...good, entries: [{ path: '/abs', outcome: 'cloned' }] }, { ...good, entries: [{ path: 'a\\b', outcome: 'cloned' }] },
    { ...good, entries: [{ path: 'node_modules', outcome: 'teleported' }] }, { ...good, entries: [{ path: 'node_modules', outcome: 'cloned', files: 1.5 }] },
    { ...good, entries: [{ path: 'node_modules', outcome: 'cloned', names: ['a'] }] }, { ...good, entries: Array.from({ length: 21 }, (_, i) => ({ path: `p${i}`, outcome: 'missing' })) }]) {
    assert.equal(validWorktreeRecord({ ...base, setup: { outcome: 'ok', copy: bad } }), false, JSON.stringify(bad).slice(0, 120));
  }
});

test('catalog: every copy result and the new import and approval lines have Korean and English text', () => {
  for (const id of ['ok', 'partial', 'none', 'stopped', 'unsupported']) assert.notEqual(tr(`worktrees.copyResult.${id}`, 1), `worktrees.copyResult.${id}`);
  for (const id of ['worktrees.import.copied', 'worktrees.reviewCopyUnsupported']) assert.notEqual(tr(id, 1), id);
});
