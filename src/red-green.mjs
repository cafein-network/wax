import { createHash } from 'node:crypto';
import { t } from '../web/messages-catalog.mjs';
import { qualityRequirements } from '../web/project-types.mjs';
import { WaxError, getFeature, updateFeature } from './workflow.mjs';
import { dueDefects, DEFECT_ID } from './defects.mjs';
import { treeKey } from './freshness.mjs';
import { WORKTREE_ID } from './worktrees.mjs';
import { PLAN_STEPS_LIMITS, STEP_ID } from './plan-steps.mjs';

export const RED_GREEN_MODES = ['warn', 'enforce', 'off'];
export const RED_GREEN_STATES = ['ok', 'partial', 'missing', 'waived', 'skipped'];
export const RED_GREEN_WARNINGS = ['otherTest', 'testsOnly', 'treeUnknown', 'noTests', 'sameTree'];
export const RED_GREEN_LIMITS = { failed: 3, name: 200, waiver: 2000, pairs: 100 };
const PROOF_ID = /^[a-f0-9-]{36}$/;

export function redGreenMode(value = process.env.WAX_RED_GREEN) {
  if (value === undefined || value === '') return 'warn';
  if (!RED_GREEN_MODES.includes(value)) throw new WaxError(t('errors.redGreen.mode', RED_GREEN_MODES.join(', ')));
  return value;
}

export function effectiveRedGreenMode(feature, value) {
  const env = redGreenMode(value);
  if (env === 'off') return 'off';
  return feature?.discipline?.redGreen === 'enforce' ? 'enforce' : env;
}

export const DISCIPLINE_VALUES = { redGreen: ['warn', 'enforce'], approach: ['ask', 'always', 'off'] };
export function validDiscipline(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(DISCIPLINE_VALUES, key) && DISCIPLINE_VALUES[key].includes(item));
}

export async function setTaskRedGreen(root, ids, on, author) {
  const changed = [];
  for (const id of ids) {
    const feature = await getFeature(root, id);
    if (feature.archivedAt || (feature.discipline?.redGreen === 'enforce') === on) continue;
    const next = { ...(feature.discipline ?? {}) };
    if (on) next.redGreen = 'enforce'; else delete next.redGreen;
    await updateFeature(root, id, 'discipline', { discipline: next, author });
    changed.push(id);
  }
  return changed;
}

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function checkKey(proof, platform = process.platform) {
  const command = (Array.isArray(proof?.command) ? proof.command : []).map((arg) => {
    const text = String(arg);
    return platform === 'win32' ? text.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`) : text;
  });
  const checks = Array.isArray(proof?.checks) && proof.checks.length ? [...new Set(proof.checks)].sort() : null;
  const cmd = sha(command);
  return { key: `${checks ? `checks:${checks.join(',')}|` : ''}cmd:${cmd}`, label: checks ? `checks:${checks.join(',')}` : `cmd:${cmd.slice(0, 16)}`, checks: checks ?? [] };
}

export const proofFolder = (proof) => proof?.worktree?.id ?? 'project';

const passed = (proof) => proof?.kind === 'test' && proof.exitCode === 0 && !proof.timedOut;

export function ranNoTests(proof) {
  const output = typeof proof?.output === 'string' ? proof.output : '';
  return proof?.exitCode === 127 || /^[ \t]*(?:#|ℹ)[ \t]+tests[ \t]+0[ \t]*\r?$/m.test(output) ||
    (/<testsuites?\b[^>]*\btests="0"/.test(output) && !/<testcase\b/.test(output));
}

export const failedTest = (proof) => proof?.kind === 'test' && Number.isInteger(proof.exitCode) && proof.exitCode !== 0 && !proof.timedOut;

const unescapeTap = (name) => name.replace(/\\([\\#])/g, '$1');
const unescapeXml = (text) => text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (whole, dec, hex, named) => {
  if (named) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
  const code = dec ? Number(dec) : parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});

export function parseTestNames(output) {
  const text = typeof output === 'string' ? output : '';
  const failed = new Set(), ok = new Set();
  if (/<testcase\b/.test(text)) {
    for (const match of text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = /\bname="([^"]*)"/.exec(match[1]);
      if (!name) continue;
      const body = match[3] ?? '';
      const value = unescapeXml(name[1]).trim();
      if (!value) continue;
      if (/<(?:failure|error)\b/.test(body)) failed.add(value);
      else if (!/<skipped\b/.test(body)) ok.add(value);
    }
    return failed.size || ok.size ? { parse: 'junit', failed: [...failed], passed: [...ok] } : { parse: 'none', failed: [], passed: [] };
  }
  if (/^TAP version \d+\r?$/m.test(text) || /^[ \t]*(?:not )?ok \d+(?: - |\r?$)/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const match = /^[ \t]*(not ok|ok)[ \t]+\d+(?:[ \t]+-)?[ \t]*(.*)$/.exec(line);
      if (!match) continue;
      let name = match[2];
      const directive = /(?:^|[ \t])#[ \t]*(SKIP|TODO)\b.*$/i.exec(name.replace(/\\[\\#]/g, '  '));
      if (directive) name = name.slice(0, directive.index);
      name = unescapeTap(name).trim();
      if (!name) continue;
      const kind = directive?.[1].toUpperCase();
      if (match[1] === 'not ok' && kind !== 'TODO') failed.add(name);
      else if (match[1] === 'ok' && kind !== 'SKIP') ok.add(name);
    }
    if (failed.size || ok.size) return { parse: 'tap', failed: [...failed], passed: [...ok] };
  }
  return { parse: 'none', failed: [], passed: [] };
}

export function matchTests(red, green) {
  const before = parseTestNames(red?.output), after = parseTestNames(green?.output);
  const failed = before.failed.slice(0, RED_GREEN_LIMITS.failed).map((name) => name.slice(0, RED_GREEN_LIMITS.name));
  if (before.parse === 'none' || after.parse === 'none' || !before.failed.length) return { parse: 'none', failed, matched: null };
  const passedNames = new Set(after.passed);
  const matched = before.failed.some((name) => passedNames.has(name));
  if (!matched && (red.truncated === true || green.truncated === true)) return { parse: 'none', failed, matched: null };
  return { parse: before.parse, failed, matched };
}

export function isTestPath(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((part) => ['test', 'tests', '__tests__', 'spec'].includes(part.toLowerCase())) ||
    /\.(?:test|spec)\.[^.]+$/i.test(name) || /_test\.[^.]+$/i.test(name);
}

const own = (files, path) => (Object.hasOwn(files, path) ? files[path] : undefined);
export function treeChange(redTree, greenTree) {
  const a = treeKey(redTree), b = treeKey(greenTree);
  if (!a || !b) return { known: false, changed: null, paths: null };
  if (JSON.stringify(a) === JSON.stringify(b)) return { known: true, same: true, changed: 0, paths: [] };
  if (redTree.head !== greenTree.head) return { known: true, same: false, changed: null, paths: null };
  const paths = [...new Set([...Object.keys(redTree.files), ...Object.keys(greenTree.files)])]
    .filter((path) => own(redTree.files, path) !== own(greenTree.files, path)).sort();
  return { known: true, same: false, changed: paths.length, paths };
}

export function pairFor(feature, green, { platform = process.platform } = {}) {
  const { key, label, checks } = checkKey(green, platform);
  const folder = proofFolder(green), greenAt = Date.parse(green.at);
  const candidates = (feature.proofs ?? []).filter((proof) => proof !== green && proof.kind === 'test' && proof.phase === green.phase &&
    proof.iteration === green.iteration && proofFolder(proof) === folder && Date.parse(proof.at) < greenAt && failedTest(proof) && checkKey(proof, platform).key === key);
  let reason = null;
  const usable = candidates.filter((proof) => {
    if (ranNoTests(proof)) { reason ??= 'noTests'; return false; }
    if (treeChange(proof.tree, green.tree).same) { reason = 'sameTree'; return false; }
    return true;
  });
  if (!usable.length) return { reason };
  const red = usable.reduce((latest, proof) => (Date.parse(proof.at) >= Date.parse(latest.at) ? proof : latest));
  const change = treeChange(red.tree, green.tree);
  const testsOnly = Boolean(change.paths?.length) && change.paths.every(isTestPath);
  const defects = checks.map((id) => /^d-([1-9][0-9]{0,2})$/.exec(id)).filter(Boolean).map((match) => `D-${Number(match[1])}`);
  return { pair: { red: red.id, green: green.id, check: label, folder, treeChanged: change.known ? true : null, changed: change.changed, testsOnly,
    tests: matchTests(red, green), defect: defects.sort((x, y) => Number(x.slice(2)) - Number(y.slice(2)))[0] ?? null }, defects };
}

function applies(feature, greens) {
  return greens.length > 0 || qualityRequirements(feature.projectType, 'implement', feature.workMode).some((item) => ['runtime', 'integration'].includes(item.kind));
}

export function assessRedGreen(feature, phase, proofIds = [], waiver, { mode: given, platform = process.platform } = {}) {
  if (waiver !== undefined && (typeof waiver !== 'string' || !waiver.trim() || waiver.length > RED_GREEN_LIMITS.waiver)) throw new WaxError(t('errors.redGreen.waiverFormat', RED_GREEN_LIMITS.waiver));
  if (phase !== 'implement') {
    if (waiver !== undefined) throw new WaxError(t('errors.redGreen.implementOnly'));
    return { record: null };
  }
  const mode = effectiveRedGreenMode(feature, given);
  const reason = waiver?.trim();
  if (mode === 'off') return { record: reason ? { state: 'waived', mode, pairs: [], defects: [], warnings: [], waiver: reason } : null };
  const greens = [...new Set(proofIds)].map((id) => feature.proofs?.find((proof) => proof.id === id)).filter(passed);
  const pairs = [], covered = new Map(), warnings = new Set(), unpaired = new Set();
  for (const green of greens) {
    const found = pairFor(feature, green, { platform });
    if (!found.pair) { if (found.reason) unpaired.add(found.reason); continue; }
    if (pairs.length >= RED_GREEN_LIMITS.pairs) break;
    for (const id of found.defects) if (!covered.has(id)) covered.set(id, pairs.length);
    pairs.push(found.pair);
    if (found.pair.treeChanged === null) warnings.add('treeUnknown');
    if (found.pair.testsOnly) warnings.add('testsOnly');
    if (found.pair.tests.matched === false) warnings.add('otherTest');
  }
  if (reason && pairs.length) throw new WaxError(t('errors.redGreen.waiverWithPairs'));
  if (!pairs.length) for (const code of unpaired) warnings.add(code);
  const due = dueDefects(feature);
  const defects = due.map(({ id }) => (covered.has(id) ? { id, state: 'ok', pair: covered.get(id) } : { id, state: 'missing', pair: null }));
  const missingDefects = defects.filter((item) => item.state === 'missing').map((item) => item.id);
  let state;
  if (reason) state = 'waived';
  else if (pairs.length) state = missingDefects.length ? 'partial' : 'ok';
  else state = mode === 'warn' && !due.length && !applies(feature, greens) ? 'skipped' : 'missing';
  const record = { state, mode, pairs, defects, warnings: RED_GREEN_WARNINGS.filter((code) => warnings.has(code)), ...(reason ? { waiver: reason } : {}) };
  const problem = redGreenProblem(record);
  if (mode === 'enforce' && problem) throw new WaxError(`${problem} (WAX_RED_GREEN=enforce)`, 409);
  return { record };
}

function redGreenProblem(record) {
  if (record?.state === 'missing') return t('errors.redGreen.missing');
  if (record?.state === 'partial') return t('errors.redGreen.defectsMissing', record.defects.filter((item) => item.state === 'missing').map((item) => item.id).join(', '));
  return null;
}

const WARNING_TEXT = { otherTest: 'errors.redGreen.warning.otherTest', testsOnly: 'errors.redGreen.warning.testsOnly', treeUnknown: 'errors.redGreen.warning.treeUnknown',
  noTests: 'errors.redGreen.warning.noTests', sameTree: 'errors.redGreen.warning.sameTree' };

export function redGreenWarning(record) {
  if (!record || record.mode === 'off' || record.state === 'skipped') return null;
  const problem = redGreenProblem(record);
  const notes = [...(problem ? [problem] : []), ...record.warnings.map((code) => t(WARNING_TEXT[code]))];
  return notes.length ? t('errors.redGreen.warned', notes.join(' ')) : null;
}

export function validRedGreen(value) {
  const record = (item) => item !== null && typeof item === 'object' && !Array.isArray(item);
  const text = (item, limit) => typeof item === 'string' && item.trim().length > 0 && item.length <= limit;
  if (!record(value) || !RED_GREEN_STATES.includes(value.state) || !RED_GREEN_MODES.includes(value.mode) ||
      !Array.isArray(value.pairs) || value.pairs.length > RED_GREEN_LIMITS.pairs || !Array.isArray(value.defects) || value.defects.length > 100 ||
      !Array.isArray(value.warnings) || new Set(value.warnings).size !== value.warnings.length || !value.warnings.every((code) => RED_GREEN_WARNINGS.includes(code)) ||
      (value.state === 'waived') !== (value.waiver !== undefined) || (value.waiver !== undefined && !text(value.waiver, RED_GREEN_LIMITS.waiver)) ||
      ((value.state === 'ok' || value.state === 'partial') !== (value.pairs.length > 0))) return false;
  const pairsOk = value.pairs.every((pair) => record(pair) && PROOF_ID.test(pair.red ?? '') && PROOF_ID.test(pair.green ?? '') && pair.red !== pair.green &&
    typeof pair.check === 'string' && /^(?:checks:[a-z][a-z0-9,-]{0,1400}|cmd:[a-f0-9]{16})$/.test(pair.check) &&
    (pair.folder === 'project' || WORKTREE_ID.test(pair.folder ?? '')) && (pair.treeChanged === true || pair.treeChanged === null) &&
    (pair.changed === null || (Number.isSafeInteger(pair.changed) && pair.changed >= 0)) && typeof pair.testsOnly === 'boolean' &&
    record(pair.tests) && ['tap', 'junit', 'none'].includes(pair.tests.parse) && Array.isArray(pair.tests.failed) && pair.tests.failed.length <= RED_GREEN_LIMITS.failed &&
    pair.tests.failed.every((name) => text(name, RED_GREEN_LIMITS.name)) && [true, false, null].includes(pair.tests.matched) &&
    (pair.defect === null || DEFECT_ID.test(pair.defect ?? '')) &&
    (pair.step === undefined || STEP_ID.test(pair.step ?? '')));
  const steps = value.steps === undefined || (Array.isArray(value.steps) && value.steps.length <= PLAN_STEPS_LIMITS.steps &&
    new Set(value.steps.map((item) => item?.id)).size === value.steps.length &&
    value.steps.every((item) => record(item) && STEP_ID.test(item.id ?? '') && ['ok', 'missing', 'noCheck'].includes(item.state) &&
      (item.linked === undefined || (item.state === 'ok' && typeof item.linked === 'boolean'))));
  const ids = value.defects.map((item) => item?.id);
  const defectsOk = new Set(ids).size === ids.length && value.defects.every((item) => record(item) && DEFECT_ID.test(item.id ?? '') &&
    (item.state === 'ok' ? Number.isSafeInteger(item.pair) && item.pair >= 0 && item.pair < value.pairs.length : item.state === 'missing' && item.pair === null));
  return pairsOk && defectsOk && steps && (value.state !== 'partial' || value.defects.some((item) => item.state === 'missing')) &&
    (value.state !== 'ok' || value.defects.every((item) => item.state === 'ok'));
}
