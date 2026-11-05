import { t } from './messages-catalog.mjs';

const STATE = { passed: 'planSteps.state.passed', failed: 'planSteps.state.failed', pending: 'planSteps.state.pending', otherCommand: 'planSteps.state.otherCommand' };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export function planStepsLine(progress, say = t) {
  if (!record(progress)) return null;
  return [say('planSteps.line', count(progress.done), count(progress.checked), count(progress.redGreen)),
    ...(count(progress.noCheck) ? [say('planSteps.lineNoCheck', count(progress.noCheck))] : [])].join(' · ');
}

export function stepStateText(row, say = t, none = null) {
  if (row?.state === 'noCheck') return none ? say('planSteps.state.none', none) : say('planSteps.state.noCheck');
  return [say(STATE[row?.state] ?? 'planSteps.state.pending'), ...(row?.redGreen === true ? [say('planSteps.redGreen')] : [])].join(' · ');
}
