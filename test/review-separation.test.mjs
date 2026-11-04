import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createFeature, getFeature, importFeature, reviewSeparationMode, updateFeature, validateStored } from '../src/workflow.mjs';
import { buildContext } from '../src/context.mjs';
import { collectDay } from '../src/chat/daily.mjs';
import { translate } from '../web/locale-core.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const waiver = '이 테스트는 단계 진행만 확인';
async function finish(root, id, phase, extra = {}) {
  await updateFeature(root, id, 'save', { phase, content: `# ${phase}\n확인된 작업 내역` });
  return updateFeature(root, id, 'complete', { phase, evidence: '실제 검증 결과 기록', verdict: 'pass', ...(['implement', 'review'].includes(phase) ? { waiver } : {}), ...extra });
}
async function toReview(root, id, implementer) {
  await createFeature(root, { id, title: '로그인' });
  for (const phase of ['plan', 'design']) await finish(root, id, phase, { author: implementer });
  await finish(root, id, 'implement', { author: implementer });
  await updateFeature(root, id, 'save', { phase: 'review', content: '# 검토' });
}
const review = (root, id, extra = {}) => updateFeature(root, id, 'complete', { phase: 'review', evidence: '수용 기준 확인', verdict: 'pass', waiver, ...extra });

test('phase completion records the completing session in the record and history', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'login', 'codex-1');
  const feature = await getFeature(root, 'login');
  assert.equal(feature.completed.implement.author, 'codex-1');
  assert.equal(feature.history.at(-2).author, 'codex-1');
  assert.equal(feature.history.at(-2).action, 'complete');
  await assert.rejects(review(root, 'login', { author: '-bad' }), /완료한 세션 이름/);
  const reviewed = await review(root, 'login', { author: 'claude-1' });
  assert.equal(reviewed.completed.review.author, 'claude-1');
  assert.equal(reviewed.completed.review.warning, undefined);
});

test('the implementing session reviewing its own work is warned by default, refused under enforce', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'login', 'codex-1');
  await assert.rejects(review(root, 'login', { author: 'codex-1', reviewSeparation: 'enforce' }), (error) => error.status === 409 && /구현한 세션\(codex-1\)/.test(error.message));
  await assert.rejects(review(root, 'login', { reviewSeparation: 'enforce' }), (error) => error.status === 409 && /--author/.test(error.message));
  assert.equal((await getFeature(root, 'login')).phase, 'review');
  const warned = await review(root, 'login', { author: 'codex-1' });
  assert.match(warned.completed.review.warning, /구현한 세션\(codex-1\)이 검토를 완료했습니다/);
  assert.equal(warned.history.at(-1).warning, warned.completed.review.warning);
  assert.equal(warned.phase, 'report');
  assert.match(await buildContext(root, 'login'), /완료 세션 "?codex-1"?, 경고: .*구현한 세션/);
  const day = await collectDay(root, undefined, { now: new Date(warned.updatedAt) });
  const event = day.events.find((item) => item.type === 'phase' && item.phase === 'review');
  assert.equal(event.author, 'codex-1');
  assert.match(event.title, /검토 단계 완료 · codex-1/);
  assert.match(event.detail, /^\[경고\] 구현한 세션/);
  assert.equal(translate('검토 단계 완료 · codex-1'), 'Review stage completed · codex-1');
});

test('implement proof authors count as the implementing session; off skips the check', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'login', title: '로그인' });
  for (const phase of ['plan', 'design']) await finish(root, 'login', phase);
  await updateFeature(root, 'login', 'save', { phase: 'implement', content: '구현' });
  const proof = { id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: new Date().toISOString(), command: ['node', '--test'], exitCode: 0, signal: null, timedOut: false, output: 'ok', durationMs: 1, author: 'gemini-1' };
  await updateFeature(root, 'login', 'attach-evidence', { proof });
  await updateFeature(root, 'login', 'complete', { phase: 'implement', evidence: '테스트 통과', proofIds: [proof.id] });
  await updateFeature(root, 'login', 'save', { phase: 'review', content: '검토' });
  await assert.rejects(review(root, 'login', { author: 'gemini-1', reviewSeparation: 'enforce' }), /구현한 세션\(gemini-1\)/);
  assert.equal((await review(root, 'login', { author: 'gemini-1', reviewSeparation: 'off' })).completed.review.warning, undefined);
});

test('an unknown implementer warns without blocking enforce; the mode comes from WAX_REVIEW_SEPARATION', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'login');
  const reviewed = await review(root, 'login', { author: 'claude-1', reviewSeparation: 'enforce' });
  assert.match(reviewed.completed.review.warning, /구현 세션 기록이 없어/);
  assert.equal(reviewSeparationMode(undefined), 'warn');
  assert.equal(reviewSeparationMode('enforce'), 'enforce');
  assert.throws(() => reviewSeparationMode('strict'), /warn·enforce·off/);
});

test('records and backups without a completing session stay valid and importable', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'login', 'codex-1');
  const path = join(root, '.wax', 'features', 'login.json');
  const old = JSON.parse(await readFile(path, 'utf8'));
  for (const completion of Object.values(old.completed)) delete completion.author;
  for (const event of old.history) delete event.author;
  await writeFile(path, JSON.stringify(old));
  assert.equal(validateStored(await getFeature(root, 'login')).completed.implement.author, undefined);
  await importFeature(root, old, 'login-copy');
  assert.equal((await getFeature(root, 'login-copy')).phase, 'review');
  assert.throws(() => validateStored({ ...old, completed: { ...old.completed, plan: { ...old.completed.plan, author: '' } } }), /데이터 형식/);
  assert.throws(() => validateStored({ ...old, completed: { ...old.completed, plan: { ...old.completed.plan, warning: 'x'.repeat(501) } } }), /데이터 형식/);
});

test('CLI complete takes --author, prints the warning and honors WAX_REVIEW_SEPARATION', async (t) => {
  const root = await workspace(t);
  await toReview(root, 'login', 'codex-1');
  const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
  const run = (env) => spawnSync(process.execPath, [cli, 'complete', 'review', 'login', '--evidence', '확인', '--verdict', 'pass', '--no-proof', waiver, '--author', 'codex-1', '--project', root], { encoding: 'utf8', env: { ...process.env, ...env } });
  const refused = run({ WAX_REVIEW_SEPARATION: 'enforce' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /구현한 세션\(codex-1\).*WAX_REVIEW_SEPARATION=enforce/);
  const warned = run({ WAX_REVIEW_SEPARATION: '' });
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /wax: 경고: 구현한 세션\(codex-1\)/);
  assert.equal(JSON.parse(warned.stdout).completed.review.author, 'codex-1');
});
