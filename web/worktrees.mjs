import { t } from './messages-catalog.mjs';
import { el, timeLabel } from './dom.mjs';
import { phaseName } from './thread-model.mjs';

const STATE_TEXT = { none: 'worktrees.setupState.none', invalid: 'worktrees.setupState.invalid', pending: 'worktrees.setupState.pending', approved: 'worktrees.setupState.approved', changed: 'worktrees.setupState.changed' };
const OUTCOMES = { none: 'worktrees.outcome.none', invalid: 'worktrees.outcome.invalid', pending: 'worktrees.outcome.pending', changed: 'worktrees.outcome.changed',
  ok: 'worktrees.outcome.ok', failed: 'worktrees.outcome.failed', timeout: 'worktrees.outcome.timeout', stopped: 'worktrees.outcome.stopped' };
const ENTRY_STATES = { active: 'worktrees.state.active', imported: 'worktrees.state.imported', discarded: 'worktrees.state.discarded', removed: 'worktrees.state.removed' };
const ACTIONS = { new: 'worktrees.import.new', modify: 'worktrees.import.modify', delete: 'worktrees.import.delete' };
const SKIPS = { sensitive: 'worktrees.import.skip.sensitive', symlink: 'worktrees.import.skip.symlink', notFile: 'worktrees.import.skip.notFile', outside: 'worktrees.import.skip.outside', unreadable: 'worktrees.import.skip.unreadable' };
const BASELINE_TEXT = { missing: 'worktrees.import.baseline.missing', mismatch: 'worktrees.import.baseline.mismatch', tooLarge: 'worktrees.import.baseline.tooLarge', failed: 'worktrees.import.baseline.failed' };
const short = (sha) => (sha ? String(sha).slice(0, 12) : '-');
const code = (text) => el('code', { translate: 'no', text });
const outcomeText = (outcome) => (OUTCOMES[outcome] ? t(OUTCOMES[outcome]) : outcome ?? '-');

export function worktreeField() {
  const box = el('input', { type: 'checkbox', name: 'worktrees', value: 'on' });
  const node = el('fieldset', { class: 'pm-pick-box pm-worktrees-field' }, el('legend', { text: t('worktrees.title') }),
    el('label', { class: 'trigger-check pm-worktree-check' }, box, el('span', { class: 'pm-worktree-text' }, el('strong', { text: t('worktrees.checkbox') }),
      el('small', { class: 'kind', text: t('worktrees.checkboxHint') }))));
  return { node, read: () => box.checked };
}

function refList(refs, title, extra = '') {
  if (!refs.length) return null;
  return el('div', { class: `pm-worktree-refs ${extra}`.trim() }, el('p', { class: 'kind', text: title }),
    refs.map((ref) => el('details', { class: 'pm-worktree-ref', dataset: { path: ref.path } }, el('summary', { translate: 'no', text: `${ref.path} · ${ref.size} B` }),
      ref.text === null ? el('p', { class: 'kind', text: t('worktrees.reviewBinary') }) : el('pre', { class: 'pm-worktree-file', translate: 'no', text: ref.text }))));
}

export function setupReviewView(review, { busy, approve, close }) {
  const canApprove = ['pending', 'changed'].includes(review.state) && review.hash;
  return el('div', { class: 'pm-worktree-review', dataset: { state: review.state } },
    el('div', { class: 'agent-head' }, el('strong', { text: t('worktrees.reviewTitle') }), el('code', { class: 'kind', translate: 'no', text: review.file }),
      el('span', { class: `badge pm-worktree-setup-${review.state}`, text: t(STATE_TEXT[review.state] ?? review.state) }), el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'pm-worktree-review-close', text: t('worktrees.reviewClose'), onclick: () => close() })),
    review.reason ? el('p', { class: 'error', text: review.reason }) : null,
    review.text !== undefined ? el('pre', { class: 'pm-worktree-file', translate: 'no', text: review.text }) : null,
    review.config ? el('p', { class: 'kind' }, t('worktrees.reviewArgs'), ' ', el('code', { translate: 'no', text: JSON.stringify(review.config.setup) })) : null,
    refList(review.refs?.filter((ref) => !ref.package) ?? [], t('worktrees.reviewRefs', review.refs?.filter((ref) => !ref.package).length ?? 0)),
    review.config && !review.refs?.some((ref) => !ref.package) ? el('p', { class: 'kind', text: t('worktrees.reviewNoRefs') }) : null,
    review.packageManager ? refList(review.refs?.filter((ref) => ref.package) ?? [], t('worktrees.reviewPackages', review.refs?.filter((ref) => ref.package).length ?? 0), 'pm-worktree-packages') : null,
    review.packageManager && !review.refs?.some((ref) => ref.package) ? el('p', { class: 'kind', text: t('worktrees.reviewNoPackages') }) : null,
    review.hash ? el('p', { class: 'kind pm-worktree-hash' }, 'sha256 ', el('code', { translate: 'no', text: review.hash })) : null,
    review.approved ? el('p', { class: 'kind', text: t('worktrees.reviewApproved', review.approved.by ?? '-', timeLabel(review.approved.at), review.approved.hash.slice(0, 12)) }) : null,
    el('p', { class: 'kind', text: t('worktrees.reviewNote', review.limits?.timeoutMinutes ?? 5, review.limits?.output ?? 4000) }),
    el('p', { class: 'kind pm-worktree-limit', text: t('worktrees.reviewLimit') }),
    canApprove ? el('button', { type: 'button', class: 'primary pm-worktree-approve', disabled: busy, text: t('worktrees.approve'), onclick: () => approve(review.hash) }) : null);
}

function entryItem(goal, entry, { busy, view, imports, preview, confirm, cancel, ask, discard }) {
  const open = imports?.get(entry.id) ?? null;
  const active = entry.state === 'active';
  const supported = view.git?.importSupported !== false;
  const parts = [code(entry.branch), ' ',
    el('span', { class: 'kind' }, t('worktrees.entryLine', entry.feature, entry.port ?? '-', entry.env?.length ? entry.env.join(', ') : '-', outcomeText(entry.setup), ENTRY_STATES[entry.state] ? t(ENTRY_STATES[entry.state]) : entry.state)),
    el('div', { class: 'kind pm-worktree-path', translate: 'no', text: `.wax/worktrees/${entry.id}` })];
  if (active && entry.summary) parts.push(el('div', { class: 'kind pm-worktree-summary', text: t('worktrees.summary', entry.summary.files, entry.summary.commits, entry.summary.uncommitted) }));
  if (!active && entry.by && entry.state !== 'removed') parts.push(el('div', { class: 'kind', text: t('worktrees.stateBy', ENTRY_STATES[entry.state] ? t(ENTRY_STATES[entry.state]) : entry.state, entry.by, timeLabel(entry.at)) }));
  if (active && !supported) {
    parts.push(el('div', { class: 'pm-worktree-oldgit' }, el('p', { class: 'kind', text: t('worktrees.import.oldGit', view.git?.version ?? '-') }),
      el('pre', { class: 'pm-worktree-file', translate: 'no', text: (entry.commands ?? []).join('\n') })));
  }
  if (active && !open?.preview && !open?.confirm) {
    parts.push(el('div', { class: 'row pm-worktree-actions' },
      el('button', { type: 'button', class: 'pm-worktree-import-open', disabled: busy || !supported || undefined, text: t('worktrees.import.button'), onclick: () => preview(goal, entry) }),
      el('button', { type: 'button', class: 'pm-worktree-discard-open', disabled: busy || undefined, text: t('worktrees.discard.button'), onclick: () => ask(entry.id, 'discard') })));
  }
  if (open?.confirm === 'discard') {
    parts.push(el('div', { class: 'pm-worktree-confirm', role: 'group', 'aria-label': t('worktrees.discard.button') }, el('p', { class: 'kind', text: t('worktrees.discard.confirmText', entry.branch) }),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'pm-worktree-discard', disabled: busy || undefined, text: t('worktrees.discard.confirm'), onclick: () => discard(goal, entry) }),
        el('button', { type: 'button', class: 'pm-worktree-cancel', disabled: busy || undefined, text: t('dashboard.cancel'), onclick: () => cancel(entry.id) }))));
  }
  if (open?.preview) parts.push(importPreview(goal, entry, open.preview, { busy, confirm, cancel }));
  if (open?.result) parts.push(importResult(open.result, () => cancel(entry.id)));
  if (open?.error) parts.push(el('p', { class: 'error', role: 'alert', text: open.error }));
  return el('li', { dataset: { worktree: entry.id, state: entry.state } }, ...parts);
}

const pathList = (paths, extra = '') => el('ul', { class: `pm-worktree-paths ${extra}`.trim() }, paths.map((path) => el('li', { dataset: { path } }, code(path))));

function importPreview(goal, entry, preview, { busy, confirm, cancel }) {
  const files = preview.files ?? [];
  const blocks = [];
  if (!preview.supported) blocks.push(el('p', { class: 'error', text: t('worktrees.import.oldGit', preview.version ?? '-') }), el('pre', { class: 'pm-worktree-file', translate: 'no', text: (preview.commands ?? []).join('\n') }));
  const unsafe = BASELINE_TEXT[preview.baseline?.state] ?? null;
  if (unsafe) blocks.push(el('p', { class: 'error pm-worktree-baseline', dataset: { state: preview.baseline.state }, text: t(unsafe) }), el('pre', { class: 'pm-worktree-file', translate: 'no', text: (preview.commands ?? []).join('\n') }));
  if (preview.conflicts?.length) blocks.push(el('p', { class: 'error pm-worktree-conflicts-title', text: t('worktrees.import.conflicts', preview.conflicts.length) }), pathList(preview.conflicts, 'pm-worktree-conflicts'),
    el('p', { class: 'kind', text: t('worktrees.import.conflictsHint') }));
  if (preview.dirtyCount) blocks.push(el('p', { class: 'error pm-worktree-dirty', text: t('worktrees.import.dirty', preview.dirtyCount) }), pathList(preview.dirty ?? []));
  if (preview.busy) blocks.push(el('p', { class: 'error', text: t('worktrees.import.busy', preview.busy) }));
  if (preview.exists?.length) blocks.push(el('p', { class: 'error', text: t('worktrees.import.exists', preview.exists.length) }), pathList(preview.exists));
  if (preview.changed?.length) blocks.push(el('p', { class: 'error', text: t('worktrees.import.projectChanged', preview.changed.length) }), pathList(preview.changed));
  if (preview.over) blocks.push(el('p', { class: 'error', text: t('worktrees.import.over', 200, 64) }));
  const ok = preview.supported && !preview.conflicts?.length && !unsafe;
  const excluded = preview.excluded?.count ? preview.excluded : null;
  return el('div', { class: 'pm-worktree-import', role: 'group', 'aria-label': t('worktrees.import.title'), dataset: { ready: preview.ready ? 'yes' : 'no' } },
    el('p', { class: 'kind' }, t('worktrees.import.from'), ' ', code(entry.branch), ' · ', code(short(preview.base)), ' → ', code(short(preview.tip)), ' · HEAD ', code(short(preview.head))),
    preview.uncommitted ? el('p', { class: 'kind', text: t('worktrees.import.uncommitted', preview.uncommitted) }) : null,
    ...blocks,
    ok ? el('p', { class: 'pm-worktree-import-summary', text: t('worktrees.import.summary', preview.count ?? files.length, preview.skip?.length ?? 0) }) : null,
    ok && files.length ? el('ul', { class: 'pm-worktree-files' }, files.map((file) => el('li', { dataset: { path: file.path, action: file.action } }, code(file.path), ' ',
      el('span', { class: 'badge', text: t(ACTIONS[file.action] ?? 'worktrees.import.modify') }), ' ',
      el('span', { class: 'kind', translate: 'no', text: file.binary ? t('worktrees.import.binary') : `+${file.added} −${file.removed}` }),
      file.mode ? el('span', { class: 'kind', translate: 'no', text: ` ${file.mode}` }) : null))) : null,
    ok && preview.skip?.length ? el('div', {}, el('p', { class: 'kind', text: t('worktrees.import.skipped', preview.skip.length) }),
      el('ul', { class: 'pm-worktree-paths pm-worktree-skip' }, preview.skip.map((item) => el('li', { dataset: { path: item.path, reason: item.reason } }, code(item.path), ' ',
        el('span', { class: 'kind', text: t(SKIPS[item.reason] ?? 'worktrees.import.skip.notFile') }))))) : null,
    ok && excluded ? el('div', { class: 'pm-worktree-excluded' }, el('p', { class: 'kind', text: t('worktrees.import.excluded', excluded.count) }),
      el('ul', { class: 'pm-worktree-paths' }, (excluded.groups ?? []).map((group) => el('li', { dataset: { path: group.path, reason: 'setupOutput' } }, code(group.path), ' ',
        el('span', { class: 'kind', text: t('worktrees.import.excludedGroup', group.count) }))))) : null,
    ok && preview.phase && preview.phase !== 'done' ? el('p', { class: 'kind pm-worktree-notdone', text: t('worktrees.import.notDone', phaseName(preview.phase)) }) : null,
    el('p', { class: 'kind', text: t('worktrees.import.note') }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary pm-worktree-import-confirm', disabled: busy || !preview.ready || undefined, text: t('worktrees.import.confirm'), onclick: () => confirm(goal, entry, preview) }),
      el('button', { type: 'button', class: 'pm-worktree-cancel', disabled: busy || undefined, text: t('dashboard.cancel'), onclick: () => cancel(entry.id) })));
}

function importResult(result, close) {
  return el('div', { class: 'pm-worktree-import-result', role: 'status' },
    el('p', { text: t('worktrees.import.done', result.imported.length, result.skipped.length, result.failed.length) }),
    result.failed?.length ? pathList(result.failed, 'pm-worktree-failed') : null,
    el('p', { class: 'kind' }, t('worktrees.import.undo'), ' ', code(result.run)),
    el('button', { type: 'button', class: 'pm-worktree-cancel', text: t('worktrees.reviewClose'), onclick: close }));
}

function cleanupBlock(goal, { busy, imports, ask, cancel, cleanup }) {
  const key = `${goal.id}:cleanup`;
  const open = imports?.get(key) ?? null;
  const parts = [];
  if (open?.result) {
    const r = open.result;
    parts.push(el('p', { class: 'pm-worktree-cleanup-result', role: 'status', text: t('worktrees.cleanup.done', r.removed.length + r.missing.length, r.failed.length + r.unsafe.length, r.kept.length) }),
      ...r.failed.map((item) => el('p', { class: 'error', translate: 'no', text: `${item.id}: ${item.reason}` })),
      el('button', { type: 'button', class: 'pm-worktree-cancel', text: t('worktrees.reviewClose'), onclick: () => cancel(key) }));
  } else if (open?.confirm === 'cleanup') {
    parts.push(el('p', { class: 'kind', text: t('worktrees.cleanup.confirmText') }),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'pm-worktree-cleanup', disabled: busy || undefined, text: t('worktrees.cleanup.confirm'), onclick: () => cleanup(goal) }),
        el('button', { type: 'button', class: 'pm-worktree-cancel', disabled: busy || undefined, text: t('dashboard.cancel'), onclick: () => cancel(key) })));
  } else {
    parts.push(el('button', { type: 'button', class: 'pm-worktree-cleanup-open', disabled: busy || undefined, text: t('worktrees.cleanup.button'), onclick: () => ask(key, 'cleanup') }));
  }
  if (open?.error) parts.push(el('p', { class: 'error', role: 'alert', text: open.error }));
  return el('div', { class: 'pm-worktree-cleanup-box' }, ...parts);
}

export function worktreeView(goal, { busy = false, set = () => {}, review = null, openReview = () => {}, approve = () => {}, closeReview = () => {},
  imports = new Map(), preview = () => {}, confirm = () => {}, cancel = () => {}, ask = () => {}, discard = () => {}, cleanup = () => {} } = {}) {
  const view = goal.worktrees ?? { on: false, locked: false, entries: [] };
  const finished = ['done', 'stopped'].includes(goal.storedState ?? goal.state);
  const box = el('input', { type: 'checkbox', name: 'worktrees', disabled: busy || view.locked || finished, onchange: (event) => set(goal, { on: event.target.checked }) });
  box.checked = Boolean(view.on);
  const envBoxes = (view.candidates ?? []).map((item) => {
    const input = el('input', { type: 'checkbox', name: 'worktree-env', value: item.name, disabled: busy || finished || !item.exists });
    input.checked = (view.env ?? []).includes(item.name);
    return { item, input };
  });
  const setup = view.setup ?? null;
  return el('section', { class: `pm-worktrees pm-worktrees-${view.on ? 'on' : 'off'}`, 'aria-label': t('worktrees.title'), dataset: { worktrees: view.on ? 'on' : 'off' } },
    el('div', { class: 'agent-head' }, el('span', { class: 'kind', text: t('worktrees.title') }),
      el('span', { class: `badge${view.on ? ' pm-auto-badge' : ''}`, text: view.on ? t('worktrees.on') : t('worktrees.off') }),
      view.on && view.by ? el('span', { class: 'kind', text: t('worktrees.onLine', view.by, timeLabel(view.at)) }) : null),
    el('label', { class: 'trigger-check pm-worktree-check pm-worktrees-toggle' }, box, el('span', { class: 'pm-worktree-text' }, el('strong', { text: t('worktrees.checkbox') }),
      el('small', { class: 'kind', text: view.locked ? t('worktrees.lockedHint') : t('worktrees.checkboxHint') }))),
    view.on ? el('fieldset', { class: 'pm-pick-box pm-worktree-env' }, el('legend', { text: t('worktrees.envTitle') }),
      el('p', { class: 'kind', text: t('worktrees.envHint') }),
      envBoxes.map(({ item, input }) => el('label', { class: 'trigger-check', dataset: { name: item.name } }, input, el('code', { translate: 'no', text: item.name }),
        item.exists ? null : el('span', { class: 'kind', text: t('worktrees.envMissing') }))),
      el('button', { type: 'button', class: 'pm-worktree-env-save', disabled: busy || finished, text: t('worktrees.envSave'),
        onclick: () => set(goal, { env: envBoxes.filter(({ input }) => input.checked).map(({ item }) => item.name) }) })) : null,
    view.on && setup ? el('div', { class: 'pm-worktree-setup', dataset: { state: setup.state } },
      el('p', { class: 'kind' }, t('worktrees.setupLine'), ' ', el('code', { translate: 'no', text: 'docs/wax/worktree.json' }), ' · ',
        el('span', { class: `badge pm-worktree-setup-${setup.state}`, text: t(STATE_TEXT[setup.state] ?? setup.state) })),
      setup.reason ? el('p', { class: 'kind', text: setup.reason }) : null,
      setup.state !== 'none' && !review ? el('button', { type: 'button', class: 'pm-worktree-review-open', disabled: busy, text: t('worktrees.reviewOpen'), onclick: () => openReview(goal) }) : null,
      review ? setupReviewView(review, { busy, approve: (hash) => approve(goal, hash), close: () => closeReview(goal) }) : null) : null,
    view.entries?.length ? el('ul', { class: 'pm-worktree-list' }, view.entries.map((entry) => entryItem(goal, entry, { busy, view, imports, preview, confirm, cancel, ask, discard }))) : null,
    view.cleanable || imports?.get(`${goal.id}:cleanup`) ? cleanupBlock(goal, { busy, imports, ask, cancel, cleanup }) : null,
    view.on ? el('p', { class: 'kind pm-worktree-git', text: t('worktrees.gitNote') }) : null);
}
