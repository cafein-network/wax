import { t } from './messages-catalog.mjs';
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const tr = (text) => globalThis.waxLocale?.translate(text) ?? text;
export const trFill = (template, ...values) => tr(template).replace(/\{(\d+)\}/g, (hole, index) => values[index] ?? hole);
export const dateLocale = () => (globalThis.document?.documentElement.lang === 'en' ? 'en-US' : 'ko-KR');

export const clear = (node) => { node.replaceChildren(); return node; };

export function richText(text) {
  const frag = el('span', { translate: 'no' });
  for (const part of String(text).split(/(@[\p{L}\p{N}_.-]+)/u)) {
    if (!part) continue;
    frag.append(part.startsWith('@') ? el('mark', { class: 'mention', text: part }) : document.createTextNode(part));
  }
  return frag;
}

export function timeLabel(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json', 'x-chat-token': token } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error ?? t('dom.requestFailed', response.status));
  return data;
}

export function storage(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function store(key, value) {
  try { localStorage.setItem(key, value); } catch {   }
}

export function commandLine(label, text, reason) {
  const button = el('button', { type: 'button', class: 'link copy-cmd', 'aria-label': `${label} 복사: ${text}`, text: t('dom.copy') });
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = t('dom.copied'); setTimeout(() => { button.textContent = t('dom.copy'); }, 1500); }
    catch { button.textContent = t('dom.copyFailed'); }
  });
  return el('div', { class: 'next-cmd' }, el('span', { class: 'kind', text: `${label} ` }), el('code', { translate: 'no', text }), ' ', button, reason ? el('span', { class: 'kind', text: ` · ${reason}` }) : null);
}
