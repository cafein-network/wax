import { LANGUAGES, STORAGE_KEY, pickLanguage, translate } from '/locale-core.mjs';

const saved = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
export const language = pickLanguage({ search: location.search, saved, browser: navigator.languages ?? [navigator.language] });
if (new URLSearchParams(location.search).has('lang')) { try { localStorage.setItem(STORAGE_KEY, language); } catch {   } }
export const tr = (text) => (language === 'en' ? translate(text) : text);
document.documentElement.lang = language;
globalThis.waxLocale = { language, translate: tr };

const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
const skipped = (node) => node?.closest?.('script, style, [translate="no"]');

function localize(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (skipped(node.parentElement)) return;
    let next = translate(node.data);
    if (next === node.data) return;
    if (node.previousSibling?.nodeType === Node.ELEMENT_NODE && /^[\p{L}\p{N}(“"‘]/u.test(next)) next = ` ${next}`;
    if (node.nextSibling?.nodeType === Node.ELEMENT_NODE && /[\p{L}\p{N}.,:;)”"’]$/u.test(next)) next = `${next} `;
    node.data = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (skipped(node)) return;
    for (const attr of ATTRS) {
      const value = node.getAttribute(attr);
      if (value) { const next = translate(value); if (next !== value) node.setAttribute(attr, next); }
    }
  }
  for (const child of node.childNodes) localize(child);
}

function picker() {
  const select = document.createElement('select');
  select.className = 'language-picker';
  select.setAttribute('aria-label', language === 'en' ? 'Language' : '언어');
  select.setAttribute('translate', 'no');
  for (const code of LANGUAGES) select.append(new Option(code === 'ko' ? '한국어' : 'English', code));
  select.value = language;
  select.addEventListener('change', () => {
    let saved = false;
    try { localStorage.setItem(STORAGE_KEY, select.value); saved = true; } catch {   }
    const url = new URL(location.href);
    if (saved) url.searchParams.delete('lang');
    else url.searchParams.set('lang', select.value);
    if (url.href === location.href) location.reload(); else location.assign(url);
  });
  return select;
}

function start() {
  document.querySelector('header.topbar, header.home-header')?.append(picker());
  if (language !== 'en') return;
  localize(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) localize(node);
      else if (record.type === 'characterData') localize(record.target);
      else if (record.type === 'attributes' && !skipped(record.target)) {
        const value = record.target.getAttribute(record.attributeName);
        if (value) { const next = translate(value); if (next !== value) record.target.setAttribute(record.attributeName, next); }
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
