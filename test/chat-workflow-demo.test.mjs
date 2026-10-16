import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_STEPS, demoSnapshot, demoProof } from '../web/workflow-demo-model.mjs';

test('demo covers failure, correction, successful retry and completion without losing evidence', () => {
  assert.equal(demoSnapshot(0).events.length, 0);
  const failed = demoSnapshot(DEMO_STEPS.findIndex((step) => step.proof === 'fail'));
  assert.equal(failed.unresolved, true);
  assert.equal(failed.phases[2].state, 'blocked');
  const corrected = demoSnapshot(failed.index + 1);
  assert.equal(corrected.unresolved, true, 'a fix alone does not count as passing evidence');
  const passed = demoSnapshot(DEMO_STEPS.findIndex((step) => step.proof === 'pass'));
  assert.equal(passed.unresolved, false);
  assert.deepEqual([passed.passed, passed.failed], [1, 1]);
  const done = demoSnapshot(100);
  assert.ok(done.phases.every((phase) => phase.state === 'done'));
  assert.equal(done.events.length, DEMO_STEPS.length - 1);
  assert.equal(done.tests.length, 2);
  assert.equal(demoSnapshot(-1).index, 0);
  assert.equal(demoSnapshot('invalid').index, 0);
  assert.equal(demoSnapshot(0).tests.length, 0, 'reset clears the simulated evidence');
  assert.match(demoProof('fail'), /가상 데모/);
  assert.match(demoProof('pass'), /종료 코드: 0/);
});

const { DEMO_TASKS, assessDemoTask, demoScenario, demoOfficeSnapshot } = await import('../web/workflow-demo-model.mjs');
const { createOfficeDemo, readDemoOfficeApi } = await import('../web/office/demo.mjs');

test('task conditions select a proportionate team with an independent reviewer and configurable models', () => {
  assert.deepEqual(Object.values(DEMO_TASKS).map((task) => assessDemoTask(task).level), ['low', 'medium', 'high']);
  assert.deepEqual(Object.values(DEMO_TASKS).map((task) => demoScenario({ task }).team.length), [4, 6, 8]);
  for (const task of Object.values(DEMO_TASKS)) {
    const scenario = demoScenario({ task });
    const names = new Set(scenario.team.map((person) => person.author));
    assert.equal(names.size, scenario.team.length);
    assert.ok(names.has('reviewer') && names.has('frontend'));
    assert.ok(scenario.steps.every((event) => names.has(event.actor)));
    assert.ok(assessDemoTask(task).reasons.length > 0);
  }
  const chosen = demoScenario({ task: DEMO_TASKS.ui, models: { frontend: { kind: 'codex', model: 'my-local-model' } } });
  assert.equal(chosen.team.find((person) => person.author === 'frontend').kind, 'codex');
  assert.equal(chosen.team.find((person) => person.author === 'frontend').model, 'my-local-model');
});

test('office snapshots preserve questions, replies, reports and role allocation through seek and reset', () => {
  const done = demoOfficeSnapshot(100);
  assert.equal(done.agents.length, 8);
  assert.equal(done.tasks.length, 7);
  assert.ok(done.notes.some((note) => note.type === 'decision'));
  for (const answer of done.notes.filter((note) => note.type === 'answer')) assert.ok(done.notes.some((note) => note.id === answer.replyTo && note.type === 'question'));
  assert.ok(done.reports.length > 0);
  assert.equal(done.features[0].phase, 'done');
  const first = demoOfficeSnapshot(0);
  assert.equal(first.notes.length, 0);
  assert.equal(first.reports.length, 0);
  assert.ok(first.tasks.every((task) => task.status === 'open'));
  const parallel = demoOfficeSnapshot(6);
  assert.equal(parallel.agents.find((p) => p.author === 'frontend').state, 'working');
  assert.equal(parallel.agents.find((p) => p.author === 'backend').state, 'working');
  assert.ok(parallel.agents.some((p) => p.state === 'idle'));
  assert.equal(readDemoOfficeApi(done, '/api/profiles').profiles.length, 8);
  assert.match(readDemoOfficeApi(done, '/api/board/demo-work/reports/1'), /가상 데모/);
  assert.throws(() => readDemoOfficeApi(done, '/api/unknown'), /제공하지 않는/);
});

test('office demo accepts only its parent on the same origin and never falls through to live writes', async () => {
  const listeners = new Map(), parent = { postMessage() {} };
  const win = { parent, location: { origin: 'http://localhost:4330' }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {} };
  const demo = createOfficeDemo(win); let calls = 0;
  demo.onStep = () => calls++;
  const receive = listeners.get('message');
  receive({ origin: 'https://elsewhere.example', source: parent, data: { type: 'wax-demo-step', position: 6 } });
  receive({ origin: win.location.origin, source: {}, data: { type: 'wax-demo-step', position: 6 } });
  assert.equal(calls, 0);
  receive({ origin: win.location.origin, source: parent, data: { type: 'wax-demo-step', position: 6, options: { task: DEMO_TASKS.ui } } });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal((await demo.api('/api/presence')).length, 4);
  await assert.rejects(demo.api('/api/tasks', { method: 'POST' }), /변경하지/);
  await assert.rejects(demo.api('/api/live-only'), /제공하지 않는/);
});

test('milestone codenames are reached only with their checkpoint evidence and rewind with the slider', () => {
  for (const task of Object.values(DEMO_TASKS)) {
    const options = { task }, scenario = demoScenario(options);
    const start = demoSnapshot(0, options), done = demoSnapshot(100, options);
    assert.equal(start.milestones.filter((m) => m.reached).length, 0);
    assert.equal(done.milestones.filter((m) => m.reached).length, 5);
    assert.equal(done.nextMilestone, null);
    assert.equal(new Set(done.milestones.map((m) => m.code)).size, 5);
    const failAt = scenario.steps.findIndex((step) => step.proof === 'fail');
    const fail = demoSnapshot(failAt, options);
    assert.equal(fail.milestones[2].reached, false);
    assert.equal(fail.nextMilestone.alias, '조립');
    const passAt = scenario.steps.findIndex((step) => step.proof === 'pass');
    assert.equal(demoSnapshot(passAt, options).milestones[2].reached, true);
    assert.equal(demoSnapshot(passAt - 1, options).milestones[2].reached, false);
    assert.equal(demoSnapshot(passAt, options).milestones[3].reached, false, 'passing tests does not replace independent review');
  }
});

const { demoReleasePlan } = await import('../web/workflow-demo-model.mjs');
test('release versions advance only after milestone evidence and retain the chosen target dates', () => {
  const options = { version: '0.3.0', dates: { 4: '2026-12-01' } };
  const ready = demoReleasePlan(demoSnapshot(100), options);
  assert.equal(ready.ready, true);
  assert.equal(ready.currentVersion, '0.3.0');
  assert.equal(ready.checkpoints[4].date, '2026-12-01');
  assert.deepEqual(ready.checkpoints.map((c) => c.version), ['0.3.0-plan.1', '0.3.0-alpha.1', '0.3.0-beta.1', '0.3.0-rc.1', '0.3.0']);
  const failedAt = DEMO_STEPS.findIndex((step) => step.proof === 'fail');
  assert.equal(demoReleasePlan(demoSnapshot(failedAt), options).ready, false);
  const reviewedAt = DEMO_STEPS.findIndex((step) => step.checkpoint === 3);
  const reviewed = demoReleasePlan(demoSnapshot(reviewedAt), options);
  assert.equal(reviewed.currentVersion, '0.3.0-rc.1');
  assert.equal(reviewed.ready, false, 'review alone does not replace report and PM confirmation');
  assert.equal(demoReleasePlan(demoSnapshot(0), options).currentVersion, '계획 전');
  assert.throws(() => demoReleasePlan(demoSnapshot(0), { version: 'invalid' }), /목표 버전/);
});

test('late parent initialization can recover readiness and portraits; callback errors are reported', async () => {
  const listeners = new Map(), sent = [];
  const parent = { postMessage(message) { sent.push(message); } };
  const win = { parent, location: { origin: 'http://localhost:4330' }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {} };
  const demo = createOfficeDemo(win);
  demo.cast([{ author: 'frontend', portrait: 'data:image/png;base64,test' }]); demo.ready();
  sent.length = 0;
  const receive = listeners.get('message');
  receive({ source: parent, origin: win.location.origin, data: { type: 'wax-demo-ping' } });
  assert.deepEqual(sent.map((message) => message.type), ['wax-demo-cast', 'wax-demo-ready']);
  assert.equal(sent[0].cast[0].author, 'frontend');
  demo.onStep = () => { throw new Error('fixture update failure'); };
  receive({ source: parent, origin: win.location.origin, data: { type: 'wax-demo-step', position: 6 } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(sent.at(-1).type, 'wax-demo-error');
});

test('merged roles receive the active report task instead of a completed implementation task', () => {
  const options = { task: DEMO_TASKS.ui }, scenario = demoScenario(options);
  const reportAt = scenario.steps.findIndex((event) => event.phase === 4 && event.actor === 'frontend');
  const snapshot = demoOfficeSnapshot(reportAt, options);
  const reportTask = snapshot.tasks.find((task) => task.to === 'frontend');
  assert.equal(reportTask.phase, 'report');
  assert.equal(reportTask.status, 'accepted');
  assert.equal(snapshot.tasks.find((task) => task.to === 'reviewer').status, 'done');
});

test('office demo restores its parent message listener after repeated cached page restores', async () => {
 const listeners=new Map(),sent=[],parent={postMessage:m=>sent.push(m)};
 const win={parent,location:{origin:'http://localhost:4330'},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)}};
 const demo=createOfficeDemo(win);demo.ready();
 for(let i=0;i<2;i++){
  listeners.get('pagehide')();assert.equal(listeners.has('message'),false);
  listeners.get('pageshow')({persisted:true});assert.equal(typeof listeners.get('message'),'function');
  listeners.get('message')({source:parent,origin:win.location.origin,data:{type:'wax-demo-step',position:i+2}});
  await Promise.resolve();assert.equal(demo.snapshot.view.index,i+2);
 }
 assert.equal(sent.filter(m=>m.type==='wax-demo-ready').length,3);
});
