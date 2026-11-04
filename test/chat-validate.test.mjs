import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from '../src/chat/validate.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { chatDir } from '../src/chat/paths.mjs';
import { project } from './chat-helpers.mjs';

test('채널 ID는 wax ID 규칙을 따른다 (AC4)', () => {
  assert.equal(v.channelId('chatbot'), 'chatbot');
  for (const bad of ['../x', 'Chat', '-a', '', 'a'.repeat(65), 'a/b', 'a b']) assert.throws(() => v.channelId(bad), /채널 ID/, bad);
});

test('작성자·본문·유형 검증 (AC4)', () => {
  assert.equal(v.author('claude-impl'), 'claude-impl');
  assert.equal(v.author('사람 1'), '사람 1');
  for (const bad of ['', ' a', 'a'.repeat(41), 'a\nb', '<b>']) assert.throws(() => v.author(bad), /작성자/, bad);
  assert.throws(() => v.body('   '), /비어/);
  assert.throws(() => v.body('x'.repeat(8001)), /8000자/);
  assert.equal(v.body('a\r\nb '), 'a\nb');
  assert.throws(() => v.kind('robot'), /종류/);
  assert.equal(v.kind(undefined, 'other'), 'other');
  assert.throws(() => v.noteType('message'), /노트 유형/);
  assert.throws(() => v.phase('ship'), /단계/);
  assert.equal(v.phase('done'), 'done');
});

test('레코드 ID에서 seq를 꺼내고 형식을 검증한다', () => {
  assert.equal(v.seqOf('m-000012-a1b2c3', ['m']), 12);
  assert.equal(v.seqOf('n-1234567-a1b2c3', ['n', 'r']), 1234567);
  assert.throws(() => v.seqOf('m-12-a1b2c3', ['m']), /형식/);
  assert.throws(() => v.seqOf('n-000001-a1b2c3', ['m']), /형식/);
  assert.throws(() => v.limit('0'), /limit/);
});

test('.wax/chat이 심볼릭 링크면 쓰지 않는다 (AC4)', async (t) => {
  const root = await project(t);
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await mkdir(join(root, '.wax'));
  try { await symlink(elsewhere, join(root, '.wax', 'chat'), 'junction'); }
  catch (error) { t.skip(`심볼릭 링크를 만들 수 없는 환경: ${error.code}`); return; }
  await assert.rejects(postMessage(root, 'general', { author: 'a', body: 'x' }), /심볼릭 링크/);
});

test('여러 호출이 동시에 같은 채팅 폴더를 만들어도 실패하지 않는다', async (t) => {
  const root = await project(t);
  const dirs = await Promise.all(Array.from({ length: 20 }, () => chatDir(root, 'channels', { create: true })));
  assert.ok(dirs.every((dir) => dir === join(root, '.wax', 'chat', 'channels')));
});

test('세션 종류: GitHub Copilot CLI(copilot)를 받아들이고 화면에서 GitHub Copilot으로 표시한다', async () => {
  const v = await import('../src/chat/validate.mjs');
  assert.equal(v.kind('copilot'), 'copilot');
  const { KIND_LABELS } = await import('../web/office/model.mjs');
  assert.equal(KIND_LABELS.copilot, 'GitHub Copilot');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../web/office/side/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.variants.copilot, '사무실 캐릭터 옷 색');
  assert.match(await readFile(new URL('../web/dashboard.mjs', import.meta.url), 'utf8'), /copilot: 'GitHub Copilot'/);
  assert.match(await readFile(new URL('../skills/plan/SKILL.md', import.meta.url), 'utf8'), /"copilot" in GitHub Copilot CLI/);
});
