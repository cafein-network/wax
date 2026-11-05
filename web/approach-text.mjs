import { t } from './messages-catalog.mjs';

const RISK = { low: 'approach.risk.low', medium: 'approach.risk.medium', high: 'approach.risk.high' };

export function approachEstimate(item, say = t) {
  return say('approach.estimate', item?.cost ?? '-', say(RISK[item?.risk] ?? 'approach.risk.unknown'));
}

export function approachLine(summary, say = t, clean = (value) => value) {
  if (!summary) return null;
  if (summary.state === 'picked') {
    const { chosen } = summary;
    return [say('approach.chosen', clean(chosen.title)), clean(chosen.by), ...(chosen.reason ? [say('approach.reason', clean(chosen.reason))] : []),
      ...(chosen.via === 'cli' ? [say('approach.viaCli')] : []), ...(summary.again ? [say('approach.againPending')] : [])].join(' · ');
  }
  if (summary.state === 'single') return say('approach.skipped', clean(summary.reason));
  if (summary.state === 'waiting') return say('approach.waiting', summary.count, summary.round);
  if (summary.state === 'again') return say('approach.againPending');
  if (summary.state === 'missing') return say('approach.missing');
  return null;
}

export function approachOthersLine(summary, say = t, clean = (value) => value) {
  return summary?.state === 'picked' && summary.others?.length ? say('approach.others', summary.others.map((title) => clean(title)).join('; ')) : null;
}
