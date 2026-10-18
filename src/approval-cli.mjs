import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { listApprovals } from './approvals.mjs';
import { runCodexSession } from './codex-session.mjs';

export async function approvalCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, prompt: { type: 'string' }, thread: { type: 'string' }, executable: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project || process.cwd());
  if (values.help || !positionals.length) {
    console.log('wax approvals list [--project <경로>]\nwax approvals codex --prompt <요청> [--thread <세션 ID>] [--executable <codex 실행 파일>] [--project <경로>]\n승인은 대시보드·대화창의 요청별 버튼에서만 처리합니다. codex는 로그인된 로컬 App Server로 새 작업을 실행합니다.');
    return;
  }
  if (positionals.length !== 1) throw new Error('approvals list 또는 approvals codex를 사용하세요.');
  if (positionals[0] === 'list') { console.log(JSON.stringify(await listApprovals(root), null, 2)); return; }
  if (positionals[0] !== 'codex') throw new Error('승인 변경은 GUI에서 처리하세요. 지원 명령: approvals list, approvals codex');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runCodexSession(root, { prompt: values.prompt, thread: values.thread, executable: values.executable, signal: controller.signal });
    process.stdout.write(`\n완료: ${result.threadId}\n`);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
