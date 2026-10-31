import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { phaseDurations } from '../src/durations.mjs';
import { buildRunTrace, renderTraceMarkdown, requestSummary, traceVisits } from '../src/run-trace.mjs';
import { headState } from '../src/freshness.mjs';

const cli = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const pass = [process.execPath, '-e', 'process.exit(0)'];
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const ev = (action, phase, ms, extra = {}) => ({ action, phase, at: at(ms), ...extra });
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const BARE_MENTION = /(^|[^\p{L}\p{N}_`/@.+-])@[A-Za-z0-9]/u;
const outsideCode = (markdown) => markdown.replace(/`+[^`]*?`+/g, '');

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function repo(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  return () => { git('add', '-A'); git('-c', 'user.name=Wax Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'); };
}
const wax = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const byPhase = (visits) => visits.reduce((out, visit) => { const item = (out[visit.phase] ??= { ms: 0, visits: 0 }); item.ms += visit.ms; item.visits += 1; return out; }, {});

test('iterations show as revisits with the reason, and visit times add up to the phase durations', () => {
  const proof = { id: '11111111-1111-1111-1111-111111111111', kind: 'test', phase: 'implement', iteration: 0, at: at(3 * HOUR), command: ['npm', 'test'], exitCode: 0, output: '', durationMs: 1 };
  const feature = { id: 'login', title: '로그인', phase: 'implement', iteration: 1, completed: { plan: { at: at(HOUR), evidence: '확인', author: 'codex-a' } }, proofs: [proof], history: [
    ev('create', 'plan', 0, { head: A }), ev('complete', 'plan', HOUR, { head: A, dirty: false, author: 'codex-a', tool: 'codex' }),
    ev('complete', 'design', 2 * HOUR, { head: A, dirty: false }),
    ev('attach-evidence', 'implement', 3 * HOUR),
    ev('complete', 'implement', 4 * HOUR, { head: B, dirty: true, author: 'codex-a' }),
    ev('archive', 'review', 5 * HOUR, { iteration: 0, reason: '토큰 만료', completed: { implement: { at: at(4 * HOUR), evidence: '구현', proofIds: [proof.id], author: 'codex-a' } } }),
    ev('iterate', 'review', 5 * HOUR, { reason: '토큰 만료', head: B, dirty: false, author: 'claude-b' }),
  ] };
  const now = T0 + 6 * HOUR;
  const trace = traceVisits(feature, { now });
  assert.deepEqual(trace.visits.map((v) => [v.phase, v.iteration, v.outcome]), [
    ['plan', 0, 'complete'], ['design', 0, 'complete'], ['implement', 0, 'complete'], ['review', 0, 'iterate'], ['implement', 1, 'open']]);
  const durations = phaseDurations(feature, now);
  assert.deepEqual(byPhase(trace.visits), durations.phases);
  assert.deepEqual(trace.durations, durations);
  const [plan, , implement, review, again] = trace.visits;
  assert.equal(plan.author, 'codex-a'); assert.equal(plan.tool, 'codex'); assert.equal(plan.evidence, '확인');
  assert.equal(plan.startHead, A); assert.equal(plan.endHead, A); assert.equal(plan.dirty, false);
  assert.equal(implement.evidence, '구현');
  assert.deepEqual(implement.proofs.map((p) => [p.id, p.linked, p.command]), [[proof.id, true, 'npm test']]);
  assert.equal(implement.startHead, A); assert.equal(implement.endHead, B); assert.equal(implement.dirty, true);
  assert.equal(review.reason, '토큰 만료'); assert.equal(review.author, 'claude-b');
  assert.equal(again.open, true); assert.equal(again.cause.reason, '토큰 만료'); assert.equal(again.endHead, null);
  assert.equal(again.ms, HOUR);
  assert.equal(durations.inProgress, 'implement');
});

test('old records without heads, tools or a create event give empty cells and never throw', () => {
  const legacy = { id: 'old', title: '옛 작업', phase: 'review', iteration: 0, completed: {}, history: [
    ev('save', 'plan', 0), ev('complete', 'plan', HOUR), null, 'junk', { action: 'complete' }, ev('complete', 'design', 3 * HOUR),
    ev('save', 'implement', 30 * MIN),
    ev('complete', 'implement', 4 * HOUR), ev('save', 'review', 5 * HOUR),
  ] };
  const now = T0 + 6 * HOUR;
  const trace = traceVisits(legacy, { now });
  assert.deepEqual(trace.visits.map((v) => [v.phase, v.outcome]), [['plan', 'complete'], ['design', 'complete'], ['implement', 'complete'], ['review', 'open']]);
  assert.deepEqual(byPhase(trace.visits), phaseDurations(legacy, now).phases);
  for (const visit of trace.visits) {
    assert.equal(visit.startHead, null); assert.equal(visit.endHead, null); assert.equal(visit.tool, null); assert.equal(visit.author, null);
    assert.equal(visit.files, null); assert.deepEqual(visit.proofs, []);
  }
  for (const broken of [null, undefined, {}, { history: 'x' }, { history: [ev('complete', 'nope', 0)] }]) {
    const empty = traceVisits(broken);
    assert.deepEqual(empty.visits, []);
    assert.match(renderTraceMarkdown({ ...empty, id: 'x', freshness: null }, 'en'), /No phase visits are recorded/);
  }
});

test('an open phase shows the questions and blocks of its linked request', () => {
  const id = 'request-12345678-1234-1234-1234-123456789abc';
  const request = requestSummary({ id, tool: 'claude', mode: 'sm', author: '대표', status: 'question', phase: 'design', origin: { trigger: 'trg-1', eventKey: 'repo#1' }, messages: [
    { role: 'user', text: '로그인 고쳐 줘', at: at(0) },
    { role: 'assistant', text: '어느 화면인가요?', at: at(2 * HOUR), phase: 'design', outcome: 'question' },
    { role: 'assistant', text: '기획 질문', at: at(10 * MIN), phase: 'plan', outcome: 'question' },
  ] });
  const feature = { id, title: '요청', phase: 'design', iteration: 0, completed: {}, history: [ev('create', 'plan', 0), ev('complete', 'plan', HOUR, { tool: 'claude' })] };
  const trace = traceVisits(feature, { request, now: T0 + 3 * HOUR });
  const [plan, design] = trace.visits;
  assert.deepEqual(plan.notes.map((n) => n.text), ['기획 질문']);
  assert.equal(plan.waiting, null);
  assert.deepEqual(design.notes.map((n) => [n.outcome, n.text]), [['question', '어느 화면인가요?']]);
  assert.equal(design.waiting, 'question'); assert.equal(design.outcome, 'open');
  assert.deepEqual(trace.request.origin, { trigger: 'trg-1', eventKey: 'repo#1' });
  assert.equal(trace.request.tool, 'claude');
  assert.equal(trace.request.notes, undefined);
  const markdown = renderTraceMarkdown({ ...trace, freshness: null }, 'en');
  assert.match(markdown, /Request `request-12345678/);
  assert.match(markdown, /Request origin: trigger: trg-1, eventKey: repo#1/);
  assert.match(markdown, /request waiting for an answer/);
  assert.equal(requestSummary({ id: 'nope' }), null);
});

test('completing and iterating record the commit and tree state, and only where Git is there', async (t) => {
  const plain = await workspace(t);
  await createFeature(plain, { id: 'plain', title: '깃 없음' });
  await updateFeature(plain, 'plain', 'save', { phase: 'plan', content: '# 기획' });
  const done = await updateFeature(plain, 'plain', 'complete', { phase: 'plan', evidence: '확인', tool: 'codex' });
  const event = done.history.at(-1);
  assert.equal(event.head, undefined); assert.equal(event.dirty, undefined); assert.equal(event.tool, 'codex');
  assert.deepEqual(await headState(plain), {});

  const root = await workspace(t);
  const commit = repo(root);
  await writeFile(join(root, '.gitignore'), '.wax/\n'); await writeFile(join(root, 'a.txt'), '1\n'); commit();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const created = await createFeature(root, { id: 'git', title: '깃' });
  assert.deepEqual(created.history[0], { action: 'create', phase: 'plan', at: created.createdAt, head, dirty: false });
  await updateFeature(root, 'git', 'save', { phase: 'plan', content: '# 기획' });
  await writeFile(join(root, 'b.txt'), '2\n');
  const completed = await updateFeature(root, 'git', 'complete', { phase: 'plan', evidence: '확인', author: 'codex-a' });
  assert.deepEqual([completed.history.at(-1).head, completed.history.at(-1).dirty, completed.history.at(-1).author], [head, true, 'codex-a']);
  await rm(join(root, 'b.txt'));
  assert.deepEqual(await headState(root), { head, dirty: false });
  await assert.rejects(updateFeature(root, 'git', 'complete', { phase: 'design', evidence: 'x', tool: 'Bad Tool' }), /tool|도구/);
  const stored = JSON.parse(await readFile(join(root, '.wax', 'features', 'git.json'), 'utf8'));
  assert.doesNotThrow(() => validateStored(stored));
  const old = structuredClone(stored); for (const item of old.history) { delete item.head; delete item.dirty; delete item.tool; }
  assert.doesNotThrow(() => validateStored(old));
  for (const bad of [{ head: 'HEAD' }, { dirty: 'yes' }, { tool: 'Codex App' }]) {
    const broken = structuredClone(stored); Object.assign(broken.history.at(-1), bad);
    assert.throws(() => validateStored(broken), /형식|format/);
  }
});

test('the trace lists files changed between visit commits, proof freshness, and the same data in Markdown', async (t) => {
  const root = await workspace(t);
  const commit = repo(root);
  await writeFile(join(root, '.gitignore'), '.wax/\n'); await writeFile(join(root, 'a.txt'), '1\n'); commit();
  const id = 'login';
  await createFeature(root, { id, title: '로그인 @octocat' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: phase === 'plan' ? '- AC-1: 로그인 — 검증: 테스트' : '# 설계' });
    await updateFeature(root, id, 'complete', { phase, evidence: '확인' });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'login.js'), 'one\ntwo\n'); commit();
  const proof = (await runTestProof(root, id, pass, { author: 'codex-a' })).proof;
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현함', proofIds: [proof.id], author: 'codex-a', tool: 'codex' });
  await updateFeature(root, id, 'iterate', { reason: '@octocat 토큰 만료 처리 빠짐', author: 'claude-b' });
  await writeFile(join(root, 'a.txt'), '2\n');

  const trace = await buildRunTrace(root, id, { language: 'en' });
  const [plan, design, implement, review, again] = trace.visits;
  assert.deepEqual(plan.files, { from: plan.startHead, to: plan.endHead, count: 0, files: [] });
  assert.equal(design.files.count, 0);
  assert.deepEqual(implement.files.files, [{ path: 'src/login.js', added: 2, deleted: 0 }]);
  assert.equal(implement.tool, 'codex');
  assert.deepEqual(implement.proofs[0].changed, { state: 'changed', count: 1, files: ['a.txt'] });
  assert.equal(review.outcome, 'iterate');
  assert.equal(again.open, true); assert.equal(again.files.live, true); assert.equal(again.files.count, 0);

  const md = trace.markdown;
  assert.match(md, /^# Run trace: /);
  assert.match(md, /## 3\. implement · iteration 0/);
  assert.match(md, /`src\/login\.js` \(\+2 −0\)/);
  assert.match(md, /Sent back to implement — `@octocat` /);
  assert.match(md, /1 files changed since recorded: `a\.txt`/);
  assert.match(md, /## 5\. implement · iteration 1/);
  assert.doesNotMatch(outsideCode(md), BARE_MENTION);
  const ko = (await buildRunTrace(root, id, { language: 'ko' })).markdown;
  assert.match(ko, /^# 실행 기록: /);
  assert.match(ko, /## 4\. 검토 · 주기 0/);
  assert.match(ko, /구현으로 되돌림/);

  const stored = JSON.parse(await readFile(join(root, '.wax', 'features', `${id}.json`), 'utf8'));
  for (const item of stored.history) delete item.head;
  await writeFile(join(root, '.wax', 'features', `${id}.json`), JSON.stringify(stored));
  const legacy = await buildRunTrace(root, id, { language: 'en' });
  assert.ok(legacy.visits.every((visit) => visit.files === null));
  assert.doesNotMatch(legacy.markdown, /### Changed files/);
});

test('wax trace prints Markdown by default and the trace data with --json', async (t) => {
  const root = await workspace(t);
  await createFeature(root, { id: 'cli-trace', title: 'CLI 실행 기록' });
  await updateFeature(root, 'cli-trace', 'save', { phase: 'plan', content: '# 기획' });
  await updateFeature(root, 'cli-trace', 'complete', { phase: 'plan', evidence: '확인', author: 'codex-a' });
  const md = wax(['trace', 'cli-trace', '--project', root], { WAX_LANG: 'en' });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^# Run trace: CLI 실행 기록/);
  assert.match(md.stdout, /## 2\. design · iteration 0/);
  assert.match(md.stdout, /Phase in progress/);
  const ko = wax(['trace', 'cli-trace', '--project', root], { WAX_LANG: 'ko' });
  assert.match(ko.stdout, /## 1\. 기획 · 주기 0/);
  const json = wax(['trace', 'cli-trace', '--project', root, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.markdown, undefined);
  assert.deepEqual(data.visits.map((v) => [v.phase, v.outcome, v.author]), [['plan', 'complete', 'codex-a'], ['design', 'open', null]]);
  const usage = wax(['trace', '--project', root], { WAX_LANG: 'en' });
  assert.equal(usage.status, 1); assert.match(usage.stderr, /Usage: trace <id> \[--json\]/);
  const missing = wax(['trace', 'nope', '--project', root], { WAX_LANG: 'en' });
  assert.equal(missing.status, 1);
});

test('a phase a headless worker completed through the CLI shows the tool from the PM loop worker launch record', () => {
  const feature = { id: 'f1', phase: 'review', iteration: 0, history: [ev('create', 'plan', 0), ev('complete', 'plan', HOUR, { author: 'wax-worker-codex' }),
    ev('complete', 'design', 2 * HOUR, { author: 'claude-a', tool: 'claude' }), ev('complete', 'implement', 3 * HOUR, { author: 'wax-worker-codex' })] };
  const launched = (tool, phase, ms) => ({ kind: 'worker', outcome: 'launched', tool, to: `wax-worker-${tool}`, phase, at: at(ms) });
  const pm = [launched('codex', 'plan', MIN), launched('codex', 'implement', 2 * HOUR + MIN), { kind: 'worker', outcome: 'exited', tool: 'codex', to: 'wax-worker-codex', phase: 'implement', at: at(3 * HOUR) }];
  const { visits } = traceVisits(feature, { pm, now: T0 + 4 * HOUR });
  assert.deepEqual(visits.map((visit) => [visit.phase, visit.author, visit.tool]), [
    ['plan', 'wax-worker-codex', 'codex'], ['design', 'claude-a', 'claude'], ['implement', 'wax-worker-codex', 'codex'], ['review', null, null]]);
  assert.equal(traceVisits(feature, { pm: [], now: T0 + 4 * HOUR }).visits[0].tool, null);
});
