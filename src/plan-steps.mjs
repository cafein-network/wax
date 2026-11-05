import { t } from '../web/messages-catalog.mjs';
import { WaxError } from './workflow.mjs';
import { acceptanceIds } from './acceptance.mjs';
import { shellWords } from './goal-allow.mjs';

export const PLAN_STEPS_MODES = ['warn', 'enforce', 'off'];
export const PLAN_STEPS_WARNINGS = ['noSteps', 'noCheck', 'badCheck', 'unknownField', 'uncovered', 'large', 'gap', 'windowsShell', 'tooMany', 'sharedCheck'];
export const STEP_PROGRESS_WARNINGS = ['unproven', 'otherCommand'];
const BLOCKING = ['noSteps', 'noCheck', 'badCheck'];
export const PLAN_STEPS_LIMITS = { steps: 30, files: 8, title: 200, done: 500, reason: 200, path: 300, paths: 50 };
export const STEP_ID = /^S-[1-9][0-9]?$/;
const AC_ID = /^AC-[1-9][0-9]{0,2}$/;
const CHECK_ID = /^[a-z][a-z0-9-]{0,63}$/;

const STEP_LINE = /^[ \t>*#+-]*S-([1-9][0-9]?)(?![0-9A-Za-z_-])(.*)$/;
const FIELDS = { files: 'files', 파일: 'files', check: 'check', 검사: 'check', done: 'done', 완료: 'done', ac: 'ac',
  title: 'title', what: 'title', 무엇: 'title', 제목: 'title', id: 'id', 단계: 'id', step: 'id' };
const SHELL = /[|&;<>$`\r\n]/;
const WINDOWS_SHIMS = ['npx', 'npm', 'yarn', 'pnpm'];

export function planStepsMode(value = process.env.WAX_PLAN_STEPS) {
  if (value === undefined || value === '') return 'warn';
  if (!PLAN_STEPS_MODES.includes(value)) throw new WaxError(t('errors.planSteps.mode', PLAN_STEPS_MODES.join(', ')));
  return value;
}

function splitOutside(text, separator) {
  const parts = [];
  let start = 0, inCode = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') { inCode = !inCode; continue; }
    if (inCode) continue;
    const match = separator.exec(text.slice(i));
    if (match && match.index === 0) { parts.push(text.slice(start, i)); i += match[0].length - 1; start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}
const splitFields = (text) => splitOutside(text, /^ (?:—|--) /);
const splitCells = (line) => {
  const cells = splitOutside(line.trim(), /^\|/);
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
};
const fieldName = (label) => FIELDS[label.trim().toLowerCase()] ?? null;
const labelled = (segment) => /^([^:：`]{1,20})[:：][ \t]*([\s\S]*)$/.exec(segment);

export function parseCheck(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const none = /^(?:없음|none)[ \t]*[(（]([^()（）]*)[)）]$/i.exec(text);
  if (none) return none[1].trim() ? { none: none[1].trim().slice(0, PLAN_STEPS_LIMITS.reason) } : 'bad';
  const ids = /^`?checks=([^`\s]+)`?$/.exec(text);
  if (ids) {
    const list = [...new Set(ids[1].split(','))];
    return list.length <= 20 && list.every((id) => CHECK_ID.test(id)) ? { checks: list } : 'bad';
  }
  const code = /^`([^`]+)`$/.exec(text);
  if (!code || SHELL.test(code[1])) return 'bad';
  const argv = shellWords(code[1].trim(), { strict: false });
  return argv ? { argv } : 'bad';
}

const parseFiles = (value) => String(value ?? '').split(/[,，、]/).map((item) => item.trim().replace(/^`|`$/g, '').trim().replaceAll('\\', '/'))
  .filter((item) => item && !/^(?:없음|none)$/i.test(item));
const parseAc = (value) => [...new Set([...String(value ?? '').matchAll(/AC-([1-9][0-9]{0,2})(?![0-9])/gi)].map((match) => `AC-${Number(match[1])}`))];

function fill(step, name, value, raw) {
  if (name === 'title') { if (!step.title) step.title = value.slice(0, PLAN_STEPS_LIMITS.title); return; }
  if (name === 'id') return;
  if (name === 'files') { step.allFiles = parseFiles(value); return; }
  if (name === 'done') { step.done = value.slice(0, PLAN_STEPS_LIMITS.done); return; }
  if (name === 'ac') { step.ac = parseAc(value); return; }
  if (name === 'check') { step.rawCheck = value; return; }
  if (raw) step.unknown = true;
}

export function readPlanSteps(plan) {
  const result = { steps: [], duplicates: [], unknownFields: [], badChecks: [], more: 0 };
  if (typeof plan !== 'string') return result;
  const seen = new Set();
  let fenced = false, header = null;
  for (const line of plan.split(/\r?\n/)) {
    if (/^[ \t]*(?:```|~~~)/.test(line)) { fenced = !fenced; header = null; continue; }
    if (fenced) continue;
    const table = /^[ \t]*\|/.test(line);
    if (!table) header = null;
    let step = null;
    if (table) {
      const cells = splitCells(line);
      const first = STEP_LINE.exec(cells[0] ?? '');
      if (!first) {
        if (cells.some((cell) => fieldName(cell))) header = cells.map((cell) => cell.trim());
        continue;
      }
      step = { id: `S-${Number(first[1])}`, title: first[2].replace(/^[ \t]*[:.)：][ \t]*/, '').trim(), ac: [], allFiles: [], done: '' };
      cells.slice(1).forEach((cell, index) => {
        if (!cell) return;
        const match = labelled(cell), column = header?.[index + 1];
        if (match && fieldName(match[1])) fill(step, fieldName(match[1]), match[2].trim(), true);
        else if (column !== undefined) fill(step, fieldName(column), cell, true);
        else if (!step.title && !match) step.title = cell.slice(0, PLAN_STEPS_LIMITS.title);
        else step.unknown = true;
      });
    } else {
      const match = STEP_LINE.exec(line);
      if (!match) continue;
      const [title, ...segments] = splitFields(match[2].replace(/^[ \t]*[:.)：]?[ \t]*/, ''));
      let titleText = title, named = false;
      step = { id: `S-${Number(match[1])}`, title: '', ac: [], allFiles: [], done: '' };
      for (const segment of segments) {
        if (!segment) continue;
        const field = labelled(segment);
        if (field && fieldName(field[1]) && fieldName(field[1]) !== 'title') { named = true; fill(step, fieldName(field[1]), field[2].trim(), true); }
        else if (!named && !field && !segment.includes('`')) titleText += ` — ${segment}`;
        else step.unknown = true;
      }
      step.title = titleText.slice(0, PLAN_STEPS_LIMITS.title);
    }
    if (seen.has(step.id)) { if (!result.duplicates.includes(step.id)) result.duplicates.push(step.id); continue; }
    seen.add(step.id);
    if (result.steps.length >= PLAN_STEPS_LIMITS.steps) { result.more += 1; continue; }
    const check = parseCheck(step.rawCheck);
    if (check === 'bad') result.badChecks.push(step.id);
    if (step.unknown) result.unknownFields.push(step.id);
    result.steps.push({ id: step.id, title: step.title, files: step.allFiles.slice(0, PLAN_STEPS_LIMITS.paths).map((path) => path.slice(0, PLAN_STEPS_LIMITS.path)),
      fileCount: step.allFiles.length, check: check === 'bad' ? null : check, done: step.done, ac: step.ac });
  }
  return result;
}

export const planSteps = (plan) => readPlanSteps(plan).steps;

const byNumber = (a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]);

function checkIdentity(check, platform) {
  if (check?.argv) return `cmd:${JSON.stringify(platform === 'win32' ? check.argv.map((word) => word.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`)) : check.argv)}`;
  if (check?.checks) return `checks:${[...check.checks].sort().join(',')}`;
  return null;
}

export function assessPlanSteps(feature, phase, { mode: given, platform = process.platform } = {}) {
  if (phase !== 'plan') return { record: null };
  const mode = planStepsMode(given);
  if (mode === 'off') return { record: null };
  const declared = acceptanceIds(feature.artifacts?.plan);
  if (!declared.length) return { record: null };
  const read = readPlanSteps(feature.artifacts.plan);
  const known = new Set(declared);
  const refusals = [];
  if (read.duplicates.length) refusals.push(t('errors.planSteps.duplicate', read.duplicates.sort(byNumber).join(', ')));
  const unknownAc = read.steps.flatMap((step) => step.ac.filter((id) => !known.has(id)).map((id) => `${step.id} → ${id}`));
  if (unknownAc.length) refusals.push(t('errors.planSteps.unknownAc', unknownAc.join(', ')));
  if (refusals.length) throw new WaxError(refusals.join(' '), 409);

  const warnings = [];
  const add = (code, ids = []) => warnings.push({ code, ids });
  const steps = read.steps;
  if (!steps.length) add('noSteps');
  const noCheck = steps.filter((step) => !step.check && !read.badChecks.includes(step.id)).map((step) => step.id);
  if (noCheck.length) add('noCheck', noCheck);
  if (read.badChecks.length) add('badCheck', read.badChecks);
  if (read.unknownFields.length) add('unknownField', read.unknownFields);
  if (steps.length) {
    const covered = new Set(steps.flatMap((step) => step.ac));
    const uncovered = declared.filter((id) => !covered.has(id));
    if (uncovered.length) add('uncovered', uncovered);
  }
  const large = steps.filter((step) => step.fileCount > PLAN_STEPS_LIMITS.files).map((step) => step.id);
  if (large.length) add('large', large);
  const numbers = new Set(steps.map((step) => Number(step.id.slice(2))));
  const gap = [];
  for (let n = 1; n < Math.max(0, ...numbers); n++) if (!numbers.has(n)) gap.push(`S-${n}`);
  if (gap.length) add('gap', gap.slice(0, PLAN_STEPS_LIMITS.steps));
  if (platform === 'win32') {
    const shims = steps.filter((step) => WINDOWS_SHIMS.includes(String(step.check?.argv?.[0] ?? '').toLowerCase())).map((step) => step.id);
    if (shims.length) add('windowsShell', shims);
  }
  if (read.more) add('tooMany');
  const sameCheck = new Map();
  for (const step of steps) {
    const key = checkIdentity(step.check, platform);
    if (key) sameCheck.set(key, [...(sameCheck.get(key) ?? []), step.id]);
  }
  const shared = [...sameCheck.values()].filter((ids) => ids.length > 1).flat().sort(byNumber);
  if (shared.length) add('sharedCheck', shared);
  const record = { count: steps.length, mode, warnings };
  if (mode === 'enforce') {
    const blocking = warnings.filter((item) => BLOCKING.includes(item.code));
    if (blocking.length) throw new WaxError(`${blocking.map((item) => warningText(item)).join(' ')} (WAX_PLAN_STEPS=enforce)`, 409);
  }
  return { record };
}

const WARNING_TEXT = { noSteps: 'errors.planSteps.warning.noSteps', noCheck: 'errors.planSteps.warning.noCheck', badCheck: 'errors.planSteps.warning.badCheck',
  unknownField: 'errors.planSteps.warning.unknownField', uncovered: 'errors.planSteps.warning.uncovered', large: 'errors.planSteps.warning.large',
  gap: 'errors.planSteps.warning.gap', windowsShell: 'errors.planSteps.warning.windowsShell', tooMany: 'errors.planSteps.warning.tooMany',
  sharedCheck: 'errors.planSteps.warning.sharedCheck',
  unproven: 'errors.planSteps.warning.unproven', otherCommand: 'errors.planSteps.warning.otherCommand' };
const warningText = (item, say = t) => say(WARNING_TEXT[item.code], item.ids.join(', '));
export const planStepsWarningText = (item, say = t) => warningText(item, say);

export function planStepsWarning(record) {
  if (!record || record.mode === 'off' || !record.warnings?.length) return null;
  return t('errors.planSteps.warned', record.warnings.map((item) => warningText(item)).join(' '));
}

export function validPlanSteps(value, phase = 'plan') {
  const codes = phase === 'implement' ? STEP_PROGRESS_WARNINGS : PLAN_STEPS_WARNINGS;
  const record = (item) => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!record(value) || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > PLAN_STEPS_LIMITS.steps ||
      !['warn', 'enforce'].includes(value.mode) || !Array.isArray(value.warnings) || value.warnings.length > codes.length) return false;
  const seen = value.warnings.map((item) => item?.code);
  return new Set(seen).size === seen.length && value.warnings.every((item) => record(item) && codes.includes(item.code) &&
    Array.isArray(item.ids) && item.ids.length <= 100 && item.ids.every((id) => typeof id === 'string' && (STEP_ID.test(id) || AC_ID.test(id))));
}
