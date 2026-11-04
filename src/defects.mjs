import { t } from '../web/messages-catalog.mjs';
import { WaxError } from './workflow.mjs';
import { describeProof } from './acceptance.mjs';
import { AUTHOR } from './proof-schema.mjs';

export const DEFECT_ID = /^D-[1-9][0-9]{0,2}$/;
export const DEFECT_CHECK = /^d-([1-9][0-9]{0,2})$/i;
export const MAX_DEFECTS = 100;
export const MAX_NEW_DEFECTS = 20;
export const DEFECT_STATES = ['open', 'resolved'];
export const DEFECT_LABELS = { open: '열림', resolved: '해결(재검증됨)' };
const STATUS = ['pass', 'fail', 'unverified'];
const AC = /^AC-[1-9][0-9]{0,2}$/;

export const isDefectCheck = (check) => typeof check?.id === 'string' && DEFECT_CHECK.test(check.id);
const key = (id) => `D-${Number(id.match(DEFECT_CHECK)[1])}`;
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const optional = (value, limit) => value === undefined || text(value, limit);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const iteration = (value) => Number.isSafeInteger(value) && value >= 0;
const proofList = (value) => Array.isArray(value) && value.length <= 100 && value.every((id) => typeof id === 'string' && id.length <= 64);

export function validDefects(defects) {
  return Array.isArray(defects) && defects.length <= MAX_DEFECTS && new Set(defects.map((item) => item?.id)).size === defects.length &&
    defects.every((item) => item !== null && typeof item === 'object' && DEFECT_ID.test(item.id) && text(item.title, 200) && optional(item.detail, 2000) &&
      (item.ac === undefined || AC.test(item.ac)) && DEFECT_STATES.includes(item.status) && iteration(item.foundIteration) && timestamp(item.foundAt) &&
      (item.author === undefined || (typeof item.author === 'string' && AUTHOR.test(item.author))) &&
      (item.status === 'open'
        ? item.resolvedIteration === undefined && item.resolvedAt === undefined && item.proofIds === undefined
        : iteration(item.resolvedIteration) && item.resolvedIteration > item.foundIteration && timestamp(item.resolvedAt) && proofList(item.proofIds) && item.proofIds.length > 0) &&
      optional(item.verifyDetail, 2000));
}

export function validDefectTrace(trace) {
  return Array.isArray(trace) && trace.length <= MAX_DEFECTS && new Set(trace.map((item) => item?.id)).size === trace.length &&
    trace.every((item) => item !== null && typeof item === 'object' && DEFECT_ID.test(item.id) && DEFECT_STATES.includes(item.status) &&
      proofList(item.proofIds) && optional(item.detail, 2000));
}

export function newDefects(feature, input, { at, author } = {}) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.length || input.length > MAX_NEW_DEFECTS) throw new WaxError(t('errors.defects.listFormat', MAX_NEW_DEFECTS));
  const existing = feature.defects ?? [];
  if (existing.length + input.length > MAX_DEFECTS) throw new WaxError(t('errors.defects.tooMany', MAX_DEFECTS));
  let next = Math.max(0, ...existing.map((item) => Number(item.id.slice(2)))) + 1;
  if (next + input.length - 1 > 999) throw new WaxError(t('errors.defects.tooMany', MAX_DEFECTS));
  return input.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || !text(item.title, 200) || !optional(item.detail, 2000) ||
        (item.ac !== undefined && (typeof item.ac !== 'string' || !AC.test(item.ac.toUpperCase())))) {
      throw new WaxError(t('errors.defects.itemFormat', index + 1));
    }
    return { id: `D-${next++}`, title: item.title.trim(), ...(item.detail?.trim() ? { detail: item.detail.trim() } : {}),
      ...(item.ac ? { ac: item.ac.toUpperCase() } : {}), status: 'open', foundIteration: feature.iteration, foundAt: at, ...(author ? { author } : {}) };
  });
}

export const dueDefects = (feature) => (feature.defects ?? []).filter((item) => item.status === 'open' && item.foundIteration < feature.iteration);
export const openDefects = (feature) => (feature.defects ?? []).filter((item) => item.status === 'open');

const passingTest = (feature, id) => feature.proofs?.some((proof) => proof.id === id && proof.iteration === feature.iteration &&
  proof.kind === 'test' && proof.exitCode === 0 && !proof.timedOut);

export function assessDefects(feature, phase, checks, waiver) {
  const items = Array.isArray(checks) ? checks.filter(isDefectCheck) : [];
  if (waiver !== undefined && !text(waiver, 2000)) throw new WaxError(t('errors.defects.waiverFormat'));
  const none = { record: {}, resolve: () => {} };
  if (phase !== 'review') {
    if (items.length || waiver !== undefined) throw new WaxError(t('errors.defects.reviewOnly'));
    return none;
  }
  const due = dueDefects(feature), dueIds = due.map((item) => item.id);
  const given = new Map();
  for (const item of items) {
    if (!STATUS.includes(item.status) || (item.proofIds !== undefined && !proofList(item.proofIds)) || !optional(item.detail, 2000)) {
      throw new WaxError(t('errors.defects.checkFormat', item.id));
    }
    const id = key(item.id);
    if (given.has(id)) throw new WaxError(t('errors.defects.duplicateCheck', id));
    if (!dueIds.includes(id)) throw new WaxError(t('errors.defects.notDue', id));
    given.set(id, item);
  }
  if (!due.length) {
    if (waiver !== undefined) throw new WaxError(t('errors.defects.nothingDue'));
    return none;
  }
  const open = [];
  const trace = due.map(({ id }) => {
    const item = given.get(id);
    const proofIds = [...new Set((item?.proofIds ?? []).filter((proofId) => passingTest(feature, proofId)))];
    const status = item?.status === 'pass' && proofIds.length ? 'resolved' : 'open';
    if (item?.status === 'fail') return { id, status: 'fail' };
    if (status === 'open') open.push(`${id}(${!item ? '항목 없음' : item.status === 'pass' ? '현재 주기 통과 테스트 근거 없음' : '미검증'})`);
    return { id, status, proofIds, ...(item?.detail?.trim() ? { detail: item.detail.trim() } : {}) };
  });
  const failed = trace.filter((item) => item.status === 'fail').map((item) => item.id);
  if (failed.length) throw new WaxError(t('errors.defects.failed', failed.join(', ')));
  if (open.length && waiver === undefined) throw new WaxError(t('errors.defects.unverified', open.join(', ')));
  if (!open.length && waiver !== undefined) throw new WaxError(t('errors.defects.waiverNotNeeded'));
  return {
    record: { defects: trace, ...(waiver !== undefined ? { defectWaiver: waiver.trim() } : {}) },
    resolve(target, at) {
      for (const entry of trace.filter((item) => item.status === 'resolved')) {
        const defect = target.defects.find((item) => item.id === entry.id);
        Object.assign(defect, { status: 'resolved', resolvedIteration: target.iteration, resolvedAt: at, proofIds: entry.proofIds, ...(entry.detail ? { verifyDetail: entry.detail } : {}) });
      }
    }
  };
}

const cell = (value) => String(value).replace(/[|\r\n]+/g, ' ');

export function defectTable(feature) {
  const defects = feature.defects ?? [];
  if (!defects.length) return '';
  const rows = defects.map((item) => `| ${item.id} | ${cell(item.title)}${item.ac ? ` (${item.ac})` : ''} | ${DEFECT_LABELS[item.status]} | ${item.foundIteration} | ${item.resolvedIteration ?? '-'} | ${cell((item.proofIds ?? []).map((id) => describeProof(feature, id)).join('; ') || '-')} |`);
  return ['| 결함 | 내용 | 상태 | 찾은 주기 | 해결 주기 | 재검증 근거 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function defectPrompt(feature, phase) {
  const lines = [];
  const open = openDefects(feature), due = dueDefects(feature);
  const list = (items) => items.map((item) => `- ${item.id}: ${cell(item.title)}${item.ac ? ` (${item.ac})` : ''}${item.detail ? ` — ${cell(item.detail)}` : ''}`).join('\n');
  if (phase === 'implement' && open.length) lines.push(`이전 검토에서 찾은 열린 결함입니다. 각 결함을 고치고, 다시 생기지 않음을 보이는 테스트를 준비하세요:\n${list(open)}`);
  if (phase === 'review') {
    if (due.length) lines.push(`재검증할 결함 ID: ${due.map((item) => item.id).join(', ')}. 완료할 때 --checks-file JSON 배열에 결함마다 {"id":"d-1","status":"pass|fail|unverified","detail":"<확인 내용>","proofIds":["<현재 주기 통과 테스트 근거 ID>"]}를 넣으세요. 재검증은 통과한 테스트 근거로만 인정합니다. 아직 고쳐지지 않았으면 fail로 두고 완료하지 말고 iterate하세요. 재검증할 수 없는 결함이 남으면 --defect-unverified <사유>로 이유를 남겨야 완료되며, 그 결함은 열린 채로 남습니다.\n${list(due)}`);
    lines.push('검토에서 결함을 찾아 iterate할 때는 --defects-file JSON 배열에 결함마다 {"title":"<무엇이 잘못됐나>","detail":"<재현 방법과 영향>","ac":"AC-1(관련 수용 기준, 선택)"}을 넣어 결함 기록(D-N)으로 남기세요.');
  }
  if (phase === 'report' && (feature.defects ?? []).length) lines.push(`결함 기록:\n${defectTable(feature)}\n보고서에 열린 결함을 숨기지 마세요.`);
  return lines;
}
