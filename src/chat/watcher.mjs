import { EventEmitter } from 'node:events';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listFeatures } from '../workflow.mjs';
import { chatDir } from './paths.mjs';
import { parseLines } from './store.mjs';
import { listPresence } from './presence.mjs';
import { listApprovals, pruneApprovals } from '../approvals.mjs';

export class ChatWatcher extends EventEmitter {
  constructor(root, { intervalMs = 1000, featureIntervalMs = 3000 } = {}) {
    super();
    Object.assign(this, { root, intervalMs, featureIntervalMs });
    this.offsets = new Map();
    this.pending = new Map();
    this.presenceMtime = 0;
    this.dailyMtime = 0;
    this.teamSignature = '';
    this.featureSignature = '';
    this.approvalSignature = '';
    this.approvalError = '';
    this.lastApprovalPrune = 0;
    this.lastFeatureCheck = 0;
    this.running = false;
  }

  async start() {
    try { await this.tick({ initial: true }); }
    catch (error) { this.emit('error', error); }
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); } catch (error) { this.emit('error', error); }
      if (this.running) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, this.intervalMs);
  }

  stop() { this.running = false; clearTimeout(this.timer); }

  async scanArea(area, initial, onRecord) {
    const dir = await chatDir(this.root, area);
    if (!dir) return;
    for (const name of await readdir(dir)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}\.jsonl$/.test(name)) continue;
      const file = join(dir, name);
      const { size } = await stat(file);
      const offset = this.offsets.get(file) ?? (initial ? size : 0);
      if (size < offset) { this.offsets.set(file, 0); this.pending.delete(file); continue; }
      if (size === offset) { this.offsets.set(file, size); continue; }
      const handle = await open(file, 'r');
      let chunk;
      try {
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        chunk = Buffer.concat([this.pending.get(file) ?? Buffer.alloc(0), buffer]);
      } finally { await handle.close(); }
      this.offsets.set(file, size);
      const end = chunk.lastIndexOf(0x0a);
      this.pending.set(file, chunk.subarray(end + 1));
      if (end < 0) continue;
      const { records } = parseLines(chunk.subarray(0, end).toString('utf8'));
      for (const record of records) onRecord(name.slice(0, -6), record);
    }
  }

  async tick({ initial = false } = {}) {
    try {
      if (initial || Date.now() - this.lastApprovalPrune >= 60_000) {
        this.lastApprovalPrune = Date.now();
        await pruneApprovals(this.root);
      }
      const approvals = await listApprovals(this.root);
      const approvalSignature = JSON.stringify([approvals.requests.map((r) => [r.id, r.status, r.decision]), approvals.issues]);
      if (approvalSignature !== this.approvalSignature) {
        this.approvalSignature = approvalSignature;
        if (!initial) this.emit('approvals', {});
      }
      this.approvalError = '';
    } catch (error) {
      const signature = `${error.code || error.status}:${error.message}`;
      if (signature !== this.approvalError) { this.approvalError = signature; this.emit('error', error); }
    }
    await this.scanArea('channels', initial, (channel, message) => this.emit('message', { channel, message }));
    await this.scanArea('board', initial, (board, record) => {
      if (record.record === 'note') this.emit('note', { board, note: record });
      else if (record.record === 'report') this.emit('report', { board, report: record });
    });
    const dir = await chatDir(this.root);
    if (dir) {
      try {
        const { mtimeMs } = await stat(join(dir, 'presence.json'));
        if (mtimeMs !== this.presenceMtime) {
          this.presenceMtime = mtimeMs;
          if (!initial) this.emit('presence', { agents: await listPresence(this.root) });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const team = [];
      for (const name of ['team.json', 'assignments.jsonl']) {
        try { team.push((await stat(join(dir, name))).mtimeMs); } catch (error) { if (error.code !== 'ENOENT') throw error; team.push(0); }
      }
      if (team.join('|') !== this.teamSignature) {
        this.teamSignature = team.join('|');
        if (!initial) this.emit('tasks', {});
      }
      try {
        const { mtimeMs } = await stat(join(dir, 'daily.jsonl'));
        if (mtimeMs !== this.dailyMtime) {
          this.dailyMtime = mtimeMs;
          if (!initial) this.emit('daily', {});
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (initial || Date.now() - this.lastFeatureCheck >= this.featureIntervalMs) {
      this.lastFeatureCheck = Date.now();
      const features = await featureSummary(this.root);
      const signature = features.map((f) => `${f.id}:${f.updatedAt}`).join('|');
      if (signature !== this.featureSignature) {
        this.featureSignature = signature;
        if (!initial) this.emit('features', { features });
      }
    }
  }
}

export async function featureSummary(root) {
  return (await listFeatures(root)).filter((feature) => !feature.archivedAt)
    .map(({ id, title, phase, updatedAt, projectType, completed }) => {
      const preview = completed.design?.checks?.find(check => check.id === 'design-preview' && check.status === 'pass');
      return { id, title, phase, updatedAt, ...(projectType ? { projectType } : {}), ...(preview ? { designPreview: { file: preview.artifact, url: `/api/features/${id}/artifacts/design-preview` } } : {}) };
    });
}
