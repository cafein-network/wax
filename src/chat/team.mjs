import { t } from '../../web/messages-catalog.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PHASES, WaxError, getFeature } from '../workflow.mjs';
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

export const TASK_DONE_CHECK = ['warn', 'enforce', 'off'];
export function taskDoneCheckMode(value = process.env.WAX_TASK_DONE_CHECK) {
  if (value === undefined || value === '') return 'warn';
  if (!TASK_DONE_CHECK.includes(value)) throw new WaxError(t('errors.chat.team.waxTaskDoneCheck'));
  return value;
}
export function taskDoneWarning(task, feature) {
  const since = task.at;
  if (task.phase === 'any') {
    if ((feature.history ?? []).some((event) => event.action === 'complete' && event.at >= since)) return null;
    return `업무 ${task.id}을(를) 배정한 뒤 작업 ${feature.id}에서 완료한 단계가 없습니다(현재 단계 ${feature.phase}). 단계를 완료(wax complete)한 뒤 done으로 바꾸고, 끝낼 수 없으면 block으로 이유를 남기세요.`;
  }
  const completed = feature.completed?.[task.phase];
  if (completed && completed.at >= since) return null;
  return `업무 ${task.id}의 ${task.phase} 단계가 배정 이후 현재 주기에 완료되지 않았습니다(작업 ${feature.id} 현재 단계 ${feature.phase}). wax complete ${task.phase} ${feature.id}로 단계를 끝낸 뒤 done으로 바꾸고, 끝낼 수 없으면 block으로 이유를 남기세요.`;
}
async function linkedFeature(root, id) {
  if (!id) return null;
  try { return await getFeature(root, id); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

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
    if (error instanceof SyntaxError) throw new WaxError(t('errors.chat.team.teamJsonIsCorrupted'), 500);
    throw error;
  }
}

export async function setPm(root, input = {}, { now = new Date() } = {}) {
  const pm = input.author ? { author: v.author(input.author), kind: input.kind ? v.kind(input.kind) : await resolveKind(root, input.author), at: now.toISOString() } : null;
  const file = await teamFile(root, true);
  return withLock(`${file}.lock`, async () => {
    const current = await getTeam(root);
    if (pm && current.pm && current.pm.author !== pm.author && !input.replace) {
      throw new WaxError(t('errors.chat.team.thisProjectsPmIs', current.pm.author), 409);
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
      task.updates.push({ id: record.id, status: record.status, author: record.author, note: record.note ?? null, at: record.at, ...(record.warning ? { warning: record.warning } : {}) });
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
  if (!pm) throw new WaxError(t('errors.chat.team.noPmIsSet'), 409);
  if (pm.author !== author) throw new WaxError(t('errors.chat.team.onlyThePmCan', pm.author), 403);
  const feature = await resolveTarget(root, v.channelId(input.feature), { write: true });
  if (!feature) throw new WaxError(t('errors.chat.team.assignmentsMustBeMade'));
  const to = v.author(input.to);
  const phase = input.phase || feature.phase;
  if (!TASK_PHASES.includes(phase)) throw new WaxError(t('errors.chat.team.theStageMustBe', TASK_PHASES.join(', ')));
  const kind = input.kind ? v.kind(input.kind) : (await listPresence(root)).find((entry) => entry.author === author)?.kind ?? pm.kind;
  const note = v.body(input.body, v.LIMITS.body, '지시 내용');
  const via = v.via(input.via);
  const file = await tasksFile(root, true);
  return withPresenceActivity(root, { author, session: input.session, kind, note: `${to}에게 ${feature.id} ${phase} 배정`, via }, async () => {
    const task = await appendRecord(file, (seq) => ({
      schema: 1, record: 'task', id: makeId('t', seq), seq, feature: feature.id, to, phase, note, by: author, kind, ...(via ? { via } : {}), at: now.toISOString(),
    }));
    return { ...task, status: 'open', statusAt: task.at, updates: [] };
  }, { now });
}

export async function updateTask(root, id, action, input = {}, { now = new Date() } = {}) {
  v.seqOf(id, ['t'], '업무 ID');
  const status = NEXT[action];
  if (!status) throw new WaxError(t('errors.chat.team.assignmentStatusChangesAre'));
  const author = v.author(input.author);
  const note = v.optionalText(input.body, v.LIMITS.body, '메모');
  const { pm } = await getTeam(root);
  const mode = status === 'done' ? taskDoneCheckMode(input.taskDoneCheck) : 'off';
  const via = v.via(input.via);
  const file = await tasksFile(root, true);
  return withPresenceActivity(root, { author, session: input.session, kind: input.kind ? v.kind(input.kind) : undefined, via }, async () => {
    const record = await appendRecord(file, async (seq) => {
      const task = fold((await readRecords(file)).records.sort((a, b) => a.seq - b.seq)).find((item) => item.id === id);
      if (!task) throw new WaxError(t('errors.chat.team.assignmentNotFound', id), 404);
      const isPm = pm?.author === author;
      if (action === 'cancel' ? !isPm : !(isPm || task.to === author)) throw new WaxError(action === 'cancel' ? '업무 취소는 PM만 할 수 있습니다.' : `업무 ${id}의 담당자(${task.to}) 또는 PM만 상태를 바꿀 수 있습니다.`, 403);
      if (FINAL.has(task.status)) throw new WaxError(t('errors.chat.team.alreadyAssignment', task.status === 'done' ? '완료' : '취소'), 409);
      if (status === 'blocked' && !note) throw new WaxError(t('errors.chat.team.leaveTheReasonIt'));
      const feature = mode === 'off' ? null : await linkedFeature(root, task.feature);
      const warning = feature ? taskDoneWarning(task, feature) : null;
      if (warning && mode === 'enforce') throw new WaxError(`${warning} (WAX_TASK_DONE_CHECK=enforce)`, 409);
      return { schema: 1, record: 'status', id: makeId('s', seq), seq, task: id, status, author, ...(note ? { note } : {}), ...(warning ? { warning } : {}), ...(via ? { via } : {}), at: now.toISOString() };
    });
    return (await listTasks(root, { all: true })).find((task) => task.id === record.task);
  }, { now });
}
