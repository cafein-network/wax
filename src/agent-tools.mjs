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
  if (!tool) throw new WaxError('지원하지 않는 실행 도구입니다.');
  return tool;
}
export async function resolveAgentCommand(id, { env = process.env, platform = process.platform } = {}) {
  const tool = agentTool(id);
  for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const candidates = platform === 'win32' ? [join(dir, `${tool.bin}.exe`), ...(tool.launcher ? [join(dir, 'node_modules', tool.launcher)] : [])] : [join(dir, tool.bin)];
    for (const file of candidates) {
      try {
        await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (id === 'copilot' && file.endsWith('npm-loader.js')) {
          const native = createRequire(file).resolve(`@github/copilot-${platform}-${process.arch}`);
          await access(native); return [native, []];
        }
        return /\.[mc]?js$/.test(file) ? [process.execPath, [file]] : [file, []];
      } catch {   }
    }
  }
  throw new WaxError(`${tool.label} 실행 파일을 찾지 못했습니다. 해당 CLI를 설치하고 로그인 또는 API 설정을 마친 뒤 대시보드를 다시 실행하세요.`);
}
export async function requestTools() {
  return Promise.all(AGENT_TOOLS.map(async ({ id, label }) => ({ id, label,
    installed: await resolveAgentCommand(id).then(() => true, () => false),
    approval: id === 'antigravity' ? 'configured' : 'dashboard',
  })));
}
