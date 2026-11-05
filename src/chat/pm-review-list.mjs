import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '../../web/messages-catalog.mjs';
import { WaxError, getFeature } from '../workflow.mjs';
import { worktreeById } from '../worktrees.mjs';
import { chatDir } from './paths.mjs';
import { appendRecord, makeId, readRecords } from './store.mjs';
import { WORKER_END, humanAuthor, listGoals, readDecisions, readGoal } from './pm-loop.mjs';
import { REPEAT_DEFAULT_OUTCOMES, cleanReviewNote, repeatDefaultCard, reviewEvidence, reviewItems, reviewSubject, reviewSummary, validRepeatDefaults } from './pm-review.mjs';

const fail = (id, status = 400, ...values) => new WaxError(t(id, ...values), status);
const defaultFile = async (root, create = false) => { const dir = await chatDir(root, null, { create }); return dir && join(dir, 'repeat-default.jsonl'); };
const isHuman = (by) => { try { humanAuthor(by); return true; } catch { return false; } };

export async function readRepeatDefault(root) {
  const file = await defaultFile(root);
  return file ? validRepeatDefaults((await readRecords(file)).records, { isHuman }) : [];
}

export async function repeatDefaultView(root, overview) {
  const records = await readRepeatDefault(root).catch(() => []);
  const items = (overview.goals ?? []).flatMap((goal) => (goal.repeatReviews ?? []).map((item) => ({ goal: goal.id, target: item.target, review: item.review, at: item.at })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return repeatDefaultCard(overview.repeatReview, records, items);
}

async function projectSummary(root) {
  const { goals } = await listGoals(root);
  const items = [];
  for (const goal of goals) items.push(...reviewItems(await readDecisions(root, goal.id).catch(() => [])));
  return { summary: reviewSummary(items), items };
}

export async function decideRepeatDefault(root, { author, outcome, note, now = Date.now() } = {}) {
  const who = humanAuthor(author);
  if (!REPEAT_DEFAULT_OUTCOMES.includes(outcome)) throw fail('errors.pmLoop.repeatDefaultOutcome', 400);
  if (note !== undefined && note !== null && typeof note !== 'string') throw fail('errors.pmLoop.reviewNote', 400);
  const clean = cleanReviewNote(note);
  const { summary } = await projectSummary(root);
  const card = repeatDefaultCard(summary, await readRepeatDefault(root));
  if (card?.state !== 'ask') throw fail('errors.pmLoop.repeatDefaultNotAsked', 409);
  const record = await appendRecord(await defaultFile(root, true), (seq) => ({ schema: 1, record: 'repeat-default', id: makeId('rd', seq), seq, outcome,
    ...(outcome === 'decided' ? { to: 'stop' } : {}), by: who, ...(clean ? { note: clean } : {}), at: new Date(now).toISOString(),
    summary: { right: summary.right, wrong: summary.wrong, unsure: summary.unsure, unrated: summary.unrated } }));
  return { id: record.id, outcome: record.outcome, ...(record.to ? { to: record.to } : {}), by: who, note: clean, summary: record.summary };
}

export async function repeatReviewDetail(root, id, target) {
  const goal = await readGoal(root, id);
  if (typeof target !== 'string' || !/^pd-[a-z0-9-]{1,40}$/.test(target)) throw fail('errors.pmLoop.reviewTargetMissing', 404, String(target).slice(0, 40));
  const decisions = await readDecisions(root, id);
  const record = decisions.find((item) => item.id === target);
  if (!record) throw fail('errors.pmLoop.reviewTargetMissing', 404, target);
  if (!reviewSubject(record)) throw fail('errors.pmLoop.reviewTargetKind', 409, target);
  const featureId = record.feature ?? decisions.find((item) => item.kind === 'worker' && item.outcome === 'launched' && item.worker === record.worker)?.feature ?? null;
  let feature = null;
  if (featureId) { try { feature = await getFeature(root, featureId); } catch (error) { if (error.status !== 404) throw error; } }
  const item = reviewItems(decisions, { features: feature ? [feature] : [], isEnd: (outcome) => WORKER_END.has(outcome) })
    .find((entry) => entry.target === target);
  const base = [root, await realpath(root).catch(() => root)];
  const folders = new Map();
  for (const proof of feature?.proofs ?? []) {
    const wt = proof?.worktree?.id;
    if (typeof wt === 'string' && !folders.has(wt)) folders.set(wt, (await worktreeById(root, wt, { feature: featureId }).catch(() => null))?.path ?? null);
  }
  const evidence = reviewEvidence(record.repeat, feature?.proofs ?? [], { rootsFor: (proof) => [...base, ...(folders.get(proof?.worktree?.id) ? [folders.get(proof.worktree.id)] : [])] });
  const hypotheses = decisions.filter((entry) => entry.kind === 'worker' && entry.feature === featureId && entry.rootCause && typeof entry.rootCause === 'object'
    && (!record.repeat?.key || entry.rootCause.repeatKey === record.repeat.key)).slice(-5).map((entry) => ({ at: entry.at,
    ...(entry.rootCause.missing ? { missing: true } : { hypothesis: String(entry.rootCause.hypothesis ?? '').slice(0, 300), result: ['fixed', 'not-fixed', 'unknown'].includes(entry.rootCause.result) ? entry.rootCause.result : 'unknown' }) }));
  return { goal: goal.id, title: goal.title, ...item, evidence, hypotheses };
}
