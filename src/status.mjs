import { getFeature } from './workflow.mjs';
import { evidenceFreshness } from './freshness.mjs';
import { acceptanceTrace } from './acceptance.mjs';
import { phaseDurations } from './durations.mjs';

export async function featureStatus(root, id) {
  const feature = await getFeature(root, id);
  const result = { ...feature, evidenceFreshness: await evidenceFreshness(root, feature) };
  const trace = acceptanceTrace(feature);
  if (trace.length) result.acceptanceTrace = trace;
  result.durations = phaseDurations(feature);
  return result;
}
