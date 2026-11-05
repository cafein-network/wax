import { cleanDenyReason } from '../approvals.mjs';
import { commandText, normalizeTestOutput, testRepeatKey, treeKey } from './stuck-check.mjs';

export const REVIEW_VERDICTS = ['right', 'wrong', 'unsure'];
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
      repeat: { count: record.repeat.count ?? null, command: record.repeat.command ?? '', exitCode: record.repeat.exitCode ?? null, proofIds: Array.isArray(record.repeat.proofIds) ? record.repeat.proofIds : [] },
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
  const count = (verdict) => items.filter((item) => item.review?.verdict === verdict).length;
  const right = count('right'), wrong = count('wrong'), unsure = count('unsure');
  const rated = right + wrong;
  return { total: items.length, right, wrong, unsure, unrated: items.length - rated - unsure, rated,
    criterion: { ...REVIEW_CRITERION, met: rated >= REVIEW_CRITERION.rated && wrong <= REVIEW_CRITERION.wrong } };
}


export const REVIEW_TAIL = 400;
const lf = (text) => text.replace(/\r\n?/g, '\n');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function reviewEvidence(repeat = {}, proofs = [], { rootsFor = () => [], tmp } = {}) {
  const byId = new Map((Array.isArray(proofs) ? proofs : []).map((proof) => [String(proof.id), proof]));
  const trees = [];
  const items = (Array.isArray(repeat.proofIds) ? repeat.proofIds : []).slice(0, 20).map((id) => {
    const proof = byId.get(String(id));
    if (!proof) return { id: String(id), missing: true };
    const options = { roots: rootsFor(proof), ...(tmp ? { tmp } : {}) };
    const output = typeof proof.output === 'string' ? proof.output : '';
    const tree = treeKey(proof.tree);
    if (tree) trees.push(tree);
    return { id: String(id), at: proof.at ?? null, exitCode: proof.exitCode ?? null, timedOut: Boolean(proof.timedOut),
      normalized: lf(normalizeTestOutput(output, options)).slice(-REVIEW_TAIL), raw: lf(output).slice(-REVIEW_TAIL),
      tree: tree ? { head: proof.tree.head ? String(proof.tree.head).slice(0, 7) : null, files: Object.keys(proof.tree.files).length } : null,
      sameKey: Boolean(repeat.key) && testRepeatKey(proof, options) === repeat.key };
  });
  return { command: repeat.command ?? '', exitCode: repeat.exitCode ?? null, count: repeat.count ?? null,
    sameKey: items.filter((item) => item.sameKey).length, proofs: items,
    sameCode: trees.length < 2 ? null : trees.every((tree) => sameJson(tree, trees[0])) };
}


export const REPEAT_DEFAULT_OUTCOMES = ['decided', 'later'];
export const REPEAT_DEFAULT_AGAIN = 5;

export function validRepeatDefaults(records = [], { isHuman = () => true } = {}) {
  return records.filter((item) => item?.record === 'repeat-default' && REPEAT_DEFAULT_OUTCOMES.includes(item.outcome) && typeof item.by === 'string' && isHuman(item.by)
    && typeof item.at === 'string' && item.summary && Number.isSafeInteger(item.summary.right) && Number.isSafeInteger(item.summary.wrong)).sort((a, b) => a.seq - b.seq);
}

export function repeatDefaultCard(summary, records = [], items = []) {
  if (!summary) return null;
  if (summary.wrong > 0) {
    const first = items.find((item) => item.review?.verdict === 'wrong');
    return { state: 'wrong', wrong: summary.wrong, first: first ? { goal: first.goal ?? null, target: first.target } : null };
  }
  if (!summary.criterion?.met) return null;
  const last = records.at(-1);
  if (last?.outcome === 'decided') return { state: 'decided', by: last.by, at: last.at, to: last.to ?? 'stop' };
  if (last?.outcome === 'later') {
    const again = last.summary.right + last.summary.wrong + REPEAT_DEFAULT_AGAIN - summary.rated;
    if (again > 0) return { state: 'later', by: last.by, at: last.at, note: last.note ?? null, again };
  }
  return { state: 'ask', right: summary.right, wrong: summary.wrong };
}
