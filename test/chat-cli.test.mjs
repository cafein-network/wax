import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli, project } from './chat-helpers.mjs';

test('post가 메시지를 JSONL에 추가하고 ID를 출력한다 (AC1)', async (t) => {
  const root = await project(t, ['chatbot']);
  const result = await cli(root, ['post', 'chatbot', '--author', 'claude-impl', '--kind', 'claude', '--message', '안녕하세요 @codex']);
  assert.equal(result.code, 0, result.stderr);
  const id = result.stdout.trim();
  assert.match(id, /^m-000001-[0-9a-f]{6}$/);
  const lines = (await readFile(join(root, '.wax', 'chat', 'channels', 'chatbot.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.deepEqual({ id: record.id, author: record.author, kind: record.kind, type: record.type, phase: record.phase, body: record.body },
    { id, author: 'claude-impl', kind: 'claude', type: 'message', phase: 'plan', body: '안녕하세요 @codex' });
});

test('read --since --json은 이후 메시지만 JSON으로 반환한다 (AC3)', async (t) => {
  const root = await project(t, ['chatbot']);
  const ids = [];
  for (const body of ['1', '2', '3']) ids.push((await cli(root, ['post', 'chatbot', '--author', 'a', '--message', body])).stdout.trim());
  const result = await cli(root, ['read', 'chatbot', '--since', ids[0], '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).messages.map((m) => m.body), ['2', '3']);
});

test('--file로 여러 줄 본문을 받고, 오류는 종료 코드로 구분한다', async (t) => {
  const root = await project(t, ['chatbot']);
  await writeFile(join(root, 'note.md'), '첫 줄\n둘째 줄 "따옴표" $HOME `백틱`\n');
  const ok = await cli(root, ['board', 'post', 'chatbot', '--author', 'codex', '--kind', 'codex', '--type', 'opinion', '--file', 'note.md', '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).body, '첫 줄\n둘째 줄 "따옴표" $HOME `백틱`');
  const missing = await cli(root, ['post', 'nope', '--author', 'a', '--message', 'x']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /wax 작업 nope/);
  const usage = await cli(root, ['post', 'chatbot', '--author', 'a']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--message 또는 --file/);
  const unknown = await cli(root, ['post', 'chatbot', '--bogus']);
  assert.equal(unknown.code, 2);
});

test('presence와 who, channels가 동작한다', async (t) => {
  const root = await project(t, ['chatbot']);
  const set = await cli(root, ['presence', '--author', 'claude-impl', '--kind', 'claude', '--state', 'working', '--feature', 'chatbot', '--note', 'store 구현']);
  assert.equal(set.code, 0, set.stderr);
  const who = await cli(root, ['who', '--json']);
  const [entry] = JSON.parse(who.stdout);
  assert.deepEqual([entry.author, entry.state, entry.effectiveState, entry.feature, entry.note], ['claude-impl', 'working', 'working', 'chatbot', 'store 구현']);
  const channels = await cli(root, ['channels', '--json']);
  assert.deepEqual(JSON.parse(channels.stdout).map((c) => c.id), ['general', 'chatbot']);
});

test('board digest는 stdout으로 출력하고 --out은 새 파일만 만든다 (AC15)', async (t) => {
  const root = await project(t, ['chatbot']);
  await cli(root, ['board', 'post', 'chatbot', '--author', 'a', '--type', 'question', '--message', '질문?']);
  const printed = await cli(root, ['board', 'digest', 'chatbot']);
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(printed.stdout, /## 미해결 질문[\s\S]*질문\?/);
  const out = await cli(root, ['board', 'digest', 'chatbot', '--out', 'digest.md']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(await readFile(join(root, 'digest.md'), 'utf8'), /화이트보드 집계 초안/);
  const again = await cli(root, ['board', 'digest', 'chatbot', '--out', 'digest.md']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /덮어쓰지 않았습니다/);
});

test('여러 프로세스가 동시에 게시해도 기록이 손상되지 않는다 (AC5)', async (t) => {
  const root = await project(t, ['chatbot']);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => cli(root, ['post', 'chatbot', '--author', `agent-${i}`, '--message', `동시 ${i}`])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const lines = (await readFile(join(root, '.wax', 'chat', 'channels', 'chatbot.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 10);
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => r.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(records.map((r) => r.body)).size, 10);
  const presence = JSON.parse(await readFile(join(root, '.wax', 'chat', 'presence.json'), 'utf8'));
  assert.equal(Object.keys(presence.agents).length, 10);
});

test('join은 겹치는 이름에 번호를 붙여 참여하고 그 이름을 알려 준다', async (t) => {
  const root = await project(t, ['chatbot']);
  const first = await cli(root, ['join', '--author', 'claude-app', '--kind', 'claude', '--json']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).author, 'claude-app');
  const second = await cli(root, ['join', '--author', 'claude-app', '--kind', 'claude', '--feature', 'chatbot', '--state', 'working']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /^claude-app-2: working \(chatbot\)\nclaude-app 이름은 다른 세션이 쓰고 있어 claude-app-2\(으\)로 참여했습니다\./);
});
