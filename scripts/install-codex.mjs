#!/usr/bin/env node
import { lstat, mkdir, realpath, readdir, readlink, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PHASES } from '../src/workflow.mjs';

const comparablePath = (path) => process.platform === 'win32' ? path.replace(/^\\\\\?\\/, '').toLowerCase() : path;
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const names = ['init', 'join', ...PHASES, 'status', 'iterate', 'chat', 'daily', 'pm', 'work'].map((phase) => `wax-${phase}`);
async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function installCodex({ project, check = false, source = pluginRoot } = {}) {
  if (!project) throw new Error('--project로 스킬을 사용할 기존 프로젝트를 지정하세요.');
  const target = await realpath(resolve(project));
  if (!(await stat(target)).isDirectory()) throw new Error('프로젝트는 디렉터리이어야 합니다.');
  source = await realpath(source);
  const directory = join(target, '.agents', 'skills');
  for (const path of [dirname(directory), directory]) {
    const info = await inspect(path);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`${path}: 기존 경로가 일반 디렉터리가 아닙니다. 변경하지 않았습니다.`);
  }
  const skills = [];
  for (const name of names) {
    const from = join(source, 'skills', name.slice('wax-'.length));
    for (const file of ['SKILL.md', 'run.mjs']) {
      if (!(await stat(join(from, file))).isFile()) throw new Error(`${name}/${file}이 없습니다. 플러그인을 다시 압축 해제하세요.`);
    }
    const path = join(directory, name);
    const info = await inspect(path);
    let matches = false, broken = false;
    if (info?.isSymbolicLink()) {
      try { matches = comparablePath(await realpath(path)) === comparablePath(await realpath(from)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; broken = true; }
    }
    skills.push({ name, path, source: from, status: matches ? 'installed' : broken ? 'stale' : info ? 'conflict' : 'missing' });
  }
  const obsolete = [], warnings = [];
  for (const name of (await readdir(directory).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })).filter((name) => name.startsWith('wax-'))) {
    const path = join(directory, name), entry = await inspect(path);
    if (!entry?.isSymbolicLink()) continue;
    try { await realpath(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; (names.includes(name) || name === 'wax-dashboard' ? obsolete : warnings).push({ name, path }); }
  }
  if (check) return { ok: !obsolete.length && skills.every((skill) => skill.status === 'installed'), project: target, skills, obsolete, warnings };
  const conflict = skills.find((skill) => skill.status === 'conflict');
  if (conflict) throw new Error(`${conflict.path}: 다른 스킬이나 이전 경로가 있습니다. 내용을 확인한 뒤 해당 경로를 옮기고 다시 설치하세요. 기존 파일은 변경하지 않았습니다.`);
  await mkdir(directory, { recursive: true });
  const created = [], removed = [];
  try {
    for (const item of obsolete) { const target = await readlink(item.path); await rm(item.path); removed.push({ ...item, target }); }
    for (const skill of skills.filter((item) => ['missing', 'stale'].includes(item.status))) {
      await symlink(skill.source, skill.path, process.platform === 'win32' ? 'junction' : 'dir');
      created.push(skill.path);
      skill.status = 'installed';
    }
  } catch (error) {
    for (const path of created) await rm(path, { force: true });
    for (const item of removed) await symlink(item.target, item.path, process.platform === 'win32' ? 'junction' : 'dir');
    throw error;
  }
  return { ok: true, project: target, skills, obsolete: [], warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { project: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log('node scripts/install-codex.mjs --project <기존 프로젝트> [--check]\n프로젝트의 .agents/skills에 wax 스킬 13개를 연결합니다(Codex·Antigravity CLI·GitHub Copilot CLI 공용). --check는 읽기 전용 설치 검사입니다.');
    else {
      const result = await installCodex(values);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) { console.error(`wax Codex 설치: ${error.message}`); process.exitCode = 1; }
}
