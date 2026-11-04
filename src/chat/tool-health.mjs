import { t } from '../../web/messages-catalog.mjs';
import { join } from 'node:path';
import { AGENT_TOOLS, agentTool } from '../agent-tools.mjs';
import { classifyFailure, loadFailureRules } from '../tool-failures.mjs';
import { WaxError } from '../workflow.mjs';
import * as v from './validate.mjs';
import { chatDir } from './paths.mjs';
import { appendRecord, makeId, readRecords, readTail } from './store.mjs';

const HOUR = 60 * 60_000;
export const HEALTH_LIMITS = { fallbackMs: 24 * HOUR, records: 500, excerpt: 300 };
const TOOL_IDS = AGENT_TOOLS.map((tool) => tool.id);
const healthFile = async (root, create = false) => { const dir = await chatDir(root, null, { create }); return dir && join(dir, 'tool-health.jsonl'); };
const switchFile = async (root, create = false) => { const dir = await chatDir(root, null, { create }); return dir && join(dir, 'tool-disabled.jsonl'); };
const time = (iso) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? ms : 0; };
const label = (id) => { try { return agentTool(id).label; } catch { return String(id); } };

export async function readToolHealth(root) {
  const file = await healthFile(root);
  if (!file) return [];
  return (await readTail(file, { limit: HEALTH_LIMITS.records })).records.filter((item) => item?.record === 'tool-health');
}

function released(failure, later, now) {
  if (failure.until) { if (now >= time(failure.until)) return true; }
  else if (now - time(failure.at) >= HEALTH_LIMITS.fallbackMs) return true;
  return later.some((item) => item.tool === failure.tool && (item.kind === 'retry'
    || (item.kind === 'success' && (failure.shape !== 'permission' || !failure.phases?.length || failure.phases.includes(item.phase)))));
}

export function activeToolHealth(records = [], now = Date.now()) {
  const out = new Map();
  records.forEach((item, index) => {
    if (item?.kind !== 'failure' || !TOOL_IDS.includes(item.tool)) return;
    if (item.shape === 'transient') return;
    if (released(item, records.slice(index + 1), now)) return;
    out.set(`${item.tool}:${item.shape}`, { tool: item.tool, shape: item.shape, rule: item.rule ?? null, version: item.version ?? null, until: item.until ?? null,
      phases: Array.isArray(item.phases) ? item.phases : null, at: item.at, excerpt: item.excerpt ?? '', source: item.source ?? null });
  });
  return [...out.values()];
}

export function healthFor(health = [], tool, phase = null) {
  return health.filter((item) => item.tool === tool && item.shape !== 'transient' && (item.shape !== 'permission' || !item.phases?.length || (phase && item.phases.includes(phase))))
    .sort((a, b) => (b.shape === 'disabled') - (a.shape === 'disabled') || time(b.at) - time(a.at))[0] ?? null;
}


export async function readToolSwitches(root) {
  const file = await switchFile(root);
  if (!file) return [];
  return (await readRecords(file)).records.filter((item) => item?.record === 'tool-disabled');
}

export function disabledTools(records = []) {
  const last = new Map();
  for (const item of records) if (TOOL_IDS.includes(item?.tool) && typeof item.disabled === 'boolean') last.set(item.tool, item);
  return [...last.values()].filter((item) => item.disabled)
    .map((item) => ({ tool: item.tool, shape: 'disabled', rule: null, version: null, until: null, phases: null, at: item.at, by: item.by ?? null, excerpt: '', source: 'human' }));
}

export async function setToolDisabled(root, tool, disabled, { author, now = Date.now() } = {}) {
  const who = v.author(author);
  if (!TOOL_IDS.includes(tool)) throw new WaxError(t('errors.toolHealth.unknownTool', String(tool).slice(0, 40)), 400);
  if (typeof disabled !== 'boolean') throw new WaxError(t('errors.toolHealth.disabledValue'), 400);
  const current = disabledTools(await readToolSwitches(root)).some((item) => item.tool === tool);
  if (current === disabled) return { tool, disabled, changed: false };
  const record = await appendRecord(await switchFile(root, true), (seq) => ({ schema: 1, record: 'tool-disabled', id: makeId('td', seq), seq, tool, disabled, by: who, at: new Date(now).toISOString() }));
  return { tool, disabled, changed: true, record: record.id };
}

const pad = (n) => String(n).padStart(2, '0');
export const localTime = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function healthText(entry) {
  if (!entry) return '';
  if (entry.shape === 'disabled') return t('toolHealth.disabledLine', label(entry.tool), entry.by ?? '-', entry.at ? localTime(entry.at) : '-');
  const shape = entry.shape === 'quota' ? t('toolHealth.shape.quota') : entry.shape === 'permission' ? t('toolHealth.shape.permission')
    : entry.shape === 'transient' ? t('toolHealth.shape.transient') : t('toolHealth.shape.config');
  const when = entry.until ? t('toolHealth.until', localTime(entry.until)) : t('toolHealth.releaseHint');
  const phases = entry.shape === 'permission' && entry.phases?.length ? t('toolHealth.phases', entry.phases.join(', ')) : '';
  return t('toolHealth.line', label(entry.tool), shape, `${phases}${when}`);
}

const clip = (text, limit) => { const all = Array.from(String(text ?? '')); return all.length > limit ? `${all.slice(0, limit - 1).join('')}…` : all.join(''); };
async function append(root, record, now) {
  return appendRecord(await healthFile(root, true), (seq) => ({ schema: 1, record: 'tool-health', id: makeId('th', seq), seq, ...record, at: new Date(now).toISOString() }));
}

export async function noteToolRun(root, { tool, phase = null, ok, error = null, source, goal = null, feature = null, run = null, now = Date.now(), rules } = {}) {
  if (!TOOL_IDS.includes(tool)) return null;
  if (ok) {
    const active = activeToolHealth(await readToolHealth(root), now).filter((item) => item.tool === tool);
    const frees = active.some((item) => item.shape !== 'permission' || !item.phases?.length || item.phases.includes(phase));
    if (frees) await append(root, { kind: 'success', tool, phase, source, goal, feature, run }, now);
    return null;
  }
  if (!error) return null;
  const output = error.toolOutput && typeof error.toolOutput === 'object' ? error.toolOutput : { error: error.message };
  const hit = classifyFailure(tool, output, { rules: rules ?? await loadFailureRules(), now });
  if (!hit) return null;
  await append(root, { kind: 'failure', tool, shape: hit.shape, rule: hit.rule, version: hit.version, ...(hit.until ? { until: hit.until } : {}), ...(hit.phases ? { phases: hit.phases } : {}),
    phase, source, goal, feature, run, excerpt: clip(hit.excerpt, HEALTH_LIMITS.excerpt) }, now);
  return { shape: hit.shape, rule: hit.rule, ...(hit.until ? { until: hit.until } : {}), ...(hit.phases ? { phases: hit.phases } : {}) };
}

export async function retryTool(root, tool, { author, now = Date.now() } = {}) {
  const who = v.author(author);
  if (!TOOL_IDS.includes(tool)) throw new WaxError(t('errors.toolHealth.unknownTool', String(tool).slice(0, 40)), 400);
  const active = activeToolHealth(await readToolHealth(root), now).filter((item) => item.tool === tool);
  if (!active.length) return { tool, released: 0 };
  const record = await append(root, { kind: 'retry', tool, by: who }, now);
  return { tool, released: active.length, record: record.id };
}

export async function toolHealthLines(root, { now = Date.now(), rules } = {}) {
  const loaded = rules ?? await loadFailureRules();
  let health = [];
  const unreadable = [];
  try { health = activeToolHealth(await readToolHealth(root), now); } catch (error) { unreadable.push(t('toolHealth.unreadable', error.message)); }
  try { health.push(...disabledTools(await readToolSwitches(root))); } catch (error) { unreadable.push(t('toolHealth.switchUnreadable', error.message)); }
  const lines = AGENT_TOOLS.map(({ id }) => {
    const entry = healthFor(health, id, null) ?? health.find((item) => item.tool === id) ?? null;
    return { tool: id, state: entry ? entry.shape : 'ok', ...(entry ? { until: entry.until, at: entry.at, rule: entry.rule } : {}), ...(entry?.shape === 'disabled' ? { by: entry.by } : {}),
      rules: loaded.byTool.get(id)?.rules.length ?? 0, line: entry ? healthText(entry) : t('toolHealth.ok', label(id)) };
  });
  return { tools: lines, issues: [...loaded.issues.map((item) => t('toolHealth.rulesIssue', item.tool, item.reason)), ...unreadable] };
}
