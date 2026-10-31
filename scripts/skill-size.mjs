import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { render } from './build-commands.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const BUDGET_FILE = join(root, 'scripts/skill-budget.json');
const HEADROOM = 0.03;
const EXTRA = { 'design': 600, 'review': 600 };
const TOTAL_HEADROOM = 0.02;
const TOTAL_EXTRA = 3600;

const bytes = (text) => Buffer.byteLength(text, 'utf8');
export function tokens(text) {
  let ascii = 0, other = 0;
  for (const char of text) char.charCodeAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4) + other;
}
const commandOf = (path) => path.split('/').at(-1) === 'SKILL.md' ? path.split('/').at(-2) : path.split('/').at(-1).replace(/\.(md|toml)$/, '');

export async function measure() {
  const files = [];
  for (const { path, sections } of render()) {
    if (path.endsWith('run.mjs')) continue;
    const text = (await readFile(join(root, path), 'utf8')).replace(/\r\n/g, '\n');
    files.push({ path, command: commandOf(path), bytes: bytes(text), tokens: tokens(text), sections: sections.map(([name, part]) => ({ name, bytes: bytes(part) })).sort((a, b) => b.bytes - a.bytes) });
  }
  return files;
}

export function sharedSections() {
  const groups = new Map();
  for (const { sections } of render()) {
    for (const [name, text] of sections) {
      if (name.startsWith('command:') || name.startsWith('host:')) continue;
      const key = `${name}\u0000${text}`;
      const group = groups.get(key) ?? { name, bytes: bytes(text), files: 0, lines: text.split('\n').filter(Boolean) };
      group.files++;
      groups.set(key, group);
    }
  }
  const variants = [...groups.values()];
  const lines = new Map();
  for (const { name, lines: parts, files } of variants) {
    for (const line of parts) {
      const key = `${name.split(':')[0]}\u0000${line}`;
      const entry = lines.get(key) ?? { section: name.split(':')[0], text: line, bytes: bytes(line), files: 0 };
      entry.files += files;
      lines.set(key, entry);
    }
  }
  return {
    sections: variants.map(({ name, bytes: size, files }) => ({ name, bytes: size, files, total: size * files })).sort((a, b) => b.total - a.total),
    paragraphs: [...lines.values()].map((entry) => ({ ...entry, total: entry.bytes * entry.files })).sort((a, b) => b.total - a.total),
  };
}

export async function readBudget() {
  return JSON.parse(await readFile(BUDGET_FILE, 'utf8'));
}

export function overBudget(files, budget) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const over = files.filter((file) => file.bytes > (budget.files[file.path] ?? 0)).map((file) => ({ ...file, budget: budget.files[file.path] ?? 0 }));
  return { files: over, total, totalBudget: budget.total, totalOver: total > budget.total };
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const pad = (text, width) => String(text).padStart(width);

export function formatReport(files, budget, limit = 15) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const out = [`Generated wax commands and skills: ${files.length} files, ${total} bytes (${kb(total)}), ~${files.reduce((s, f) => s + f.tokens, 0)} tokens${budget ? `; total budget ${budget.total}` : ''}`, '', '   bytes  ~tokens   budget  file  (largest sections)'];
  for (const file of [...files].sort((a, b) => b.bytes - a.bytes)) {
    const top = file.sections.slice(0, 3).map((s) => `${s.name} ${kb(s.bytes)}`).join(', ');
    out.push(`${pad(file.bytes, 8)} ${pad(file.tokens, 8)} ${pad(budget?.files[file.path] ?? '-', 8)}  ${file.path}  (${top})`);
  }
  const { sections, paragraphs } = sharedSections();
  out.push('', 'Shared sections (bytes per copy x files = bytes across all files):');
  for (const s of sections.slice(0, limit)) out.push(`${pad(s.bytes, 8)} x ${pad(s.files, 2)} = ${pad(s.total, 7)}  ${s.name}`);
  out.push('', `Largest shared paragraphs (first ${limit}):`);
  for (const p of paragraphs.slice(0, limit)) out.push(`${pad(p.bytes, 8)} x ${pad(p.files, 2)} = ${pad(p.total, 7)}  [${p.section}] ${p.text.slice(0, 70)}…`);
  return out.join('\n');
}

export function newBudget(files) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    _comment: [
      'Byte budgets for the generated wax commands and skills, checked by test/skill-size.test.mjs.',
      'Built as current size + 3% per file (+600 bytes for design and review) and current total + 2% + 3600 bytes.',
      'To raise them deliberately: trim first (npm run size:skills shows the largest sections), then run',
      'node scripts/skill-size.mjs --update-budget and explain the growth in the pull request.',
    ],
    total: Math.ceil(total * (1 + TOTAL_HEADROOM)) + TOTAL_EXTRA,
    files: Object.fromEntries(files.map((file) => [file.path, Math.ceil(file.bytes * (1 + HEADROOM)) + (EXTRA[file.command] ?? 0)])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await measure();
  if (process.argv.includes('--update-budget')) {
    await writeFile(BUDGET_FILE, `${JSON.stringify(newBudget(files), null, 2)}\n`);
    console.log(`Updated ${BUDGET_FILE}`);
  }
  let budget = null;
  try { budget = await readBudget(); } catch {   }
  console.log(formatReport(files, budget));
}
