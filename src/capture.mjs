import { randomUUID } from 'node:crypto';
import { constants, copyFile, lstat, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { getFeature, WaxError } from './workflow.mjs';
import { runCommand } from './evidence.mjs';
import { artifactFile } from './quality.mjs';
import { qualityRequirements } from '../web/project-types.mjs';

async function plainDirectory(path) {
  try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new WaxError('캡처 보관 경로는 심볼릭 링크가 아닌 일반 디렉터리이어야 합니다.');
}

export async function captureArtifact(root, id, { check, file, command = [], revision, timeout = 120_000 } = {}) {
  if (typeof check !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(check)) throw new WaxError('검증 항목 ID가 올바르지 않습니다.');
  if (typeof file !== 'string' || !file) throw new WaxError('--file 캡처 파일 경로가 필요합니다.');
  if (!Array.isArray(command) || command.length > 100 || command.some((arg) => typeof arg !== 'string' || arg.length > 2000) || (command.length && !command[0]) ||
      !Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) throw new WaxError('캡처 명령과 100~300000ms 제한을 확인하세요.');
  const feature = await getFeature(root, id);
  if (feature.archivedAt || feature.phase === 'done' || (revision !== undefined && revision !== feature.revision)) throw new WaxError('현재 진행 중인 최신 작업에서 캡처하세요.', 409);
  let run = null;
  if (command.length) {
    const started = Date.now();
    run = { command, ...(await runCommand(root, command, timeout)), durationMs: Date.now() - started };
    if (run.exitCode !== 0 || run.timedOut) throw new WaxError(`캡처 명령이 실패했습니다(종료 코드 ${run.exitCode ?? run.signal ?? '없음'}${run.timedOut ? ', 시간 초과' : ''}).\n${run.output.slice(-2000)}`);
  }
  const kind = qualityRequirements(feature.projectType, feature.phase, feature.workMode).find((rule) => rule.id === check)?.kind === 'preview' ? 'preview' : 'visual';
  const source = await artifactFile(root, file, kind);
  if (!source) throw new WaxError('캡처 파일을 확인하세요. 프로젝트 안의 비어 있지 않은 20MB 이하 이미지·동영상' + (kind === 'preview' ? '·HTML 시안' : '') + '이어야 합니다.');
  const parts = ['.wax', 'artifacts', feature.id, `${feature.phase}-${feature.iteration}`];
  let directory = resolve(root);
  for (const part of parts) { directory = join(directory, part); await plainDirectory(directory); }
  const name = `${check}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}${extname(source).toLowerCase()}`;
  await copyFile(source, join(directory, name), constants.COPYFILE_EXCL);
  const artifact = [...parts, name].join('/');
  if (!(await artifactFile(root, artifact, kind))) throw new WaxError('캡처를 보관하지 못했습니다. .wax 경로를 확인하세요.');
  return { artifact, check, phase: feature.phase, iteration: feature.iteration, source: file,
    ...(run ? { command: run.command, exitCode: run.exitCode, durationMs: run.durationMs } : {}) };
}
