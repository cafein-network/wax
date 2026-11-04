import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { DOC_PHASES, judgeRequest, outOfStage } from '../src/goal-allow.mjs';
import { createApproval, listApprovals } from '../src/approvals.mjs';
import { workerPrompt } from '../src/chat/pm-loop.mjs';
import { createFeature, getFeature } from '../src/workflow.mjs';

const write = (file_path) => ({ tool: 'claude', details: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path, content: 'x' } } });
const codexFiles = (paths, cwd) => ({ tool: 'codex', method: 'item/fileChange/requestApproval', details: { threadId: 'th', turnId: 'tu', itemId: 'i', cwd }, item: { changes: paths.map((path) => ({ path, kind: 'update' })) } });

test('a document-stage write outside .wax/ and docs/wax/ is flagged; stage files, code stages and reads are not', async (t) => {
  const root = await realpath(await project(t));
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  const ctx = (phase) => ({ root, phase, feature: 'login', author: 'wax-worker-claude', cli: 'wax' });
  assert.deepEqual(DOC_PHASES, ['plan', 'design', 'report']);
  assert.deepEqual(await outOfStage(write(join(root, 'src', 'app.js')), ctx('plan')), { phase: 'plan', paths: ['src/app.js'] });
  assert.equal(await outOfStage(write(join(root, '.wax', 'tmp', 'plan.md')), ctx('plan')), null);
  assert.equal(await outOfStage(write(join(root, 'docs', 'wax', 'login', 'design.md')), ctx('design')), null);
  assert.equal(await outOfStage(write(join(root, 'src', 'app.js')), ctx('implement')), null, 'code stages may edit code');
  assert.equal((await outOfStage(write(join(root, '..', 'elsewhere.md')), ctx('report'))).paths[0], '../elsewhere.md');
  assert.equal(await outOfStage({ tool: 'claude', details: { tool_name: 'Read', input: { file_path: join(root, 'src', 'app.js') } } }, ctx('plan')), null);
  const codex = await outOfStage(codexFiles(['.wax/tmp/a.md', 'README.md', 'src/x.js'], root), ctx('design'));
  assert.deepEqual(codex, { phase: 'design', paths: ['README.md', 'src/x.js'] });
  const verdict = await judgeRequest(write(join(root, 'src', 'app.js')), { kinds: [], ...ctx('plan') });
  assert.deepEqual(verdict, { outOfStage: { phase: 'plan', paths: ['src/app.js'] } });
  assert.equal(verdict.allow, undefined);
});

test('an approval keeps the out-of-stage flag and rejects a malformed one', async (t) => {
  const root = await project(t);
  const base = { tool: 'claude', session: 's1', callId: 'c1', action: 'Write', details: { tool: 'Write', input: { file_path: 'src/app.js' } } };
  const pending = await createApproval(root, { ...base, outOfStage: { phase: 'plan', paths: ['src/app.js'] } }, { timeoutMs: 60_000 });
  const [listed] = (await listApprovals(root)).requests.filter((item) => item.id === pending.request.id);
  assert.deepEqual(listed.outOfStage, { phase: 'plan', paths: ['src/app.js'] });
  await assert.rejects(createApproval(root, { ...base, callId: 'c2', outOfStage: { phase: 'implement', paths: ['src/app.js'] } }, { timeoutMs: 60_000 }));
  await assert.rejects(createApproval(root, { ...base, callId: 'c3', outOfStage: { phase: 'plan', paths: [] } }, { timeoutMs: 60_000 }));
});

test('the worker prompt states the document-stage write scope only for plan, design and report', async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'f1', title: '기능' });
  const feature = await getFeature(root, 'f1');
  const goal = { id: 'goal-00000000', title: '목표' };
  const prompt = (phase) => workerPrompt({ root, goal, feature: { ...feature, phase }, task: { id: 'task-1', phase, note: '배정' }, author: 'wax-worker-claude' });
  for (const phase of ['plan', 'design', 'report']) assert.match(prompt(phase), /문서 단계입니다\. 소스 코드·설정 파일을 고치지 말고/, phase);
  for (const phase of ['implement', 'review']) assert.doesNotMatch(prompt(phase), /문서 단계입니다/, phase);
});
