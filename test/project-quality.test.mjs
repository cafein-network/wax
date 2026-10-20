import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { project, createTestSymlink } from './chat-helpers.mjs';
import { createFeature, getFeature, listFeatures, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { assessQuality } from '../src/quality.mjs';
import { projectType, qualityRequirements } from '../web/project-types.mjs';
import { createRequestRunner } from '../src/chat/requests.mjs';
import { officeScene } from '../web/office/model.mjs';
import { SIDE_ROOMS, BUILDING } from '../web/office/side-rooms.mjs';
import { requestAction } from '../web/start-guide.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const record = (id, proofIds = [], artifact = '', status = 'pass') => ({ id, proofIds, artifact, status, detail: '명시적인 테스트 픽스처 결과' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function next(root, feature, checks = [], proofIds = []) {
  feature = await updateFeature(root, feature.id, 'save', { phase: feature.phase, content: '# 단계 기록', revision: feature.revision });
  return updateFeature(root, feature.id, 'complete', { phase: feature.phase, revision: feature.revision, evidence: '픽스처', verdict: 'pass', checks, proofIds });
}
async function proof(root, feature, kind, id, code = 'require("node:assert/strict").equal(2 + 2, 4)') {
  const result = await runTestProof(root, feature.id, [process.execPath, '-e', code], { revision: feature.revision, verification: kind, checks: [id] });
  assert.equal(result.recorded, true); return result;
}
test('project types detect Roblox/lookbook, allow explicit choice, and keep SM design concise', () => {
  assert.equal(projectType('auto', '로블룩스 게임'), 'roblox');
  assert.equal(projectType('auto', 'FASHN api 룩북'), 'lookbook');
  assert.equal(projectType('general', 'Roblox'), 'general');
  assert.throws(() => projectType('missing'));
  assert.deepEqual(qualityRequirements('roblox', 'design', 'sm'), []);
});
test('manual completion refuses prose-only previews and file-existence checks as playtest proof', async t => {
  const root = await project(t);
  let feature = await createFeature(root, { id: 'game', title: 'Roblox 게임' });
  feature = await next(root, feature);
  await writeFile(join(root, 'design.md'), '# 문서만 있음');
  await assert.rejects(next(root, feature, [record('design-preview', [], 'design.md')]), /필수 검증/);
  feature = await getFeature(root, feature.id);
  await writeFile(join(root, 'preview.png'), png);
  feature = await next(root, feature, [record('design-preview', [], 'preview.png')]);
  const result = await proof(root, feature, 'static', 'play-loop', 'require("node:assert/strict").ok(require("node:fs").existsSync("preview.png"))');
  assert.equal(result.proof.exitCode, 0);
  await assert.rejects(next(root, result.feature, [record('play-loop', [result.proof.id])], [result.proof.id]), /필수 검증/);
  feature = await getFeature(root, feature.id);
  assert.equal(feature.phase, 'implement');
});
test('quality coverage rejects missing, wrong-phase, failed and outside-project evidence', async t => {
  const root = await project(t), outside = await project(t);
  await writeFile(join(outside, 'preview.png'), png);
  let feature = await createFeature(root, { id: 'look', title: '룩북' });
  feature = await next(root, feature);
  if (!await createTestSymlink(t, join(outside, 'preview.png'), join(root, 'external.png'))) return;
  assert.equal((await assessQuality(root, feature, [record('design-preview', [], 'external.png')])).ok, false);
  assert.equal((await assessQuality(root, feature, [record('design-preview', [], join(outside, 'preview.png'))])).ok, false);
  await writeFile(join(root, 'preview.png'), png);
  feature = await next(root, feature, [record('design-preview', [], 'preview.png')]);
  let result = await proof(root, feature, 'integration', 'generation-storage');
  assert.equal((await assessQuality(root, result.feature, [record('generation-storage', [result.proof.id])], [])).ok, false);
  feature = await next(root, result.feature, [record('generation-storage', [result.proof.id])], [result.proof.id]);
  assert.equal((await assessQuality(root, feature, [record('generation-storage', [result.proof.id])], [result.proof.id])).ok, false, 'previous phase proof cannot satisfy review');
  result = await proof(root, feature, 'integration', 'generation-storage', 'process.exit(1)');
  assert.equal((await assessQuality(root, result.feature, [record('generation-storage', [result.proof.id])], [result.proof.id])).ok, false);
  await assert.rejects(runTestProof(root, feature.id, [process.execPath], { verification: 'invented' }), /검증 종류/);
});
test('automatic request shows a failed review and resumes through a new implementation iteration', async t => {
  const root = await project(t), calls = []; let failReview = true;
  const runner = createRequestRunner({ root, execute: async (dir, input) => {
    let feature = (await listFeatures(dir))[0]; calls.push([feature.phase, feature.iteration]);
    const checks = [], proofIds = [];
    for (const rule of qualityRequirements(feature.projectType, feature.phase, feature.workMode)) {
      if (rule.kind === 'preview') { await writeFile(join(dir, 'preview.png'), png); checks.push(record(rule.id, [], 'preview.png')); }
      else {
        const result = await proof(dir, feature, rule.kind, rule.id); feature = result.feature; proofIds.push(result.proof.id);
        if (rule.kind === 'visual') await writeFile(join(dir, 'capture.png'), png);
        checks.push(record(rule.id, [result.proof.id], rule.kind === 'visual' ? 'capture.png' : '', feature.phase === 'review' && failReview && rule.id === 'play-loop' ? 'fail' : 'pass'));
      }
    }
    const outcome = feature.phase === 'review' && failReview ? 'blocked' : 'complete';
    return { threadId: 'quality-fixture', message: JSON.stringify({ outcome, report: '모의 검증 보고', document: '# 모의 단계 문서', evidence: '픽스처', proofIds, checks }) };
  } });
  t.after(() => runner.close());
  const request = await runner.submit({ author: '사용자', body: 'Roblox 코인 게임', mode: 'project' }); await runner.settled();
  const [planned] = await runner.list();
  await runner.reply(request.id, { approveWorkflow: true, workflowRevision: planned.workflow.revision }); await runner.settled();
  let [saved] = await runner.list();
  assert.equal(saved.status, 'blocked'); assert.equal(saved.phase, 'review'); assert.equal(saved.needsFix, true);
  assert.equal(requestAction(saved).label, '수정 후 다시 검증');
  failReview = false;
  await runner.reply(request.id, { resume: true }); await runner.settled();
  [saved] = await runner.list();
  assert.equal(saved.status, 'completed');
  assert.deepEqual(calls.slice(-3), [['implement', 1], ['review', 1], ['report', 1]]);
  const feature = await getFeature(root, request.id);
  assert.equal(feature.completed.review.checks.length, 2);
  assert.ok(feature.completed.review.checks.every(check => check.status === 'pass'));
});
test('design workers enter B1 and can reach every other floor without renumbering existing rooms', () => {
  const now = Date.now(), agents = ['designer', 'developer'].map(author => ({ author, kind: 'codex', state: 'working', feature: author, lastActive: new Date(now).toISOString() }));
  const scene = officeScene({ agents, order: agents.map(a => a.author), now, awayAfterMs: 600000, studio: SIDE_ROOMS.studio, features: [{ id: 'designer', phase: 'design' }, { id: 'developer', phase: 'implement' }] });
  assert.equal(scene[0].room, 'studio'); assert.equal(scene[1].room, 'dev');
  assert.ok(BUILDING.NODES[`studio:${scene[0].spot}`]);
  assert.equal(SIDE_ROOMS.meeting.floor, '1F'); assert.equal(SIDE_ROOMS.dev.floor, '2F');
});
test('design previews serve only registered local artifacts with a sandbox and reject moved outside files', async t => {
  const root = await project(t), outside = await project(t);
  let feature = await createFeature(root, { id: 'preview', title: '룩북 시안' });
  feature = await next(root, feature);
  await writeFile(join(root, 'preview.html'), '<h1>시안</h1><script>parent.stolen=true</script>');
  await writeFile(join(root, 'unregistered.html'), '등록하지 않은 파일');
  feature = await next(root, feature, [record('design-preview', [], 'preview.html')]);
  const server = createChatServer({ root }); t.after(() => server.shutdown());
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/features/preview/artifacts/design-preview`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.match(await response.text(), /시안/);
  assert.equal((await fetch(`${base}/api/features/preview/artifacts/unregistered.html`)).status, 404);
  assert.equal((await fetch(`${base}/api/features/preview/artifacts/design-preview`, { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  const summary = await (await fetch(`${base}/api/features`)).json();
  assert.equal(summary[0].designPreview.file, 'preview.html');
  assert.equal((await fetch(`${base}/api/features/unknown/artifacts/design-preview`)).status, 404);
  await writeFile(join(outside, 'preview.html'), '프로젝트 밖의 파일');
  await rename(join(root, 'preview.html'), join(root, 'preview-original.html'));
  if (!await createTestSymlink(t, join(outside, 'preview.html'), join(root, 'preview.html'))) return;
  assert.equal((await fetch(`${base}/api/features/preview/artifacts/design-preview`)).status, 404);
});
