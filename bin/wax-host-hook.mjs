#!/usr/bin/env node
import { appendFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { recordHostEvent } from '../src/chat/host-state.mjs';

const env = process.env;

async function waxProject(cwd) {
  if (env.WAX_PROJECT) return resolve(env.WAX_PROJECT);
  let dir = await realpath(cwd);
  for (;;) {
    try { if ((await lstat(join(dir, '.wax'))).isDirectory()) return dir; } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

try {
  if (env.WAX_WORKER !== '1' && env.WAX_HOST_STATE !== 'off') {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 1_000_000) throw new Error('hook input too large'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const session = input?.session_id, event = input?.hook_event_name;
    const root = typeof input?.cwd === 'string' && typeof session === 'string' ? await waxProject(input.cwd) : null;
    if (root) {
      await recordHostEvent(root, { session, event, notificationType: input.notification_type, toolName: input.tool_name }, { env });
      if (event === 'SessionStart' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) {
        if (env.CLAUDE_ENV_FILE) await appendFile(env.CLAUDE_ENV_FILE, `export WAX_HOST_SESSION=${session}\n`);
        else process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `wax host session: ${session} (pass --host-session ${session} to wax chat join)` } })}\n`);
      }
    }
  }
} catch {
}
