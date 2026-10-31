import { t } from '../web/messages-catalog.mjs';
import { lstat, readdir, readFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WaxError } from './workflow.mjs';
import { LockError, processAlive, withFileLock } from './file-lock.mjs';
import { safeDir, checkFile } from './chat/paths.mjs';
import { writeJsonAtomic } from './chat/store.mjs';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ['pending', 'decided', 'dispatching', 'delivered', 'cancelled', 'expired'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const immutable = (r) => JSON.stringify([r.id, r.project, r.tool, r.session, r.callId, r.action, r.details, r.createdAt, r.expiresAt, r.ownerPid]);
const directory = (root, create = false) => safeDir(root, ['.wax', 'approvals'], { create });
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const APPROVAL_HISTORY_LIMIT = 100;
const snapshots = new Map();

function validate(r, id) {
  if (!r || r.schema !== 1 || r.id !== id || !ID.test(id) || !['claude', 'codex', 'gemini', 'copilot', 'antigravity'].includes(r.tool) ||
      !text(r.project, 4096) || !text(r.session, 256) || !text(r.callId, 256) || !text(r.action, 160) ||
      !r.details || typeof r.details !== 'object' || Array.isArray(r.details) || JSON.stringify(r.details).length > 100_000 ||
      !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= r.createdAt ||
      !Number.isSafeInteger(r.ownerPid) || r.ownerPid < 1 || !HASH.test(r.secretHash) ||
      r.fingerprint !== hash(immutable(r)) || !STATES.includes(r.status) || !Array.isArray(r.events) ||
      (['decided', 'dispatching', 'delivered'].includes(r.status) && !['allow', 'deny'].includes(r.decision))) {
    throw new WaxError(t('errors.approvals.theApprovalRecordIs'), 500);
  }
  return r;
}

async function load(root, id, { dir, project } = {}) {
  if (!ID.test(id)) throw new WaxError(t('errors.approvals.invalidApprovalRequestId'));
  dir ??= await directory(root);
  if (!dir) throw new WaxError(t('errors.approvals.noApprovalRequest'), 404);
  const path = await checkFile(join(dir, `${id}.json`));
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new WaxError(t('errors.approvals.noApprovalRequest'), 404);
    if (error instanceof SyntaxError) throw new WaxError(t('errors.approvals.theApprovalRecordJson'), 500);
    throw error;
  }
  validate(record, id);
  if (record.project !== (project ?? await realpath(root))) throw new WaxError(t('errors.approvals.approvalRequestFromA'), 403);
  return record;
}

function status(r, now = Date.now(), alive = processAlive) {
  if (['delivered', 'cancelled', 'expired'].includes(r.status)) return r.status;
  if (now >= r.expiresAt) return 'expired';
  if (!alive(r.ownerPid)) return 'cancelled';
  return r.status;
}

function publicRecord(r, current = status(r)) {
  const { secretHash, ownerPid, ...result } = r;
  return { ...structuredClone(result), status: current };
}

async function change(root, id, transform) {
  if (!ID.test(id)) throw new WaxError(t('errors.approvals.invalidApprovalRequestId'));
  const dir = await directory(root);
  if (!dir) throw new WaxError(t('errors.approvals.noApprovalRequest'), 404);
  return withFileLock(join(dir, `${id}.lock`), async () => {
    const record = await load(root, id);
    const result = await transform(record);
    await writeJsonAtomic(join(dir, `${id}.json`), record);
    return result;
  });
}

function authorize(record, secret) {
  const actual = hash(typeof secret === 'string' ? secret : '');
  if (!timingSafeEqual(Buffer.from(record.secretHash, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new WaxError(t('errors.approvals.theConnectionToReceive'), 403);
  }
}

export async function createApproval(root, input, { timeoutMs = 120_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new WaxError(t('errors.approvals.theApprovalWaitTime'));
  const secret = randomBytes(32).toString('hex');
  const createdAt = Date.now();
  const record = { schema: 1, id: randomUUID(), project: await realpath(root), tool: input.tool,
    session: input.session, callId: input.callId, action: input.action, details: structuredClone(input.details),
    createdAt, expiresAt: createdAt + timeoutMs, ownerPid: process.pid, secretHash: hash(secret),
    status: 'pending', events: [{ status: 'pending', at: createdAt }] };
  record.fingerprint = hash(immutable(record));
  validate(record, record.id);
  const dir = await directory(root, true);
  await writeJsonAtomic(join(dir, `${record.id}.json`), record);
  return { request: publicRecord(record), secret };
}

async function snapshot(root) {
  const dir = await directory(root);
  if (!dir) return { records: [], issues: [] };
  const project = await realpath(root);
  let cache = snapshots.get(project);
  if (!cache) {
    if (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value);
    cache = new Map(); snapshots.set(project, cache);
  }
  let names;
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { records: [], issues: [] }; throw error; }
  const present = new Set(names);
  for (const name of cache.keys()) if (!present.has(name)) cache.delete(name);
  const records = [], issues = [];
  for (let offset = 0; offset < names.length; offset += 16) {
    await Promise.all(names.slice(offset, offset + 16).map(async (file) => {
      try {
        const info = await lstat(join(dir, file), { bigint: true });
        if (!info.isFile() || info.isSymbolicLink()) throw new WaxError(t('errors.approvals.theApprovalRecordMust'), 500);
        const signature = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
        let entry = cache.get(file);
        if (entry?.signature !== signature) {
          entry = { signature, record: await load(root, file.slice(0, -5), { dir, project }) };
          cache.set(file, entry);
        }
        records.push(entry.record);
      } catch (error) {
        cache.delete(file);
        if (error.code !== 'ENOENT' && error.status !== 404) issues.push({ file, message: error.message });
      }
    }));
  }
  issues.sort((a, b) => a.file.localeCompare(b.file));
  return { records, issues };
}

export async function listApprovals(root) {
  const { records, issues } = await snapshot(root), now = Date.now(), pids = new Map();
  const alive = (pid) => { if (!pids.has(pid)) pids.set(pid, processAlive(pid)); return pids.get(pid); };
  const requests = records.map((record) => publicRecord(record, status(record, now, alive)));
  requests.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const active = requests.filter((r) => ['pending', 'decided', 'dispatching'].includes(r.status));
  const history = requests.filter((r) => !['pending', 'decided', 'dispatching'].includes(r.status));
  return { requests: [...active, ...history.slice(0, 50)], issues, historyOmitted: Math.max(0, history.length - 50) };
}

export async function pruneApprovals(root, { onBusy } = {}) {
  const dir = await directory(root);
  if (!dir) return 0;
  try {
    return await prune(root, dir);
  } catch (error) {
    if (!(error instanceof LockError)) throw error;
    onBusy?.();
    return 0;
  }
}

function prune(root, dir) {
  return withFileLock(join(dir, 'retention.lock'), async () => {
    const { records } = await snapshot(root), now = Date.now();
    const eligible = (r) => ['delivered', 'cancelled', 'expired'].includes(r.status) || r.expiresAt + 5000 < now;
    const history = records.filter(eligible).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    let removed = 0;
    const candidates = history.slice(APPROVAL_HISTORY_LIMIT);
    for (let offset = 0; offset < candidates.length; offset += 16) {
      await Promise.all(candidates.slice(offset, offset + 16).map((candidate) => withFileLock(join(dir, `${candidate.id}.lock`), async () => {
        let current;
        try { current = await load(root, candidate.id); } catch (error) { if (error.status === 404) return; throw error; }
        if (!eligible(current)) return;
        await checkFile(join(dir, `${candidate.id}.json`));
        await unlink(join(dir, `${candidate.id}.json`)); removed++;
      }, { sweep: false }).catch((error) => { if (!(error instanceof LockError)) throw error; })));
    }
    return removed;
  }, { timeoutMs: 1000 });
}

export async function decideApproval(root, id, { decision, fingerprint, actor }) {
  if (!['allow', 'deny'].includes(decision) || !text(actor, 80)) throw new WaxError(t('errors.approvals.chooseAllowOnceOr'));
  return change(root, id, (record) => {
    if (fingerprint !== record.fingerprint) throw new WaxError(t('errors.approvals.theRequestShownDiffers'), 409);
    if (status(record) !== 'pending') throw new WaxError(t('errors.approvals.thisRequestWasAlready'), 409);
    Object.assign(record, { status: 'decided', decision, decidedBy: actor, decidedAt: Date.now() });
    record.events.push({ status: 'decided', decision, actor, at: record.decidedAt });
    return publicRecord(record);
  });
}

export async function takeDecision(root, id, secret) {
  return change(root, id, (record) => {
    authorize(record, secret);
    const current = status(record);
    if (current === 'pending') return null;
    if (current !== 'decided') throw new WaxError(t('errors.approvals.thisRequestsResponseHas'), 409);
    record.status = 'dispatching';
    record.events.push({ status: 'dispatching', at: Date.now() });
    return record.decision;
  });
}

export async function finishDelivery(root, id, secret) {
  return change(root, id, (record) => {
    authorize(record, secret);
    if (record.status !== 'dispatching') throw new WaxError(t('errors.approvals.notAnApprovalResponse'), 409);
    record.status = 'delivered'; record.deliveredAt = Date.now();
    record.events.push({ status: 'delivered', at: record.deliveredAt });
  });
}

export async function cancelApproval(root, id, secret, reason = '연결 종료') {
  return change(root, id, (record) => {
    authorize(record, secret);
    if (['delivered', 'cancelled', 'expired'].includes(record.status)) return;
    record.status = Date.now() >= record.expiresAt ? 'expired' : 'cancelled'; record.reason = String(reason).slice(0, 200);
    record.events.push({ status: record.status, at: Date.now(), reason: record.reason });
  });
}

export async function cancelSessionApprovals(root, tool, session) {
  for (const request of (await listApprovals(root)).requests) {
    if (request.tool !== tool || request.session !== session || !['pending', 'decided', 'dispatching'].includes(request.status)) continue;
    await change(root, request.id, (record) => {
      if (!['pending', 'decided', 'dispatching'].includes(record.status)) return;
      record.status = 'cancelled'; record.reason = '도구 세션 종료';
      record.events.push({ status: 'cancelled', at: Date.now(), reason: record.reason });
    });
  }
}

export async function waitForApproval(root, pending, { signal, pollMs = 200 } = {}) {
  let claimed = false;
  try {
    while (!signal?.aborted) {
      const record = await load(root, pending.request.id);
      authorize(record, pending.secret);
      if (status(record) === 'decided') {
        const decision = await takeDecision(root, record.id, pending.secret);
        claimed = true;
        return decision;
      }
      if (status(record) !== 'pending') return null;
      await sleep(pollMs, undefined, { signal });
    }
    return null;
  } catch (error) {
    if (signal?.aborted || error.status === 409) return null;
    throw error;
  } finally {
    if (!claimed) await cancelApproval(root, pending.request.id, pending.secret, signal?.aborted ? '연결 또는 요청 종료' : '승인 대기 만료').catch(() => {});
  }
}
