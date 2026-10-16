import { OfficeInbox } from './inbox.mjs';
import { clear, el, richText } from '../dom.mjs';

export function createOfficeMessenger({ dialog, launcher, frame, count, api, getConfig, getChannels, onChange }) {
  const inbox = new OfficeInbox();
  const host = dialog.ownerDocument.defaultView;
  const target = dialog.querySelector('[data-messenger-target]');
  const preview = dialog.querySelector('[data-messenger-preview]');
  let generation = 0, frameChannel = null;
  const update = () => {
    const total = inbox.count();
    count.textContent = total > 99 ? '99+' : String(total);
    count.hidden = total === 0;
    launcher.setAttribute('aria-label', total ? `팀 메시지 열기, 안 읽은 메시지 ${total}개` : '팀 메시지 열기');
    onChange();
  };
  const open = async ({ author, channel } = {}) => {
    const config = getConfig();
    if (!config) return;
    if (author) channel = inbox.channelFor(author) ?? channel;
    const channels = getChannels();
    channel = channels.some((item) => item.id === channel) ? channel : channels.find((item) => item.id === 'general')?.id ?? channels[0]?.id ?? 'general';
    const url = new URL('/chat', location.href);
    url.searchParams.set('embed', '1');
    url.searchParams.set('channel', channel);
    if (author) url.searchParams.set('recipient', author);
    target.textContent = author ? `${author}에게 · 공개 채널` : `${config.project} · 공개 채널`;
    const currentGeneration = ++generation;
    const readOnly = !config.token;
    const navigate = frame.getAttribute('src') !== url.pathname + url.search || (frameChannel !== null && frameChannel !== channel);
    frame.hidden = readOnly; preview.hidden = !readOnly;
    if (!readOnly && navigate) frame.setAttribute('src', url.pathname + url.search);
    if (!dialog.open) dialog.showModal();
    launcher.setAttribute('aria-expanded', 'true');
    if (readOnly) {
      clear(preview).append(el('p', { class: 'kind', text: '가상 데모 · 실제 메시지를 보내지 않습니다.' }));
      try {
        const { messages } = await api(`/api/channels/${encodeURIComponent(channel)}/messages?limit=50`);
        if (currentGeneration !== generation || !dialog.open) return;
        preview.append(...messages.map((message) => el('article', { class: 'message' }, el('strong', { text: message.author }), el('div', { class: 'body' }, richText(message.body)))));
        if (!messages.length) preview.append(el('p', { class: 'empty', text: '아직 메시지가 없습니다.' }));
        inbox.read(channel); update();
      } catch (error) { if (currentGeneration === generation) preview.append(el('p', { class: 'error', text: error.message })); }
    } else if (!navigate) frame.contentWindow?.postMessage({ type: 'wax-chat-visible' }, location.origin);
  };
  launcher.addEventListener('click', () => open());
  dialog.addEventListener('close', () => { generation++; launcher.setAttribute('aria-expanded', 'false'); });
  const receive = (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || !dialog.open) return;
    if (event.data?.type === 'wax-chat-close') { dialog.close(); return; }
    if (event.data?.type !== 'wax-chat-read' || host.document.hidden) return;
    const channel = event.data.channel;
    if (!getChannels().some((item) => item.id === channel)) return;
    const ids = event.data.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return;
    frameChannel = channel;
    inbox.read(channel, ids); update();
  };
  host.addEventListener('message', receive);
  const destroy = () => { host.removeEventListener('message', receive); frame.removeAttribute('src'); };
  window.addEventListener('pagehide', destroy);
  window.addEventListener('pageshow', (event) => { if (event.persisted) host.addEventListener('message', receive); });
  return {
    open,
    count: (author) => inbox.count(author),
    isUnread: (channel, id) => inbox.isUnread(channel, id),
    receive(channel, message) {
      const received = inbox.receive(channel, message, getConfig()?.user);
      if (received) update();
      return received;
    },
  };
}
