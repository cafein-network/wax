import { t } from '../web/messages-catalog.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeDir, checkFile } from './chat/paths.mjs';
import { withLock } from './chat/lock.mjs';
import { renameWithRetry } from './file-lock.mjs';
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
const FILE_PATH = /^\.wax\/(?:chat\/(?:(?:rules|memos|assignments|daily)\.jsonl|team\.json|(?:channels|board)\/[a-z0-9][a-z0-9-]{0,63}\.jsonl)|wiki\/(?:state\.json|log\.jsonl))$/;
export const FILE_BUDGET = 128 * 1024 * 1024, FILE_COUNT = 5000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
async function listRecordFiles(root) {
  const paths = [];
  const add = async (parts, pick) => {
    const dir = await safeDir(root, parts);
    if (dir) for (const name of (await readdir(dir)).filter(pick).sort()) paths.push([...parts, name].join('/'));
  };
  await add(['.wax', 'chat'], (name) => ['rules.jsonl', 'memos.jsonl', 'assignments.jsonl', 'daily.jsonl', 'team.json'].includes(name));
  for (const area of ['channels', 'board']) await add(['.wax', 'chat', area], (name) => /^[a-z0-9][a-z0-9-]{0,63}\.jsonl$/.test(name));
  await add(['.wax', 'wiki'], (name) => ['state.json', 'log.jsonl'].includes(name));
  return paths;
}
async function collectFiles(root, budget) {
  const files = [];
  let used = 0;
  for (const path of await listRecordFiles(root)) {
    let data;
    try { data = await readFile(await checkFile(join(root, path))); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (used + data.length > budget) { files.push({ path, size: data.length, omitted: true }); continue; }
    used += data.length;
    let text; try { text = utf8.decode(data); } catch {   }
    files.push(text === undefined ? { path, size: data.length, base64: data.toString('base64') } : { path, size: data.length, text });
  }
  if (files.length > FILE_COUNT) throw new WaxError(t('errors.backup.aBackupSupportsUp', FILE_COUNT));
  return files;
}
const fileBytes = (item) => item.text !== undefined ? Buffer.from(item.text, 'utf8') : Buffer.from(item.base64, 'base64');
export async function createBackup(root, { rawBudget = RAW_BUDGET, fileBudget = FILE_BUDGET } = {}) {
  const snapshot = async () => ({ ...(await scanFeatures(root, { includeRaw: true, rawBudget })), files: await collectFiles(root, fileBudget) });
  const first = await snapshot();
  const { features, issues, files } = first;
  if (hash(first) !== hash(await snapshot())) throw new WaxError(t('errors.backup.recordsChangedDuringThe'), 409);
  if (features.length > 1000) throw new WaxError(t('errors.backup.aBackupSupportsUpTo'));
  const data = { format: 'wax-workspace', version: 2, createdAt: new Date().toISOString(), features, complete: !issues.length, damaged: issues.slice(0, DAMAGED_LIMIT),
    ...(issues.length > DAMAGED_LIMIT ? { damagedOmitted: issues.length - DAMAGED_LIMIT } : {}), files };
  return { ...data, checksum: hash(data) };
}
export function validateBackup(backup) {
  if (!backup || backup.format !== 'wax-workspace' || ![1, 2].includes(backup.version) || !Array.isArray(backup.features) || backup.features.length > 1000 ||
      typeof backup.createdAt !== 'string' || !Number.isFinite(Date.parse(backup.createdAt))) throw new WaxError(t('errors.backup.thisIsNotA'));
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
      (backup.damaged !== undefined && (!Array.isArray(backup.damaged) || backup.damaged.length > DAMAGED_LIMIT || !backup.damaged.every(validIssue)))) throw new WaxError(t('errors.backup.checkTheFormatOf'));
  if (backup.version === 1 ? backup.files !== undefined : !Array.isArray(backup.files)) throw new WaxError(t('errors.backup.thisIsNotA'));
  const paths = new Set();
  let total = 0;
  for (const item of backup.files ?? []) {
    const ok = item && typeof item.path === 'string' && FILE_PATH.test(item.path) && !paths.has(item.path) && Number.isSafeInteger(item.size) && item.size >= 0 &&
      [item.text !== undefined, item.base64 !== undefined, item.omitted === true].filter(Boolean).length === 1 &&
      (item.text === undefined || (typeof item.text === 'string' && Buffer.byteLength(item.text) === item.size)) &&
      (item.base64 === undefined || (typeof item.base64 === 'string' && BASE64.test(item.base64) && Buffer.from(item.base64, 'base64').length === item.size));
    if (!ok || paths.size >= FILE_COUNT) throw new WaxError(t('errors.backup.checkTheFormatOfThe'));
    paths.add(item.path); if (!item.omitted) total += item.size;
  }
  if (total > FILE_BUDGET) throw new WaxError(t('errors.backup.aRecordFileIn'));
  if (checksum !== hash(data)) throw new WaxError(t('errors.backup.theBackupChecksumDoes'));
  const ids = new Set();
  for (const feature of backup.features) {
    try { validateStored(feature); } catch { throw new WaxError(t('errors.backup.theBackupHasAn')); }
    if (ids.has(feature.id)) throw new WaxError(t('errors.backup.theBackupHasDuplicate')); ids.add(feature.id);
  }
  return backup;
}
async function fileExists(root, path) {
  const parts = path.split('/'), name = parts.pop(), dir = await safeDir(root, parts);
  if (!dir) return false;
  try { await lstat(join(dir, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function createFile(root, item) {
  const parts = item.path.split('/'), name = parts.pop(), file = join(await safeDir(root, parts, { create: true }), name);
  await withLock(`${file}.lock`, async () => {
    if (await fileExists(root, item.path)) throw new WaxError(t('errors.backup.existingRecordFilesAre'), 409);
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, fileBytes(item), { flag: 'wx', mode: 0o600 }); await renameWithRetry(temp, file); }
    finally { await rm(temp, { force: true }); }
  });
}
export async function previewRestore(root, backup, prefix = '') {
  validateBackup(backup);
  if (typeof prefix !== 'string' || (prefix && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(prefix))) throw new WaxError(t('errors.backup.theRestorePrefixMust'));
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
  const files = [];
  for (const item of backup.files ?? []) {
    const status = item.omitted ? 'omitted' : prefix ? 'prefix' : await fileExists(root, item.path) ? 'exists' : 'new';
    files.push({ path: item.path, size: item.size, status });
  }
  return { items, files, damagedCount: (backup.damaged?.length ?? 0) + (backup.damagedOmitted ?? 0), damagedOmitted: backup.damagedOmitted ?? 0, warnings: (backup.damaged ?? []).map(({ raw, rawBase64, ...issue }) => issue), newCount: items.filter((item) => item.status === 'new').length, skippedCount: items.filter((item) => item.status !== 'new').length,
    newFileCount: files.filter((item) => item.status === 'new').length, skippedFileCount: files.filter((item) => item.status !== 'new').length,
    fingerprint: hash({ checksum: backup.checksum, prefix, items, ...(files.length ? { files } : {}) }) };
}
export async function restoreBackup(root, backup, { prefix = '', fingerprint } = {}) {
  const preview = await previewRestore(root, backup, prefix);
  if (!fingerprint || fingerprint !== preview.fingerprint) throw new WaxError(t('errors.backup.theRestoreTargetChanged'), 409);
  const result = { restored: [], skipped: preview.items.filter((item) => item.status !== 'new'), failed: [] };
  for (const item of preview.items.filter((item) => item.status === 'new')) {
    try { await importFeature(root, backup.features.find((feature) => feature.id === item.sourceId), item.id); result.restored.push(item.id); }
    catch (error) {
      if (error.status === 409) result.skipped.push({ ...item, status: 'changed' });
      else { result.failed.push({ id: item.id, error: '복원 중 오류가 발생했습니다. 저장 경로와 기록을 확인하세요.' }); break; }
    }
  }
  result.remaining = preview.newCount - result.restored.length - result.skipped.filter((item) => item.status === 'changed').length;
  result.restoredFiles = []; result.skippedFiles = preview.files.filter((item) => item.status !== 'new');
  for (const item of result.failed.length ? [] : preview.files.filter((item) => item.status === 'new')) {
    try { await createFile(root, backup.files.find((file) => file.path === item.path)); result.restoredFiles.push(item.path); }
    catch (error) {
      if (error.status === 409) result.skippedFiles.push({ ...item, status: 'changed' });
      else { result.failed.push({ path: item.path, error: '기록 파일 복원 중 오류가 발생했습니다. 저장 경로를 확인하세요.' }); break; }
    }
  }
  result.remainingFiles = preview.newFileCount - result.restoredFiles.length - result.skippedFiles.filter((item) => item.status === 'changed').length;
  return result;
}
