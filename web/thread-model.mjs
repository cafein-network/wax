import { t } from './messages-catalog.mjs';

export const THREAD_STATES = ['attention', 'active', 'done'];
export const STATE_LABELS = { attention: t('threadModel.answerNeeded'), active: t('threadModel.inProgress'), done: t('threadModel.done') };
const QUIET_MS = 24 * 60 * 60 * 1000;
const REQUEST_STATES = { queued: 'active', running: 'active', question: 'attention', blocked: 'attention', workflow: 'attention', paused: 'attention', completed: 'done' };
const PHASE_NAMES = { plan: t('threadModel.plan'), design: t('threadModel.design'), implement: t('threadModel.implement'), review: t('threadModel.review'), report: t('threadModel.report'), done: t('threadModel.done') };
const SM_PHASE_NAMES = { plan: t('threadModel.intakeAnalysis'), design: t('threadModel.impactCheck'), implement: t('threadModel.fix'), review: t('threadModel.regressionCheck'), report: t('threadModel.resolutionReport'), done: t('threadModel.done') };
export const phaseName = (phase, mode) => (mode === 'sm' ? SM_PHASE_NAMES : PHASE_NAMES)[phase] ?? phase;
const TASK_STATES = { open: 'active', accepted: 'active', blocked: 'attention', done: 'done', cancelled: 'done' };
const TOOLS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI', antigravity: 'Antigravity CLI', grok: 'Grok Build' };

const firstLine = (text = '') => String(text).split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? '';
const time = (value) => typeof value === 'number' ? new Date(value).toISOString() : value ?? null;
const pendingApproval = (approval, now) => approval.status === 'pending' && (!approval.expiresAt || approval.expiresAt > now);

export function conversationThreads(messages, { user, now = Date.now() } = {}) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const rootOf = (message) => {
    const seen = new Set([message.id]);
    let current = message;
    while (current.replyTo && byId.has(current.replyTo) && !seen.has(current.replyTo)) { seen.add(current.replyTo); current = byId.get(current.replyTo); }
    return current;
  };
  const groups = new Map();
  for (const message of messages) {
    const root = rootOf(message);
    if (!groups.has(root.id)) groups.set(root.id, []);
    groups.get(root.id).push(message);
  }
  const threads = [];
  for (const [rootId, items] of groups) {
    const root = byId.get(rootId);
    if (items.length < 2 && root.type !== 'question') continue;
    const last = items.at(-1);
    const others = [...new Set(items.map((item) => item.author).filter((author) => author !== user))];
    const waiting = last.type === 'question' && last.author !== user;
    const state = waiting ? 'attention' : last.type === 'decision' || now - Date.parse(last.at) > QUIET_MS ? 'done' : 'active';
    threads.push({
      key: `m:${rootId}`, kind: 'conversation', channel: root.channel, title: firstLine(root.body), owner: others[0] ?? root.author, state,
      startedAt: root.at, lastAt: last.at, preview: `${last.author}: ${firstLine(last.body)}`, items,
      replyTo: last.id, recipients: others,
    });
  }
  return threads;
}

export function requestThread(request, approvals = [], { now = Date.now() } = {}) {
  const linked = approvals.filter((approval) => request.approvals?.includes(approval.id) && pendingApproval(approval, now));
  return {
    key: `r:${request.id}`, kind: 'request', id: request.id, mode: request.mode, title: request.title, owner: request.agent ?? TOOLS[request.tool] ?? request.tool,
    state: linked.length ? 'attention' : REQUEST_STATES[request.status] ?? 'active', status: request.status, phase: request.phase,
    startedAt: request.createdAt, lastAt: request.updatedAt ?? request.createdAt, preview: request.detail ?? '', detail: request.detail ?? '',
    items: request.messages ?? [], approvals: linked,
  };
}

export function taskThread(task) {
  const last = task.updates?.at(-1);
  return {
    key: `t:${task.id}`, kind: 'task', id: task.id, channel: task.feature, title: firstLine(task.note), owner: task.to, phase: task.phase,
    state: TASK_STATES[task.status] ?? 'active', status: task.status, startedAt: task.at, lastAt: task.statusAt ?? task.at,
    preview: last ? `${last.author}: ${last.note ? firstLine(last.note) : last.status}` : firstLine(task.note),
    items: [{ author: task.by, text: task.note, at: task.at, status: 'open' }, ...(task.updates ?? []).map((update) => ({ author: update.author, text: `${update.warning ? `[경고] ${update.warning} / ` : ''}${update.note ?? ''}`, at: update.at, status: update.status, ...(update.warning ? { warning: update.warning } : {}) }))],
    recipients: [task.to],
  };
}

export function approvalThread(approval) {
  const subject = approval.details?.command ?? approval.details?.path ?? approval.action;
  return {
    key: `a:${approval.id}`, kind: 'approval', id: approval.id, title: t('threadModel.runApproval', TOOLS[approval.tool] ?? approval.tool), owner: TOOLS[approval.tool] ?? approval.tool,
    state: 'attention', startedAt: time(approval.createdAt), lastAt: time(approval.createdAt), preview: firstLine(typeof subject === 'string' ? subject : JSON.stringify(subject)),
    items: [], approvals: [approval],
  };
}

export function buildThreads({ messages = [], requests = [], tasks = [], approvals = [], user, now = Date.now() } = {}) {
  const linked = new Set(requests.flatMap((request) => request.approvals ?? []));
  const threads = [
    ...requests.map((request) => requestThread(request, approvals, { now })),
    ...tasks.map(taskThread),
    ...approvals.filter((approval) => pendingApproval(approval, now) && !linked.has(approval.id)).map(approvalThread),
    ...conversationThreads(messages, { user, now }),
  ].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)) || a.key.localeCompare(b.key));
  const counts = Object.fromEntries(THREAD_STATES.map((state) => [state, threads.filter((thread) => thread.state === state).length]));
  return { threads, counts };
}

export function foldProgress(items, isProgress) {
  const out = [];
  let run = [];
  const flush = () => { if (run.length >= 2) out.push({ folded: run }); else out.push(...run.map((item) => ({ item }))); run = []; };
  items.forEach((item, index) => {
    if (index < items.length - 1 && isProgress(item)) { run.push(item); return; }
    flush(); out.push({ item });
  });
  flush();
  return out;
}

export const isChannelProgress = (message) => message.kind !== 'human' && (message.type ?? 'message') === 'message';
export const isRequestProgress = (message) => message.role === 'assistant';

export const DATE_GROUPS = ['today', 'yesterday', 'week', 'month', 'older'];
export const DATE_LABELS = { today: t('threadModel.today'), yesterday: t('threadModel.yesterday'), week: t('threadModel.last7Days'), month: t('threadModel.last30Days'), older: t('threadModel.previous') };
const DAY_MS = 24 * 60 * 60 * 1000;

export function dateGroup(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'older';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (at >= start) return 'today';
  if (at >= start - DAY_MS) return 'yesterday';
  if (at >= start - 7 * DAY_MS) return 'week';
  if (at >= start - 30 * DAY_MS) return 'month';
  return 'older';
}

export function matchThread(thread, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [thread.title, thread.preview, thread.owner, thread.id, thread.channel, thread.phase].filter(Boolean).join('\n').toLowerCase();
  return words.every((word) => text.includes(word));
}

export function arrangeThreads(threads, { state = 'attention', query = '', pinned = new Set(), now = Date.now() } = {}) {
  const searching = Boolean(String(query).trim());
  const matched = threads.filter((thread) => matchThread(thread, query));
  const top = matched.filter((thread) => pinned.has(thread.key));
  const rest = matched.filter((thread) => !pinned.has(thread.key) && (searching || thread.state === state));
  const groups = DATE_GROUPS.map((key) => ({ key, label: DATE_LABELS[key], threads: rest.filter((thread) => dateGroup(thread.lastAt, now) === key) })).filter((group) => group.threads.length);
  return { pinned: top, groups };
}

export function phaseSections(messages = [], { proofs = [], done = false, start = 'plan' } = {}) {
  const sections = [];
  for (const message of messages) {
    const phase = message.phase ?? sections.at(-1)?.phase ?? start;
    if (sections.at(-1)?.phase !== phase) sections.push({ phase, items: [], proofs: [] });
    sections.at(-1).items.push(message);
  }
  sections.forEach((section, index) => {
    section.startAt = section.items[0]?.at ?? null; section.endAt = section.items.at(-1)?.at ?? null;
    section.current = index === sections.length - 1 && !done;
  });
  for (const proof of [...proofs].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const same = sections.filter((section) => section.phase === proof.phase);
    const target = same.find((section) => String(section.endAt) >= String(proof.at)) ?? same.at(-1);
    target?.proofs.push(proof);
  }
  return sections;
}

export function proofSummary(proofs = []) {
  const tests = proofs.filter((proof) => proof.kind === 'test');
  return { tests: tests.length, passed: tests.filter((proof) => proof.exitCode === 0 && !proof.timedOut).length, commits: proofs.filter((proof) => proof.kind === 'git').length };
}
