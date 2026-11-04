import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestSymlink } from './chat-helpers.mjs';
import { PREVIEW_LIMITS, applyEdits, approvalPreview, createPreviewCache, hunks, lineDiff, parseUnified, previewShape } from '../src/approval-preview.mjs';
import { createApproval } from '../src/approvals.mjs';
import { createChatServer } from '../src/chat/server.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wax-preview-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), outside = join(base, 'outside');
  for (const dir of [join(root, 'src'), join(root, '.git'), join(root, '.wax', 'chat'), outside]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, 'src', 'a.js'), 'one\ntwo\nthree\n');
  await writeFile(join(root, '.env'), 'SECRET=1\n');
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(root, '.wax', 'chat', 'general.jsonl'), '{}\n');
  await writeFile(join(outside, 'secret.txt'), 'outside secret\n');
  return { root, outside };
}
const claude = (root, tool_name, input, extra = {}) => ({ tool: 'claude', project: root, status: 'pending', fingerprint: 'f', details: { tool_name, input }, ...extra });
const only = async (root, request) => (await approvalPreview(root, request)).files[0];
const text = (file) => file.lines.map(([type, line]) => `${type}${line}`).join('\n');

test('line diff: identical, insert, delete, replace and a minimal edit script', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb'), [[' ', 'a'], [' ', 'b']]);
  assert.deepEqual(lineDiff('', 'x\ny'), [['+', 'x'], ['+', 'y']]);
  assert.deepEqual(lineDiff('x\ny', ''), [['-', 'x'], ['-', 'y']]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), [[' ', 'a'], ['-', 'b'], ['+', 'B'], [' ', 'c']]);
  const lcs = (a, b) => { const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0)); for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]); return d[a.length][b.length]; };
  let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    const make = () => Array.from({ length: Math.floor(random() * 12) }, () => 'abc'[Math.floor(random() * 3)]);
    const a = make(), b = make(), ops = lineDiff(a, b);
    assert.deepEqual(ops.filter(([type]) => type !== '+').map(([, line]) => line), a);
    assert.deepEqual(ops.filter(([type]) => type !== '-').map(([, line]) => line), b);
    assert.equal(ops.filter(([type]) => type !== ' ').length, a.length + b.length - 2 * lcs(a, b));
    const coarse = lineDiff(a, b, { maxEdits: 0 });
    assert.deepEqual(coarse.filter(([type]) => type !== '+').map(([, line]) => line), a);
    assert.deepEqual(coarse.filter(([type]) => type !== '-').map(([, line]) => line), b);
  }
});

test('hunks keep three context lines and count every added and removed line', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = before.map((line, i) => (i === 9 ? 'changed' : line));
  const result = hunks(lineDiff(before, after));
  assert.equal(result.added, 1); assert.equal(result.removed, 1);
  assert.deepEqual(result.lines.map(([type]) => type).join(''), '@   -+   ');
  assert.equal(result.lines[0][1], '@@ -7,7 +7,7 @@');
});

test('Write: a new file shows every line added; an overwrite is compared with the current file', async (t) => {
  const { root } = await fixture(t);
  const created = await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'new.js'), content: 'export const x = 1;\n' }));
  assert.equal(created.path, 'src/new.js'); assert.equal(created.state, 'new');
  assert.equal(created.added, 1); assert.equal(created.removed, 0);
  const overwrite = await only(root, claude(root, 'Write', { file_path: 'src/a.js', content: 'one\n2\nthree\n' }));
  assert.equal(overwrite.state, 'modify');
  assert.deepEqual([overwrite.added, overwrite.removed], [1, 1]);
  assert.match(text(overwrite), /-two\n\+2/);
});

test('Edit: found, not found, ambiguous, replace_all and creating with an empty old_string', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src', 'b.js'), 'x = 1\ny = 1\n');
  const path = join(root, 'src', 'a.js');
  const found = await only(root, claude(root, 'Edit', { file_path: path, old_string: 'two', new_string: 'TWO' }));
  assert.deepEqual([found.state, found.added, found.removed], ['modify', 1, 1]);
  assert.deepEqual(await only(root, claude(root, 'Edit', { file_path: path, old_string: 'four', new_string: '4' })), { path: 'src/a.js', none: 'notFound', edit: 1 });
  const ambiguous = await only(root, claude(root, 'Edit', { file_path: join(root, 'src', 'b.js'), old_string: '= 1', new_string: '= 2' }));
  assert.deepEqual(ambiguous, { path: 'src/b.js', none: 'ambiguous', edit: 1, count: 2 });
  const all = await only(root, claude(root, 'Edit', { file_path: join(root, 'src', 'b.js'), old_string: '= 1', new_string: '= 2', replace_all: true }));
  assert.deepEqual([all.added, all.removed], [2, 2]);
  assert.deepEqual(await only(root, claude(root, 'Edit', { file_path: join(root, 'src', 'gone.js'), old_string: 'a', new_string: 'b' })), { path: 'src/gone.js', none: 'missing' });
  const create = await only(root, claude(root, 'Edit', { file_path: join(root, 'src', 'gone.js'), old_string: '', new_string: 'fresh\n' }));
  assert.deepEqual([create.state, create.added], ['new', 1]);
  assert.deepEqual(applyEdits('abc', [{ old: '', new: 'x' }]), { reason: 'emptyOld', edit: 1 });
});

test('MultiEdit applies edits in order and names the edit that does not apply', async (t) => {
  const { root } = await fixture(t);
  const path = join(root, 'src', 'a.js');
  const ok = await only(root, claude(root, 'MultiEdit', { file_path: path, edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'ONE\ntwo', new_string: 'ONE\nTWO' }] }));
  assert.deepEqual([ok.added, ok.removed], [2, 2]);
  assert.match(text(ok), /\+ONE\n\+TWO/);
  assert.deepEqual(await only(root, claude(root, 'MultiEdit', { file_path: path, edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'one', new_string: 'x' }] })),
    { path: 'src/a.js', none: 'notFound', edit: 2 });
});

test('interactive hook records (details.tool, cwd) resolve relative paths from the request cwd inside the project', async (t) => {
  const { root } = await fixture(t);
  const hook = { tool: 'claude', project: root, status: 'pending', details: { cwd: join(root, 'src'), tool: 'Edit', input: { file_path: 'a.js', old_string: 'three', new_string: '3' } } };
  const file = await only(root, hook);
  assert.equal(file.path, 'src/a.js'); assert.equal(file.added, 1);
  const away = await only(root, { ...hook, details: { ...hook.details, cwd: '/', input: { file_path: 'src/a.js', old_string: 'three', new_string: '3' } } });
  assert.equal(away.path, 'src/a.js');
});

test('Codex file changes show the diff the request carries, without reading files', async (t) => {
  const { root } = await fixture(t);
  const request = { tool: 'codex', project: root, status: 'pending', details: { threadId: 't', cwd: root, item: { changes: [
    { path: join(root, 'src', 'a.js'), kind: { type: 'update', move_path: null }, diff: '--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n' },
    { path: 'src/new.md', kind: { type: 'add' }, diff: '# title\nbody\n' },
    { path: '.env', kind: { type: 'update' }, diff: '-SECRET=1\n+SECRET=2\n' },
  ] } } };
  const { files } = await approvalPreview(root, request);
  assert.deepEqual([files[0].path, files[0].state, files[0].added, files[0].removed], ['src/a.js', 'patch', 1, 1]);
  assert.deepEqual(files[0].lines.slice(0, 3).map(([type]) => type), ['@', '@', '@']);
  assert.deepEqual([files[1].state, files[1].added, files[1].lines], ['new', 2, [['+', '# title'], ['+', 'body']]]);
  assert.deepEqual(files[2], { path: '.env', none: 'sensitive' });
  const legacy = await approvalPreview(root, { tool: 'codex', project: root, status: 'pending', details: { cwd: root, item: { changes: { 'src/a.js': { type: 'delete', content: 'one\ntwo\n' } } } } });
  assert.deepEqual([legacy.files[0].state, legacy.files[0].removed], ['delete', 2]);
  assert.deepEqual(parseUnified('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file').lines.map(([type]) => type), ['@', '-', '+', '@']);
});

test('paths outside the project, symlink escapes, .env*, .git/ and .wax/chat/ are never read', async (t) => {
  const { root, outside } = await fixture(t);
  assert.deepEqual(await only(root, claude(root, 'Write', { file_path: join(outside, 'secret.txt'), content: 'x' })), { path: join(outside, 'secret.txt'), none: 'outside' });
  assert.deepEqual(await only(root, claude(root, 'Write', { file_path: '../outside/secret.txt', content: 'x' })), { path: '../outside/secret.txt', none: 'outside' });
  for (const [path, shown] of [['.env', '.env'], ['.env.local', '.env.local'], ['.git/config', '.git/config'], ['.wax/chat/general.jsonl', '.wax/chat/general.jsonl']]) {
    assert.deepEqual(await only(root, claude(root, 'Edit', { file_path: join(root, path), old_string: 'S', new_string: 'T' })), { path: shown, none: 'sensitive' }, path);
  }
  if (await createTestSymlink(t, join(outside, 'secret.txt'), join(root, 'src', 'link.txt'), 'file')) {
    assert.deepEqual(await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'link.txt'), content: 'x' })), { path: 'src/link.txt', none: 'symlink' });
  }
  if (await createTestSymlink(t, outside, join(root, 'src', 'out'), 'dir')) {
    assert.deepEqual(await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'out', 'secret.txt'), content: 'x' })), { path: 'src/out/secret.txt', none: 'symlink' });
  }
  if (await createTestSymlink(t, join(root, '.env'), join(root, 'src', 'env-link'), 'file')) {
    assert.deepEqual(await only(root, claude(root, 'Edit', { file_path: join(root, 'src', 'env-link'), old_string: 'S', new_string: 'T' })), { path: 'src/env-link', none: 'sensitive' });
  }
  assert.equal(await approvalPreview(root, claude(outside, 'Write', { file_path: 'src/a.js', content: 'x' })), null);
});

test('binary files, oversized files and directories are not previewed; long output is truncated with a count', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'src', 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  assert.equal((await only(root, claude(root, 'Edit', { file_path: join(root, 'src', 'image.bin'), old_string: 'P', new_string: 'Q' }))).none, 'binary');
  await writeFile(join(root, 'src', 'latin1.txt'), Buffer.from([0xff, 0xfe, 0x41]));
  assert.equal((await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'latin1.txt'), content: 'A' }))).none, 'binary');
  assert.equal((await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'x.bin'), content: 'a\0b' }))).none, 'binary');
  await writeFile(join(root, 'src', 'big.txt'), 'x'.repeat(PREVIEW_LIMITS.fileBytes + 1));
  assert.equal((await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'big.txt'), content: 'small' }))).none, 'tooLarge');
  assert.equal((await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'dir'), content: 'x'.repeat(PREVIEW_LIMITS.fileBytes + 1) }))).none, 'tooLarge');
  assert.equal((await only(root, claude(root, 'Write', { file_path: join(root, 'src'), content: 'x' }))).none, 'notFile');
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'y'.repeat(i === 0 ? 1000 : 1)}`).join('\n');
  const long = await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'long.txt'), content: lines }));
  assert.equal(long.added, 1000, 'counts cover the whole diff');
  assert.equal(long.lines.length, PREVIEW_LIMITS.outputLines);
  assert.equal(long.omitted, 1001 - PREVIEW_LIMITS.outputLines);
  assert.ok(long.lines.every(([, line]) => line.length <= PREVIEW_LIMITS.lineChars + 1));
  assert.ok(long.lines[1][1].endsWith('…'));
});

test('NotebookEdit and malformed writes get a short note; commands get no preview at all', async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await only(root, claude(root, 'NotebookEdit', { notebook_path: join(root, 'n.ipynb'), new_source: 'x' })), { path: 'n.ipynb', none: 'unsupported' });
  assert.deepEqual(await only(root, claude(root, 'Write', { file_path: join(root, 'a') })), { path: null, none: 'invalid' });
  assert.deepEqual(await only(root, claude(root, 'MultiEdit', { file_path: join(root, 'a'), edits: [] })), { path: null, none: 'invalid' });
  assert.equal(await approvalPreview(root, claude(root, 'Bash', { command: 'rm -rf /' })), null);
  assert.equal(previewShape({ tool: 'codex', details: { command: 'ls' } }), null);
  assert.equal(previewShape({ tool: 'gemini', details: { input: {} } }), null);
});

test('markup in a diff stays plain data (the card renders it with textContent)', async (t) => {
  const { root } = await fixture(t);
  const file = await only(root, claude(root, 'Write', { file_path: join(root, 'src', 'x.html'), content: '<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n' }));
  assert.deepEqual(file.lines.slice(1), [['+', '<img src=x onerror=alert(1)>'], ['+', '<script>alert(1)</script>']]);
});

test('the preview cache recomputes when the file changes and skips finished requests', async (t) => {
  const { root } = await fixture(t);
  let clock = 1000;
  const cache = createPreviewCache({ now: () => clock });
  const request = { ...claude(root, 'Edit', { file_path: join(root, 'src', 'a.js'), old_string: 'two', new_string: 'TWO' }), id: 'r1' };
  const first = await cache.get(root, request);
  clock = 2000;
  assert.equal(await cache.get(root, request), first, 'unchanged file reuses the preview');
  await writeFile(join(root, 'src', 'a.js'), 'one\nthree\n');
  const second = await cache.get(root, request);
  assert.equal(second.computedAt, 2000);
  assert.equal(second.files[0].none, 'notFound');
  assert.equal(await cache.get(root, { ...request, status: 'delivered' }), null);
});

test('GET /api/approvals attaches a preview to pending write requests only; the record file is unchanged', async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, '.wax'), { recursive: true });
  const write = await createApproval(root, { tool: 'claude', session: 's', callId: 'c1', action: 'Write', details: { tool_name: 'Write', input: { file_path: join(root, 'src', 'a.js'), content: 'one\n' } } });
  const bash = await createApproval(root, { tool: 'claude', session: 's', callId: 'c2', action: 'Bash', details: { tool_name: 'Bash', input: { command: 'ls' } } });
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const port = server.address().port;
  const body = await (await fetch(`http://127.0.0.1:${port}/api/approvals`)).json();
  const byId = new Map(body.requests.map((r) => [r.id, r]));
  const preview = byId.get(write.request.id).preview;
  assert.deepEqual([preview.files[0].path, preview.files[0].added, preview.files[0].removed], ['src/a.js', 0, 2]);
  assert.equal(byId.get(bash.request.id).preview, undefined);
  const { listApprovals } = await import('../src/approvals.mjs');
  assert.equal((await listApprovals(root)).requests.find((r) => r.id === write.request.id).preview, undefined, 'previews are not stored in approval records');
});
