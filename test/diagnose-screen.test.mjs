import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RULES, collect, diagnose, diagnoseCite, findingText, renderDiagnose } from '../src/diagnose.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { messages, fill } from '../web/messages-catalog.mjs';

const FEATURE = 'invoice-total', GOAL = 'goal-0000beef';
const BASE = Date.parse('2026-11-05T00:00:00.000Z');
const iso = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
const SECRET = ['gh', 'p_', 'b2'.repeat(18)].join('');
const proofId = (n) => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
const PLAN = ['# Plan', '- AC-1: total', '- AC-2: rounding',
  '- S-1: discount — files: src/a.js — check: `node --test test/a.test.js` — done: ok — AC: AC-1',
  '- S-2: rounding — files: src/b.js — check: `node --test test/b.test.js` — done: ok — AC: AC-2',
  '- S-3: docs — files: README.md — check: none(docs only) — done: ok — AC: AC-1',
  '- S-4: units — files: src/c.js — check: checks=unit-a,unit-b — done: ok — AC: AC-2',
  '- S-5: no check — files: src/d.js — done: ok — AC: AC-2'].join('\n');
const proof = (n, fields) => ({ id: proofId(n), kind: 'test', phase: 'implement', iteration: 1, at: iso(20 + n), command: ['node', '--test'], exitCode: 0, output: 'ok', durationMs: 5, ...fields });

function featureRecord(overrides = {}) {
  return {
    schemaVersion: 1, id: FEATURE, title: 'Invoice total', description: '', createdAt: iso(0), updatedAt: iso(60), iteration: 1, phase: 'review', revision: 7,
    artifacts: { plan: PLAN },
    proofs: [
      proof(1, { command: ['node', '--test', 'test/a.test.js'] }),
      proof(2, { command: ['node', '--test', 'test/b.test.js'], exitCode: 1, output: 'fail' }),
      proof(3, { command: ['node', '--test', 'test/b.test.js'], iteration: 0 }),
      proof(4, { command: ['node', '--test', 'test/b.test.js'], phase: 'review' }),
      proof(5, { checks: ['unit-a'], verification: 'runtime' }),
    ],
    completed: {
      plan: { at: iso(5), evidence: 'plan done', steps: { count: 5, mode: 'warn', warnings: [{ code: 'noCheck', ids: ['S-5'] }, { code: 'gap', ids: ['S-6'] }] } },
      implement: { at: iso(40), evidence: 'implemented', proofs: [proofId(1)] },
    },
    history: [{ action: 'create', phase: 'plan', at: iso(0) }, { action: 'complete', phase: 'plan', at: iso(5) }],
    ...overrides,
  };
}

async function makeProject(t, overrides) {
  const root = await mkdtemp(path.join(tmpdir(), 'wax-diagnose-screen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wax = (...parts) => path.join(root, '.wax', ...parts);
  await mkdir(wax('features'), { recursive: true });
  await mkdir(wax('chat', 'pm-loop'), { recursive: true });
  await writeFile(wax('features', `${FEATURE}.json`), `${JSON.stringify(featureRecord(overrides), null, 2)}\n`);
  await writeFile(wax('chat', 'pm-loop', `${GOAL}.json`), `${JSON.stringify({ id: GOAL, title: 'Invoices', features: [FEATURE], state: 'stopped', stoppedBy: 'ceo',
    stoppedReason: `paused ${SECRET}`, createdAt: iso(0) }, null, 2)}\n`);
  await writeFile(wax('chat', 'pm-loop', `${GOAL}.jsonl`), `${[
    { schema: 1, record: 'decision', id: 'pd-000001-abcdef', seq: 1, goal: GOAL, kind: 'goal', outcome: 'created', by: 'ceo', at: iso(0) },
    { schema: 1, record: 'decision', id: 'pd-000002-abcdef', seq: 2, goal: GOAL, kind: 'goal', outcome: 'stopped', by: 'ceo', reason: `token ${SECRET} at ${root}/src`, at: iso(50) },
  ].map((item) => JSON.stringify(item)).join('\n')}\n`);
  return root;
}
const plan = (report) => report.dimensions.find((item) => item.id === 'plan').findings;
const byCode = (report, code) => report.dimensions.flatMap((item) => item.findings).find((item) => item.code === code);

test('diagnose plan steps: steps with a check and no passing proof in this cycle’s implement are found; none(reason) and steps without a usable check are not counted', async (t) => {
  const root = await makeProject(t);
  const report = await diagnose(root, FEATURE);
  const missing = byCode(report, 'diagnose.plan.stepsNoGreen');
  assert.ok(missing, 'implement completed → warning');
  assert.equal(missing.severity, 'warn');
  assert.deepEqual(missing.args, [FEATURE, 2, 3, 'S-2, S-4']);
  assert.deepEqual(missing.numbers, { steps: 5, checked: 3, green: 1, missing: 2, none: 1 });
  assert.equal(missing.method, 'diagnose.method.stepsGreen');
  assert.deepEqual(missing.cites.map((cite) => cite.pointer), ['/artifacts/plan', '/completed/implement']);
  assert.ok(missing.cites.every((cite) => Number.isSafeInteger(cite.line) && cite.line > 0));
  const noCheck = byCode(report, 'diagnose.plan.stepWarning.noCheck');
  assert.deepEqual([noCheck.severity, noCheck.args, noCheck.cites[0].pointer], ['warn', [FEATURE, 'S-5'], '/completed/plan/steps/warnings/0']);
  assert.equal(byCode(report, 'diagnose.plan.stepWarning.gap').severity, 'info');
  assert.equal(report.dropped, 0);
  assert.match(renderDiagnose(report), /이 주기에 통과 근거가 없는 계획 단계 2개\(검사가 있는 단계 3개 가운데\): S-2, S-4/);
});

test('diagnose plan steps: all green, still implementing, before implement, and plans without steps', async (t) => {
  const greens = featureRecord().proofs.concat([proof(6, { command: ['node', '--test', 'test/b.test.js'] }), proof(7, { checks: ['unit-b', 'other'], verification: 'runtime' })]);
  const split = await diagnose(await makeProject(t, { proofs: greens }), FEATURE);
  assert.deepEqual(byCode(split, 'diagnose.plan.stepsNoGreen').args, [FEATURE, 1, 3, 'S-4']);
  greens.push(proof(8, { checks: ['unit-a', 'unit-b'], verification: 'runtime' }));
  const all = await diagnose(await makeProject(t, { proofs: greens }), FEATURE);
  const ok = byCode(all, 'diagnose.plan.stepsAllGreen');
  assert.deepEqual([ok.severity, ok.args], ['info', [FEATURE, 3]]);
  assert.ok(ok.cites.some((cite) => cite.pointer === '/proofs/5'), 'cites the matching proof');
  assert.equal(byCode(all, 'diagnose.plan.stepsNoGreen'), undefined);

  const working = await diagnose(await makeProject(t, { phase: 'implement', completed: { plan: featureRecord().completed.plan } }), FEATURE);
  assert.deepEqual([byCode(working, 'diagnose.plan.stepsPending').severity, byCode(working, 'diagnose.plan.stepsPending').cites.length], ['info', 1]);

  const early = await diagnose(await makeProject(t, { phase: 'design' }), FEATURE);
  assert.equal(plan(early).some((item) => /^diagnose\.plan\.steps/.test(item.code)), false, 'not judged before implement');

  const old = await diagnose(await makeProject(t, { artifacts: { plan: '# Plan\n- AC-1: total' }, completed: { implement: { at: iso(40), evidence: 'x' } } }), FEATURE);
  assert.equal(plan(old).some((item) => /^diagnose\.plan\.step/.test(item.code)), false, 'no S lines, no steps record → nothing');
});

test('diagnoseCite: shows only records the same report cites, scrubbed, with the JSON value or the jsonl line', async (t) => {
  const root = await makeProject(t);
  const report = await diagnose(root, GOAL);
  const stopped = byCode(report, 'diagnose.stop.goalStopped');
  const line = stopped.cites.find((cite) => cite.file.endsWith('.jsonl'));
  const shown = await diagnoseCite(root, GOAL, line);
  assert.equal(shown.file, `.wax/chat/pm-loop/${GOAL}.jsonl`);
  assert.match(shown.text, /"outcome": "stopped"/);
  assert.doesNotMatch(shown.text, new RegExp(SECRET));
  assert.doesNotMatch(shown.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(shown.text, /<project>/);

  const planCite = byCode(report, 'diagnose.plan.stepsNoGreen').cites[0];
  const planText = await diagnoseCite(root, GOAL, planCite);
  assert.equal(planText.text, PLAN);
  assert.equal(planText.truncated, false);
  const featureFile = await readFile(path.join(root, planCite.file), 'utf8');
  assert.match(featureFile.split('\n')[planCite.line - 1], /"plan":/, 'the cite line is where the value starts');

  for (const cite of [{ file: planCite.file, line: planCite.line, pointer: '/title' }, { file: planCite.file, line: planCite.line + 1, pointer: planCite.pointer },
    { file: '.wax/../package.json', line: 1 }, { file: '/etc/passwd', line: 1 }, { file: line.file, line: 'x' }, {}]) {
    await assert.rejects(diagnoseCite(root, GOAL, cite), (error) => error.status === 404, JSON.stringify(cite));
  }
});

test('the "N more findings" line keeps its last finding as code and args, so English text has no Korean', () => {
  const ctx = { features: [] };
  const rules = { stop: () => Array.from({ length: 4 }, (_, index) => ({ dimension: 'stop', severity: 'info', code: 'diagnose.stop.goalDone', args: [`goal-${index}`], numbers: {}, cites: [{ file: '.wax/x.jsonl', line: index + 1 }] })) };
  const { dimensions } = collect(ctx, rules, { perCode: 2 });
  const more = dimensions[0].findings.find((item) => item.code === 'diagnose.more');
  assert.deepEqual(more.of, { code: 'diagnose.stop.goalDone', args: ['goal-1'] });
  const english = (code, ...args) => fill(messages[code]?.[1] ?? code, args);
  assert.equal(findingText(more, english), '2 more findings of the same kind (the last of them: Goal goal-1 is done.)');
  assert.doesNotMatch(findingText(more, english), /[가-힣]/);
  assert.ok(RULES.plan);
});

test('GET /api/diagnose/<id>: the same scrubbed report and cited records, read-only, same-origin only, narrow ids', async (t) => {
  const root = await makeProject(t);
  const before = await readFile(path.join(root, '.wax', 'features', `${FEATURE}.json`), 'utf8');
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' }, intervalMs: 50 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = await (await fetch(`${base}/api/diagnose/${GOAL}`)).json();
  assert.equal(report.target.id, GOAL);
  assert.ok(report.dimensions.length >= 7);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SECRET));
  const cite = byCode(report, 'diagnose.stop.goalStopped').cites.find((item) => item.line);
  const query = new URLSearchParams({ file: cite.file, line: String(cite.line), ...(cite.pointer ? { pointer: cite.pointer } : {}) });
  const shown = await fetch(`${base}/api/diagnose/${GOAL}/cite?${query}`);
  assert.equal(shown.status, 200);
  assert.doesNotMatch((await shown.json()).text, new RegExp(SECRET));
  assert.equal((await fetch(`${base}/api/diagnose/${GOAL}/cite?file=.wax/features/${FEATURE}.json&line=1&pointer=/title`)).status, 404);
  assert.equal((await fetch(`${base}/api/diagnose/no-such-task`)).status, 404);
  assert.equal((await fetch(`${base}/api/diagnose/Bad.Id`)).status, 404, 'ids outside the narrow pattern do not reach diagnose');
  assert.equal((await fetch(`${base}/api/diagnose/${GOAL}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const { token } = await (await fetch(`${base}/api/config`)).json();
  assert.equal((await fetch(`${base}/api/diagnose/${GOAL}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: '{}' })).status, 404, 'no write route, even with the token');
  assert.equal(await readFile(path.join(root, '.wax', 'features', `${FEATURE}.json`), 'utf8'), before);
});
