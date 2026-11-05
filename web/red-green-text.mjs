import { t } from './messages-catalog.mjs';

const WARNING = {
  otherTest: 'errors.redGreen.warning.otherTest', testsOnly: 'errors.redGreen.warning.testsOnly', treeUnknown: 'errors.redGreen.warning.treeUnknown',
  noTests: 'errors.redGreen.warning.noTests', sameTree: 'errors.redGreen.warning.sameTree',
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

export const redGreenWarningText = (code, say = t) => (WARNING[code] ? say(WARNING[code]) : String(code));

export function redGreenLine(value, say = t) {
  if (!record(value)) return null;
  const pairs = list(value.pairs).length, warnings = list(value.warnings).length;
  const missing = list(value.defects).filter((item) => item?.state === 'missing').map((item) => item.id);
  const head = value.state === 'ok' || value.state === 'partial' ? (pairs === 1 ? say('redGreen.line.pair') : say('redGreen.line.pairs', pairs))
    : value.state === 'waived' ? say('redGreen.line.waived')
      : value.state === 'skipped' ? say('redGreen.line.skipped')
        : say('redGreen.line.missing');
  return [head, ...(warnings ? [warnings === 1 ? say('redGreen.line.warning') : say('redGreen.line.warnings', warnings)] : []),
    ...(missing.length ? [say('redGreen.line.defectsMissing', missing.join(', '))] : [])].join(' · ');
}

export const redGreenWarningLines = (value, say = t) => (record(value) ? list(value.warnings).map((code) => redGreenWarningText(code, say)) : []);

export const redGreenDefectLines = (value, say = t) => (record(value)
  ? list(value.defects).map((item) => say(item?.state === 'ok' ? 'redGreen.defect.ok' : 'redGreen.defect.missing', item?.id ?? '-')) : []);

export function redGreenMarks(value) {
  const marks = new Map();
  for (const pair of record(value) ? list(value.pairs) : []) {
    if (typeof pair?.red === 'string') marks.set(pair.red, 'red');
    if (typeof pair?.green === 'string') marks.set(pair.green, 'green');
  }
  return marks;
}

export function pairWarnings(pair) {
  return [...(pair?.tests?.matched === false ? ['otherTest'] : []), ...(pair?.testsOnly === true ? ['testsOnly'] : []), ...(pair?.treeChanged === null ? ['treeUnknown'] : [])];
}

export function pairChangeText(pair, say = t) {
  if (pair?.treeChanged === null) return redGreenWarningText('treeUnknown', say);
  return Number.isSafeInteger(pair?.changed) ? say('redGreen.changed', pair.changed) : say('redGreen.changedUnknown');
}
