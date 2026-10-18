import { createHash } from 'node:crypto';
import { scanFeatures, getFeature, importFeature, validateStored, validId, RAW_LIMIT, DAMAGED_LIMIT, RAW_BUDGET, WaxError } from './workflow.mjs';
const hash = (value) => {
  const digest = createHash('sha256');
  const visit = (item) => {
    if (Array.isArray(item)) {
      digest.update('['); for (let i = 0; i < item.length; i++) { if (i) digest.update(','); visit(item[i] ?? null); } digest.update(']');
    } else if (item !== null && typeof item === 'object') {
      digest.update('{'); let first = true;
      for (const key of Object.keys(item)) {
        if (item[key] === undefined) continue;
        if (!first) digest.update(','); first = false; digest.update(JSON.stringify(key) + ':'); visit(item[key]);
      }
      digest.update('}');
    } else digest.update(JSON.stringify(item));
  };
  visit(value); return digest.digest('hex');
};
export async function createBackup(root, { rawBudget = RAW_BUDGET } = {}) {
  const first = await scanFeatures(root, { includeRaw: true, rawBudget });
  const { features, issues } = first;
  const second = await scanFeatures(root, { includeRaw: true, rawBudget });
  if (hash(first) !== hash(second)) throw new WaxError('백업 중 기록이 변경되었습니다. 다시 시도하세요.', 409);
  if (features.length > 1000) throw new WaxError('백업은 정상 작업 1000개까지 지원합니다. 작업을 나누어 내보내세요.');
  const data = { format: 'wax-workspace', version: 1, createdAt: new Date().toISOString(), features, complete: !issues.length, damaged: issues.slice(0, DAMAGED_LIMIT),
    ...(issues.length > DAMAGED_LIMIT ? { damagedOmitted: issues.length - DAMAGED_LIMIT } : {}) };
  return { ...data, checksum: hash(data) };
}
export function validateBackup(backup) {
  if (!backup || backup.format !== 'wax-workspace' || backup.version !== 1 || !Array.isArray(backup.features) || backup.features.length > 1000 ||
      typeof backup.createdAt !== 'string' || !Number.isFinite(Date.parse(backup.createdAt))) throw new WaxError('지원하는 wax 백업 파일이 아닙니다.');
  const { checksum, ...data } = backup;
  const validIssue = (item) => {
    if (!item || typeof item.file !== 'string' || /[\\/]/.test(item.file) || typeof item.message !== 'string') return false;
    if (item.raw !== undefined && (typeof item.raw !== 'string' || Buffer.byteLength(item.raw) > RAW_LIMIT)) return false;
    if (item.rawBase64 !== undefined && (typeof item.rawBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.rawBase64) || Buffer.from(item.rawBase64, 'base64').length > RAW_LIMIT)) return false;
    if (item.rawOmitted !== undefined && (item.rawOmitted !== true || !Number.isSafeInteger(item.size) || item.size < 0)) return false;
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) return false;
    if (item.omittedReason !== undefined && (item.omittedReason !== 'total-limit' || item.rawOmitted !== true)) return false;
    return [item.raw !== undefined, item.rawBase64 !== undefined, item.rawOmitted === true].filter(Boolean).length <= 1;
  };
  if ((backup.complete !== undefined && typeof backup.complete !== 'boolean') ||
      (backup.damagedOmitted !== undefined && (!Number.isSafeInteger(backup.damagedOmitted) || backup.damagedOmitted < 0)) ||
      (backup.damaged !== undefined && (!Array.isArray(backup.damaged) || backup.damaged.length > DAMAGED_LIMIT || !backup.damaged.every(validIssue)))) throw new WaxError('손상 기록 목록의 형식을 확인하세요.');
  if (checksum !== hash(data)) throw new WaxError('백업 체크섬이 일치하지 않습니다. 파일이 변경되거나 손상되었습니다.');
  const ids = new Set();
  for (const feature of backup.features) {
    try { validateStored(feature); } catch { throw new WaxError('백업에 잘못된 작업 기록이 있습니다.'); }
    if (ids.has(feature.id)) throw new WaxError('백업에 중복된 작업 ID가 있습니다.'); ids.add(feature.id);
  }
  return backup;
}
export async function previewRestore(root, backup, prefix = '') {
  validateBackup(backup);
  if (typeof prefix !== 'string' || (prefix && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(prefix))) throw new WaxError('복원 접두사는 영문 소문자·숫자·하이픈 32자 이하이어야 합니다.');
  const items = [];
  for (const feature of backup.features) {
    const id = validId(prefix + feature.id);
    try {
      const existing = await getFeature(root, id);
      items.push({ sourceId: feature.id, id, title: feature.title, status: 'exists', revision: existing.revision });
    } catch (error) {
      if (error.status === 404) items.push({ sourceId: feature.id, id, title: feature.title, status: 'new' });
      else if (error.status === 500) items.push({ sourceId: feature.id, id, title: feature.title, status: 'damaged' });
      else throw error;
    }
  }
  return { items, damagedCount: (backup.damaged?.length ?? 0) + (backup.damagedOmitted ?? 0), damagedOmitted: backup.damagedOmitted ?? 0, warnings: (backup.damaged ?? []).map(({ raw, rawBase64, ...issue }) => issue), newCount: items.filter((item) => item.status === 'new').length, skippedCount: items.filter((item) => item.status !== 'new').length,
    fingerprint: hash({ checksum: backup.checksum, prefix, items }) };
}
export async function restoreBackup(root, backup, { prefix = '', fingerprint } = {}) {
  const preview = await previewRestore(root, backup, prefix);
  if (!fingerprint || fingerprint !== preview.fingerprint) throw new WaxError('복원 대상이 변경되었습니다. 먼저 다시 미리보기 하세요.', 409);
  const result = { restored: [], skipped: preview.items.filter((item) => item.status !== 'new'), failed: [] };
  for (const item of preview.items.filter((item) => item.status === 'new')) {
    try { await importFeature(root, backup.features.find((feature) => feature.id === item.sourceId), item.id); result.restored.push(item.id); }
    catch (error) {
      if (error.status === 409) result.skipped.push({ ...item, status: 'changed' });
      else { result.failed.push({ id: item.id, error: '복원 중 오류가 발생했습니다. 저장 경로와 기록을 확인하세요.' }); break; }
    }
  }
  result.remaining = preview.newCount - result.restored.length - result.skipped.filter((item) => item.status === 'changed').length;
  return result;
}
