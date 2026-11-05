import { fill, messages } from './messages-catalog.mjs';
import { api, clear, el, tr } from './dom.mjs';

export const say = (code, ...args) => fill(messages[code]?.[globalThis.waxLocale?.language === 'en' ? 1 : 0] ?? code, args);
export const findingText = (item) => (item.code === 'diagnose.more' && item.of?.code ? say(item.code, item.args?.[0], say(item.of.code, ...(item.of.args ?? []))) : say(item.code, ...(item.args ?? [])));
export const bundleCommand = (id) => `wax diagnose ${id} --bundle ../wax-diagnose-${id}`;
export const citeText = (cite) => `${cite.file}${cite.line ? `:${cite.line}` : ''}${cite.pointer ? `#${cite.pointer}` : ''}`;
const citeKey = (cite) => `${cite.file}\u0000${cite.line ?? ''}\u0000${cite.pointer ?? ''}`;

const SEVERITY = { stop: 'diagnose.severity.stop', warn: 'diagnose.severity.warn', info: 'diagnose.severity.info' };
const DIMENSION = { stop: 'diagnose.dimension.stop', repeat: 'diagnose.dimension.repeat', plan: 'diagnose.dimension.plan', evidence: 'diagnose.dimension.evidence',
  approval: 'diagnose.dimension.approval', cost: 'diagnose.dimension.cost', tool: 'diagnose.dimension.tool', records: 'diagnose.dimension.records' };

function copyLine(text) {
  const button = el('button', { type: 'button', class: 'link copy-cmd diagnose-copy', 'aria-label': say('diagnose.screen.copyLabel', text), text: say('dom.copy') });
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = say('dom.copied'); setTimeout(() => { button.textContent = say('dom.copy'); }, 1500); }
    catch { button.textContent = say('dom.copyFailed'); }
  });
  return el('div', { class: 'next-cmd diagnose-cli' }, el('span', { class: 'kind', text: `${say('diagnose.screen.cli')} ` }), el('code', { text }), ' ', button);
}

export function reportView(report, { cites = new Map(), toggle = () => {} } = {}) {
  const finding = (item) => {
    const opened = item.cites.filter((cite) => cites.has(citeKey(cite)));
    return el('li', { class: `diagnose-finding diagnose-${item.severity}`, dataset: { severity: item.severity, code: item.code } },
      el('div', { class: 'agent-head' }, el('span', { class: `badge diagnose-severity diagnose-severity-${item.severity}`, text: say(SEVERITY[item.severity] ?? SEVERITY.info) }),
        el('span', { class: 'diagnose-text', text: findingText(item) })),
      el('p', { class: 'kind diagnose-cites' }, `${say('diagnose.screen.cites')} `, ...item.cites.flatMap((cite, index) => [index ? ' ' : null,
        cite.line ? el('button', { type: 'button', class: 'link diagnose-cite', 'aria-expanded': String(cites.has(citeKey(cite))), 'aria-label': say('diagnose.screen.citeLabel', citeText(cite)),
          dataset: { file: cite.file, line: String(cite.line), pointer: cite.pointer ?? '' }, onclick: () => toggle(cite) }, el('code', { text: citeText(cite) }))
          : el('code', { text: citeText(cite) })])),
      item.method ? el('p', { class: 'kind diagnose-method', text: say('diagnose.methodLabel', say(item.method)) }) : null,
      item.quote ? el('pre', { class: 'diagnose-quote', text: item.quote }) : null,
      ...opened.map((cite) => {
        const shown = cites.get(citeKey(cite));
        if (shown.loading) return el('p', { class: 'kind diagnose-cite-loading', text: say('diagnose.screen.citeLoading', citeText(cite)) });
        if (shown.error) return el('p', { class: 'error diagnose-cite-error', role: 'status', text: shown.error });
        return el('figure', { class: 'diagnose-cite-view', dataset: { file: cite.file, line: String(cite.line) } },
          el('figcaption', { class: 'kind' }, el('code', { text: citeText(cite) }), shown.truncated ? ` ${say('diagnose.screen.citeTruncated')}` : null),
          el('pre', { class: 'diagnose-cite-text', text: shown.text }));
      }));
  };
  const target = report.target ?? { kind: 'goal', id: '-', goals: [], features: [] };
  return el('div', { class: 'diagnose-report', dataset: { findings: String(report.findings ?? 0) } },
    el('p', { class: 'diagnose-summary' }, el('strong', { text: say('diagnose.summary', report.summary ? findingText(report.summary) : say('diagnose.nothing')) })),
    el('p', { class: 'kind', text: say(target.kind === 'goal' ? 'diagnose.targetGoal' : 'diagnose.targetFeature', target.id,
      (target.kind === 'goal' ? target.features : target.goals).join(', ') || '-', report.read ?? 0) }),
    ...(report.dimensions ?? []).map((dimension) => {
      const shown = dimension.findings.filter((item) => item.cites?.length);
      return el('section', { class: 'diagnose-dimension', dataset: { dimension: dimension.id, count: String(shown.length) } },
        el('h4', { text: say(DIMENSION[dimension.id] ?? dimension.id) }),
        shown.length ? el('ul', { class: 'note-list' }, shown.map(finding)) : el('p', { class: 'kind diagnose-nothing', text: say('diagnose.nothingIn', report.read ?? 0) }));
    }),
    el('p', { class: 'kind diagnose-read-only', text: say('diagnose.readOnly') }));
}

export function mountDiagnose(id, { call = api } = {}) {
  const state = { open: false, loading: false, report: null, error: '', cites: new Map() };
  let generation = 0;
  const node = el('section', { class: 'diagnose', translate: 'no', 'aria-label': say('diagnose.screen.title'), dataset: { diagnose: id } });
  const path = `/api/diagnose/${encodeURIComponent(id)}`;
  async function run() {
    const version = ++generation;
    Object.assign(state, { open: true, loading: true, error: '', cites: new Map() });
    draw();
    try {
      const report = await call(path);
      if (version !== generation) return;
      state.report = report;
    } catch (error) {
      if (version !== generation) return;
      state.report = null; state.error = tr(error.message);
    }
    state.loading = false;
    draw();
  }
  async function toggle(cite) {
    const key = citeKey(cite);
    if (state.cites.has(key)) { state.cites.delete(key); draw(); return; }
    const version = generation;
    state.cites.set(key, { loading: true });
    draw();
    const query = new URLSearchParams({ file: cite.file, line: String(cite.line), ...(cite.pointer ? { pointer: cite.pointer } : {}) });
    let shown;
    try { const result = await call(`${path}/cite?${query}`); shown = { text: result.text, truncated: Boolean(result.truncated) }; }
    catch (error) { shown = { error: tr(error.message) }; }
    if (version !== generation || !state.cites.has(key)) return;
    state.cites.set(key, shown);
    draw();
  }
  function close() { generation++; Object.assign(state, { open: false, loading: false, report: null, error: '', cites: new Map() }); draw(); }
  function draw() {
    const buttons = el('div', { class: 'row diagnose-actions' },
      el('button', { type: 'button', class: 'diagnose-run', disabled: state.loading, 'aria-expanded': String(state.open), text: say(state.open ? 'diagnose.screen.again' : 'diagnose.screen.run'), onclick: run }),
      state.open ? el('button', { type: 'button', class: 'diagnose-close', text: say('diagnose.screen.close'), onclick: close }) : null);
    const body = !state.open ? null : el('div', { class: 'diagnose-body', role: 'region', 'aria-label': say('diagnose.screen.title'), 'aria-live': 'polite' },
      el('p', { class: 'kind diagnose-hint', text: say('diagnose.screen.hint') }),
      state.loading ? el('p', { class: 'kind diagnose-loading', text: say('diagnose.screen.loading') }) : null,
      state.error ? el('p', { class: 'error diagnose-error', role: 'status', text: state.error }) : null,
      state.report ? reportView(state.report, { cites: state.cites, toggle }) : null,
      copyLine(bundleCommand(id)),
      el('p', { class: 'kind diagnose-bundle-hint', text: say('diagnose.screen.bundleHint') }));
    clear(node).append(buttons, ...(body ? [body] : []));
  }
  draw();
  return { node, run, close };
}
