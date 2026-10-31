import { t } from './messages-catalog.mjs';
import { el, trFill } from './dom.mjs';

export function wikiView({ pages, pending = 0 }, open) {
  const items = pages.map((page) => el('li', { class: `wiki-item${page.errors ? ' has-errors' : ''}` },
    el('button', { type: 'button', class: 'link wiki-open', onclick: () => open(page) }, el('strong', { translate: 'no', text: page.title })),
    el('span', { class: 'record-meta' }, el('code', { text: page.path }), ' · ',
      page.errors || page.warnings ? trFill('오류 {0} · 확인 {1}', page.errors, page.warnings) : t('wikiPanel.evidenceChecked')),
    page.problems?.length ? el('ul', { class: 'wiki-problems' }, page.problems.slice(0, 3).map((p) => el('li', { class: p.level, text: p.message }))) : null));
  if (!items.length) items.push(el('li', { class: 'empty', text: t('wikiPanel.noWikiPagesYet') }));
  return { items, summary: pending ? trFill('페이지 {0} · 반영 대기 기록 {1}', pages.length, pending) : trFill('페이지 {0}', pages.length) };
}
