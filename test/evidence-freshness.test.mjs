import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { buildPrompt, createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { collectGitProof, runTestProof } from '../src/evidence.mjs';
import { createTreeObserver, evidenceFreshness, freshnessText, treeFingerprint, TREE_LIMITS } from '../src/freshness.mjs';
import { validProof } from '../src/proof-schema.mjs';
import { createBackup, previewRestore, restoreBackup } from '../src/backup.mjs';
import { buildContext } from '../src/context.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { project } from './chat-helpers.mjs';
import { once } from 'node:events';

async function workspace(t) { const root = await mkdtemp(join(tmpdir(), 'wax-freshness-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function repo(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  const commit = (message) => { git('add', '-A', '--', '.', ':(exclude).wax'); git('-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message); };
  return { git, commit };
}
const pass = [process.execPath, '-e', 'process.exit(0)'];

test('test and commit proofs record a working tree fingerprint; later changes are observed per file', async (t) => {
  const root = await workspace(t), { git, commit } = repo(root);
  await writeFile(join(root, 'app.js'), 'one\n'); await writeFile(join(root, 'keep.js'), 'keep\n'); commit('fixture');
  await createFeature(root, { id: 'fresh', title: '신선도' });
  await writeFile(join(root, 'app.js'), 'two\n'); await writeFile(join(root, '새 파일.js'), 'new\n');
  const { proof } = await runTestProof(root, 'fresh', pass);
  assert.equal(proof.dirty, true);
  assert.equal(proof.tree.head, git('rev-parse', 'HEAD').trim());
  assert.deepEqual(Object.keys(proof.tree.files).sort(), ['app.js', '새 파일.js']);
  const observe = () => createTreeObserver(root)(proof.tree);
  assert.deepEqual(await observe(), { state: 'unchanged', files: [] });
  commit('same content');
  assert.deepEqual(await observe(), { state: 'unchanged', files: [] });
  await writeFile(join(root, 'keep.js'), 'edited\n'); commit('later'); await writeFile(join(root, '새 파일.js'), 'edited\n'); await writeFile(join(root, 'extra.js'), 'x');
  assert.deepEqual(await observe(), { state: 'changed', files: ['extra.js', 'keep.js', '새 파일.js'] });
  await rm(join(root, 'app.js'));
  assert.deepEqual((await observe()).files, ['app.js', 'extra.js', 'keep.js', '새 파일.js']);

  const feature = await getFeature(root, 'fresh');
  const git_ = await collectGitProof(root, feature);
  assert.equal(git_.tree.head, git('rev-parse', 'HEAD').trim());
  assert.equal(git_.tree.files['app.js'], null);
  assert.equal(validProof(git_), true);
});

test('report prompt, status freshness and context show changes since the review proof as an observation', async (t) => {
  const root = await workspace(t), { commit } = repo(root);
  await writeFile(join(root, 'app.js'), 'one\n'); commit('fixture');
  await createFeature(root, { id: 'fresh', title: '신선도' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, 'fresh', 'save', { phase, content: `${phase} 문서` });
    await updateFeature(root, 'fresh', 'complete', { phase, evidence: '확인' });
  }
  const implement = (await runTestProof(root, 'fresh', pass)).proof;
  await updateFeature(root, 'fresh', 'save', { phase: 'implement', content: '구현' });
  await updateFeature(root, 'fresh', 'complete', { phase: 'implement', evidence: '통과', proofIds: [implement.id] });
  const review = (await runTestProof(root, 'fresh', pass)).proof;
  await updateFeature(root, 'fresh', 'save', { phase: 'review', content: '검토' });
  await updateFeature(root, 'fresh', 'complete', { phase: 'review', evidence: '통과', verdict: 'pass', proofIds: [review.id] });
  let feature = await getFeature(root, 'fresh');
  assert.equal(feature.phase, 'report');
  assert.deepEqual(await evidenceFreshness(root, feature), { basis: { id: review.id, phase: 'review', at: review.at }, state: 'unchanged', count: 0, files: [] });

  await writeFile(join(root, 'app.js'), 'after review\n');
  const freshness = await evidenceFreshness(root, feature);
  assert.equal(freshness.state, 'changed'); assert.deepEqual(freshness.files, ['app.js']);
  const text = freshnessText(freshness);
  assert.match(text, /검토 근거\(.+\) 이후 바뀐 파일 1개: app\.js/); assert.match(text, /판정 아님/);
  assert.match(buildPrompt(feature, 'report', { freshness: text }), /이후 바뀐 파일 1개: app\.js/);
  assert.doesNotMatch(buildPrompt(feature, 'review', { freshness: text }), /이후 바뀐 파일/);

  const context = await buildContext(root, 'fresh');
  assert.match(context, /근거 신선도: .*검토 근거.*이후 바뀐 파일 1개: app\.js/);
  assert.match(context, /이후 바뀐 파일 1개\(\\?"app\.js\\?"\)/);

  const cli = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '../bin/wax.mjs'), 'status', 'fresh', '--project', root], { encoding: 'utf8' }));
  assert.equal(cli.evidenceFreshness.count, 1); assert.equal(cli.revision, feature.revision);
  const prompt = execFileSync(process.execPath, [join(import.meta.dirname, '../bin/wax.mjs'), 'prompt', 'report', 'fresh', '--project', root], { encoding: 'utf8' });
  assert.match(prompt, /검토 근거\(.+\) 이후 바뀐 파일 1개: app\.js/);
  feature = await getFeature(root, 'fresh');
  assert.equal(feature.evidenceFreshness, undefined);
});

test('dashboard evidence cards get the changed-file observation', async (t) => {
  const root = await project(t), { commit } = repo(root);
  await writeFile(join(root, 'app.js'), 'one\n'); commit('fixture');
  await createFeature(root, { id: 'fresh', title: '신선도' });
  const { proof } = await runTestProof(root, 'fresh', pass);
  await writeFile(join(root, 'app.js'), 'two\n');
  const server = createChatServer({ root });
  t.after(() => server.shutdown());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address();
  const body = await (await fetch(`http://127.0.0.1:${port}/api/features/fresh/proofs`)).json();
  assert.deepEqual(body.proofs.find((item) => item.id === proof.id).changed, { state: 'changed', count: 1, files: ['app.js'] });
});

test('no Git means no fingerprint; huge trees record unknown instead of stalling; old proofs stay valid and portable', async (t) => {
  const plain = await workspace(t);
  await createFeature(plain, { id: 'plain', title: '깃 없음' });
  const { proof } = await runTestProof(plain, 'plain', pass);
  assert.equal(proof.tree, undefined); assert.equal(proof.commit, null);
  assert.equal(await treeFingerprint(plain), undefined);
  assert.match(await buildContext(plain, 'plain'), /이후 변경 미확인/);
  assert.equal(await evidenceFreshness(plain, await getFeature(plain, 'plain')), null);

  const big = await workspace(t);
  repo(big);
  await mkdir(join(big, 'many'));
  for (let i = 0; i <= TREE_LIMITS.files; i++) await writeFile(join(big, 'many', `${i}.txt`), String(i));
  const tree = await treeFingerprint(big);
  assert.deepEqual(tree, { head: null, unknown: true });
  assert.deepEqual(await createTreeObserver(big)(tree), { state: 'unknown', files: [] });

  const base = { id: '00000000-0000-4000-8000-000000000000', kind: 'test', phase: 'implement', iteration: 0, at: new Date().toISOString(), command: ['x'], exitCode: 0, output: '', durationMs: 1 };
  assert.equal(validProof(base), true);
  assert.equal(validProof({ ...base, tree: { head: null, unknown: true } }), true);
  for (const tree of [null, 'x', { head: 'nope', files: {} }, { head: null }, { head: null, unknown: true, files: {} }, { head: null, files: { 'a': 'bad' } }, { head: null, files: { 'a\nb': null } }])
    assert.equal(validProof({ ...base, tree }), false, JSON.stringify(tree));

  const { commit } = repo(plain);
  await writeFile(join(plain, 'a.js'), 'a'); commit('fixture');
  await runTestProof(plain, 'plain', pass);
  const backup = await createBackup(plain), target = await workspace(t);
  const preview = await previewRestore(target, backup);
  await restoreBackup(target, backup, preview);
  const restored = await getFeature(target, 'plain');
  assert.equal(restored.proofs.length, 2); assert.equal(restored.proofs[0].tree, undefined); assert.ok(restored.proofs[1].tree.files);
});

async function gitState(top) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else { const info = await lstat(path); out.push(`${relative(top, path)} ${info.size} ${info.mtimeMs}`); }
    }
  };
  await walk(join(top, '.git'));
  return out.sort();
}

function oldFingerprint(root) {
  const git = (cwd, args, input) => execFileSync('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const list = (text) => text.split('\0').filter(Boolean);
  const [top, prefix = ''] = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']).split(/\r?\n/);
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
  const tracked = head ? list(git(root, ['diff', '--name-only', '--relative', '--no-renames', '-z', head, '--'])) : list(git(root, ['ls-files', '-z', '--cached']));
  const paths = [...new Set([...tracked, ...list(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))])].filter((path) => path !== '.wax' && !path.startsWith('.wax/')).sort();
  const files = {}, present = [];
  for (const path of paths) { if (existsSync(join(root, path))) present.push(path); else files[path] = null; }
  if (present.length) git(top, ['hash-object', '--stdin-paths'], present.map((path) => prefix + path).join('\n') + '\n').split(/\r?\n/).filter(Boolean).forEach((id, index) => { files[present[index]] = id; });
  return { head, files };
}

test('the fingerprint never writes the project .git and keeps the values of the old git diff <HEAD> version', async (t) => {
  const top = await workspace(t), { git, commit } = repo(top);
  git('config', 'core.autocrlf', 'false');
  const sub = join(top, 'app');
  await mkdir(join(sub, 'lib'), { recursive: true });
  await writeFile(join(top, '.gitattributes'), '*.txt text eol=lf\n');
  await writeFile(join(top, '.gitignore'), 'ignored.log\n');
  await writeFile(join(top, 'outside.js'), 'outside\n');
  for (const name of ['edit.js', 'gone.js', 'same.js', 'staged.js', 'old-name.js', 'uncached.js', 'lib/deep.js']) await writeFile(join(sub, name), `${name}\n`);
  await writeFile(join(sub, 'crlf.txt'), 'one\ntwo\n');
  commit('fixture');
  await createFeature(sub, { id: 'fresh', title: '신선도' });

  await writeFile(join(sub, 'edit.js'), 'edited\n');
  await rm(join(sub, 'gone.js'));
  await writeFile(join(sub, 'new.js'), 'new\n');
  await writeFile(join(sub, 'ignored.log'), 'log\n');
  await writeFile(join(sub, 'crlf.txt'), 'one\r\ntwo\r\n');
  await writeFile(join(sub, 'staged.js'), 'staged\n'); git('add', 'app/staged.js'); await writeFile(join(sub, 'staged.js'), 'staged.js\n');
  await writeFile(join(sub, 'added.js'), 'added\n'); git('add', 'app/added.js'); await rm(join(sub, 'added.js'));
  git('mv', 'app/old-name.js', 'app/new-name.js');
  git('rm', '-q', '--cached', 'app/uncached.js');
  await writeFile(join(top, 'outside.js'), 'changed outside\n');
  await mkdir(join(sub, '.wax', 'tmp'), { recursive: true }); await writeFile(join(sub, '.wax', 'tmp', 'x'), 'x');
  const later = new Date(Date.now() + 5000);
  for (const name of ['same.js', 'lib/deep.js']) await utimes(join(sub, name), later, later);

  const baseline = await gitState(top);
  const tree = await treeFingerprint(sub);
  const { proof } = await runTestProof(sub, 'fresh', pass);
  const observe = createTreeObserver(sub);
  assert.deepEqual(await observe(proof.tree), { state: 'unchanged', files: [] });
  assert.equal(await evidenceFreshness(sub, await getFeature(sub, 'fresh')), null);
  await collectGitProof(sub, await getFeature(sub, 'fresh'));
  assert.deepEqual(await createTreeObserver(sub)({ head: tree.head, files: { ...tree.files, 'edit.js': null } }), { state: 'changed', files: ['edit.js'] });
  assert.deepEqual(await gitState(top), baseline, 'treeFingerprint, runTestProof, collectGitProof and freshness checks never touch the project .git');

  assert.deepEqual(proof.tree, tree);
  assert.deepEqual(Object.keys(tree.files).sort(), ['edit.js', 'gone.js', 'new-name.js', 'new.js', 'old-name.js', 'uncached.js']);
  assert.equal(tree.files['gone.js'], null); assert.equal(tree.files['old-name.js'], null);
  assert.deepEqual(tree, oldFingerprint(sub), 'same values as the old implementation');
  assert.deepEqual(await treeFingerprint(top), oldFingerprint(top), 'same values from the repository top');
});
