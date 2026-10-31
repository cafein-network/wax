import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { buildPrBody, code, inline, quoteMarkdown, writePrBody } from '../src/pr-body.mjs';

const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const pass = [process.execPath, '-e', 'process.exit(0)'];
const PLAN = '# 기획\n- AC-1: 로그인하면 홈으로 간다 — 검증: e2e\n- AC-2: 잘못된 비밀번호는 거절 — 검증: 단위 테스트\n';
const BARE_MENTION = /(^|[^\p{L}\p{N}_`/@.+-])@[A-Za-z0-9]/u;
const outsideCode = (markdown) => markdown.split(/^```[\s\S]*?^```/m).join('').replace(/`+[^`]*?`+/g, '');

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-pr-body-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function repo(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  return () => { git('add', '-A', '--', '.', ':(exclude).wax'); git('-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture'); };
}
const wax = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

async function finished(root, id, { report = '# 보고\n\n로그인 흐름을 바꿨습니다.\n', title = '로그인' } = {}) {
  await createFeature(root, { id, title });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: phase === 'plan' ? PLAN : '# 설계' });
    await updateFeature(root, id, 'complete', { phase, evidence: '확인' });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  const implement = (await runTestProof(root, id, pass, { author: 'codex-a' })).proof;
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현', proofIds: [implement.id], author: 'codex-a' });
  await updateFeature(root, id, 'save', { phase: 'review', content: '# 검토' });
  const review = (await runTestProof(root, id, pass, { author: 'claude-b' })).proof;
  await updateFeature(root, id, 'complete', { phase: 'review', evidence: '검토', verdict: 'pass', proofIds: [review.id], author: 'claude-b',
    checks: [{ id: 'ac-1', status: 'pass', detail: '홈 이동 확인 by @alice', proofIds: [review.id] }, { id: 'ac-2', status: 'unverified', detail: '테스트 계정 없음' }],
    acWaiver: '테스트 계정 발급 대기 (@bob 담당)' });
  if (report) {
    await updateFeature(root, id, 'save', { phase: 'report', content: report });
    await updateFeature(root, id, 'complete', { phase: 'report', evidence: '보고' });
  }
  return { implement, review };
}

test('a full record becomes a PR body with report, AC trace, proofs and freshness, in the CLI language', async (t) => {
  const root = await workspace(t), commit = repo(root);
  await writeFile(join(root, 'app.js'), 'one\n'); commit();
  const { implement, review } = await finished(root, 'login');
  const ko = await buildPrBody(root, 'login', { language: 'ko' });
  assert.deepEqual(ko.missing, []);
  assert.equal(ko.stale, 0);
  assert.match(ko.body, /^<!-- wax 제안 PR 제목: 로그인 -->/);
  assert.match(ko.body, /## 요약\n\n### 보고\n\n로그인 흐름을 바꿨습니다\./, 'report headings are demoted under the summary');
  assert.match(ko.body, new RegExp(`\\| AC-1 \\| 통과\\(근거 연결\\) \\| 테스트 \`.+\` \\(exit 0, \`${review.id.slice(0, 8)}\`\\) — 홈 이동 확인 by \`@alice\` \\|`));
  assert.match(ko.body, /\| AC-2 \| 미검증\(검토 기록\) \| - — 테스트 계정 없음 \|/);
  assert.match(ko.body, /미검증 기준의 사유\(검토 기록\): 테스트 계정 발급 대기 \(`@bob` 담당\)/);
  assert.match(ko.body, new RegExp(`### 테스트\\n\\n- \`.+\` — 실행 당시 통과 \\(exit 0\\), 구현, 커밋 \`[0-9a-f]{12}\` 기준\\(.+\\), .*기록 \`codex-a\`, 근거 \`${implement.id.slice(0, 8)}\``));
  assert.match(ko.body, /## 근거 신선도\n\n근거 2개 모두 기록 이후 바뀐 파일이 없습니다/);
  assert.doesNotMatch(ko.body, /## 근거 없이 완료한 단계/);

  const en = await buildPrBody(root, 'login', { language: 'en' });
  assert.match(en.body, /## Summary[\s\S]*## Acceptance criteria[\s\S]*\| AC-1 \| Passed \(proof linked\) \|[\s\S]*## Verification[\s\S]*passed when run \(exit 0\), implement[\s\S]*## Evidence freshness/);
  assert.doesNotMatch(en.body.replace(/로그인|보고|흐름을 바꿨습니다|홈 이동 확인|테스트 계정 [가-힣 ]+|담당/g, ''), /[가-힣]/, 'only record text stays Korean');

  const printed = wax(['pr-body', 'login', '--project', root], { WAX_LANG: 'en' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /^<!-- wax suggested PR title: 로그인 -->/);
  const json = JSON.parse(wax(['pr-body', 'login', '--json', '--project', root], { WAX_LANG: 'ko' }).stdout);
  assert.deepEqual(Object.keys(json), ['id', 'title', 'language', 'body', 'missing', 'stale']);
  assert.equal(json.language, 'ko');
  assert.match(wax(['pr-body', '--project', root], { WAX_LANG: 'en' }).stderr, /Usage: pr-body <id>/);
});

test('missing pieces are stated as missing, never invented', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'bare', title: '빈 작업' });
  const { body, missing } = await buildPrBody(root, 'bare', { language: 'en' });
  assert.deepEqual(missing, ['report-incomplete', 'report', 'acceptance', 'proofs', 'freshness']);
  assert.match(body, /The report phase has not been completed yet/);
  assert.match(body, /No saved report document\. Save it in the report phase with `wax save report bare --file docs\/wax\/bare\/report\.md`/);
  assert.match(body, /declares no acceptance criteria IDs/);
  assert.match(body, /No test or commit proofs are recorded/);
  assert.match(body, /Not checked: no current-iteration proof/);
  assert.doesNotMatch(body, /passed when run|\| AC-/);

  const reviewing = await workspace(t);
  await createFeature(reviewing, { id: 'mid', title: '중간' });
  await updateFeature(reviewing, 'mid', 'save', { phase: 'plan', content: PLAN });
  const mid = await buildPrBody(reviewing, 'mid', { language: 'ko' });
  assert.match(mid.body, /\| AC-1 \| 검토 기록 없음 \| - \|/);
  assert.match(mid.body, /검토 단계가 완료되지 않아/);
  assert.ok(mid.missing.includes('review') && mid.missing.includes('report'));
});

test('no-proof waivers are shown honestly with their phase', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'waived', title: '문서 변경' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, 'waived', 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, 'waived', 'complete', { phase, evidence: '확인' });
  }
  await updateFeature(root, 'waived', 'save', { phase: 'implement', content: '# 구현' });
  await updateFeature(root, 'waived', 'complete', { phase: 'implement', evidence: '문서만', waiver: '실행할 코드가 없는 문서 변경 | cc @carol' });
  const { body, missing } = await buildPrBody(root, 'waived', { language: 'ko' });
  assert.match(body, /## 근거 없이 완료한 단계\n\n- 구현: 실행할 코드가 없는 문서 변경 \\\| cc `@carol`/);
  assert.ok(missing.includes('proofs'));
});

test('proofs whose files changed since recording are flagged as stale', async (t) => {
  const root = await workspace(t), commit = repo(root);
  await writeFile(join(root, 'app.js'), 'one\n'); commit();
  const { review } = await finished(root, 'stale');
  await writeFile(join(root, 'app.js'), 'two\n'); await writeFile(join(root, 'new.js'), 'x\n');
  const { body, stale, missing } = await buildPrBody(root, 'stale', { language: 'en' });
  assert.equal(stale, 2);
  assert.deepEqual(missing, []);
  assert.match(body, new RegExp(`- Test \`.+\` \\(exit 0, \`${review.id.slice(0, 8)}\`\\) \\(report basis\\): 2 files changed since recorded: \`app\\.js\`, \`new\\.js\``));
  assert.match(body, /An observation, not a verdict/);

  const plain = await workspace(t);
  await finished(plain, 'nogit');
  const nogit = await buildPrBody(plain, 'nogit', { language: 'en' });
  assert.match(nogit.body, /no Git commit recorded/);
  assert.match(nogit.body, /Not checked: no current-iteration proof has a working tree fingerprint/);
});

test('record text cannot notify people or hide content', async (t) => {
  assert.equal(inline('ping @octocat and @org/team, mail a@b.com'), 'ping `@octocat` and `@org/team`, mail a@b.com');
  assert.equal(inline('a‮​b\n<!-- x -->'), 'a b &lt;!-- x --&gt;');
  assert.equal(inline('x'.repeat(500)).length, 200);
  assert.equal(code('a`b'), '``a`b``');
  assert.equal(code('`x'), '`` `x ``');
  assert.equal(code('a|b'), '`a|b`');
  assert.equal(code('a|b', 200, true), '`a\\|b`');
  const quoted = quoteMarkdown('# 제목\ncc @alice `@inline` x\n```\n@fenced\n```\n<!-- 숨김 -->\n```\nunclosed @fence');
  assert.equal(quoted.text, '### 제목\ncc `@alice` `@inline` x\n```\n@fenced\n```\n&lt;!-- 숨김 -->\n```\nunclosed @fence\n```');
  const long = quoteMarkdown('line\n'.repeat(3000));
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 6000);

  const root = await workspace(t);
  await finished(root, 'mention', { title: 'Fix @octocat login', report: '# Report\n\nThanks @alice and @org/reviewers.\n\n```sh\necho @kept-in-code\n```\n' });
  const { body } = await buildPrBody(root, 'mention', { language: 'en' });
  assert.doesNotMatch(outsideCode(body), BARE_MENTION, body);
  assert.match(body, /Thanks `@alice` and `@org\/reviewers`/);
  assert.match(body, /echo @kept-in-code/);
  assert.match(body, /^<!-- wax suggested PR title: Fix `@octocat` login -->/);
});

test('--out writes the draft file only, and refuses directories and symbolic links', async (t) => {
  const root = await workspace(t);
  await finished(root, 'out');
  const file = join(root, 'pr-body.md');
  const result = wax(['pr-body', 'out', '--out', file, '--project', root], { WAX_LANG: 'en' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved the PR description draft: .*pr-body\.md\n/);
  assert.match(result.stdout, /gh pr create --draft --title <title> --body-file ".*pr-body\.md"/);
  assert.equal(await readFile(file, 'utf8'), (await buildPrBody(root, 'out', { language: 'en' })).body);
  const json = JSON.parse(wax(['pr-body', 'out', '--out', file, '--json', '--project', root]).stdout);
  assert.equal(json.out, file);
  assert.equal(await readFile(file, 'utf8'), json.body);

  await assert.rejects(writePrBody(root, 'x'), /일반 파일 경로/);
  await writeFile(join(root, 'target.md'), 'keep');
  try { await symlink(join(root, 'target.md'), join(root, 'link.md')); } catch { return; }
  const refused = wax(['pr-body', 'out', '--out', join(root, 'link.md'), '--project', root], { WAX_LANG: 'en' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--out must be a regular file path/);
  assert.equal(await readFile(join(root, 'target.md'), 'utf8'), 'keep');
});

test('pr-body never runs gh or opens network connections itself', async () => {
  const source = await readFile(new URL('../src/pr-body.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(child_process|http|https|net|tls|dgram)|\bfetch\(|\bspawn\(|\bexecFile/);
});
