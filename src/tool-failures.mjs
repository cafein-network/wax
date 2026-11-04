import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AGENT_TOOLS } from './agent-tools.mjs';

export const FAILURE_SHAPES = ['config', 'quota', 'permission', 'transient'];
export const FAILURE_STREAMS = ['error', 'stderr', 'result'];
const PHASE_NAMES = ['plan', 'design', 'implement', 'review', 'report'];
export const FAILURE_LIMITS = { fileBytes: 32 * 1024, rules: 50, contains: 10, text: 300, regex: 300, input: 12_000 };
export const DEFAULT_FAILURE_DIR = fileURLToPath(new URL('../tool-failures/', import.meta.url));
const TOOL_IDS = AGENT_TOOLS.map((tool) => tool.id);
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,3})?$/;
const HIDDEN = /[\p{Cc}\p{Cf}](?<![\n\t])/u;

class Invalid extends Error {}
const bad = (where, why) => { throw new Invalid(`${where}: ${why}`); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, allowed, required, where) {
  if (!isObject(value)) bad(where, 'not an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(where, `unknown key ${JSON.stringify(key.slice(0, 40))}`);
  for (const key of required) if (!(key in value)) bad(where, `missing ${key}`);
}
function shortText(value, where, max = FAILURE_LIMITS.text) {
  if (typeof value !== 'string' || !value.length) bad(where, 'not text');
  if (value.length > max) bad(where, `longer than ${max}`);
  if (HIDDEN.test(value)) bad(where, 'hidden characters');
  return value;
}
function compile(source, where) {
  shortText(source, where, FAILURE_LIMITS.regex);
  try { return new RegExp(source, 'iu'); } catch (error) { return bad(where, `does not compile (${error.message.slice(0, 80)})`); }
}

export function validateFailureRules(value, { tool } = {}) {
  try {
    only(value, ['schema', 'tool', 'version', 'rules'], ['schema', 'tool', 'version', 'rules'], 'file');
    if (value.schema !== 1) bad('schema', 'must be 1');
    if (!TOOL_IDS.includes(value.tool)) bad('tool', `not one of ${TOOL_IDS.join('|')}`);
    if (tool && value.tool !== tool) bad('tool', `does not match the file name (${tool})`);
    if (typeof value.version !== 'string' || !VERSION.test(value.version)) bad('version', 'not YYYY.MM.DD[.n]');
    if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > FAILURE_LIMITS.rules) bad('rules', `1-${FAILURE_LIMITS.rules} rules`);
    const seen = new Set();
    const rules = value.rules.map((rule, index) => {
      const where = `rules[${index}]`;
      only(rule, ['id', 'shape', 'match', 'until', 'phases'], ['id', 'shape', 'match'], where);
      if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) bad(`${where}.id`, 'lowercase letters, digits and -');
      if (seen.has(rule.id)) bad(`${where}.id`, 'duplicate');
      seen.add(rule.id);
      if (!FAILURE_SHAPES.includes(rule.shape)) bad(`${where}.shape`, `not one of ${FAILURE_SHAPES.join('|')}`);
      only(rule.match, ['stream', 'contains', 'regex'], [], `${where}.match`);
      if (rule.match.stream !== undefined && !FAILURE_STREAMS.includes(rule.match.stream)) bad(`${where}.match.stream`, `not one of ${FAILURE_STREAMS.join('|')}`);
      if (rule.match.contains === undefined && rule.match.regex === undefined) bad(`${where}.match`, 'needs contains or regex');
      let contains = [];
      if (rule.match.contains !== undefined) {
        if (!Array.isArray(rule.match.contains) || !rule.match.contains.length || rule.match.contains.length > FAILURE_LIMITS.contains) bad(`${where}.match.contains`, `1-${FAILURE_LIMITS.contains} texts`);
        contains = rule.match.contains.map((item, n) => shortText(item, `${where}.match.contains[${n}]`).toLowerCase());
      }
      const regex = rule.match.regex === undefined ? null : compile(rule.match.regex, `${where}.match.regex`);
      let until = null;
      if (rule.until !== undefined) {
        only(rule.until, ['regex'], ['regex'], `${where}.until`);
        if (rule.shape !== 'quota') bad(`${where}.until`, 'only for quota');
        until = compile(rule.until.regex, `${where}.until.regex`);
        if (new RegExp(`${rule.until.regex}|`, 'u').exec('').length < 2) bad(`${where}.until.regex`, 'needs a capture group for the time');
      }
      let phases = null;
      if (rule.phases !== undefined) {
        if (rule.shape !== 'permission') bad(`${where}.phases`, 'only for permission');
        if (!Array.isArray(rule.phases) || !rule.phases.length || !rule.phases.every((phase) => PHASE_NAMES.includes(phase)) || new Set(rule.phases).size !== rule.phases.length) bad(`${where}.phases`, `distinct phases from ${PHASE_NAMES.join('|')}`);
        phases = [...rule.phases];
      }
      return { id: rule.id, shape: rule.shape, stream: rule.match.stream ?? null, contains, regex, until, phases };
    });
    return { ok: true, rules: { tool: value.tool, version: value.version, rules } };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.message };
    throw error;
  }
}

const cache = new Map();
export function loadFailureRules({ dir = DEFAULT_FAILURE_DIR, fresh = false } = {}) {
  if (!fresh && cache.has(dir)) return cache.get(dir);
  const job = (async () => {
    const byTool = new Map(), issues = [];
    for (const tool of TOOL_IDS) {
      const file = join(dir, `${tool}.json`);
      let info;
      try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; issues.push({ tool, file, reason: error.message }); continue; }
      if (info.isSymbolicLink() || !info.isFile()) { issues.push({ tool, file, reason: 'not a regular file' }); continue; }
      if (info.size > FAILURE_LIMITS.fileBytes) { issues.push({ tool, file, reason: `larger than ${FAILURE_LIMITS.fileBytes} bytes` }); continue; }
      let value;
      try { value = JSON.parse(await readFile(file, 'utf8')); } catch { issues.push({ tool, file, reason: 'not JSON' }); continue; }
      const checked = validateFailureRules(value, { tool });
      if (checked.ok) byTool.set(tool, checked.rules); else issues.push({ tool, file, reason: checked.reason });
    }
    return { byTool, issues };
  })();
  cache.set(dir, job);
  job.catch(() => cache.delete(dir));
  return job;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseResetTime(text) {
  const value = String(text ?? '').trim();
  const named = value.match(/^([A-Za-z]{3})[A-Za-z]* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}),? (\d{1,2}):(\d{2}) ?([AP]M)$/i);
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase());
    let hour = Number(named[4]) % 12;
    if (named[6].toUpperCase() === 'PM') hour += 12;
    if (month < 0 || Number(named[4]) > 12 || Number(named[5]) > 59) return null;
    const ms = new Date(Number(named[3]), month, Number(named[2]), hour, Number(named[5])).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; }
  return null;
}

const tail = (text) => String(text ?? '').slice(-FAILURE_LIMITS.input);
const MAX_UNTIL_MS = 60 * 24 * 60 * 60_000;

export function classifyFailure(tool, output = {}, { rules, now = Date.now() } = {}) {
  const set = rules?.byTool?.get(tool);
  if (!set) return null;
  const streams = Object.fromEntries(FAILURE_STREAMS.map((name) => [name, tail(output?.[name])]));
  for (const rule of set.rules) {
    const text = rule.stream ? streams[rule.stream] : FAILURE_STREAMS.map((name) => streams[name]).join('\n');
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!rule.contains.every((item) => lower.includes(item))) continue;
    const hit = rule.regex ? rule.regex.exec(text) : null;
    if (rule.regex && !hit) continue;
    let until = null;
    if (rule.until) {
      const found = rule.until.exec(text)?.[1];
      const ms = found ? parseResetTime(found) : null;
      if (ms && ms > now && ms - now <= MAX_UNTIL_MS) until = new Date(ms).toISOString();
    }
    const at = hit ? hit.index : rule.contains.length ? lower.indexOf(rule.contains[0]) : 0;
    const excerpt = text.slice(Math.max(0, at - 80), at + 220).replace(/\s+/g, ' ').trim();
    return { tool, shape: rule.shape, rule: rule.id, version: set.version, ...(until ? { until } : {}), ...(rule.phases ? { phases: rule.phases } : {}), excerpt };
  }
  return null;
}
