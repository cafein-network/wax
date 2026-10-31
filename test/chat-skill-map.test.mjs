import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTestProof } from '../src/evidence.mjs';
import { getFeature, updateFeature } from '../src/workflow.mjs';
import { joinPresence } from '../src/chat/presence.mjs';
import { assignTask, setPm, updateTask } from '../src/chat/team.mjs';
import { listProfiles } from '../src/chat/skills.mjs';
import { areaOf, buildSkillMap, formatSkillMap } from '../src/chat/skill-map.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { BIN, at, cli, project } from './chat-helpers.mjs';

const commit = (files, overrides = {}) => ({
  id: randomUUID(), kind: 'git', phase: 'plan', iteration: 0, at: new Date().toISOString(), commit: 'b'.repeat(40), files, ...overrides,
});
const node = process.execPath;

test('스킬 지도: 코드 영역은 커밋 경로에서, src·web 같은 폴더는 한 단계 더 나눈다', () => {
  assert.equal(areaOf('README.md'), '(루트 파일)');
  assert.equal(areaOf('docs/USER_GUIDE.md'), 'docs');
  assert.equal(areaOf('src/chat/server.mjs'), 'src/chat');
  assert.equal(areaOf('src/workflow.mjs'), 'src');
  assert.equal(areaOf('web/office/card.mjs'), 'web/office');
  assert.equal(areaOf('test/a/b.mjs'), 'test');
});

test('스킬 지도: 근거 작성자·업무 담당자별로 단계·검증·코드 영역 기록을 세고 빈 분야를 알려 준다', async (t) => {
  const root = await project(t, ['login']);
  await mkdir(join(root, 'docs'));
  await setPm(root, { author: '사람', kind: 'human' });
  const task = await assignTask(root, { author: '사람', feature: 'login', to: 'claude', phase: 'plan', body: '기획' }, at('2026-10-01T09:00:00Z'));
  await updateTask(root, task.id, 'accept', { author: 'claude', kind: 'claude' }, at('2026-10-01T09:00:00Z'));
  await runTestProof(root, 'login', [node, '-e', 'process.exit(0)']);
  await runTestProof(root, 'login', [node, '-e', 'process.exit(1)'], { author: 'codex' });
  await runTestProof(root, 'login', [node, '-e', 'process.exit(0)'], { author: 'codex', verification: 'runtime', checks: ['smoke'] });
  await updateFeature(root, 'login', 'attach-evidence', { proof: commit(['src/chat/a.mjs', 'src/chat/b.mjs', 'web/app.mjs'], { author: 'codex' }) });
  await updateFeature(root, 'login', 'attach-evidence', { proof: commit(['src/chat/c.mjs']) });
  await updateTask(root, task.id, 'done', { author: 'claude', body: '완료' }, { now: new Date(Date.now() + 3_600_000) });
  await updateFeature(root, 'login', 'attach-evidence', { proof: commit(['src/x.mjs'], { at: new Date(Date.now() + 7_200_000).toISOString() }) });
  await joinPresence(root, { author: 'gemini', kind: 'gemini' });

  const map = await buildSkillMap(root);
  const row = (author) => map.people.find((p) => p.author === author);
  assert.deepEqual(row('claude').cells['phase:plan'], { count: 1, failed: 0 });
  assert.deepEqual(row('claude').cells['check:test'], { count: 1, failed: 0 });
  assert.deepEqual(row('claude').cells['area:src/chat'], { count: 1, failed: 0 });
  assert.deepEqual(row('codex').cells['check:test'], { count: 0, failed: 1 });
  assert.deepEqual(row('codex').cells['check:runtime'], { count: 1, failed: 0 });
  assert.deepEqual(row('codex').cells['area:src/chat'], { count: 1, failed: 0 }, '한 커밋이 같은 영역 파일 여럿을 고쳐도 한 번');
  assert.deepEqual(row('codex').cells['area:web'], { count: 1, failed: 0 });
  assert.deepEqual(row('gemini'), { author: 'gemini', kind: 'gemini', total: 0, cells: {} }, '기록 없는 참여자도 줄에 보인다');
  assert.equal(map.unattributed, 1);
  const column = (key) => map.columns.find((c) => c.key === key);
  assert.equal(column('area:src/chat').holders, 2);
  assert.equal(column('area:src/chat').total, 2);
  assert.equal(column('check:test').holders, 1, '실패만 있는 사람은 그 분야를 가진 것으로 보지 않는다');
  assert.equal(column('area:docs').holders, 0, '아무도 커밋하지 않은 최상위 폴더');
  assert.equal(column('area:.wax'), undefined);
  assert.ok(map.gaps.empty.includes('docs'));
  assert.ok(map.gaps.empty.includes('검토'));
  assert.deepEqual(map.gaps.single.find((g) => g.label === 'web'), { label: 'web', author: 'codex' });
  assert.deepEqual(map.people.slice(0, 2).map((p) => [p.author, p.total]), [['claude', 3], ['codex', 3]], '기록 수(실패 제외)순, 같으면 이름순');
  assert.deepEqual(map.people.slice(2).map((p) => p.total), [0, 0]);

  const text = formatSkillMap(map);
  assert.match(text, /\| 사원 \| 단계: 기획 \|/);
  assert.match(text, /\| codex \|.*0\(실패 1\)/);
  assert.match(text, /빈 분야\(기록 없음\): .*docs/);
  assert.match(text, /한 명만 기록이 있는 분야: .*web\(codex\)/);
  assert.match(text, /작성자를 알 수 없는 근거 1개/);

  const codex = (await listProfiles(root)).find((p) => p.author === 'codex');
  assert.equal(codex.counts.testsFailed, 1);
  assert.equal(codex.counts.commits, 1);
});

test('스킬 지도: 근거 작성자 이름은 채팅 이름 규칙을 따르고 저장된 이상한 이름은 거부한다', async (t) => {
  const root = await project(t, ['login']);
  await assert.rejects(runTestProof(root, 'login', [node, '-e', '0'], { author: '-bad name' }), /작성자는/);
  await assert.rejects(updateFeature(root, 'login', 'attach-evidence', { proof: commit(['a'], { author: 'x'.repeat(41) }) }), /검증 근거/);
  assert.equal((await getFeature(root, 'login')).proofs, undefined);
});

test('스킬 지도: wax chat skills·wax test --author·GET /api/skills/map', async (t) => {
  const root = await project(t, ['login']);
  const run = await promisify(execFile)(node, [BIN, '--project', root, 'test', 'login', '--author', 'grok', '--', node, '-e', '0']);
  assert.equal(JSON.parse(run.stdout).proof.author, 'grok');
  const human = await cli(root, ['skills']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /\| grok \|/);
  const json = await cli(root, ['skills', '--json']);
  assert.equal(JSON.parse(json.stdout).people[0].cells['check:test'].count, 1);
  const empty = await project(t, []);
  assert.match((await cli(empty, ['skills'])).stdout, /아직 참여한 세션이나 기록이 없습니다/);

  const server = createChatServer({ root, intervalMs: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const map = await (await fetch(`http://127.0.0.1:${server.address().port}/api/skills/map`)).json();
  assert.equal(map.people[0].author, 'grok');
  assert.deepEqual(map.groups, { phase: '단계', check: '검증', area: '코드 영역' });
});
