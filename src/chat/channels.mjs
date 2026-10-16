import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { getFeature, listFeatures, WaxError } from '../workflow.mjs';
import * as v from './validate.mjs';
import { chatDir } from './paths.mjs';
import { appendRecord, makeId, readRecords } from './store.mjs';
import { resolveKind, withPresenceActivity } from './presence.mjs';

export const projectName = (root) => basename(resolve(root));

export async function canonicalChannel(root, id) {
  if (id === v.GENERAL || id !== projectName(root)) return id;
  try { v.channelId(id); await getFeature(root, id); return id; }
  catch (error) {
    if (error.status === 400 || error.status === 404) return v.GENERAL;
    throw error;
  }
}

export async function resolveTarget(root, id, { write = false } = {}) {
  v.channelId(id);
  let feature = null;
  try { feature = await getFeature(root, id); }
  catch (error) {
    if (error.status !== 404) throw error;
    if (id !== v.GENERAL) throw new WaxError(`wax 작업 ${id}이(가) 없습니다. 작업 ID 또는 ${v.GENERAL}을 사용하세요.`, 404);
  }
  if (write && feature?.archivedAt) throw new WaxError(`보관된 작업 ${id}에는 쓸 수 없습니다. 복원 후 사용하세요.`, 409);
  return feature;
}

async function channelFile(root, channel, create) {
  const dir = await chatDir(root, 'channels', { create });
  if (create) await chatDir(root, null, { create: true });
  return dir && join(dir, `${channel}.jsonl`);
}

export async function postMessage(root, name, input = {}, { now = new Date() } = {}) {
  const channel = await canonicalChannel(root, name);
  const feature = await resolveTarget(root, channel, { write: true });
  const author = v.author(input.author);
  const kind = await resolveKind(root, author, input.kind);
  const type = v.messageType(input.type, 'message');
  const body = v.body(input.body);
  const doing = v.optionalText(input.doing, v.LIMITS.note, '지금 하는 일');
  const to = v.recipients(input.to);
  const phase = v.phase(input.phase) ?? feature?.phase ?? null;
  const replyTo = input.replyTo ? (v.seqOf(input.replyTo, ['m'], '답글 대상 ID'), input.replyTo) : null;
  await chatDir(root, null, { create: true });
  const file = await channelFile(root, channel, true);
  if (replyTo) {
    const { records } = await readRecords(file);
    if (!records.some((record) => record.id === replyTo)) throw new WaxError(`답글 대상 메시지 ${replyTo}이(가) 이 채널에 없습니다.`);
  }
  return withPresenceActivity(root, { author, session: input.session, kind, feature: feature ? channel : undefined, note: doing }, async () => {
    const message = await appendRecord(file, (seq) => ({
      schema: 1, id: makeId('m', seq), seq, channel, author, kind, type, body,
      ...(doing ? { doing } : {}), ...(to.length ? { to } : {}),
      ...(phase ? { phase } : {}), ...(replyTo ? { replyTo } : {}), at: now.toISOString(),
    }));
    return message;
  }, { now });
}

export async function readMessages(root, name, { since, limit } = {}) {
  const channel = await canonicalChannel(root, name);
  await resolveTarget(root, channel);
  const sinceSeq = since ? v.seqOf(since, ['m'], 'since ID') : 0;
  const max = v.limit(limit);
  const file = await channelFile(root, channel, false);
  if (!file) return { messages: [], skipped: 0 };
  const { records, skipped } = await readRecords(file);
  const messages = records.filter((record) => record.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  return { messages: since ? messages.slice(0, max) : messages.slice(-max), skipped };
}

export async function listChannels(root) {
  const features = (await listFeatures(root)).filter((feature) => !feature.archivedAt);
  const dir = await chatDir(root, 'channels');
  const files = dir ? (await readdir(dir)).filter((name) => /^[a-z0-9][a-z0-9-]{0,63}\.jsonl$/.test(name)) : [];
  const stats = new Map();
  for (const name of files) {
    const { records } = await readRecords(join(dir, name));
    const last = records.at(-1);
    stats.set(name.slice(0, -6), { count: records.length, lastAt: last?.at ?? null });
  }
  const channels = features.map((feature) => ({
    id: feature.id, name: feature.id, title: feature.title, phase: feature.phase, isFeature: true,
    ...(stats.get(feature.id) ?? { count: 0, lastAt: null }),
  }));
  if (!features.some((feature) => feature.id === v.GENERAL)) {
    channels.unshift({ id: v.GENERAL, name: projectName(root), title: '프로젝트 전체', phase: null, isFeature: false, ...(stats.get(v.GENERAL) ?? { count: 0, lastAt: null }) });
  }
  return channels;
}
