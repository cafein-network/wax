import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { t } from '../../web/messages-catalog.mjs';
import { WaxError } from '../workflow.mjs';
import { validTree } from '../freshness.mjs';

export const STUCK_CHECK = ['warn', 'stop', 'off'];
export const REPEAT_LIMITS = { tail: 2000, max: 2000, pollMs: 5000 };

export function stuckCheckMode(value = process.env.WAX_STUCK_CHECK) {
  if (value === undefined || value === null || value === '') return 'warn';
  if (!STUCK_CHECK.includes(value)) throw new WaxError(t('errors.pmLoop.stuckCheck'));
  return value;
}

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMP_PATTERNS = [
  /(?:\/private)?\/var\/folders\/[^/\s'"]+\/[^/\s'"]+\/T\/[^/\s'"]+/g,
  /[A-Za-z]:\\Users\\[^\\\s'"]+\\AppData\\Local\\Temp\\[^\\\s'"]+/gi,
  /(?<![\w.-])\/tmp\/[^/\s'"]+/g,
];

const VOLATILE = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\w:])/g, '<time>'],
  [/(?<![\w:.])\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\w:])/g, '<time>'],
  [/(?<![\w.])1\d{12}(?![\w.])/g, '<time>'],
  [/((?:<project>|<tmp>)[^\s'"():]*):\d+(?::\d+)?/g, '$1:<pos>'],
  [/\b(duration(?:_ms|Ms)?|elapsed(?:_ms|Ms)?)(["']?\s*[:=]?\s*)\d+(?:\.\d+)?/g, '$1$2<duration>'],
  [/(?<![\w.])\d+(?:\.\d+)?\s?(?:ns|[µμu]s|ms|s|secs?|seconds?|milliseconds?|mins?|minutes?)(?!\w)/g, '<duration>'],
  [/\b(pid|PID)(\s*[:=]?\s*)\d+/g, '$1$2<pid>'],
  [/(?<![\w.])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?!\d)/g, '$1:<port>'],
];

export function normalizeTestOutput(output, { roots = [], tmp = [tmpdir()] } = {}) {
  let text = typeof output === 'string' ? output : '';
  const swap = (paths, token, segment) => {
    for (const path of [...new Set(paths.filter((item) => typeof item === 'string' && item.length > 1))].sort((a, b) => b.length - a.length)) {
      for (const form of new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])) {
        text = text.replace(new RegExp(`${escape(form)}${segment ? '(?:[\\\\/][^\\\\/\\s\'"]+)?' : ''}`, 'g'), token);
      }
    }
  };
  swap(roots, '<project>', false);
  swap(tmp, '<tmp>', true);
  for (const pattern of TEMP_PATTERNS) text = text.replace(pattern, '<tmp>');
  for (const [pattern, to] of VOLATILE) text = text.replace(pattern, to);
  return text.slice(-REPEAT_LIMITS.tail);
}

export function treeKey(tree) {
  if (!tree || tree.unknown !== undefined || !validTree(tree)) return null;
  return [tree.head, Object.entries(tree.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))];
}

export function testRepeatKey(proof, options = {}) {
  if (proof?.kind !== 'test' || proof.exitCode === 0) return null;
  const tree = treeKey(proof.tree);
  if (!tree) return null;
  const command = Array.isArray(proof.command) ? proof.command.map(String) : [];
  return sha([command, proof.exitCode ?? null, Boolean(proof.timedOut), tree, normalizeTestOutput(proof.output, options)]);
}

export const commandText = (proof) => (Array.isArray(proof.command) ? proof.command.join(' ') : '').slice(0, 300);

export function failedTestRepeats(proofs = [], { author, since = 0, ...options } = {}) {
  const groups = new Map();
  for (const item of Array.isArray(proofs) ? proofs : []) {
    if (item?.kind !== 'test' || item.author !== author || !(Date.parse(item.at) >= since)) continue;
    const key = testRepeatKey(item, options);
    if (!key) continue;
    const group = groups.get(key) ?? { kind: 'test', key, command: commandText(item), exitCode: item.exitCode ?? null, count: 0, proofIds: [] };
    group.count += 1;
    group.proofIds.push(String(item.id));
    groups.set(key, group);
  }
  return groups;
}

function requestContent({ tool, method, details = {}, item = null }) {
  if (tool === 'claude') return details.input ?? null;
  if (tool === 'codex') {
    if (method === 'item/fileChange/requestApproval') return item?.changes ?? null;
    if (details.networkApprovalContext) return { network: details.networkApprovalContext };
    return { command: details.command ?? item?.command ?? null, cwd: details.cwd ?? item?.cwd ?? null };
  }
  const call = details.toolCall ?? {};
  return { title: call.title ?? null, input: call.rawInput ?? call.input ?? null };
}
export const approvalRepeatKey = (request) => sha([request?.tool ?? null, request?.action ?? null, requestContent(request ?? {})]);

export function createRepeatCounter() {
  const counts = new Map();
  return { add(key) { const n = Math.min((counts.get(key) ?? 0) + 1, REPEAT_LIMITS.max); counts.set(key, n); return n; } };
}

export function createStuckWatch({ mode, threshold, author, since, roots = [], read, pollMs = REPEAT_LIMITS.pollMs, now = () => Date.now(), onWarn = () => {}, onStuck = () => {} }) {
  let last = -Infinity, running = null, done = false;
  const told = new Set();
  async function check() {
    const proofs = await read();
    for (const group of failedTestRepeats(proofs, { author, since, roots }).values()) {
      if (done || group.count < threshold || told.has(group.key)) continue;
      told.add(group.key);
      if (mode === 'stop') { done = true; await onStuck(group); }
      else await onWarn(group);
    }
  }
  return {
    poke() {
      if (mode === 'off' || done || running || now() - last < pollMs) return;
      last = now();
      running = check().catch(() => {}).finally(() => { running = null; });
    },
    idle: () => running ?? Promise.resolve(),
    async final() { if (mode !== 'warn' || done) return; await (running ?? Promise.resolve()); try { await check(); } catch {} },
  };
}

export function approvalRepeatNote(request, requests = [], threshold = 3) {
  if (!request?.repeatKey || !Number.isSafeInteger(request.repeat) || request.repeat < threshold) return null;
  const earlier = requests.filter((item) => item.id !== request.id && item.repeatKey === request.repeatKey && item.createdAt <= request.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return { threshold, previous: earlier ? { decision: earlier.decision ?? null, decidedBy: earlier.decidedBy ?? null, ...(earlier.allowKind ? { allowKind: earlier.allowKind } : {}), at: earlier.decidedAt ?? earlier.createdAt } : null };
}
