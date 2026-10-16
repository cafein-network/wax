import { ChannelFeed, ChannelDrafts } from './channel-state.mjs';
import { api, clear, el, richText, timeLabel } from '/dom.mjs';

const $ = (id) => document.getElementById(id);
const TYPE_LABELS = { message: '메시지', opinion: '의견', question: '질문', answer: '답변', decision: '결정' };
let config, channels = [], current = new URLSearchParams(location.search).get('channel');
const feed = new ChannelFeed(), drafts = new ChannelDrafts(), sending = new Set();
const shown = new Map();

function renderChannels() {
  clear($('channels')).append(...channels.map((channel) => el('li', {}, el('button', {
    type: 'button', 'aria-current': String(channel.id === current),
    onclick: () => selectChannel(channel.id),
  }, el('span', {}, el('strong', { text: `# ${channel.name ?? channel.id}` }), channel.phase ? ' ' : '', channel.phase ? el('span', { class: 'badge', text: channel.phase }) : null),
  el('span', { class: 'meta', text: `${channel.title ?? ''} · ${channel.count}개` })))));
}

function messageNode(message) {
  const target = message.replyTo && shown.get(message.replyTo);
  return el('article', { class: 'message', id: message.id },
    el('header', {},
      el('span', { class: 'who', text: message.author }),
      el('span', { class: 'kind', text: message.kind }),
      message.type !== 'message' ? el('span', { class: `badge type-${message.type}`, text: TYPE_LABELS[message.type] }) : null,
      message.phase ? el('span', { class: 'badge', text: message.phase }) : null,
      el('time', { class: 'when', datetime: message.at, text: timeLabel(message.at) })),
    message.replyTo ? el('div', { class: 'reply', text: `↳ ${target ? `${target.author}: ${target.body.slice(0, 80)}` : message.replyTo}` }) : null,
    el('div', { class: 'body' }, richText(message.body)));
}

function append(message) {
  if (shown.has(message.id)) return;
  const timeline = $('timeline');
  timeline.querySelector('.empty')?.remove();
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  shown.set(message.id, message);
  timeline.append(messageNode(message));
  if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
}

async function selectChannel(id) {
  if (feed.current !== null) drafts.edit(current, $('body').value);
  current = id;
  const sequence = feed.begin(id);
  $('body').value = drafts.read(id).body;
  $('composer').querySelector('[type=submit]').disabled = sending.has(id);
  history.replaceState(null, '', `/chat?channel=${encodeURIComponent(id)}`);
  renderChannels();
  shown.clear();
  clear($('timeline')).append(el('p', { class: 'empty', text: '불러오는 중…' }));
  try {
    const { messages } = await api(`/api/channels/${encodeURIComponent(id)}/messages?limit=200`);
    const merged = feed.merge(id, sequence, messages);
    if (!merged) return;
    shown.clear(); clear($('timeline'));
    if (!merged.length) $('timeline').append(el('p', { class: 'empty', text: '아직 메시지가 없습니다. 에이전트는 wax chat post로 글을 남깁니다.' }));
    merged.forEach(append);
    $('timeline').scrollTop = $('timeline').scrollHeight;
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
  const id = current, body = $('body').value, type = $('type').value;
  if (!body.trim() || sending.has(id)) return;
  const draft = drafts.edit(id, body);
  sending.add(id); $('composer').querySelector('[type=submit]').disabled = true;
  $('error').hidden = true;
  try {
    const message = await api(`/api/channels/${encodeURIComponent(id)}/messages`, { method: 'POST', token: config.token, body: { body, type } });
    if (feed.receive(id, message)) append(message);
    if (drafts.sent(id, draft.version) && current === id) $('body').value = '';
  } catch (error) {
    if (current === id) { $('error').hidden = false; $('error').textContent = error.message; }
  } finally {
    sending.delete(id); $('composer').querySelector('[type=submit]').disabled = sending.has(current);
  }
});
$('body').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('composer').requestSubmit(); });

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => { $('status').dataset.state = 'live'; $('status').textContent = '실시간 연결됨'; };
  source.onerror = () => { $('status').dataset.state = 'down'; $('status').textContent = '연결 끊김 — 다시 연결 중'; };
  source.addEventListener('message', (event) => {
    const { channel, message } = JSON.parse(event.data);
    const entry = channels.find((c) => c.id === channel);
    if (entry) { entry.count += 1; renderChannels(); }
    if (feed.receive(channel, message)) append(message);
  });
  source.addEventListener('features', () => refreshChannels().catch(() => {}));
}

try {
  config = await api('/api/config');
  document.title = `${config.project} · wax 채널`;
  $('author').textContent = `작성자: ${config.user}`;
  await refreshChannels();
  await selectChannel(current);
  connect();
} catch (error) {
  clear($('timeline')).append(el('p', { class: 'error', text: `불러오지 못했습니다: ${error.message}` }));
}
