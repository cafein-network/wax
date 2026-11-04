import { cleanDenyReason } from '../approvals.mjs';
import { commandText } from './stuck-check.mjs';

export const REVIEW_VERDICTS = ['right', 'wrong'];
export const REVIEW_NOTE_MAX = 300;
export const REVIEW_CRITERION = { rated: 10, wrong: 0 };

export function reviewSubject(record) {
  if (record?.kind === 'repeat' && record.outcome === 'warned' && record.repeat) return 'repeat-warned';
  if (record?.kind === 'worker' && record.outcome === 'stuck' && record.repeat) return 'repeat-stuck';
  return null;
}

export function cleanReviewNote(value) {
  if (value === undefined || value === null || value === '') return null;
  const clean = Array.from(cleanDenyReason(value)).slice(0, REVIEW_NOTE_MAX).join('').trim();
  return clean || null;
}

const time = (value) => Date.parse(value ?? '') || 0;

export function reviewItems(decisions = [], { features = [], isEnd = () => false } = {}) {
  const reviews = new Map();
  for (const record of decisions) {
    if (record.kind !== 'review' || !REVIEW_VERDICTS.includes(record.outcome) || typeof record.target !== 'string') continue;
    if (!reviews.has(record.target)) reviews.set(record.target, []);
    reviews.get(record.target).push({ verdict: record.outcome, by: record.by ?? null, note: record.note ?? null, at: record.at });
  }
  const launches = new Map(decisions.filter((item) => item.kind === 'worker' && item.outcome === 'launched').map((item) => [item.worker, item]));
  const ends = new Map(decisions.filter((item) => item.kind === 'worker' && isEnd(item.outcome)).map((item) => [item.worker, item]));
  const byFeature = new Map(features.map((feature) => [feature.id, feature]));
  const items = [];
  for (const record of decisions) {
    const subject = reviewSubject(record);
    if (!subject) continue;
    const launch = launches.get(record.worker) ?? null, end = ends.get(record.worker) ?? null;
    const feature = byFeature.get(record.feature ?? launch?.feature);
    const author = launch?.to ?? null;
    let passedAfter = null;
    if (subject === 'repeat-warned' && feature && author) {
      const until = end ? time(end.at) : Infinity;
      passedAfter = (feature.proofs ?? []).some((proof) => proof.kind === 'test' && proof.exitCode === 0 && proof.author === author
        && commandText(proof) === record.repeat.command && time(proof.at) > time(record.at) && time(proof.at) <= until);
    }
    const history = reviews.get(record.id) ?? [];
    items.push({
      target: record.id, subject, at: record.at, worker: record.worker ?? null, tool: record.tool ?? launch?.tool ?? null,
      feature: record.feature ?? launch?.feature ?? null, phase: record.phase ?? launch?.phase ?? null, iteration: record.iteration ?? launch?.iteration ?? null, to: author,
      repeat: { count: record.repeat.count ?? null, command: record.repeat.command ?? '', proofIds: Array.isArray(record.repeat.proofIds) ? record.repeat.proofIds : [] },
      review: history.at(-1) ?? null, history,
      facts: {
        end: subject === 'repeat-stuck' ? 'stuck' : end?.outcome ?? null,
        completed: Boolean(feature && launch && feature.completed?.[launch.phase] && time(feature.completed[launch.phase].at) >= time(launch.at)),
        passedAfter,
      },
    });
  }
  return items;
}

export function reviewSummary(items = []) {
  const right = items.filter((item) => item.review?.verdict === 'right').length;
  const wrong = items.filter((item) => item.review?.verdict === 'wrong').length;
  const rated = right + wrong;
  return { total: items.length, right, wrong, unrated: items.length - rated, rated,
    criterion: { ...REVIEW_CRITERION, met: rated >= REVIEW_CRITERION.rated && wrong <= REVIEW_CRITERION.wrong } };
}
