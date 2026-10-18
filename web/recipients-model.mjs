export const REACH = {
  now: { label: '바로 답함', title: '이 세션은 채널을 듣고 있어 부르면 곧 답합니다.' },
  later: { label: '다음 명령 때', title: '지금 듣고 있지 않습니다. 다음 wax 명령을 실행할 때 메시지를 확인합니다.' },
  away: { label: '자리 비움', title: '10분 넘게 활동이 없습니다. 돌아오면 메시지를 확인합니다.' },
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
  if (!to.length) return '받는 사람을 고르지 않았습니다. 기록은 남지만 AI 세션을 깨우지 않습니다. 답이 필요하면 받는 사람을 고르거나 @이름으로 부르세요.';
  const byName = new Map(options.map((option) => [option.author, option]));
  const groups = { now: [], later: [], away: [] };
  for (const name of to) groups[byName.get(name)?.reach ?? 'later'].push(name);
  return [
    groups.now.length ? `${groups.now.join(', ')}: 듣는 중이라 곧 답합니다.` : '',
    groups.later.length ? `${groups.later.join(', ')}: 다음 wax 명령 때 확인합니다.` : '',
    groups.away.length ? `${groups.away.join(', ')}: 자리 비움 — 돌아오면 확인합니다.` : '',
  ].filter(Boolean).join(' ');
}
