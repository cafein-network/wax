export const WAITING_STATES = ['blocked', 'done'];
export const ASSIGN_WARNINGS = { notJoined: 'team.assignWarning.notJoined', ended: 'team.assignWarning.ended', away: 'team.assignWarning.away' };
export const HOST_STATE_LABELS = { working: 'host.state.working', blocked: 'host.state.blocked', done: 'host.state.done', idle: 'host.state.idle', unknown: 'host.state.unknown' };

export function waitingSessions(presence = [], user = null) {
  return presence
    .filter((entry) => entry?.host && WAITING_STATES.includes(entry.host.state) && !entry.host.ended && entry.kind !== 'human' && entry.author !== user)
    .map((entry) => ({
      author: entry.author, kind: entry.kind ?? 'other', state: entry.host.state, since: entry.host.at, feature: entry.feature ?? null,
      approval: entry.host.state === 'blocked' && entry.host.event === 'PermissionRequest', detail: entry.host.detail ?? null,
    }))
    .sort((a, b) => WAITING_STATES.indexOf(a.state) - WAITING_STATES.indexOf(b.state) || Date.parse(a.since) - Date.parse(b.since) || a.author.localeCompare(b.author));
}

export function seenByMessage(presence = [], recipients = []) {
  const done = new Set(presence.filter((entry) => entry?.host?.state === 'done').map((entry) => entry.author));
  return [...new Set(recipients)].filter((name) => done.has(name));
}
