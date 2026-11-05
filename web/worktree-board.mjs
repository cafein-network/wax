import { t } from './messages-catalog.mjs';
import { api, clear, commandLine, el, tr } from './dom.mjs';
import { openEvents } from './events.mjs';
import { phaseName } from './thread-model.mjs';
import { copyResultText, integrationText, linesText } from './worktree-board-text.mjs';

export const BOARD_UI = { concurrency: 4, autoMs: 30_000, pageRows: 50 };
const STATE = { active: 'worktrees.state.active', imported: 'worktrees.state.imported', discarded: 'worktrees.state.discarded', removed: 'worktrees.state.removed' };
const SETUP = { none: 'worktrees.outcome.none', invalid: 'worktrees.outcome.invalid', pending: 'worktrees.outcome.pending', changed: 'worktrees.outcome.changed',
  ok: 'worktrees.outcome.ok', failed: 'worktrees.outcome.failed', timeout: 'worktrees.outcome.timeout', stopped: 'worktrees.outcome.stopped' };
const RUN = { running: 'worktreeBoard.run.running', done: 'worktreeBoard.run.done', blocked: 'worktreeBoard.run.blocked', exited: 'worktreeBoard.run.exited', timeout: 'worktreeBoard.run.timeout',
  failed: 'worktreeBoard.run.failed', stopped: 'worktreeBoard.run.stopped', stuck: 'worktreeBoard.run.stuck' };
const ISSUE = { folderMissing: 'worktreeBoard.issue.folderMissing', notOnBranch: 'worktreeBoard.issue.notOnBranch', branchMissing: 'worktreeBoard.issue.branchMissing', reviewMoved: 'worktreeBoard.issue.reviewMoved' };
const PROOF = { passed: 'worktreeBoard.proof.passed', failed: 'worktreeBoard.proof.failed', timeout: 'worktreeBoard.proof.timeout' };
const COLUMNS = ['state', 'activity', 'goal', 'uncommitted', 'ahead', 'baseMoved', 'lines', 'age', 'lastCommit', 'lastRun', 'proof', 'setup', 'port'];
const columnLabels = () => ({ state: t('worktreeBoard.col.state'), activity: t('worktreeBoard.col.activity'), goal: t('worktreeBoard.col.goal'), uncommitted: t('worktreeBoard.col.uncommitted'),
  ahead: t('worktreeBoard.col.ahead'), baseMoved: t('worktreeBoard.col.baseMoved'), lines: t('worktreeBoard.col.lines'), age: t('worktreeBoard.col.age'), lastCommit: t('worktreeBoard.col.lastCommit'),
  lastRun: t('worktreeBoard.col.lastRun'), proof: t('worktreeBoard.col.proof'), setup: t('worktreeBoard.col.setup'), port: t('worktreeBoard.col.port') });
const LINK = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/;
const raw = (text, tag = 'span') => el(tag, { translate: 'no', text: String(text ?? '') });
const PENDING = '…';

export function spanLabel(ms) {
  const minutes = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60_000));
  if (minutes < 60) return t('worktreeBoard.span.minutes', minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('worktreeBoard.span.hours', hours) : t('worktreeBoard.span.days', Math.floor(hours / 24));
}

function partialText(row, name) {
  const found = row.partial?.find((item) => item.cell === name);
  return found ? t(found.reason === 'timeout' ? 'worktreeBoard.cellTimeout' : 'worktreeBoard.cellError') : null;
}

function activityText(activity) {
  const tool = activity.toolLabel ?? activity.tool ?? '-';
  if (activity.kind === 'running') return t(activity.alive === false ? 'worktreeBoard.activity.runningGone' : 'worktreeBoard.activity.running', tool, activity.phase ? phaseName(activity.phase) : '-');
  if (activity.kind === 'waiting') {
    if (activity.reason === 'approval') return t('worktreeBoard.activity.waitingApproval', activity.action || '-');
    if (activity.reason === 'card') return t('worktreeBoard.activity.waitingCard', activity.detail || '-');
    return t('worktreeBoard.activity.waitingBlocked', t(RUN[activity.outcome] ?? 'worktreeBoard.run.exited'));
  }
  return t('worktreeBoard.activity.idle');
}

function gitCell(row, name, value, format) {
  if (value !== null && value !== undefined) return format(value);
  return partialText(row, name) ?? (row.git !== null ? '-' : '');
}

export function rowCells(row, board, now = Date.now()) {
  const git = row.git;
  const target = board.project?.target ?? null;
  const name = target?.name ?? t('worktreeBoard.projectHead');
  const judged = row.pr ? { kind: 'review', text: t('worktreeBoard.judge.review') } : git ? integrationText(git.integration, { target, git }) : null;
  const filling = git && row.tier < 3 && !row.issue && row.state !== 'removed' && !row.pr;
  const stateParts = [el('span', { class: `badge wt-state wt-state-${row.state}`, text: t(STATE[row.state] ?? 'worktrees.state.active') })];
  if (row.issue) stateParts.push(el('span', { class: 'wt-issue', text: t(ISSUE[row.issue] ?? 'worktreeBoard.cellError') }));
  if (judged && judged.kind !== 'pending') stateParts.push(el('span', { class: `wt-judge wt-judge-${judged.kind}`, dataset: { judge: judged.kind, reason: git.integration?.reason ?? '' }, text: judged.text }));
  else if (filling) stateParts.push(el('span', { class: 'wt-judge wt-judge-pending', dataset: { judge: 'pending' }, text: partialText(row, 'integration') ?? PENDING }));
  const age = [];
  if (row.createdAt) age.push(t('worktreeBoard.created', spanLabel(now - Date.parse(row.createdAt))));
  if (git?.lastCommit?.at) age.push(t('worktreeBoard.lastCommitAge', spanLabel(now - Date.parse(git.lastCommit.at))));
  const proof = !row.proof ? t('worktreeBoard.proof.none') : row.proof.outcome === 'passed' && row.proof.changedSince ? t('worktreeBoard.proof.passedChanged', row.proof.changedSince) : t(PROOF[row.proof.outcome] ?? 'worktreeBoard.proof.failed');
  const port = row.port ? [raw(row.port, 'code')] : ['-'];
  if (row.link && LINK.test(row.link)) {
    port.splice(0, 1, el('a', { class: 'wt-port-link', href: row.link, target: '_blank', rel: 'noopener noreferrer', translate: 'no', text: String(row.port) }));
    if (row.portUp !== null) port.push(' ', el('span', { class: `badge wt-port-${row.portUp ? 'up' : 'down'}`, text: t(row.portUp ? 'worktreeBoard.portUp' : 'worktreeBoard.portDown') }));
  }
  return {
    state: stateParts,
    activity: [el('span', { class: `wt-activity wt-activity-${row.activity.kind}`, dataset: { activity: row.activity.kind }, text: activityText(row.activity) })],
    goal: [raw(row.goalTitle ?? row.goal, 'strong'), ' · ', raw(row.feature, 'code'), el('div', { class: 'kind' }, row.pr ? raw(t('worktreeBoard.reviewPr', row.pr.number, String(row.pr.head).slice(0, 12)), 'code') : raw(row.branch, 'code'))],
    uncommitted: [gitCell(row, 'uncommitted', git?.uncommitted, (count) => t(git.tooMany ? 'worktreeBoard.tooMany' : 'worktreeBoard.uncommitted', count))],
    ahead: [gitCell(row, 'ahead', git?.ahead, (count) => t('worktreeBoard.ahead', count))],
    baseMoved: [gitCell(row, 'baseMoved', git?.baseMoved, (count) => t('worktreeBoard.baseMoved', name, count))],
    lines: [git ? (linesText(git.lines) ?? partialText(row, 'lines') ?? (filling ? PENDING : '')) : ''],
    age: [age.join(' · ') || '-'],
    lastCommit: git?.lastCommit ? [raw(git.lastCommit.subject)] : [partialText(row, 'lastCommit') ?? ''],
    lastRun: row.lastRun ? [`${row.lastRun.phase ? phaseName(row.lastRun.phase) : '-'} · `, raw(row.lastRun.toolLabel ?? row.lastRun.tool ?? '-'), ` · ${t(RUN[row.lastRun.outcome] ?? 'worktreeBoard.run.exited')}`] : ['-'],
    proof: [proof],
    setup: [row.setup?.outcome ? t(SETUP[row.setup.outcome] ?? 'worktrees.outcome.none') : '-',
      ...(row.setup?.copy ? [' · ', el('span', { class: 'wt-copy', dataset: { copy: row.setup.copy.state }, text: copyResultText(row.setup.copy) })] : [])],
    port,
  };
}

export function canCleanUp(row) {
  return row.state === 'active' && !row.issue && row.git?.integration?.integrated === true && typeof row.cleanup?.fingerprint === 'string' && row.activity?.kind !== 'running';
}

function rowNode(row, board, { ask = null, busy = false } = {}) {
  const cells = rowCells(row, board);
  if (ask && canCleanUp(row)) cells.state.push(el('button', { type: 'button', class: 'wt-cleanup', disabled: busy || undefined, text: t('worktreeBoard.cleanup.button'), onclick: () => ask(row.id) }));
  const labels = Object.fromEntries(Object.entries(columnLabels()).map(([key, text]) => [key, tr(text)]));
  return el('tr', { dataset: { worktree: row.id, state: row.state, tier: String(row.tier) } },
    COLUMNS.map((name) => el('td', { dataset: { cell: name, label: labels[name] } }, cells[name].map((part) => (part === '' ? null : part)))));
}

export function mountWorktreeBoard(container, { goal = null, fetchJson = (path) => api(path), postJson = null, heading = true, hideEmpty = true } = {}) {
  let board = null, all = false, generation = 0, loading = null, lastLoad = -Infinity, started = false;
  let asking = null, sending = false, outcome = null, token = null;
  const post = postJson ?? (async (path, body) => { token ??= (await api('/api/config')).token; return api(path, { method: 'POST', token, body }); });
  const cleanupBox = el('div', { class: 'wt-cleanup-box', hidden: true });
  const rows = new Map();
  const body = el('tbody');
  const status = el('p', { class: 'kind wt-target', 'aria-live': 'polite' });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const removed = el('input', { type: 'checkbox', class: 'wt-show-removed', onchange: (event) => { all = event.target.checked; void refresh(); } });
  const removedLabel = el('label', { class: 'trigger-check wt-removed-toggle', hidden: true }, removed, el('span', { text: t('worktreeBoard.showRemoved') }));
  const moreButton = el('button', { type: 'button', class: 'wt-more', hidden: true, text: t('worktreeBoard.showMore'), onclick: () => void more() });
  const moreText = el('span', { class: 'kind wt-more-text' });
  const refreshButton = el('button', { type: 'button', class: 'wt-refresh', text: t('worktreeBoard.refresh'), onclick: () => void refresh() });
  const table = el('table', { class: 'agent-table wt-board' },
    el('thead', {}, el('tr', {}, COLUMNS.map((name) => el('th', { scope: 'col', text: columnLabels()[name] })))), body);
  const node = el('div', { class: 'wt-board-box', dataset: { goal: goal ?? '' } },
    heading ? el('header', {}, el('h2', { id: goal ? null : 'worktree-board-heading', text: t('worktreeBoard.title') }), el('span', { class: 'spacer' }), refreshButton)
      : el('div', { class: 'row wt-board-head' }, el('span', { class: 'kind', text: t('worktreeBoard.title') }), el('span', { class: 'spacer' }), refreshButton),
    heading ? el('p', { class: 'kind', text: t('worktreeBoard.intro') }) : null,
    errorBox, status, cleanupBox, el('div', { class: 'table-wrap wt-board-wrap' }, table),
    el('div', { class: 'row wt-board-foot' }, moreButton, moreText, removedLabel));
  container.append(node);

  const query = (extra = {}) => {
    const params = new URLSearchParams();
    if (goal) params.set('goal', goal);
    if (all) params.set('all', '1');
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    const text = params.toString();
    return `/api/worktree-board${text ? `?${text}` : ''}`;
  };
  const showError = (error) => { errorBox.hidden = !error; errorBox.textContent = error?.message ?? ''; };
  const draw = () => {
    if (!board) return;
    const list = [...rows.values()];
    const empty = !list.length && !board.removedHidden && !all;
    if (hideEmpty) container.hidden = empty;
    const target = board.project?.target;
    status.textContent = !list.length ? t('worktreeBoard.none') : target ? t('worktreeBoard.target', target.name ?? t('worktreeBoard.projectHead'), target.commit.slice(0, 12)) : (board.gitRows ? t('worktreeBoard.noHead') : '');
    clear(body).append(...list.map((row) => rowNode(row, board, { ask, busy: sending })));
    drawCleanup();
    moreButton.hidden = !board.more;
    moreText.textContent = board.more ? t('worktreeBoard.moreRows', board.more) : '';
    removedLabel.hidden = !(board.removedHidden || all);
  };
  const ask = (id) => { asking = id; outcome = null; draw(); cleanupBox.querySelector('button.wt-cleanup-confirm')?.focus(); };
  const drawCleanup = () => {
    const row = asking ? rows.get(asking) : null;
    clear(cleanupBox);
    if (outcome?.done) {
      cleanupBox.append(el('p', { class: 'wt-cleanup-done', role: 'status', text: t('worktreeBoard.cleanup.done', outcome.done.worktree) }),
        commandLine(t('worktreeBoard.cleanup.branchCommand'), outcome.done.branchCommand));
    } else if (row) {
      const judged = integrationText(row.git?.integration, { target: board?.project?.target ?? null, git: row.git });
      cleanupBox.append(el('div', { class: 'pm-worktree-confirm wt-cleanup-confirm-box', role: 'group', 'aria-label': t('worktreeBoard.cleanup.title'), dataset: { worktree: row.id } },
        el('strong', { text: t('worktreeBoard.cleanup.title') }),
        el('p', {}, el('span', { class: 'kind', text: `${t('worktreeBoard.cleanup.folder')} ` }), raw(String(row.path ?? '').replaceAll('\\', '/'), 'code')),
        el('p', {}, el('span', { class: 'kind', text: `${t('worktreeBoard.cleanup.reason')} ` }), el('span', { class: 'wt-judge-integrated', text: judged?.text ?? '' })),
        el('p', { class: 'wt-cleanup-warning', text: t('worktreeBoard.cleanup.warning') }),
        el('p', { class: 'kind', text: t('worktreeBoard.cleanup.recheck') }),
        outcome?.error ? el('p', { class: 'error', role: 'alert', text: outcome.error }) : null,
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'wt-cleanup-confirm', disabled: sending || !canCleanUp(row) || undefined, text: t('worktreeBoard.cleanup.confirm'), onclick: () => void confirmCleanup(row) }),
          el('button', { type: 'button', class: 'link wt-cleanup-cancel', disabled: sending || undefined, text: t('worktreeBoard.cleanup.cancel'), onclick: () => { asking = null; outcome = null; draw(); } }))));
    }
    cleanupBox.hidden = !cleanupBox.childNodes.length;
  };
  async function confirmCleanup(row) {
    if (sending) return;
    sending = true; outcome = null; draw();
    try {
      const done = await post(`/api/pm-loop/${row.goal}/worktrees/${row.id}/cleanup-integrated`, { fingerprint: row.cleanup.fingerprint });
      asking = null; outcome = { done };
    } catch (error) { outcome = { error: error.message }; }
    finally { sending = false; }
    draw();
    if (outcome?.done) await refresh();
  }
  const fill = (list, mine) => {
    const jobs = list.filter((row) => row.git && !row.issue && row.state !== 'removed' && !row.pr).flatMap((row) => [[row.id, 2], [row.id, 3]]);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && mine === generation) {
        const [id, tier] = jobs[next++];
        let result;
        try { result = await fetchJson(`/api/worktree-board/${id}?tier=${tier}`); }
        catch { result = { id, tier, partial: [{ cell: tier === 3 ? 'integration' : 'lines', reason: 'error' }], ...(tier === 3 ? { integration: { integrated: null, reason: 'error' } } : {}) }; }
        if (mine !== generation) return;
        const row = rows.get(id);
        if (!row?.git) continue;
        if (tier === 2) row.git.lines = result.lines ?? null;
        else { row.git.integration = result.integration ?? null; row.cleanup = result.cleanup ?? null; }
        row.partial = [...row.partial.filter((item) => item.cell !== (tier === 3 ? 'integration' : 'lines')), ...(result.partial ?? [])];
        row.tier = Math.max(row.tier, tier === 3 ? 3 : (row.git.integration ? 3 : 2));
        if (result.issue && !row.issue) row.issue = result.issue;
        draw();
      }
    };
    return Promise.all(Array.from({ length: BOARD_UI.concurrency }, worker));
  };
  async function load(offset) {
    const mine = offset ? generation : ++generation;
    const data = await fetchJson(query(offset ? { offset } : {}));
    if (mine !== generation) return;
    if (!offset) { rows.clear(); board = data; }
    else board = { ...board, more: data.more };
    const fresh = [];
    for (const row of data.rows) {
      const known = rows.get(row.id);
      if (!known || (!known.git && row.git)) { rows.set(row.id, row); if (row.git) fresh.push(row); }
    }
    showError(null);
    draw();
    await fill(fresh, mine);
  }
  function refresh() {
    lastLoad = Date.now();
    loading = load(0).catch((error) => { showError(error); }).finally(() => { loading = null; });
    return loading;
  }
  async function more() {
    if (!board) return;
    const offset = [...rows.values()].filter((row) => row.git && row.state !== 'removed').length;
    try { await load(offset); } catch (error) { showError(error); }
  }
  const poke = () => { if (started && !loading && Date.now() - lastLoad >= BOARD_UI.autoMs) void refresh(); };
  const start = () => { if (started) return; started = true; void refresh(); };
  let observer = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); start(); } });
    observer.observe(node);
  } else start();
  return { node, refresh, poke, stop: () => { generation++; observer?.disconnect(); }, get rows() { return rows; } };
}

const panel = typeof document !== 'undefined' && document.getElementById('worktree-board-panel');
if (panel && new URLSearchParams(location.search).get('embed') !== '1') {
  const view = mountWorktreeBoard(panel);
  const source = openEvents();
  for (const type of ['pm', 'resync']) source.addEventListener(type, () => view.poke());
  window.addEventListener('pagehide', () => source.close());
}
