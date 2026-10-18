import { lstat, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getFeature } from './workflow.mjs';

export async function diagnoseProject(root) {
  const project = resolve(root);
  const result = { ok: true, project, features: { total: 0, valid: 0 }, issues: [] };
  const issue = (file, code, message) => { result.ok = false; result.issues.push({ file, code, message }); };
  try {
    if (!(await stat(project)).isDirectory()) throw new Error('기존 프로젝트 디렉터리를 지정하세요.');
    for (const path of [join(project, '.wax'), join(project, '.wax', 'features')]) {
      let info;
      try { info = await lstat(path); }
      catch (error) { if (error.code === 'ENOENT') return result; throw error; }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path}: wax 데이터 경로는 일반 디렉터리이어야 합니다.`);
    }
    const directory = join(project, '.wax', 'features');
    for (const file of (await readdir(directory)).sort()) {
      if (file.endsWith('.lock')) issue(file, 'LOCK_PRESENT', '저장 잠금이 있습니다. 실행 중인 wax 작업이 있는지 확인하세요. 진단은 잠금을 삭제하지 않습니다.');
      if (!file.endsWith('.json')) continue;
      result.features.total += 1;
      try { await getFeature(project, file.slice(0, -5)); result.features.valid += 1; }
      catch (error) { issue(file, 'INVALID_RECORD', error.message); }
    }
  } catch (error) { issue(project, 'INVALID_DIRECTORY', error.message); }
  return result;
}
