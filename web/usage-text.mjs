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

export const dollars = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '0.00');

export function costTotalText(summary, say = t) {
  if (typeof summary?.costUsd !== 'number') return null;
  return summary.costUnknown ? say('usage.costTotalUnknown', dollars(summary.costUsd), summary.costUnknown) : say('usage.costTotal', dollars(summary.costUsd));
}

export function costLimitText(usage, limit, say = t) {
  const known = typeof usage?.costUsd === 'number', unknown = usage?.costUnknown ?? 0;
  const used = known || !unknown ? `$${dollars(known ? usage.costUsd : 0)}` : say('usage.costUnknownRuns', unknown);
  return [say('usage.costLimit', used, dollars(limit)), known && unknown ? say('usage.costUnknownRuns', unknown) : null, say('usage.costNote')].filter(Boolean).join(' · ');
}

export function usageLines(summary, say = t) {
  if (!summary?.runs) return [];
  const cost = costTotalText(summary, say);
  return [...(summary.tools ?? []).map((entry) => toolUsageText(entry, say)), ...(cost ? [cost] : []),
    ...(summary.unreported ? [say('usage.unreported', summary.unreported)] : []),
    ...(summary.missing ? [say('usage.missing', summary.missing)] : [])];
}
