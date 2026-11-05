import { t } from './messages-catalog.mjs';
import { el, timeLabel } from './dom.mjs';

const short = (sha) => (sha ? String(sha).slice(0, 12) : '-');
const raw = (text, tag = 'span', extra = {}) => el(tag, { translate: 'no', ...extra, text: String(text ?? '') });
const WHY = { setup: 'reviewPr.why.setup', ref: 'reviewPr.why.ref', package: 'reviewPr.why.package', github: 'reviewPr.why.github', script: 'reviewPr.why.script' };
const STATE = { OPEN: 'reviewPr.state.open', CLOSED: 'reviewPr.state.closed', MERGED: 'reviewPr.state.merged', UNKNOWN: 'reviewPr.state.unknown' };

function infoView(info) {
  const pr = info.pr;
  return el('div', { class: 'pm-review-pr-info', dataset: { pr: String(pr.number), cross: pr.cross ? 'yes' : 'no' } },
    el('p', {}, el('strong', {}, `#${pr.number} `, raw(pr.title)), ' ', el('span', { class: 'badge', text: t(STATE[pr.state] ?? STATE.UNKNOWN) })),
    el('p', { class: 'kind' }, t('reviewPr.byLine'), ' ', raw(pr.author || '-', 'code'), ' · ', raw(`${pr.headOwner ? `${pr.headOwner}:` : ''}${pr.headRef}`, 'code'), ' → ', raw(pr.base, 'code'),
      ' · ', t('reviewPr.head'), ' ', raw(short(pr.head), 'code')),
    pr.cross ? el('p', { class: 'error pm-review-pr-fork', role: 'note', text: t('reviewPr.fork') }) : null,
    pr.state !== 'OPEN' ? el('p', { class: 'kind pm-review-pr-closed', text: t('reviewPr.notOpen') }) : null,
    info.setupChanged ? el('p', { class: 'error pm-review-pr-setup', text: t('reviewPr.setupChanged') }) : null,
    info.risky?.length ? el('div', { class: 'pm-review-pr-risky' }, el('p', { class: 'kind', text: t('reviewPr.risky', info.risky.length, pr.files) }),
      el('ul', { class: 'pm-worktree-paths' }, info.risky.map((item) => el('li', { dataset: { path: item.path, why: item.why } }, raw(item.path, 'code'), ' ',
        el('span', { class: 'kind', text: t(WHY[item.why] ?? WHY.script) }))))) : el('p', { class: 'kind', text: t('reviewPr.noRisky', pr.files) }),
    pr.filesTruncated ? el('p', { class: 'kind', text: t('reviewPr.filesTruncated') }) : null,
    info.remote ? el('p', { class: 'kind pm-review-pr-remote' }, t('reviewPr.remote'), ' ', raw(info.remote, 'code'), ' · ', raw(pr.repo, 'code'))
      : el('p', { class: 'error pm-review-pr-noremote', text: t('reviewPr.noRemote', pr.repo) }),
    info.shallow ? el('p', { class: 'error pm-review-pr-shallow', text: t('reviewPr.shallow') }) : null);
}

function fetchConfirm(info, { busy, confirm, cancel, again }) {
  const n = info.pr.number;
  return el('div', { class: 'pm-review-pr-confirm', role: 'group', 'aria-label': t('reviewPr.fetch') },
    el('p', { class: 'kind', text: t(again ? 'reviewPr.confirmAgain' : 'reviewPr.confirmText', n, short(info.pr.head)) }),
    el('ul', { class: 'pm-review-pr-writes' },
      el('li', { text: t('reviewPr.writes.objects') }),
      el('li', {}, t('reviewPr.writes.ref'), ' ', raw(`refs/wax/review/pr-${n}`, 'code')),
      el('li', {}, t('reviewPr.writes.worktree'), ' ', raw('.wax/worktrees/<goal>-<n>/', 'code'))),
    el('p', { class: 'kind', text: t('reviewPr.writes.not') }),
    el('p', { class: 'kind', text: t('reviewPr.writes.after') }),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'primary pm-review-pr-fetch', disabled: busy || undefined, text: t('reviewPr.fetchConfirm'), onclick: () => confirm() }),
      el('button', { type: 'button', class: 'pm-worktree-cancel', disabled: busy || undefined, text: t('dashboard.cancel'), onclick: () => cancel() })));
}

export function reviewPrBlock(goal, { busy = false, open = null, read = () => {}, fetchPr = () => {}, ask = () => {}, cancel = () => {} } = {}) {
  const features = (goal.features ?? []).filter((item) => item.phase === 'review' && !item.archived);
  if (!features.length && !open) return null;
  const finished = ['done', 'stopped'].includes(goal.storedState ?? goal.state);
  const select = el('select', { name: 'review-feature', class: 'pm-review-pr-feature', disabled: busy || finished || undefined, 'aria-label': t('reviewPr.feature') },
    features.map((item) => el('option', { value: item.id, translate: 'no', text: item.title ? `${item.id} · ${item.title}` : item.id })));
  if (open?.feature && features.some((item) => item.id === open.feature)) select.value = open.feature;
  const number = el('input', { type: 'text', name: 'review-pr-number', inputmode: 'numeric', class: 'pm-review-pr-number', placeholder: '123', size: 8, maxlength: 10,
    disabled: busy || finished || undefined, 'aria-label': t('reviewPr.number'), value: open?.number ?? '' });
  const info = open?.info ?? null;
  const parts = [
    el('p', { class: 'kind', text: t('reviewPr.hint') }),
    features.length ? el('div', { class: 'row pm-review-pr-pick' }, select, number,
      el('button', { type: 'button', class: 'pm-review-pr-read', disabled: busy || finished || undefined, text: t('reviewPr.read'), onclick: () => read(goal, select.value, number.value) })) : null,
  ];
  if (info) {
    parts.push(infoView(info));
    const mine = (info.entries ?? []).filter((item) => item.feature === (open.feature ?? select.value));
    const stale = mine.find((item) => item.stale);
    const same = mine.find((item) => !item.stale);
    if (stale) parts.push(el('p', { class: 'error pm-review-pr-new', text: t('reviewPr.newCommits', short(stale.head), short(info.pr.head)) }));
    if (same) parts.push(el('p', { class: 'kind pm-review-pr-have', text: t('reviewPr.haveHead', same.id) }));
    if (open.confirm === 'fetch') parts.push(fetchConfirm(info, { busy, again: Boolean(stale), confirm: () => fetchPr(goal, open.feature ?? select.value, info), cancel: () => ask(goal, { confirm: null }) }));
    else if (info.ready && !same) {
      parts.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'pm-review-pr-fetch-open', disabled: busy || finished || undefined,
        text: t(stale ? 'reviewPr.fetchAgain' : 'reviewPr.fetch'), onclick: () => ask(goal, { confirm: 'fetch' }) })));
    }
  }
  if (open?.result) parts.push(el('p', { class: 'pm-review-pr-result', role: 'status', text: t('pmLoop.worktree.reviewFetched', open.result.pr, short(open.result.head), open.result.worktree) }));
  if (open?.error) parts.push(el('p', { class: 'error', role: 'alert', text: open.error }));
  if (open) parts.push(el('button', { type: 'button', class: 'pm-worktree-cancel pm-review-pr-close', disabled: busy || undefined, text: t('worktrees.reviewClose'), onclick: () => cancel(goal) }));
  return el('fieldset', { class: 'pm-pick-box pm-review-pr', dataset: { state: open?.result ? 'fetched' : info ? 'read' : 'empty' } }, el('legend', { text: t('reviewPr.title') }), ...parts);
}

export function reviewRunBlock(entry, { busy = false, open = null, allow = () => {}, ask = () => {}, cancel = () => {} } = {}) {
  const run = entry.run ?? { allowed: false };
  if (run.allowed) return el('p', { class: 'kind pm-review-run', dataset: { run: 'allowed' }, text: t('reviewPr.run.allowed', short(entry.pr.head), run.decision?.by ?? '-', timeLabel(run.decision?.at)) });
  if (open?.confirm !== 'allow-run') {
    return el('div', { class: 'pm-review-run', dataset: { run: 'pending' } }, el('p', { class: 'kind', text: t('reviewPr.run.pending') }),
      el('button', { type: 'button', class: 'pm-review-run-open', disabled: busy || undefined, text: t('reviewPr.run.button'), onclick: () => ask(entry.id, 'allow-run') }));
  }
  return el('div', { class: 'pm-review-run-confirm', role: 'group', 'aria-label': t('reviewPr.run.button'), dataset: { run: 'confirm' } },
    entry.pr.cross ? el('p', { class: 'error pm-review-pr-fork', text: t('reviewPr.fork') }) : null,
    el('p', { class: 'kind', text: t(entry.pr.cross ? 'reviewPr.run.textFork' : 'reviewPr.run.text', short(entry.pr.head)) }),
    el('p', { class: 'kind', text: t('reviewPr.run.scope') }),
    run.hash ? el('p', { class: 'kind' }, 'worktree.json sha256 ', raw(run.hash, 'code')) : el('p', { class: 'kind', text: t('reviewPr.run.noSetup') }),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'primary pm-review-run-confirm-button', disabled: busy || undefined, text: t('reviewPr.run.confirm'), onclick: () => allow(entry) }),
      el('button', { type: 'button', class: 'pm-worktree-cancel', disabled: busy || undefined, text: t('dashboard.cancel'), onclick: () => cancel(entry.id) })));
}
