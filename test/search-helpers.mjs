import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadSqlite } from '../src/sqlite.mjs';
import { buildIndex, openIndex, search } from '../src/search.mjs';
import { project } from './chat-helpers.mjs';
import { createFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';

export const sqlite = await loadSqlite();
export const skip = sqlite.error ? `node:sqlite with FTS5 unavailable: ${sqlite.error}` : false;
export const STORE = new URL('../src/chat/store.mjs', import.meta.url).href;
export const channelFile = (root, name) => join(root, '.wax', 'chat', 'channels', `${name}.jsonl`);
export const line = (seq, body, extra = {}) => `${JSON.stringify({ schema: 1, id: `m-${String(seq).padStart(6, '0')}-abc123`, seq, channel: 'general', author: 'codex-app', kind: 'codex', type: 'message', body, at: new Date(Date.UTC(2026, 9, 18, 0, 0, seq)).toISOString(), ...extra })}\n`;
export const refs = async (root, query, input = {}) => (await search(root, { query, limit: 50, ...input })).results.map((r) => r.ref);
export const count = async (root) => { const { db } = await openIndex(root); try { return db.prepare('SELECT count(*) AS n FROM docs').get().n; } finally { db.close(); } };
export const run = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [...(options.node ?? []), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
});


export const RECOVERY_RECORDS = 16_000;
export async function bigChannel(root, lines = RECOVERY_RECORDS) {
  await mkdir(join(root, '.wax', 'chat', 'channels'), { recursive: true });
  for (let c = 0; c < 4; c++) await writeFile(channelFile(root, `c-${c}`), Array.from({ length: lines / 4 }, (_, i) => line(i + 1, `개발 메모 ${c}-${i}`)).join(''));
}
export const ownerPid = async (root) => { for (let i = 0; i < 400; i++) { const owner = await readFile(join(root, '.wax', 'search', 'rebuild.lock', 'owner.json'), 'utf8').then(JSON.parse, () => null); if (owner?.pid) return owner.pid; await new Promise((done) => setTimeout(done, 10)); } throw new Error('no builder'); };

export async function korean(t) {
  const root = await project(t);
  await createFeature(root, { id: 'lookbook-upload', title: '룩북 업로드 화면', description: '디자인 인계를 확인하고 Claude Code로 구현합니다.' });
  await postMessage(root, 'lookbook-upload', { author: 'claude-app', kind: 'claude', body: '디자인 인계를 확인했습니다. docs/wax/design/handoff-v2.md 리뷰 부탁해요 (commit a1b2c3d9)' });
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '오류 원인: UI 버튼 리뷰 필요. 100% 확인, 이름_밑줄 "따옴표" 포함' });
  await postMessage(root, 'general', { author: 'codex-app', kind: 'codex', body: '계획과 다른 이야기입니다. reviewer handoff note' });
  await buildIndex(root);
  return root;
}
