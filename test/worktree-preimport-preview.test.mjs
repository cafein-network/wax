import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { project } from './chat-helpers.mjs';
import { prepareWorktree } from '../src/worktree-make.mjs';
import { decideSetup, setupReview } from '../src/worktree-setup.mjs';
import { mergeTreeSupported } from '../src/worktree-import.mjs';
import { tailLines } from '../src/worktree-preimport.mjs';
import { createGoal, importWorktree, previewWorktreeImport, readDecisions, readGoal, startWorktreeChecks, stopWorktreeChecks } from '../src/chat/pm-loop.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root, message = 'fixture') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message); };
const modern = mergeTreeSupported(git(process.cwd(), '--version').match(/(\d+\.\d+)/)[1]);
const person = '대표';
const free = { portProbe: async () => 'free' };
const SCRIPTS = {
  'checks/gate.mjs': 'import { readFileSync } from "node:fs";\nfor (let i = 1; i <= 50; i++) console.log(`line ${i}`);\nif (readFileSync("shared.txt", "utf8").includes("BROKEN")) { console.error("shared.txt is BROKEN"); process.exit(1); }\nconsole.log("all good");\n',
  'checks/hang.mjs': 'console.log("waiting"); setInterval(() => {}, 1000);\n',
};
const GATE = [[process.execPath, 'checks/gate.mjs']];

async function setup(t, checks = GATE) {
  const root = await project(t, ['f1']);
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), '.wax/\n.env*\n');
  await writeFile(join(root, 'shared.txt'), 'line\n');
  await mkdir(join(root, 'checks'));
  for (const [path, text] of Object.entries(SCRIPTS)) await writeFile(join(root, path), text);
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  if (checks) await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ checks }));
  commit(root);
  if (checks) await decideSetup(root, { author: person, hash: (await setupReview(root)).hash });
  const goal = await readGoal(root, (await createGoal(root, { title: '검사', features: ['f1'], worktrees: true }, { author: person })).id);
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
const stale = (error) => error.status === 409 && /가져오기 전 검사가 지금 워크트리와 HEAD에서 통과하지 않아/.test(error.message);

test('the preview blocks the import until the last run passed for the current key: not run → failed → changed since (stale) → passed → import, with seq·key·outcome on the import record', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'line\nBROKEN\n');
  const before = await gitFiles(root);
  let preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(preview.checks.required, true);
  assert.equal(preview.checks.state, 'notRun');
  assert.equal(preview.checks.source, 'config');
  assert.deepEqual(preview.checks.commands, GATE);
  assert.equal(preview.ready, false);
  assert.equal('checksGate' in preview, false, 'internal gate data stays on the server');
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: preview.fingerprint }), stale);
  const failed = await (await startWorktreeChecks(root, goal.id, one.id, { author: person })).job;
  assert.equal(failed.outcome, 'failed');
  preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(preview.checks.state, 'failed');
  assert.equal(preview.checks.current, true);
  assert.equal(preview.checks.last.seq, failed.seq);
  assert.equal(preview.checks.last.by, person);
  const [row] = preview.checks.last.results;
  assert.deepEqual([row.outcome, row.exitCode, row.cut], ['failed', 1, true]);
  assert.equal(row.tail.split('\n').length, 40);
  assert.match(row.tail, /shared\.txt is BROKEN/);
  assert.doesNotMatch(row.tail, /^line 1$/m);
  assert.equal(preview.ready, false);
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: preview.fingerprint }), stale);
  await writeFile(join(one.path, 'shared.txt'), 'line\nfixed\n');
  preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(preview.checks.state, 'stale');
  assert.equal(preview.checks.current, false);
  assert.equal(preview.checks.last.seq, failed.seq, 'the old result is still shown');
  assert.equal(preview.ready, false);
  const passed = await (await startWorktreeChecks(root, goal.id, one.id, { author: person })).job;
  assert.equal(passed.outcome, 'passed');
  preview = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.deepEqual([preview.checks.state, preview.checks.current, preview.checks.passed], ['passed', true, true]);
  assert.equal(preview.checks.last.behind, 0);
  assert.equal(preview.ready, true);
  assert.deepEqual(await gitFiles(root), before, 'previews and checks do not change the project .git');
  const result = await importWorktree(root, goal.id, one.id, { author: person, fingerprint: preview.fingerprint });
  assert.deepEqual(result.imported, ['shared.txt']);
  assert.deepEqual(result.checks, { seq: passed.seq, key: passed.key, outcome: 'passed', commands: 1 });
  assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'line\nfixed\n');
  const record = (await readDecisions(root, goal.id)).find((item) => item.kind === 'worktree-import');
  assert.deepEqual(record.checks, { seq: passed.seq, key: passed.key, outcome: 'passed' });
  assert.match(record.reason, /가져오기 전 검사 통과\(명령 1개\)/);
});

test('a passed result goes stale when main moves (409 checksStale even with the old fingerprint); a new run keeps behind for the preview notice', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'line\nfine\n');
  await (await startWorktreeChecks(root, goal.id, one.id, { author: person })).job;
  const ready = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(ready.ready, true);
  await writeFile(join(root, 'later.txt'), 'main moved\n');
  commit(root, 'main moves');
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: ready.fingerprint }), stale);
  const moved = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(moved.checks.state, 'stale');
  assert.notEqual(moved.fingerprint, ready.fingerprint);
  const again = await (await startWorktreeChecks(root, goal.id, one.id, { author: person })).job;
  assert.equal(again.behind, 1);
  const fresh = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.deepEqual([fresh.checks.state, fresh.checks.last.behind], ['passed', 1]);
  assert.equal(fresh.ready, true);
});

test('no checks import as before (W10); a running check blocks the import; unapproved checks block it unless the start-screen command is used', { skip: !modern }, async (t) => {
  const none = await setup(t, null);
  await writeFile(join(none.one.path, 'shared.txt'), 'line\nplain\n');
  const plain = await previewWorktreeImport(none.root, none.goal.id, none.one.id, { author: person });
  assert.deepEqual([plain.checks.required, plain.checks.reason, plain.ready], [false, 'none', true]);
  const done = await importWorktree(none.root, none.goal.id, none.one.id, { author: person, fingerprint: plain.fingerprint });
  assert.equal(done.checks, undefined);
  assert.equal((await readDecisions(none.root, none.goal.id)).find((item) => item.kind === 'worktree-import').checks, undefined);

  const { root, goal, one } = await setup(t, [[process.execPath, 'checks/hang.mjs']]);
  await writeFile(join(one.path, 'shared.txt'), 'line\nwaiting\n');
  const running = await startWorktreeChecks(root, goal.id, one.id, { author: person });
  const during = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.equal(during.checks.state, 'running');
  assert.equal(during.checks.running.worktree, one.id);
  assert.equal(during.ready, false);
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: during.fingerprint }), stale);
  await stopWorktreeChecks(root, goal.id, one.id, { author: person });
  await running.job;
  const stopped = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.deepEqual([stopped.checks.state, stopped.checks.last.outcome, stopped.ready], ['failed', 'stopped', false]);
  await writeFile(join(root, 'docs', 'wax', 'worktree.json'), JSON.stringify({ checks: GATE }));
  commit(root, 'checks changed after approval');
  const changed = await previewWorktreeImport(root, goal.id, one.id, { author: person });
  assert.deepEqual([changed.checks.required, changed.checks.state, changed.checks.source, changed.ready], [true, 'unapproved', null, false]);
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: changed.fingerprint }), (error) => error.status === 409 && /승인 전이거나/.test(error.message));
  const shell = await previewWorktreeImport(root, goal.id, one.id, { author: person, testCommand: 'node checks/gate.mjs | tail' });
  assert.deepEqual([shell.checks.state, shell.ready], ['shell', false]);
  const start = await previewWorktreeImport(root, goal.id, one.id, { author: person, testCommand: 'node checks/gate.mjs' });
  assert.deepEqual([start.checks.source, start.checks.state], ['start', 'stale'], 'the stopped run used other commands');
  const record = await (await startWorktreeChecks(root, goal.id, one.id, { author: person, testCommand: 'node checks/gate.mjs' })).job;
  assert.equal(record.outcome, 'passed');
  const ok = await previewWorktreeImport(root, goal.id, one.id, { author: person, testCommand: 'node checks/gate.mjs' });
  assert.equal(ok.ready, true);
  await assert.rejects(importWorktree(root, goal.id, one.id, { author: person, fingerprint: ok.fingerprint }), (error) => error.status === 409);
  const imported = await importWorktree(root, goal.id, one.id, { author: person, fingerprint: ok.fingerprint, testCommand: 'node checks/gate.mjs' });
  assert.equal(imported.checks.outcome, 'passed');
});

test('dashboard API: the preview carries the checks block and the import answers 409 with the checksStale message', { skip: !modern }, async (t) => {
  const { root, goal, one } = await setup(t);
  await writeFile(join(one.path, 'shared.txt'), 'line\nBROKEN\n');
  const server = createChatServer({ root, env: { WAX_CHAT_USER: person, WAX_TOOL_NEWS: 'off' }, intervalMs: 30, requestTools: async () => [] });
  await server.startWatching();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/config`)).json();
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify(body) });
  const route = `/api/pm-loop/${goal.id}/worktrees/${one.id}`;
  const preview = await (await post(`${route}/import-preview`, {})).json();
  assert.equal(preview.checks.state, 'notRun');
  assert.equal(preview.ready, false);
  const refused = await post(`${route}/import`, { fingerprint: preview.fingerprint });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /가져오기 전 검사가 지금 워크트리와 HEAD에서 통과하지 않아/);
});

test('output tail for the screen: the last 40 lines, CRLF shown as line breaks only', () => {
  const text = Array.from({ length: 45 }, (_, i) => `l${i + 1}`).join('\r\n');
  const tail = tailLines(`${text}\r\n`);
  assert.equal(tail.cut, true);
  assert.equal(tail.text.split('\n').length, 40);
  assert.equal(tail.text.startsWith('l6\n'), true);
  assert.doesNotMatch(tail.text, /\r/);
  assert.deepEqual(tailLines('one\ntwo'), { text: 'one\ntwo', cut: false });
});
