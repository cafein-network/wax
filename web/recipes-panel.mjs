import { t } from './messages-catalog.mjs';
import { api, clear, el } from './dom.mjs';
import { phaseName } from './thread-model.mjs';
import { allowFields, allowKindLabel } from './goal-allow.mjs';
import { worktreeField } from './worktrees.mjs';

const BUDGETS = [['phaseRuns', t('pmLoop.budgetLabel.phaseRuns')], ['workers', t('pmLoop.budgetLabel.workers')], ['hours', t('pmLoop.budgetLabel.hours')], ['iterations', t('pmLoop.budgetLabel.iterations')], ['failures', t('pmLoop.budgetLabel.failures')], ['autoPerHour', t('pmLoop.budgetLabel.autoPerHour')]];
const SOURCE_LABELS = { builtin: t('recipes.source.builtin'), local: t('recipes.source.local'), shared: t('recipes.source.shared') };
const APPROVAL_LABELS = { approved: t('recipes.approval.approved'), pending: t('recipes.approval.pending'), changed: t('recipes.approval.changed'),
  rejected: t('recipes.approval.rejected'), retired: t('recipes.approval.retired') };
const canStart = (entry) => Boolean(entry.active && entry.usable && (entry.source !== 'shared' || entry.approval?.state === 'approved'));
const usesDetails = (recipe) => Boolean(recipe?.input?.details || recipe?.tasks?.some((task) => /\{details\}/.test(task.description ?? ''))
  || Object.values(recipe?.notes ?? {}).some((note) => /\{details\}/.test(note)));
const raw = (text, tag = 'span') => el(tag, { translate: 'no', text });
const recipeText = (entry, text, tag = 'span') => (entry.source === 'builtin' ? el(tag, { text }) : raw(text, tag));
const field = (label, control, extra = {}) => el('label', { class: 'trigger-field', ...extra }, el('span', { text: label }), control);

function template() {
  return { schema: 1, id: 'my-recipe', title: t('recipes.template.title'), input: { label: t('recipes.template.label') }, goal: '{input}',
    tasks: [{ id: 'task-{slug}', title: '{input}', ac: [t('recipes.template.ac')] }], workers: {}, budgets: {}, mode: 'suggest', notes: {} };
}

export function recipeItem(entry, { start, edit, remove, review = () => {}, share = () => {}, busy = false }) {
  const recipe = entry.recipe;
  const approval = entry.source === 'shared' ? entry.approval?.state ?? 'pending' : null;
  return el('li', { class: `pm-recipe${entry.usable ? '' : ' pm-recipe-unusable'}`, dataset: { recipe: entry.id, source: entry.source, usable: String(entry.usable) } },
    el('div', { class: 'agent-head' },
      recipe ? recipeText(entry, recipe.title, 'strong') : raw(entry.id, 'strong'),
      el('code', { class: 'kind', translate: 'no', text: entry.id }),
      el('span', { class: 'badge', text: SOURCE_LABELS[entry.source] ?? entry.source }),
      !entry.usable ? el('span', { class: 'badge pm-recipe-bad', text: t('recipes.unusable') }) : null,
      approval ? el('span', { class: `badge pm-recipe-approval pm-recipe-approval-${approval}`, dataset: { approval }, text: APPROVAL_LABELS[approval] ?? approval }) : null,
      entry.shadowedBy ? el('span', { class: 'badge', text: t('recipes.shadowed', SOURCE_LABELS[entry.shadowedBy] ?? entry.shadowedBy) }) : null,
      recipe?.mode === 'auto' ? el('span', { class: 'badge pm-recipe-auto', text: t('recipes.autoRecommended') }) : null),
    recipe?.description ? el('p', { class: 'kind' }, recipeText(entry, recipe.description)) : null,
    !entry.usable ? el('p', { class: 'error pm-recipe-reason', translate: 'no', text: `${entry.file}: ${entry.reason}` }) : null,
    el('div', { class: 'row proposal-actions' },
      canStart(entry) ? el('button', { type: 'button', class: 'primary pm-recipe-start-button', disabled: busy, text: t('recipes.start'), onclick: () => start(entry) }) : null,
      entry.source === 'shared' ? el('button', { type: 'button', class: `${approval === 'approved' ? '' : 'primary '}pm-recipe-review-button`, disabled: busy, text: t('recipes.review'), onclick: () => review(entry) }) : null,
      entry.source === 'local' || (entry.usable && !entry.shadowedBy && (entry.source !== 'shared' || approval === 'approved'))
        ? el('button', { type: 'button', class: 'pm-recipe-edit', disabled: busy, text: entry.source === 'local' ? t('recipes.edit') : t('recipes.copyToLocal'), onclick: () => edit(entry) }) : null,
      entry.source === 'local' && entry.usable ? el('button', { type: 'button', class: 'pm-recipe-export', disabled: busy, text: t('recipes.export'), onclick: () => { if (confirm(t('recipes.confirmExport', entry.id))) share(entry); } }) : null,
      entry.source === 'local' ? el('button', { type: 'button', class: 'link pm-recipe-delete', disabled: busy, text: t('recipes.delete'), onclick: () => { if (confirm(t('recipes.confirmDelete', entry.id))) remove(entry); } }) : null));
}

function toolSelect(name, value, toolOptions, defaultLabel) {
  const options = [{ id: '', label: defaultLabel }, ...toolOptions];
  if (value && !toolOptions.some((item) => item.id === value)) options.push({ id: value, label: t('recipes.notInstalled', value) });
  return el('select', { name }, options.map((item) => el('option', { value: item.id, selected: item.id === (value ?? '') || undefined, text: item.label })));
}

export function startEditor(entry, filled, { phases, toolOptions = [], defaults = {} }) {
  const title = el('input', { name: 'recipe-title', maxlength: '200', translate: 'no', value: filled.title });
  const tasks = filled.tasks.map((task) => {
    const id = el('input', { name: 'recipe-task-id', maxlength: '64', translate: 'no', value: task.id });
    const name = el('input', { name: 'recipe-task-title', maxlength: '200', translate: 'no', value: task.title });
    const ac = el('textarea', { name: 'recipe-task-ac', rows: String(Math.min(6, Math.max(2, task.ac.length))), translate: 'no' });
    ac.value = task.ac.join('\n');
    return { node: el('fieldset', { class: 'pm-pick-box pm-plan-task pm-recipe-task' }, el('legend', { text: t('recipes.task') }),
      field(t('recipes.taskId'), id), field(t('pmLoop.judge.fieldTitle'), name), field(t('pmLoop.judge.fieldAc'), ac)),
    read: () => ({ id: id.value.trim(), title: name.value, ac: ac.value.split('\n').map((line) => line.trim()).filter(Boolean) }) };
  });
  const workers = Object.fromEntries(phases.map((phase) => [phase, toolSelect(`worker-${phase}`, filled.workers[phase] ?? null, toolOptions, t('recipes.defaultOrder'))]));
  const judge = toolSelect('recipe-judge-tool', filled.judgeTool, toolOptions, t('recipes.defaultOrder'));
  const budgets = el('div', { class: 'trigger-grid pm-budgets' }, BUDGETS.map(([name, label]) => field(label,
    el('input', { type: 'number', name, min: name === 'iterations' ? '0' : '1', value: String(filled.budgets?.[name] ?? defaults[name] ?? '') }))));
  const notes = Object.entries(filled.notes ?? {});
  const node = el('div', { class: 'pm-recipe-values' },
    field(t('pmLoop.field.title'), title),
    tasks.map((item) => item.node),
    el('fieldset', { class: 'pm-pick-box' }, el('legend', { text: t('recipes.workers') }),
      el('div', { class: 'trigger-grid' }, phases.map((phase) => field(phaseName(phase), workers[phase], { class: 'trigger-field pm-tool' })))),
    el('p', { class: 'kind', text: t('recipes.workersHint') }),
    field(t('pmLoop.judge.toolLabel'), judge, { class: 'trigger-field pm-tool' }),
    el('details', { class: 'pm-recipe-budgets', open: true }, el('summary', { text: t('pmLoop.budgetTitle') }), budgets),
    notes.length ? el('div', { class: 'pm-recipe-notes' }, el('h4', { text: t('recipes.notes') }), el('p', { class: 'kind', text: t('recipes.notesHint') }),
      notes.map(([phase, note]) => el('p', { class: 'kind' }, el('strong', { text: `${phaseName(phase)} ` }), recipeText(entry, note)))) : null,
    filled.mode === 'auto' ? el('p', { class: 'kind pm-recipe-auto-note', text: t('recipes.autoNote') }) : null,
    el('p', { class: 'kind', text: t('recipes.planningHint') }));
  const read = () => ({
    title: title.value,
    tasks: tasks.map((item) => item.read()),
    workers: Object.fromEntries(Object.entries(workers).filter(([, select]) => select.value).map(([phase, select]) => [phase, select.value])),
    judgeTool: judge.value || null,
    budgets: Object.fromEntries([...budgets.querySelectorAll('input[type="number"]')].map((input) => [input.name, input.value === '' ? undefined : Number(input.value)])),
  });
  return { node, read };
}

export function mountRecipes({ token, onCreated = () => {}, showError = () => {} }) {
  let data = null, busy = false, picked = null, filled = null, editor = null, editing = null, from = null, allowBox = null, worktreeBox = null, origin = null;
  const list = el('ul', { class: 'note-list pm-recipe-list' });
  const errorBox = el('p', { class: 'error', role: 'alert', hidden: true });
  const notice = el('p', { class: 'kind pm-recipe-notice', role: 'status', hidden: true });
  const fail = (error) => { errorBox.hidden = !error; errorBox.textContent = error?.message ?? ''; if (error) { showError(null); say(null); } };
  const say = (text) => { notice.hidden = !text; notice.textContent = text ?? ''; };
  const startTitle = el('h3', {});
  const input = el('input', { name: 'recipe-input', maxlength: '200', translate: 'no' });
  const inputLabel = el('span', {});
  const slug = el('input', { name: 'recipe-slug', maxlength: '40', translate: 'no' });
  const details = el('textarea', { name: 'recipe-details', rows: '4', maxlength: '2000', translate: 'no' });
  const detailsLabel = el('span', {});
  const detailsField = el('label', { class: 'trigger-field pm-recipe-details', hidden: true }, detailsLabel, details, el('small', { class: 'kind', text: t('recipes.detailsHint') }));
  const values = el('div', {});
  const create = el('button', { type: 'submit', class: 'primary', text: t('pmLoop.create'), disabled: true });
  const startForm = el('form', { class: 'pm-recipe-form pm-recipe-start', hidden: true },
    startTitle,
    el('label', { class: 'trigger-field' }, inputLabel, input),
    detailsField,
    el('div', { class: 'trigger-grid' }, field(t('recipes.slug'), slug),
      el('div', { class: 'row pm-recipe-fill-row' }, el('button', { type: 'button', class: 'pm-recipe-fill', text: t('recipes.fill'), onclick: () => fill() }))),
    el('small', { class: 'kind', text: t('recipes.slugHint') }),
    values,
    el('div', { class: 'row' }, create, el('button', { type: 'button', text: t('pmLoop.cancel'), onclick: () => closeStart() })));
  startForm.addEventListener('submit', (event) => { event.preventDefault(); void submit(); });
  const editorTitle = el('h3', {});
  const json = el('textarea', { name: 'recipe-json', rows: '16', translate: 'no', spellcheck: 'false', class: 'pm-recipe-json' });
  const editForm = el('form', { class: 'pm-recipe-form pm-recipe-editor', hidden: true },
    editorTitle, el('p', { class: 'kind', text: t('recipes.editorHint') }), json,
    el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary', text: t('recipes.save') }), el('button', { type: 'button', text: t('pmLoop.cancel'), onclick: () => closeEditor() })));
  editForm.addEventListener('submit', (event) => { event.preventDefault(); void save(); });
  const editorHint = el('p', { class: 'kind pm-recipe-draft-hint', hidden: true, text: t('recipes.draftHint') });
  editorTitle.after(editorHint);
  const reviewForm = el('section', { class: 'pm-recipe-form pm-recipe-review', hidden: true });
  const manualLine = el('div', { class: 'pm-manual' });
  const manualForm = el('section', { class: 'pm-recipe-form pm-manual-review', hidden: true });
  const newButton = el('button', { type: 'button', class: 'new-trigger pm-recipe-create', text: t('recipes.new'), onclick: () => openEditor(null) });
  const node = el('section', { class: 'pm-recipes', hidden: true, 'aria-labelledby': 'pm-recipes-heading' },
    el('h3', { id: 'pm-recipes-heading', text: t('recipes.title') }), el('p', { class: 'kind', text: t('recipes.intro') }),
    errorBox, notice, manualLine, manualForm, list, newButton, startForm, editForm, reviewForm);

  function render() {
    if (!data) return;
    const items = data.recipes.map((entry) => recipeItem(entry, { start: openStart, edit: openEditor, remove, review: openReview, share, busy }));
    clear(list).append(...(items.length ? items : [el('li', { class: 'kind', text: t('recipes.empty') })]));
    for (const [where, count] of Object.entries(data.skipped ?? {})) if (count) list.append(el('li', { class: 'kind', text: t('recipes.skipped', count, SOURCE_LABELS[where] ?? where) }));
    for (const issue of data.issues ?? []) list.append(el('li', { class: 'error', text: issue }));
  }
  async function refresh() {
    try { data = await api('/api/recipes'); render(); } catch (error) { fail(error); }
    try { renderManual(await api('/api/manual')); } catch (error) { fail(error); }
  }

  function openStart(entry) {
    fail(null); closeEditor(); closeReview();
    picked = entry; filled = null; editor = null;
    clear(startTitle).append(t('recipes.startTitle'), ' ', recipeText(entry, entry.recipe.title));
    clear(inputLabel).append(recipeText(entry, entry.recipe.input.label));
    input.value = ''; slug.value = '';
    input.placeholder = entry.recipe.input.example ?? '';
    details.value = '';
    detailsField.hidden = !usesDetails(entry.recipe);
    clear(detailsLabel).append(entry.recipe.input.details ? recipeText(entry, entry.recipe.input.details.label) : t('recipes.detailsLabel'));
    details.placeholder = entry.recipe.input.details?.example ?? '';
    clear(values); create.disabled = true;
    startForm.hidden = false;
    input.focus();
  }
  function closeStart() { startForm.hidden = true; picked = null; filled = null; editor = null; allowBox = null; worktreeBox = null; origin = null; clear(values); }
  async function fill() {
    if (!picked) return;
    fail(null);
    const query = new URLSearchParams({ input: input.value, ...(slug.value.trim() ? { slug: slug.value.trim() } : {}) });
    try {
      filled = await api(`/api/recipes/${picked.id}/fill?${query}`);
      slug.value = filled.slug;
      editor = startEditor(picked, filled, { phases: data.phases, toolOptions: data.toolOptions ?? [], defaults: data.defaults ?? {} });
      const checks = (await api('/api/manual/checks').catch(() => null))?.checks ?? [];
      allowBox = allowFields({ suggested: filled.allow ?? [], checks });
      worktreeBox = worktreeField();
      clear(values).append(editor.node, allowBox.node, worktreeBox.node);
      create.disabled = false;
    } catch (error) { fail(error); }
  }
  async function submit() {
    if (!picked || !filled || !editor || busy) return;
    busy = true; create.disabled = true; fail(null);
    try {
      const ref = { id: picked.id, hash: filled.hash, input: filled.input, slug: filled.slug, ...(detailsField.hidden || !details.value.trim() ? {} : { details: details.value }) };
      const goal = await api('/api/pm-loop', { method: 'POST', token: token(), body: { recipe: ref, ...editor.read(), allow: allowBox?.read() ?? { kinds: [] }, worktrees: worktreeBox?.read() ?? false, ...(origin ? { origin } : {}) } });
      closeStart();
      close();
      await onCreated(goal);
    } catch (error) { fail(error); create.disabled = false; }
    finally { busy = false; }
  }

  function openEditor(entry, draft = null) {
    fail(null); closeStart(); closeReview();
    editing = entry?.source === 'local' ? entry.id : null;
    from = draft?.from ?? null;
    editorHint.hidden = !from;
    editorTitle.textContent = entry ? (entry.source === 'local' ? t('recipes.editTitle', entry.id) : t('recipes.copyTitle', entry.id)) : t('recipes.newTitle');
    if (draft) editorTitle.textContent = t('recipes.draftTitle', draft.from);
    json.value = entry?.source === 'local' && typeof entry.text === 'string' ? entry.text : `${JSON.stringify(draft?.draft ?? entry?.recipe ?? template(), null, 2)}\n`;
    editForm.hidden = false;
    json.focus();
  }
  function closeEditor() { editForm.hidden = true; editing = null; from = null; editorHint.hidden = true; }
  async function save() {
    let value;
    try { value = JSON.parse(json.value); } catch (error) { fail(new Error(t('recipes.notJson', error.message))); return; }
    try {
      await api('/api/recipes', { method: 'POST', token: token(), body: { recipe: value, ...(editing ? { previous: editing } : {}), ...(from ? { from } : {}) } });
      closeEditor();
      await refresh();
    } catch (error) { fail(error); }
  }
  async function remove(entry) {
    busy = true; render();
    try { await api(`/api/recipes/${entry.id}/delete`, { method: 'POST', token: token(), body: {} }); } catch (error) { fail(error); }
    finally { busy = false; }
    await refresh();
  }

  async function openReview(entry) {
    fail(null); say(null); closeStart(); closeEditor();
    let view;
    try { view = await api(`/api/recipes/${entry.id}/shared`); } catch (error) { fail(error); return; }
    const state = view.approval?.state ?? 'pending';
    const decide = (action) => async () => {
      if (action === 'retire' && !confirm(t('recipes.confirmRetire', view.id))) return;
      try { await api(`/api/recipes/${view.id}/shared/${action}`, { method: 'POST', token: token(), body: { hash: view.hash } }); closeReview(); await refresh(); }
      catch (error) { fail(error); }
    };
    const diff = view.diff
      ? (view.diff.every((line) => line.op === 'same') ? el('p', { class: 'kind pm-recipe-same', text: t('recipes.reviewSame') })
        : el('pre', { class: 'pm-recipe-diff', translate: 'no' }, view.diff.map((line) => el('span', { class: `pm-diff-${line.op}`, text: `${line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '} ${line.line}\n` }))))
      : el('p', { class: 'kind pm-recipe-first', text: t('recipes.reviewNoPrevious') });
    clear(reviewForm).append(
      el('h3', { text: t('recipes.reviewTitle', view.id) }),
      el('p', { class: 'kind', text: t('recipes.reviewHint') }),
      el('p', { class: 'kind' }, el('span', { class: `badge pm-recipe-approval pm-recipe-approval-${state}`, dataset: { approval: state }, text: APPROVAL_LABELS[state] ?? state }), ' ',
        el('code', { translate: 'no', text: t('recipes.reviewFile', view.file, (view.hash ?? '-').slice(0, 12)) })),
      view.usable ? null : el('p', { class: 'error pm-recipe-reason', translate: 'no', text: `${view.file}: ${view.reason}` }),
      view.recipe?.allow?.length ? el('p', { class: 'kind pm-recipe-allow', text: t('goalAllow.recipeAllow', view.recipe.allow.map(allowKindLabel).join(', ')) }) : null,
      el('h4', { text: t('recipes.reviewNormalized') }),
      el('pre', { class: 'pm-recipe-normalized', translate: 'no', text: view.normalized ?? view.text ?? '' }),
      view.previous ? el('h4', { text: t('recipes.reviewDiff', `${view.previous.by} · ${view.previous.hash.slice(0, 12)}`) }) : null,
      view.usable ? diff : null,
      view.history?.length ? el('details', { class: 'pm-recipe-history' }, el('summary', { text: t('recipes.reviewHistory') }),
        el('ul', {}, view.history.map((item) => el('li', { class: 'kind', translate: 'no',
          text: `${item.at} · ${APPROVAL_LABELS[item.decision] ?? item.decision}${item.exported ? ` (${t('recipes.reviewExported')})` : ''} · ${item.by} · ${item.hash.slice(0, 12)}` })))) : null,
      el('div', { class: 'row' },
        view.usable && state !== 'approved' ? el('button', { type: 'button', class: 'primary pm-recipe-approve', text: t('recipes.approve'), onclick: decide('approve') }) : null,
        state !== 'approved' && state !== 'rejected' ? el('button', { type: 'button', class: 'pm-recipe-reject', text: t('recipes.rejectShared'), onclick: decide('reject') }) : null,
        ['approved', 'changed'].includes(state) ? el('button', { type: 'button', class: 'pm-recipe-retire', text: t('recipes.retire'), onclick: decide('retire') }) : null,
        el('button', { type: 'button', text: t('pmLoop.cancel'), onclick: () => closeReview() })));
    reviewForm.hidden = false;
    reviewForm.scrollIntoView?.({ block: 'nearest' });
  }
  function closeReview() { reviewForm.hidden = true; clear(reviewForm); }
  function renderManual(view) {
    const state = view.approval?.state ?? 'pending';
    const used = view.usable && state === 'approved';
    clear(manualLine).append(el('div', { class: 'agent-head' }, el('strong', { text: t('manual.title') }),
      view.exists ? el('span', { class: `badge pm-recipe-approval pm-recipe-approval-${state}`, dataset: { approval: state }, text: APPROVAL_LABELS[state] ?? state }) : null,
      view.exists ? el('span', { class: `kind pm-manual-use`, dataset: { used: used ? 'yes' : 'no' }, text: used ? t('manual.inUse') : t('manual.notInUse') }) : null,
      el('span', { class: 'spacer' }),
      view.exists ? el('button', { type: 'button', class: `${used ? '' : 'primary '}pm-manual-review-button`, text: t('manual.review'), onclick: () => openManual() }) : null),
      el('p', { class: 'kind', text: view.exists ? t('manual.intro') : t('manual.missing') }),
      view.exists && !view.usable ? el('p', { class: 'error pm-manual-reason', translate: 'no', text: `${view.file}: ${view.reason}` }) : null);
  }
  async function openManual() {
    fail(null); say(null); closeStart(); closeEditor(); closeReview();
    let view;
    try { view = await api('/api/manual'); } catch (error) { fail(error); return; }
    renderManual(view);
    const state = view.approval?.state ?? 'pending';
    const decide = (action) => async () => {
      if (action === 'retire' && !confirm(t('manual.confirmRetire'))) return;
      try { await api(`/api/manual/${action}`, { method: 'POST', token: token(), body: { hash: view.hash } }); closeManual(); await refresh(); }
      catch (error) { fail(error); }
    };
    const diff = view.diff
      ? (view.diff.every((line) => line.op === 'same') ? el('p', { class: 'kind pm-recipe-same', text: t('recipes.reviewSame') })
        : el('pre', { class: 'pm-recipe-diff', translate: 'no' }, view.diff.map((line) => el('span', { class: `pm-diff-${line.op}`, text: `${line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '} ${line.line}\n` }))))
      : el('p', { class: 'kind pm-recipe-first', text: t('recipes.reviewNoPrevious') });
    clear(manualForm).append(
      el('h3', { text: t('manual.title') }),
      el('p', { class: 'kind', text: t('manual.reviewHint') }),
      el('p', { class: 'kind' }, el('span', { class: `badge pm-recipe-approval pm-recipe-approval-${state}`, dataset: { approval: state }, text: APPROVAL_LABELS[state] ?? state }), ' ',
        el('code', { translate: 'no', text: t('recipes.reviewFile', view.file, (view.hash ?? '-').slice(0, 12)) })),
      view.usable ? null : el('p', { class: 'error pm-recipe-reason', translate: 'no', text: `${view.file}: ${view.reason ?? '-'}` }),
      el('h4', { text: t('manual.checks') }),
      view.checks?.length ? el('ul', { class: 'pm-manual-checks' }, view.checks.map((command) => el('li', {}, el('code', { translate: 'no', text: command }))))
        : el('p', { class: 'kind', text: t('manual.noChecks') }),
      el('h4', { text: t('manual.body') }),
      el('pre', { class: 'pm-recipe-normalized pm-manual-body', translate: 'no', text: view.body ?? view.text ?? '' }),
      view.previous ? el('h4', { text: t('recipes.reviewDiff', `${view.previous.by} · ${view.previous.hash.slice(0, 12)}`) }) : null,
      view.text !== undefined ? diff : null,
      view.history?.length ? el('details', { class: 'pm-recipe-history' }, el('summary', { text: t('recipes.reviewHistory') }),
        el('ul', {}, view.history.map((item) => el('li', { class: 'kind', translate: 'no', text: `${item.at} · ${APPROVAL_LABELS[item.decision] ?? item.decision} · ${item.by} · ${item.hash.slice(0, 12)}` })))) : null,
      el('div', { class: 'row' },
        view.usable && state !== 'approved' ? el('button', { type: 'button', class: 'primary pm-manual-approve', text: t('manual.approve'), onclick: decide('approve') }) : null,
        view.hash && state !== 'approved' && state !== 'rejected' ? el('button', { type: 'button', class: 'pm-manual-reject', text: t('manual.reject'), onclick: decide('reject') }) : null,
        ['approved', 'changed'].includes(state) ? el('button', { type: 'button', class: 'pm-manual-retire', text: t('manual.retire'), onclick: decide('retire') }) : null,
        el('button', { type: 'button', text: t('pmLoop.cancel'), onclick: () => closeManual() })));
    manualForm.hidden = false;
    manualForm.scrollIntoView?.({ block: 'nearest' });
  }
  function closeManual() { manualForm.hidden = true; clear(manualForm); }
  async function share(entry) {
    fail(null);
    try { const result = await api(`/api/recipes/${entry.id}/export`, { method: 'POST', token: token(), body: {} }); await refresh(); say(t('recipes.exported', result.file)); }
    catch (error) { fail(error); }
  }
  async function openDraft(goalId) {
    node.hidden = false; fail(null); say(null);
    try {
      const [draft] = await Promise.all([api(`/api/pm-loop/${goalId}/recipe-draft`), refresh()]);
      openEditor(null, draft);
      editForm.scrollIntoView?.({ block: 'nearest' });
    } catch (error) { fail(error); }
  }
  function open() { node.hidden = false; void refresh(); }
  async function startFromProposal(id) {
    node.hidden = false; fail(null);
    try {
      const [proposals] = await Promise.all([api('/api/proposals?all=1'), refresh()]);
      const proposal = proposals.proposals.find((item) => item.id === id);
      if (!proposal || proposal.action !== 'recipe' || proposal.status !== 'accepted' || proposal.goal) throw new Error(t('recipes.proposalUnusable'));
      const entry = data?.recipes.find((item) => item.id === proposal.recipe);
      if (!entry) throw new Error(t('recipes.proposalRecipeMissing', proposal.recipe));
      openStart(entry);
      origin = proposal.id;
      input.value = proposal.text;
      if (proposal.details && !detailsField.hidden) details.value = proposal.details;
      say(t('recipes.fromProposal', proposal.triggerName));
      await fill();
    } catch (error) { fail(error); }
  }
  function close() { node.hidden = true; closeStart(); closeEditor(); closeReview(); closeManual(); say(null); }
  return { node, open, close, refresh, openDraft, startFromProposal, toggle: () => (node.hidden ? open() : close()) };
}
