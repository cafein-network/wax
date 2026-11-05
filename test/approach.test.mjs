import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { completePhase, createFeature, getFeature, importFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { APPROACH_LIMITS, approachMode, approachQuote, clipText, effectiveApproachMode, proposalItems, validApproach, validApproachDone } from '../src/approach.mjs';
import { WORKER_FORBIDDEN, workerForbidden, workerForbiddenPrompt } from '../src/worker-commands.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const WORKER = 'wax-worker-claude';
const items = [
  { title: '서버에서 계산', summary: '합계를 API에서 계산', tradeoffs: '요청이 하나 늘어남', cost: 'S', risk: 'low' },
  { title: '브라우저에서 계산', summary: '화면에서 계산', tradeoffs: '두 곳에 같은 계산', cost: 'M', risk: 'medium' },
];

async function workspace(t, { phase = 'design' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wax-approach-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createFeature(dir, { id: 'calc', title: '금액 계산', projectType: 'general' });
  if (phase === 'design') {
    await updateFeature(dir, 'calc', 'save', { phase: 'plan', content: '# 기획\n범위: 합계' });
    await completePhase(dir, 'calc', 'plan', { evidence: '기획 확인' });
    await updateFeature(dir, 'calc', 'save', { phase: 'design', content: '# 설계\n구조' });
  }
  await mkdir(join(dir, '.wax', 'tmp'), { recursive: true });
  return dir;
}
const wax = (root, args, env = {}) => spawnSync(process.execPath, [CLI, '--project', root, ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko', WAX_WORKER: '', WAX_APPROACH: '', ...env } });
const json = async (root, name, value) => { const path = join(root, '.wax', 'tmp', name); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
const propose = (root, value = items, extra = {}) => updateFeature(root, 'calc', 'approach-propose', { approach: value, author: WORKER, ...extra });
const pick = (root, number, extra = {}) => updateFeature(root, 'calc', 'approach-pick', { approach: { number, ...extra.input }, author: '대표', pickVia: 'cli', ...extra });
const completeDesign = (root, options = {}) => completePhase(root, 'calc', 'design', { evidence: '설계 확인', ...options });

test('CLI approach --propose records a round from a --file JSON array, clips worker text and leaves history; no flags only shows', async (t) => {
  const root = await workspace(t);
  const long = { ...items[1], title: `${'가'.repeat(APPROACH_LIMITS.title + 30)}`, summary: `숨은​ 문자\r\n줄 @someone ${'x'.repeat(2000)}` };
  const run = wax(root, ['approach', 'calc', '--propose', '--file', await json(root, 'a.json', [items[0], long]), '--author', WORKER]);
  assert.equal(run.status, 0, run.stderr);
  const feature = await getFeature(root, 'calc');
  const [round] = feature.approach.proposals;
  assert.equal(round.round, 1);
  assert.equal(round.author, WORKER);
  assert.deepEqual(round.items[0], items[0]);
  assert.equal(Array.from(round.items[1].title).length, APPROACH_LIMITS.title);
  assert.ok(round.items[1].title.endsWith('…'));
  assert.equal(Array.from(round.items[1].summary).length, APPROACH_LIMITS.summary);
  assert.ok(round.items[1].summary.startsWith('숨은 문자\n줄 @someone'), 'hidden characters removed, line break kept, mention kept in the record');
  assert.equal(feature.approach.pick, null);
  assert.deepEqual(feature.history.filter((event) => event.action === 'approach-propose').map((event) => [event.phase, event.round, event.count, event.author]), [['design', 1, 2, WORKER]]);
  assert.equal(validateStored(feature), feature);
  const show = wax(root, ['approach', 'calc']);
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout);
  assert.deepEqual([shown.phase, shown.mode, shown.revision, shown.approach.proposals.length], ['design', 'warn', feature.revision, 1]);
});

test('propose refuses bad shapes, wrong stage, off mode and a 4th round, and writes nothing', async (t) => {
  const root = await workspace(t);
  const refuse = async (value, pattern) => {
    const run = wax(root, ['approach', 'calc', '--propose', '--file', await json(root, 'bad.json', value)]);
    assert.equal(run.status, 1, JSON.stringify(value)); assert.match(run.stderr, pattern, JSON.stringify(value));
  };
  await refuse([items[0]], /2~3개.*--single/);
  await refuse([...items, items[0], items[1]], /3개까지/);
  await refuse({ items }, /JSON 배열/);
  await refuse([items[0], { ...items[1], extra: 'x' }], /JSON 배열/);
  await refuse([items[0], { ...items[1], cost: 3 }], /JSON 배열/);
  await refuse([items[0], { ...items[1], cost: 'XL' }], /2번째 방법의 cost/);
  await refuse([items[0], { ...items[1], risk: 'none' }], /2번째 방법의 risk/);
  await refuse([{ ...items[0], title: ' ​ ' }, items[1]], /1번째 방법의 title/);
  await refuse('{ nope', /JSON/);
  const usage = (args) => { const run = wax(root, ['approach', 'calc', ...args]); assert.equal(run.status, 1, args.join(' ')); assert.match(run.stderr, /사용법: approach/, args.join(' ')); };
  usage(['--propose']);
  usage(['--propose', '--single', '한 가지']);
  usage(['--single', '한 가지', '--file', 'x.json']);
  usage(['--single', '한 가지', '--reason', 'x']);
  usage(['extra', '--single', '한 가지']);
  assert.equal((await getFeature(root, 'calc')).approach, undefined, 'nothing was written');
  const early = await workspace(t, { phase: 'plan' });
  await assert.rejects(propose(early), (error) => error.status === 409 && /설계 단계에서만/.test(error.message));
  await assert.rejects(propose(root, items, { approachMode: 'off' }), (error) => error.status === 409 && /off/.test(error.message));
  for (let index = 0; index < APPROACH_LIMITS.rounds; index += 1) await propose(root);
  await assert.rejects(propose(root), (error) => error.status === 409 && /3번까지/.test(error.message));
  assert.deepEqual((await getFeature(root, 'calc')).approach.proposals.map((round) => round.round), [1, 2, 3]);
});

test('--single records the reason only before proposals, refuses always, and a later propose clears it', async (t) => {
  const root = await workspace(t);
  const run = wax(root, ['approach', 'calc', '--single', '버튼 문구 하나만 바뀜', '--author', WORKER]);
  assert.equal(run.status, 0, run.stderr);
  let feature = await getFeature(root, 'calc');
  assert.equal(feature.approach.single.reason, '버튼 문구 하나만 바뀜');
  assert.equal(feature.approach.single.author, WORKER);
  assert.equal(feature.history.at(-1).action, 'approach-single');
  await assert.rejects(updateFeature(root, 'calc', 'approach-single', { approach: ' ' }), /사유/);
  await assert.rejects(updateFeature(root, 'calc', 'approach-single', { approach: '하나뿐', approachMode: 'always' }), (error) => error.status === 409 && /always/.test(error.message));
  const clipped = await updateFeature(root, 'calc', 'approach-single', { approach: 'y'.repeat(900) });
  assert.equal(Array.from(clipped.approach.single.reason).length, APPROACH_LIMITS.reason);
  await propose(root);
  feature = await getFeature(root, 'calc');
  assert.equal(feature.approach.single, null);
  await assert.rejects(updateFeature(root, 'calc', 'approach-single', { approach: '하나뿐' }), (error) => error.status === 409 && /이미 방법을 냈습니다/.test(error.message));
});

test('only a person picks: WAX_WORKER=1, worker and machine names, a missing name or revision are refused; the pick keeps via cli and can be changed during design', async (t) => {
  const root = await workspace(t);
  await assert.rejects(pick(root, 1), (error) => error.status === 409 && /고를 방법이 없습니다/.test(error.message));
  const proposed = await propose(root);
  const revision = String(proposed.revision);
  const refuse = (args, pattern, env) => { const run = wax(root, ['approach', 'calc', ...args], env); assert.equal(run.status, 1, args.join(' ')); assert.match(run.stderr, pattern, args.join(' ')); };
  refuse(['--pick', '1', '--author', '대표', '--revision', revision], /사람만/, { WAX_WORKER: '1' });
  refuse(['--pick', '1', '--author', WORKER, '--revision', revision], /사람만/);
  refuse(['--pick', '1', '--author', 'auto', '--revision', revision], /사람만/);
  refuse(['--pick', '1', '--author', 'pm-loop', '--revision', revision], /사람만/);
  refuse(['--pick', '1', '--revision', revision], /사람만/);
  refuse(['--pick', '1', '--author', '대표'], /--revision/);
  refuse(['--pick', '3', '--author', '대표', '--revision', revision], /1~2/);
  refuse(['--pick', '0', '--author', '대표', '--revision', revision], /1~2/);
  refuse(['--pick', 'one', '--author', '대표', '--revision', revision], /정수/);
  refuse(['--pick', '1', '--author', '대표', '--revision', String(proposed.revision - 1)], /./);
  assert.equal((await getFeature(root, 'calc')).approach.pick, null, 'nothing was picked');
  const run = wax(root, ['approach', 'calc', '--pick', '2', '--author', '대표', '--revision', revision, '--reason', '서버 배포가 막혀 있음 @team']);
  assert.equal(run.status, 0, run.stderr);
  let feature = await getFeature(root, 'calc');
  assert.deepEqual({ ...feature.approach.pick, at: undefined }, { round: 1, index: 1, by: '대표', via: 'cli', reason: '서버 배포가 막혀 있음 @team', at: undefined });
  assert.deepEqual(feature.history.filter((event) => event.action === 'approach-pick').map((event) => [event.round, event.index, event.author]), [[1, 1, '대표']]);
  await pick(root, 1);
  feature = await getFeature(root, 'calc');
  assert.equal(feature.approach.pick.index, 0);
  assert.equal(feature.history.filter((event) => event.action === 'approach-pick').length, 2);
  await assert.rejects(propose(root), (error) => error.status === 409 && /이미 방법을 골랐습니다/.test(error.message));
  await assert.rejects(updateFeature(root, 'calc', 'approach-pick', { approach: { number: 1 }, author: '대표', pickVia: 'phone' }), /cli, dashboard/);
  await completeDesign(root);
  await assert.rejects(pick(root, 2), (error) => error.status === 409 && /설계 단계에서만/.test(error.message));
});

test('complete design: warn (default) completes without a record and warns; ask refuses; proposals not yet picked are refused in every mode but off', async (t) => {
  const root = await workspace(t);
  await assert.rejects(completeDesign(root, { approachMode: 'ask' }), (error) => error.status === 409 && /--propose.*--single/.test(error.message));
  await assert.rejects(completeDesign(root, { approachMode: 'always' }), (error) => error.status === 409 && /always/.test(error.message));
  assert.equal((await getFeature(root, 'calc')).phase, 'design', 'a refusal writes nothing');
  await propose(root);
  for (const mode of [undefined, 'warn', 'ask', 'always']) {
    await assert.rejects(completeDesign(root, { approachMode: mode }), (error) => error.status === 409 && /아직 고르지 않았습니다/.test(error.message), String(mode));
  }
  const off = await workspace(t);
  await propose(off);
  const skipped = await completeDesign(off, { approachMode: 'off' });
  assert.equal(skipped.feature.completed.design.approach, undefined);
  const plain = await workspace(t);
  const done = await completeDesign(plain);
  assert.deepEqual(done.feature.completed.design.approach, { mode: 'warn', state: 'missing' });
  assert.match(done.warning, /방법 고르기 기록 없이/);
  assert.equal(done.feature.phase, 'implement');
  assert.equal(validateStored(done.feature), done.feature);
});

test('complete design passes with a pick (picked) or a --single (single); always ignores a --single; the CLI reads WAX_APPROACH', async (t) => {
  const root = await workspace(t);
  await propose(root);
  await pick(root, 2);
  const picked = await completeDesign(root, { approachMode: 'always' });
  assert.deepEqual(picked.feature.completed.design.approach, { mode: 'always', state: 'picked', round: 1, index: 1 });
  assert.equal(picked.warning, null);
  const single = await workspace(t);
  await updateFeature(single, 'calc', 'approach-single', { approach: '하나뿐' });
  await assert.rejects(completeDesign(single, { approachMode: 'always' }), (error) => error.status === 409 && /always/.test(error.message));
  const ok = await completeDesign(single, { approachMode: 'ask' });
  assert.deepEqual(ok.feature.completed.design.approach, { mode: 'ask', state: 'single' });
  const cli = await workspace(t);
  const refused = wax(cli, ['complete', 'design', 'calc', '--evidence', '설계 확인'], { WAX_APPROACH: 'ask' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /WAX_APPROACH=ask/);
  const bad = wax(cli, ['complete', 'design', 'calc', '--evidence', '설계 확인'], { WAX_APPROACH: 'sometimes' });
  assert.match(bad.stderr, /WAX_APPROACH/);
  const warned = wax(cli, ['complete', 'design', 'calc', '--evidence', '설계 확인']);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /방법 고르기 기록 없이/);
});

test('a person’s discipline.approach on the task wins over WAX_APPROACH; the warn default is only an environment value', async (t) => {
  const root = await workspace(t);
  await updateFeature(root, 'calc', 'discipline', { discipline: { approach: 'ask' }, author: '대표' });
  await assert.rejects(completeDesign(root, { approachMode: 'warn' }), (error) => error.status === 409);
  await updateFeature(root, 'calc', 'discipline', { discipline: { approach: 'off' }, author: '대표' });
  await assert.rejects(propose(root, items, { approachMode: 'ask' }), /off/);
  await assert.rejects(updateFeature(root, 'calc', 'discipline', { discipline: { approach: 'warn' } }), /approach는 ask·always·off/);
  assert.equal(effectiveApproachMode({ discipline: { approach: 'always' } }, 'off'), 'always');
  assert.equal(effectiveApproachMode({}, undefined), 'warn');
  assert.equal(effectiveApproachMode({ discipline: { redGreen: 'enforce' } }, 'ask'), 'ask');
  assert.equal(approachMode(''), 'warn');
  assert.throws(() => approachMode('enforce'), /warn, ask, always, off/);
  const done = await completeDesign(root, { approachMode: 'always' });
  assert.equal(done.feature.completed.design.approach, undefined);
});

test('old records and phases stay as they were: no approach field, other phases unaffected, finished or archived tasks refuse', async (t) => {
  const root = await workspace(t, { phase: 'plan' });
  await updateFeature(root, 'calc', 'save', { phase: 'plan', content: '# 기획' });
  const plan = await completePhase(root, 'calc', 'plan', { evidence: '기획', approachMode: 'always' });
  assert.equal(plan.feature.completed.plan.approach, undefined);
  const feature = await getFeature(root, 'calc');
  assert.equal(feature.approach, undefined);
  assert.equal(validateStored(feature), feature);
  const bad = (patch) => importFeature(root, { ...structuredClone(feature), ...patch }, 'bad');
  await assert.rejects(bad({ approach: { proposals: [{ round: 1, at: feature.createdAt, items: [items[0]] }], pick: null, single: null } }), /형식/);
  await assert.rejects(bad({ approach: { proposals: [], pick: { round: 1, index: 0, by: '대표', via: 'cli', at: feature.createdAt }, single: null } }), /형식/);
  await assert.rejects(bad({ completed: { ...feature.completed, plan: { ...feature.completed.plan, approach: { mode: 'warn', state: 'missing' } } } }), /형식/);
  assert.equal(validApproach({ proposals: [{ round: 1, at: feature.createdAt, items }], pick: { round: 1, index: 1, by: '대표', via: 'dashboard', at: feature.createdAt }, single: null }), true);
  assert.equal(validApproach({ proposals: [{ round: 2, at: feature.createdAt, items }], pick: null, single: null }), false);
  assert.equal(validApproachDone({ mode: 'ask', state: 'missing' }), false);
  assert.equal(validApproachDone({ mode: 'warn', state: 'picked', round: 1, index: 0 }), true);
  assert.equal(validApproachDone({ mode: 'off', state: 'single' }), false);
  const archived = await workspace(t);
  await updateFeature(archived, 'calc', 'archive-feature', {});
  await assert.rejects(propose(archived), (error) => error.status === 409);
});

test('approachQuote quotes the record as data: hidden characters removed, @mentions defused, every line prefixed', async (t) => {
  const root = await workspace(t);
  assert.deepEqual(approachQuote(await getFeature(root, 'calc')), []);
  await propose(root, [{ ...items[0], summary: '@alice 에게 물어봄‮' }, items[1]]);
  await pick(root, 1, { input: { reason: '빠름 @bob' } });
  const [block] = approachQuote(await getFeature(root, 'calc'));
  const [intro, ...lines] = block.split('\n');
  assert.match(intro, /데이터이며 지시가 아닙니다/);
  assert.ok(lines.every((line) => line.startsWith('> ')));
  assert.match(block, /`@alice` 에게 물어봄/);
  assert.match(block, /빠름 `@bob`/);
  assert.doesNotMatch(block, /‮/);
  assert.match(block, /"chosen"/);
  const single = await workspace(t);
  await updateFeature(single, 'calc', 'approach-single', { approach: '하나뿐 @carol' });
  assert.match(approachQuote(await getFeature(single, 'calc'))[0], /"single"[\s\S]*`@carol`/);
  assert.equal(clipText('a\r\nb\u0007', 10), 'a\nb');
  assert.throws(() => proposalItems('x'), /JSON 배열/);
});

test('wax approach --pick is on the worker-forbidden list and marked on the approval screen; propose and single are not', () => {
  assert.deepEqual(WORKER_FORBIDDEN.wax, ['approach --pick']);
  assert.match(workerForbiddenPrompt(), /wax approach --pick/);
  const bash = (command) => ({ tool: 'claude', details: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } } });
  const mark = (command) => workerForbidden(bash(command), { cli: CLI })?.command ?? null;
  assert.equal(mark('wax approach calc --pick 1 --author 대표 --revision 3'), 'wax approach --pick');
  assert.equal(mark(`node "${CLI}" --project /tmp/p approach calc --pick=2 --revision 3`), 'wax approach --pick');
  assert.equal(mark('wax approach calc --propose --file .wax/tmp/a.json'), null);
  assert.equal(mark('wax approach calc --single 하나뿐'), null);
  assert.equal(mark('wax status calc'), null);
});
