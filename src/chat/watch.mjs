import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatWatcher } from './watcher.mjs';
import { chatDir } from './paths.mjs';
import { readRecords, writeJsonAtomic } from './store.mjs';
import { chatFiles } from './daily.mjs';
import { listTasks } from './team.mjs';
import * as v from './validate.mjs';

const oneLine = (text, max = 300) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isForMe(message, author) {
  if (message.author === author) return false;
  const mention = new RegExp(`(^|[^\\p{L}\\p{N}_.-])@${escape(author)}(?![\\p{L}\\p{N}_.-])`, 'u');
  return Boolean(message.to?.includes(author)) || mention.test(String(message.body ?? ''));
}

export const byTime = (a, b) => a.message.at.localeCompare(b.message.at) || (a.message.seq ?? 0) - (b.message.seq ?? 0) || a.channel.localeCompare(b.channel);

const cursorFile = async (root, author, feature) => join(await chatDir(root, 'watch', { create: true }), `${Buffer.from(author).toString('hex')}${feature ? `.${feature}` : ''}.json`);
async function readCursor(file) {
  try { const data = JSON.parse(await readFile(file, 'utf8')); return typeof data?.at === 'string' ? { at: data.at, ids: Array.isArray(data.ids) ? data.ids : [] } : null; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

export async function watchChat(root, { author, feature, write, intervalMs = 1000, onError = () => {} }) {
  author = v.author(author);
  const seen = new Set();
  const announceTasks = async () => {
    for (const task of await listTasks(root, { to: author, feature })) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      write({ event: 'task', task });
    }
  };
  const file = await cursorFile(root, author, feature);
  const delivered = new Set();
  let cursor = await readCursor(file);
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
  const watcher = new ChatWatcher(root, { intervalMs });
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
        for (const message of (await readRecords(channelFile)).records) {
          if (wanted(id, message) && (message.at > cursor.at || (message.at === cursor.at && !cursor.ids.includes(message.id)))) missed.push({ channel: id, message });
        }
      }
      const caught = held; held = null;
      await deliver([...missed, ...caught]);
    }
    await announceTasks();
  } catch (error) { watcher.stop(); throw error; }
  return () => watcher.stop();
}

export function formatWatchEvent({ event, channel, message: m, task: t }) {
  if (event === 'task') return `[업무 ${t.id}] PM ${t.by}의 배정: ${t.feature}/${t.phase} ${oneLine(t.note)}`;
  return `[메시지 ${m.id}] #${channel} ${m.author}(${m.kind})${m.type !== 'message' ? ` <${m.type}>` : ''}${m.to?.length ? ` → ${m.to.join(', ')}` : ''}: ${oneLine(m.body)}`;
}
