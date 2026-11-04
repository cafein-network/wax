import { constants, lstat, open, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { excludedPath, realTarget } from './goal-allow.mjs';

export const PREVIEW_LIMITS = { fileBytes: 256 * 1024, lines: 5000, outputLines: 400, lineChars: 400, files: 20, context: 3, maxEdits: 2000 };
const CLAUDE_WRITES = ['Write', 'Edit', 'MultiEdit'];
const CLAUDE_UNSUPPORTED = ['NotebookEdit'];
const ACTIVE = ['pending', 'decided', 'dispatching'];
const HIDDEN = /[\0\p{Cc}]/u;
const inside = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
const shown = (root, path) => relative(root, path).split(sep).join('/').slice(0, 300) || '.';


const splitLines = (text) => { const lines = text === '' ? [] : text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };

export function lineDiff(before, after, { maxEdits = PREVIEW_LIMITS.maxEdits } = {}) {
  const a = Array.isArray(before) ? before : splitLines(before), b = Array.isArray(after) ? after : splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  const middle = myers(midA, midB, maxEdits) ?? [...midA.map((line) => ['-', line]), ...midB.map((line) => ['+', line])];
  return [...a.slice(0, head).map((line) => [' ', line]), ...middle, ...a.slice(a.length - tail).map((line) => [' ', line])];
}

function myers(a, b, maxEdits) {
  const n = a.length, m = b.length, max = n + m;
  if (!n) return b.map((line) => ['+', line]);
  if (!m) return a.map((line) => ['-', line]);
  const offset = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, maxEdits) && !found; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return null;
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d], at = (k) => snapshot[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push([' ', a[x - 1]]); x--; y--; }
    if (d > 0) { if (x === prevX) ops.push(['+', b[y - 1]]); else ops.push(['-', a[x - 1]]); }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

export function hunks(ops, { context = PREVIEW_LIMITS.context } = {}) {
  const added = ops.filter(([type]) => type === '+').length, removed = ops.filter(([type]) => type === '-').length;
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([type], index) => { if (type !== ' ') for (let i = Math.max(0, index - context); i <= Math.min(ops.length - 1, index + context); i++) keep[i] = true; });
  const lines = [];
  let oldLine = 1, newLine = 1;
  for (let i = 0; i < ops.length;) {
    if (!keep[i]) { if (ops[i][0] !== '+') oldLine++; if (ops[i][0] !== '-') newLine++; i++; continue; }
    let end = i;
    while (end < ops.length && keep[end]) end++;
    const part = ops.slice(i, end);
    const oldCount = part.filter(([type]) => type !== '+').length, newCount = part.filter(([type]) => type !== '-').length;
    lines.push(['@', `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`]);
    for (const op of part) { lines.push(op); if (op[0] !== '+') oldLine++; if (op[0] !== '-') newLine++; }
    i = end;
  }
  return { added, removed, lines };
}

function capped(lines, budget) {
  const take = lines.slice(0, Math.max(0, budget.left));
  budget.left -= take.length;
  return { lines: take.map(([type, text]) => [type, clip(text)]), omitted: lines.length - take.length };
}
const clip = (text) => {
  const line = String(text).replace(/\r$/, '');
  return line.length > PREVIEW_LIMITS.lineChars ? `${line.slice(0, PREVIEW_LIMITS.lineChars)}…` : line;
};

export function parseUnified(text, { kind } = {}) {
  const raw = splitLines(String(text).replace(/\n$/, ''));
  if (kind === 'add' && !raw.some((line) => line.startsWith('@@'))) return { added: raw.length, removed: 0, lines: raw.map((line) => ['+', line]) };
  if (kind === 'delete' && !raw.some((line) => line.startsWith('@@'))) return { added: 0, removed: raw.length, lines: raw.map((line) => ['-', line]) };
  let added = 0, removed = 0;
  const lines = raw.map((line) => {
    if (/^(---|\+\+\+) /.test(line) || /^(diff |index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line) || line.startsWith('@@')) return ['@', line];
    if (line.startsWith('+')) { added++; return ['+', line.slice(1)]; }
    if (line.startsWith('-')) { removed++; return ['-', line.slice(1)]; }
    if (line.startsWith('\\')) return ['@', line];
    return [' ', line.startsWith(' ') ? line.slice(1) : line];
  });
  return { added, removed, lines };
}


export function previewShape(request) {
  if (!request || typeof request !== 'object' || !request.details || typeof request.details !== 'object') return null;
  const details = request.details;
  if (request.tool === 'claude') {
    const name = typeof details.tool_name === 'string' ? details.tool_name : typeof details.tool === 'string' ? details.tool : null;
    const input = details.input;
    if (!CLAUDE_WRITES.includes(name) && !CLAUDE_UNSUPPORTED.includes(name)) return null;
    const base = typeof details.cwd === 'string' ? details.cwd : null;
    const path = input && typeof input === 'object' && !Array.isArray(input) ? (input.file_path ?? input.notebook_path) : undefined;
    if (CLAUDE_UNSUPPORTED.includes(name)) return { kind: 'claude', files: [{ path: typeof path === 'string' ? path : null, op: 'unsupported' }], base };
    if (typeof path !== 'string') return { kind: 'claude', files: [{ path: null, op: 'invalid' }], base };
    if (name === 'Write') return { kind: 'claude', base, files: [typeof input.content === 'string' ? { path, op: 'write', content: input.content } : { path, op: 'invalid' }] };
    const edits = name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : null;
    const valid = edits?.length && edits.length <= 100 && edits.every((edit) => edit && typeof edit.old_string === 'string' && typeof edit.new_string === 'string');
    return { kind: 'claude', base, files: [valid ? { path, op: 'edit', edits: edits.map((edit) => ({ old: edit.old_string, new: edit.new_string, all: edit.replace_all === true })) } : { path, op: 'invalid' }] };
  }
  if (request.tool === 'codex') {
    const changes = details.item?.changes;
    if (!changes || typeof changes !== 'object') return null;
    const list = Array.isArray(changes) ? changes : Object.entries(changes).map(([path, change]) => ({ ...(change && typeof change === 'object' ? change : {}), path }));
    const files = list.slice(0, PREVIEW_LIMITS.files).map((change) => {
      const kind = typeof change?.kind === 'string' ? change.kind : change?.kind?.type ?? change?.type;
      const diff = [change?.diff, change?.unified_diff, change?.content].find((value) => typeof value === 'string');
      const move = change?.kind?.move_path ?? change?.move_path;
      return typeof change?.path === 'string' && typeof diff === 'string'
        ? { path: change.path, op: 'patch', kind, diff, ...(typeof move === 'string' ? { move } : {}) } : { path: typeof change?.path === 'string' ? change.path : null, op: 'invalid' };
    });
    return { kind: 'codex', base: typeof details.cwd === 'string' ? details.cwd : null, files, more: Math.max(0, list.length - files.length) };
  }
  return null;
}


export async function previewTarget(root, path, base) {
  if (typeof path !== 'string' || !path || HIDDEN.test(path) || path.length > 4096) return { reason: 'invalid' };
  const start = typeof base === 'string' && inside(root, resolve(base)) ? resolve(base) : root;
  const lexical = resolve(start, path);
  if (!inside(root, lexical) || lexical === root) return { lexical, reason: 'outside' };
  if (excludedPath(relative(root, lexical))) return { lexical, reason: 'sensitive' };
  const real = await realTarget(lexical);
  if (!real || !inside(root, real) || real === root) return { lexical, reason: 'symlink' };
  if (excludedPath(relative(root, real))) return { lexical, reason: 'sensitive' };
  return { lexical, real };
}

export async function readCurrent(real) {
  let info;
  try { info = await lstat(real, { bigint: true }); }
  catch (error) { return error.code === 'ENOENT' ? { missing: true } : { reason: 'unreadable' }; }
  if (!info.isFile()) return { reason: 'notFile' };
  if (info.size > BigInt(PREVIEW_LIMITS.fileBytes)) return { reason: 'tooLarge' };
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || await realpath(real) !== real) return { reason: 'unreadable' };
    const buffer = Buffer.alloc(PREVIEW_LIMITS.fileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PREVIEW_LIMITS.fileBytes) return { reason: 'tooLarge' };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { reason: 'binary' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') }; }
    catch { return { reason: 'binary' }; }
  } catch { return { reason: 'unreadable' }; }
  finally { await handle?.close().catch(() => {}); }
}

export function applyEdits(text, edits) {
  let current = text;
  for (const [index, edit] of edits.entries()) {
    if (edit.old === '') {
      if (current !== '' && current !== null) return { reason: 'emptyOld', edit: index + 1 };
      current = edit.new; continue;
    }
    if (current === null) return { reason: 'missing' };
    const first = current.indexOf(edit.old);
    if (first < 0) return { reason: 'notFound', edit: index + 1 };
    if (!edit.all && current.indexOf(edit.old, first + 1) >= 0) {
      let count = 0;
      for (let at = current.indexOf(edit.old); at >= 0; at = current.indexOf(edit.old, at + edit.old.length)) count++;
      return { reason: 'ambiguous', edit: index + 1, count };
    }
    current = edit.all ? current.split(edit.old).join(edit.new) : current.slice(0, first) + edit.new + current.slice(first + edit.old.length);
  }
  return { text: current };
}


function diffFile(path, before, after, state, budget) {
  if (after.includes('\0')) return { path, none: 'binary' };
  if (after.length > PREVIEW_LIMITS.fileBytes) return { path, none: 'tooLarge' };
  const a = splitLines(before ?? ''), b = splitLines(after);
  if (a.length > PREVIEW_LIMITS.lines || b.length > PREVIEW_LIMITS.lines) return { path, none: 'tooLarge' };
  const { added, removed, lines } = hunks(lineDiff(a, b));
  if (before && after && before.endsWith('\n') !== after.endsWith('\n')) lines.push(['@', after.endsWith('\n') ? '\\ (newline added at end of file)' : '\\ No newline at end of file']);
  return { path, state, added, removed, ...capped(lines, budget) };
}

async function claudeFile(root, file, base, budget) {
  if (file.op === 'unsupported') return { path: file.path ? shownPath(root, file.path, base) : null, none: 'unsupported' };
  if (file.op === 'invalid') return { path: null, none: 'invalid' };
  const target = await previewTarget(root, file.path, base);
  const path = target.lexical ? shown(root, target.lexical) : null;
  if (target.reason) return { path: target.reason === 'outside' ? file.path.slice(0, 300) : path, none: target.reason };
  if (file.op === 'write' && (file.content.includes('\0') || file.content.length > PREVIEW_LIMITS.fileBytes)) return { path, none: file.content.includes('\0') ? 'binary' : 'tooLarge' };
  const current = await readCurrent(target.real);
  if (current.reason) return { path, none: current.reason };
  const before = current.missing ? null : current.text;
  if (file.op === 'write') return diffFile(path, before, file.content, before === null ? 'new' : 'modify', budget);
  const applied = applyEdits(before, file.edits);
  if (applied.reason) return { path, none: applied.reason, ...(applied.edit ? { edit: applied.edit } : {}), ...(applied.count ? { count: applied.count } : {}) };
  return diffFile(path, before, applied.text, before === null ? 'new' : 'modify', budget);
}
const shownPath = (root, path, base) => {
  const lexical = resolve(typeof base === 'string' ? base : root, path);
  return inside(root, lexical) ? shown(root, lexical) : path.slice(0, 300);
};

async function codexFile(root, file, base, budget) {
  if (file.op === 'invalid') return { path: file.path?.slice(0, 300) ?? null, none: 'invalid' };
  const target = await previewTarget(root, file.path, base);
  const path = target.lexical ? shown(root, target.lexical) : null;
  if (target.reason) return { path: target.reason === 'outside' ? file.path.slice(0, 300) : path, none: target.reason };
  if (file.diff.includes('\0')) return { path, none: 'binary' };
  if (file.diff.length > PREVIEW_LIMITS.fileBytes) return { path, none: 'tooLarge' };
  const state = file.kind === 'add' ? 'new' : file.kind === 'delete' ? 'delete' : 'patch';
  const { added, removed, lines } = parseUnified(file.diff, { kind: file.kind });
  return { path, state, added, removed, ...(file.move ? { move: String(file.move).slice(0, 300) } : {}), ...capped(lines, budget) };
}

export async function approvalPreview(root, request, { now = Date.now } = {}) {
  const shape = previewShape(request);
  if (!shape) return null;
  let project;
  try { project = await realpath(root); } catch { return null; }
  if (request.project && request.project !== project) return null;
  const budget = { left: PREVIEW_LIMITS.outputLines };
  const files = [];
  for (const file of shape.files) files.push(await (shape.kind === 'claude' ? claudeFile : codexFile)(project, file, shape.base, budget));
  return { computedAt: now(), files, ...(shape.more ? { more: shape.more } : {}) };
}

export function createPreviewCache({ limit = 100, now = Date.now } = {}) {
  const cache = new Map();
  async function signature(root, request) {
    const shape = previewShape(request);
    if (!shape || shape.kind !== 'claude') return `${request.fingerprint}`;
    const parts = [];
    for (const file of shape.files) {
      const target = file.path ? await previewTarget(root, file.path, shape.base).catch(() => ({})) : {};
      let stat = 'none';
      if (target.real) { try { const info = await lstat(target.real, { bigint: true }); stat = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'); } catch { stat = 'missing'; } }
      parts.push(`${target.real ?? target.reason}:${stat}`);
    }
    return `${request.fingerprint}|${parts.join('|')}`;
  }
  return {
    async get(root, request) {
      if (!ACTIVE.includes(request?.status)) return null;
      let project;
      try { project = await realpath(root); } catch { return null; }
      const key = await signature(project, request);
      const hit = cache.get(request.id);
      if (hit?.key === key) return hit.value;
      const value = await approvalPreview(project, request, { now });
      cache.delete(request.id);
      if (cache.size >= limit) cache.delete(cache.keys().next().value);
      cache.set(request.id, { key, value });
      return value;
    },
    size: () => cache.size,
  };
}
