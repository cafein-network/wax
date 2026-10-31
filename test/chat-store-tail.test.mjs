import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { readTail } from '../src/chat/store.mjs';
import { listChannels, postMessage, readMessages } from '../src/chat/channels.mjs';

const line = (seq, extra = {}) => `${JSON.stringify({ schema: 1, id: `m-${String(seq).padStart(6, '0')}-abc123`, seq, channel: 'general', author: 'codex-app', kind: 'codex', type: 'message',
  body: `${seq}번 메시지 ${'한글과 emoji 🙂 '.repeat(40)}`, at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(), ...extra })}\n`;
async function channel(t, count, { broken = [] } = {}) {
  const root = await project(t);
  const dir = join(root, '.wax', 'chat', 'channels');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'general.jsonl');
  await writeFile(file, Array.from({ length: count }, (_, i) => (broken.includes(i + 1) ? '{ not json\n' : line(i + 1))).join(''));
  return { root, file };
}

test('readTail reads only the end of a long file, across chunk and character boundaries', async (t) => {
  const { file } = await channel(t, 2000);
  const last = await readTail(file, { limit: 3 });
  assert.deepEqual(last.records.map((r) => r.seq), [1998, 1999, 2000]);
  assert.equal(last.skipped, 0, 'a line cut by the chunk start is dropped, not counted as broken');
  const many = await readTail(file, { limit: 500 });
  assert.deepEqual([many.records[0].seq, many.records.at(-1).seq, many.records.length], [1501, 2000, 500]);
  assert.ok(many.records.every((r, i) => r.body.endsWith('🙂 ') && (i === 0 || r.seq === many.records[i - 1].seq + 1)));
  const since = await readTail(file, { stop: (r) => r.seq <= 1200 });
  assert.ok(since.records[0].seq <= 1200 && since.records.at(-1).seq === 2000);
  assert.equal((await readTail(file)).records.length, 2000, 'without a limit or stop the whole file is read');
  assert.deepEqual(await readTail(join(file, '..', 'missing.jsonl'), { limit: 1 }), { records: [], skipped: 0 });
});

test('channel reads use the tail and keep their results', async (t) => {
  const { root } = await channel(t, 1500, { broken: [1499] });
  const recent = await readMessages(root, 'general', { limit: 5 });
  assert.deepEqual(recent.messages.map((m) => m.seq), [1495, 1496, 1497, 1498, 1500]);
  assert.equal(recent.skipped, 1);
  const after = await readMessages(root, 'general', { since: 'm-000010-000000', limit: 3 });
  assert.deepEqual(after.messages.map((m) => m.seq), [11, 12, 13]);
  const one = await readMessages(root, 'general', { id: 'm-000007-abc123' });
  assert.deepEqual(one.messages.map((m) => m.seq), [7]);
  assert.deepEqual((await readMessages(root, 'general', { id: 'm-000007-ffffff' })).messages, []);
  const [general] = await listChannels(root);
  assert.equal(general.count, 1500);
  assert.equal(general.lastAt, new Date(Date.UTC(2026, 9, 1, 0, 0, 1500)).toISOString());
  const reply = await postMessage(root, 'general', { author: '대표', kind: 'human', body: '오래된 메시지에 답장', replyTo: 'm-000002-abc123' });
  assert.equal(reply.seq, 1501);
  await assert.rejects(postMessage(root, 'general', { author: '대표', kind: 'human', body: 'x', replyTo: 'm-000002-ffffff' }), /답글 대상/);
});
