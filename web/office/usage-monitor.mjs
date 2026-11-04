import { t } from '../messages-catalog.mjs';
import { clear, dateLocale, el, timeLabel } from '../dom.mjs';
import { BUILDING } from './side-rooms.mjs';


const MONITOR = { x: 506, y: 8, width: 416, height: 114 };
export const LIMIT_LABELS = { five_hour: t('office.usageMonitor.fiveHours'), seven_day: t('office.usageMonitor.weekly'), spend_limit: t('office.usageMonitor.spendingLimit') };
export const gaugeTone = (percent) => (percent >= 85 ? 'high' : percent >= 60 ? 'mid' : 'low');

export function monitorLimits(claude) {
  return (claude?.limits ?? []).filter((limit) => limit.kind !== 'spend_limit' || claude.limits.length === 1);
}

export function createUsageMonitor({ $, api, state, demo = false, overlayFor, setStyle, requestFrame, doc = document }) {
  function place(scale, seen) {
    seen.add('usage-monitor');
    const node = overlayFor('usage-monitor', () => el('button', { type: 'button', class: 'usage-monitor', onclick: () => open() }));
    const top = BUILDING.floorTop.boss + MONITOR.y;
    setStyle(node, { left: `${MONITOR.x * scale}px`, top: `${top * scale}px`, width: `${MONITOR.width * scale}px`, height: `${MONITOR.height * scale}px`, fontSize: `${Math.max(9, 15 * scale)}px` });
    const claude = state.usage?.claude;
    const key = JSON.stringify([claude?.limits, claude?.sessions?.length, Math.max(0, ...(claude?.sessions ?? []).map((x) => x.context?.percent ?? 0))]);
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    const limits = monitorLimits(claude);
    node.setAttribute('aria-label', limits.length ? `Claude 사용량 모니터: ${limits.map((l) => `${LIMIT_LABELS[l.kind] ?? l.kind} ${l.percentUsed}%`).join(', ')}. 눌러서 자세히 보기` : t('office.usageMonitor.claudeUsageMonitorNo'));
    clear(node).append(
      el('span', { class: 'um-title', text: t('office.usageMonitor.claudeUsage') }),
      ...(limits.length ? limits.map((limit) => el('span', { class: 'um-row' },
        el('span', { class: 'um-label', text: LIMIT_LABELS[limit.kind] ?? limit.kind }),
        el('span', { class: 'um-bar' }, el('span', { class: `um-fill ${gaugeTone(limit.percentUsed)}`, style: { width: `${Math.min(100, limit.percentUsed)}%` } })),
        el('span', { class: 'um-value', text: `${limit.percentUsed}%` }),
      )) : [el('span', { class: 'um-empty', text: t('office.usageMonitor.noRecordsClaudeCode') })]),
      ...(claude?.sessions?.length ? [el('span', { class: 'um-foot', text: `세션 ${claude.sessions.length} · 컨텍스트 최대 ${Math.max(0, ...claude.sessions.map((x) => x.context?.percent ?? 0))}%` })] : []),
    );
  }

  const refreshRequest = (path) => api(`${path}/refresh`, { method: 'POST', token: state.config?.token, body: {} });
  async function refreshTools({ fresh = false } = {}) {
    const data = await (fresh && !demo ? refreshRequest('/api/tools') : api('/api/tools')).catch(() => null);
    if (data?.tools) state.tools = data.tools;
    return Boolean(data?.tools);
  }
  async function refreshToolNews({ fresh = false } = {}) {
    const data = await (fresh && !demo ? refreshRequest('/api/tools/news') : api('/api/tools/news')).catch(() => null);
    if (data?.tools) state.toolNews = data;
    return Boolean(data?.tools);
  }
  async function refreshUsage() {
    if (doc.hidden) return;
    const usage = await api('/api/usage').catch(() => null);
    if (!usage) return;
    state.usage = usage;
    requestFrame();
  }

  function open() {
    const claude = state.usage?.claude ?? { limits: [], sessions: [] };
    $('agent-title').textContent = t('office.usageMonitor.claudeUsage2');
    const content = [];
    if (claude.limits.length) {
      content.push(el('h3', { text: t('office.usageMonitor.planUsageWholeAccount') }), el('dl', { class: 'dl' }, claude.limits.flatMap((limit) => [
        el('dt', { text: LIMIT_LABELS[limit.kind] ?? limit.kind }),
        el('dd', { text: `${limit.percentUsed}%${limit.resetsAt ? ` · ${new Date(limit.resetsAt).toLocaleString(dateLocale())} 초기화` : ''}` }),
      ])), el('p', { class: 'kind', text: `${claude.limitsAt ? new Date(claude.limitsAt).toLocaleString(dateLocale()) : ''}에 읽은 값입니다. 같은 계정의 모든 Claude Code 세션이 함께 씁니다.` }));
    } else {
      content.push(el('p', { class: 'empty', text: t('office.usageMonitor.noRecordsYet') }));
    }
    content.push(el('h3', { text: t('office.usageMonitor.session') }), claude.sessions.length
      ? el('div', { class: 'table-wrap' }, el('table', { class: 'agent-table' },
        el('thead', {}, el('tr', {}, [t('office.usageMonitor.session'), t('office.usageMonitor.model'), t('office.usageMonitor.context'), t('office.usageMonitor.cost'), t('office.usageMonitor.lastRecord')].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, claude.sessions.map((x) => el('tr', {},
          el('td', {}, el('code', { text: x.session.slice(0, 8) })), el('td', { text: x.model ?? '-' }),
          el('td', { text: x.context?.percent !== null && x.context?.percent !== undefined ? `${x.context.percent}%${x.context.tokens ? ` (${Math.round(x.context.tokens / 1000)}k)` : ''}` : '-' }),
          el('td', { text: x.costUsd !== null && x.costUsd !== undefined ? `$${x.costUsd.toFixed(2)}` : '-' }),
          el('td', { text: `${timeLabel(x.at)}${x.ended ? ' · 끝남' : ''}` }))))))
      : el('p', { class: 'empty', text: t('office.usageMonitor.noActiveClaudeCode') }));
    content.push(el('p', { class: 'kind', text: t('office.usageMonitor.withWaxModeIn') }));
    const target = $('agent-content');
    delete target.dataset.npc;
    clear(target).append(...content);
    $('agent-dialog').showModal();
  }

  return { place, open, refreshUsage, refreshTools, refreshToolNews };
}
