import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPrompt, createFeature, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { RULING_LIMITS, RULING_NOT_ALONE, flagged, newRuling, rulingInput, rulingSummary, validRulings } from '../src/rulings.mjs';
import { featureStatus } from '../src/status.mjs';
import { workerPrompt } from '../src/chat/pm-loop.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const AUTHOR = 'wax-worker-claude';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-ruling-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createFeature(dir, { id: 'calc', title: '금액 계산', projectType: 'general' });
  return dir;
}
const wax = (root, ...args) => spawnSync(process.execPath, [CLI, '--project', root, ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });
const record = (root, input, extra = {}) => updateFeature(root, 'calc', 'ruling', { ruling: input, ...extra });
const sample = { what: '날짜 계산을 src/date.js로 뺌', why: '두 곳에서 같은 계산', cost: '되돌리면 파일 하나 합치기' };

test('CLI ruling records R-N from flags or a --file JSON, at the current stage and cycle, and shows in the history', async (t) => {
  const root = await workspace(t);
  const first = wax(root, 'ruling', 'calc', '--what', sample.what, '--why', sample.why, '--cost', sample.cost, '--area', 'structure', '--author', AUTHOR);
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.ruling.id, 'R-1');
  assert.deepEqual({ ...out.ruling, at: undefined }, { id: 'R-1', phase: 'plan', iteration: 0, at: undefined, author: AUTHOR, area: 'structure', ...sample, flag: false, status: 'open' });
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  const file = join(root, '.wax', 'tmp', 'r.json');
  await writeFile(file, JSON.stringify({ what: '반올림은 0.5에서 올림 (i < n; $x)', why: 'AC-1에 반올림 방식이 없음', cost: '금액이 1원씩 다를 수 있음', area: 'behavior' }));
  const second = wax(root, 'ruling', 'calc', '--file', file, '--phase', 'plan', '--author', AUTHOR, '--revision', String(out.revision));
  assert.equal(second.status, 0, second.stderr);
  const feature = await getFeature(root, 'calc');
  assert.deepEqual(feature.rulings.map((item) => [item.id, item.area, item.what]), [['R-1', 'structure', sample.what], ['R-2', 'behavior', '반올림은 0.5에서 올림 (i < n; $x)']]);
  assert.deepEqual(feature.history.filter((event) => event.action === 'ruling').map((event) => [event.ruling, event.phase, event.author]), [['R-1', 'plan', AUTHOR], ['R-2', 'plan', AUTHOR]]);
  assert.equal(validateStored(feature), feature);
  assert.equal(JSON.parse(await readFile(join(root, '.wax', 'features', 'calc.json'), 'utf8')).rulings.length, 2);
});

test('CLI ruling refuses bad input: missing or long fields, unknown area, flags mixed with --file, odd file shape, wrong stage, stale revision', async (t) => {
  const root = await workspace(t);
  const refuse = (args, pattern) => { const run = wax(root, 'ruling', 'calc', ...args); assert.equal(run.status, 1, args.join(' ')); assert.match(run.stderr, pattern, args.join(' ')); };
  refuse(['--what', 'x', '--why', 'y'], /cost/);
  refuse(['--what', 'x'.repeat(RULING_LIMITS.what + 1), '--why', 'y', '--cost', 'z'], /what.*200/);
  refuse(['--what', 'x', '--why', 'y'.repeat(RULING_LIMITS.why + 1), '--cost', 'z'], /why.*500/);
  refuse(['--what', 'x', '--why', 'y', '--cost', 'z'.repeat(RULING_LIMITS.cost + 1)], /cost.*300/);
  refuse(['--what', ' ', '--why', 'y', '--cost', 'z'], /what/);
  refuse(['--what', 'x', '--why', 'y', '--cost', 'z', '--area', 'security'], /--area/);
  refuse(['--what', 'x', '--why', 'y', '--cost', 'z', '--phase', 'implement'], /지금 단계\(plan\)/);
  refuse(['--what', 'x', '--why', 'y', '--cost', 'z', '--phase', 'nope'], /단계/);
  refuse(['--what', 'x', '--why', 'y', '--cost', 'z', '--revision', '9'], /./);
  refuse(['--what', 'x', '--why', 'y', '--cost', 'z', '--author', 'bad;name'], /./);
  await mkdir(join(root, '.wax', 'tmp'), { recursive: true });
  const file = async (name, value) => { const path = join(root, '.wax', 'tmp', name); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
  refuse(['--file', await file('a.json', sample), '--what', 'x'], /한쪽으로만/);
  refuse(['--file', await file('b.json', { ...sample, extra: 'x' })], /JSON 객체/);
  refuse(['--file', await file('c.json', [sample])], /JSON 객체/);
  refuse(['--file', await file('d.json', { ...sample, cost: 3 })], /JSON 객체/);
  refuse(['--file', await file('e.json', '{ not json')], /JSON/);
  refuse(['--file', join(root, '.wax', 'tmp', 'missing.json')], /missing\.json/);
  const extra = wax(root, 'ruling', 'calc', 'more', '--what', 'x', '--why', 'y', '--cost', 'z');
  assert.match(extra.stderr, /사용법: ruling/);
  assert.equal((await getFeature(root, 'calc')).rulings, undefined, 'nothing was written');
  assert.deepEqual(rulingInput({ what: 'a', why: 'b', cost: 'c', author: 'x' }), { what: 'a', why: 'b', cost: 'c' });
});

test('limits: 50 rulings per task (then "split the plan"); numbers continue after the highest; finished and archived tasks are 409', async (t) => {
  const root = await workspace(t);
  for (let index = 0; index < RULING_LIMITS.count; index += 1) await record(root, { ...sample, what: `결정 ${index + 1}` });
  const full = await getFeature(root, 'calc');
  assert.equal(full.rulings.at(-1).id, 'R-50');
  await assert.rejects(record(root, sample), (error) => error.status === 400 && /50개까지.*계획을 더 나누세요/.test(error.message));
  assert.equal(newRuling({ phase: 'design', iteration: 2, rulings: [{ id: 'R-1' }, { id: 'R-7' }] }, sample, { at: 'x' }).id, 'R-8');
  const done = await mkdtemp(join(tmpdir(), 'wax-ruling-done-'));
  t.after(() => rm(done, { recursive: true, force: true }));
  await createFeature(done, { id: 'calc', title: '금액', projectType: 'general' });
  for (const phase of ['plan', 'design', 'implement', 'review', 'report']) {
    await updateFeature(done, 'calc', 'save', { phase, content: `# ${phase}` });
    await updateFeature(done, 'calc', 'complete', { phase, evidence: '확인', ...(['implement', 'review'].includes(phase) ? { waiver: '진행만 확인' } : {}), ...(phase === 'review' ? { verdict: 'pass' } : {}), redGreen: 'off' });
  }
  assert.equal((await getFeature(done, 'calc')).phase, 'done');
  await assert.rejects(record(done, sample), (error) => error.status === 409);
  const archived = await workspace(t);
  await updateFeature(archived, 'calc', 'archive-feature', {});
  await assert.rejects(record(archived, sample), (error) => error.status === 409);
});

test('the "may need a person" flag: set only without --area, from the fixed words (case-insensitive); it never blocks', async (t) => {
  const root = await workspace(t);
  for (const what of ['오래된 행 삭제', 'DROP the column', 'add a migration', 'auth 미들웨어 생략', '권한 검사를 뒤로 미룸', 'secret을 설정 파일로', '비밀값 위치', 'skip test for now', 'ac-2 해석을 좁힘']) {
    assert.equal(flagged(what), true, what);
  }
  for (const what of ['이름을 calcTotal로', 'split helper into a module']) assert.equal(flagged(what), false, what);
  await record(root, { ...sample, what: '오래된 행 delete' });
  await record(root, { ...sample, what: '오래된 행 delete', area: 'scope' });
  const [plain, withArea] = (await getFeature(root, 'calc')).rulings;
  assert.equal(plain.flag, true);
  assert.equal(plain.area, 'other');
  assert.equal(withArea.flag, false, 'an explicit --area is not flagged');
});

test('status shows "3 rulings, 2 unacknowledged" and lines with unacknowledged and flagged first; no rulings, no summary', async (t) => {
  const root = await workspace(t);
  assert.equal((await featureStatus(root, 'calc')).rulingSummary, undefined);
  await record(root, { ...sample, area: 'structure' });
  await record(root, { ...sample, what: '임시 테이블 drop' });
  await record(root, { ...sample, what: '이름을 total로' , area: 'naming' });
  const path = join(root, '.wax', 'features', 'calc.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.rulings[0] = { ...stored.rulings[0], status: 'acknowledged', marked: { by: '대표', at: new Date().toISOString() } };
  await writeFile(path, JSON.stringify(stored));
  const status = await featureStatus(root, 'calc');
  assert.equal(status.rulingSummary.text, '결정 3개(확인 안 함 2)');
  assert.deepEqual([status.rulingSummary.total, status.rulingSummary.unacknowledged, status.rulingSummary.flagged], [3, 2, 1]);
  assert.deepEqual(status.rulingSummary.lines, [
    'R-2 [other] 임시 테이블 drop — 두 곳에서 같은 계산 — 비용: 되돌리면 파일 하나 합치기 · 확인 안 함 (사람이 정할 일일 수 있음)',
    'R-3 [naming] 이름을 total로 — 두 곳에서 같은 계산 — 비용: 되돌리면 파일 하나 합치기 · 확인 안 함',
    'R-1 [structure] 날짜 계산을 src/date.js로 뺌 — 두 곳에서 같은 계산 — 비용: 되돌리면 파일 하나 합치기 · 사람이 확인함',
  ]);
  assert.equal(rulingSummary({ rulings: [] }), null);
});

test('stored format: bad rulings are a damaged record; a mark needs who and when, and "decided again" needs a note', () => {
  const base = { id: 'R-1', phase: 'implement', iteration: 0, at: new Date().toISOString(), area: 'other', what: 'a', why: 'b', cost: 'c', flag: false, status: 'open' };
  const at = new Date().toISOString();
  assert.equal(validRulings([base]), true);
  assert.equal(validRulings([{ ...base, status: 'acknowledged', marked: { by: '대표', at } }]), true);
  assert.equal(validRulings([{ ...base, status: 'overridden', marked: { by: '대표', at, note: '반올림은 내림으로', defect: 'D-2' } }]), true);
  for (const bad of [
    { ...base, id: 'R-0' }, { ...base, id: 'D-1' }, { ...base, phase: 'done' }, { ...base, area: 'security' }, { ...base, what: '' }, { ...base, why: 'x'.repeat(501) },
    { ...base, flag: 'no' }, { ...base, status: 'closed' }, { ...base, author: 'bad;name' }, { ...base, marked: { by: '대표', at } },
    { ...base, status: 'acknowledged' }, { ...base, status: 'overridden', marked: { by: '대표', at } }, { ...base, status: 'acknowledged', marked: { by: '대표', at, defect: 'R-1' } },
  ]) assert.equal(validRulings([bad]), false, JSON.stringify(bad));
  assert.equal(validRulings([base, base]), false, 'same ID twice');
  assert.equal(validRulings(Array.from({ length: 51 }, (_, index) => ({ ...base, id: `R-${index + 1}` }))), false);
});

test('report prompt quotes the ruling table as data and says not to hide unacknowledged ones; other stages do not', async (t) => {
  const root = await workspace(t);
  assert.doesNotMatch(buildPrompt(await getFeature(root, 'calc'), 'report'), /결정 기록/);
  await record(root, { what: '알림은 @octocat 팀에만\u202e', why: '요청 글에 그렇게 적힘', cost: '다른 팀이 알림을 못 받음', area: 'behavior' });
  await record(root, { ...sample, what: 'auth 확인 생략' });
  const feature = await getFeature(root, 'calc');
  const prompt = buildPrompt(feature, 'report');
  assert.match(prompt, /결정 2개, 확인 안 함 2개/);
  assert.match(prompt, /확인 안 한 결정\(status: open\).*숨기지 마세요/);
  const quoted = prompt.split('\n').filter((line) => line.startsWith('> '));
  assert.ok(quoted.some((line) => line.includes('"id": "R-1"')));
  assert.ok(quoted.some((line) => line.includes('"mayNeedPerson": true')));
  assert.ok(quoted.some((line) => line.includes('`@octocat`')), 'mentions are neutralized');
  assert.ok(!prompt.includes('\u202e'), 'hidden characters are removed');
  for (const phase of ['plan', 'design', 'implement', 'review']) assert.doesNotMatch(buildPrompt(feature, phase), /작업자가 사람에게 묻지 않고 정한 결정 기록/, phase);
});

test('worker prompt (design, implement, review) asks for CLI ruling --file and lists what a worker must not decide alone', async (t) => {
  const root = await workspace(t);
  const feature = await getFeature(root, 'calc');
  const goal = { id: 'goal-12345678', title: '금액 계산' };
  const prompt = (phase) => workerPrompt({ root, goal, feature: { ...feature, phase }, task: { id: 'task-1', phase, note: '배정' }, author: AUTHOR });
  for (const phase of ['design', 'implement', 'review']) {
    const text = prompt(phase);
    assert.match(text, new RegExp(`ruling calc --phase ${phase} --author ${AUTHOR} --file \\.wax/tmp/<파일>\\.json`), phase);
    for (const line of RULING_NOT_ALONE) assert.ok(text.includes(line), `${phase}: ${line}`);
    assert.match(text, /정하지 말고 blocked로 이유를 보고하세요/);
  }
  for (const phase of ['plan', 'report']) assert.doesNotMatch(prompt(phase), / ruling calc /, phase);
  const inTree = workerPrompt({ root, goal, feature: { ...feature, phase: 'implement' }, task: { id: 'task-1', phase: 'implement', note: '배정' }, author: AUTHOR,
    worktree: { path: join(root, '.wax', 'worktrees', 'w1'), branch: 'wax/w1' }, realRoot: root });
  assert.ok(inTree.includes(`--file ${root.replaceAll('\\', '/')}/.wax/tmp/<파일>.json`), 'absolute project .wax/tmp in a worktree');
});
