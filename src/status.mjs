import { getFeature } from './workflow.mjs';
import { evidenceFreshness } from './freshness.mjs';
import { acceptanceTrace } from './acceptance.mjs';
import { phaseDurations } from './durations.mjs';
import { featureUsage } from './chat/pm-loop.mjs';
import { rulingSummary } from './rulings.mjs';
import { approachSummary } from './approach.mjs';
import { approachLine, approachOthersLine } from '../web/approach-text.mjs';
import { redGreenDefectLines, redGreenLine, redGreenWarningLines } from '../web/red-green-text.mjs';
import { stepProgress } from './plan-progress.mjs';
import { planStepsLine, stepStateText } from '../web/plan-steps-text.mjs';
import { returnStageLines, reviewStagesLine, reviewStagesWarningLines } from '../web/review-stages-text.mjs';
import { returnStages } from './review-stages.mjs';

export function redGreenStatus(feature) {
  const done = feature?.completed?.implement?.redGreen;
  const required = feature?.discipline?.redGreen === 'enforce';
  if (!done && !required) return null;
  return { required, ...(done ? { state: done.state, mode: done.mode, pairs: done.pairs.length, line: redGreenLine(done), warnings: redGreenWarningLines(done), defects: redGreenDefectLines(done),
    ...(done.waiver ? { waiver: done.waiver } : {}) } : { state: null }) };
}

export function planStepsStatus(feature) {
  const progress = stepProgress(feature);
  if (!progress) return null;
  const { steps, ...counts } = progress;
  return { ...counts, line: planStepsLine(progress), steps: steps.map((row) => ({ id: row.id, title: row.title, check: row.check, ...(row.none ? { none: row.none } : {}),
    ac: row.ac, state: row.state, redGreen: row.redGreen, proof: row.proof, line: `${row.id}${row.title ? ` ${row.title}` : ''} — ${stepStateText(row, undefined, row.none)}` })) };
}

export function reviewStagesStatus(feature) {
  const stages = feature?.completed?.review?.stages;
  const returned = returnStages(feature).filter((item) => item.stage);
  if (!stages && !returned.length) return null;
  return { ...(stages ? { mode: stages.mode, line: reviewStagesLine(stages), warnings: reviewStagesWarningLines(stages),
    items: stages.checks.map(({ id, stage, status }) => ({ id, stage, status })) } : {}), returned: returnStageLines(returned) };
}

export async function featureStatus(root, id) {
  const feature = await getFeature(root, id);
  const result = { ...feature, evidenceFreshness: await evidenceFreshness(root, feature) };
  const trace = acceptanceTrace(feature);
  if (trace.length) result.acceptanceTrace = trace;
  result.durations = phaseDurations(feature);
  const rulings = rulingSummary(feature);
  if (rulings) result.rulingSummary = rulings;
  result.usage = await featureUsage(root, id);
  const redGreen = redGreenStatus(feature);
  if (redGreen) result.redGreen = redGreen;
  const steps = planStepsStatus(feature);
  if (steps) result.planSteps = steps;
  const approach = approachSummary(feature);
  if (approach) result.approachSummary = { ...approach, line: approachLine(approach), ...(approachOthersLine(approach) ? { others: approach.others, othersLine: approachOthersLine(approach) } : {}) };
  const stages = reviewStagesStatus(feature);
  if (stages) result.reviewStages = stages;
  return result;
}
