import { homedir, userInfo } from 'node:os';
import { realpathSync } from 'node:fs';
import { SECRET_RULES } from './secrets.mjs';

export const OUTPUT_LIMITS = { tail: 2000, rpcMessage: 500 };
export const OUTPUT_OUTCOMES = new Set(['failed', 'timeout', 'stuck']);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const everywhere = (pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

const PEM = '-----(?:BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----';
const PEM_BEGIN = PEM.replace('(?:BEGIN|END)', 'BEGIN'), PEM_END = PEM.replace('(?:BEGIN|END)', 'END');
const PRIVATE_KEY_BLOCK = new RegExp(`${PEM_BEGIN}[\\s\\S]*?(?:${PEM_END}|$(?![\\s\\S]))`, 'g');
const PRIVATE_KEY_TAIL = new RegExp(`^[\\s\\S]*?${PEM_END}`);
const SECRET_PATTERNS = SECRET_RULES.filter((rule) => rule.id !== 'private-key').map((rule) => ({ id: rule.id, pattern: everywhere(rule.pattern) }));

const TOKEN_RULES = [
  [/(\bauthorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?(?!(?:bearer|basic|token|digest)\s)[^\s"',;<>]+/gi, (_, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}<token>`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 <token>'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"<>]+:[^/\s@'"<>]+@/gi, '$1<token>@'],
  [/([?&#;](?:[\w-]*token|api[_-]?key|key|secret|password|signature|sig|code)=)[^&\s"'#<>]+/gi, '$1<token>'],
  [/((?:token|key|secret)[\w-]*["']?\s*[:= ]\s*["']?)[A-Za-z0-9_-]{40,}/gi, '$1<token>'],
  [/((?:password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;<>]+/gi, '$1<token>'],
];
const FIELD_NAME = /(?:token|key|secret)[\w-]*$/i;
const FIELD_VALUE = /^[A-Za-z0-9_-]{40,}/;

export function scrubField(name, value, context = scrubContext()) {
  const done = scrubText(value, context);
  if (typeof name !== 'string' || !FIELD_NAME.test(name) || !FIELD_VALUE.test(done.text)) return done;
  return { text: done.text.replace(FIELD_VALUE, '<token>'), count: done.count + 1, rules: { ...done.rules, token: (done.rules.token ?? 0) + 1 } };
}
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-])/g;
const NAME_END = '(?![\\p{L}\\p{N}_])';

export function pathForms(path) {
  if (typeof path !== 'string') return [];
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (trimmed.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '').length < 2) return [];
  const slash = trimmed.replaceAll('\\', '/'), back = trimmed.replaceAll('/', '\\');
  return [...new Set([trimmed, slash, back, back.replaceAll('\\', '\\\\')])];
}

const real = (path) => { try { return realpathSync.native(path); } catch { return null; } };

export function scrubContext({ roots = [], homes, user, tokens = [], keepEmail = false, env = process.env } = {}) {
  const expand = (list) => list.filter((item) => typeof item === 'string' && item).flatMap((item) => [item, real(item)]).filter(Boolean);
  const homeList = homes ?? [(() => { try { return homedir(); } catch { return null; } })(), env.USERPROFILE, env.HOME];
  let name = user;
  if (name === undefined) { try { name = userInfo().username; } catch { name = null; } }
  return Object.freeze({
    projects: Object.freeze(expand(roots)), homes: Object.freeze(expand(homeList)),
    user: typeof name === 'string' && name.trim().length >= 2 ? name.trim() : null,
    tokens: Object.freeze(tokens.filter((item) => typeof item === 'string' && item.length >= 8)), keepEmail: Boolean(keepEmail),
  });
}

const compiled = new WeakMap();
function rulesFor(context) {
  if (compiled.has(context)) return compiled.get(context);
  const paths = [...context.projects.flatMap((path) => pathForms(path).map((form) => ({ form, id: 'project', to: '<project>' }))),
    ...context.homes.flatMap((path) => pathForms(path).map((form) => ({ form, id: 'home', to: '~' })))]
    .sort((a, b) => b.form.length - a.form.length)
    .filter((item, index, list) => list.findIndex((other) => other.form.toLowerCase() === item.form.toLowerCase()) === index)
    .map((item) => ({ ...item, pattern: new RegExp(`${escape(item.form)}${NAME_END}`, 'giu') }));
  const tokens = [...new Set(context.tokens)].sort((a, b) => b.length - a.length).map((token) => new RegExp(escape(token), 'g'));
  const user = context.user ? new RegExp(`(?<=[\\\\/])${escape(context.user)}(?![\\p{L}\\p{N}_-])`, 'giu') : null;
  const built = { paths, tokens, user };
  compiled.set(context, built);
  return built;
}

export function scrubText(text, context = scrubContext()) {
  const rules = {};
  let out = typeof text === 'string' ? text : String(text ?? ''), count = 0;
  const bump = (id) => { rules[id] = (rules[id] ?? 0) + 1; count += 1; };
  const swap = (pattern, id, to) => { out = out.replace(pattern, (...match) => { bump(id); return typeof to === 'function' ? to(...match) : to.replace(/\$(\d)/g, (_, n) => match[Number(n)] ?? ''); }); };
  const lines = (match) => '\n'.repeat((match.match(/\n/g) ?? []).length);
  swap(PRIVATE_KEY_BLOCK, 'secret:private-key', (match) => `<secret:private-key>${lines(match)}`);
  swap(PRIVATE_KEY_TAIL, 'secret:private-key', (match) => `<secret:private-key>${lines(match)}`);
  for (const { id, pattern } of SECRET_PATTERNS) swap(pattern, `secret:${id}`, `<secret:${id}>`);
  const built = rulesFor(context);
  for (const pattern of built.tokens) swap(pattern, 'token', '<token>');
  for (const [pattern, to] of TOKEN_RULES) swap(pattern, 'token', to);
  for (const { pattern, id, to } of built.paths) swap(pattern, id, to);
  if (built.user) swap(built.user, 'user', '<user>');
  if (!context.keepEmail) swap(EMAIL, 'email', '<email>');
  return { text: out, count, rules };
}

export function scrubValue(value, context = scrubContext()) {
  const rules = {};
  let count = 0;
  const walk = (item) => {
    if (typeof item === 'string') {
      const done = scrubText(item, context);
      count += done.count;
      for (const [id, n] of Object.entries(done.rules)) rules[id] = (rules[id] ?? 0) + n;
      return done.text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return { value: walk(value), count, rules };
}

export function tailChars(text, n) {
  if (text.length <= n) return text;
  const cut = text.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

export function outputTail(toolOutput, context = scrubContext(), { limit = OUTPUT_LIMITS.tail } = {}) {
  if (!toolOutput || typeof toolOutput !== 'object') return null;
  const text = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value));
  const picked = [['stderr', text(toolOutput.stderr)], ['result', text(toolOutput.result)], ['error', text(toolOutput.error)]].find(([, value]) => value.trim());
  const rpc = toolOutput.rpcError && typeof toolOutput.rpcError === 'object' ? toolOutput.rpcError : null;
  if (!picked && !rpc) return null;
  const [source, raw] = picked ?? ['none', ''];
  const done = scrubText(raw, context);
  const tail = tailChars(done.text, limit);
  let scrubbed = done.count, rpcError;
  if (rpc) {
    const message = scrubText(String(rpc.message ?? '').slice(0, OUTPUT_LIMITS.rpcMessage * 8), context);
    scrubbed += message.count;
    rpcError = { code: Number.isSafeInteger(rpc.code) ? rpc.code : null, message: message.text.slice(0, OUTPUT_LIMITS.rpcMessage) };
  }
  return { source, tail, bytes: Buffer.byteLength(raw, 'utf8'), kept: Buffer.byteLength(tail, 'utf8'), scrubbed, ...(rpcError ? { rpcError } : {}) };
}
