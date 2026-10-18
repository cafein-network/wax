import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const HANGUL = /[가-힣]/;

export function jsStrings(code) {
  const out = [];
  let i = 0, prev = '';
  const regexAllowed = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(?:return|typeof|case|of|in|=>)$/.test(prev);
  function template() {
    let text = '', n = 0; i++;
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') { const e = code[i + 1]; text += e === 'n' ? '\n' : e; i += 2; continue; }
      if (code[i] === '$' && code[i + 1] === '{') {
        i += 2; let depth = 1; const start = i;
        while (i < code.length && depth) {
          const c = code[i];
          if (c === '`') { const inner = template(); if (HANGUL.test(inner)) out.push(inner); continue; }
          if (c === "'" || c === '"') { const s = quoted(c); if (HANGUL.test(s)) out.push(s); continue; }
          if (c === '{') depth++; else if (c === '}') depth--;
          i++;
        }
        void start; text += `{${n++}}`; continue;
      }
      text += code[i++];
    }
    i++; return text;
  }
  function quoted(q) {
    let text = ''; i++;
    while (i < code.length && code[i] !== q) { if (code[i] === '\\') { const e = code[i + 1]; text += e === 'n' ? '\n' : e; i += 2; continue; } text += code[i++]; }
    i++; return text;
  }
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2) + 2; if (i < 2) break; continue; }
    if (c === '/' && regexAllowed()) {
      i++; let cls = false;
      while (i < code.length && (code[i] !== '/' || cls)) { if (code[i] === '\\') i++; else if (code[i] === '[') cls = true; else if (code[i] === ']') cls = false; i++; }
      i++; while (/[a-z]/.test(code[i] ?? '')) i++; prev = 'x'; continue;
    }
    if (c === '`') { const s = template(); if (HANGUL.test(s)) out.push(s); prev = 'x'; continue; }
    if (c === "'" || c === '"') { const s = quoted(c); if (HANGUL.test(s)) out.push(s); prev = 'x'; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const word = code.slice(i).match(/^[\w$]+/);
    if (word) { prev = word[0]; i += word[0].length; continue; }
    prev = c; i++;
  }
  return out;
}

export function htmlStrings(html) {
  const out = [];
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/\s(?:title|aria-label|placeholder|alt|content)="([^"]*)"/g)) if (HANGUL.test(m[1])) out.push(decode(m[1]));
  for (const m of body.matchAll(/>([^<]+)</g)) { const text = decode(m[1]).replace(/\s+/g, ' ').trim(); if (HANGUL.test(text)) out.push(text); }
  return out;
}
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(mjs|html)$/.test(entry.name) && !/^messages-[a-z]+\.mjs$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function dashboardStrings() {
  const found = new Map();
  for (const file of await walk(join(root, 'web'))) {
    const source = await readFile(file, 'utf8');
    for (const text of file.endsWith('.html') ? htmlStrings(source) : jsStrings(source)) {
      const key = text.trim();
      if (!key || !HANGUL.test(key)) continue;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key).add(relative(root, file));
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = await dashboardStrings();
  let list = [...found.keys()];
  if (process.argv.includes('--missing')) {
    const { covers } = await import('../web/locale-core.mjs');
    list = list.filter((text) => !covers(text));
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(Object.fromEntries(list.map((k) => [k, [...found.get(k)]])), null, 1));
  else { for (const text of list) console.log(JSON.stringify(text), '\t', [...found.get(text)].join(',')); console.error(`${list.length} strings`); }
}
