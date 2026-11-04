import { t } from '../messages-catalog.mjs';

export const TYPE_LABELS = { message: t('office.sceneState.message'), opinion: t('office.sceneState.opinion'), question: t('office.sceneState.question'), answer: t('office.sceneState.answer'), decision: t('office.sceneState.decision') };

export function remember(state, author, item) {
  const list = state.recent.get(author) ?? [];
  list.push(item);
  list.sort((a, b) => a.at.localeCompare(b.at));
  state.recent.set(author, list.slice(-20));
}

export function addMessage(state, channel, message) {
  state.events.push({ channel, author: message.author, at: message.at, to: message.to ?? [] });
  remember(state, message.author, { channel, at: message.at, text: message.body, label: TYPE_LABELS[message.type] ?? t('office.sceneState.message') });
}

export function addNote(state, board, note) {
  const entry = state.boards.get(board) ?? { notes: [], reports: [] };
  if (!entry.notes.some((existing) => existing.id === note.id)) entry.notes.push(note);
  state.boards.set(board, entry);
  state.events.push({ channel: board, author: note.author, at: note.at });
  const previous = state.lastNoteAt.get(note.author);
  if (!previous || previous < note.at) state.lastNoteAt.set(note.author, note.at);
  remember(state, note.author, { channel: board, at: note.at, text: note.body, label: `보드 ${TYPE_LABELS[note.type]}` });
}

export function pickCurrentBoard(state, wanted = null) {
  if (wanted && state.features.some((feature) => feature.id === wanted)) { state.currentBoard = wanted; return; }
  let best = null, bestAt = '';
  for (const [id, board] of state.boards) {
    const at = board.notes.at(-1)?.at ?? '';
    if (at > bestAt) { best = id; bestAt = at; }
  }
  state.currentBoard = best ?? state.features[0]?.id ?? 'general';
}

export function addToOrder(state, authors) {
  for (const author of authors) if (!state.order.includes(author)) state.order.push(author);
}

export async function loadSnapshot(state, api, { wanted = null, now = null } = {}) {
  const [agents, features, channels, team] = await Promise.all([api('/api/presence'), api('/api/features'), api('/api/channels'), api('/api/team').catch(() => ({ pm: null }))]);
  Object.assign(state, { agents, features, channels, pm: team.pm?.author ?? null, tasks: team.tasks ?? [], events: [], recent: new Map(), lastNoteAt: new Map(), boards: new Map() });
  const at = now ?? Date.now();
  const active = agents.filter((a) => at - Date.parse(a.lastActive) <= state.config.awayAfterMs).map((a) => a.author);
  addToOrder(state, [...active, ...agents.map((a) => a.author)]);
  await Promise.all(channels.map(async (channel) => {
    if (channel.count) {
      const { messages } = await api(`/api/channels/${encodeURIComponent(channel.id)}/messages?limit=50`);
      messages.forEach((message) => addMessage(state, channel.id, message));
    }
    const board = await api(`/api/board/${encodeURIComponent(channel.id)}`);
    state.boards.set(channel.id, { notes: [], reports: board.reports });
    board.notes.forEach((note) => addNote(state, channel.id, note));
  }));
  pickCurrentBoard(state, wanted);
}

export function npcContext(state, now = Date.now()) {
  const live = state.features.filter((feature) => !feature.archivedAt);
  return {
    hour: new Date(now).getHours(),
    project: state.config.project,
    description: state.config.description ?? null,
    features: live.map((feature) => ({ id: feature.id, title: feature.title, phase: feature.phase })),
    labels: state.config.labels,
    active: live.filter((feature) => feature.phase !== 'done').length,
    working: state.scene.filter((item) => item.state === 'working').length,
    pm: state.pm,
    meetings: [...new Set(state.scene.filter((item) => item.room === 'meeting' && item.group).map((item) => (item.group === 'general' ? state.config.project : item.group)))],
    agents: state.scene.map((item) => ({ name: item.author, kind: item.kind, model: state.agents.find((a) => a.author === item.author)?.model ?? null, state: item.state, feature: item.feature })),
    tasks: state.tasks ?? [],
    limits: state.usage?.claude?.limits ?? [],
    tools: state.tools,
    toolNews: state.toolNews,
  };
}

export function teamSummary(state) {
  const ai = state.scene.filter((item) => item.kind !== 'human');
  const live = state.features.filter((feature) => !feature.archivedAt);
  const tasks = state.tasks ?? [];
  return {
    ai: ai.length, working: ai.filter((item) => item.state === 'working').length,
    active: live.filter((feature) => feature.phase !== 'done').length, done: live.filter((feature) => feature.phase === 'done').length,
    openTasks: tasks.filter((task) => ['open', 'accepted', 'blocked'].includes(task.status ?? 'open')).length, blocked: tasks.filter((task) => task.status === 'blocked').length,
    pm: state.pm,
  };
}
