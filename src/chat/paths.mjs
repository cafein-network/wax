import { lstat, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WaxError } from '../workflow.mjs';

export async function resolveProject({ project, env = process.env, cwd = process.cwd() } = {}) {
  const root = resolve(cwd, project || env.WAX_PROJECT || '.');
  let info;
  try { info = await stat(root); } catch { throw new WaxError(`프로젝트 경로가 없습니다: ${root}`, 404); }
  if (!info.isDirectory()) throw new WaxError(`프로젝트 경로가 디렉터리가 아닙니다: ${root}`);
  return root;
}

async function checkDir(path, create) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new WaxError('채팅 데이터 경로는 심볼릭 링크가 아닌 일반 디렉터리여야 합니다.', 500);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return false;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') throw mkdirError;
      return checkDir(path, false);
    }
    return true;
  }
}

export async function safeDir(root, parts, { create = false } = {}) {
  let path = resolve(root);
  for (const part of parts) {
    if (!/^[.a-z0-9-]+$/.test(part) || part === '.' || part === '..') throw new WaxError('잘못된 저장 경로입니다.');
    path = join(path, part);
    if (!(await checkDir(path, create))) return null;
  }
  return path;
}

export const chatDir = (root, area, options) => safeDir(root, ['.wax', 'chat', ...(area ? [area] : [])], options);

export async function checkFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new WaxError('채팅 기록은 심볼릭 링크가 아닌 일반 파일이어야 합니다.', 500);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path;
}
