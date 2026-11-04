import { t } from './messages-catalog.mjs';
import { el, timeLabel, trFill } from './dom.mjs';

const STATUS_LABELS = { proposed: t('rulesPanel.awaitingApproval'), approved: t('rulesPanel.applied'), rejected: t('rulesPanel.reject'), retired: t('rulesPanel.retire') };
const ACTIONS = { proposed: [['approve', t('rulesPanel.approve')], ['reject', t('rulesPanel.reject')]], approved: [['retire', t('rulesPanel.retire')]] };

function ruleItem(rule, decide) {
  return el('li', { class: `rule-item rule-${rule.status}` },
    el('div', { class: 'agent-head' }, el('span', { class: 'badge', text: STATUS_LABELS[rule.status] }), el('strong', { translate: 'no', text: rule.body })),
    el('p', { class: 'kind' }, '이유: ', el('span', { translate: 'no', text: rule.why })),
    el('p', { class: 'record-meta' }, trFill('제안 {0} · {1} · 근거', rule.author, timeLabel(rule.at)), ' ', ...rule.sources.map((ref) => el('code', { text: ref })), rule.decidedBy ? ` · ${trFill(rule.status === 'approved' ? '승인 {0}' : rule.status === 'rejected' ? '거절 {0}' : '폐기 {0}', rule.decidedBy)}` : ''),
    ACTIONS[rule.status] ? el('div', { class: 'row rule-actions' }, ACTIONS[rule.status].map(([action, label]) => el('button', {
      type: 'button', class: action === 'approve' ? 'primary' : '', text: label,
      onclick: (event) => { event.currentTarget.disabled = true; decide(rule, action); },
    }))) : null);
}

export function rulesView({ rules, candidates = 0 }, decide) {
  const proposed = rules.filter((rule) => rule.status === 'proposed').reverse();
  const approved = rules.filter((rule) => rule.status === 'approved').reverse();
  const closed = rules.filter((rule) => ['rejected', 'retired'].includes(rule.status)).reverse();
  const items = [...proposed, ...approved].map((rule) => ruleItem(rule, decide));
  if (!items.length) items.push(el('li', { class: 'empty', text: candidates ? trFill('규칙이 없습니다. 근거가 될 실수 기록이 {0}개 있습니다. PM 세션에 규칙 제안을 맡기세요.', candidates) : t('rulesPanel.noRulesYetWhen') }));
  if (closed.length) items.push(el('li', { class: 'rule-closed' }, el('details', {}, el('summary', { text: trFill('거절·폐기 {0}개', closed.length) }), el('ul', { class: 'note-list' }, closed.map((rule) => ruleItem(rule, decide))))));
  return { items, summary: trFill('적용 {0} · 대기 {1}', approved.length, proposed.length) };
}
