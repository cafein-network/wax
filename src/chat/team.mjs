import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PHASES, WaxError } from '../workflow.mjs';
import * as v from './validate.mjs';
import { chatDir, checkFile } from './paths.mjs';
import { withLock } from './lock.mjs';
import { appendRecord, makeId, readRecords, writeJsonAtomic } from './store.mjs';
import { resolveTarget } from './channels.mjs';
import { resolveKind, listPresence, withPresenceActivity } from './presence.mjs';

export const TASK_PHASES = [...PHASES, 'any'];
export const TASK_STATUSES = ['open', 'accepted', 'blocked', 'done', 'cancelled'];
const NEXT = { accept: 'accepted', done: 'done', block: 'blocked', cancel: 'cancelled' };
const FINAL = new Set(['done', 'cancelled']);

async function teamFile(root, create) {
  const dir = await chatDir(root, null, { create });
  return dir && join(dir, 'team.json');
}

async function tasksFile(root, create) {
  const dir = await chatDir(root, null, { create });
  return dir && join(dir, 'assignments.jsonl');
}

export async function getTeam(root) {
  const file = await teamFile(root, false);
  if (!file) return { schema: 1, pm: null };
  await checkFile(file);
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return { schema: 1, pm: data?.pm && typeof data.pm.author === 'string' ? data.pm : null };
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, pm: null };
    if (error instanceof SyntaxError) throw new WaxError('team.json이 손상되었습니다.', 500);
    throw error;
  }
}

export async function setPm(root, input = {}, { now = new Date() } = {}) {
  const pm = input.author ? { author: v.author(input.author), kind: input.kind ? v.kind(input.kind) : await resolveKind(root, input.author), at: now.toISOString() } : null;
  const file = await teamFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const current = await getTeam(root);
    if (pm && current.pm && current.pm.author !== pm.author && !input.replace) {
      throw new WaxError(`이 프로젝트의 PM은 이미 ${current.pm.author}입니다. PM은 대표가 교체를 요청했을 때만 바꿉니다(--replace).`, 409);
    }
    const team = { ...current, pm };
    await writeJsonAtomic(file, team);
    return team;
  });
}

function fold(records) {
  const tasks = new Map();
  for (const record of records) {
    if (record.record === 'task') tasks.set(record.id, { ...record, status: 'open', statusAt: record.at, updates: [] });
    else if (record.record === 'status' && tasks.has(record.task)) {
      const task = tasks.get(record.task);
      Object.assign(task, { status: record.status, statusAt: record.at });
      task.updates.push({ id: record.id, status: record.status, author: record.author, note: record.note ?? null, at: record.at });
    }
  }
  return [...tasks.values()];
}

export async function readTaskRecords(root) {
  const file = await tasksFile(root, false);
  return file ? (await readRecords(file)).records.sort((a, b) => a.seq - b.seq) : [];
}

export async function listTasks(root, { to, feature, all = false } = {}) {
  const tasks = fold(await readTaskRecords(root));
  return tasks.filter((task) => (all || !FINAL.has(task.status)) && (!to || task.to === to) && (!feature || task.feature === feature));
}

export async function assignTask(root, input = {}, { now = new Date() } = {}) {
  const author = v.author(input.author);
  const { pm } = await getTeam(root);
  if (!pm) throw new WaxError('PM이 지정되지 않았습니다. 대표가 wax chat team pm <이름>으로 먼저 지정하세요.', 409);
  if (pm.author !== author) throw new WaxError(`업무는 PM(${pm.author})만 배정할 수 있습니다.`, 403);
  const feature = await resolveTarget(root, v.channelId(input.feature), { write: true });
  if (!feature) throw new WaxError('업무는 wax 작업에 배정해야 합니다.');
  const to = v.author(input.to);
  const phase = input.phase || feature.phase;
  if (!TASK_PHASES.includes(phase)) throw new WaxError(`단계는 ${TASK_PHASES.join(', ')} 중 하나여야 합니다.`);
  const kind = input.kind ? v.kind(input.kind) : (await listPresence(root)).find((entry) => entry.author === author)?.kind ?? pm.kind;
  const note = v.body(input.body, v.LIMITS.body, '지시 내용');
  const file = await tasksFile(root, true);
  return withPresenceActivity(root, { author, session: input.session, kind, note: `${to}에게 ${feature.id} ${phase} 배정` }, async () => {
    const task = await appendRecord(file, (seq) => ({
      schema: 1, record: 'task', id: makeId('t', seq), seq, feature: feature.id, to, phase, note, by: author, kind, at: now.toISOString(),
    }));
    return { ...task, status: 'open', statusAt: task.at, updates: [] };
  }, { now });
}

export async function updateTask(root, id, action, input = {}, { now = new Date() } = {}) {
  v.seqOf(id, ['t'], '업무 ID');
  const status = NEXT[action];
  if (!status) throw new WaxError('업무 상태 변경은 accept, done, block, cancel 중 하나입니다.');
  const author = v.author(input.author);
  const note = v.optionalText(input.body, v.LIMITS.body, '메모');
  const { pm } = await getTeam(root);
  const file = await tasksFile(root, true);
  return withPresenceActivity(root, { author, session: input.session, kind: input.kind ? v.kind(input.kind) : undefined }, async () => {
    const record = await appendRecord(file, async (seq) => {
      const task = fold((await readRecords(file)).records.sort((a, b) => a.seq - b.seq)).find((item) => item.id === id);
      if (!task) throw new WaxError(`업무 ${id}이(가) 없습니다.`, 404);
      const isPm = pm?.author === author;
      if (action === 'cancel' ? !isPm : !(isPm || task.to === author)) throw new WaxError(action === 'cancel' ? '업무 취소는 PM만 할 수 있습니다.' : `업무 ${id}의 담당자(${task.to}) 또는 PM만 상태를 바꿀 수 있습니다.`, 403);
      if (FINAL.has(task.status)) throw new WaxError(`이미 ${task.status === 'done' ? '완료' : '취소'}된 업무입니다.`, 409);
      if (status === 'blocked' && !note) throw new WaxError('막힌 이유를 --message로 남기세요.');
      return { schema: 1, record: 'status', id: makeId('s', seq), seq, task: id, status, author, ...(note ? { note } : {}), at: now.toISOString() };
    });
    return (await listTasks(root, { all: true })).find((task) => task.id === record.task);
  }, { now });
}
