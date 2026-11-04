import { t } from '../web/messages-catalog.mjs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, WaxError } from './workflow.mjs';
import { HIDDEN, JUDGE_LIMITS, validateJudgment } from './chat/pm-judge.mjs';
import { BUDGET_RANGE, DEFAULT_BUDGETS, HEADLESS_TOOLS, MODES, PM_LIMITS, budgetUsage, judgeToolSetting, normalizeBudgets, readDecisions, readGoal, workerRuns } from './chat/pm-loop.mjs';
import { getFeature } from './workflow.mjs';
import { listTasks } from './chat/team.mjs';
import { chatDir, safeDir } from './chat/paths.mjs';
import { withLock } from './chat/lock.mjs';
import { appendRecord, makeId, readRecords, writeJsonAtomic } from './chat/store.mjs';
import * as v from './chat/validate.mjs';

export const RECIPE_LIMITS = { file: 64 * 1024, count: 50, title: 200, description: 500, label: 200, example: 200, goal: 200, input: 200, slug: 40, notes: 1000,
  details: 2000, detailsExample: 500, taskDescription: 1000, filled: 3000,
  tasks: JUDGE_LIMITS.tasks, taskTitle: JUDGE_LIMITS.title, ac: JUDGE_LIMITS.ac, acText: JUDGE_LIMITS.acText };
export const RECIPE_SOURCES = ['local', 'shared', 'builtin'];
const DECISIONS = { approve: 'approved', reject: 'rejected', retire: 'retired' };
const GOAL_ID = /^goal-[a-f0-9]{8}$/;
export const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYS = ['schema', 'id', 'title', 'description', 'input', 'goal', 'tasks', 'workers', 'judgeTool', 'budgets', 'mode', 'notes', 'allow'];
export const RECIPE_ALLOW = ['wax', 'test', 'write', 'read'];
const REQUIRED = ['schema', 'id', 'title', 'input', 'goal', 'tasks'];
const HOLES = new Set(['input', 'slug']);
const DESCRIPTION_HOLES = new Set(['input', 'details']);
const NOTE_HOLES = new Set(['input', 'slug', 'details']);
const NO_HOLES = new Set();
const BUILTIN_DIR = fileURLToPath(new URL('../recipes/', import.meta.url));
export const BUILTIN_TEXT = {
  bugfix: ['recipes.bugfix.title', 'recipes.bugfix.description', 'recipes.bugfix.label', 'recipes.bugfix.example', 'recipes.bugfix.detailsLabel', 'recipes.bugfix.detailsExample',
    'recipes.bugfix.goal', 'recipes.bugfix.ac1', 'recipes.bugfix.ac2', 'recipes.bugfix.noteImplement', 'recipes.bugfix.noteReview'],
  feature: ['recipes.feature.title', 'recipes.feature.description', 'recipes.feature.label', 'recipes.feature.example', 'recipes.feature.detailsLabel', 'recipes.feature.detailsExample',
    'recipes.feature.goal', 'recipes.feature.ac1', 'recipes.feature.ac2', 'recipes.feature.ac3', 'recipes.feature.noteImplement'],
  refactor: ['recipes.refactor.title', 'recipes.refactor.description', 'recipes.refactor.label', 'recipes.refactor.example', 'recipes.refactor.detailsLabel', 'recipes.refactor.detailsExample',
    'recipes.refactor.goal', 'recipes.refactor.ac1', 'recipes.refactor.ac2', 'recipes.refactor.noteImplement'],
};

const fail = (id, status = 400, ...values) => new WaxError(t(id, ...values), status);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const length = (text) => Array.from(text).length;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const absent = (value) => value === undefined || value === null || value === '';

class OutOfSchema extends Error {}
const reject = (why) => { throw new OutOfSchema(why); };
function keys(value, allowed, required, where) {
  if (!isObject(value)) reject(t('pmJudge.schema.notObject', where));
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject(t('pmJudge.schema.extraKey', where, JSON.stringify(key.slice(0, 40))));
  for (const key of required) if (!(key in value)) reject(t('pmJudge.schema.missingKey', where, key));
}
function text(value, max, where, { lines = false, holes = HOLES } = {}) {
  if (typeof value !== 'string' || !value.trim()) reject(t('pmJudge.schema.notText', where));
  if (length(value) > max) reject(t('pmJudge.schema.tooLong', where, max));
  if (HIDDEN.test(value)) reject(t('pmJudge.schema.hidden', where));
  if (!lines && /\n/.test(value)) reject(t('pmJudge.schema.oneLine', where));
  for (const [, name] of value.matchAll(/\{([^{}]*)\}/g)) {
    if (!holes.has(name)) reject(t('recipes.schema.placeholder', where, `{${name.slice(0, 20)}}`, holes.size ? [...holes].map((hole) => `{${hole}}`).join(', ') : t('recipes.schema.noPlaceholder')));
  }
  return value.trim();
}
function phaseMap(value, where, check) {
  if (absent(value)) return {};
  keys(value, PHASES, [], where);
  return Object.fromEntries(Object.entries(value).filter(([, item]) => !absent(item)).map(([phase, item]) => [phase, check(item, `${where}.${phase}`)]));
}
const workerTool = (value, where) => {
  if (!HEADLESS_TOOLS.includes(value)) reject(t('pmJudge.schema.notOneOf', where, HEADLESS_TOOLS.join('|')));
  return value;
};
function budgetsOf(value) {
  if (absent(value)) return {};
  keys(value, Object.keys(DEFAULT_BUDGETS), [], 'budgets');
  try { normalizeBudgets(value); } catch (error) { reject(`budgets: ${error.message}`); }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => !absent(item)).map(([name, item]) => [name, Number(item)]));
}

function allowOf(value) {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > RECIPE_ALLOW.length) reject(t('pmJudge.schema.listSize', 'allow', RECIPE_ALLOW.length));
  value.forEach((kind, index) => { if (!RECIPE_ALLOW.includes(kind)) reject(t('pmJudge.schema.notOneOf', `allow[${index}]`, RECIPE_ALLOW.join('|'))); });
  if (new Set(value).size !== value.length) reject(t('pmJudge.schema.duplicate', 'allow'));
  return RECIPE_ALLOW.filter((kind) => value.includes(kind));
}

export function validateRecipe(value) {
  try {
    keys(value, KEYS, REQUIRED, 'recipe');
    if (value.schema !== 1) reject(t('recipes.schema.version', JSON.stringify(value.schema ?? null).slice(0, 20)));
    if (typeof value.id !== 'string' || !RECIPE_ID.test(value.id) || value.id in Object.prototype) reject(t('pmJudge.schema.badId', 'id'));
    const title = text(value.title, RECIPE_LIMITS.title, 'title', { holes: NO_HOLES });
    const description = absent(value.description) ? '' : text(value.description, RECIPE_LIMITS.description, 'description', { lines: true, holes: NO_HOLES });
    keys(value.input, ['label', 'example', 'details'], ['label'], 'input');
    let details = null;
    if (!absent(value.input.details)) {
      keys(value.input.details, ['label', 'example'], ['label'], 'input.details');
      details = { label: text(value.input.details.label, RECIPE_LIMITS.label, 'input.details.label', { holes: NO_HOLES }),
        example: absent(value.input.details.example) ? null : text(value.input.details.example, RECIPE_LIMITS.detailsExample, 'input.details.example', { lines: true, holes: NO_HOLES }) };
    }
    const input = { label: text(value.input.label, RECIPE_LIMITS.label, 'input.label', { holes: NO_HOLES }),
      example: absent(value.input.example) ? null : text(value.input.example, RECIPE_LIMITS.example, 'input.example', { holes: NO_HOLES }), details };
    const goal = text(value.goal, RECIPE_LIMITS.goal, 'goal');
    if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > RECIPE_LIMITS.tasks) reject(t('pmJudge.schema.listSize', 'tasks', RECIPE_LIMITS.tasks));
    const seen = new Set();
    const tasks = value.tasks.map((task, index) => {
      const where = `tasks[${index}]`;
      keys(task, ['id', 'title', 'description', 'ac'], ['id', 'title', 'ac'], where);
      if (typeof task.id !== 'string' || /\{input\}/.test(task.id)) reject(t('pmJudge.schema.badId', `${where}.id`));
      const id = text(task.id, 64, `${where}.id`);
      if (id !== task.id || !RECIPE_ID.test(id.replace(/\{slug\}/g, 'x'))) reject(t('pmJudge.schema.badId', `${where}.id`));
      if (seen.has(id)) reject(t('pmJudge.schema.duplicate', `${where}.id`));
      seen.add(id);
      if (!Array.isArray(task.ac) || !task.ac.length || task.ac.length > RECIPE_LIMITS.ac) reject(t('pmJudge.schema.listSize', `${where}.ac`, RECIPE_LIMITS.ac));
      const taskTitle = text(task.title, RECIPE_LIMITS.taskTitle, `${where}.title`);
      const taskDescription = absent(task.description) ? null : text(task.description, RECIPE_LIMITS.taskDescription, `${where}.description`, { lines: true, holes: DESCRIPTION_HOLES });
      return { id, title: taskTitle, ...(taskDescription ? { description: taskDescription } : {}), ac: task.ac.map((item, n) => text(item, RECIPE_LIMITS.acText, `${where}.ac[${n}]`)) };
    });
    const workers = phaseMap(value.workers, 'workers', workerTool);
    if (!absent(value.judgeTool)) workerTool(value.judgeTool, 'judgeTool');
    const budgets = budgetsOf(value.budgets);
    const mode = absent(value.mode) ? 'suggest' : value.mode;
    if (!MODES.includes(mode)) reject(t('pmJudge.schema.notOneOf', 'mode', MODES.join('|')));
    const notes = phaseMap(value.notes, 'notes', (item, where) => text(item, RECIPE_LIMITS.notes, where, { lines: true, holes: NOTE_HOLES }));
    const allow = allowOf(value.allow);
    return { ok: true, recipe: { schema: 1, id: value.id, title, description, input, goal, tasks, workers, judgeTool: absent(value.judgeTool) ? null : value.judgeTool, budgets, mode, notes, allow } };
  } catch (error) {
    if (error instanceof OutOfSchema) return { ok: false, reason: error.message };
    throw error;
  }
}

export function parseRecipe(textValue) {
  if (typeof textValue !== 'string') return { ok: false, reason: t('pmJudge.schema.notJson') };
  if (Buffer.byteLength(textValue) > RECIPE_LIMITS.file) return { ok: false, reason: t('recipes.check.tooLarge', RECIPE_LIMITS.file / 1024) };
  let value;
  try { value = JSON.parse(textValue); } catch { return { ok: false, reason: t('pmJudge.schema.notJson') }; }
  return validateRecipe(value);
}

function stored(recipe) {
  const out = { schema: 1, id: recipe.id, title: recipe.title };
  if (recipe.description) out.description = recipe.description;
  out.input = { label: recipe.input.label, ...(recipe.input.example ? { example: recipe.input.example } : {}),
    ...(recipe.input.details ? { details: { label: recipe.input.details.label, ...(recipe.input.details.example ? { example: recipe.input.details.example } : {}) } } : {}) };
  Object.assign(out, { goal: recipe.goal, tasks: recipe.tasks });
  if (Object.keys(recipe.workers).length) out.workers = recipe.workers;
  if (recipe.judgeTool) out.judgeTool = recipe.judgeTool;
  if (Object.keys(recipe.budgets).length) out.budgets = recipe.budgets;
  out.mode = recipe.mode;
  if (Object.keys(recipe.notes).length) out.notes = recipe.notes;
  if (recipe.allow?.length) out.allow = recipe.allow;
  return out;
}


const FOLDERS = { local: '.wax/recipes', shared: 'docs/wax/recipes', builtin: 'recipes' };
async function readEntry(dir, name, source) {
  const id = name.slice(0, -'.json'.length);
  const base = { id, source, file: `${FOLDERS[source]}/${name}` };
  try {
    const info = await lstat(join(dir, name));
    if (info.isSymbolicLink() || !info.isFile()) return { ...base, usable: false, reason: t('recipes.check.notFile') };
    if (info.size > RECIPE_LIMITS.file) return { ...base, usable: false, reason: t('recipes.check.tooLarge', RECIPE_LIMITS.file / 1024) };
    const content = await readFile(join(dir, name), 'utf8');
    const own = source === 'builtin' ? {} : { text: content };
    const checked = parseRecipe(content);
    const hash = sha(content);
    if (!checked.ok) return { ...base, hash, usable: false, reason: checked.reason, ...own };
    if (checked.recipe.id !== id) return { ...base, hash, usable: false, reason: t('recipes.check.idMismatch', checked.recipe.id, name), ...own };
    return { ...base, hash, usable: true, recipe: checked.recipe, ...own };
  } catch (error) {
    return { ...base, usable: false, reason: t('recipes.check.unreadable', error.code ?? String(error.message).slice(0, 200)) };
  }
}

async function readSource(dir, source) {
  if (!dir) return { entries: [], skipped: 0 };
  let names;
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { entries: [], skipped: 0 }; throw error; }
  const entries = [];
  for (const name of names.slice(0, RECIPE_LIMITS.count)) entries.push(await readEntry(dir, name, source));
  return { entries, skipped: Math.max(0, names.length - RECIPE_LIMITS.count) };
}

const localDir = (root, create = false) => safeDir(root, ['.wax', 'recipes'], { create });
const sharedDir = (root, create = false) => safeDir(root, ['docs', 'wax', 'recipes'], { create });
const auditFile = async (root, create = false) => { const dir = await chatDir(root, null, { create }); return dir && join(dir, 'recipes.jsonl'); };

async function sharedDecisions(root) {
  const file = await auditFile(root);
  if (!file) return [];
  return (await readRecords(file)).records.filter((record) => record.kind === 'shared' && typeof record.recipe === 'string' && typeof record.hash === 'string'
    && Object.values(DECISIONS).includes(record.decision));
}

export function approvalState(entry, decisions = []) {
  const mine = decisions.filter((record) => record.recipe === entry.id);
  const last = mine.at(-1) ?? null;
  const approved = mine.filter((record) => record.decision === 'approved').at(-1) ?? null;
  let state = 'pending';
  if (last?.decision === 'approved') state = last.hash === entry.hash ? 'approved' : 'changed';
  else if (last?.decision === 'rejected') state = last.hash === entry.hash ? 'rejected' : approved ? 'changed' : 'pending';
  else if (last?.decision === 'retired') state = 'retired';
  return { state, approvedHash: approved?.hash ?? null, decision: last?.decision ?? null, by: last?.by ?? null, at: last?.at ?? null };
}

export const startable = (entry) => Boolean(entry?.usable && (entry.source !== 'shared' || entry.approval?.state === 'approved'));

export async function listRecipes(root, { builtinDir = BUILTIN_DIR } = {}) {
  const issues = [];
  let local = { entries: [], skipped: 0 }, shared = { entries: [], skipped: 0 }, decisions = [];
  try { local = await readSource(await localDir(root), 'local'); } catch (error) { issues.push(t('recipes.check.localDir', String(error.message).slice(0, 200))); }
  try { shared = await readSource(await sharedDir(root), 'shared'); } catch (error) { issues.push(t('recipes.check.sharedDir', String(error.message).slice(0, 200))); }
  if (shared.entries.length) {
    try { decisions = await sharedDecisions(root); } catch (error) { issues.push(t('recipes.check.approvals', String(error.message).slice(0, 200))); }
  }
  for (const entry of shared.entries) entry.approval = approvalState(entry, decisions);
  const builtin = await readSource(builtinDir, 'builtin');
  const all = [...local.entries, ...shared.entries, ...builtin.entries];
  const winner = new Map();
  for (const entry of all) if (!winner.has(entry.id) && (entry.usable || entry.source === 'shared')) winner.set(entry.id, entry);
  const recipes = all.map((entry) => {
    const first = winner.get(entry.id);
    return { ...entry, active: first === entry, ...(first === entry && entry.source === 'shared' && entry.usable && !startable(entry) ? { needsApproval: true } : {}),
      ...(entry.usable && first && first !== entry ? { shadowedBy: first.source } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id) || RECIPE_SOURCES.indexOf(a.source) - RECIPE_SOURCES.indexOf(b.source));
  return { recipes, skipped: { local: local.skipped, shared: shared.skipped, builtin: builtin.skipped }, issues, order: RECIPE_SOURCES };
}

export async function getRecipe(root, id, options) {
  if (typeof id !== 'string' || !RECIPE_ID.test(id)) throw fail('errors.recipes.invalidId');
  const { recipes } = await listRecipes(root, options);
  const found = recipes.find((entry) => entry.id === id && entry.active);
  if (found && !found.usable) throw fail('errors.recipes.unusable', 409, id, found.reason);
  if (found && !startable(found)) throw fail('errors.recipes.needsApproval', 409, id, t(`recipes.approval.${found.approval.state}`));
  if (found) return found;
  const broken = recipes.find((entry) => entry.id === id);
  if (broken) throw fail('errors.recipes.unusable', 409, id, broken.reason);
  throw fail('errors.recipes.notFound', 404, id);
}


export function slugify(input) {
  const ascii = String(input).normalize('NFKD').toLowerCase().replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, RECIPE_LIMITS.slug).replace(/-+$/, '');
  return ascii || sha(String(input)).slice(0, 8);
}

function inputLine(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('errors.recipes.inputMissing');
  const line = value.replace(/\s+/g, ' ').trim();
  if (length(line) > RECIPE_LIMITS.input) throw fail('errors.recipes.inputTooLong', 400, RECIPE_LIMITS.input);
  if (HIDDEN.test(line)) throw fail('errors.recipes.inputHidden');
  return line;
}

function detailsText(value) {
  if (absent(value)) return '';
  if (typeof value !== 'string') throw fail('errors.recipes.detailsInvalid');
  const textValue = value.replace(/\r\n?/g, '\n').trim();
  if (length(textValue) > RECIPE_LIMITS.details) throw fail('errors.recipes.detailsTooLong', 400, RECIPE_LIMITS.details);
  if (HIDDEN.test(textValue)) throw fail('errors.recipes.detailsHidden');
  return textValue;
}

export const usesDetails = (recipe) => Boolean(recipe?.input?.details || recipe?.tasks?.some((task) => /\{details\}/.test(task.description ?? ''))
  || Object.values(recipe?.notes ?? {}).some((note) => /\{details\}/.test(note)));

export function fillRecipe(recipe, { input, slug, details } = {}) {
  const line = inputLine(input);
  const piece = absent(slug) ? slugify(line) : String(slug);
  if (!SLUG.test(piece)) throw fail('errors.recipes.slugInvalid', 400, RECIPE_LIMITS.slug);
  const extra = detailsText(details);
  const fill = (template) => template.replace(/\{(input|slug|details)\}/g, (hole, name) => (name === 'input' ? line : name === 'slug' ? piece : extra));
  const checked = validateJudgment('plan', { tasks: recipe.tasks.map((task) => ({ id: fill(task.id), title: fill(task.title), ac: task.ac.map(fill) })), reason: '-' });
  if (!checked.ok) throw fail('errors.recipes.filledInvalid', 400, checked.reason);
  const title = fill(recipe.goal);
  if (length(title) > PM_LIMITS.title) throw fail('errors.recipes.filledInvalid', 400, t('pmJudge.schema.tooLong', 'goal', PM_LIMITS.title));
  const filledLong = (value, where) => {
    const out = value.trim();
    if (length(out) > RECIPE_LIMITS.filled) throw fail('errors.recipes.filledInvalid', 400, t('pmJudge.schema.tooLong', where, RECIPE_LIMITS.filled));
    return out;
  };
  const descriptions = recipe.tasks.map((task, index) => (task.description ? filledLong(fill(task.description), `tasks[${index}].description`) : ''));
  const notes = Object.fromEntries(Object.entries(recipe.notes).map(([phase, note]) => [phase, filledLong(fill(note), `notes.${phase}`)]).filter(([, note]) => note));
  return { input: line, slug: piece, title, tasks: checked.proposal.tasks, descriptions, workers: { ...recipe.workers }, judgeTool: recipe.judgeTool, budgets: normalizeBudgets(recipe.budgets),
    mode: recipe.mode, notes, allow: [...(recipe.allow ?? [])] };
}

function startWorkers(value) {
  try { return phaseMap(value, 'workers', workerTool); }
  catch (error) { if (error instanceof OutOfSchema) throw fail('errors.recipes.editInvalid', 400, error.message); throw error; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function recipeStart(root, body = {}, options) {
  const ref = body.recipe;
  if (!isObject(ref)) throw fail('errors.recipes.startShape');
  const entry = await getRecipe(root, ref.id, options);
  if (!absent(ref.hash) && ref.hash !== entry.hash) throw fail('errors.recipes.changed', 409, entry.id);
  const filled = fillRecipe(entry.recipe, { input: ref.input, slug: ref.slug, details: ref.details });
  const edited = [];
  let title = filled.title;
  if (!absent(body.title)) {
    title = v.body(body.title, PM_LIMITS.title, t('pmLoop.field.title')).replace(/\s+/g, ' ');
    if (HIDDEN.test(title)) throw fail('errors.recipes.editInvalid', 400, t('pmJudge.schema.hidden', 'title'));
    if (title !== filled.title) edited.push('title');
  }
  let tasks = filled.tasks;
  if (!absent(body.tasks)) {
    const checked = validateJudgment('plan', { tasks: body.tasks, reason: '-' });
    if (!checked.ok) throw fail('errors.recipes.editInvalid', 400, checked.reason);
    tasks = checked.proposal.tasks;
    if (!same(tasks, filled.tasks)) edited.push('tasks');
  }
  let workers = filled.workers;
  if (body.workers !== undefined) { workers = startWorkers(body.workers); if (!same(workers, filled.workers)) edited.push('workers'); }
  let judgeTool = filled.judgeTool;
  if (body.judgeTool !== undefined) { judgeTool = judgeToolSetting(body.judgeTool); if (judgeTool !== filled.judgeTool) edited.push('judgeTool'); }
  let budgets = filled.budgets;
  if (!absent(body.budgets)) { budgets = normalizeBudgets(body.budgets, filled.budgets); if (!same(budgets, filled.budgets)) edited.push('budgets'); }
  if (!absent(ref.slug) && ref.slug !== slugify(filled.input)) edited.push('slug');
  const describe = (task, index) => {
    const same = filled.tasks.findIndex((item) => item.id === task.id);
    return filled.descriptions[same >= 0 ? same : index] ?? '';
  };
  tasks = tasks.map((task, index) => ({ ...task, description: describe(task, index) }));
  return { title, tasks, budgets, judgeTool,
    recipe: { id: entry.id, source: entry.source, hash: entry.hash, title: entry.recipe.title, mode: entry.recipe.mode, workers, notes: filled.notes, input: filled.input, edited } };
}


const locked = async (root, fn) => withLock(join(await chatDir(root, null, { create: true }), 'recipes.lock'), fn);
async function audit(root, record, now) {
  return appendRecord(await auditFile(root, true), (seq) => ({ schema: 1, record: 'event', id: makeId('re', seq), seq, ...record, at: new Date(now).toISOString() }));
}
async function localExists(dir, id) {
  try { const info = await lstat(join(dir, `${id}.json`)); return info.isFile() || info.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function saveRecipe(root, value, { author, previous = null, from = null, now = Date.now() } = {}) {
  const who = v.author(author);
  const checked = validateRecipe(value);
  if (!checked.ok) throw fail('errors.recipes.invalid', 400, checked.reason);
  if (!absent(from) && (typeof from !== 'string' || !GOAL_ID.test(from))) throw fail('errors.pmLoop.invalidGoalId');
  if (!absent(from) && !checked.recipe.goal.includes('{input}')) throw fail('errors.recipes.goalNeedsInput');
  const recipe = stored(checked.recipe);
  const content = `${JSON.stringify(recipe, null, 2)}\n`;
  if (Buffer.byteLength(content) > RECIPE_LIMITS.file) throw fail('errors.recipes.invalid', 400, t('recipes.check.tooLarge', RECIPE_LIMITS.file / 1024));
  if (!absent(previous) && (typeof previous !== 'string' || !RECIPE_ID.test(previous))) throw fail('errors.recipes.invalidId');
  return locked(root, async () => {
    const dir = await localDir(root, true);
    const existed = await localExists(dir, recipe.id);
    await writeJsonAtomic(join(dir, `${recipe.id}.json`), recipe);
    if (!absent(previous) && previous !== recipe.id && await localExists(dir, previous)) {
      await rm(join(dir, `${previous}.json`), { force: true });
      await audit(root, { recipe: previous, outcome: 'deleted', by: who, renamedTo: recipe.id }, now);
    }
    await audit(root, { recipe: recipe.id, outcome: existed ? 'edited' : 'created', by: who, hash: sha(content), ...(absent(from) ? {} : { from }) }, now);
    return { id: recipe.id, source: 'local', file: `.wax/recipes/${recipe.id}.json`, hash: sha(content), recipe: checked.recipe };
  });
}

export async function deleteRecipe(root, id, { author, now = Date.now(), builtinDir = BUILTIN_DIR } = {}) {
  const who = v.author(author);
  if (typeof id !== 'string' || !RECIPE_ID.test(id)) throw fail('errors.recipes.invalidId');
  return locked(root, async () => {
    const dir = await localDir(root);
    if (!dir || !(await localExists(dir, id))) {
      if (await localExists(builtinDir, id)) throw fail('errors.recipes.builtinReadOnly', 409, id);
      throw fail('errors.recipes.notFound', 404, id);
    }
    await rm(join(dir, `${id}.json`), { force: true });
    await audit(root, { recipe: id, outcome: 'deleted', by: who }, now);
    return { id, deleted: true };
  });
}


export function lineDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((line) => ({ op: 'del', line })), ...b.map((line) => ({ op: 'add', line }))];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: 'same', line: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ op: 'del', line: a[i++] });
    else out.push({ op: 'add', line: b[j++] });
  }
  while (i < a.length) out.push({ op: 'del', line: a[i++] });
  while (j < b.length) out.push({ op: 'add', line: b[j++] });
  return out;
}
const pretty = (recipe) => `${JSON.stringify(recipe, null, 2)}\n`;

async function sharedEntry(root, id) {
  if (typeof id !== 'string' || !RECIPE_ID.test(id)) throw fail('errors.recipes.invalidId');
  const dir = await sharedDir(root);
  if (!dir || !(await localExists(dir, id))) throw fail('errors.recipes.sharedNotFound', 404, id);
  const entry = await readEntry(dir, `${id}.json`, 'shared');
  return { ...entry, approval: approvalState(entry, await sharedDecisions(root)) };
}

export async function sharedReview(root, id) {
  const entry = await sharedEntry(root, id);
  const decisions = (await sharedDecisions(root)).filter((record) => record.recipe === id);
  const last = decisions.filter((record) => record.decision === 'approved' && record.approved).at(-1) ?? null;
  const normalized = entry.usable ? pretty(stored(entry.recipe)) : null;
  return { ...entry, normalized,
    previous: last ? { hash: last.hash, by: last.by, at: last.at, normalized: pretty(last.approved) } : null,
    diff: last && normalized ? lineDiff(pretty(last.approved), normalized) : null,
    history: decisions.slice(-10).reverse().map((record) => ({ decision: record.decision, hash: record.hash, by: record.by, at: record.at, ...(record.exported ? { exported: true } : {}) })) };
}

export async function decideShared(root, id, action, { author, hash, now = Date.now() } = {}) {
  const who = v.author(author);
  const decision = DECISIONS[action];
  if (!decision) throw fail('errors.recipes.sharedAction');
  return locked(root, async () => {
    const entry = await sharedEntry(root, id);
    if (action !== 'retire' && hash !== entry.hash) throw fail('errors.recipes.changed', 409, id);
    if (action === 'approve' && !entry.usable) throw fail('errors.recipes.unusable', 409, id, entry.reason);
    if (action === 'retire' && !['approved', 'changed'].includes(entry.approval.state)) throw fail('errors.recipes.notApproved', 409, id);
    const record = await audit(root, { kind: 'shared', recipe: id, hash: entry.hash ?? '', decision, by: who, ...(action === 'approve' ? { approved: stored(entry.recipe) } : {}) }, now);
    return { id, decision, hash: record.hash, state: approvalState(entry, [record]).state };
  });
}

export async function exportRecipe(root, id, { author, now = Date.now() } = {}) {
  const who = v.author(author);
  if (typeof id !== 'string' || !RECIPE_ID.test(id)) throw fail('errors.recipes.invalidId');
  return locked(root, async () => {
    const dir = await localDir(root);
    if (!dir || !(await localExists(dir, id))) throw fail('errors.recipes.exportNotLocal', 404, id);
    const entry = await readEntry(dir, `${id}.json`, 'local');
    if (!entry.usable) throw fail('errors.recipes.unusable', 409, id, entry.reason);
    const recipe = stored(entry.recipe);
    const target = join(await sharedDir(root, true), `${id}.json`);
    const replaced = await localExists(dirname(target), id);
    await writeJsonAtomic(target, recipe);
    const hash = sha(await readFile(target, 'utf8'));
    await audit(root, { kind: 'shared', recipe: id, hash, decision: 'approved', by: who, approved: recipe, exported: true }, now);
    return { id, source: 'shared', file: `${FOLDERS.shared}/${id}.json`, hash, replaced };
  });
}


const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu');
const draftText = (value, max) => {
  const out = Array.from(String(value ?? '').replace(HIDDEN_ALL, '').replace(/\s+/g, ' ').replace(/\{/g, '(').replace(/\}/g, ')').trim());
  return out.length > max ? `${out.slice(0, max - 1).join('')}…` : out.join('');
};
function acTexts(plan) {
  if (typeof plan !== 'string') return [];
  const found = new Map();
  for (const [, n, body] of plan.matchAll(/^[ \t>*#|+-]*AC-([1-9][0-9]{0,2})(?![0-9A-Za-z_-])\s*[:.)\]-]?\s*(.*)$/gm)) {
    const value = draftText(body, RECIPE_LIMITS.acText);
    if (value && !found.has(Number(n))) found.set(Number(n), value);
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

export async function recipeDraft(root, id, { now = Date.now() } = {}) {
  const goal = await readGoal(root, id);
  if (!['done', 'stopped'].includes(goal.state)) throw fail('errors.recipes.draftNotFinished', 409, id);
  const [decisions, tasks] = await Promise.all([readDecisions(root, id), listTasks(root, { all: true })]);
  const features = [];
  for (const featureId of goal.features) { try { features.push(await getFeature(root, featureId)); } catch {   } }
  const completedBy = (run) => features.find((item) => item.id === run.feature)?.history?.some((event) => event?.action === 'complete' && event.phase === run.phase && event.author === run.to);
  const workers = {};
  for (const run of workerRuns(decisions)) {
    if (run.end?.outcome !== 'exited' || run.end.result !== 'done' || run.end.taskStatus !== 'done' || !HEADLESS_TOOLS.includes(run.tool) || !completedBy(run)) continue;
    workers[run.phase] = run.tool;
  }
  const end = Date.parse(goal.doneAt ?? goal.stoppedAt ?? '') || now;
  const { usage } = budgetUsage({ goal, features, tasks, decisions, now: end });
  const budgets = {};
  for (const name of ['phaseRuns', 'hours', 'iterations', 'failures']) {
    if (!(usage[name] > 0)) continue;
    const [min, max] = BUDGET_RANGE[name];
    budgets[name] = Math.min(max, Math.max(min, Math.ceil(usage[name] * 1.5)));
  }
  const ids = new Set();
  const draftTasks = features.slice(0, RECIPE_LIMITS.tasks).map((feature) => {
    let prefix = feature.id.slice(0, 23).replace(/-+$/, '') || 'task';
    for (let n = 2; ids.has(prefix); n++) prefix = `${feature.id.slice(0, 20).replace(/-+$/, '')}-${n}`;
    ids.add(prefix);
    const ac = acTexts(feature.artifacts?.plan).slice(0, RECIPE_LIMITS.ac);
    return { id: `${prefix}-{slug}`, title: draftText(feature.title || feature.id, RECIPE_LIMITS.taskTitle), ac: ac.length ? ac : [t('recipes.template.ac')] };
  });
  const title = draftText(goal.title, RECIPE_LIMITS.title) || goal.id;
  const draft = { schema: 1, id: `from-${goal.id}`, title, description: t('recipes.draft.description', goal.id), input: { label: t('recipes.template.label') },
    goal: draftText(goal.title, RECIPE_LIMITS.goal) || goal.id, tasks: draftTasks, workers, ...(goal.judgeTool ? { judgeTool: goal.judgeTool } : {}), budgets, mode: 'suggest', notes: {} };
  return { from: goal.id, state: goal.state, draft, used: usage };
}
