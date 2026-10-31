import { t } from '../../web/messages-catalog.mjs';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WaxError } from '../workflow.mjs';

export async function resolveProject({ project, env = process.env, cwd = process.cwd() } = {}) {
  const root = resolve(cwd, project || env.WAX_PROJECT || '.');
  let info;
  try { info = await stat(root); } catch { throw new WaxError(t('errors.chat.paths.projectPathDoesNot', root), 404); }
  if (!info.isDirectory()) throw new WaxError(t('errors.chat.paths.projectPathIsNot', root));
  return root;
}

async function checkDir(path, create) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new WaxError(t('errors.chat.paths.theChatDataPath'), 500);
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
    if (!/^[.a-z0-9-]+$/.test(part) || part === '.' || part === '..') throw new WaxError(t('errors.chat.paths.invalidStoragePath'));
    path = join(path, part);
    if (!(await checkDir(path, create))) return null;
  }
  return path;
}

export const chatDir = (root, area, options) => safeDir(root, ['.wax', 'chat', ...(area ? [area] : [])], options);

export async function checkFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new WaxError(t('errors.chat.paths.theChatRecordMust'), 500);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path;
}
