import { t } from './messages-catalog.mjs';

export const TOOLS = [
  { kind: 'claude', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'copilot', label: 'GitHub Copilot CLI' },
  { kind: 'gemini', label: 'Gemini CLI' },
  { kind: 'antigravity', label: 'Antigravity CLI' },
  { kind: 'grok', label: 'Grok Build' },
];

export const COMMANDS = [
  { name: 'init', args: '', label: t('commands.openStartupGuideAnd') },
  { name: 'join', args: '', label: t('commands.joinTheTeamChannel') },
  { name: 'plan', args: t('commands.taskidRequest'), label: t('commands.plan') },
  { name: 'design', args: t('commands.taskId'), label: t('commands.design') },
  { name: 'implement', args: t('commands.taskId'), label: t('commands.implement') },
  { name: 'review', args: t('commands.taskId'), label: t('commands.review') },
  { name: 'report', args: t('commands.taskId'), label: t('commands.report') },
  { name: 'status', args: t('commands.taskId2'), label: t('commands.checkStatus') },
  { name: 'iterate', args: t('commands.taskidReason'), label: t('commands.iterate') },
  { name: 'work', args: t('commands.assignmentId'), label: t('commands.workOnAnAssignment') },
  { name: 'pm', args: t('commands.goal'), label: t('commands.adviseAssignAndReport') },
  { name: 'chat', args: t('commands.channelMessage'), label: t('commands.channelChat') },
  { name: 'daily', args: t('commands.date'), label: t('commands.dailyReport') },
];

export function commandFor(kind, command, args = '') {
  const tail = args ? ` ${args}` : '';
  switch (kind) {
    case 'claude':
    case 'gemini': return `/wax:${command}${tail}`;
    case 'codex': return `$wax:${command}${tail}`;
    case 'antigravity': return `/${command}${tail}`;
    case 'copilot':
    case 'grok': { const text = `wax ${command} 스킬로${tail} 진행해줘`; return globalThis.waxLocale?.translate(text) ?? text; }
    default: return null;
  }
}

const OPEN_TASK = new Set(['open', 'accepted', 'blocked']);

export function nextCommand({ agent, features = [], tasks = [] }) {
  const pick = (command, args, reason) => {
    const text = commandFor(agent.kind, command, args);
    return text ? { command, args, text, reason } : null;
  };
  const task = tasks.find((item) => item.to === agent.author && OPEN_TASK.has(item.status ?? 'open'));
  if (task) return pick('work', task.id, task.phase === 'any' ? `PM이 배정한 ${task.feature} 업무` : t('commands.taskAssignedByThe', task.feature, task.phase));
  const feature = agent.feature && features.find((f) => f.id === agent.feature);
  if (feature && feature.phase !== 'done') return pick(feature.phase, feature.id, `${feature.id}의 현재 단계`);
  return pick('status', feature ? feature.id : '', feature ? t('commands.isComplete', feature.id) : t('commands.noAssignedTask'));
}

export function assignmentCommand(kind) {
  return commandFor(kind, 'work');
}
