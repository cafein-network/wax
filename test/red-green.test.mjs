import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assessRedGreen, checkKey, effectiveRedGreenMode, isTestPath, matchTests, pairFor, parseTestNames, ranNoTests, redGreenMode, redGreenWarning,
  treeChange, validDiscipline, validRedGreen } from '../src/red-green.mjs';
import { treeKey as stuckTreeKey } from '../src/chat/stuck-check.mjs';
import { treeKey } from '../src/freshness.mjs';

const HEAD = 'a'.repeat(40), OTHER_HEAD = 'c'.repeat(40);
const blob = (n) => String(n).repeat(40).slice(0, 40);
const tree = (files, head = HEAD) => ({ head, files });
const BEFORE = tree({ 'test/add.test.mjs': blob(1) });
const AFTER = tree({ 'test/add.test.mjs': blob(1), 'src/add.mjs': blob(2) });
let clock = Date.parse('2026-11-05T00:00:00Z');
const at = () => new Date(clock += 1000).toISOString();
const command = ['node', '--test', 'test/add.test.mjs'];
const proof = (extra = {}) => ({ id: randomUUID(), kind: 'test', phase: 'implement', iteration: 0, at: at(), command, commit: HEAD, dirty: true,
  durationMs: 5, exitCode: 0, signal: null, output: '', truncated: false, timedOut: false, tree: AFTER, ...extra });
const red = (extra = {}) => proof({ exitCode: 1, tree: BEFORE, ...extra });
const feature = (proofs, extra = {}) => ({ id: 'pay', projectType: 'general', workMode: 'project', iteration: 0, proofs, ...extra });
const judge = (proofs, greens, extra = {}, options = {}) => assessRedGreen(feature(proofs, extra), 'implement', greens.map((item) => item.id), options.waiver, { mode: 'warn', platform: 'linux', ...options });

const TAP_RED = 'TAP version 13\n# Subtest: 더하기는 합을 낸다\nnot ok 1 - 더하기는 합을 낸다\n  ---\n  ...\n# Subtest: passes \\# hash\nok 2 - passes \\# hash\nok 3 - skipped # SKIP\nnot ok 4 - later # TODO\n1..4\n# tests 4\n# pass 1\n# fail 1\n';
const TAP_GREEN = 'TAP version 13\r\nok 1 - 더하기는 합을 낸다\r\nok 2 - passes \\# hash\r\n1..2\r\n# tests 2\r\n';

test('modes: WAX_RED_GREEN defaults to warn, rejects unknown values, and a task can only tighten it', () => {
  assert.equal(redGreenMode(undefined), 'warn');
  assert.equal(redGreenMode(''), 'warn');
  assert.equal(redGreenMode('enforce'), 'enforce');
  assert.throws(() => redGreenMode('strict'), /WAX_RED_GREEN/);
  assert.equal(effectiveRedGreenMode({ discipline: { redGreen: 'enforce' } }, 'warn'), 'enforce');
  assert.equal(effectiveRedGreenMode({ discipline: { redGreen: 'enforce' } }, undefined), 'enforce');
  assert.equal(effectiveRedGreenMode({ discipline: { redGreen: 'enforce' } }, 'off'), 'off');
  assert.equal(effectiveRedGreenMode({ discipline: { redGreen: 'warn' } }, 'enforce'), 'enforce');
  assert.equal(effectiveRedGreenMode({}, 'enforce'), 'enforce');
  assert.equal(validDiscipline({ redGreen: 'enforce' }), true);
  assert.equal(validDiscipline({}), true);
  assert.equal(validDiscipline({ redGreen: 'off' }), false);
  assert.equal(validDiscipline({ redGreen: 'enforce', other: 'x' }), false);
  assert.equal(validDiscipline([]), false);
});

test('treeKey is shared between the repeat check and red→green', () => {
  assert.equal(stuckTreeKey, treeKey);
  assert.equal(treeKey({ head: HEAD, unknown: true }), null);
  assert.deepEqual(treeKey(tree({ b: blob(1), a: null })), [HEAD, [['a', null], ['b', blob(1)]]]);
});

test('check key: sorted checks plus the whole command; one side with checks is a different check; Windows slashes and drive case', () => {
  const a = checkKey({ command, checks: ['e2e-smoke', 'd-1'] }, 'linux'), b = checkKey({ command, checks: ['d-1', 'e2e-smoke', 'd-1'] }, 'linux');
  assert.equal(a.key, b.key);
  assert.equal(a.label, 'checks:d-1,e2e-smoke');
  assert.notEqual(checkKey({ command }, 'linux').key, a.key);
  assert.match(checkKey({ command }, 'linux').label, /^cmd:[a-f0-9]{16}$/);
  assert.notEqual(checkKey({ command: ['node', '-e', 'process.exit(1)'], checks: ['e2e-smoke'] }, 'linux').key, checkKey({ command, checks: ['e2e-smoke'] }, 'linux').key);
  const win = ['C:\\Program Files\\node.exe', '--test', 'test\\a.test.js'], posix = ['c:/Program Files/node.exe', '--test', 'test/a.test.js'];
  assert.equal(checkKey({ command: win }, 'win32').key, checkKey({ command: posix }, 'win32').key);
  assert.notEqual(checkKey({ command: win }, 'linux').key, checkKey({ command: posix }, 'linux').key);
});

test('a red is a failed test with an integer exit code; timeouts, null exit codes and runs with no tests are not', () => {
  const first = red(), green = proof();
  assert.equal(judge([first, green], [green]).record.state, 'ok');
  for (const bad of [{ exitCode: 1, timedOut: true }, { exitCode: null }, { exitCode: 0 }]) {
    const candidate = red(bad), later = proof();
    assert.equal(judge([candidate, later], [later]).record.state, 'missing', JSON.stringify(bad));
  }
  assert.equal(ranNoTests({ exitCode: 127, output: '' }), true);
  assert.equal(ranNoTests({ exitCode: 1, output: 'TAP version 13\n1..0\n# tests 0\n# pass 0\n' }), true);
  assert.equal(ranNoTests({ exitCode: 1, output: 'ℹ tests 0\r\nℹ pass 0\r\n' }), true);
  assert.equal(ranNoTests({ exitCode: 1, output: '<testsuites tests="0"></testsuites>' }), true);
  assert.equal(ranNoTests({ exitCode: 1, output: '# tests 10\n' }), false);
  const none = red({ output: '# tests 0\n' }), after = proof();
  const judged = judge([none, after], [after]).record;
  assert.equal(judged.state, 'missing');
  assert.deepEqual(judged.warnings, ['noTests']);
});

test('pair rules: same folder, same phase and cycle, red first, code changed; the latest eligible red wins', () => {
  const worktree = { id: 'goal-abcdef12-1', branch: 'wax/goal-abcdef12/pay-1' };
  const cases = [
    ['other worktree', red({ worktree }), proof()],
    ['project red, worktree green', red(), proof({ worktree })],
    ['other cycle', red({ iteration: 1 }), proof()],
    ['other phase', red({ phase: 'design' }), proof()],
    ['other command', red({ command: ['node', '-e', 'process.exit(1)'] }), proof()],
    ['checks on one side', red({ checks: ['e2e-smoke'], verification: 'runtime' }), proof()],
  ];
  for (const [name, candidate, green] of cases) assert.equal(judge([candidate, green], [green]).record.state, 'missing', name);
  const green = proof(), late = red();
  assert.equal(judge([green, late], [green]).record.state, 'missing');
  const wRed = red({ worktree }), wGreen = proof({ worktree });
  assert.equal(judge([wRed, wGreen], [wGreen]).record.pairs[0].folder, 'goal-abcdef12-1');
  const same = red({ tree: AFTER }), again = proof();
  const judged = judge([same, again], [again]).record;
  assert.equal(judged.state, 'missing');
  assert.deepEqual(judged.warnings, ['sameTree']);
  const first = red(), middle = proof({ tree: tree({ 'src/add.mjs': blob(3) }) }), second = red({ tree: tree({ 'src/add.mjs': blob(4) }) }), sameAsGreen = red({ tree: AFTER }), last = proof();
  const pair = judge([first, middle, second, sameAsGreen, last], [last]).record.pairs[0];
  assert.equal(pair.red, second.id);
  assert.equal(pair.green, last.id);
  assert.deepEqual(pairFor(feature([last]), last, { platform: 'linux' }), { reason: null });
});

test('tree change: unknown trees still pair with a warning; head changes leave the changed count unknown; tests-only changes warn', () => {
  assert.deepEqual(treeChange(undefined, AFTER), { known: false, changed: null, paths: null });
  assert.deepEqual(treeChange({ head: HEAD, unknown: true }, AFTER), { known: false, changed: null, paths: null });
  assert.deepEqual(treeChange(BEFORE, AFTER), { known: true, same: false, changed: 1, paths: ['src/add.mjs'] });
  assert.deepEqual(treeChange(tree({}), tree({ 'src/gone.mjs': null })).paths, ['src/gone.mjs']);
  assert.deepEqual(treeChange(BEFORE, tree({}, OTHER_HEAD)), { known: true, same: false, changed: null, paths: null });

  const noGit = red({ tree: undefined }), noGitGreen = proof({ tree: undefined });
  const unknown = judge([noGit, noGitGreen], [noGitGreen]).record;
  assert.equal(unknown.state, 'ok');
  assert.equal(unknown.pairs[0].treeChanged, null);
  assert.deepEqual(unknown.warnings, ['treeUnknown']);
  assert.match(redGreenWarning(unknown), /바뀐 코드를 확인하지 못했습니다/);

  const testOnlyRed = red({ tree: tree({}) }), testOnlyGreen = proof({ tree: tree({ 'test/add.test.mjs': blob(5), 'src/__tests__/x.js': blob(6) }) });
  const testsOnly = judge([testOnlyRed, testOnlyGreen], [testOnlyGreen]).record;
  assert.equal(testsOnly.pairs[0].testsOnly, true);
  assert.equal(testsOnly.pairs[0].changed, 2);
  assert.deepEqual(testsOnly.warnings, ['testsOnly']);
  const movedRed = red(), moved = proof({ tree: tree({}, OTHER_HEAD) });
  const committed = judge([movedRed, moved], [moved]).record.pairs[0];
  assert.equal(committed.treeChanged, true);
  assert.equal(committed.changed, null);
  assert.equal(committed.testsOnly, false);
});

test('test file paths', () => {
  for (const path of ['test/a.mjs', 'pkg/tests/a.py', 'src/__tests__/a.js', 'spec/a.rb', 'src/a.test.ts', 'src/a.spec.js', 'pkg/a_test.go', 'Test\\a.cs'])
    assert.equal(isTestPath(path), true, path);
  for (const path of ['src/add.mjs', 'src/testing.mjs', 'contest/a.js', 'src/latest.js', 'docs/spec.md']) assert.equal(isTestPath(path), false, path);
});

test('test names: TAP and JUnit only, SKIP and TODO excluded, escapes and CRLF handled', () => {
  assert.deepEqual(parseTestNames(TAP_RED), { parse: 'tap', failed: ['더하기는 합을 낸다'], passed: ['passes # hash'] });
  assert.deepEqual(parseTestNames(TAP_GREEN), { parse: 'tap', failed: [], passed: ['더하기는 합을 낸다', 'passes # hash'] });
  const junit = '<?xml version="1.0"?><testsuites><testcase name="a &amp; b" classname="t"><failure message="x"/></testcase>' +
    '<testcase name="ok one" classname="t"/><testcase name="skip" classname="t"><skipped/></testcase><testcase name="err" classname="t"><error/></testcase></testsuites>';
  assert.deepEqual(parseTestNames(junit), { parse: 'junit', failed: ['a & b', 'err'], passed: ['ok one'] });
  assert.deepEqual(parseTestNames('✖ 더하기는 합을 낸다 (0.5ms)\nℹ tests 1\n'), { parse: 'none', failed: [], passed: [] });
  assert.deepEqual(parseTestNames('FAILED test_add.py::test_sum\n'), { parse: 'none', failed: [], passed: [] });

  assert.deepEqual(matchTests({ output: TAP_RED }, { output: TAP_GREEN }), { parse: 'tap', failed: ['더하기는 합을 낸다'], matched: true });
  assert.deepEqual(matchTests({ output: TAP_RED }, { output: 'TAP version 13\nok 1 - 다른 테스트\n' }), { parse: 'tap', failed: ['더하기는 합을 낸다'], matched: false });
  assert.deepEqual(matchTests({ output: TAP_RED }, { output: 'all good' }), { parse: 'none', failed: ['더하기는 합을 낸다'], matched: null });
  assert.equal(matchTests({ output: TAP_RED }, { output: 'TAP version 13\nok 1 - 다른 테스트\n', truncated: true }).parse, 'none');
  const many = `TAP version 13\n${Array.from({ length: 5 }, (_, i) => `not ok ${i + 1} - ${'긴'.repeat(300)}${i}`).join('\n')}\n`;
  const limited = matchTests({ output: many }, { output: TAP_GREEN });
  assert.equal(limited.failed.length, 3);
  assert.ok(limited.failed.every((name) => name.length === 200));

  const otherRed = red({ output: TAP_RED }), otherGreen = proof({ output: 'TAP version 13\nok 1 - 다른 테스트\n# tests 1\n' });
  const judged = judge([otherRed, otherGreen], [otherGreen]).record;
  assert.equal(judged.state, 'ok');
  assert.deepEqual(judged.warnings, ['otherTest']);
  assert.match(redGreenWarning(judged), /다른 테스트가 실패했다가 통과했습니다/);
});

test('--no-red: refused with a pair, outside implement and when malformed; recorded as waived', () => {
  const r = red(), g = proof();
  assert.throws(() => judge([r, g], [g], {}, { waiver: '문서만 바뀜' }), /--no-red 사유를 함께 쓰지 마세요/);
  assert.throws(() => judge([g], [g], {}, { waiver: ' ' }), /--no-red/);
  assert.throws(() => judge([g], [g], {}, { waiver: 'x'.repeat(2001) }), /2000/);
  assert.throws(() => assessRedGreen(feature([g]), 'review', [g.id], '사유', { mode: 'warn' }), /구현 단계에만/);
  assert.deepEqual(assessRedGreen(feature([g]), 'review', [g.id], undefined, { mode: 'enforce' }), { record: null });
  const waived = judge([g], [g], {}, { waiver: ' 설정 파일만 바뀜 ', mode: 'enforce' }).record;
  assert.equal(waived.state, 'waived');
  assert.equal(waived.waiver, '설정 파일만 바뀜');
  assert.equal(redGreenWarning(waived), null);
  assert.equal(validRedGreen(waived), true);
});

test('modes: warn completes with a warning, enforce refuses with 409, off computes nothing', () => {
  const g = proof();
  const warned = judge([g], [g]).record;
  assert.equal(warned.state, 'missing');
  assert.match(redGreenWarning(warned), /빨강→초록 경고.*고치기 전에 실패한 같은 검사/);
  assert.throws(() => judge([g], [g], {}, { mode: 'enforce' }), (error) => error.status === 409 && /WAX_RED_GREEN=enforce/.test(error.message));
  assert.throws(() => judge([g], [g], { discipline: { redGreen: 'enforce' } }, { mode: 'warn' }), /enforce/);
  assert.deepEqual(judge([g], [g], { discipline: { redGreen: 'enforce' } }, { mode: 'off' }), { record: null });
  assert.equal(judge([g], [g], {}, { mode: 'off', waiver: '사유' }).record.state, 'waived');
});

test('which tasks: no test proof in a general project is skipped silently under warn but not under enforce', () => {
  const skipped = assessRedGreen(feature([]), 'implement', [], undefined, { mode: 'warn' }).record;
  assert.equal(skipped.state, 'skipped');
  assert.equal(redGreenWarning(skipped), null);
  assert.equal(assessRedGreen(feature([], { projectType: 'web' }), 'implement', [], undefined, { mode: 'warn' }).record.state, 'missing');
  assert.throws(() => assessRedGreen(feature([]), 'implement', [], undefined, { mode: 'enforce' }), /409|enforce/);
});

test('defects: each open defect needs a pair whose checks carry d-N; --no-red covers the whole completion', () => {
  const defects = [{ id: 'D-1', title: '반올림', status: 'open', foundIteration: 0, foundAt: at() }, { id: 'D-2', title: '영수증', status: 'open', foundIteration: 0, foundAt: at() }];
  const extra = { iteration: 1, defects };
  const d1 = { checks: ['d-1'], verification: 'runtime', iteration: 1 };
  const r1 = red(d1), g1 = proof(d1);
  const partial = judge([r1, g1], [g1], extra).record;
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.defects, [{ id: 'D-1', state: 'ok', pair: 0 }, { id: 'D-2', state: 'missing', pair: null }]);
  assert.equal(partial.pairs[0].defect, 'D-1');
  assert.match(redGreenWarning(partial), /D-2/);
  assert.throws(() => judge([r1, g1], [g1], extra, { mode: 'enforce' }), /D-2.*enforce/);
  assert.equal(validRedGreen(partial), true);
  const both = { checks: ['d-2', 'd-1'], verification: 'runtime', iteration: 1 };
  const r2 = red(both), g2 = proof(both);
  const ok = judge([r2, g2], [g2], extra, { mode: 'enforce' }).record;
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.defects.map((item) => item.state), ['ok', 'ok']);
  const lonely = proof(d1);
  assert.equal(judge([lonely], [lonely], extra).record.state, 'missing');
  const waived = judge([lonely], [lonely], extra, { mode: 'enforce', waiver: '재현 불가' }).record;
  assert.equal(waived.state, 'waived');
  assert.deepEqual(waived.defects.map((item) => item.state), ['missing', 'missing']);
  const resolved = [{ ...defects[0], status: 'resolved', resolvedIteration: 1, resolvedAt: at(), proofIds: [g1.id] }];
  assert.equal(judge([r1, g1], [g1], { iteration: 1, defects: resolved }).record.state, 'ok');
});

test('validRedGreen rejects malformed records', () => {
  const r = red(), g = proof();
  const good = judge([r, g], [g]).record;
  assert.equal(validRedGreen(good), true);
  const broken = [
    { ...good, state: 'fine' }, { ...good, mode: 'strict' }, { ...good, warnings: ['made-up'] }, { ...good, warnings: ['testsOnly', 'testsOnly'] },
    { ...good, pairs: [] }, { ...good, waiver: '사유' }, { ...good, state: 'waived' },
    { ...good, pairs: [{ ...good.pairs[0], red: 'x' }] }, { ...good, pairs: [{ ...good.pairs[0], red: g.id }] },
    { ...good, pairs: [{ ...good.pairs[0], check: 'anything' }] }, { ...good, pairs: [{ ...good.pairs[0], folder: '../x' }] },
    { ...good, pairs: [{ ...good.pairs[0], treeChanged: false }] }, { ...good, pairs: [{ ...good.pairs[0], tests: { parse: 'tap', failed: ['x'.repeat(201)], matched: true } }] },
    { ...good, defects: [{ id: 'D-1', state: 'ok', pair: 3 }] }, { ...good, defects: [{ id: 'D-1', state: 'missing', pair: null }] },
    { ...good, state: 'partial' }, { ...good, state: 'missing' }, null, [],
  ];
  for (const record of broken) assert.equal(validRedGreen(record), false, JSON.stringify(record));
});
