import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getFeature } from './workflow.mjs';
import { detectProjectType } from './project-detect.mjs';
import { installedVersion } from './chat/tools.mjs';

async function browserTools(project, readVersion) {
  const projectType = await detectProjectType(project);
  const playwrightCli = await installedVersion('playwright-cli', readVersion ? { read: readVersion } : {});
  let playwrightTest = null;
  try { playwrightTest = JSON.parse(await readFile(join(project, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version ?? null; } catch {   }
  const hints = [];
  if (!playwrightCli) hints.push('화면 탐색·캡처: npm install -g @playwright/cli@latest (에이전트 스킬: Claude Code는 playwright-cli install --skills, 그 밖의 도구는 --skills agents)');
  if (!playwrightTest && projectType === 'web') hints.push('E2E 근거: npm install -D @playwright/test && npx playwright install chromium');
  return { projectType, playwrightCli, playwrightTest, hints };
}

export async function diagnoseProject(root, { readVersion } = {}) {
  const project = resolve(root);
  const result = { ok: true, project, features: { total: 0, valid: 0 }, issues: [], browser: await browserTools(project, readVersion) };
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
