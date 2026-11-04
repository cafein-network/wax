import { mkdtemp, mkdir, rm, stat, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readRecords } from '../src/chat/store.mjs';
import { buildIndex, openIndex, searchIndex, syncIndex } from '../src/search.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const BIN = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const sizes = (process.argv[2] ?? '10000,100000').split(',').map(Number);
const median = (values) => +[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
async function measure(fn, runs = 9) { const values = []; for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); if (i > 1) values.push(performance.now() - t); } return median(values); }
const run = (args) => new Promise((resolve) => {
  const started = performance.now(), child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; });
  child.on('close', (code) => resolve({ code, ms: performance.now() - started, out }));
});
const WORDS = ['개발', '작업을', '진행했습니다', '테스트', '결과와', '변경', '파일을', '확인하고', '다음', '단계에서', '동작을', '검증합니다', 'build', 'review', 'implement', 'tests', 'passed', 'Claude', 'Codex'];
const RARE = '디자인 인계를 확인했습니다. handoff-v2.md 리뷰 오류 a1b2c3d4e5 docs/wax/design';

async function makeProject(count) {
  const root = await mkdtemp(join(tmpdir(), 'wax 검색 bench-'));
  const channels = join(root, '.wax', 'chat', 'channels');
  await mkdir(channels, { recursive: true });
  const perChannel = Math.ceil(count / 20);
  for (let c = 0; c < 20; c++) {
    const name = c === 0 ? 'general' : `feature-${c}`;
    const lines = [];
    for (let i = 0; i < perChannel && c * perChannel + i < count; i++) {
      const n = c * perChannel + i, words = Array.from({ length: 12 }, (_, k) => WORDS[(n * 7 + k * 13) % WORDS.length]).join(' ');
      lines.push(JSON.stringify({ schema: 1, id: `m-${String(i + 1).padStart(6, '0')}-be${String(c).padStart(4, '0')}`, seq: i + 1, channel: name, author: `agent-${n % 5}`, kind: 'codex', type: 'message',
        body: n % 997 === 0 ? `${RARE} ${words}` : words, at: new Date(Date.UTC(2026, 9, 1 + (n % 17), 0, 0, n % 60)).toISOString() }));
    }
    await writeFile(join(channels, `${name}.jsonl`), `${lines.join('\n')}\n`);
  }
  return root;
}

async function jsonlSearch(root, term, filter = () => true) {
  const out = [];
  for (let c = 0; c < 20; c++) {
    const name = c === 0 ? 'general' : `feature-${c}`;
    for (const r of (await readRecords(join(root, '.wax', 'chat', 'channels', `${name}.jsonl`))).records) if (r.body.toLowerCase().includes(term.toLowerCase()) && filter(r, name)) out.push(`message:${name}:${r.id}`);
  }
  return out.sort();
}
async function allIds(db, input) {
  const ids = []; let cursor;
  do { const page = searchIndex(db, { ...input, limit: 50, cursor }); ids.push(...page.results.map((r) => r.ref)); cursor = page.next; } while (cursor);
  return ids.sort();
}

const report = { node: process.version, platform: `${process.platform}-${process.arch}`, note: 'Synthetic messages, warm file cache, medians (first 2 runs dropped). Index build and CLI timings include process start.', runs: [] };
for (const count of sizes) {
  const root = await makeProject(count);
  try {
    const jsonlBytes = (await Promise.all(Array.from({ length: 20 }, (_, c) => stat(join(root, '.wax', 'chat', 'channels', `${c === 0 ? 'general' : `feature-${c}`}.jsonl`))))).reduce((n, s) => n + s.size, 0);
    const build = await run(['--project', root, 'search', 'index', '--json']);
    assert.equal(build.code, 0, build.out);
    const built = JSON.parse(build.out);
    const db = (await openIndex(root)).db;
    const dbBytes = (await stat(join(root, '.wax', 'search', 'index.db'))).size + await stat(join(root, '.wax', 'search', 'index.db-wal')).then((s) => s.size, () => 0);
    const queries = [
      ['한글 흔한 2자 "개발"', { query: '개발' }, (r) => r.body.includes('개발')],
      ['한글 드문 2자 "인계"', { query: '인계' }, null],
      ['한글 3자+조사 "인계를"', { query: '인계를' }, null],
      ['영문 드문 "handoff"', { query: 'handoff' }, null],
      ['영문 흔한 "review"', { query: 'review' }, null],
      ['경로 "docs/wax/design"', { query: 'docs/wax/design' }, null],
      ['SHA 앞자리 "a1b2c3d"', { query: 'a1b2c3d' }, null],
      ['작업 필터 "인계" + feature-3', { query: '인계', feature: 'feature-3' }, (r, name) => name === 'feature-3'],
      ['기간 필터 "개발" 10/05', { query: '개발', from: '2026-10-05', to: '2026-10-05' }, (r) => r.at.startsWith('2026-10-05')],
    ];
    const rows = [];
    for (const [label, input, extra] of queries) {
      const term = input.query, filter = extra ?? (() => true);
      const expected = await jsonlSearch(root, term, (r, name) => filter(r, name) && (!input.feature || name === input.feature));
      assert.deepEqual(await allIds(db, input), expected, `${label}: same records as a full scan`);
      rows.push({ query: label, matches: expected.length,
        jsonlScanMs: await measure(() => jsonlSearch(root, term, (r, name) => filter(r, name) && (!input.feature || name === input.feature)), 5),
        indexFirstPageMs: await measure(() => searchIndex(db, { ...input, limit: 20 })) });
    }
    const noChangeSyncMs = await measure(() => syncIndex(root, db), 5);
    await appendFile(join(root, '.wax', 'chat', 'channels', 'general.jsonl'), Array.from({ length: 100 }, (_, i) => `${JSON.stringify({ schema: 1, id: `m-9${String(i).padStart(5, '0')}-append`, seq: 900000 + i, author: 'agent-x', kind: 'codex', type: 'message', body: '추가된 인계 기록', at: new Date().toISOString() })}\n`).join(''));
    const t = performance.now(); const appended = await syncIndex(root, db); const appendSyncMs = +(performance.now() - t).toFixed(2);
    db.close();
    const cli = []; for (let i = 0; i < 5; i++) cli.push((await run(['--project', root, 'search', '인계', '--json', '--limit', '20'])).ms);
    const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const apiMs = await measure(async () => { const res = await fetch(`http://127.0.0.1:${server.address().port}/api/search?q=${encodeURIComponent('인계')}&limit=20`); assert.equal(res.status, 200); await res.json(); }, 7);
    await server.shutdown();
    report.runs.push({ records: count, jsonlBytes, indexBytes: dbBytes, documents: built.documents, buildCliMs: Math.round(build.ms), buildSyncMs: built.ms,
      noChangeSyncMs, append100: { docs: appended.docs, ms: appendSyncMs }, cliSearchWithStartMs: median(cli), dashboardApiMs: apiMs, queries: rows,
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  } finally { await rm(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify(report, null, 2));
