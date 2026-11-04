import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PHASES, buildPrompt, createFeature, getFeature, listFeatures, updateFeature } from '../src/workflow.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function finish(root, id, phase) {
  await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n확인된 작업 내역` });
  const waiver = ['implement', 'review'].includes(phase) ? '이 테스트는 단계 진행만 확인' : undefined;
  return updateFeature(root, id, 'complete', { phase, evidence: '실제 검증 결과 기록', verdict: 'pass', waiver });
}

const testProof = (overrides = {}) => ({
  id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: '2026-10-30T00:00:00.000Z',
  command: ['node', '--test'], exitCode: 0, signal: null, timedOut: false,
  output: 'ok', durationMs: 1, commit: 'a'.repeat(40), dirty: false, ...overrides,
});

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

test('implement and review need real proof or a recorded reason, not prose alone', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'login', title: '로그인' });
  for (const phase of ['plan', 'design']) await finish(root, 'login', phase);
  await updateFeature(root, 'login', 'save', { phase: 'implement', content: '구현' });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'implement', evidence: '테스트 다 통과함' }), /구현은 .*--no-proof/);
  const failed = testProof({ exitCode: 1 });
  await updateFeature(root, 'login', 'attach-evidence', { proof: failed });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'implement', evidence: '통과', proofIds: [failed.id] }), /통과한 테스트 근거를 선택/);
  const commit = testProof({ kind: 'git', files: ['src/login.mjs'] });
  delete commit.command; delete commit.exitCode; delete commit.signal; delete commit.timedOut; delete commit.output; delete commit.durationMs;
  await updateFeature(root, 'login', 'attach-evidence', { proof: commit });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'implement', evidence: '커밋', proofIds: [commit.id], waiver: '도구 없음' }), /함께 쓰지 마세요/);
  const implemented = await updateFeature(root, 'login', 'complete', { phase: 'implement', evidence: '커밋으로 구현', proofIds: [commit.id] });
  assert.deepEqual(implemented.completed.implement.proofIds, [commit.id]);
  assert.equal(implemented.completed.implement.waiver, undefined);

  await updateFeature(root, 'login', 'save', { phase: 'review', content: '검토' });
  const reviewCommit = { ...commit, id: randomUUID(), phase: 'review' };
  await updateFeature(root, 'login', 'attach-evidence', { proof: reviewCommit });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'review', evidence: '커밋만', verdict: 'pass', proofIds: [reviewCommit.id] }), /검토는 .*통과한 테스트 근거/);
  const passed = testProof({ phase: 'review' });
  await updateFeature(root, 'login', 'attach-evidence', { proof: passed });
  const reviewed = await updateFeature(root, 'login', 'complete', { phase: 'review', evidence: '수용 기준 테스트 통과', verdict: 'pass', proofIds: [passed.id] });
  assert.equal(reviewed.phase, 'report');

  await updateFeature(root, 'login', 'save', { phase: 'report', content: '보고' });
  await assert.rejects(updateFeature(root, 'login', 'complete', { phase: 'report', evidence: '보고', waiver: '필요 없음' }), /구현·검토 단계에만/);
});

test('a recorded reason completes without proof and is kept with the completion', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'docs', title: '문서 정리' });
  for (const phase of ['plan', 'design']) await finish(root, 'docs', phase);
  await updateFeature(root, 'docs', 'save', { phase: 'implement', content: '구현' });
  await assert.rejects(updateFeature(root, 'docs', 'complete', { phase: 'implement', evidence: '완료', waiver: '  ' }), /근거 없이 완료하는 사유/);
  const done = await updateFeature(root, 'docs', 'complete', { phase: 'implement', evidence: '문서만 고침', waiver: '실행할 코드가 없는 문서 변경' });
  assert.equal(done.completed.implement.waiver, '실행할 코드가 없는 문서 변경');
  assert.equal((await getFeature(root, 'docs')).completed.implement.waiver, '실행할 코드가 없는 문서 변경');
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

test('review prompts check role flows, recovery, data accuracy and volume in order, and ask why each finding matters', () => {
  const feature = { id: 'pay', title: '정산', description: '', projectType: 'general', artifacts: {}, completed: {} };
  const review = buildPrompt(feature, 'review');
  const order = ['역할별 핵심 흐름', '서버에서도 막히는지', '확인·취소·수정 경로', '원본 데이터와 맞는지', '실제에 가까운 데이터 양', '로딩·오류·빈 화면'];
  const at = order.map((text) => review.indexOf(text));
  assert.ok(at.every((index) => index > 0), `missing: ${order.filter((_, i) => at[i] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'structure → function → efficiency → presentation');
  assert.match(review, /해당 없음과 이유/);
  assert.match(review, /누가 어떤 상황에서 왜 곤란한지/);
  assert.match(buildPrompt(feature, 'plan'), /역할별로 무엇을 먼저 보고 하며 무엇을 볼 수 없어야 하는지/);
  assert.match(buildPrompt({ ...feature, projectType: 'web' }, 'review'), /역할별 로그인으로 볼 수 없어야 할 화면·요청이 막히는지/);
});
