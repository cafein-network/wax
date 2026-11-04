import { t } from '../web/messages-catalog.mjs';
import { WaxError } from './workflow.mjs';

const DECLARED = /^[ \t>*#|+-]*AC-([1-9][0-9]{0,2})(?![0-9A-Za-z_-])/gm;
const TRACE_ID = /^AC-[1-9][0-9]{0,2}$/;
export const AC_CHECK = /^ac-([1-9][0-9]{0,2})$/i;
export const MAX_ACCEPTANCE = 100;
const STATUS = ['pass', 'fail', 'unverified'];
export const AC_LABELS = { pass: '통과', fail: '실패', unverified: '미검증', pending: '검토 전' };

export const isAcCheck = (check) => typeof check?.id === 'string' && AC_CHECK.test(check.id);
const key = (id) => `AC-${Number(id.match(AC_CHECK)[1])}`;

export function acceptanceIds(plan) {
  if (typeof plan !== 'string') return [];
  const numbers = new Set([...plan.matchAll(DECLARED)].map((match) => Number(match[1])));
  return [...numbers].sort((a, b) => a - b).slice(0, MAX_ACCEPTANCE).map((n) => `AC-${n}`);
}

export function validTrace(trace) {
  return Array.isArray(trace) && trace.length <= MAX_ACCEPTANCE && new Set(trace.map((item) => item?.id)).size === trace.length &&
    trace.every((item) => item !== null && typeof item === 'object' && TRACE_ID.test(item.id) && STATUS.includes(item.status) &&
      Array.isArray(item.proofIds) && item.proofIds.length <= 100 && item.proofIds.every((id) => typeof id === 'string' && id.length <= 64) &&
      (item.detail === undefined || (typeof item.detail === 'string' && item.detail.length <= 2000)));
}

const usable = (feature, id) => feature.proofs?.some((proof) => proof.id === id && proof.iteration === feature.iteration &&
  (proof.kind === 'git' || (proof.exitCode === 0 && !proof.timedOut)));

export function assessAcceptance(feature, phase, checks, waiver) {
  const items = Array.isArray(checks) ? checks.filter(isAcCheck) : [];
  if (waiver !== undefined && (typeof waiver !== 'string' || !waiver.trim() || waiver.length > 2000)) throw new WaxError(t('errors.acceptance.unverifiedAcceptanceCriteriaReason'));
  if (phase !== 'review') {
    if (items.length || waiver !== undefined) throw new WaxError(t('errors.acceptance.acceptanceCriteriaItemsAc'));
    return {};
  }
  const declared = acceptanceIds(feature.artifacts.plan);
  const given = new Map();
  for (const item of items) {
    if (!STATUS.includes(item.status) || (item.proofIds !== undefined && (!Array.isArray(item.proofIds) || item.proofIds.length > 100 || !item.proofIds.every((id) => typeof id === 'string'))) ||
        (item.detail !== undefined && (typeof item.detail !== 'string' || item.detail.length > 2000))) {
      throw new WaxError(t('errors.acceptance.acceptanceCriteriaItemCheck', item.id));
    }
    const id = key(item.id);
    if (given.has(id)) throw new WaxError(t('errors.acceptance.acceptanceCriteriaItemIs', id));
    if (!declared.includes(id)) throw new WaxError(t('errors.acceptance.isNotAnAcceptance', id));
    given.set(id, item);
  }
  if (!declared.length) {
    if (waiver !== undefined) throw new WaxError(t('errors.acceptance.thePlanHasNo'));
    return {};
  }
  const open = [];
  const trace = declared.map((id) => {
    const item = given.get(id);
    const proofIds = [...new Set((item?.proofIds ?? []).filter((proofId) => usable(feature, proofId)))];
    const status = item?.status === 'pass' && proofIds.length ? 'pass' : item?.status === 'fail' ? 'fail' : 'unverified';
    if (status === 'unverified') open.push(`${id}(${!item ? '항목 없음' : item.status === 'pass' ? '현재 주기 통과 근거 없음' : '미검증'})`);
    return { id, status, proofIds, ...(item?.detail?.trim() ? { detail: item.detail.trim() } : {}) };
  });
  const failed = trace.filter((item) => item.status === 'fail').map((item) => item.id);
  if (failed.length) throw new WaxError(t('errors.acceptance.acceptanceCriterionIsMarked', failed.join(', ')));
  if (open.length && waiver === undefined) {
    throw new WaxError(t('errors.acceptance.someAcceptanceCriteriaIn', open.join(', ')));
  }
  if (!open.length && waiver !== undefined) throw new WaxError(t('errors.acceptance.ifEveryAcceptanceCriterion'));
  return { acceptance: trace, ...(waiver !== undefined ? { acWaiver: waiver.trim() } : {}) };
}

export function acceptanceTrace(feature) {
  const recorded = feature.completed?.review?.acceptance ?? [];
  return acceptanceIds(feature.artifacts?.plan).map((id) => recorded.find((item) => item.id === id) ?? { id, status: 'pending', proofIds: [] });
}

export function describeProof(feature, id) {
  const proof = feature.proofs?.find((item) => item.id === id);
  if (!proof) return `${id.slice(0, 8)}(기록 없음)`;
  if (proof.kind === 'git') return `커밋 ${proof.commit.slice(0, 12)}`;
  return `테스트 ${proof.command.join(' ').slice(0, 80)} (exit=${proof.exitCode}, ${id.slice(0, 8)})`;
}

export function acceptanceTable(feature) {
  const trace = acceptanceTrace(feature);
  if (!trace.length) return '';
  const cell = (text) => text.replace(/[|\r\n]+/g, ' ');
  const rows = trace.map((item) => `| ${item.id} | ${AC_LABELS[item.status]} | ${cell(item.proofIds.map((id) => describeProof(feature, id)).join('; ') || '-')} |`);
  const waiver = feature.completed?.review?.acWaiver;
  return ['| 수용 기준 | 상태 | 근거 |', '| --- | --- | --- |', ...rows, ...(waiver ? [`\n미검증 사유: ${cell(waiver)}`] : [])].join('\n');
}
