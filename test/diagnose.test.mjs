import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DIMENSIONS, RULES, collect, citeText, diagnose, oneLine, renderDiagnose } from '../src/diagnose.mjs';
import { scrubContext } from '../src/scrub.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const GOAL = 'goal-0000abcd', FEATURE = 'shop-login';
const BASE = Date.parse('2026-11-05T00:00:00.000Z');
const iso = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
const HEAD_A = 'a'.repeat(40), HEAD_B = 'b'.repeat(40);
const SECRET = ['gh', 'p_', 'a1'.repeat(18)].join('');
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const proofId = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const failing = (n, minutes) => ({ id: proofId(n), kind: 'test', phase: 'implement', iteration: 1, at: iso(minutes), author: 'wax-worker-claude', command: ['node', '--test', 'test/login.test.mjs'],
  exitCode: 1, output: 'not ok 1 - login keeps the session\n  expected: 200\n  actual: 500', durationMs: 900, tree: { head: HEAD_A, files: { 'src/login.mjs': 'c'.repeat(40) } } });

function featureRecord() {
  return {
    schemaVersion: 1, id: FEATURE, title: 'Login', description: '', createdAt: iso(0), updatedAt: iso(90), iteration: 1, phase: 'review', revision: 9,
    artifacts: { plan: '# Plan\n- AC-1: login works\n- AC-2: logout works\n- AC-3: remember me' },
    proofs: [failing(1, 20), failing(2, 25), failing(3, 30),
      { id: proofId(4), kind: 'test', phase: 'implement', iteration: 1, at: iso(40), author: 'wax-worker-claude', command: ['node', '--test'], exitCode: 0, output: 'ok', durationMs: 800, tree: { head: HEAD_A, files: {} } },
      { id: proofId(5), kind: 'test', phase: 'implement', iteration: 1, at: iso(41), command: ['npm', 'test'], exitCode: 1, output: 'fail', durationMs: 10 },
      { id: proofId(6), kind: 'test', phase: 'implement', iteration: 1, at: iso(42), command: ['npm', 'test'], exitCode: 1, output: 'fail', durationMs: 10 }],
    completed: {
      plan: { at: iso(5), evidence: 'plan done' },
      implement: { at: iso(45), evidence: 'implemented', waiver: 'config only change', redGreen: { state: 'waived', mode: 'warn', pairs: [], defects: [], warnings: ['treeUnknown'], waiver: 'cannot fail first' } },
      review: { at: iso(80), evidence: 'reviewed', verdict: 'pass', acceptance: [{ id: 'AC-1', status: 'pass', proofIds: [proofId(4)] }, { id: 'AC-2', status: 'unverified', proofIds: [] }], acWaiver: 'AC-2 needs a phone' },
    },
    rulings: [
      { id: 'R-1', what: 'store sessions in sqlite', why: 'simple', cost: 'migration', area: 'structure', phase: 'implement', iteration: 1, at: iso(35), status: 'overridden', marked: { by: 'ceo', at: iso(70), note: 'use redis', defect: 'D-1' } },
      { id: 'R-2', what: 'name the cookie sid', why: 'short', cost: 'rename', area: 'naming', phase: 'implement', iteration: 1, at: iso(36), status: 'open' },
    ],
    defects: [{ id: 'D-1', status: 'open' }],
    history: [
      { action: 'create', phase: 'plan', at: iso(0) },
      { action: 'complete', phase: 'plan', at: iso(5), head: HEAD_A },
      { action: 'complete', phase: 'design', at: iso(10), head: HEAD_A },
      { action: 'complete', phase: 'implement', at: iso(45), head: HEAD_A },
      { action: 'complete', phase: 'review', at: iso(80), head: HEAD_B },
    ],
  };
}

const decision = (seq, minutes, fields) => ({ schema: 1, record: 'decision', id: `pd-${String(seq).padStart(6, '0')}-abcdef`, seq, goal: GOAL, ...fields, at: iso(minutes) });

async function makeProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'wax-diagnose-'));
  const wax = (...parts) => path.join(root, '.wax', ...parts);
  await mkdir(wax('features'), { recursive: true });
  await mkdir(wax('chat', 'pm-loop'), { recursive: true });
  await mkdir(wax('chat', 'snapshots'), { recursive: true });
  await mkdir(wax('approvals'), { recursive: true });
  await writeFile(wax('features', `${FEATURE}.json`), `${JSON.stringify(featureRecord(), null, 2)}\n`);
  await writeFile(wax('chat', 'pm-loop', `${GOAL}.json`), `${JSON.stringify({ id: GOAL, title: 'Ship login', features: [FEATURE, 'gone-task'], state: 'stopped', mode: 'auto',
    stoppedBy: 'auto', stoppedReason: 'approach-doubt: two root-cause attempts', stoppedAt: iso(95), createdAt: iso(0), updatedAt: iso(95) }, null, 2)}\n`);
  await writeFile(wax('chat', 'pm-loop', 'goal-ffff0000.json'), `${JSON.stringify({ id: 'goal-ffff0000', title: 'Other', features: ['other'], state: 'running', createdAt: iso(0) }, null, 2)}\n`);
  const home = path.join(tmpdir(), 'home-of-someone');
  const lines = [
    decision(1, 0, { kind: 'goal', outcome: 'created', by: 'ceo', reason: 'Ship login' }),
    decision(2, 12, { key: 'k-start', kind: 'start-worker', feature: FEATURE, phase: 'implement', iteration: 1, outcome: 'suggested', by: 'pm-loop', reason: 'no session' }),
    decision(3, 15, { key: 'k-start', kind: 'start-worker', feature: FEATURE, phase: 'implement', iteration: 1, outcome: 'executed', by: 'auto', reason: 'auto' }),
    decision(4, 15, { kind: 'worker', outcome: 'launched', worker: 'w-1', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, task: 't-1', to: 'wax-worker-claude', by: 'auto' }),
    decision(5, 26, { kind: 'repeat', outcome: 'warned', worker: 'w-1', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, by: 'pm-loop', repeat: { kind: 'test', key: 'k', count: 2, command: 'node --test test/login.test.mjs' }, reason: 'warned' }),
    decision(6, 31, { kind: 'worker', outcome: 'stuck', worker: 'w-1', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, task: 't-1', by: 'pm-loop', reason: 'repeated 3 times',
      repeat: { kind: 'test', count: 3, command: 'node --test test/login.test.mjs' }, usage: { source: 'claude', tokens: { input: 1000, output: 200, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd: 0.5, turns: 4 },
      output: { source: 'stderr', tail: `Error: bad credential ${SECRET}\nat ${root}/src/login.mjs:3\nhome ${home}/x\nmail me@example.com\n\u001b[31mred\u001b[0m`, bytes: 12000, kept: 300, scrubbed: 0, rpcError: { code: -32603, message: `internal ${SECRET}` } } }),
    '{"schema":1,"seq":7, broken',
    decision(8, 50, { kind: 'worker', outcome: 'launched', worker: 'w-2', tool: 'codex', feature: FEATURE, phase: 'implement', iteration: 1, task: 't-2', to: 'wax-worker-codex', by: 'auto', mode: 'root-cause', attempt: 1 }),
    decision(9, 60, { kind: 'worker', outcome: 'failed', worker: 'w-2', tool: 'codex', feature: FEATURE, phase: 'implement', iteration: 1, task: 't-2', by: 'pm-loop', reason: 'codex failed', usage: null,
      rootCause: { attempt: 1, reproduced: true, hypothesis: 'stale server holds the port', change: 'kill the server', result: 'not-fixed', repeatKey: 'k' } }),
    decision(10, 61, { kind: 'judgment', outcome: 'requested', judge: 'j-1', judgment: 'block', site: 'block', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, by: 'auto' }),
    decision(11, 64, { kind: 'judgment', outcome: 'proposed', judge: 'j-1', judgment: 'block', site: 'block', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, by: 'pm-loop', reason: 'retry',
      usage: { source: 'claude', tokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null, reasoning: null, total: null }, costUsd: 0.25, turns: 1 } }),
    decision(12, 70, { key: 'k-doubt', kind: 'approach-doubt', feature: FEATURE, phase: 'implement', iteration: 1, outcome: 'suggested', by: 'pm-loop', reason: 'two attempts did not fix it' }),
    decision(13, 95, { kind: 'goal', outcome: 'stopped', by: 'auto', rule: 'approach-doubt', reason: 'approach-doubt: two root-cause attempts' }),
  ].map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  await writeFile(wax('chat', 'pm-loop', `${GOAL}.jsonl`), `${lines.join('\n')}\n`);
  const approval = (n, fields) => writeFile(wax('approvals', `${uuid(n)}.json`), `${JSON.stringify({ schema: 1, id: uuid(n), project: root, tool: 'claude', session: 's', callId: `c${n}`, action: 'Bash',
    details: { input: { command: 'npm test' } }, createdAt: BASE + 20 * 60_000, expiresAt: BASE + 80 * 60_000, ownerPid: 1, secretHash: 'f'.repeat(64), events: [], goal: GOAL, ...fields }, null, 2)}\n`);
  await approval(1, { status: 'delivered', decision: 'allow', decidedBy: 'ceo', decidedAt: BASE + 35 * 60_000 });
  await approval(2, { status: 'delivered', decision: 'deny', decidedBy: 'ceo', decidedAt: BASE + 22 * 60_000, action: 'Write' });
  await approval(3, { status: 'pending' });
  await approval(4, { status: 'delivered', decision: 'allow', decidedBy: `goal-allow:${GOAL}`, decidedAt: BASE + 20 * 60_000 });
  await approval(5, { status: 'pending', goal: 'goal-ffff0000' });
  await writeFile(wax('chat', 'tool-health.jsonl'), `${JSON.stringify({ schema: 1, record: 'tool-health', id: 'th-1', seq: 1, kind: 'failure', tool: 'codex', shape: 'quota', rule: 'codex-usage-limit', goal: GOAL, feature: FEATURE, at: iso(60) })}\n`);
  await writeFile(wax('chat', 'snapshots', 'runs.jsonl'), `${JSON.stringify({ schema: 1, record: 'snapshot', id: 'snap-1', seq: 1, run: 'w-2', point: 'before', goal: GOAL, feature: FEATURE, state: 'unknown', reason: 'not-git', head: null, at: iso(50) })}\n`);
  await writeFile(wax('chat', 'worktree-setup.jsonl'), `${JSON.stringify({ schema: 1, record: 'event', id: 'ws-1', seq: 1, kind: 'run', worktree: 'wt-1', goal: GOAL, hash: 'h', outcome: 'failed', code: 1, signal: null, ms: 10, output: 'npm ci failed', at: iso(49) })}\n`);
  await writeFile(wax('chat', 'worktrees.jsonl'), `${JSON.stringify({ schema: 1, seq: 1, id: 'wt-1', goal: GOAL, feature: FEATURE, branch: 'wax/wt-1', path: path.join(tmpdir(), 'wax-wt-elsewhere'), state: 'active', at: iso(48) })}\n`);
  return { root, home };
}

const all = (report) => report.dimensions.flatMap((dimension) => dimension.findings);
const codes = (report, dimension) => report.dimensions.find((item) => item.id === dimension).findings.map((item) => item.code);
const find = (report, code) => all(report).find((item) => item.code === code);
async function lineOf(root, file, needle) {
  const rows = (await readFile(path.join(root, file), 'utf8')).split('\n');
  const index = rows.findIndex((row) => row.includes(needle));
  assert.ok(index >= 0, `${needle} in ${file}`);
  return index + 1;
}
const LOG = `.wax/chat/pm-loop/${GOAL}.jsonl`, GOAL_FILE = `.wax/chat/pm-loop/${GOAL}.json`, FEATURE_FILE = `.wax/features/${FEATURE}.json`;

test('diagnose: a stopped goal gives findings in every dimension, each with file:line cites', async (t) => {
  const { root } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await diagnose(root, GOAL);
  assert.deepEqual(report.dimensions.map((item) => item.id), DIMENSIONS);
  assert.deepEqual(report.target, { kind: 'goal', id: GOAL, goals: [GOAL], features: [FEATURE] });
  assert.equal(report.dropped, 0, 'no rule made a finding without cites');
  for (const item of all(report)) {
    assert.ok(item.cites.length, item.code);
    for (const cite of item.cites) assert.ok(cite.file.startsWith('.wax/') && !cite.file.includes('\\'), citeText(cite));
  }
  assert.equal(report.summary.code, 'diagnose.stop.goalStopped');
  assert.deepEqual(report.summary.cites.map(citeText), [`${GOAL_FILE}:${await lineOf(root, GOAL_FILE, '"state"')}#/state`, `${GOAL_FILE}:${await lineOf(root, GOAL_FILE, '"stoppedReason"')}#/stoppedReason`, `${LOG}:13`]);
  assert.match(report.summary.text, /approach-doubt/);
  const card = find(report, 'diagnose.stop.humanCard');
  assert.deepEqual([card.args[0], card.numbers.waitMs, card.cites.map(citeText)], ['approach-doubt', 25 * 60_000, [`${LOG}:12`, `${LOG}:13`]]);
  assert.deepEqual(codes(report, 'stop'), ['diagnose.stop.goalStopped', 'diagnose.stop.humanCard', 'diagnose.stop.workerEnded', 'diagnose.stop.phase']);

  const same = find(report, 'diagnose.repeat.sameFailure');
  assert.equal(same.numbers.count, 3);
  const proofLine = async (n) => (await lineOf(root, FEATURE_FILE, `"id": "${proofId(n)}"`)) - 1;
  assert.deepEqual(same.cites.map(citeText), [`${FEATURE_FILE}:${await proofLine(1)}#/proofs/0`, `${FEATURE_FILE}:${await proofLine(2)}#/proofs/1`, `${FEATURE_FILE}:${await proofLine(3)}#/proofs/2`]);
  assert.deepEqual(codes(report, 'repeat').sort(), ['diagnose.repeat.approachDoubt', 'diagnose.repeat.hypothesis', 'diagnose.repeat.retries', 'diagnose.repeat.sameFailure', 'diagnose.repeat.stuck', 'diagnose.repeat.untracked', 'diagnose.repeat.warned'].sort());
  assert.deepEqual(find(report, 'diagnose.repeat.stuck').cites.map(citeText), [`${LOG}:6`]);
  assert.match(find(report, 'diagnose.repeat.hypothesis').text, /stale server holds the port.*not-fixed/);
  assert.deepEqual(find(report, 'diagnose.repeat.retries').cites.map(citeText), [`${LOG}:4`, `${LOG}:8`]);

  assert.deepEqual(find(report, 'diagnose.plan.acMissing').args, [FEATURE, 'AC-3']);
  assert.deepEqual(find(report, 'diagnose.plan.acNotPassed').cites.map((cite) => cite.pointer), ['/completed/review/acceptance/1']);
  assert.ok(find(report, 'diagnose.plan.rulingOverridden'));
  assert.deepEqual(find(report, 'diagnose.plan.rulingsOpen').args.slice(1), [1, 'R-2']);
  assert.ok(find(report, 'diagnose.plan.defectsOpen'));

  assert.deepEqual(codes(report, 'evidence').sort(), ['diagnose.evidence.acUnverified', 'diagnose.evidence.changedAfter', 'diagnose.evidence.noProof', 'diagnose.evidence.noRed', 'diagnose.evidence.redGreenWarnings', 'diagnose.evidence.snapshotUnknown'].sort());
  const waiver = find(report, 'diagnose.evidence.noProof');
  assert.deepEqual(waiver.cites.map(citeText), [`${FEATURE_FILE}:${await lineOf(root, FEATURE_FILE, '"waiver": "config only change"')}#/completed/implement/waiver`]);
  assert.deepEqual(find(report, 'diagnose.evidence.changedAfter').args.slice(1), ['implement', 'review', HEAD_A.slice(0, 12), HEAD_B.slice(0, 12)]);

  const wait = find(report, 'diagnose.approval.wait');
  assert.deepEqual(wait.numbers, { count: 2, totalMs: 17 * 60_000, longestMs: 15 * 60_000, denied: 1 });
  assert.equal(wait.severity, 'warn');
  assert.equal(wait.cites[0].file, `.wax/approvals/${uuid(1)}.json`, 'the longest wait is cited first');
  assert.equal(find(report, 'diagnose.approval.open').numbers.count, 1);
  assert.equal(find(report, 'diagnose.approval.goalAllow').numbers.count, 1);

  const total = find(report, 'diagnose.cost.total');
  assert.deepEqual([total.numbers.runs, total.numbers.costUsd, total.numbers.costUnknown], [3, 0.75, 1]);
  assert.equal(total.severity, 'warn', 'unknown cost is called out');
  const claudeTime = all(report).find((item) => item.code === 'diagnose.cost.time' && item.args[0] === 'Claude Code');
  assert.deepEqual([claudeTime.numbers.runs, claudeTime.numbers.ms], [2, (16 + 3) * 60_000]);
  assert.ok(find(report, 'diagnose.cost.phases'));

  const output = find(report, 'diagnose.tool.outputRpc');
  assert.deepEqual(output.cites.map(citeText), [`${LOG}:6`]);
  assert.ok(find(report, 'diagnose.tool.noOutput'));
  assert.ok(find(report, 'diagnose.tool.health'));
  assert.ok(find(report, 'diagnose.tool.setup'));

  const broken = find(report, 'diagnose.records.broken');
  assert.deepEqual(broken.cites.map(citeText), [`${LOG}:7`]);
  assert.deepEqual(find(report, 'diagnose.records.featureMissing').cites.map((cite) => cite.pointer), ['/features/1']);
  assert.ok(report.read >= 10);
});

test('diagnose: secrets, tokens, the project and home paths, emails and control characters do not leave in the report', async (t) => {
  const { root, home } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = scrubContext({ roots: [root], homes: [home], user: null, env: {} });
  const report = await diagnose(root, GOAL, { context });
  const json = JSON.stringify(report);
  for (const leak of [SECRET, root, home, 'me@example.com']) assert.ok(!json.includes(leak), `leaked ${leak}`);
  const output = find(report, 'diagnose.tool.outputRpc');
  assert.match(output.quote, /<secret:github-token>/);
  assert.match(output.quote, /<project>\/src\/login\.mjs/);
  assert.match(output.quote, /~\/x/);
  assert.ok(!/\u001b/.test(output.quote), 'terminal control characters are dropped');
  assert.match(output.text, /JSON-RPC .*-32603: internal <secret:github-token>/);
  assert.ok(report.scrubbed >= 4 && report.scrubRules['secret:github-token'] >= 2);
  const markdown = renderDiagnose(report);
  for (const leak of [SECRET, root, home, 'me@example.com', '\u001b']) assert.ok(!markdown.includes(leak), `markdown leaked ${JSON.stringify(leak)}`);
  assert.equal(oneLine('a\u001b[31m\n\u202eb'), 'a [31m b');
});

test('diagnose: it only reads — every file under .wax is byte-for-byte the same, nothing is added', async (t) => {
  const { root } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = async () => {
    const out = [];
    for (const file of (await readdir(path.join(root, '.wax'), { recursive: true })).sort()) {
      const full = path.join(root, '.wax', file);
      const info = await stat(full);
      out.push([file, info.isFile() ? createHash('sha256').update(await readFile(full)).digest('hex') : 'dir', info.mtimeMs]);
    }
    return out;
  };
  const before = await tree();
  await diagnose(root, GOAL);
  await diagnose(root, FEATURE);
  assert.deepEqual(await tree(), before);
});

test('diagnose: a task target reads that task and the goals it belongs to, and --since drops older lines', async (t) => {
  const { root } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await diagnose(root, FEATURE);
  assert.deepEqual(report.target, { kind: 'feature', id: FEATURE, goals: [GOAL], features: [FEATURE] });
  assert.equal(report.summary.code, 'diagnose.stop.goalStopped');
  assert.equal(report.dropped, 0);
  const later = await diagnose(root, GOAL, { since: iso(55) });
  assert.equal(later.since, iso(55));
  assert.equal(find(later, 'diagnose.repeat.sameFailure'), undefined, 'proofs before --since are not counted');
  assert.equal(find(later, 'diagnose.repeat.stuck'), undefined);
  assert.equal(find(later, 'diagnose.approval.wait'), undefined, 'approvals created before --since are not counted');
  assert.ok(find(later, 'diagnose.repeat.hypothesis'));
  await assert.rejects(diagnose(root, GOAL, { since: 'yesterday' }), /ISO/);
});

test('diagnose: missing or invalid targets fail, an empty goal reports nothing found per dimension', async (t) => {
  const { root } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(diagnose(root, 'goal-12345678'), (error) => error.status === 404);
  await assert.rejects(diagnose(root, 'no-such-task'), (error) => error.status === 404);
  await assert.rejects(diagnose(root, '../etc'), /goal|task|목표|작업/);
  await writeFile(path.join(root, '.wax', 'chat', 'pm-loop', 'goal-22222222.json'), 'not json');
  await assert.rejects(diagnose(root, 'goal-22222222'), (error) => error.status === 500);
  await writeFile(path.join(root, '.wax', 'chat', 'pm-loop', 'goal-33333333.json'), JSON.stringify({ id: 'goal-33333333', title: 'Empty', features: [], state: 'running' }));
  const empty = await diagnose(root, 'goal-33333333');
  assert.deepEqual(codes(empty, 'stop'), ['diagnose.stop.goalState']);
  const markdown = renderDiagnose(empty);
  assert.equal((markdown.match(/찾은 것 없음 \(읽은 파일 \d+개\)/g) ?? []).length, DIMENSIONS.length - 1);
});

test('diagnose: a design run that proposed approaches and the run that writes the design are not a retry, real design retries still are', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wax-diagnose-approach-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const goal = 'goal-0000beef', feature = 'slug';
  await mkdir(path.join(root, '.wax', 'features'), { recursive: true });
  await mkdir(path.join(root, '.wax', 'chat', 'pm-loop'), { recursive: true });
  await writeFile(path.join(root, '.wax', 'features', `${feature}.json`), `${JSON.stringify({ schemaVersion: 1, id: feature, title: 'Slug', createdAt: iso(0), updatedAt: iso(60), iteration: 1, phase: 'design', revision: 5,
    approach: { proposals: [{ round: 1, at: iso(12), author: 'wax-worker-claude', items: [{ title: 'a' }, { title: 'b' }] }], pick: { round: 1, index: 0, by: 'ceo', via: 'dashboard', at: iso(15) }, single: null },
    history: [{ action: 'create', phase: 'plan', at: iso(0) }] }, null, 2)}\n`);
  await writeFile(path.join(root, '.wax', 'chat', 'pm-loop', `${goal}.json`), `${JSON.stringify({ id: goal, title: 'Slug', features: [feature], state: 'running', createdAt: iso(0) }, null, 2)}\n`);
  const launch = (seq, minutes, iteration, worker) => JSON.stringify({ schema: 1, record: 'decision', id: `pd-${String(seq).padStart(6, '0')}-abcdef`, seq, goal, kind: 'worker', outcome: 'launched',
    worker, tool: 'claude', feature, phase: 'design', iteration, task: `t-${seq}`, by: 'ceo', at: iso(minutes) });
  await writeFile(path.join(root, '.wax', 'chat', 'pm-loop', `${goal}.jsonl`), `${[launch(1, 10, 0, 'w-1'), launch(2, 20, 0, 'w-2'), launch(3, 40, 1, 'w-3'), launch(4, 50, 1, 'w-4')].join('\n')}\n`);
  const report = await diagnose(root, goal);
  const retries = all(report).filter((item) => item.code === 'diagnose.repeat.retries');
  const log = `.wax/chat/pm-loop/${goal}.jsonl`;
  assert.deepEqual(retries.map((item) => [item.args[2], item.numbers.launches, item.cites.map(citeText)]), [[1, 2, [`${log}:3`, `${log}:4`]]], 'only cycle 1 is a retry');

  await writeFile(path.join(root, '.wax', 'chat', 'pm-loop', `${goal}.jsonl`), `${[launch(1, 10, 0, 'w-1'), launch(2, 20, 0, 'w-2'), launch(3, 30, 0, 'w-3')].join('\n')}\n`);
  const again = all(await diagnose(root, goal)).filter((item) => item.code === 'diagnose.repeat.retries');
  assert.deepEqual(again.map((item) => [item.numbers.launches, item.cites.map(citeText)]), [[2, [`${log}:2`, `${log}:3`]]]);
});

test('diagnose: big records are read up to the limits with a truncated finding, links are not followed', async (t) => {
  const { root } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const byLines = await diagnose(root, GOAL, { limits: { lines: 5 } });
  const cut = find(byLines, 'diagnose.records.truncatedLines');
  assert.deepEqual(cut.cites.map(citeText), [`${LOG}:5`]);
  assert.equal(find(byLines, 'diagnose.repeat.stuck'), undefined, 'lines past the limit are not read');
  const byBytes = await diagnose(root, GOAL, { limits: { bytes: 2000 } });
  assert.ok(all(byBytes).some((item) => item.code === 'diagnose.records.truncatedBytes' && item.cites[0].file === LOG));
  assert.ok(all(byBytes).some((item) => item.code === 'diagnose.records.truncatedBytes' && item.cites[0].file === FEATURE_FILE), 'an indented JSON over the limit is not parsed');
  assert.equal(byBytes.dropped, 0);

  const outside = await mkdtemp(path.join(tmpdir(), 'wax-diagnose-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'health.jsonl'), `${JSON.stringify({ seq: 1, kind: 'failure', tool: 'codex', shape: 'config', goal: GOAL, at: iso(1) })}\n`);
  await rm(path.join(root, '.wax', 'chat', 'tool-health.jsonl'));
  try { await symlink(path.join(outside, 'health.jsonl'), path.join(root, '.wax', 'chat', 'tool-health.jsonl')); }
  catch (error) { t.diagnostic(`symlink not available: ${error.code}`); return; }
  const linked = await diagnose(root, GOAL);
  assert.deepEqual(find(linked, 'diagnose.records.link').cites, [{ file: '.wax/chat/tool-health.jsonl' }]);
  assert.equal(find(linked, 'diagnose.tool.health'), undefined, 'the linked file is not read');
});

test('diagnose: collect drops and counts findings without cites, so a rule cannot make one silently', () => {
  const ctx = {};
  const rules = { ...Object.fromEntries(Object.keys(RULES).map((id) => [id, () => []])),
    stop: () => [{ dimension: 'stop', severity: 'info', code: 'diagnose.stop.goalDone', args: ['g'], numbers: {}, cites: [] },
      { dimension: 'stop', severity: 'info', code: 'diagnose.stop.goalDone', args: ['h'], numbers: {}, cites: [{ file: '.wax/x.json', line: 2 }] },
      { dimension: 'stop', severity: 'stop', code: 'diagnose.stop.goalStopped', args: ['h', 'p', 'r'], numbers: {}, cites: [{ file: '.wax/x.json', line: 1 }] }] };
  const { dimensions, dropped } = collect(ctx, rules);
  assert.equal(dropped, 1);
  assert.deepEqual(dimensions[0].findings.map((item) => item.severity), ['stop', 'info'], 'stop before info');
  assert.equal(dimensions[0].findings[1].text, '목표 h은(는) 끝났습니다.');
  const many = { ...rules, stop: () => Array.from({ length: 5 }, (_, n) => ({ dimension: 'stop', severity: 'info', code: 'diagnose.stop.goalDone', args: [`g${n}`], numbers: {}, cites: [{ file: '.wax/x.jsonl', line: n + 1 }] })) };
  const grouped = collect(ctx, many, { perCode: 2 }).dimensions[0].findings;
  assert.deepEqual(grouped.map((item) => item.args[0]), ['g3', 'g4', 3]);
  assert.equal(grouped[2].code, 'diagnose.more');
  assert.deepEqual(grouped[2].cites.map((cite) => cite.line), [1, 2, 3]);
  assert.match(grouped[2].text, /3개 더.*g2/);
});

test('wax diagnose CLI: Markdown or --json, exit 0 for a report and 1 for a missing target, English with WAX_LANG=en', async (t) => {
  const { root } = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, WAX_LANG: 'ko' };
  const markdown = await run(process.execPath, [CLI, 'diagnose', GOAL, '--project', root], { env });
  assert.match(markdown.stdout, /^# wax 진단: goal-0000abcd/m);
  assert.match(markdown.stdout, /^## 왜 멈췄나/m);
  assert.match(markdown.stdout, /한 줄 요약: 목표 goal-0000abcd이\(가\) 멈춤 상태입니다/);
  assert.match(markdown.stdout, /`\.wax\/chat\/pm-loop\/goal-0000abcd\.jsonl:6`/);
  assert.ok(!markdown.stdout.includes(SECRET) && !markdown.stdout.includes(root));
  const json = JSON.parse((await run(process.execPath, [CLI, '--project', root, 'diagnose', FEATURE, '--json'], { env })).stdout);
  assert.equal(json.target.kind, 'feature');
  const english = await run(process.execPath, [CLI, 'diagnose', GOAL, '--project', root], { env: { ...process.env, WAX_LANG: 'en' } });
  assert.match(english.stdout, /^## Why it stopped/m);
  assert.match(english.stdout, /In one line: Goal goal-0000abcd is stopped/);
  for (const args of [['diagnose', 'goal-99999999'], ['diagnose'], ['diagnose', GOAL, '--level', 'full'], ['diagnose', GOAL, '--zip', 'out'], ['diagnose', GOAL, '--since', 'soon']]) {
    await assert.rejects(run(process.execPath, [CLI, ...args, '--project', root], { env }), (error) => error.code === 1 && /wax diagnose:/.test(error.stderr), args.join(' '));
  }
  const help = await run(process.execPath, [CLI, 'diagnose', '--help'], { env });
  assert.match(help.stdout, /읽기 전용/);
});
