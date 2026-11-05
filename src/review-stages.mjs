import { t } from '../web/messages-catalog.mjs';
import { WaxError } from './workflow.mjs';
import { AC_CHECK, isAcCheck } from './acceptance.mjs';
import { DEFECT_CHECK, isDefectCheck } from './defects.mjs';
import { planSteps, STEP_ID } from './plan-steps.mjs';
import { unmention } from './mention.mjs';

export const REVIEW_STAGES_MODES = ['warn', 'enforce', 'off'];
export const REVIEW_STAGES = ['spec', 'quality'];
export const QUALITY_ITEMS = ['q-tests', 'q-structure', 'q-security', 'q-simplicity'];
export const REVIEW_STAGES_WARNINGS = ['stepsMissing', 'redGreenMissing', 'noQuality', 'redGreenMismatch'];
const BLOCKING = ['stepsMissing', 'redGreenMissing', 'noQuality'];
export const REVIEW_STAGES_LIMITS = { quality: 20, detail: 2000, checks: 60 };
export const STEP_CHECK = /^s-([1-9][0-9]?)$/i;
export const QUALITY_CHECK = /^q-[a-z0-9][a-z0-9-]{0,61}$/;
export const RED_GREEN_CHECK = 'red-green';
const STATUS = ['pass', 'fail', 'unverified'];
const PROOF = /^[A-Za-z0-9-]{1,64}$/;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const isStepCheck = (check) => typeof check?.id === 'string' && STEP_CHECK.test(check.id);
const isQualityCheck = (check) => typeof check?.id === 'string' && QUALITY_CHECK.test(check.id);
const isRedGreenCheck = (check) => check?.id === RED_GREEN_CHECK;
export const isStageCheck = (check) => isStepCheck(check) || isQualityCheck(check) || isRedGreenCheck(check);
const isSpec = (check) => isAcCheck(check) || isDefectCheck(check) || isStepCheck(check) || isRedGreenCheck(check);
const itemId = (check) => (isStepCheck(check) ? `S-${Number(check.id.match(STEP_CHECK)[1])}`
  : isAcCheck(check) ? `AC-${Number(check.id.match(AC_CHECK)[1])}` : isDefectCheck(check) ? `D-${Number(check.id.match(DEFECT_CHECK)[1])}` : check.id);

export function reviewStagesMode(value = process.env.WAX_REVIEW_STAGES) {
  if (value === undefined || value === '') return 'warn';
  if (!REVIEW_STAGES_MODES.includes(value)) throw new WaxError(t('errors.reviewStages.mode', REVIEW_STAGES_MODES.join(', ')));
  return value;
}

const usable = (feature, id, testOnly) => feature.proofs?.some((proof) => proof.id === id && proof.iteration === feature.iteration &&
  ((!testOnly && proof.kind === 'git') || (proof.kind === 'test' && proof.exitCode === 0 && !proof.timedOut)));

const cleanDetail = (value) => unmention(String(value).replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}](?<![\n\t])/gu, '').trim());

export function assessReviewStages(feature, phase, checks, { mode: given } = {}) {
  const items = Array.isArray(checks) ? checks.filter(record) : [];
  for (const item of items) {
    if (item.stage !== undefined && !REVIEW_STAGES.includes(item.stage)) throw new WaxError(t('errors.reviewStages.stageValue', String(item.id).slice(0, 64), REVIEW_STAGES.join(', ')));
  }
  if (phase !== 'review') {
    const misplaced = items.filter((item) => isQualityCheck(item) || isRedGreenCheck(item) || item.stage !== undefined);
    if (misplaced.length) throw new WaxError(t('errors.reviewStages.reviewOnly', misplaced.map((item) => String(item.id).slice(0, 64)).join(', ')));
    return { record: null };
  }
  const mode = reviewStagesMode(given);
  const seen = new Set();
  for (const item of items) {
    if (isSpec(item) && item.stage !== undefined && item.stage !== 'spec') throw new WaxError(t('errors.reviewStages.wrongStage', itemId(item), 'spec'));
    if (isQualityCheck(item) && item.stage !== undefined && item.stage !== 'quality') throw new WaxError(t('errors.reviewStages.wrongStage', item.id, 'quality'));
    if (!isStageCheck(item)) continue;
    const id = itemId(item);
    if (seen.has(id)) throw new WaxError(t('errors.reviewStages.duplicate', id));
    seen.add(id);
    if (!STATUS.includes(item.status) || (item.detail !== undefined && (typeof item.detail !== 'string' || item.detail.length > REVIEW_STAGES_LIMITS.detail)) ||
        (item.proofIds !== undefined && (!Array.isArray(item.proofIds) || item.proofIds.length > 100 || !item.proofIds.every((proofId) => typeof proofId === 'string' && proofId.length <= 64)))) {
      throw new WaxError(t('errors.reviewStages.itemFormat', id));
    }
    if (isQualityCheck(item) && item.status === 'unverified' && !item.detail?.trim()) throw new WaxError(t('errors.reviewStages.unverifiedDetail', id));
  }
  const stepIds = planSteps(feature.artifacts?.plan).map((step) => step.id);
  const stepItems = items.filter(isStepCheck), qualityItems = items.filter(isQualityCheck), redGreenItem = items.find(isRedGreenCheck);
  const unknownSteps = stepItems.map(itemId).filter((id) => !stepIds.includes(id));
  if (unknownSteps.length) throw new WaxError(t('errors.reviewStages.unknownStep', unknownSteps.join(', ')));
  if (qualityItems.length > REVIEW_STAGES_LIMITS.quality) throw new WaxError(t('errors.reviewStages.tooMany', REVIEW_STAGES_LIMITS.quality));
  if (items.some((item) => (isAcCheck(item) || isDefectCheck(item)) && item.status === 'fail')) return { record: null };
  const specFailed = [...stepItems, ...(redGreenItem ? [redGreenItem] : [])].filter((item) => item.status === 'fail').map(itemId);
  if (specFailed.length) throw new WaxError(t('errors.reviewStages.specFailed', specFailed.join(', ')));
  const qualityFailed = qualityItems.filter((item) => item.status === 'fail').map((item) => item.id);
  if (qualityFailed.length) throw new WaxError(t('errors.reviewStages.qualityFailed', qualityFailed.join(', ')));
  if (mode === 'off') return { record: null };

  const noCheck = new Set(planSteps(feature.artifacts?.plan).filter((step) => !step.check || step.check.none).map((step) => step.id));
  const specState = (item) => (item.status === 'pass' && (isRedGreenCheck(item) || (isStepCheck(item) && noCheck.has(itemId(item))) ||
    (item.proofIds ?? []).some((id) => usable(feature, id, isDefectCheck(item)))) ? 'pass' : 'unverified');
  const spec = items.filter(isSpec).map(specState);
  const kept = [...stepItems, ...(redGreenItem ? [redGreenItem] : []), ...qualityItems].slice(0, REVIEW_STAGES_LIMITS.checks).map((item) => {
    const proofIds = [...new Set((item.proofIds ?? []).filter((id) => PROOF.test(id) && usable(feature, id, false)))];
    const status = isQualityCheck(item) ? item.status : specState(item);
    return { id: itemId(item), stage: isQualityCheck(item) ? 'quality' : 'spec', status, ...(item.detail?.trim() ? { detail: cleanDetail(item.detail) } : {}), ...(proofIds.length ? { proofIds } : {}) };
  });

  const warnings = [];
  const missingSteps = stepIds.filter((id) => !stepItems.some((item) => itemId(item) === id));
  if (missingSteps.length) warnings.push({ code: 'stepsMissing', ids: missingSteps });
  const implemented = feature.completed?.implement?.redGreen?.state;
  if (!redGreenItem && implemented && !['ok', 'skipped'].includes(implemented)) warnings.push({ code: 'redGreenMissing', ids: [] });
  if (!qualityItems.length) warnings.push({ code: 'noQuality', ids: [] });
  if (redGreenItem?.status === 'pass' && ['missing', 'partial'].includes(implemented)) warnings.push({ code: 'redGreenMismatch', ids: [] });
  if (mode === 'enforce') {
    const blocking = warnings.filter((item) => BLOCKING.includes(item.code));
    if (blocking.length) throw new WaxError(`${blocking.map((item) => reviewStagesWarningText(item)).join(' ')} (WAX_REVIEW_STAGES=enforce)`, 409);
  }
  const unverifiedQuality = qualityItems.filter((item) => item.status === 'unverified').length;
  return { record: { mode,
    spec: { state: 'pass', items: spec.length, unverified: spec.filter((state) => state === 'unverified').length },
    quality: { state: qualityItems.length ? 'pass' : 'none', items: qualityItems.length, unverified: unverifiedQuality },
    checks: kept, warnings } };
}

const WARNING_TEXT = { stepsMissing: 'reviewStages.warning.stepsMissing', redGreenMissing: 'reviewStages.warning.redGreenMissing',
  noQuality: 'reviewStages.warning.noQuality', redGreenMismatch: 'reviewStages.warning.redGreenMismatch' };
export const reviewStagesWarningText = (item, say = t) => (WARNING_TEXT[item?.code] ? say(WARNING_TEXT[item.code], (item.ids ?? []).join(', ')) : String(item?.code));

export function reviewStagesWarning(value) {
  if (!record(value) || !value.warnings?.length) return null;
  return t('reviewStages.warned', value.warnings.map((item) => reviewStagesWarningText(item)).join(' '));
}

export function validReviewStages(value) {
  const part = (item, states) => record(item) && states.includes(item.state) && count(item.items) && count(item.unverified) && item.unverified <= item.items;
  if (!record(value) || !['warn', 'enforce'].includes(value.mode) || !part(value.spec, ['pass']) || !part(value.quality, ['pass', 'none']) ||
      (value.quality.state === 'none') !== (value.quality.items === 0) || !Array.isArray(value.warnings) || value.warnings.length > REVIEW_STAGES_WARNINGS.length ||
      !Array.isArray(value.checks) || value.checks.length > REVIEW_STAGES_LIMITS.checks) return false;
  const codes = value.warnings.map((item) => item?.code);
  const ids = value.checks.map((item) => item?.id);
  return new Set(codes).size === codes.length && value.warnings.every((item) => record(item) && REVIEW_STAGES_WARNINGS.includes(item.code) &&
      Array.isArray(item.ids) && item.ids.length <= 100 && item.ids.every((id) => typeof id === 'string' && STEP_ID.test(id))) &&
    new Set(ids).size === ids.length && value.checks.every((item) => record(item) && REVIEW_STAGES.includes(item.stage) && STATUS.includes(item.status) &&
      (item.stage === 'quality' ? QUALITY_CHECK.test(item.id ?? '') && item.status !== 'fail' : (STEP_ID.test(item.id ?? '') || item.id === RED_GREEN_CHECK) && item.status !== 'fail') &&
      (item.detail === undefined || (typeof item.detail === 'string' && item.detail.length <= REVIEW_STAGES_LIMITS.detail * 2)) &&
      (item.proofIds === undefined || (Array.isArray(item.proofIds) && item.proofIds.length <= 100 && item.proofIds.every((id) => typeof id === 'string' && PROOF.test(id)))));
}

export function returnStages(feature) {
  const byCycle = new Map();
  for (const item of feature?.defects ?? []) {
    if (item?.source?.ruling !== undefined || !Number.isSafeInteger(item?.foundIteration)) continue;
    const entry = byCycle.get(item.foundIteration) ?? { iteration: item.foundIteration, stage: null, defects: 0 };
    entry.defects += 1;
    if (item.stage === 'spec' || (item.stage === 'quality' && entry.stage === null)) entry.stage = item.stage;
    byCycle.set(item.foundIteration, entry);
  }
  return [...byCycle.values()].sort((a, b) => a.iteration - b.iteration);
}

export function reviewStagePrompt(feature, phase, { mode: given } = {}) {
  let mode;
  try { mode = reviewStagesMode(given); } catch { return []; }
  if (mode === 'off') return [];
  if (phase === 'report') {
    const stages = feature.completed?.review?.stages;
    if (!record(stages)) return [];
    const quality = stages.checks?.filter((item) => item.stage === 'quality').map((item) => `${item.id}=${item.status}`).join(', ');
    return [`두 단계 검토 기록: 명세 항목 ${stages.spec.items}개(미검증 ${stages.spec.unverified}), 품질 항목 ${stages.quality.items}개(미검증 ${stages.quality.unverified})${quality ? `: ${quality}` : ''}. 보고서에 품질 미검증 항목을 숨기지 마세요.`];
  }
  if (phase !== 'review') return [];
  const steps = planSteps(feature.artifacts?.plan).map((step) => step.id.toLowerCase());
  const implemented = feature.completed?.implement?.redGreen?.state;
  return [[
    '검토는 두 단계로 하세요. 두 단계 모두 이 검토 세션이 하고, 구현한 세션은 검토하지 않습니다.',
    `1단계 명세: 수용 기준(ac-N), ${steps.length ? `계획 단계(${steps.join(', ')})` : '계획 단계(기획에 S-N이 있으면 s-N)'}, 빨강→초록(red-green${implemented ? `, 구현 완료 기록: ${implemented}` : ''}), 재검증할 결함(d-N)을 --checks-file 항목으로 적으세요. 예: {"id":"s-1","stage":"spec","status":"pass|fail|unverified","detail":"<확인 내용>","proofIds":["<현재 주기 근거 ID>"]}, {"id":"red-green","stage":"spec","status":"pass","detail":"<구현 기록의 짝 확인>"}.`,
    '명세 항목이 하나라도 fail이면 거기서 멈추세요. 품질은 보지 말고, 완료하지 말고, --defects-file 결함에 "stage":"spec"을 붙여 iterate하세요.',
    `2단계 품질(명세가 모두 통과한 뒤에만): ${QUALITY_ITEMS.join(', ')}(빠진 경우·약한 단언, 구조, 보안, 단순함)를 {"id":"q-tests","stage":"quality","status":"pass|fail|unverified","detail":"<확인 내용>"}로 적으세요. unverified에는 detail이 필요합니다. 품질 fail이면 "stage":"quality" 결함과 함께 iterate하세요.`,
  ].join('\n')];
}
