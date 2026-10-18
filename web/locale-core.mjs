import { phrases, patterns } from './messages-en.mjs';

export const LANGUAGES = ['ko', 'en'];
export const STORAGE_KEY = 'wax.language';

export function pickLanguage({ search = '', saved = null, browser = [] } = {}) {
  const explicit = new URLSearchParams(search).get('lang');
  if (LANGUAGES.includes(explicit)) return explicit;
  if (LANGUAGES.includes(saved)) return saved;
  return [browser].flat().some((tag) => /^ko\b/i.test(tag ?? '')) ? 'ko' : 'en';
}

const HANGUL = /[가-힣]/;
const exact = new Map(Object.entries(phrases).map(([source, target]) => [source.trim(), target]));
const shape = (source) => source.trim().replace(/\{\w+\}/g, '{}');
const shapes = new Set(patterns.map(([source]) => shape(source)));
const compiled = patterns
  .map(([source, target]) => {
    const keys = [];
    const expression = source.trim().split(/(\{\w+\})/).map((part) => {
      if (/^\{\w+\}$/.test(part)) { keys.push(part.slice(1, -1)); return '(.+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { expression: new RegExp(`^${expression}$`, 's'), keys, target, weight: source.replace(/\{\w+\}/g, '').length };
  })
  .sort((a, b) => b.weight - a.weight);

const memo = new Map();
export function translate(value, depth = 0) {
  if (typeof value !== 'string' || depth > 6 || !HANGUL.test(value)) return value;
  if (depth === 0 && memo.has(value)) return memo.get(value);
  const source = value.trim();
  let result = exact.get(source);
  let loose;
  if (result === undefined) {
    for (const { expression, keys, target } of compiled) {
      const match = source.match(expression);
      if (!match) continue;
      let whole = true;
      const filled = target.replace(/\{(\w+)\}/g, (hole, key) => {
        if (!keys.includes(key)) return hole;
        const value = match[keys.indexOf(key) + 1], done = translate(value, depth + 1);
        if (HANGUL.test(done)) whole = false;
        return done;
      });
      if (whole) { result = filled; break; }
      loose ??= filled;
    }
  }
  if (result === undefined) {
    const korean = (text) => (text?.match(/[가-힣]/g) ?? []).length;
    const joined = pieces(source, depth);
    result = joined !== undefined && (loose === undefined || korean(joined) <= korean(loose)) ? joined : loose;
  }
  const out = result === undefined ? value : value.slice(0, value.indexOf(source)) + result + value.slice(value.indexOf(source) + source.length);
  if (depth === 0) { if (memo.size > 5000) memo.clear(); memo.set(value, out); }
  return out;
}

const changed = (before, after) => (after !== before ? after : undefined);
function pieces(source, depth) {
  const next = (text) => translate(text, depth + 1);
  for (const glue of [' · ', ' — ', ' → ', ' / ', ', ', ': ']) {
    if (!source.includes(glue)) continue;
    const parts = source.split(glue), done = parts.map(next);
    if (done.some((part, index) => part !== parts[index])) return done.join(glue);
  }
  const edge = source.match(/^([·•↳▶️✓]\s*)(.+)$/su) ?? source.match(/^([^가-힣]+?)\s(.*[가-힣].*)$/s);
  if (edge) { const rest = next(edge[2]); if (rest !== edge[2]) return `${edge[1]}${/\s$/.test(edge[1]) || /^[·•↳▶️✓]/u.test(edge[1]) ? '' : ' '}${rest}`; }
  const tail = source.match(/^(.*[가-힣].*?)\s([^가-힣]+)$/s);
  if (tail) { const head = next(tail[1]); if (head !== tail[1]) return `${head} ${tail[2]}`; }
  return changed(source, source.replace(/[<[][^<>[\]]*[가-힣][^<>[\]]*[>\]]/g, (token) => exact.get(token) ?? token));
}

export function covers(text) {
  const source = text.trim();
  return exact.has(source) || shapes.has(shape(source));
}
