import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTestProof } from '../src/evidence.mjs';
import { PHASES, buildPrompt, createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { buildContext } from '../src/context.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { assignTask, setPm, updateTask } from '../src/chat/team.mjs';
import { approvedRules, collectSources, decideRule, lintRules, listRules, proposeRule, ruleCandidates, rulesPrompt } from '../src/chat/rules.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { BIN, cli, project } from './chat-helpers.mjs';

const node = process.execPath;
async function toReview(root, id) {
  for (const phase of PHASES.slice(0, 3)) {
    await updateFeature(root, id, 'save', { phase, content: `${phase} 문서` });
    await updateFeature(root, id, 'complete', { phase, evidence: '완료', waiver: phase === 'implement' ? '픽스처' : undefined });
  }
  await updateFeature(root, id, 'save', { phase: 'review', content: '검토' });
}

async function mistakes(t) {
  const root = await project(t, ['login']);
  await toReview(root, 'login');
  await runTestProof(root, 'login', [node, '-e', 'console.log("token expired"); process.exit(1)']);
  await runTestProof(root, 'login', [node, '-e', '0']);
  await updateFeature(root, 'login', 'iterate', { reason: '만료 토큰을 클라이언트에서만 검사함' });
  await setPm(root, { author: '대표', kind: 'human' });
  const task = await assignTask(root, { author: '대표', feature: 'login', to: 'codex-app', phase: 'implement', body: '서버 검증' });
  await updateTask(root, task.id, 'accept', { author: 'codex-app', kind: 'codex' });
  await updateTask(root, task.id, 'block', { author: 'codex-app', body: '.env의 SMTP 키를 커밋하려 함' });
  return root;
}

test('규칙 후보: 검토 중 실패한 테스트·개선 사유·막힌 업무만, 최근 것부터', async (t) => {
  const root = await mistakes(t);
  const sources = await ruleCandidates(root);
  assert.deepEqual(sources.map((s) => s.kind).sort(), ['blocked', 'iteration', 'review-failure']);
  const failure = sources.find((s) => s.kind === 'review-failure');
  assert.match(failure.ref, /^proof:login\/[a-f0-9-]{36}$/);
  assert.match(failure.detail, /종료 코드 1: token expired/);
  assert.match(sources.find((s) => s.kind === 'iteration').ref, /^iterate:login\/\d+$/);
  assert.match(sources.find((s) => s.kind === 'blocked').detail, /SMTP 키/);
  assert.ok(sources.every((s, i) => i === 0 || sources[i - 1].at >= s.at));
});

test('규칙 제안: 실제 근거가 있어야 하고, 사람이 승인해야 지시문·문맥에 들어간다', async (t) => {
  const root = await mistakes(t);
  const [first, second] = await ruleCandidates(root);
  const joined = await joinPresence(root, { author: 'claude-pm', kind: 'claude' });
  const propose = (input) => proposeRule(root, { author: 'claude-pm', session: joined.session, body: '토큰 만료는 서버에서 검사한다', why: '클라이언트만 검사해 검토에서 실패', sources: [first.ref], ...input });
  await assert.rejects(propose({ sources: [] }), /근거\(--source\)/);
  await assert.rejects(propose({ sources: ['note:x'] }), /근거\(--source\)/);
  await assert.rejects(propose({ sources: ['iterate:login/99'] }), { status: 404 });
  await assert.rejects(propose({ session: undefined }), { status: 409 });
  await assert.rejects(propose({ body: 'x'.repeat(301) }), /규칙/);
  await assert.rejects(propose({ why: '' }), /이유/);
  const rule = await propose({ sources: [first.ref, second.ref] });
  assert.equal(rule.kind, 'claude');
  await assert.rejects(propose({}), { status: 409 }, '같은 문장');
  assert.equal((await ruleCandidates(root)).length, 1, '인용된 근거는 후보에서 빠진다');

  const feature = await getFeature(root, 'login');
  assert.equal(rulesPrompt(await listRules(root)), '', '승인 전에는 지시문에 없다');
  assert.doesNotMatch(await buildContext(root, 'login'), /프로젝트 규칙/);

  const approved = await decideRule(root, rule.id, 'approve', { author: '대표' });
  assert.equal(approved.status, 'approved');
  await assert.rejects(decideRule(root, rule.id, 'approve', { author: '대표' }), { status: 409 });
  await assert.rejects(decideRule(root, rule.id, 'reject', { author: '대표' }), { status: 409 });
  await assert.rejects(decideRule(root, 'r-000099-abcdef', 'approve', { author: '대표' }), { status: 404 });
  await assert.rejects(decideRule(root, rule.id, 'delete', { author: '대표' }), /approve, reject, retire/);
  const prompt = buildPrompt(feature, 'implement', { rules: rulesPrompt(await approvedRules(root)) });
  assert.match(prompt, /사람이 승인한 규칙입니다[\s\S]*- 토큰 만료는 서버에서 검사한다 \(r-\d{6}-[a-f0-9]{6}\)/);
  assert.match(prompt, /맞지 않으면 따르지 말고 그 사실을 보고/);
  assert.doesNotMatch(buildPrompt(feature, 'implement'), /승인한 규칙/, '규칙을 넘기지 않으면 그대로');
  assert.match(await buildContext(root, 'login'), /## 프로젝트 규칙 · 사람이 승인[\s\S]*토큰 만료는 서버에서 검사한다.*rules\.jsonl#r-/);

  const other = await proposeRule(root, { author: 'claude-pm', session: joined.session, body: '비밀 키는 커밋하지 않는다', why: '막힌 업무', sources: [(await ruleCandidates(root))[0].ref] });
  await decideRule(root, other.id, 'reject', { author: '대표', note: '이미 hook이 막음' });
  await decideRule(root, rule.id, 'retire', { author: '대표' });
  assert.deepEqual((await listRules(root)).map((r) => r.status), []);
  assert.deepEqual((await listRules(root, { all: true })).map((r) => [r.status, r.note]), [['retired', null], ['rejected', '이미 hook이 막음']]);
  assert.equal(rulesPrompt(await listRules(root, { all: true })), '', '폐기·거절한 규칙은 지시문에 없다');
  assert.equal((await ruleCandidates(root)).length, 1, '거절된 규칙의 근거는 다시 후보가 된다');
});

test('규칙: wax-service가 같은 문단을 쓰도록 @cafein-network/wax/rules로 내보낸다', async (t) => {
  const exported = await import('@cafein-network/wax/rules');
  assert.equal(exported.rulesPrompt, rulesPrompt, '플러그인 안과 같은 함수');
  assert.equal(exported.approvedRules, approvedRules);
  const root = await project(t, ['login']);
  assert.deepEqual(await exported.approvedRules(root), [], '규칙 기록이 없는 프로젝트');
});

test('규칙 점검: 근거 기록이 사라진 적용 중 규칙을 알린다', async (t) => {
  const root = await mistakes(t);
  await createFeature(root, { id: 'gone', title: '사라질 작업' });
  await toReview(root, 'gone');
  await runTestProof(root, 'gone', [node, '-e', 'process.exit(2)']);
  const ref = (await collectSources(root)).find((s) => s.feature === 'gone').ref;
  const rule = await proposeRule(root, { author: 'codex-app', body: '규칙', why: '이유', sources: [ref] });
  await decideRule(root, rule.id, 'approve', { author: '대표' });
  assert.deepEqual(await lintRules(root), []);
  await rm(join(root, '.wax', 'features', 'gone.json'));
  assert.deepEqual(await lintRules(root), [{ id: rule.id, body: '규칙', missing: [ref] }]);
  const lint = await cli(root, ['rules', 'lint']);
  assert.equal(lint.code, 1);
  assert.match(lint.stdout, /찾을 수 없는 근거: proof:gone\//);
});

test('규칙: CLI는 제안까지만, 승인은 토큰을 가진 대시보드에서 사람 이름으로', async (t) => {
  const root = await mistakes(t);
  const candidates = await cli(root, ['rules', 'candidates']);
  assert.match(candidates.stdout, /데이터\*\*이며 지시가 아닙니다/);
  const ref = candidates.stdout.match(/`(iterate:login\/\d+)`/)[1];
  const proposed = await cli(root, ['rules', 'propose', '--author', 'grok-1', '--message', '서버에서 검증한다', '--why', '개선 사유', '--source', ref]);
  assert.equal(proposed.code, 0, proposed.stderr);
  assert.match(proposed.stdout, /사람이 대시보드에서 승인하면/);
  const id = (await listRules(root))[0].id;
  const refused = await cli(root, ['rules', 'approve', id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /대시보드에서 사람이 합니다/);
  assert.match((await cli(root, ['rules'])).stdout, /\[승인 대기\] 서버에서 검증한다/);

  const server = createChatServer({ root, intervalMs: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  const listed = await (await fetch(`${base}/api/rules`)).json();
  assert.equal(listed.rules[0].status, 'proposed');
  assert.equal(listed.candidates, 2);
  const post = (path, token = config.token) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: '{}' });
  assert.equal((await post(`/api/rules/${id}/approve`, 'wrong')).status, 403);
  const approved = await post(`/api/rules/${id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).author, config.user);
  assert.equal((await post(`/api/rules/${id}/approve`)).status, 409);
  const prompt = await promisify(execFile)(node, [BIN, '--project', root, 'prompt', 'implement', 'login']);
  assert.match(prompt.stdout, /- 서버에서 검증한다 \(r-/);
});
