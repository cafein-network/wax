#!/usr/bin/env node
import { handleClaudeApproval } from '../src/approval-hosts.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('승인 요청 크기 제한 초과');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  await handleClaudeApproval(input, { signal: controller.signal,
    emit: (value) => new Promise((done, fail) => process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? fail(error) : done())) });
} catch (error) {
  process.stderr.write(`wax 승인 연결: ${error.message}\n`);
} finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
