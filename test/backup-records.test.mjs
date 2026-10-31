import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { postNote } from '../src/chat/board.mjs';
import { saveMemo } from '../src/chat/work-notes.mjs';
import { setPm } from '../src/chat/team.mjs';
import { listRules } from '../src/chat/rules.mjs';
import { markSeen } from '../src/wiki.mjs';
import { createFeature, getFeature } from '../src/workflow.mjs';
import { createBackup, validateBackup, previewRestore, restoreBackup } from '../src/backup.mjs';


const RULES = [
  { schema: 1, record: 'rule', id: 'r-000001-aaaaaa', seq: 1, body: '테스트를 먼저 돌린다', why: '검토 실패', sources: ['proof:login/p-1'], author: 'claude', kind: 'claude', at: '2026-10-01T00:00:00.000Z' },
  { schema: 1, record: 'decision', id: 'd-000002-bbbbbb', seq: 2, rule: 'r-000001-aaaaaa', status: 'approved', author: '대표', at: '2026-10-01T01:00:00.000Z' },
].map((record) => JSON.stringify(record)).join('\n') + '\n';

async function source(t) {
  const root = await project(t);
  await createFeature(root, { id: 'login', title: '로그인' });
  await mkdir(join(root, '.wax/chat'), { recursive: true });
  await writeFile(join(root, '.wax/chat/rules.jsonl'), RULES);
  const input = { author: 'claude', kind: 'claude' };
  await saveMemo(root, { ...input, body: '다음: 토큰 만료 확인' });
  await setPm(root, input);
  await postMessage(root, 'general', { ...input, body: '안녕하세요' });
  await postNote(root, 'login', { ...input, type: 'decision', body: '토큰을 쓴다' });
  await markSeen(root, ['proof:login/p-1']);
  return root;
}

test('backup carries rules, memos, team, channels, boards and wiki state; restore recreates them exactly', async (t) => {
  const root = await source(t), target = await project(t);
  const backup = validateBackup(await createBackup(root));
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.files.map((file) => file.path), ['.wax/chat/memos.jsonl', '.wax/chat/rules.jsonl', '.wax/chat/team.json', '.wax/chat/channels/general.jsonl', '.wax/chat/board/login.jsonl', '.wax/wiki/state.json']);
  assert.ok(!backup.files.some((file) => /presence|lock/.test(file.path)));
  const preview = await previewRestore(target, backup);
  assert.equal(preview.newFileCount, 6);
  const result = await restoreBackup(target, backup, preview);
  assert.deepEqual(result.restored, ['login']); assert.equal(result.restoredFiles.length, 6); assert.equal(result.remainingFiles, 0);
  for (const file of backup.files) assert.equal(await readFile(join(target, file.path), 'utf8'), await readFile(join(root, file.path), 'utf8'));
  assert.equal((await listRules(target))[0].status, 'approved');
  const again = await previewRestore(target, backup);
  assert.equal(again.newFileCount, 0); assert.ok(again.files.every((file) => file.status === 'exists'));
});

test('restore never overwrites or merges into existing record files and skips them with a prefix', async (t) => {
  const root = await source(t), target = await project(t);
  const backup = await createBackup(root);
  await mkdir(join(target, '.wax/chat'), { recursive: true });
  await writeFile(join(target, '.wax/chat/rules.jsonl'), '{"seq":1,"record":"rule","id":"r-000001-cccccc"}\n');
  const preview = await previewRestore(target, backup);
  assert.equal(preview.files.find((file) => file.path === '.wax/chat/rules.jsonl').status, 'exists');
  await saveMemo(target, { author: 'codex', kind: 'codex', body: '새 메모 보존' });
  await assert.rejects(restoreBackup(target, backup, preview), { status: 409 });
  const result = await restoreBackup(target, backup, await previewRestore(target, backup));
  assert.equal(result.skippedFiles.length, 2); assert.equal(result.restoredFiles.length, 4);
  assert.equal(await readFile(join(target, '.wax/chat/rules.jsonl'), 'utf8'), '{"seq":1,"record":"rule","id":"r-000001-cccccc"}\n');
  assert.match(await readFile(join(target, '.wax/chat/memos.jsonl'), 'utf8'), /새 메모 보존/);
  assert.doesNotMatch(await readFile(join(target, '.wax/chat/memos.jsonl'), 'utf8'), /토큰 만료/);

  const fresh = await project(t);
  const copy = await previewRestore(fresh, backup, 'copy-');
  assert.ok(copy.files.every((file) => file.status === 'prefix'));
  const copied = await restoreBackup(fresh, backup, { ...copy, prefix: 'copy-' });
  assert.deepEqual(copied.restored, ['copy-login']); assert.deepEqual(copied.restoredFiles, []);
  assert.equal((await getFeature(fresh, 'copy-login')).title, '로그인');
});

test('record files are integrity-checked, path-restricted and limited; version 1 backups still restore', async (t) => {
  const root = await source(t), target = await project(t);
  const backup = await createBackup(root);
  const tampered = structuredClone(backup); tampered.files[0].text += 'x';
  assert.throws(() => validateBackup(tampered), /기록 파일/);
  const resign = (data) => { const { checksum, ...rest } = data; return { ...rest, checksum: createHash('sha256').update(JSON.stringify(rest)).digest('hex') }; };
  const escape = structuredClone(backup); escape.files[0].path = '.wax/chat/../../evil.jsonl';
  assert.throws(() => validateBackup(resign(escape)), /기록 파일/);
  const presence = structuredClone(backup); presence.files[0].path = '.wax/chat/presence.json';
  assert.throws(() => validateBackup(resign(presence)), /기록 파일/);
  const resized = structuredClone(backup); resized.files[0].size += 1;
  assert.throws(() => validateBackup(resign(resized)), /기록 파일/);

  const small = validateBackup(await createBackup(root, { fileBudget: 10 }));
  assert.ok(small.files.every((file) => file.omitted && file.text === undefined));
  assert.ok((await previewRestore(target, small)).files.every((file) => file.status === 'omitted'));

  const { files, ...legacy } = backup; delete legacy.checksum; legacy.version = 1;
  const v1 = resign(legacy);
  assert.equal(validateBackup(v1), v1);
  assert.throws(() => validateBackup(resign({ ...legacy, files: [] })), /지원하는/);
  const preview = await previewRestore(target, v1);
  assert.deepEqual(preview.files, []);
  assert.deepEqual((await restoreBackup(target, v1, preview)).restored, ['login']);
});
