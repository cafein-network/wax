import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './chat-helpers.mjs';
import { ChatWatcher } from '../src/chat/watcher.mjs';
import { createFeature, featureStamp } from '../src/workflow.mjs';

const touch = async (root, id, title) => {
  const file = join(root, '.wax', 'features', `${id}.json`);
  const feature = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...feature, title, updatedAt: new Date(Date.parse(feature.updatedAt) + 1000).toISOString() }));
};

test('감시: 기능 기록은 이름·크기·수정 시각이 바뀔 때만 다시 읽고, 바뀌면 features를 알린다', async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'one', title: 'one' });
  const before = await featureStamp(root);
  assert.match(before, /^one\.json:\d+:/);
  const watcher = new ChatWatcher(root, { featureIntervalMs: 0 }), events = [];
  watcher.on('features', ({ features }) => events.push(features.map((f) => f.title)));
  await watcher.tick({ initial: true });
  await watcher.tick();
  assert.deepEqual(events, [], '바뀐 것이 없으면 알리지 않는다');
  await touch(root, 'one', 'one renamed');
  assert.notEqual(await featureStamp(root), before);
  await watcher.tick();
  assert.deepEqual(events, [['one renamed']]);
});

test('감시: 채팅 감시처럼 기능·승인 감시를 끄면 그 이벤트를 내지 않는다', async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'one', title: 'one' });
  const watcher = new ChatWatcher(root, { featureIntervalMs: 0, features: false, approvals: false }), events = [];
  for (const name of ['features', 'approvals']) watcher.on(name, () => events.push(name));
  await watcher.tick({ initial: true });
  await touch(root, 'one', 'changed');
  await watcher.tick();
  assert.deepEqual(events, []);
});

test('감시: CLI가 제안한 규칙과 저장한 위키 페이지·반영 표시를 rules·wiki로 알린다', async (t) => {
  const root = await project(t);
  const watcher = new ChatWatcher(root, { featureIntervalMs: 0 }), events = [];
  for (const name of ['rules', 'wiki']) watcher.on(name, () => events.push(name));
  await watcher.tick({ initial: true });
  await watcher.tick();
  assert.deepEqual(events, [], '처음 상태는 알리지 않는다');
  await mkdir(join(root, '.wax', 'chat'), { recursive: true });
  await appendFile(join(root, '.wax', 'chat', 'rules.jsonl'), '{"record":"rule"}\n');
  await watcher.tick();
  assert.deepEqual(events.splice(0), ['rules']);
  const pages = join(root, 'docs', 'wax', 'wiki');
  await mkdir(pages, { recursive: true });
  await watcher.tick();
  assert.deepEqual(events.splice(0), ['wiki'], '위키 폴더가 생겼다');
  await writeFile(join(pages, 'overview.md.tmp'), '# 개요\n');
  await rename(join(pages, 'overview.md.tmp'), join(pages, 'overview.md'));
  await watcher.tick();
  assert.deepEqual(events.splice(0), ['wiki']);
  await mkdir(join(root, '.wax', 'wiki'), { recursive: true });
  await writeFile(join(root, '.wax', 'wiki', 'state.json'), '{"schema":1,"seen":[]}\n');
  await watcher.tick();
  assert.deepEqual(events.splice(0), ['wiki'], 'wiki skip이 남긴 반영 표시');
  await watcher.tick();
  assert.deepEqual(events, []);
  const quiet = new ChatWatcher(root, { featureIntervalMs: 0, knowledge: false });
  quiet.on('rules', () => events.push('rules'));
  await quiet.tick({ initial: true });
  await appendFile(join(root, '.wax', 'chat', 'rules.jsonl'), '{"record":"rule"}\n');
  await quiet.tick();
  assert.deepEqual(events, [], '채팅 감시(wax chat watch)는 규칙·위키를 보지 않는다');
});
