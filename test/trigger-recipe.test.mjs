import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { acceptProposal, dismissProposal, fireLocal, listProposals, saveTrigger } from '../src/chat/triggers.mjs';
import { getRecipe } from '../src/recipes.mjs';
import { createGoal } from '../src/chat/pm-loop.mjs';
import { normalizeIssues } from '../src/chat/trigger-github.mjs';

const author = '대표';
const NOW = Date.parse('2026-11-02T10:00:00Z');
const recipeTrigger = (extra = {}) => ({ name: '버그 레시피', enabled: true, source: { type: 'local' }, action: { kind: 'recipe', recipe: 'bugfix', text: '{{payload.title}}' }, limits: { perDay: 5, cooldown: '0' }, ...extra });
const readProposalFile = async (root, id) => JSON.parse(await readFile(join(root, '.wax', 'chat', 'proposals', `${id}.json`), 'utf8'));

test('a recipe trigger needs an existing recipe; GitHub issues default the input to the issue title', async (t) => {
  const root = await project(t);
  const trigger = await saveTrigger(root, recipeTrigger(), { author, now: NOW });
  assert.deepEqual(trigger.action, { kind: 'recipe', recipe: 'bugfix', text: '{{payload.title}}' });
  await assert.rejects(saveTrigger(root, recipeTrigger({ action: { kind: 'recipe', recipe: 'no-such-recipe', text: 'x' } }), { author, now: NOW }), (error) => error.status === 404 || /레시피|recipe/i.test(error.message));
  await assert.rejects(saveTrigger(root, recipeTrigger({ action: { kind: 'recipe', recipe: '../x', text: 'x' } }), { author, now: NOW }), /레시피 ID|recipe ID/);
  await assert.rejects(saveTrigger(root, recipeTrigger({ action: { kind: 'recipe', recipe: 'bugfix', text: '' } }), { author, now: NOW }));
  const issues = await saveTrigger(root, { ...recipeTrigger(), enabled: false, source: { type: 'github-issues', repo: 'owner/name', label: 'bug', every: '5m' }, action: { kind: 'recipe', recipe: 'bugfix', text: '' } }, { author, now: NOW });
  assert.equal(issues.action.text, '{{issue.title}}');
  assert.ok(normalizeIssues);
});

test('accepting a recipe proposal creates no request and returns the start screen to open; the input is one bounded line', async (t) => {
  const root = await project(t);
  const trigger = await saveTrigger(root, recipeTrigger(), { author, now: NOW });
  assert.equal((await fireLocal(root, trigger.id, { key: 'k1', payload: JSON.stringify({ title: `로그인 ${'끊김 '.repeat(100)}` }), now: NOW })).outcome, 'proposed');
  const [proposal] = await listProposals(root, { now: NOW });
  assert.deepEqual([proposal.action, proposal.recipe], ['recipe', 'bugfix']);
  assert.ok(Array.from(proposal.text).length <= 200, 'input fits the recipe input');
  let submitted = false;
  const result = await acceptProposal(root, proposal.id, { author, text: '로그인 끊김', submit: async () => { submitted = true; }, now: NOW + 1 });
  assert.equal(submitted, false);
  const { details, ...open } = result.open;
  assert.deepEqual(open, { recipe: 'bugfix', input: '로그인 끊김', proposal: proposal.id });
  assert.ok(details === undefined || typeof details === 'string');
  assert.deepEqual([result.proposal.status, result.proposal.text, result.request], ['accepted', '로그인 끊김', undefined]);
});

test('a goal started from the accepted proposal keeps it as origin; the same proposal cannot start a second goal', async (t) => {
  const root = await project(t);
  const trigger = await saveTrigger(root, recipeTrigger(), { author, now: NOW });
  await fireLocal(root, trigger.id, { key: 'k1', payload: '{"title":"로그인 끊김"}', now: NOW });
  const [proposal] = await listProposals(root, { now: NOW });
  const entry = await getRecipe(root, 'bugfix');
  const start = (origin, slug = 'login') => createGoal(root, { recipe: { id: 'bugfix', hash: entry.hash, input: '로그인 끊김', slug }, origin }, { author, now: NOW + 10 });
  await assert.rejects(start(proposal.id), (error) => error.status === 409);
  await acceptProposal(root, proposal.id, { author, now: NOW + 1 });
  const goal = await start(proposal.id);
  assert.deepEqual(goal.origin, { trigger: trigger.id, eventKey: 'local:k1', proposal: proposal.id, source: `wax trigger fire ${trigger.id}` });
  assert.equal((await readProposalFile(root, proposal.id)).goal, goal.id);
  await assert.rejects(start(proposal.id, 'login-2'), (error) => error.status === 409);
  assert.equal((await start(undefined, 'other')).origin, undefined);
});

test('only an accepted recipe proposal for the same recipe can be an origin', async (t) => {
  const root = await project(t);
  const recipeOne = await saveTrigger(root, recipeTrigger(), { author, now: NOW });
  const requestOne = await saveTrigger(root, { ...recipeTrigger({ name: '요청' }), action: { kind: 'request', mode: 'sm', tool: 'codex', text: '{{payload.title}}' } }, { author, now: NOW });
  await fireLocal(root, recipeOne.id, { key: 'r1', payload: '{"title":"a"}', now: NOW });
  await fireLocal(root, requestOne.id, { key: 'q1', payload: '{"title":"b"}', now: NOW });
  const proposals = await listProposals(root, { now: NOW });
  const recipeProposal = proposals.find((item) => item.action === 'recipe'), requestProposal = proposals.find((item) => item.action === 'request');
  await acceptProposal(root, requestProposal.id, { author, submit: async (input) => ({ id: input.id, tool: input.tool, mode: input.mode }), now: NOW + 1 });
  await dismissProposal(root, recipeProposal.id, { author, now: NOW + 1 });
  const entry = await getRecipe(root, 'feature');
  const start = (origin) => createGoal(root, { recipe: { id: 'feature', hash: entry.hash, input: '새 기능', slug: 'new' }, origin }, { author, now: NOW + 10 });
  await assert.rejects(start(requestProposal.id), (error) => error.status === 409, 'request proposal');
  await assert.rejects(start(recipeProposal.id), (error) => error.status === 409, 'dismissed proposal');
  await assert.rejects(start('proposal-not-a-real-id'), (error) => error.status >= 400);
});

test('accepting a CI-failure recipe proposal prefills details with failed jobs and steps only; GitHub errors still open the screen', async (t) => {
  const { fetchRunFailures } = await import('../src/chat/trigger-github.mjs');
  const jobs = { jobs: [
    { name: 'test (ubuntu, 24)', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }] },
    { name: 'lint', conclusion: 'success', steps: [] },
  ] };
  const calls = [];
  const gh = async (args) => { calls.push(args); return { stdout: JSON.stringify(jobs) }; };
  assert.deepEqual(await fetchRunFailures('owner/repo', 42, { gh }), ['test (ubuntu, 24): npm test']);
  assert.deepEqual(calls[0], ['run', 'view', '42', '--repo=owner/repo', '--json=jobs'], 'no log content is fetched');
  assert.deepEqual(await fetchRunFailures('bad repo', 42, { gh }), []);

  const root = await project(t);
  const trigger = await saveTrigger(root, { ...recipeTrigger(), enabled: false, source: { type: 'ci-failure', repo: 'owner/repo', branch: 'main', every: '5m' }, action: { kind: 'recipe', recipe: 'bugfix', text: '' } }, { author, now: NOW });
  const { writeFile, mkdir } = await import('node:fs/promises');
  const id = 'proposal-00000000-0000-4000-8000-000000000001';
  const dir = join(root, '.wax', 'chat', 'proposals');
  await mkdir(dir, { recursive: true });
  const proposal = { schema: 1, id, trigger: trigger.id, triggerName: trigger.name, eventKey: 'ci-failure:42', action: 'recipe', recipe: 'bugfix', source: { type: 'ci-failure', label: 'owner/repo · main · run 42' },
    text: 'CI (main)', quoted: 'CI\nmain @ abc123', missed: 0, status: 'proposed', requestId: 'request-x', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString() };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(proposal));
  const accepted = await acceptProposal(root, id, { author, gh, now: NOW + 1 });
  assert.match(accepted.open.details, /main @ abc123/);
  assert.match(accepted.open.details, /- test \(ubuntu, 24\): npm test/);
  assert.equal(accepted.proposal.details, accepted.open.details, 'stored for the start screen');
  await writeFile(join(dir, `${id.replace(/1$/, '2')}.json`), JSON.stringify({ ...proposal, id: id.replace(/1$/, '2'), eventKey: 'ci-failure:43' }));
  const offline = await acceptProposal(root, id.replace(/1$/, '2'), { author, gh: async () => { throw new Error('offline'); }, now: NOW + 1 });
  assert.equal(offline.proposal.status, 'accepted');
  assert.doesNotMatch(offline.open.details, /npm test/);
});
