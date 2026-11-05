
export class JsonLineError extends SyntaxError {
  constructor(message, line) { super(`${message} (line ${line})`); this.line = line; }
}

export const pointerPart = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
export const pointerOf = (parts) => parts.map((part) => `/${pointerPart(part)}`).join('');

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const SPACE = /[ \t\n\r]*/y;

export function parseJsonLines(text, { maxDepth = 200, pointerDepth = 8, maxPointers = 200_000 } = {}) {
  if (typeof text !== 'string') throw new JsonLineError('JSON text must be a string', 1);
  const lines = new Map();
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0, line = 1;
  let counted = at;
  const lineHere = () => {
    for (; counted < at; counted++) if (text.charCodeAt(counted) === 10) line++;
    return line;
  };
  const fail = (message) => { throw new JsonLineError(message, lineHere()); };
  const space = () => { SPACE.lastIndex = at; SPACE.exec(text); at = SPACE.lastIndex; };
  const expect = (char) => { if (text[at] !== char) fail(`expected ${JSON.stringify(char)}`); at++; };

  function string() {
    const start = at;
    at++;
    for (;;) {
      const code = text.charCodeAt(at);
      if (Number.isNaN(code)) fail('unterminated string');
      if (code === 34) break;
      if (code < 0x20) fail('control character in string');
      at += code === 92 ? 2 : 1;
    }
    at++;
    try { return JSON.parse(text.slice(start, at)); } catch { at = start; return fail('bad string escape'); }
  }

  function value(parts, depth) {
    space();
    if (parts.length <= pointerDepth && lines.size < maxPointers) lines.set(pointerOf(parts), lineHere());
    const char = text[at];
    if (char === '{' || char === '[') {
      if (depth >= maxDepth) fail('JSON is nested too deeply');
      at++;
      const out = char === '{' ? {} : [];
      space();
      const close = char === '{' ? '}' : ']';
      if (text[at] === close) { at++; return out; }
      for (let index = 0; ; index++) {
        if (char === '{') {
          space();
          if (text[at] !== '"') fail('expected a property name');
          const key = string();
          space();
          expect(':');
          Object.defineProperty(out, key, { value: value([...parts, key], depth + 1), enumerable: true, writable: true, configurable: true });
        } else out.push(value([...parts, index], depth + 1));
        space();
        if (text[at] === ',') { at++; continue; }
        if (text[at] === close) { at++; return out; }
        fail(`expected "," or ${JSON.stringify(close)}`);
      }
    }
    if (char === '"') return string();
    if (text.startsWith('true', at)) { at += 4; return true; }
    if (text.startsWith('false', at)) { at += 5; return false; }
    if (text.startsWith('null', at)) { at += 4; return null; }
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(text);
    if (match) { at = NUMBER.lastIndex; return Number(match[0]); }
    return fail(at >= text.length ? 'unexpected end of JSON' : `unexpected ${JSON.stringify(char)}`);
  }

  const result = value([], 0);
  space();
  if (at < text.length) fail('unexpected text after JSON');
  const lineOf = (pointer) => {
    if (typeof pointer !== 'string' || (pointer && !pointer.startsWith('/'))) return null;
    if (lines.has(pointer)) return lines.get(pointer);
    if (!has(result, pointer)) return null;
    for (let cut = pointer.lastIndexOf('/'); cut >= 0; cut = pointer.lastIndexOf('/', cut - 1)) {
      const up = pointer.slice(0, cut);
      if (lines.has(up)) return lines.get(up);
      if (!cut) break;
    }
    return lines.get('') ?? null;
  };
  return { value: result, lines, lineOf };
}

function has(doc, pointer) {
  let node = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

export function rewriteJsonStrings(text, replace, { want = null, maxDepth = 200 } = {}) {
  if (typeof text !== 'string') throw new JsonLineError('JSON text must be a string', 1);
  const breaks = [];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) breaks.push(index);
  const lineAt = (offset) => { let low = 0, high = breaks.length; while (low < high) { const mid = (low + high) >> 1; if (breaks[mid] < offset) low = mid + 1; else high = mid; } return low + 1; };
  const pieces = [], ranges = new Map();
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0, copied = 0;
  const fail = (message) => { throw new JsonLineError(message, lineAt(at)); };
  const space = () => { SPACE.lastIndex = at; SPACE.exec(text); at = SPACE.lastIndex; };
  function string(parts, key) {
    const start = at;
    at++;
    for (;;) {
      const code = text.charCodeAt(at);
      if (Number.isNaN(code)) fail('unterminated string');
      if (code === 34) break;
      if (code < 0x20) fail('control character in string');
      at += code === 92 ? 2 : 1;
    }
    at++;
    let value;
    try { value = JSON.parse(text.slice(start, at)); } catch { at = start; fail('bad string escape'); }
    const next = replace(value, { parts, key, line: lineAt(start) });
    pieces.push(text.slice(copied, start), jsonString(typeof next === 'string' ? next : value));
    copied = at;
    return value;
  }
  function value(parts, depth, pointer) {
    space();
    const start = at;
    const char = text[at];
    if (char === '{' || char === '[') {
      if (depth >= maxDepth) fail('JSON is nested too deeply');
      at++;
      space();
      const close = char === '{' ? '}' : ']';
      if (text[at] === close) at++;
      else {
        for (let index = 0; ; index++) {
          if (char === '{') {
            space();
            if (text[at] !== '"') fail('expected a property name');
            const name = string(parts, true);
            space();
            if (text[at] !== ':') fail('expected ":"');
            at++;
            value([...parts, name], depth + 1, want ? `${pointer}/${pointerPart(name)}` : '');
          } else value([...parts, index], depth + 1, want ? `${pointer}/${index}` : '');
          space();
          if (text[at] === ',') { at++; continue; }
          if (text[at] === close) { at++; break; }
          fail(`expected "," or ${JSON.stringify(close)}`);
        }
      }
    } else if (char === '"') string(parts, false);
    else if (text.startsWith('true', at)) at += 4;
    else if (text.startsWith('false', at)) at += 5;
    else if (text.startsWith('null', at)) at += 4;
    else {
      NUMBER.lastIndex = at;
      if (!NUMBER.exec(text)) fail(at >= text.length ? 'unexpected end of JSON' : `unexpected ${JSON.stringify(char)}`);
      at = NUMBER.lastIndex;
    }
    if (want?.has(pointer)) ranges.set(pointer, [lineAt(start), lineAt(at - 1)]);
  }
  value([], 0, '');
  space();
  if (at < text.length) fail('unexpected text after JSON');
  pieces.push(text.slice(copied));
  return { text: pieces.join(''), ranges };
}

const unicodeEscape = (char) => char.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
export const escapeInvisible = (json) => json.replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu, unicodeEscape);
export const jsonString = (value) => escapeInvisible(JSON.stringify(String(value)));
