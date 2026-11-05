import { t } from './messages-catalog.mjs';

const WARNING = { stepsMissing: 'reviewStages.warning.stepsMissing', redGreenMissing: 'reviewStages.warning.redGreenMissing',
  noQuality: 'reviewStages.warning.noQuality', redGreenMismatch: 'reviewStages.warning.redGreenMismatch' };
const RETURNED = { spec: 'reviewStages.returned.spec', quality: 'reviewStages.returned.quality' };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

const counted = (part, say) => {
  const unverified = count(part?.unverified), passed = Math.max(0, count(part?.items) - unverified);
  return unverified ? `${passed}, ${say('reviewStages.unverifiedCount', unverified)}` : String(passed);
};

export function reviewStagesLine(value, say = t) {
  if (!record(value)) return null;
  const quality = value.quality?.state === 'pass' ? say('reviewStages.quality', counted(value.quality, say)) : say('reviewStages.qualityNone');
  return `${say('reviewStages.spec', counted(value.spec, say))} → ${quality}`;
}

export const reviewStagesWarningLines = (value, say = t) => (record(value) && Array.isArray(value.warnings)
  ? value.warnings.map((item) => (WARNING[item?.code] ? say(WARNING[item.code], (item.ids ?? []).join(', ')) : String(item?.code))) : []);

export const stageName = (stage, say = t) => say(stage === 'quality' ? 'reviewStages.stage.quality' : 'reviewStages.stage.spec');

export const returnStageLines = (cycles, say = t) => (Array.isArray(cycles)
  ? cycles.map((item) => say(RETURNED[item?.stage] ?? 'reviewStages.returned.unknown', count(item?.iteration))) : []);
