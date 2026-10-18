import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { qualityRequirements } from '../web/project-types.mjs';

const PREVIEW = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.html', '.blend', '.rbxl', '.rbxlx', '.mp4']);
const CAPTURE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4']);
export async function artifactFile(root, file, kind = 'preview') {
  if (typeof file !== 'string' || !file || file.length > 2000 || isAbsolute(file)) return null;
  try {
    const base = await realpath(root), path = await realpath(resolve(base, file));
    const local = relative(base, path);
    if (!local || local === '..' || local.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(local)) return null;
    if (!(kind === 'preview' ? PREVIEW : CAPTURE).has(extname(path).toLowerCase())) return null;
    const info = await stat(path);
    return info.isFile() && info.size > 0 && info.size <= 20 * 1024 * 1024 ? path : null;
  } catch { return null; }
}
export async function assessQuality(root, feature, checks = [], proofIds = []) {
  const requirements = qualityRequirements(feature.projectType, feature.phase, feature.workMode);
  if (!requirements.length) return { ok: true, checks: [], missing: [], failed: [] };
  const valid = Array.isArray(checks) && checks.length <= 20 && checks.every(c => c && typeof c.id === 'string' && ['pass', 'fail', 'unverified'].includes(c.status) &&
    typeof c.detail === 'string' && c.detail.trim() && c.detail.length <= 2000 && typeof c.artifact === 'string' && c.artifact.length <= 2000 &&
    Array.isArray(c.proofIds) && c.proofIds.length <= 100 && c.proofIds.every(id => typeof id === 'string')) && new Set(checks.map(c => c.id)).size === checks.length;
  const missing = [], failed = [], results = [];
  for (const rule of requirements) {
    const result = valid && checks.find(c => c.id === rule.id);
    let passed = result?.status === 'pass';
    if (passed && ['preview', 'visual'].includes(rule.kind)) passed = Boolean(await artifactFile(root, result.artifact, rule.kind));
    if (passed && rule.kind !== 'preview') passed = result.proofIds.some(id => proofIds.includes(id) && feature.proofs?.some(p => p.id === id && p.kind === 'test' && p.phase === feature.phase && p.iteration === feature.iteration && p.exitCode === 0 && !p.timedOut && p.verification === rule.kind && p.checks?.includes(rule.id)));
    if (!passed) missing.push(rule.label);
    if (result?.status === 'fail') failed.push(rule.label);
    results.push({ id: rule.id, label: rule.label, status: passed ? 'pass' : result?.status === 'fail' ? 'fail' : 'unverified', detail: result?.detail || '아직 검증 근거가 없습니다.', artifact: result?.artifact || '', proofIds: passed ? result.proofIds : [] });
  }
  return { ok: missing.length === 0, checks: results, missing, failed };
}
export const qualityMessage = assessment => `필수 검증을 확인하지 못해 완료하지 않았습니다: ${assessment.missing.join(', ')}. 시안 파일과 해당 항목에 연결한 실제 실행 근거를 확인한 뒤 이어서 진행하세요.`;
