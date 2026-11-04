import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestAction, sessionGuide } from '../web/start-guide.mjs';
import { joinPresence, listPresence } from '../src/chat/presence.mjs';
import { assignTask, setPm, listTasks, updateTask } from '../src/chat/team.mjs';
import { listFeatures } from '../src/workflow.mjs';
import { project } from './chat-helpers.mjs';

test('fresh init/join → PM assignment → work acceptance has a concrete next action at each step', async (t) => {
  const root = await project(t, ['login']);
  const pm = await joinPresence(root, { author: 'pm-app', kind: 'codex' });
  const worker = await joinPresence(root, { author: 'worker-app', kind: 'claude', feature: 'login' });
  const features = await listFeatures(root);
  let agent = (await listPresence(root)).find((a) => a.author === worker.author);
  assert.equal(agent.state, 'idle', 'feature selection alone never reports work started');
  assert.match(sessionGuide(agent, { features }).title, /배정된 업무 없음/);
  assert.equal(sessionGuide(agent, { features }).command, '/wax:plan login');
  await assert.rejects(assignTask(root, { author: pm.author, session: pm.session, to: worker.author, feature: 'login', body: '로그인 기획' }), /PM이 지정되지/);
  await setPm(root, { author: pm.author, kind: pm.kind });
  const task = await assignTask(root, { author: pm.author, session: pm.session, to: worker.author, feature: 'login', phase: features[0].phase, body: '로그인 범위와 수용 기준을 기획해줘' });
  let guide = sessionGuide(agent, { features, tasks: await listTasks(root) });
  assert.match(guide.title, /배정됨/);
  assert.equal(guide.command, `/wax:work ${task.id}`);
  assert.match(guide.detail, /실행해야/);
  await updateTask(root, task.id, 'accept', { author: worker.author, session: worker.session });
  guide = sessionGuide(agent, { features, tasks: await listTasks(root) });
  assert.match(guide.title, /수락됨/);
  await updateTask(root, task.id, 'block', { author: worker.author, session: worker.session, body: '로그인 대상은 관리자만인가요?' });
  guide = sessionGuide(agent, { features, tasks: await listTasks(root) });
  assert.match(guide.title, /막혀/);
  assert.match(guide.detail, /관리자/);
});

test('guide distinguishes future-phase assignments, away sessions and recorded work from execution', () => {
  const agent = { author: 'worker', kind: 'codex', state: 'idle', feature: 'login' };
  const future = { id: 't-1', to: agent.author, feature: 'login', phase: 'implement', status: 'open' };
  const snapshot = { features: [{ id: 'login', phase: 'plan' }], tasks: [future] };
  assert.match(sessionGuide(agent, snapshot).title, /이전 단계/);
  assert.equal(sessionGuide(agent, snapshot).command, '$wax:status login');
  assert.equal(sessionGuide({ ...agent, effectiveState: 'away' }, snapshot).command, '$wax:join');
  assert.match(sessionGuide({ ...agent, state: 'working' }).title, /마지막 기록/);
  assert.equal(sessionGuide({ ...agent, state: 'working' }).command, undefined);
  assert.equal(sessionGuide(agent, { tasks: [{ ...future, phase: 'any', status: 'done' }] }).command, null);
  assert.equal(sessionGuide({ ...agent, kind: 'gemini' }, { tasks: [{ ...future, phase: 'any' }] }).command, '/wax:work t-1');
});

test('request guide identifies queued work, actual executor, answer, recovery and completion', () => {
  assert.match(requestAction().title, /아직 실행/);
  const request = { id: 'new', createdAt: '2026-10-17T02:00:00Z', status: 'queued' };
  assert.match(requestAction(request, [{ id: 'old', createdAt: '2026-10-17T01:00:00Z', status: 'running' }, request]).title, /앞선 요청 1건/);
  assert.match(requestAction({ ...request, status: 'running', agent: 'wax-claude-2' }).title, /wax-claude-2/);
  assert.equal(requestAction({ ...request, status: 'question' }).action, 'reply');
  assert.equal(requestAction({ ...request, status: 'workflow' }).action, 'workflow');
  for (const status of ['blocked', 'paused']) assert.equal(requestAction({ ...request, status }).action, 'resume');
  const restart = requestAction({ ...request, status: 'blocked', newRequest: true });
  assert.equal(restart.action, 'new'); assert.match(restart.title, /새 요청/);
  assert.match(requestAction({ ...request, status: 'completed' }).title, /마쳤/);
});

test('generated startup and PM instructions remove the approval loop across all hosts', async () => {
  for (const path of ['commands', 'commands/wax', 'skills']) {
    const file = (command) => path === 'skills' ? `skills/${command}/SKILL.md` : `${path}/${command}.${path === 'commands' ? 'md' : 'toml'}`;
    const init = await readFile(new URL(`../${file('init')}`, import.meta.url), 'utf8');
    const join = await readFile(new URL(`../${file('join')}`, import.meta.url), 'utf8');
    const pm = await readFile(new URL(`../${file('pm')}`, import.meta.url), 'utf8');
    assert.match(init, /always <URL>\//);
    assert.match(init, /--state idle/);
    assert.match(join, /do not allocate a new identity on repeated init or join/);
    assert.match(join, /joining only registers the session/);
    assert.match(pm, /Execute the plan now/);
    assert.match(pm, /Reuse an open or accepted assignment/);
    assert.match(pm, /Verify the result with CLI chat tasks --json/);
    assert.doesNotMatch(pm, /Ask the CEO to choose and do not create assignments until they decide/);
    assert.match(pm, /When a new goal or an instruction to proceed is supplied/);
    if (path === 'skills') {
      assert.match(join, /Codex CLI syntax: invoke wax skills with \$wax:<command>/);
      assert.match(pm, /The \$ sigil invokes a skill; @ is for file mentions/);
    }
  }
});
