import { t } from './messages-catalog.mjs';

const PARTS = [['input', 'usage.input'], ['output', 'usage.output'], ['cacheRead', 'usage.cacheRead'], ['cacheWrite', 'usage.cacheWrite'], ['reasoning', 'usage.reasoning'], ['total', 'usage.total']];

export function toolUsageText(entry, say = t) {
  const tokens = entry?.tokens ?? {};
  const parts = PARTS.filter(([name]) => Number.isSafeInteger(tokens[name])).map(([name, id]) => say(id, tokens[name]));
  if (typeof entry?.costUsd === 'number') parts.push(say('usage.cost', entry.costUsd));
  if (Number.isSafeInteger(entry?.turns)) parts.push(say('usage.turns', entry.turns));
  parts.push(say('usage.runs', entry?.runs ?? 0));
  return `${entry?.label ?? entry?.tool ?? '-'} ${parts.join(' · ')}`;
}

export function usageLines(summary, say = t) {
  if (!summary?.runs) return [];
  return [...(summary.tools ?? []).map((entry) => toolUsageText(entry, say)),
    ...(summary.unreported ? [say('usage.unreported', summary.unreported)] : []),
    ...(summary.missing ? [say('usage.missing', summary.missing)] : [])];
}
