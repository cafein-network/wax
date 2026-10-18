import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { WaxError } from './workflow.mjs';
import { safeDir } from './chat/paths.mjs';
import { withFileLock, processAlive } from './file-lock.mjs';
import { loadSqlite } from './sqlite.mjs';
import { SOURCES, DOC_KINDS, lineDocs, fileDocs } from './search-sources.mjs';

export const SCHEMA_VERSION = 3;
const GUARD = 64;
const HEAD = 4096;
const PAGE_MAX = 50;
const MAX_JSON = 20 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, kind TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
  ino TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, guard TEXT, lines INTEGER NOT NULL DEFAULT 0, bad INTEGER NOT NULL DEFAULT 0, bad_lines TEXT, synced_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, source TEXT NOT NULL, kind TEXT NOT NULL, feature TEXT, channel TEXT, author TEXT,
  type TEXT, phase TEXT, status TEXT, at TEXT, seq INTEGER, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, pointer TEXT, link TEXT);
CREATE TABLE IF NOT EXISTS refs(path TEXT NOT NULL, doc TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, size INTEGER, mtime REAL, ino TEXT, PRIMARY KEY(path, doc));
CREATE INDEX IF NOT EXISTS refs_source ON refs(source);
CREATE INDEX IF NOT EXISTS docs_source ON docs(source);
CREATE INDEX IF NOT EXISTS docs_at ON docs(at, id);
CREATE INDEX IF NOT EXISTS docs_kind_at ON docs(kind, at, id);
CREATE INDEX IF NOT EXISTS docs_feature_at ON docs(feature, at, id);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_tri USING fts5(title, body, content='docs', content_rowid='id', tokenize='trigram');
-- Bigram text is only indexed, not stored: it is derived from title and body.
CREATE VIRTUAL TABLE IF NOT EXISTS docs_bi USING fts5(grams, content='', contentless_delete=1, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_tri(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_tri(docs_tri, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  DELETE FROM docs_bi WHERE rowid = old.id;
END;`;

export function bigrams(value) {
  const out = new Set();
  for (const word of value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const chars = [...word];
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return [...out].join(' ');
}

export function terms(query) {
  if (typeof query !== 'string') return [];
  const out = [];
  for (const match of query.normalize('NFC').matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).trim();
    if (term && !out.includes(term)) out.push(term);
  }
  return out.slice(0, 8);
}
const phrase = (term) => `"${term.replaceAll('"', '""')}"`;
const likeEscape = (term) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

export function plan(term) {
  const length = [...term].length;
  if (length >= 3) return { via: 'trigram', sql: 'id IN (SELECT rowid FROM docs_tri WHERE docs_tri MATCH ?)', arg: phrase(term) };
  if (length === 2 && /^[\p{L}\p{N}]{2}$/u.test(term)) return { via: 'bigram', sql: 'id IN (SELECT rowid FROM docs_bi WHERE docs_bi MATCH ?)', arg: phrase(term.toLowerCase()) };
  return { via: 'scan', sql: "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')", arg: `%${likeEscape(term)}%`, twice: true };
}

async function indexDir(root, create) { return safeDir(root, ['.wax', 'search'], { create }); }
const DB_NAME = 'index.db';

function configure(db) {
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY;');
}

async function createIndexFile(sqlite, dir) {
  for (const name of await readdir(dir)) {
    const owner = /^index\.db\.new-(\d+)-\d+(?:-(?:wal|shm|journal))?$/.exec(name);
    if (owner && !processAlive(Number(owner[1]))) await rm(join(dir, name), { force: true });
  }
  const temp = join(dir, `${DB_NAME}.new-${process.pid}-${Date.now()}`);
  const db = new sqlite.DatabaseSync(temp);
  try {
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema', ?), ('building', ?)").run(String(SCHEMA_VERSION), marker());
  } finally { db.close(); }
  for (const name of [`${DB_NAME}-wal`, `${DB_NAME}-shm`]) await rm(join(dir, name), { force: true });
  await rename(temp, join(dir, DB_NAME));
}

export async function openIndex(root) {
  const sqlite = await loadSqlite();
  if (sqlite.error) return { state: 'unsupported', error: sqlite.error };
  const dir = await indexDir(root, false);
  const path = dir && join(dir, DB_NAME);
  if (!path) return { state: 'missing' };
  try { await stat(path); } catch { return { state: 'missing' }; }
  for (const name of [path, `${path}-wal`, `${path}-shm`]) {
    const info = await lstat(name).catch(() => null);
    if (info && !info.isFile()) return { state: 'corrupt', path, error: `검색 색인 파일(${name.split(/[\\/]/).at(-1)})이 일반 파일이 아닙니다.` };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(path);
    configure(db);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value;
    if (Number(version) !== SCHEMA_VERSION) { db.close(); return { state: 'outdated', path, error: `색인 형식(${version ?? '없음'})이 이 wax의 형식(${SCHEMA_VERSION})과 다릅니다.` }; }
    return { state: 'ready', db, path };
  } catch (error) {
    try { db?.close(); } catch {   }
    return { state: 'corrupt', path, error: `검색 색인을 열 수 없습니다: ${error.message}` };
  }
}

export async function listSources(root) {
  const found = [];
  for (const source of SOURCES) {
    let dir;
    try { dir = await safeDir(root, source.dir); } catch { continue; }
    if (!dir) continue;
    for (const name of await readdir(dir).catch(() => [])) {
      if (!source.name.test(name)) continue;
      const abs = join(dir, name);
      const info = await lstat(abs).catch(() => null);
      if (!info?.isFile()) continue;
      found.push({ source, abs, rel: [...source.dir, name].join('/'), info });
    }
  }
  return found;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function openChecked(abs, expected) {
  const handle = await open(abs, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (expected && `${info.dev}:${info.ino}` !== `${expected.dev}:${expected.ino}`)) throw Object.assign(new Error('changed while opening'), { code: 'ECHANGED' });
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function referenceFile(root, path, { read = true } = {}) {
  if (typeof path !== 'string' || !/^docs\/wax\/[A-Za-z0-9/._-]{1,200}\.md$/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return { state: 'refused', key: null };
  let current = await realpath(root), info;
  const parts = path.split('/');
  try {
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return { state: 'refused', key: null };
    }
  } catch (error) { return { state: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unreadable', key: null }; }
  const key = statKey(info);
  if (info.size > 1_000_000) return { state: 'too-large', key };
  if (!read) return { state: 'ok', key };
  let handle;
  try {
    handle = await openChecked(current, info);
    return { state: 'ok', key, text: await handle.readFile('utf8') };
  } catch (error) { return { state: error.code === 'ELOOP' || error.code === 'ECHANGED' ? 'refused' : error.code === 'ENOENT' ? 'missing' : 'unreadable', key: null }; }
  finally { await handle?.close(); }
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function bytes(abs, start, end) {
  const handle = await openChecked(abs);
  try {
    const length = Math.max(0, end - start), buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
const statKey = (info) => ({ size: info.size, mtime: info.mtimeMs, ino: `${info.dev}:${info.ino}` });

async function planSource(entry, row) {
  const key = statKey(entry.info);
  if (!row) return { mode: 'full', key };
  if (row.ino !== key.ino || row.format !== entry.source.format) return { mode: 'full', key };
  if (entry.source.format === 'json') return row.size === key.size && row.mtime === key.mtime ? { mode: 'none' } : { mode: 'full', key };
  if (key.size < row.offset) return { mode: 'full', key };
  if (key.size === row.offset) return row.mtime === key.mtime ? { mode: 'none' } : { mode: 'full', key };
  if (row.offset > 0) {
    const [guard, head] = await Promise.all([bytes(entry.abs, Math.max(0, row.offset - GUARD), row.offset), bytes(entry.abs, 0, Math.min(HEAD, row.offset))]);
    if (`${sha(guard)}:${sha(head)}` !== row.guard) return { mode: 'full', key };
  }
  if (!(await bytes(entry.abs, row.offset, key.size)).includes(0x0a)) return { mode: 'none' };
  return { mode: 'append', key, from: row.offset };
}

async function readLines(root, entry, from, lookups) {
  const size = entry.info.size;
  const chunk = await bytes(entry.abs, from, size);
  const end = chunk.lastIndexOf(0x0a) + 1;
  const docs = [], bad = [], local = new Map();
  const taskFeature = async (task) => local.get(task) ?? lookups.taskFeature(task);
  let line = lookups.firstLine;
  for (const raw of chunk.subarray(0, end).toString('utf8').split('\n').slice(0, -1)) {
    line++;
    if (!raw.trim()) continue;
    let record;
    try { record = JSON.parse(raw); } catch { bad.push(line); continue; }
    if (record?.record === 'task' && typeof record.id === 'string') local.set(record.id, record.feature ?? null);
    const made = await lineDocs(entry.source, record, { rel: entry.rel, files: (path) => referenceFile(root, path), taskFeature });
    if (!made.length && !(record && typeof record === 'object' && typeof record.id === 'string')) bad.push(line);
    docs.push(...made);
  }
  const offset = from + end;
  const guard = offset > 0 ? `${sha(await bytes(entry.abs, Math.max(0, offset - GUARD), offset))}:${sha(await bytes(entry.abs, 0, Math.min(HEAD, offset)))}` : null;
  return { docs, bad, offset, lines: line, guard };
}

function insertDocs(db, rel, docs) {
  const insert = db.prepare(`INSERT INTO docs(ref, source, kind, feature, channel, author, type, phase, status, at, seq, title, body, pointer, link)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING`);
  const grams = db.prepare('INSERT INTO docs_bi(rowid, grams) VALUES (?, ?)');
  const track = db.prepare('INSERT OR REPLACE INTO refs(path, doc, source, state, size, mtime, ino) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const d of docs) {
    const { changes, lastInsertRowid } = insert.run(d.ref, rel, d.kind, d.feature, d.channel, d.author, d.type, d.phase, d.status, d.at, d.seq, d.title ?? '', d.body ?? '', d.pointer ?? null, d.link ?? null);
    if (changes) grams.run(lastInsertRowid, bigrams(`${d.title ?? ''} ${d.body ?? ''}`));
    if (changes && d.file) track.run(d.file.path, d.ref, rel, d.file.state, d.file.key?.size ?? null, d.file.key?.mtime ?? null, d.file.key?.ino ?? null);
  }
}

function write(db, work) {
  try { db.exec('BEGIN IMMEDIATE'); }
  catch (error) { throw new WaxError(`다른 wax 프로세스가 검색 색인을 쓰고 있습니다. 잠시 후 다시 시도하세요. (${error.message})`, 409); }
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {   } throw error; }
}

async function syncSource(root, db, entry) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = db.prepare('SELECT * FROM sources WHERE path = ?').get(entry.rel);
    const step = await planSource(entry, row);
    if (step.mode === 'none') return { changed: false };
    let parsed;
    if (entry.source.format === 'json') {
      let docs = [], bad = [];
      try {
        if (entry.info.size > MAX_JSON) throw new Error('too large');
        docs = fileDocs(entry.source, JSON.parse(await readFile(entry.abs, 'utf8')), { rel: entry.rel });
      } catch { bad = [1]; }
      parsed = { docs, bad, offset: entry.info.size, lines: 1, guard: null };
    } else {
      const from = step.mode === 'append' ? step.from : 0;
      parsed = await readLines(root, entry, from, { firstLine: step.mode === 'append' ? row.lines : 0,
        taskFeature: async (task) => db.prepare('SELECT feature FROM docs WHERE ref = ?').get(`task:${task}`)?.feature ?? null });
    }
    const outcome = write(db, () => {
      const now = db.prepare('SELECT size, mtime, ino, offset FROM sources WHERE path = ?').get(entry.rel);
      if (JSON.stringify(now ?? null) !== JSON.stringify(row ? { size: row.size, mtime: row.mtime, ino: row.ino, offset: row.offset } : null)) return 'retry';
      if (step.mode === 'full') { db.prepare('DELETE FROM docs WHERE source = ?').run(entry.rel); db.prepare('DELETE FROM refs WHERE source = ?').run(entry.rel); }
      insertDocs(db, entry.rel, parsed.docs);
      const bad = (step.mode === 'append' ? (row.bad ?? 0) : 0) + parsed.bad.length;
      const badLines = [...(step.mode === 'append' && row.bad_lines ? JSON.parse(row.bad_lines) : []), ...parsed.bad].slice(0, 20);
      db.prepare(`INSERT OR REPLACE INTO sources(path, kind, format, size, mtime, ino, offset, guard, lines, bad, bad_lines, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.rel, entry.source.kind, entry.source.format, step.key.size, step.key.mtime, step.key.ino, parsed.offset, parsed.guard, parsed.lines, bad, badLines.length ? JSON.stringify(badLines) : null, new Date().toISOString());
      return 'ok';
    });
    if (outcome === 'ok') return { changed: true, docs: parsed.docs.length, full: step.mode === 'full' };
    entry.info = await lstat(entry.abs).catch(() => null) ?? entry.info;
  }
  throw new WaxError(`${entry.rel}을(를) 동기화하는 동안 계속 바뀌어 이번에는 건너뛰었습니다. 다시 시도하세요.`, 409);
}

const sameKey = (row, key) => (key?.size ?? null) === row.size && (key?.mtime ?? null) === row.mtime && (key?.ino ?? null) === row.ino;

async function changedReferences(root, db) {
  const groups = new Map();
  for (const row of db.prepare('SELECT * FROM refs ORDER BY path').all()) groups.set(row.path, [...(groups.get(row.path) ?? []), row]);
  const changed = [];
  for (const [path, rows] of groups) {
    const probe = await referenceFile(root, path, { read: false });
    const stale = rows.filter((row) => probe.state !== row.state || !sameKey(row, probe.key));
    if (stale.length) changed.push({ path, probe, rows: stale });
  }
  return changed;
}

async function syncReferences(root, db) {
  let files = 0, docs = 0;
  for (const { path, probe, rows } of await changedReferences(root, db)) {
    const file = probe.state === 'ok' ? await referenceFile(root, path) : probe;
    files++;
    docs += write(db, () => {
      let done = 0;
      for (const row of rows) {
        const now = db.prepare('SELECT * FROM refs WHERE path = ? AND doc = ?').get(path, row.doc);
        if (!now || now.state !== row.state || !sameKey(now, row)) continue;
        const current = db.prepare('SELECT * FROM docs WHERE ref = ?').get(row.doc);
        if (!current) { db.prepare('DELETE FROM refs WHERE path = ? AND doc = ?').run(path, row.doc); continue; }
        db.prepare('DELETE FROM docs WHERE ref = ?').run(row.doc);
        insertDocs(db, current.source, [{ ...current, body: file.state === 'ok' ? file.text.slice(0, 100_000) : '', status: file.state === 'ok' ? null : `file-${file.state}`, file: { path, state: file.state, key: file.key } }]);
        done++;
      }
      return done;
    });
  }
  return { files, docs };
}

export async function syncIndex(root, db) {
  const started = Date.now();
  const entries = await listSources(root);
  const present = new Set(entries.map((e) => e.rel));
  let changed = 0, docs = 0, removed = 0;
  for (const entry of entries) {
    const result = await syncSource(root, db, entry);
    if (result.changed) { changed++; docs += result.docs; }
  }
  for (const { path } of db.prepare('SELECT path FROM sources').all()) {
    if (present.has(path)) continue;
    write(db, () => { db.prepare('DELETE FROM docs WHERE source = ?').run(path); db.prepare('DELETE FROM refs WHERE source = ?').run(path); db.prepare('DELETE FROM sources WHERE path = ?').run(path); });
    removed++;
  }
  const references = await syncReferences(root, db);
  write(db, () => db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('synced_at', ?)").run(new Date().toISOString()));
  return { sources: entries.length, changed: changed + references.docs, removed, docs, references, ms: Date.now() - started };
}

const marker = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
async function builder(root, db) {
  const raw = db.prepare("SELECT value FROM meta WHERE key = 'building'").get()?.value;
  if (!raw) return null;
  let mark;
  try { mark = JSON.parse(raw); } catch { mark = {}; }
  const dir = await indexDir(root, false);
  const owner = dir ? await readFile(join(dir, 'rebuild.lock', 'owner.json'), 'utf8').then(JSON.parse, () => null) : null;
  const live = Number.isSafeInteger(mark?.pid) && owner?.pid === mark.pid && processAlive(mark.pid);
  return { raw, at: typeof mark?.at === 'string' ? mark.at : null, pid: mark?.pid ?? null, live };
}

async function resumeInterrupted(root, db, build) {
  const synced = await syncIndex(root, db);
  write(db, () => db.prepare("DELETE FROM meta WHERE key = 'building' AND value = ?").run(build.raw));
  return synced;
}

export async function buildIndex(root, { rebuild = false } = {}) {
  const sqlite = await loadSqlite();
  if (sqlite.error) throw Object.assign(new WaxError(sqlite.error, 501), { state: 'unsupported' });
  const dir = await indexDir(root, true);
  return withFileLock(join(dir, 'rebuild.lock'), async () => {
    let opened = await openIndex(root);
    if (opened.state === 'ready' && rebuild) {
      write(opened.db, () => {
        opened.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('building', ?)").run(marker());
        opened.db.exec('DELETE FROM docs; DELETE FROM sources; DELETE FROM refs;');
      });
    } else if (opened.state !== 'ready') {
      await createIndexFile(sqlite, dir);
      opened = await openIndex(root);
      if (opened.state !== 'ready') throw new WaxError(opened.error ?? '검색 색인을 만들지 못했습니다.', 500);
    }
    try {
      write(opened.db, () => opened.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('building', ?)").run(marker()));
      const result = await syncIndex(root, opened.db);
      write(opened.db, () => opened.db.prepare("DELETE FROM meta WHERE key = 'building'").run());
      return { ...result, ...counts(opened.db) };
    } finally { opened.db.close(); }
  }, { timeoutMs: 30_000, staleMs: 10 * 60_000 });
}

function counts(db) {
  return {
    documents: db.prepare('SELECT count(*) AS n FROM docs').get().n,
    indexedSources: db.prepare('SELECT count(*) AS n FROM sources').get().n,
    badRecords: db.prepare('SELECT coalesce(sum(bad), 0) AS n FROM sources').get().n,
  };
}

export async function indexStatus(root) {
  const opened = await openIndex(root);
  if (opened.state !== 'ready') return { state: opened.state, error: opened.error ?? null, next: nextStep(opened.state) };
  const { db } = opened;
  try {
    let pending = 0;
    const entries = await listSources(root), present = new Set(entries.map((e) => e.rel));
    for (const entry of entries) if ((await planSource(entry, db.prepare('SELECT * FROM sources WHERE path = ?').get(entry.rel))).mode !== 'none') pending++;
    pending += db.prepare('SELECT path FROM sources').all().filter((row) => !present.has(row.path)).length;
    pending += (await changedReferences(root, db)).length;
    const build = await builder(root, db);
    const damaged = [
      ...db.prepare('SELECT path, bad, bad_lines FROM sources WHERE bad > 0 ORDER BY path LIMIT 20').all().map((r) => ({ path: r.path, records: r.bad, lines: r.bad_lines ? JSON.parse(r.bad_lines) : [] })),
      ...db.prepare("SELECT path, state FROM refs WHERE state <> 'ok' ORDER BY path LIMIT 20").all().map((r) => ({ path: r.path, records: 1, lines: [], file: r.state })),
    ];
    const size = await stat(opened.path).then((s) => s.size, () => 0) + await stat(`${opened.path}-wal`).then((s) => s.size, () => 0);
    const state = build ? (build.live ? 'building' : 'interrupted') : pending ? 'stale' : 'ready';
    return { state, pending, building: build ? { at: build.at, pid: build.pid, live: build.live } : null, syncedAt: db.prepare("SELECT value FROM meta WHERE key = 'synced_at'").get()?.value ?? null,
      ...counts(db), damaged, bytes: size, scope: Object.values(DOC_KINDS), next: ['building', 'interrupted', 'stale'].includes(state) ? nextStep(state) : null };
  } finally { db.close(); }
}

export function nextStep(state) {
  return ({
    missing: '검색 색인이 아직 없습니다. 대시보드의 검색 화면에서 “검색 색인 만들기”를 누르거나 wax search index 를 실행하세요.',
    corrupt: '검색 색인이 손상됐습니다. wax search index --rebuild 로 다시 만드세요. 프로젝트 기록(.wax의 JSON/JSONL)은 그대로입니다.',
    outdated: '이 wax 버전의 검색 색인 형식과 다릅니다. wax search index --rebuild 로 다시 만드세요.',
    unsupported: '검색은 Node.js 22.16 이상 또는 24 이상에서 사용할 수 있습니다. 다른 wax 기능은 그대로 쓸 수 있습니다.',
    stale: '아직 색인에 반영되지 않은 변경이 있습니다. 검색하면 먼저 반영합니다.',
    building: '검색 색인을 만드는 중입니다. 끝날 때까지 결과가 일부만 나올 수 있습니다.',
    interrupted: '검색 색인 만들기가 중간에 멈췄습니다. 검색하거나 “색인 이어서 만들기”(wax search index)를 누르면 남은 기록부터 이어서 반영합니다.',
  })[state] ?? null;
}

const pick = (value, max = 64) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
const day = (value, end) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new WaxError('기간은 YYYY-MM-DD 형식이어야 합니다.');
  return end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
};
const cursorOf = (row) => Buffer.from(JSON.stringify([row.at ?? '', row.id])).toString('base64url');
function readCursor(value) {
  if (!value) return null;
  try { const [at, id] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); if (typeof at === 'string' && Number.isSafeInteger(id)) return { at, id }; } catch {   }
  throw new WaxError('잘못된 페이지 위치입니다. 검색을 처음부터 다시 하세요.');
}

export function marksIn(text, list) {
  const lower = text.toLowerCase(), ranges = [];
  for (const term of list) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    for (let at = lower.indexOf(needle); at !== -1 && ranges.length < 200; at = lower.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]).filter((r, i, all) => i === 0 || r[0] >= all[i - 1][1]);
}
function snippet(body, list, width = 220) {
  const marks = marksIn(body, list);
  const center = marks[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(center - 60, body.length - width)), end = Math.min(body.length, start + width);
  const text = `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
  const shift = start > 0 ? 1 - start : -start;
  return { text, marks: marks.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a + shift, b + shift]) };
}

export function searchIndex(db, input = {}) {
  const list = terms(input.query);
  const limit = Math.min(Math.max(Number.parseInt(input.limit ?? 20, 10) || 20, 1), PAGE_MAX);
  const where = [], args = [];
  const filters = { kind: pick(input.kind, 20), feature: pick(input.feature), author: pick(input.author, 40), phase: pick(input.phase, 20) };
  if (filters.kind && !Object.hasOwn(DOC_KINDS, filters.kind)) throw new WaxError(`종류는 ${Object.keys(DOC_KINDS).join(', ')} 중 하나여야 합니다.`);
  for (const [column, value] of Object.entries(filters)) if (value) { where.push(`${column} = ?`); args.push(value); }
  const from = day(input.from, false), to = day(input.to, true);
  if (from) { where.push('at >= ?'); args.push(from); }
  if (to) { where.push('at <= ?'); args.push(to); }
  if (!list.length && !Object.values(filters).some(Boolean) && !from && !to) return { query: '', terms: [], results: [], next: null, total: 0, methods: [] };
  const methods = list.map((term) => ({ term, ...plan(term) }));
  for (const method of methods) { where.push(method.sql); args.push(method.arg); if (method.twice) args.push(method.arg); }
  const cursor = readCursor(input.cursor);
  const page = [...where], pageArgs = [...args];
  if (cursor) { page.push("(coalesce(at, '') < ? OR (coalesce(at, '') = ? AND id < ?))"); pageArgs.push(cursor.at, cursor.at, cursor.id); }
  const sql = `SELECT id, ref, kind, feature, channel, author, type, phase, status, at, seq, title, body, pointer, link FROM docs
    ${page.length ? `WHERE ${page.join(' AND ')}` : ''} ORDER BY coalesce(at, '') DESC, id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...pageArgs, limit + 1);
  const total = db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM docs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT 1001)`).get(...args).n;
  const results = rows.slice(0, limit).map((row) => ({
    ref: row.ref, kind: row.kind, kindLabel: DOC_KINDS[row.kind] ?? row.kind, feature: row.feature, channel: row.channel, author: row.author, type: row.type, phase: row.phase,
    status: row.status, at: row.at, seq: row.seq, title: row.title, titleMarks: marksIn(row.title, list), snippet: snippet(row.body, list), source: row.pointer, link: row.link,
  }));
  return { query: input.query ?? '', terms: list, results, next: rows.length > limit ? cursorOf(rows[limit - 1]) : null, total: total > 1000 ? '1000+' : total,
    methods: methods.map(({ term, via }) => ({ term, via })) };
}

export async function search(root, input = {}, { sync = true } = {}) {
  const opened = await openIndex(root);
  if (opened.state !== 'ready') throw Object.assign(new WaxError(opened.state === 'unsupported' ? opened.error : `${opened.error ? `${opened.error} ` : ''}${nextStep(opened.state)}`, opened.state === 'unsupported' ? 501 : 409), { state: opened.state });
  const { db } = opened;
  try {
    const build = await builder(root, db);
    const synced = !sync || build?.live ? null : build ? await resumeInterrupted(root, db, build) : await syncIndex(root, db);
    const result = searchIndex(db, input);
    const damaged = db.prepare('SELECT coalesce(sum(bad), 0) AS n FROM sources').get().n + db.prepare("SELECT count(*) AS n FROM refs WHERE state <> 'ok'").get().n;
    const unfinished = build?.live ? 'building' : build && !synced ? 'interrupted' : null;
    return { ...result, index: { complete: !unfinished, synced: Boolean(synced), changed: synced?.changed ?? 0, syncedAt: db.prepare("SELECT value FROM meta WHERE key = 'synced_at'").get()?.value ?? null, damaged,
      note: unfinished ? nextStep(unfinished) : !sync ? '방금 바뀐 기록은 아직 반영되지 않았을 수 있습니다.' : null } };
  } finally { db.close(); }
}

export const searchSourceRoots = SOURCES.map((s) => s.dir.join('/'));
export { DOC_KINDS };
export const relativePath = (root, path) => relative(root, path).split(sep).join('/');
