import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const TREE_LIMITS = { files: 200, bytes: 64 * 1024 * 1024, timeout: 5000, buffer: 1_000_000 };
const SHA = /^[a-f0-9]{40,64}$/;
const own = (path) => path !== '.wax' && !path.startsWith('.wax/');
const list = (text) => text.split('\0').filter(Boolean);

function git(root, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', ...args], { cwd: root, encoding: 'utf8', timeout: TREE_LIMITS.timeout, maxBuffer: TREE_LIMITS.buffer, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.on('error', () => {   });
    child.stdin.end(input);
  });
}

async function changedFiles(root, head, top, prefix) {
  const tracked = head ? list(await git(root, ['diff', '--name-only', '--relative', '--no-renames', '-z', head, '--']))
    : list(await git(root, ['ls-files', '-z', '--cached']));
  const untracked = list(await git(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  const paths = [...new Set([...tracked, ...untracked])].filter(own).sort();
  if (paths.length > TREE_LIMITS.files || paths.some((path) => path.includes('\n'))) throw new Error('tree too large');
  const files = {}, present = [];
  let bytes = 0;
  for (const path of paths) {
    let info;
    try { info = await lstat(join(root, path)); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { files[path] = null; continue; } throw error; }
    if (info.isDirectory()) continue;
    if ((bytes += info.size) > TREE_LIMITS.bytes) throw new Error('tree too large');
    present.push(path);
  }
  if (present.length) {
    const ids = (await git(top, ['hash-object', '--stdin-paths'], present.map((path) => prefix + path).join('\n') + '\n')).split(/\r?\n/).filter(Boolean);
    if (ids.length !== present.length || !ids.every((id) => SHA.test(id))) throw new Error('hash failed');
    present.forEach((path, index) => { files[path] = ids[index]; });
  }
  return files;
}

export async function treeFingerprint(root) {
  let top, prefix;
  try { [top, prefix = ''] = (await git(root, ['rev-parse', '--show-toplevel', '--show-prefix'])).split(/\r?\n/); } catch { return undefined; }
  if (!top) return undefined;
  let head = null;
  try { head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null; } catch {   }
  if (head !== null && !SHA.test(head)) return undefined;
  try { return { head, files: await changedFiles(root, head, top, prefix) }; } catch { return { head, unknown: true }; }
}

export function validTree(tree) {
  if (tree === undefined) return true;
  if (!tree || typeof tree !== 'object' || Array.isArray(tree) || (tree.head !== null && !SHA.test(tree.head))) return false;
  if (tree.unknown === true) return tree.files === undefined;
  if (tree.unknown !== undefined || !tree.files || typeof tree.files !== 'object' || Array.isArray(tree.files)) return false;
  const entries = Object.entries(tree.files);
  return entries.length <= TREE_LIMITS.files && entries.every(([path, id]) => path && path.length <= 4096 && !path.includes('\n') && !path.includes('\0') && (id === null || (typeof id === 'string' && SHA.test(id))));
}

export function createTreeObserver(root) {
  let current;
  const diffs = new Map();
  const now = () => (current ??= treeFingerprint(root).catch(() => undefined));
  const between = (from, to) => {
    const key = `${from}..${to}`;
    if (!diffs.has(key)) diffs.set(key, git(root, ['diff', '--name-only', '--relative', '--no-renames', '-z', from, to, '--']).then(list, () => null));
    return diffs.get(key);
  };
  async function blobs(requests) {
    const out = new Map(), asked = requests.filter(([head]) => head);
    for (const [head, path] of requests) if (!head) out.set(`${head}:${path}`, null);
    if (!asked.length) return out;
    const lines = (await git(root, ['cat-file', '--batch-check=%(objectname)'], asked.map(([head, path]) => `${head}:./${path}`).join('\n') + '\n')).split(/\r?\n/);
    asked.forEach(([head, path], index) => out.set(`${head}:${path}`, SHA.test(lines[index] ?? '') ? lines[index] : null));
    return out;
  }
  return async function observe(tree) {
    if (!tree || tree.unknown || !tree.files) return { state: 'unknown', files: [] };
    const present = await now();
    if (!present || present.unknown) return { state: 'unknown', files: [] };
    if (tree.head !== present.head && (!tree.head || !present.head)) return { state: 'unknown', files: [] };
    const committed = tree.head === present.head ? [] : await between(tree.head, present.head);
    if (!committed) return { state: 'unknown', files: [] };
    const paths = [...new Set([...Object.keys(tree.files), ...Object.keys(present.files), ...committed])].filter(own).sort();
    const changed = [], lookups = [], pending = [];
    for (const path of paths) {
      const before = Object.hasOwn(tree.files, path), after = Object.hasOwn(present.files, path);
      if (!before && !after) { changed.push(path); continue; }
      pending.push(path);
      if (!before) lookups.push([tree.head, path]);
      if (!after) lookups.push([present.head, path]);
    }
    let found;
    try { found = await blobs(lookups); } catch { return { state: 'unknown', files: [] }; }
    for (const path of pending) {
      const before = Object.hasOwn(tree.files, path) ? tree.files[path] : found.get(`${tree.head}:${path}`);
      const after = Object.hasOwn(present.files, path) ? present.files[path] : found.get(`${present.head}:${path}`);
      if (before !== after) changed.push(path);
    }
    changed.sort();
    return { state: changed.length ? 'changed' : 'unchanged', files: changed };
  };
}

export function freshnessBasis(feature) {
  const usable = (feature.proofs ?? []).filter((proof) => proof.tree && proof.iteration === feature.iteration && (proof.kind === 'git' || (proof.exitCode === 0 && !proof.timedOut)));
  for (const phase of ['review', 'implement']) {
    const found = usable.filter((proof) => proof.phase === phase).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    if (found) return found;
  }
  return null;
}

export async function evidenceFreshness(root, feature, observe = createTreeObserver(root)) {
  const basis = freshnessBasis(feature);
  if (!basis) return null;
  const result = await observe(basis.tree);
  return { basis: { id: basis.id, phase: basis.phase, at: basis.at }, state: result.state, count: result.files.length, files: result.files.slice(0, 20) };
}

export function freshnessText(freshness, shown = 10) {
  if (!freshness) return '';
  const label = freshness.basis.phase === 'review' ? '검토 근거' : '구현 근거';
  const since = `${label}(${freshness.basis.at}) 이후`;
  if (freshness.state === 'unknown') return `${since} 바뀐 파일은 미확인입니다(작업 트리를 비교하지 못함).`;
  if (freshness.state === 'unchanged') return `${since} 바뀐 파일 없음(관찰 기록, 판정 아님).`;
  const names = freshness.files.slice(0, shown).join(', ');
  return `${since} 바뀐 파일 ${freshness.count}개: ${names}${freshness.count > shown ? ` 외 ${freshness.count - shown}개` : ''} (관찰 기록, 판정 아님. 보고에 반영할지, 테스트를 다시 실행할지 확인하세요).`;
}

export async function headState(root) {
  let head, prefix;
  try { [prefix, head] = (await git(root, ['rev-parse', '--show-prefix', 'HEAD^{commit}'])).split(/\r?\n/); } catch { return {}; }
  if (!SHA.test(head ?? '')) return {};
  try {
    const entries = list(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.']));
    return { head, dirty: entries.some((entry) => /^.. /.test(entry) && own(entry.slice(3).slice(entry.slice(3).startsWith(prefix) ? prefix.length : 0))) };
  } catch { return { head }; }
}
