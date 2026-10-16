import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { updateFeature } from '../src/workflow.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { project } from './chat-helpers.mjs';

const proof = { id: '00000000-0000-4000-8000-000000000001', kind: 'test', phase: 'plan', iteration: 0, at: '2026-10-15T00:00:00Z', command: ['node', '--test'], output: 'actual failure <script>data only</script>', exitCode: 1, timedOut: false, truncated: false, durationMs: 15 };
test('대시보드 실행 근거 조회는 저장된 원문을 반환하고 호스트 검사와 404를 유지한다', async (t) => {
  const root = await project(t, ['login']);
  const feature = await updateFeature(root, 'login', 'attach-evidence', { proof, revision: 1 });
  const server = createChatServer({ root });
  t.after(() => server.shutdown());
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1'); await listening;
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/api/features/login/proofs/${proof.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { feature: 'login', proof: feature.proofs[0] });
  assert.equal((await fetch(`${base}/api/features/login/proofs/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/features/missing/proofs/${proof.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/features/login/proofs/${proof.id}`, { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request({host:'127.0.0.1',port,path:`/api/features/login/proofs/${proof.id}`,headers:{host:`evil.example:${port}`}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(status,403);
});
