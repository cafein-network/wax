import { t } from './messages-catalog.mjs';
import { ChannelFeed, ChannelDrafts } from './channel-state.mjs';
import { api, clear, el, richText, storage, store, timeLabel, tr } from '/dom.mjs';
import { icon } from '/icons.mjs';
import { REACH, addressed, deliveryHint, recipientOptions } from '/recipients-model.mjs';
import { assignPersonas, faceThumb, keepFaces, loadFaceAssets, reservedFrom } from '/office/faces.mjs';
import { faceShot } from '/office/card.mjs';
import { STATE_LABELS, THREAD_STATES, arrangeThreads, buildThreads, foldProgress, isChannelProgress, phaseName, phaseSections, proofSummary } from '/thread-model.mjs';
import { applyCompletion, completionAt, completions } from '/composer-complete.mjs';
import { approvalCard } from '/approvals.mjs';
import { openEvents } from '/events.mjs';

const $ = (id) => document.getElementById(id);
const embedded = new URLSearchParams(location.search).get('embed') === '1';
let readingReady = false;
if (embedded) document.body.classList.add('messenger-chat');
function notifyRead() {
  if (embedded && readingReady && parent !== window && !document.hidden) parent.postMessage({ type: 'wax-chat-read', channel: current, ids: [...shown.keys()] }, location.origin);
}
let officeFaces = [];
if (embedded) window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || !(event.source === parent || (event.source && event.source !== window && event.source.parent === parent))) return;
  if (event.data?.type === 'wax-chat-visible') { $('timeline').scrollTop = $('timeline').scrollHeight; notifyRead(); }
  if (event.data?.type === 'wax-chat-faces' && Array.isArray(event.data.faces)) { officeFaces = event.data.faces.slice(0, 500); repaintAvatars(); }
});
if (embedded) document.addEventListener('visibilitychange', notifyRead);
if (embedded) document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') parent.postMessage({ type: 'wax-chat-close' }, location.origin);
});
const TYPE_LABELS = { message: t('app.message'), opinion: t('app.opinion'), question: t('app.question'), answer: t('app.answer'), decision: t('app.decision') };
let config, channels = [], current = new URLSearchParams(location.search).get('channel');
const feed = new ChannelFeed(), drafts = new ChannelDrafts(), sending = new Set();
const shown = new Map();
let presence = [], options = [], selected = new Set(), replyTo = null, typeBeforeReply = null;

function renderRecipients() {
  const unavailable = [...selected].filter((name) => !options.some((option) => option.author === name));
  for (const name of unavailable) selected.delete(name);
  if (unavailable.length) { $('delivery').textContent = t('app.sessionCantBeSelected', unavailable.join(', ')); $('delivery').hidden = false; }
  const list = clear($('recipients'));
  if (!options.length) { list.append(el('span', { class: 'meta', text: t('app.noAiSessionsHave') })); return; }
  list.append(...options.map((option) => el('button', {
    type: 'button', class: `recipient reach-${option.reach}`, 'aria-pressed': String(selected.has(option.author)),
    title: `${option.kind}${option.model ? ` · ${option.model}` : ''} — ${REACH[option.reach].title}${option.peer ? ' 다른 Claude Code 세션과는 직접 알림도 주고받습니다.' : ''}`,
    onclick: () => { selected.has(option.author) ? selected.delete(option.author) : selected.add(option.author); renderRecipients(); },
  }, el('span', { class: `dot kind-${option.kind}`, 'aria-hidden': 'true' }), el('span', { text: option.author }),
  el('span', { class: 'reach', text: REACH[option.reach].label }))));
}

function computeRecipients() { options = recipientOptions(presence, config?.user, current); renderRecipients(); }
async function refreshRecipients() { presence = await api('/api/presence'); computeRecipients(); repaintAvatars(); }

function setReply(message) {
  if (!message && typeBeforeReply !== null) { $('type').value = typeBeforeReply; typeBeforeReply = null; }
  replyTo = message;
  $('replying').hidden = !message;
  if (!message) return;
  $('replying-text').textContent = t('app.replyTo', message.author, message.body.slice(0, 60));
  if (message.type === 'question' && $('type').value !== 'answer') { typeBeforeReply ??= $('type').value; $('type').value = 'answer'; }
  if (options.some((option) => option.author === message.author)) { selected.add(message.author); renderRecipients(); }
  $('body').focus();
}

function renderChannels() {
  clear($('channels')).append(...channels.map((channel) => el('li', {}, el('button', {
    type: 'button', 'aria-current': String(channel.id === current),
    onclick: () => selectChannel(channel.id),
  }, el('span', {}, el('strong', { text: `# ${channel.name ?? channel.id}` }), channel.phase ? ' ' : '', channel.phase ? el('span', { class: 'badge', text: channel.phase }) : null),
  el('span', { class: 'meta' }, channel.isFeature ? el('span', { translate: 'no', text: channel.title ?? '' }) : el('span', { text: tr(channel.title ?? '') }), ` · ${channel.count}개`)))));
}

let faceAssets = null, faces = new Map();
function computeFaces() {
  const both = (agents, reserved) => assignPersonas(agents, faceAssets, assignPersonas(agents, faceAssets, reserved), { humans: true });
  const known = both(presence, keepFaces(faces, reservedFrom(officeFaces, faceAssets)));
  const extra = [...new Map([...shown.values()].filter((m) => !presence.some((a) => a.author === m.author)).map((m) => [m.author, { author: m.author, kind: m.kind }])).values()];
  faces = extra.length ? both(extra, known) : known;
}
function avatarNode(author, kind) {
  const face = faces.get(author);
  const node = (face && faceThumb(faceAssets, face.persona, face.kind, author)) || faceShot(null, null, kind === 'human' ? 'U' : author, 32);
  node.classList.add('message-avatar');
  node.dataset.author = author; node.dataset.kind = kind;
  if (face) node.dataset.persona = face.persona;
  return node;
}
function repaintAvatars() {
  computeFaces();
  for (const old of $('timeline').querySelectorAll('.message-avatar')) old.replaceWith(avatarNode(old.dataset.author, old.dataset.kind));
}

function messageNode(message) {
  const target = message.replyTo && shown.get(message.replyTo);
  return el('article', { class: `message msg-${message.type}${message.author === config?.user ? ' own-message' : ''}`, id: message.id },
    el('header', {},
      avatarNode(message.author, message.kind),
      el('span', { class: 'who', text: message.author }),
      el('span', { class: 'kind', text: message.kind === 'human' ? t('app.ceo') : message.kind }),
      message.type !== 'message' ? el('span', { class: `badge type-${message.type}`, text: TYPE_LABELS[message.type] }) : null,
      message.phase ? el('span', { class: 'badge', text: message.phase }) : null,
      el('time', { class: 'when', datetime: message.at, text: timeLabel(message.at) }),
      message.to?.length ? el('span', { class: 'meta', text: `→ ${message.to.join(', ')}` }) : null,
      message.author !== config?.user ? el('button', { type: 'button', class: 'link reply-button', text: t('app.reply'), onclick: () => setReply(message) }) : null),
    message.replyTo ? el('div', { class: 'reply', text: `↳ ${target ? `${target.author}: ${target.body.slice(0, 80)}` : message.replyTo}` }) : null,
    el('div', { class: 'body' }, richText(message.body)));
}

function append(message) {
  if (shown.has(message.id)) return;
  shown.set(message.id, message);
  if (threadKey) { renderWork(); return; }
  const timeline = $('timeline');
  timeline.querySelector('.empty')?.remove();
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  timeline.append(messageNode(message));
  if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
}

const KIND_LABELS = { request: t('app.request'), task: t('app.assignments'), conversation: t('app.chat'), approval: t('app.executionApproval') };
const STATUS_LABELS = {
  request: { queued: t('app.waiting'), running: t('app.inProgress'), question: t('app.question'), blocked: t('app.hasAQuestion'), workflow: t('app.reviewWorkflow'), paused: t('app.paused'), completed: t('app.done') },
  task: { open: t('app.assign'), accepted: t('app.accepted'), blocked: t('app.blocked'), done: t('app.done'), cancelled: t('app.cancel') },
};
let work = { requests: [], tasks: [], approvals: [] }, threads = [], counts = {}, threadState = 'attention', threadKey = null;
const pendingThread = new URLSearchParams(location.search).get('thread');
const activeThread = () => threads.find((thread) => thread.key === threadKey) ?? null;

async function refreshWork() {
  if (embedded || !config) return;
  const [requests, team, approvals] = await Promise.all([
    api('/api/requests').then((data) => data.requests, () => work.requests),
    api('/api/team?all=1').then((data) => data.tasks, () => work.tasks),
    api('/api/approvals').then((data) => data.requests, () => work.approvals),
  ]);
  work = { requests, tasks: team, approvals };
  renderWork();
}

function renderWork() {
  ({ threads, counts } = buildThreads({ messages: [...shown.values()], ...work, user: config?.user }));
  $('work-count').hidden = !counts.attention;
  $('work-count').textContent = String(counts.attention ?? 0);
  clear($('work-filters')).append(...THREAD_STATES.map((state) => el('button', {
    type: 'button', class: `work-filter state-${state}`, 'aria-pressed': String(state === threadState),
    onclick: () => { threadState = state; renderWork(); },
  }, el('span', { text: STATE_LABELS[state] }), el('span', { class: 'tab-count', text: String(counts[state] ?? 0) }))));
  const searching = Boolean(workQuery.trim());
  const { pinned: top, groups } = arrangeThreads(threads, { state: threadState, query: workQuery, pinned });
  const rows = [
    ...(top.length ? [el('li', { class: 'thread-group', role: 'presentation', text: t('app.pin') }), ...top.map((thread) => threadRow(thread, true))] : []),
    ...groups.flatMap((group) => [el('li', { class: 'thread-group', role: 'presentation', text: group.label }), ...group.threads.map((thread) => threadRow(thread, searching))]),
  ];
  clear($('threads')).append(...(rows.length ? rows : [el('li', { class: 'empty', text: searching ? t('app.noMatchingWork') : t('app.noWorkInThis') })]));
  if (threadKey) renderThread();
}

let workQuery = '', pinned = readPinned();
function readPinned() {
  try { const keys = JSON.parse(storage('wax.chat.pinned', '[]')); return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === 'string').slice(-100) : []); }
  catch { return new Set(); }
}
function togglePin(key) {
  if (!pinned.delete(key)) pinned.add(key);
  store('wax.chat.pinned', JSON.stringify([...pinned].slice(-100)));
  renderWork();
}
function threadRow(thread, showState) {
  const isPinned = pinned.has(thread.key);
  return el('li', { class: 'thread-row' }, el('button', {
    type: 'button', class: `thread-item state-${thread.state}`, 'aria-current': String(thread.key === threadKey), onclick: () => openThread(thread.key),
  }, el('span', { class: 'thread-title' }, el('span', { class: 'badge', text: KIND_LABELS[thread.kind] }), showState ? el('span', { class: `badge state-${thread.state}`, text: STATE_LABELS[thread.state] }) : null, ' ', el('strong', { translate: thread.kind === 'approval' ? null : 'no', text: thread.title || t('app.untitled') })),
  el('span', { class: 'meta' }, el('span', { translate: 'no', text: thread.owner ?? '' }), ` · ${timeLabel(thread.lastAt)}`),
  thread.preview ? el('span', { class: 'thread-preview', translate: 'no', text: thread.preview }) : null),
  el('button', { type: 'button', class: 'pin-toggle', 'aria-pressed': String(isPinned), 'aria-label': isPinned ? t('app.unpin') : t('app.pin'), title: isPinned ? t('app.unpin') : t('app.pin'), onclick: () => togglePin(thread.key) }, icon('star', 16)));
}

function showTab(tab) {
  const workTab = tab === 'work';
  $('tab-channels').setAttribute('aria-selected', String(!workTab)); $('tab-work').setAttribute('aria-selected', String(workTab));
  $('channels-pane').hidden = workTab; $('work-pane').hidden = !workTab;
  if (workTab) refreshWork().catch(() => {});
}

function openThread(key) {
  threadKey = key;
  const thread = activeThread();
  setReply(null); selected.clear();
  for (const author of thread?.recipients ?? []) if (options.some((option) => option.author === author)) selected.add(author);
  renderRecipients();
  const url = new URL(location.href); url.searchParams.set('thread', key);
  history.replaceState(null, '', url.pathname + url.search);
  renderWork();
}

function closeThread() {
  if (!threadKey) return;
  threadKey = null;
  $('thread-head').hidden = true;
  document.querySelector('.channel-start-hint').hidden = false;
  $('recipients-wrap').hidden = false; $('composer').hidden = false; $('type').closest('.row').querySelector('label').hidden = false; $('type').hidden = false;
  const url = new URL(location.href); url.searchParams.delete('thread');
  history.replaceState(null, '', url.pathname + url.search);
  selected.clear(); setReply(null); renderRecipients();
  clear($('timeline')); [...shown.values()].forEach((message) => { $('timeline').append(messageNode(message)); });
  $('timeline').scrollTop = $('timeline').scrollHeight;
  renderWork();
}

function foldNode(items, render) {
  return el('details', { class: 'progress-fold' }, el('summary', { text: t('app.progressUpdates', items.length) }), ...items.map(render));
}
function requestMessageNode(thread, message) {
  const user = message.role === 'user';
  return el('article', { class: `message${user ? ' own-message' : ''}` },
    el('header', {}, el('span', { class: 'who', translate: 'no', text: user ? config.user : thread.owner }), el('time', { class: 'when', datetime: message.at, text: timeLabel(message.at) })),
    el('div', { class: 'body' }, richText(message.text ?? '')));
}
const proofCache = new Map(), openSections = new Map();
async function loadProofs(thread) {
  const cached = proofCache.get(thread.id);
  if (cached?.lastAt === thread.lastAt) return;
  proofCache.set(thread.id, { lastAt: thread.lastAt, proofs: cached?.proofs ?? [] });
  try {
    const { proofs } = await api(`/api/features/${encodeURIComponent(thread.id)}/proofs`);
    proofCache.set(thread.id, { lastAt: thread.lastAt, proofs });
    if (threadKey === thread.key) renderThread();
  } catch {   }
}
function proofCard(thread, proof) {
  const test = proof.kind === 'test', passed = test && proof.exitCode === 0 && !proof.timedOut;
  const result = test ? (proof.timedOut ? t('app.testTimedOut') : passed ? t('app.testPassed') : t('app.testFailed')) : t('app.commitLinked');
  return el('a', { class: `proof-card ${test ? (passed ? 'proof-pass' : 'proof-fail') : 'proof-git'}`, href: `/manage?feature=${encodeURIComponent(thread.id)}`, title: t('app.viewTheRunEvidence') },
    icon(test ? (passed ? 'passed' : 'failed') : 'link', 16), el('strong', { text: result }),
    el('code', { translate: 'no', text: test ? proof.command : String(proof.commit ?? '').slice(0, 7) }),
    test && proof.durationMs === null ? null : el('span', { class: 'meta', text: test ? t('app.seconds', Math.max(1, Math.round(proof.durationMs / 1000))) : t('app.files', proof.files) }),
    freshnessNode(proof.changed));
}
function freshnessNode(changed) {
  if (changed?.state === 'unchanged') return el('span', { class: 'meta', text: t('app.noChangesSince') });
  if (changed?.state !== 'changed') return null;
  return el('span', { class: 'meta proof-warn', title: changed.files.join('\n'), text: t('app.filesChangedSince', changed.count) });
}
function sectionNode(thread, section, index, last) {
  const key = `${thread.key}:${index}`, summary = proofSummary(section.proofs);
  const status = section.current ? STATUS_LABELS.request[thread.status] ?? t('app.inProgress') : t('app.done');
  return el('details', { class: `phase-section${section.current ? ' current' : ''}`, open: openSections.get(key) ?? last,
    ontoggle: (event) => { if (event.currentTarget.open === last) openSections.delete(key); else openSections.set(key, event.currentTarget.open); } },
  el('summary', {}, el('strong', { text: phaseName(section.phase, thread.mode) }), el('span', { class: `badge${section.current ? ' state-active' : ''}`, text: status }),
    el('span', { class: 'meta', text: t('app.progressUpdates', section.items.length) }),
    summary.tests ? el('span', { class: `meta${summary.passed < summary.tests ? ' proof-warn' : ''}`, text: t('app.testsPassed', summary.passed, summary.tests) }) : null,
    summary.commits ? el('span', { class: 'meta', text: t('app.commits', summary.commits) }) : null),
  ...section.items.map((message) => requestMessageNode(thread, message)),
  section.proofs.length ? el('div', { class: 'proof-cards' }, ...section.proofs.map((proof) => proofCard(thread, proof))) : null);
}
function taskUpdateNode(item) {
  return el('article', { class: `message msg-${item.status === 'blocked' ? 'question' : 'message'}` },
    el('header', {}, el('span', { class: 'who', translate: 'no', text: item.author }), el('span', { class: 'badge', text: STATUS_LABELS.task[item.status] ?? item.status }), el('time', { class: 'when', datetime: item.at, text: timeLabel(item.at) })),
    item.text ? el('div', { class: 'body' }, richText(item.text)) : null);
}

async function decideApproval(request, decision) {
  try { await api(`/api/approvals/${request.id}/decision`, { method: 'POST', token: config.token, body: { decision, fingerprint: request.fingerprint } }); }
  catch (error) { $('error').hidden = false; $('error').textContent = error.message; }
  await refreshWork().catch(() => {});
}

function renderThread() {
  const thread = activeThread(), head = $('thread-head');
  head.hidden = false;
  document.querySelector('.channel-start-hint').hidden = true;
  const back = el('button', { type: 'button', class: 'link', text: t('app.allMessages'), onclick: closeThread });
  if (!thread) {
    clear(head).append(back, el('p', { class: 'meta', text: t('app.thisWorkItemWas') }));
    clear($('timeline')); $('composer').hidden = true; return;
  }
  const link = thread.kind === 'request' ? el('a', { href: `/start?request=${encodeURIComponent(thread.id)}`, text: t('app.openInRequestsReports') })
    : thread.kind === 'task' ? el('a', { href: '/manage#tasks-heading', text: t('app.openInPmAssignments') }) : null;
  clear(head).append(...[back,
    el('h2', {}, el('span', { class: 'badge', text: KIND_LABELS[thread.kind] }), ' ', el('span', { translate: thread.kind === 'approval' ? null : 'no', text: thread.title || t('app.untitled') })),
    el('p', { class: 'meta' }, el('span', { class: `badge state-${thread.state}`, text: STATE_LABELS[thread.state] }),
      thread.status && STATUS_LABELS[thread.kind]?.[thread.status] !== STATE_LABELS[thread.state] ? el('span', { class: 'badge', text: STATUS_LABELS[thread.kind]?.[thread.status] ?? thread.status }) : null,
      thread.phase && thread.phase !== 'done' ? el('span', { class: 'badge', text: phaseName(thread.phase, thread.mode) }) : null,
      ' ', el('span', { translate: 'no', text: thread.owner ?? '' }), ` · 시작 ${timeLabel(thread.startedAt)} · 최근 ${timeLabel(thread.lastAt)}`),
    thread.kind === 'request' && thread.detail ? el('p', { class: 'thread-detail', translate: 'no', text: thread.detail }) : null,
    link ? el('p', { class: 'meta' }, link) : null,
    ...(thread.approvals ?? []).map((approval) => approvalCard(approval, decideApproval))].filter(Boolean));
  const timeline = clear($('timeline'));
  if (thread.kind === 'conversation') timeline.append(...foldProgress(thread.items, isChannelProgress).map((entry) => entry.folded ? foldNode(entry.folded, messageNode) : messageNode(entry.item)));
  else if (thread.kind === 'request') {
    void loadProofs(thread);
    const sections = phaseSections(thread.items, { proofs: proofCache.get(thread.id)?.proofs ?? [], done: thread.status === 'completed' });
    timeline.append(...sections.map((section, index) => sectionNode(thread, section, index, index === sections.length - 1)));
  }
  else if (thread.kind === 'task') timeline.append(...thread.items.map(taskUpdateNode));
  timeline.scrollTop = timeline.scrollHeight;
  $('composer').hidden = thread.kind === 'approval';
  $('recipients-wrap').hidden = thread.kind === 'request';
  $('type').hidden = thread.kind === 'request'; $('type').closest('.row').querySelector('label').hidden = thread.kind === 'request';
}

async function showTarget(id, target) {
  let node = document.getElementById(target);
  if (!node) {
    try {
      const { messages } = await api(`/api/channels/${encodeURIComponent(id)}/messages?id=${encodeURIComponent(target)}`);
      if (current !== id || !messages.length) return;
      append(messages[0]);
      node = document.getElementById(target);
      node?.before(el('p', { class: 'empty', text: t('app.thisMessageWasOpened') }));
      $('timeline').prepend(...[node?.previousElementSibling, node].filter(Boolean));
    } catch { return; }
  }
  node?.classList.add('search-target');
  node?.scrollIntoView({ block: 'center' });
}
async function selectChannel(id) {
  readingReady = false;
  if (threadKey) closeThread();
  if (feed.current !== null) drafts.edit(current, $('body').value);
  current = id;
  setReply(null); $('type').value = 'message'; $('delivery').hidden = true;
  selected.clear(); computeRecipients();
  const sequence = feed.begin(id);
  $('body').value = drafts.read(id).body;
  $('composer').querySelector('[type=submit]').disabled = sending.has(id);
  const url = new URL(location.href); url.searchParams.set('channel', id);
  const target = id === new URLSearchParams(location.search).get('channel') && /^#m-\d{6}-[a-f0-9]{6}$/.test(location.hash) ? location.hash.slice(1) : null;
  history.replaceState(null, '', url.pathname + url.search + (target ? `#${target}` : ''));
  renderChannels();
  shown.clear();
  clear($('timeline')).append(el('p', { class: 'empty', text: t('app.loading') }));
  try {
    const { messages } = await api(`/api/channels/${encodeURIComponent(id)}/messages?limit=200`);
    const merged = feed.merge(id, sequence, messages);
    if (!merged) return;
    shown.clear(); clear($('timeline'));
    if (!merged.length) $('timeline').append(el('p', { class: 'empty', text: t('app.noMessagesYetRun') }));
    merged.forEach(append);
    repaintAvatars();
    $('timeline').scrollTop = $('timeline').scrollHeight;
    if (target) await showTarget(id, target);
    readingReady = true;
    notifyRead();
  } catch (error) {
    if (!feed.accepts(id, sequence)) return;
    const live = feed.merge(id, sequence, []) ?? [];
    shown.clear(); clear($('timeline')); live.forEach(append);
    $('timeline').append(el('p', { class: 'error', text: error.message }));
  }
}

async function refreshChannels() {
  channels = await api('/api/channels');
  current = channels.find((channel) => channel.id === current || channel.name === current)?.id ?? channels[0]?.id ?? 'general';
  renderChannels();
}

$('body').addEventListener('input', () => drafts.edit(current, $('body').value));
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const thread = activeThread();
  if (thread?.kind === 'request') { await replyToRequest(thread); return; }
  const id = thread?.kind === 'task' ? thread.channel : current, body = $('body').value, type = $('type').value, to = [...selected];
  const reply = replyTo ?? (thread?.kind === 'conversation' ? shown.get(thread.replyTo) ?? null : null);
  if (!body.trim() || sending.has(id)) return;
  const draft = drafts.edit(id, body);
  sending.add(id); $('composer').querySelector('[type=submit]').disabled = true;
  $('error').hidden = true;
  try {
    const message = await api(`/api/channels/${encodeURIComponent(id)}/messages`, { method: 'POST', token: config.token, body: { body, type, to, replyTo: reply?.id } });
    if (feed.receive(id, message)) append(message);
    if (drafts.sent(id, draft.version) && current === id) {
      $('body').value = '';
      if (replyTo === reply) { typeBeforeReply = null; setReply(null); $('type').value = 'message'; }
      $('delivery').textContent = deliveryHint(addressed(message, options), options);
      $('delivery').hidden = false;
    }
    if (thread?.kind === 'task' && id !== current) { $('delivery').textContent = t('app.sentToTheWork', id, $('delivery').textContent); $('delivery').hidden = false; $('body').value = ''; }
  } catch (error) {
    if (current === id) { $('error').hidden = false; $('error').textContent = error.message; }
  } finally {
    sending.delete(id); $('composer').querySelector('[type=submit]').disabled = sending.has(current);
  }
});
async function replyToRequest(thread) {
  const body = $('body').value;
  if (!body.trim() || sending.has(thread.key)) return;
  sending.add(thread.key); $('composer').querySelector('[type=submit]').disabled = true; $('error').hidden = true;
  try {
    await api(`/api/requests/${encodeURIComponent(thread.id)}/reply`, { method: 'POST', token: config.token, body: { body } });
    if (threadKey === thread.key) $('body').value = '';
    await refreshWork();
  } catch (error) {
    if (threadKey === thread.key) { $('error').hidden = false; $('error').textContent = error.message; }
  } finally {
    sending.delete(thread.key); $('composer').querySelector('[type=submit]').disabled = false;
  }
}

$('replying-cancel').addEventListener('click', () => setReply(null));
$('tab-channels').addEventListener('click', () => showTab('channels'));
$('tab-work').addEventListener('click', () => showTab('work'));
let completion = null;
function completionContext() {
  const thread = activeThread(), chosen = options.filter((option) => selected.has(option.author));
  const feature = thread?.kind === 'request' ? thread.id : thread?.kind === 'task' ? thread.channel : channels.find((channel) => channel.id === current && channel.isFeature)?.id ?? null;
  return { sessions: options, features: channels.filter((channel) => channel.isFeature).map((channel) => ({ id: channel.id, title: channel.title })), kind: chosen.length === 1 ? chosen[0].kind : null, feature };
}
function updateCompletion() {
  const body = $('body');
  const at = body.selectionStart === body.selectionEnd ? completionAt(body.value, body.selectionStart) : null;
  const items = completions(at, completionContext());
  completion = items.length ? { at, items, index: Math.min(completion?.index ?? 0, items.length - 1) } : null;
  renderCompletion();
}
function renderCompletion() {
  const list = $('complete'), body = $('body');
  list.hidden = !completion; body.setAttribute('aria-expanded', String(Boolean(completion)));
  if (!completion) { clear(list); body.removeAttribute('aria-activedescendant'); return; }
  const command = completion.at.trigger === '/';
  clear(list).append(...completion.items.map((item, index) => el('li', {
    id: `complete-${index}`, role: 'option', class: 'complete-item', 'aria-selected': String(index === completion.index),
    onmousedown: (event) => { event.preventDefault(); acceptCompletion(index); },
  }, el('span', { class: 'complete-label', translate: 'no', text: item.label }), el('span', { class: 'meta', translate: command ? null : 'no', text: item.detail }))));
  body.setAttribute('aria-activedescendant', `complete-${completion.index}`);
}
function acceptCompletion(index) {
  const body = $('body'), item = completion.items[index];
  const next = applyCompletion(body.value, completion.at, item);
  body.value = next.text; body.setSelectionRange(next.caret, next.caret);
  drafts.edit(current, body.value);
  if (item.author && options.some((option) => option.author === item.author)) { selected.add(item.author); renderRecipients(); }
  completion = null; renderCompletion(); body.focus();
}
$('body').addEventListener('input', updateCompletion);
$('body').addEventListener('click', updateCompletion);
$('body').addEventListener('keyup', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateCompletion(); });
$('body').addEventListener('blur', () => { completion = null; renderCompletion(); });
$('body').addEventListener('keydown', (event) => {
  if (completion && !event.ctrlKey && !event.metaKey && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      completion.index = (completion.index + (event.key === 'ArrowDown' ? 1 : -1) + completion.items.length) % completion.items.length;
      renderCompletion(); return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); acceptCompletion(completion.index); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); completion = null; renderCompletion(); return; }
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('composer').requestSubmit();
});
$('work-search').addEventListener('input', (event) => { workQuery = event.target.value; renderWork(); });

function connect() {
  const source = openEvents();
  source.onopen = () => { $('status').dataset.state = 'live'; $('status').textContent = t('app.connectedLive'); };
  source.onerror = () => { $('status').dataset.state = 'down'; $('status').textContent = t('app.disconnectedReconnecting'); };
  source.addEventListener('message', (event) => {
    const { channel, message } = JSON.parse(event.data);
    const entry = channels.find((c) => c.id === channel);
    if (entry) { entry.count += 1; renderChannels(); }
    if (feed.receive(channel, message)) { append(message); if (message.kind !== 'human' && !faces.has(message.author)) repaintAvatars(); notifyRead(); }
  });
  let workTimer = null;
  for (const name of ['requests', 'tasks', 'approvals']) source.addEventListener(name, () => { clearTimeout(workTimer); workTimer = setTimeout(() => refreshWork().catch(() => {}), 250); });
  source.addEventListener('features', () => refreshChannels().catch(() => {}));
  source.addEventListener('presence', () => refreshRecipients().catch(() => {}));
  source.addEventListener('resync', () => {
    reloadCurrent().catch(() => {});
    for (const refresh of [refreshChannels, refreshWork, refreshRecipients]) refresh().catch(() => {});
  });
}
async function reloadCurrent() {
  const id = current;
  const { messages } = await api(`/api/channels/${encodeURIComponent(id)}/messages?limit=200`);
  if (current !== id) return;
  for (const message of messages) if (feed.receive(id, message)) append(message);
}

try {
  config = await api('/api/config');
  document.title = t('app.waxChannel', config.project);
  $('author').textContent = t('app.author', config.user);
  await refreshChannels();
  await selectChannel(current);
  await refreshRecipients().catch(() => {});
  loadFaceAssets().then((assets) => { faceAssets = assets; repaintAvatars(); });
  const recipient = new URLSearchParams(location.search).get('recipient');
  if (recipient) {
    if (options.some((option) => option.author === recipient)) { selected.add(recipient); renderRecipients(); }
    else { $('delivery').textContent = t('app.sessionCantBeSelectedAs', recipient); $('delivery').hidden = false; }
  }
  if (embedded) $('body').placeholder = t('app.typeAMessage');
  setInterval(() => refreshRecipients().catch(() => {}), 30_000);
  await refreshWork().catch(() => {});
  if (pendingThread) { showTab('work'); openThread(pendingThread); }
  connect();
} catch (error) {
  clear($('timeline')).append(el('p', { class: 'error', text: t('app.couldntLoad', error.message) }));
}

const approvals = $('approvals');
new MutationObserver(() => { approvals.hidden = !approvals.querySelector('.approval-card') || approvals.querySelectorAll('.approval-card button').length === 0; }).observe(approvals, { childList: true, subtree: true });
