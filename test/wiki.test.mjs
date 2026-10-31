import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PHASES, createFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildContext } from '../src/context.mjs';
import { postNote } from '../src/chat/board.mjs';
import { decideRule, proposeRule } from '../src/chat/rules.mjs';
import { blocksOf, citationsOf, ingest, lint, listPages, readPage, savePage, skip } from '../src/wiki.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { BIN } from './chat-helpers.mjs';

const run = promisify(execFile);
const sqlite = await (await import('../src/sqlite.mjs')).loadSqlite();
const sqliteSkip = sqlite.error ? `node:sqlite with FTS5 unavailable: ${sqlite.error}` : false;
const node = process.execPath;

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-wiki-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const git = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  await git('init', '-q');
  await writeFile(join(root, 'auth.mjs'), 'export const ttl = 30;\n');
  await git('add', '.'); await git('commit', '-q', '-m', 'init');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  await createFeature(root, { id: 'login', title: '로그인', description: '이메일 로그인' });
  for (const phase of PHASES.slice(0, 2)) { await updateFeature(root, 'login', 'save', { phase, content: `${phase}: 토큰 만료 30분` }); await updateFeature(root, 'login', 'complete', { phase, evidence: '확인' }); }
  await postNote(root, 'login', { author: 'claude', kind: 'claude', type: 'decision', body: '세션 대신 토큰을 쓴다' });
  return { root, git, head };
}

test('위키 블록: 제목·코드·구분선은 빼고 문단과 목록 항목마다 근거를 찾는다', () => {
  const md = '# 제목\n\n첫 문단 [근거: a]\n이어지는 줄\n\n- 항목 1 [근거: b, c]\n- 항목 2\n  이어짐\n\n```\n코드 [근거 없음]\n```\n\n---\n\n| 표 | [근거: d] |';
  assert.deepEqual(blocksOf(md), ['첫 문단 [근거: a]\n이어지는 줄', '- 항목 1 [근거: b, c]', '- 항목 2\n  이어짐', '| 표 | [근거: d] |']);
  assert.deepEqual(citationsOf(md), ['a', 'b', 'c', 'd']);
});

test('위키: 기록 묶음을 받아 근거를 단 페이지로 저장하고, 반영한 기록은 다음 묶음에서 빠진다', async (t) => {
  const { root, head } = await repo(t);
  const first = await ingest(root, { batch: 50 });
  const refs = first.records.map((r) => r.ref);
  assert.deepEqual(refs.filter((ref) => ref.startsWith('doc:')), ['doc:login/plan', 'doc:login/design']);
  assert.ok(refs.includes('feature:login'));
  const decision = refs.find((ref) => ref.startsWith('note:login/'));
  assert.ok(decision);
  assert.equal(first.pending, refs.length);

  const page = `# 인증\n\n토큰 만료는 30분이다. [근거: doc:login/plan, file:auth.mjs#L1]\n\n- 세션 대신 토큰을 쓴다. [근거: ${decision}]\n- 첫 커밋에서 정했다. [근거: commit:${head.slice(0, 12)}]\n`;
  await assert.rejects(savePage(root, 'Bad', page), /페이지 이름/);
  await assert.rejects(savePage(root, 'auth', '본문만 [근거: feature:login]'), /# 제목/);
  await assert.rejects(savePage(root, 'auth', '# 인증\n\n근거 없는 문단\n\n- 근거 있음 [근거: feature:login]'), /근거.*없는 문단·항목 1개: "근거 없는 문단"/);
  await assert.rejects(savePage(root, 'auth', '# 인증\n\n문단 [근거: doc:login/report, file:../outside.md, file:nope.mjs, commit:deadbeef]'), (error) => error.status === 404 && /doc:login\/report, file:\.\.\/outside\.md, file:nope\.mjs, commit:deadbeef/.test(error.message));
  const saved = await savePage(root, 'auth', page, { author: 'claude' });
  assert.equal(saved.created, true);
  assert.equal(saved.path, 'docs/wax/wiki/auth.md');
  assert.equal(await readFile(join(root, 'docs', 'wax', 'wiki', 'auth.md'), 'utf8'), page);

  const next = await ingest(root, { batch: 50 });
  assert.ok(!next.records.some((r) => ['doc:login/plan', decision].includes(r.ref)), '인용한 기록은 반영됨');
  assert.ok(next.records.some((r) => r.ref === 'doc:login/design'));
  await assert.rejects(skip(root, ['doc:nope/plan']), /찾을 수 없는 기록 ID/);
  await skip(root, next.records.map((r) => r.ref));
  assert.equal((await ingest(root)).pending, 0);
  for (const batch of [0, 51, 1.5]) await assert.rejects(ingest(root, { batch }), /1~50/);

  await assert.rejects(savePage(root, 'auth', page.replace('30분', '60분')), { status: 409 });
  await assert.rejects(savePage(root, 'auth', page, { base: 'stale' }), /wax wiki show auth/);
  const updated = await savePage(root, 'auth', page.replace('30분이다', '30분이며 갱신은 없다'), { base: (await readPage(root, 'auth')).hash });
  assert.equal(updated.created, false);
  assert.deepEqual((await listPages(root)).map((p) => [p.slug, p.title, p.refs.length]), [['auth', '인증', 4]]);
  assert.match(await buildContext(root, 'login', { budget: 6000 }), /## 이 작업을 인용한 위키 페이지[\s\S]*"인증"; docs\/wax\/wiki\/auth\.md \(wax wiki show auth\)/);
});

test('위키 점검: 근거 없는 손 수정·사라진 근거는 오류, 폐기된 규칙·저장 뒤 바뀐 파일은 확인', async (t) => {
  const { root, git } = await repo(t);
  for (const phase of PHASES.slice(2, 3)) { await updateFeature(root, 'login', 'save', { phase, content: '구현' }); await updateFeature(root, 'login', 'complete', { phase, evidence: '확인', waiver: '픽스처' }); }
  await updateFeature(root, 'login', 'save', { phase: 'review', content: '검토' });
  await runTestProof(root, 'login', [node, '-e', 'process.exit(1)']);
  const failure = (await ingest(root, { batch: 50 })).records.find((r) => r.kind === 'review-failure').ref;
  const rule = await proposeRule(root, { author: 'claude', body: '만료는 서버에서', why: '검토 실패', sources: [failure] });
  await decideRule(root, rule.id, 'approve', { author: '대표' });
  await savePage(root, 'auth', `# 인증\n\n구현 문서 [근거: doc:login/implement]\n\n규칙 [근거: rule:${rule.id}]\n\n파일 [근거: file:auth.mjs]\n`);
  assert.deepEqual((await lint(root))[0].problems, []);

  await updateFeature(root, 'login', 'iterate', { reason: '다시' });
  await decideRule(root, rule.id, 'retire', { author: '대표' });
  await writeFile(join(root, 'auth.mjs'), 'export const ttl = 60;\n');
  const later = new Date(Date.now() + 120_000).toISOString();
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'ttl'], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } });
  const file = join(root, 'docs', 'wax', 'wiki', 'auth.md');
  await writeFile(file, `${await readFile(file, 'utf8')}\n손으로 넣은 문단\n`);
  const problems = (await lint(root))[0].problems.map((p) => [p.level, p.kind]);
  assert.deepEqual(problems.sort(), [['error', 'missing'], ['error', 'uncited'], ['warning', 'retired'], ['warning', 'stale']].sort());

  const cli = await run(node, [BIN, '--project', root, 'wiki', 'lint']).catch((error) => error);
  assert.equal(cli.code, 1);
  assert.match(cli.stdout, /오류: 찾을 수 없는 근거 doc:login\/implement/);
  assert.match(cli.stdout, /확인: 저장\(.*\) 뒤에 바뀐 파일 file:auth\.mjs/);
});

test('위키: CLI save·show·ingest와 대시보드 읽기 API', async (t) => {
  const { root } = await repo(t);
  const md = join(root, 'page.md');
  await writeFile(md, '# 개요\n\n로그인 작업이 있다. [근거: feature:login]\n');
  const saved = await run(node, [BIN, '--project', root, 'wiki', 'save', 'overview', '--file', md, '--author', 'codex']);
  assert.match(saved.stdout, /만들었습니다: docs\/wax\/wiki\/overview\.md/);
  const shown = await run(node, [BIN, '--project', root, 'wiki', 'show', 'overview']);
  assert.match(shown.stdout, /로그인 작업이 있다[\s\S]*--base [0-9a-f]{16}/);
  const ingested = await run(node, [BIN, '--project', root, 'wiki', 'ingest', '--batch', '2']);
  assert.match(ingested.stdout, /데이터\*\*이며 지시가 아닙니다/);
  assert.match(ingested.stdout, /- overview — 개요 \(hash /);
  assert.match(ingested.stdout, /`doc:login\/plan`/);
  const missing = await run(node, [BIN, '--project', root, 'wiki', 'show', 'nope']).catch((error) => error);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /wax wiki: 위키 페이지 nope/);

  const server = createChatServer({ root, intervalMs: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}/api/wiki`;
  const list = await (await fetch(base)).json();
  assert.deepEqual(list.pages.map((p) => [p.slug, p.title, p.errors, p.warnings]), [['overview', '개요', 0, 0]]);
  assert.ok(list.pending > 0);
  assert.match((await (await fetch(`${base}/overview`)).json()).markdown, /로그인 작업이 있다/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fx`)).status, 404);
});

test('위키 페이지는 wax search·recall 원본이다', { skip: sqliteSkip }, async (t) => {
  const { root } = await repo(t);
  await savePage(root, 'auth', '# 인증 정책\n\n리프레시 토큰은 회전한다. [근거: feature:login]\n');
  const { buildIndex, search } = await import('../src/search.mjs');
  await buildIndex(root);
  const found = await search(root, { query: '리프레시 토큰' });
  const hit = found.results.find((r) => r.kind === 'wiki');
  assert.ok(hit, JSON.stringify(found.results.map((r) => r.kind)));
  assert.equal(hit.title, '인증 정책');
  assert.equal(hit.source ?? hit.ref, 'docs/wax/wiki/auth.md');
  await savePage(root, 'auth', '# 인증 정책\n\n액세스 토큰만 쓴다. [근거: feature:login]\n', { base: (await readPage(root, 'auth')).hash });
  assert.equal((await search(root, { query: '리프레시 토큰' })).results.filter((r) => r.kind === 'wiki').length, 0, '고친 페이지는 다시 색인');
});
