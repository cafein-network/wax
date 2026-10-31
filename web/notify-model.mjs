export const PHASE_ORDER = ['plan', 'design', 'implement', 'review', 'report', 'done'];
export const REPLAY_SLACK_MS = 2000;
const SEEN_LIMIT = 1000;

export function createNoticeModel({ user, offset = 0, now = () => Date.now() } = {}) {
  const seen = new Set(), phases = new Map();
  let settling = true, openedAt = -Infinity, generation = 0, pending = 0;
  const serverNow = () => now() + offset;
  const remember = (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
    return true;
  };
  const emit = (notice, hidden) => {
    if (!remember(notice.key) || settling || !hidden) return null;
    pending++;
    return notice;
  };
  const isPending = (request) => request?.status === 'pending' && !(Number(request.expiresAt) <= serverNow());
  return {
    get pending() { return pending; },
    get settling() { return settling; },
    connected() { settling = true; openedAt = serverNow(); return ++generation; },
    baseline({ approvals = [], features = [] } = {}, at = generation) {
      if (at !== generation) return false;
      for (const request of approvals) if (isPending(request)) remember(`a:${request.id}`);
      for (const feature of features) phases.set(feature.id, feature.phase);
      settling = false;
      return true;
    },
    message({ channel, message } = {}, hidden) {
      if (!message?.id || message.type !== 'question' || message.kind === 'human' || message.author === user) return null;
      const key = `m:${message.id}`;
      if (Date.parse(message.at) < openedAt - REPLAY_SLACK_MS) { remember(key); return null; }
      return emit({ key, kind: 'question', channel, id: message.id, author: message.author, body: String(message.body ?? '') }, hidden);
    },
    approvals(requests = [], hidden) {
      return requests.filter(isPending).map((request) => emit({ key: `a:${request.id}`, kind: 'approval', id: request.id, tool: request.tool, action: request.action, details: request.details }, hidden)).filter(Boolean);
    },
    features(features = [], hidden) {
      const out = [];
      for (const feature of features) {
        const before = phases.get(feature.id);
        phases.set(feature.id, feature.phase);
        if (!PHASE_ORDER.includes(before) || PHASE_ORDER.indexOf(feature.phase) <= PHASE_ORDER.indexOf(before)) continue;
        const notice = emit({ key: `p:${feature.id}:${before}:${feature.updatedAt}`, kind: 'phase', feature: feature.id, title: String(feature.title ?? ''), phase: before, next: feature.phase }, hidden);
        if (notice) out.push(notice);
      }
      return out;
    },
    proposal({ proposal } = {}, hidden) {
      if (!proposal?.id) return null;
      const key = `pr:${proposal.id}`;
      if (Date.parse(proposal.at) < openedAt - REPLAY_SLACK_MS) { remember(key); return null; }
      return emit({ key, kind: 'proposal', id: proposal.id, trigger: proposal.trigger, name: String(proposal.name ?? ''), body: String(proposal.text ?? '') }, hidden);
    },
    triggerNotice(notice = {}, hidden) {
      if (!notice?.id) return null;
      const key = `tn:${notice.id}`;
      if (Date.parse(notice.at) < openedAt - REPLAY_SLACK_MS) { remember(key); return null; }
      return emit({ key, kind: 'trigger', id: notice.id, trigger: notice.trigger, name: String(notice.name ?? ''), body: String(notice.text ?? '') }, hidden);
    },
    pm({ goal, suggestion } = {}, hidden) {
      if (!suggestion?.id) return null;
      const key = `pm:${suggestion.id}`;
      if (Date.parse(suggestion.at) < openedAt - REPLAY_SLACK_MS) { remember(key); return null; }
      return emit({ key, kind: 'pm', id: suggestion.id, goal: String(goal ?? ''), suggestion: String(suggestion.kind ?? ''), feature: String(suggestion.feature ?? ''), body: String(suggestion.text ?? '') }, hidden);
    },
    viewed() { pending = 0; },
  };
}

export function noticeUrl(notice, { requestId } = {}) {
  if (notice.kind === 'question') return `/?channel=${encodeURIComponent(notice.channel)}#${notice.id}`;
  if (notice.kind === 'approval') return `/?thread=${encodeURIComponent(requestId ? `r:${requestId}` : `a:${notice.id}`)}`;
  if (notice.kind === 'proposal') return `/start#${notice.id}`;
  if (notice.kind === 'trigger') return '/manage#triggers-heading';
  if (notice.kind === 'pm') return /^goal-[a-f0-9]{8}$/.test(notice.goal) ? `/manage#${notice.goal}` : '/manage#pm-loop-heading';
  return `/manage?feature=${encodeURIComponent(notice.feature)}`;
}

export const titleWithCount = (title, count) => (count > 0 ? `(${count}) ` : '') + String(title).replace(/^\(\d+\) /, '');
