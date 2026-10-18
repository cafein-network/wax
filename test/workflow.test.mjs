import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PHASES, buildPrompt, createFeature, getFeature, listFeatures, updateFeature } from '../src/workflow.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function finish(root, id, phase) {
  await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n확인된 작업 내역` });
  return updateFeature(root, id, 'complete', { phase, evidence: '실제 검증 결과 기록', verdict: 'pass' });
}

test('full lifecycle persists across sessions and retains evidence', async (t) => {
  const root = await workspace(t);
  assert.deepEqual(await listFeatures(root), []);
  await createFeature(root, { id: 'login', title: '로그인' });
  for (const phase of PHASES) await finish(root, 'login', phase);
  const state = await getFeature(root, 'login');
  assert.equal(state.phase, 'done');
  assert.equal(state.revision, 11);
  assert.equal(state.completed.review.verdict, 'pass');
  assert.equal((await listFeatures(root)).length, 1);
});

test('gates reject skipped phases, empty evidence, and unchecked review', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'login', title: '로그인' });
  await assert.rejects(updateFeature(root, 'login', 'save', { phase: 'design', content: '설계' }), { status: 409 });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'plan', evidence: '완료' }), { status: 409 });
  await updateFeature(root, 'login', 'save', { phase: 'plan', content: '기획' });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'plan', evidence: '' }), { status: 400 });
  for (const phase of ['plan', 'design', 'implement']) await finish(root, 'login', phase);
  await updateFeature(root, 'login', 'save', { phase: 'review', content: '검토' });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'review', evidence: '테스트' }), { status: 409 });
  assert.equal((await getFeature(root, 'login')).phase, 'review');
});

test('iteration archives artifacts and invalidates downstream completion', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'fix', title: '개선' });
  for (const phase of PHASES) await finish(root, 'fix', phase);
  const next = await updateFeature(root, 'fix', 'iterate', { reason: '경계 조건 수정' });
  assert.equal(next.phase, 'implement');
  assert.equal(next.iteration, 1);
  assert.equal(next.completed.review, undefined);
  assert.equal(next.artifacts.implement, undefined);
  assert.ok(next.artifacts.design);
  assert.ok(next.history.find((event) => event.action === 'archive').artifacts.review);
});

test('duplicate creation and stale edits do not overwrite data', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'task', title: '원본' });
  await assert.rejects(createFeature(root, { id: 'task', title: '덮어쓰기' }), { status: 409 });
  await updateFeature(root, 'task', 'save', { phase: 'plan', content: '첫 수정', revision: 1 });
  await assert.rejects(updateFeature(root, 'task', 'save', { phase: 'plan', content: '오래된 수정', revision: 1 }), { status: 409 });
  assert.equal((await getFeature(root, 'task')).artifacts.plan, '첫 수정');
  const results = await Promise.allSettled([
    updateFeature(root, 'task', 'save', { phase: 'plan', content: 'A', revision: 2 }),
    updateFeature(root, 'task', 'save', { phase: 'plan', content: 'B', revision: 2 })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
});

test('path traversal, symlink data roots, and damaged JSON are rejected', async (t) => {
  const root = await workspace(t);
  await assert.rejects(createFeature(root, { id: '../outside', title: 'bad' }), { status: 400 });
  const outside = await workspace(t);
  await symlink(outside, join(root, '.wax'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(listFeatures(root), /심볼릭 링크/);
  await rm(join(root, '.wax'));
  await mkdir(join(root, '.wax', 'features'), { recursive: true });
  await writeFile(join(root, '.wax', 'features', 'bad.json'), '{');
  await assert.rejects(getFeature(root, 'bad'), /손상/);
});

test('CLI handles paths with spaces and returns usable prompts', async (t) => {
  const root = join(await workspace(t), 'project with spaces');
  const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'start', 'hello', '--title', 'hello $world', '--project', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).title, 'hello $world');
  const feature = await getFeature(root, 'hello');
  assert.match(buildPrompt(feature), /수용 기준/);
  const prompt = execFileSync(process.execPath, [cli, 'prompt', 'plan', 'hello', '--project', root], { encoding: 'utf8' });
  assert.match(prompt, /hello \$world/);
});

test('malformed stored records are rejected before an edit can discard data', async (t) => {
  const root = await workspace(t);
  const feature = await createFeature(root, { id: 'damaged', title: '원본' });
  const path = join(root, '.wax', 'features', 'damaged.json');
  for (const changes of [
    { artifacts: [] }, { artifacts: { plan: 42 } }, { artifacts: { unknown: '문서' } },
    { completed: [] }, { completed: { plan: { at: feature.createdAt, evidence: '' } } },
    { completed: { review: { at: feature.createdAt, evidence: '검증', verdict: 'fail' } } },
    { title: null }, { description: {} }, { iteration: -1 }, { revision: 1.5 },
    { updatedAt: 'invalid' }, { createdAt: null }, { history: [null] }
  ]) {
    const content = JSON.stringify({ ...feature, ...changes });
    await writeFile(path, content);
    await assert.rejects(getFeature(root, 'damaged'), { status: 500, message: /damaged.*데이터 형식/ });
    await assert.rejects(updateFeature(root, 'damaged', 'save', { phase: 'plan', content: '새 문서' }), { status: 500 });
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

test('CLI version flags report the installed package version', async () => {
  const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-v']) {
    assert.equal(execFileSync(process.execPath, [cli, flag], { encoding: 'utf8' }).trim(), version);
  }
});

test('metadata edits and archive/restore retain documents, history and revision protection', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'organize', title: '원래 제목', description: '기존 설명' });
  await updateFeature(root, 'organize', 'save', { phase: 'plan', content: '보존할 문서', revision: 1 });
  await assert.rejects(updateFeature(root, 'organize', 'edit', { title: 'stale', description: '', revision: 1 }), { status: 409 });
  await assert.rejects(updateFeature(root, 'organize', 'edit', { title: '', description: '', revision: 2 }), { status: 400 });
  const edited = await updateFeature(root, 'organize', 'edit', { title: '바꾼 제목', description: '', revision: 2 });
  assert.equal(edited.title, '바꾼 제목');
  assert.deepEqual(edited.history.at(-1).changes, { before: { title: '원래 제목', description: '기존 설명' }, after: { title: '바꾼 제목', description: '' } });
  const archived = await updateFeature(root, 'organize', 'archive-feature', { revision: 3 });
  assert.ok(archived.archivedAt);
  for (const action of ['save', 'complete', 'iterate', 'edit', 'archive-feature']) {
    await assert.rejects(updateFeature(root, 'organize', action, { phase: 'plan', content: '덮어쓰기', revision: 4 }), { status: 409 });
  }
  await assert.rejects(updateFeature(root, 'organize', 'restore', { revision: 3 }), { status: 409 });
  const restored = await updateFeature(root, 'organize', 'restore', { revision: 4 });
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.artifacts.plan, '보존할 문서');
  assert.equal(restored.phase, 'plan');
  assert.equal(restored.revision, 5);
  assert.deepEqual(restored.history.slice(-3).map((event) => event.action), ['edit', 'archive-feature', 'restore']);
  assert.equal((await listFeatures(root)).length, 1);
});

test('CLI can edit, archive and restore using explicit revisions', async (t) => {
  const root = await workspace(t);
  const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
  await createFeature(root, { id: 'cli', title: '처음' });
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8' }));
  assert.equal(run('edit', 'cli', '--title', '수정', '--description', '', '--revision', '1').title, '수정');
  assert.ok(run('archive', 'cli', '--revision', '2').archivedAt);
  assert.equal(run('restore', 'cli', '--revision', '3').archivedAt, null);
});
