import { t } from '../../web/messages-catalog.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatWatcher } from './watcher.mjs';
import { chatDir } from './paths.mjs';
import { readTail, writeJsonAtomic } from './store.mjs';
import { chatFiles } from './daily.mjs';
import { listTasks } from './team.mjs';
import { LISTEN_BEAT_MS, startBeat } from './listeners.mjs';
import * as v from './validate.mjs';
import { mentions } from '../../web/recipients-model.mjs';
import { WaxError } from '../workflow.mjs';

const oneLine = (text, max = 300) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };

export function isForMe(message, author) {
  if (message.author === author) return false;
  return Boolean(message.to?.includes(author)) || mentions(message.body, author);
}

export const byTime = (a, b) => a.message.at.localeCompare(b.message.at) || (a.message.seq ?? 0) - (b.message.seq ?? 0) || a.channel.localeCompare(b.channel);

const cursorName = (key, feature) => `${key}${feature ? `.${feature}` : ''}.json`;
const cursorFiles = async (root, author, feature) => {
  const dir = await chatDir(root, 'watch', { create: true });
  const legacy = cursorName(Buffer.from(author).toString('hex'), feature);
  return { file: join(dir, cursorName(createHash('sha256').update(author).digest('hex').slice(0, 32), feature)), legacy: legacy.length <= 255 ? join(dir, legacy) : null };
};
async function readCursor(file) {
  try { const data = JSON.parse(await readFile(file, 'utf8')); return typeof data?.at === 'string' ? { at: data.at, ids: Array.isArray(data.ids) ? data.ids : [] } : null; }
  catch (error) { if (['ENOENT', 'ENAMETOOLONG'].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
}

export async function watchChat(root, { author, feature, write, intervalMs = 1000, wake = false, beatMs = LISTEN_BEAT_MS, onError = () => {} }) {
  author = v.author(author);
  feature = feature ? v.channelId(feature) : undefined;
  const seen = new Set();
  const announceTasks = async () => {
    for (const task of await listTasks(root, { to: author, feature })) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      write({ event: 'task', task });
    }
  };
  const { file, legacy } = await cursorFiles(root, author, feature);
  const delivered = new Set();
  let cursor = await readCursor(file) ?? (legacy && await readCursor(legacy));
  const fresh = !cursor;
  if (fresh) {
    cursor = { at: new Date().toISOString(), ids: [] };
    await writeJsonAtomic(file, { schema: 1, author, feature: feature ?? null, ...cursor });
  }
  let queue = Promise.resolve();
  const deliver = (items) => (queue = queue.then(async () => {
    for (const item of items.sort(byTime)) {
      if (delivered.has(item.message.id)) continue;
      delivered.add(item.message.id);
      write({ event: 'message', ...item });
      const { at, id } = item.message;
      if (at > cursor.at) cursor = { at, ids: [id] };
      else if (at === cursor.at) cursor = { at, ids: [...cursor.ids, id] };
      else continue;
      await writeJsonAtomic(file, { schema: 1, author, feature: feature ?? null, at: cursor.at, ids: cursor.ids });
    }
  }).catch(onError));
  const wanted = (channel, message) => (!feature || channel === feature) && isForMe(message, author);
  const watcher = new ChatWatcher(root, { intervalMs, features: false, approvals: false, knowledge: false });
  let batch = [], held = fresh ? null : [];
  watcher.on('message', ({ channel, message }) => { if (wanted(channel, message)) batch.push({ channel, message }); });
  const tick = watcher.tick.bind(watcher);
  watcher.tick = async (options) => {
    await tick(options);
    const items = batch; batch = [];
    if (!items.length) return;
    if (held) held.push(...items); else await deliver(items);
  };
  watcher.on('tasks', () => announceTasks().catch(onError));
  watcher.on('error', onError);
  await watcher.start();
  try {
    if (held) {
      const missed = [];
      for (const { id, file: channelFile } of await chatFiles(root, 'channels')) {
        for (const message of (await readTail(channelFile, { stop: (record) => record.at < cursor.at })).records) {
          if (wanted(id, message) && (message.at > cursor.at || (message.at === cursor.at && !cursor.ids.includes(message.id)))) missed.push({ channel: id, message });
        }
      }
      const caught = held; held = null;
      await deliver([...missed, ...caught]);
    }
    await announceTasks();
  } catch (error) { watcher.stop(); throw error; }
  let stopBeat = async () => {};
  if (wake) { try { stopBeat = await startBeat(root, author, feature, beatMs, onError); } catch (error) { onError(error); } }
  return () => { watcher.stop(); return stopBeat(); };
}

export const INBOX = { scan: 500, limitDefault: 20, limitMax: 100 };
export async function readInbox(root, { author, since, limit } = {}) {
  author = v.author(author);
  const max = limit === undefined ? INBOX.limitDefault : limit;
  if (!Number.isInteger(max) || max < 1 || max > INBOX.limitMax) throw new WaxError(t('errors.chat.validate.limitMustBeAn', INBOX.limitMax));
  const files = await chatFiles(root, 'channels');
  let after = null;
  if (since !== undefined) {
    const seq = v.seqOf(since, ['m'], 'since ID');
    for (const { id, file } of files) {
      const found = (await readTail(file, { stop: (record) => record.seq <= seq })).records.find((record) => record.id === since);
      if (found) { after = { channel: id, message: found }; break; }
    }
    if (!after) throw new WaxError(t('errors.chat.watch.sinceMessageNotFound', since), 404);
  }
  const items = [];
  for (const { id, file } of files) {
    const { records } = await readTail(file, after ? { stop: (record) => record.at < after.message.at } : { limit: INBOX.scan });
    for (const message of records) if (isForMe(message, author) && (!after || byTime({ channel: id, message }, after) > 0)) items.push({ channel: id, message });
  }
  items.sort(byTime);
  const messages = after ? items.slice(0, max) : items.slice(-max);
  return { author, since: since ?? null, messages, more: items.length > messages.length, tasks: await listTasks(root, { to: author }) };
}

export function formatWatchEvent({ event, channel, message: m, task: t }) {
  if (event === 'task') return `[업무 ${t.id}] PM ${t.by}의 배정: ${t.feature}/${t.phase} ${oneLine(t.note)}`;
  return `[메시지 ${m.id}] #${channel} ${m.author}(${m.kind})${m.type !== 'message' ? ` <${m.type}>` : ''}${m.to?.length ? ` → ${m.to.join(', ')}` : ''}: ${oneLine(m.body)}`;
}
