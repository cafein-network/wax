import { t } from './messages-catalog.mjs';
export const REACH = {
  now: { label: t('recipientsModel.repliesRightAway'), title: t('recipientsModel.thisSessionIsListening') },
  later: { label: t('recipientsModel.onNextCommand'), title: t('recipientsModel.notListeningRightNow') },
  away: { label: t('recipientsModel.away'), title: t('recipientsModel.noActivityForOver') },
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mentions(body, name) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_.-])@${escape(name)}(?![\\p{L}\\p{N}_.-])`, 'u').test(String(body ?? ''));
}

const hears = (agent, channel) => agent.listening && (!agent.listeningFeatures || agent.listeningFeatures.includes(channel));
export const reachOf = (agent, channel) => hears(agent, channel) ? 'now' : agent.effectiveState === 'away' ? 'away' : 'later';

export function recipientOptions(presence, self, channel) {
  const rank = { now: 0, later: 1, away: 2 };
  return presence
    .filter((agent) => agent.kind !== 'human' && agent.author !== self)
    .map((agent) => ({ author: agent.author, kind: agent.kind, model: agent.model ?? null, peer: agent.peer ?? null, reach: reachOf(agent, channel) }))
    .sort((a, b) => rank[a.reach] - rank[b.reach] || a.author.localeCompare(b.author));
}

export const addressed = (message, options) => [...new Set([...(message.to ?? []), ...options.filter((option) => mentions(message.body, option.author)).map((option) => option.author)])];

export function deliveryHint(to, options) {
  if (!to.length) return t('recipientsModel.noRecipientSelectedThe');
  const byName = new Map(options.map((option) => [option.author, option]));
  const groups = { now: [], later: [], away: [] };
  for (const name of to) groups[byName.get(name)?.reach ?? 'later'].push(name);
  return [
    groups.now.length ? t('recipientsModel.listeningWillReplySoon', groups.now.join(', ')) : '',
    groups.later.length ? t('recipientsModel.willCheckAtThe', groups.later.join(', ')) : '',
    groups.away.length ? t('recipientsModel.awayWillCheckWhen', groups.away.join(', ')) : '',
  ].filter(Boolean).join(' ');
}
