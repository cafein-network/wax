import { t } from '../web/messages-catalog.mjs';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { WaxError } from './workflow.mjs';

export const AGENT_TOOLS = [
  { id: 'codex', label: 'Codex', bin: 'codex', launcher: '@openai/codex/bin/codex.js' },
  { id: 'claude', label: 'Claude Code', bin: 'claude', launcher: '@anthropic-ai/claude-code/cli.js' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', launcher: '@google/gemini-cli/dist/index.js' },
  { id: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot', launcher: '@github/copilot/npm-loader.js' },
  { id: 'antigravity', label: 'Antigravity CLI', bin: 'agy' },
];
export function agentTool(id = 'codex') {
  const tool = AGENT_TOOLS.find((item) => item.id === id);
  if (!tool) throw new WaxError(t('errors.agentTools.unsupportedExecutionTool'));
  return tool;
}
export async function resolveAgentCommand(id, { env = process.env, platform = process.platform } = {}) {
  const tool = agentTool(id);
  let hint = null;
  for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const candidates = platform === 'win32' ? [join(dir, `${tool.bin}.exe`), ...(tool.launcher ? [join(dir, 'node_modules', tool.launcher)] : [])] : [join(dir, tool.bin)];
    for (const file of candidates) {
      try {
        await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (id === 'copilot' && file.endsWith('npm-loader.js')) {
          const name = `@github/copilot-${platform}-${process.arch}`;
          try { const native = createRequire(file).resolve(name); await access(native); return [native, []]; }
          catch { hint = `${file}의 런처는 있지만 이 컴퓨터용 실행 파일(${name})이 없습니다. GitHub Copilot CLI를 다시 설치하세요.`; continue; }
        }
        return /\.[mc]?js$/.test(file) ? [process.execPath, [file]] : [file, []];
      } catch {   }
    }
    if (platform === 'win32' && !hint && await access(join(dir, `${tool.bin}.cmd`)).then(() => true, () => false)) {
      hint = `${join(dir, `${tool.bin}.cmd`)}는 있지만 셸 없이 실행할 ${tool.launcher ? `런처(${join(dir, 'node_modules', tool.launcher)})` : '실행 파일(.exe)'}를 찾지 못했습니다.`;
    }
  }
  throw new WaxError(t('errors.agentTools.executableNotFound', tool.label, hint ? `${hint} ` : ''));
}
export async function requestTools() {
  return Promise.all(AGENT_TOOLS.map(async ({ id, label }) => ({ id, label,
    installed: await resolveAgentCommand(id).then(() => true, () => false),
    approval: id === 'antigravity' ? 'configured' : 'dashboard',
  })));
}
