import { t } from '../../web/messages-catalog.mjs';
import { execFile } from 'node:child_process';
import { WaxError } from '../workflow.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const GITHUB_LIMITS = {
  timeoutMs: 20_000, maxBuffer: 4 * 1024 * 1024, issues: 100, runs: 20, title: 300, body: 1500, labels: 10, seen: 500,
  everyMinMs: MINUTE, everyMaxMs: DAY, slackMs: 30_000, authOkMs: 10 * MINUTE, error: 300,
};
export const DEFAULT_EVERY = '5m';
export const CONNECTION = ['ok', 'missing', 'unauthenticated', 'unreachable'];

const fail = (id, ...values) => new WaxError(t(id, ...values), 400);
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/+-]{1,200}$/;
const cutText = (text, limit) => { const all = Array.from(String(text ?? '')); return all.length > limit ? `${all.slice(0, limit - 1).join('')}…` : all.join(''); };
const httpsUrl = (value) => typeof value === 'string' && value.length <= 300 && /^https:\/\/[^\s"'<>`]+$/.test(value) ? value : '';
const isoOrEmpty = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';

export function everyMs(text) {
  const match = /^(\d{1,4})([mhd])$/.exec(String(text ?? '').trim());
  const ms = match ? Number(match[1]) * { m: MINUTE, h: HOUR, d: DAY }[match[2]] : NaN;
  if (!(ms >= GITHUB_LIMITS.everyMinMs && ms <= GITHUB_LIMITS.everyMaxMs)) throw fail('errors.chat.triggers.invalidEvery');
  return ms;
}

function repoOf(value) {
  const repo = typeof value === 'string' ? value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '') : '';
  if (!REPO.test(repo)) throw fail('errors.chat.triggers.invalidRepo');
  return repo;
}
function every(value) {
  const text = value === undefined || value === null || value === '' ? DEFAULT_EVERY : String(value).trim();
  everyMs(text);
  return text;
}
function plainName(value, limit, id, { optional = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text && optional) return '';
  if (!text || Array.from(text).length > limit || CONTROL.test(text) || text.includes(',') || text.startsWith('-')) throw fail(id, limit);
  return text;
}

export const normalizeIssues = (source) => ({ type: 'github-issues', repo: repoOf(source.repo), label: plainName(source.label, 50, 'errors.chat.triggers.invalidLabel'), every: every(source.every) });
export function normalizeCi(source) {
  const branch = typeof source.branch === 'string' ? source.branch.trim() : '';
  if (!BRANCH.test(branch) || branch.endsWith('/') || branch.endsWith('.lock')) throw fail('errors.chat.triggers.invalidBranch');
  const workflow = plainName(source.workflow, 100, 'errors.chat.triggers.invalidWorkflow', { optional: true });
  return { type: 'ci-failure', repo: repoOf(source.repo), branch, ...(workflow ? { workflow } : {}), every: every(source.every) };
}
export const describeIssues = (source) => `${source.repo} · label:${source.label} · ${source.every}`;
export const describeCi = (source) => `${source.repo} · ${source.branch}${source.workflow ? ` · ${source.workflow}` : ''} · ${source.every}`;

export function runGh(args, { signal, timeout = GITHUB_LIMITS.timeoutMs, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(env.WAX_GH_BIN || 'gh', args, {
      timeout, maxBuffer: GITHUB_LIMITS.maxBuffer, windowsHide: true, signal, encoding: 'utf8',
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' },
    }, (error, stdout, stderr) => {
      if (error) { reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })); return; }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const AUTH = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials|requires authentication|GH_TOKEN/i;
export const aborted = (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
const firstLine = (text) => cutText(String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '', GITHUB_LIMITS.error);

export function classifyGhError(error) {
  if (error?.code === 'ENOENT') return { connection: 'missing' };
  const stderr = String(error?.stderr ?? '');
  if (AUTH.test(stderr)) return { connection: 'unauthenticated', detail: firstLine(stderr) };
  if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') return { error: new WaxError(t('errors.chat.triggers.ghTimeout', Math.round(GITHUB_LIMITS.timeoutMs / 1000)), 502) };
  return { error: new WaxError(t('errors.chat.triggers.ghFailed', firstLine(stderr) || firstLine(error?.message) || String(error?.code ?? '')), 502) };
}

export async function checkConnection(gh, { signal } = {}) {
  try { await gh(['auth', 'status'], { signal }); return { status: 'ok' }; }
  catch (error) {
    if (aborted(error)) throw error;
    if (error?.code === 'ENOENT') return { status: 'missing' };
    if (error?.killed || error?.signal === 'SIGTERM') return { status: 'unreachable' };
    return { status: 'unauthenticated', detail: firstLine(error?.stderr) };
  }
}

function parseArray(stdout) {
  let data;
  try { data = JSON.parse(String(stdout ?? '')); } catch { throw new WaxError(t('errors.chat.triggers.ghBadOutput'), 502); }
  if (!Array.isArray(data)) throw new WaxError(t('errors.chat.triggers.ghBadOutput'), 502);
  return data;
}

export function parseIssues(stdout, source) {
  const out = [];
  for (const item of parseArray(stdout)) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.number) || item.number < 1) continue;
    const title = cutText(typeof item.title === 'string' ? item.title : '', GITHUB_LIMITS.title);
    const url = httpsUrl(item.url);
    const labels = (Array.isArray(item.labels) ? item.labels : []).map((label) => (typeof label?.name === 'string' ? cutText(label.name, 50) : '')).filter(Boolean).slice(0, GITHUB_LIMITS.labels);
    const body = cutText(typeof item.body === 'string' ? item.body : '', GITHUB_LIMITS.body);
    const updatedAt = isoOrEmpty(item.updatedAt);
    out.push({
      key: `github-issues:${source.repo.toLowerCase()}#${item.number}`, at: updatedAt, missed: 0,
      source: { type: 'github-issues', label: `${source.repo}#${item.number}`, ...(url ? { url } : {}) },
      values: { issue: { number: item.number, title, url, repo: source.repo, labels: labels.join(', '), updatedAt } },
      quoted: [`#${item.number} ${title}`, url, labels.length ? `labels: ${labels.join(', ')}` : '', body ? `\n${body}` : ''].filter(Boolean).join('\n'),
    });
  }
  return out.sort((a, b) => a.values.issue.number - b.values.issue.number);
}

export function parseRuns(stdout, source) {
  const out = [];
  for (const item of parseArray(stdout)) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.databaseId) || item.databaseId < 1) continue;
    const name = cutText(typeof item.name === 'string' ? item.name : '', GITHUB_LIMITS.title);
    const sha = typeof item.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(item.headSha) ? item.headSha.slice(0, 12) : '';
    const url = httpsUrl(item.url);
    const createdAt = isoOrEmpty(item.createdAt);
    out.push({
      key: `ci-failure:${item.databaseId}`, at: createdAt, missed: 0,
      source: { type: 'ci-failure', label: `${source.repo} · ${source.branch} · run ${item.databaseId}`, ...(url ? { url } : {}) },
      values: { run: { id: item.databaseId, name, url, sha, branch: source.branch, repo: source.repo, workflow: source.workflow ?? '', createdAt } },
      quoted: [name, `${source.branch}${sha ? ` @ ${sha}` : ''}`, url, createdAt].filter(Boolean).join('\n'),
    });
  }
  return out.sort((a, b) => (a.at || '').localeCompare(b.at || '') || a.values.run.id - b.values.run.id);
}

export async function fetchIssues(source, { gh, signal } = {}) {
  const { stdout } = await gh(['issue', 'list', `--repo=${source.repo}`, `--label=${source.label}`, '--state=open', '--json=number,title,body,url,labels,updatedAt', `--limit=${GITHUB_LIMITS.issues}`], { signal });
  const events = parseIssues(stdout, source);
  return { events, truncated: events.length >= GITHUB_LIMITS.issues };
}
export async function fetchRuns(source, { gh, signal } = {}) {
  const { stdout } = await gh(['run', 'list', `--repo=${source.repo}`, `--branch=${source.branch}`, '--status=failure', ...(source.workflow ? [`--workflow=${source.workflow}`] : []),
    '--json=databaseId,name,headSha,url,createdAt', `--limit=${GITHUB_LIMITS.runs}`], { signal });
  const events = parseRuns(stdout, source);
  return { events, truncated: events.length >= GITHUB_LIMITS.runs };
}

export function diffSeen(events, seen, { truncated = false } = {}) {
  const first = !Array.isArray(seen);
  const before = new Set(first ? [] : seen);
  const fresh = first ? [] : events.filter((event) => !before.has(event.key));
  const keys = events.map((event) => event.key);
  const kept = truncated && !first ? seen.filter((key) => !keys.includes(key)) : [];
  return { first, fresh, seen: [...kept, ...keys].slice(-GITHUB_LIMITS.seen) };
}

export function pollDue(source, state = {}, now) {
  const last = Date.parse(state.lastPoll ?? '');
  return !Number.isFinite(last) || now - last >= everyMs(source.every) - GITHUB_LIMITS.slackMs || last > now;
}
