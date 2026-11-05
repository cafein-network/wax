import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gitEnv } from './freshness.mjs';
import { WORKTREE_ID, validWorktreeTag, worktreeTag } from './worktrees.mjs';
import { t } from '../web/messages-catalog.mjs';
import { WaxError } from './workflow.mjs';

export const SECRET_LIMITS = { files: 500, fileBytes: 1024 * 1024, bytes: 32 * 1024 * 1024, findings: 20, timeout: 10_000, buffer: 8 * 1024 * 1024 };
export const ALLOW_MARK = 'wax-secrets: allow';
export const ALLOW_FILE = 'docs/wax/secrets-allow.txt';
export const SECRET_MODES = ['enforce', 'warn', 'off'];

export const SECRET_RULES = [
  { id: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { id: 'openai-key', pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { id: 'xai-key', pattern: /\bxai-[A-Za-z0-9]{60,}/ },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe-live-key', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
];

export function secretScanMode(value = process.env.WAX_SECRET_SCAN) {
  if (value === undefined || value === '') return 'enforce';
  if (!SECRET_MODES.includes(value)) throw new WaxError(t('errors.secrets.mode', SECRET_MODES.join(', ')));
  return value;
}

export const mask = (value) => `${String(value).slice(0, 4)}…`;

export function scanLine(line) {
  if (line.includes(ALLOW_MARK)) return [];
  const found = [];
  let rest = line;
  for (const rule of SECRET_RULES) {
    const match = rest.match(rule.pattern);
    if (!match) continue;
    found.push({ rule: rule.id, preview: mask(match[0]) });
    rest = rest.replace(match[0], ' ');
  }
  return found;
}

const ENV_FILE = /^\.env(?:\..+)?$/i;
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;
const KEY_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
export function sensitiveFile(path) {
  const name = basename(path);
  if (ENV_FILE.test(name) && !ENV_EXAMPLE.test(name)) return 'env-file';
  if (KEY_FILE.test(name)) return 'key-file';
  return null;
}

export function addedLines(before, after) {
  const old = new Set(before === null ? [] : before.split(/\r?\n/));
  return after.split(/\r?\n/).map((text, index) => ({ line: index + 1, text })).filter((item) => !old.has(item.text));
}

function git(cwd, args, { buffer = SECRET_LIMITS.buffer } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'buffer', timeout: SECRET_LIMITS.timeout, maxBuffer: buffer, windowsHide: true, env: gitEnv() },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}
const names = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);
const own = (path) => path === '.wax' || path.startsWith('.wax/');

async function allowList(root) {
  try { return new Set((await readFile(join(root, ALLOW_FILE), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))); }
  catch { return new Set(); }
}

export const gitRead = (root, args) => git(root, args);

export async function taskChanges(root, { base } = {}) {
  let head, prefix;
  try { [prefix, head] = (await git(root, ['rev-parse', '--show-prefix', 'HEAD^{commit}'])).toString('utf8').split(/\r?\n/); }
  catch { return { ok: false, reason: 'no-git' }; }
  const from = typeof base === 'string' && /^[a-f0-9]{40,64}$/.test(base) ? base : head;
  try { await git(root, ['cat-file', '-e', `${from}^{commit}`]); }
  catch { return { ok: false, reason: 'base-missing', base: from }; }
  const strip = (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : null);
  const paths = new Set(), committedWax = new Set();
  try {
    if (from !== head) {
      for (const path of names(await git(root, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=d', '--relative', from, head]))) {
        (own(path) ? committedWax : paths).add(path);
      }
    }
    for (const entry of names(await git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.']))) {
      const path = strip(entry.slice(3));
      if (path === null || entry[1] === 'D' || entry[0] === 'D') continue;
      if (own(path)) { if (entry[0] !== '?' && entry[0] !== ' ') committedWax.add(path); continue; }
      paths.add(path);
    }
  } catch { return { ok: false, reason: 'git-failed', base: from }; }
  return { ok: true, base: from, head, paths, committedWax };
}

export async function scanSecrets(root, { base } = {}) {
  const changes = await taskChanges(root, { base });
  if (!changes.ok) return { state: 'unknown', reason: changes.reason, ...(changes.base ? { base: changes.base } : {}), files: 0, findings: [], more: 0 };
  const { base: from, paths, committedWax } = changes;
  if (paths.size > SECRET_LIMITS.files) return { state: 'unknown', reason: 'too-many-files', base: from, files: 0, findings: [], more: 0 };

  const allowed = await allowList(root);
  const findings = [];
  for (const path of committedWax) findings.push({ file: path, rule: 'wax-record' });
  let files = 0, bytes = 0;
  for (const path of [...paths].sort()) {
    if (allowed.has(path)) continue;
    const kind = sensitiveFile(path);
    if (kind) { findings.push({ file: path, rule: kind }); continue; }
    let info;
    try { info = await lstat(join(root, path)); } catch { continue; }
    if (!info.isFile() || info.size > SECRET_LIMITS.fileBytes) continue;
    if ((bytes += info.size) > SECRET_LIMITS.bytes) return { state: 'unknown', reason: 'too-large', base: from, files, findings: [], more: 0 };
    const content = await readFile(join(root, path));
    if (content.includes(0)) continue;
    let before = null;
    try { before = (await git(root, ['cat-file', 'blob', `${from}:./${path}`])).toString('utf8'); } catch { before = null; }
    files += 1;
    for (const { line, text } of addedLines(before, content.toString('utf8'))) {
      for (const hit of scanLine(text)) findings.push({ file: path, line, ...hit });
    }
  }
  return { state: findings.length ? 'found' : 'clean', base: from, files, findings: findings.slice(0, SECRET_LIMITS.findings), more: Math.max(0, findings.length - SECRET_LIMITS.findings) };
}

export function mergeSecretScans(project, trees) {
  const seen = trees.filter(([, scan]) => scan && scan.reason !== 'no-git');
  if (!seen.length) return project;
  const all = [project, ...seen.map(([, scan]) => scan)];
  const findings = [...project.findings, ...seen.flatMap(([entry, scan]) => scan.findings.map((item) => ({ ...item, worktree: entry.id })))];
  const more = all.reduce((sum, scan) => sum + scan.more, 0) + Math.max(0, findings.length - SECRET_LIMITS.findings);
  const unknown = all.find((scan) => scan.state === 'unknown');
  const state = findings.length ? 'found' : unknown ? 'unknown' : 'clean';
  return { state, ...(state === 'unknown' ? { reason: unknown.reason } : {}), ...(project.base ? { base: project.base } : {}), files: all.reduce((sum, scan) => sum + scan.files, 0),
    findings: findings.slice(0, SECRET_LIMITS.findings), more, worktrees: seen.map(([entry]) => worktreeTag(entry)) };
}

export function validSecretScan(scan) {
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const short = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;
  return record(scan) && ['clean', 'found', 'unknown'].includes(scan.state) && Number.isSafeInteger(scan.files) && scan.files >= 0 &&
    Number.isSafeInteger(scan.more) && scan.more >= 0 && (scan.reason === undefined || short(scan.reason, 40)) &&
    (scan.base === undefined || /^[a-f0-9]{40,64}$/.test(scan.base)) &&
    Array.isArray(scan.findings) && scan.findings.length <= SECRET_LIMITS.findings && scan.findings.every((item) => record(item) && short(item.file, 1000) && short(item.rule, 40) &&
      (item.line === undefined || (Number.isSafeInteger(item.line) && item.line > 0)) && (item.preview === undefined || short(item.preview, 8)) &&
      (item.worktree === undefined || (typeof item.worktree === 'string' && WORKTREE_ID.test(item.worktree)))) &&
    (scan.worktrees === undefined || (Array.isArray(scan.worktrees) && scan.worktrees.length <= SECRET_LIMITS.findings && scan.worktrees.every(validWorktreeTag)));
}

export const findingText = (item) => `${item.worktree ? `.wax/worktrees/${item.worktree}/` : ''}${item.file}${item.line ? `:${item.line}` : ''} ${item.rule}${item.preview ? ` ${item.preview}` : ''}`;
