import { t } from '../web/messages-catalog.mjs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { listApprovals } from './approvals.mjs';
import { runCodexSession } from './codex-session.mjs';
import { cliText } from './cli-locale.mjs';

export async function approvalCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, prompt: { type: 'string' }, thread: { type: 'string' }, executable: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project || process.cwd());
  const { say } = cliText();
  if (values.help || !positionals.length) {
    console.log(say('cli.approvals.help'));
    return;
  }
  if (positionals.length !== 1) throw new Error(t('errors.approvalCli.useApprovalsListOr'));
  if (positionals[0] === 'list') { console.log(JSON.stringify(await listApprovals(root), null, 2)); return; }
  if (positionals[0] !== 'codex') throw new Error(t('errors.approvalCli.changeApprovalsInThe'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runCodexSession(root, { prompt: values.prompt, thread: values.thread, executable: values.executable, signal: controller.signal });
    process.stdout.write(`\n${say('cli.approvals.done', result.threadId)}\n`);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
