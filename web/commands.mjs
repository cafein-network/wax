
export const TOOLS = [
  { kind: 'claude', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'copilot', label: 'GitHub Copilot CLI' },
  { kind: 'gemini', label: 'Gemini CLI' },
  { kind: 'antigravity', label: 'Antigravity CLI' },
];

export const COMMANDS = [
  { name: 'init', args: '', label: '시작하기(참여·작업·대시보드·PM)' },
  { name: 'join', args: '', label: '팀 채널에 참여' },
  { name: 'plan', args: '<작업ID> [요청]', label: '기획' },
  { name: 'design', args: '<작업ID>', label: '설계' },
  { name: 'implement', args: '<작업ID>', label: '구현' },
  { name: 'review', args: '<작업ID>', label: '검토' },
  { name: 'report', args: '<작업ID>', label: '보고' },
  { name: 'status', args: '[작업ID]', label: '상태 확인' },
  { name: 'iterate', args: '<작업ID> <개선 사유>', label: '개선 주기' },
  { name: 'work', args: '[업무ID]', label: '배정 업무 수행' },
  { name: 'pm', args: '[목표]', label: 'PM으로 조언·배정·보고' },
  { name: 'chat', args: '[채널] [메시지]', label: '채널 대화' },
  { name: 'daily', args: '[날짜]', label: '일일 보고' },
];

export function commandFor(kind, command, args = '') {
  const tail = args ? ` ${args}` : '';
  switch (kind) {
    case 'claude':
    case 'gemini': return `/wax:${command}${tail}`;
    case 'codex': return `$wax:${command}${tail}`;
    case 'antigravity': return `/${command}${tail}`;
    case 'copilot': return `wax ${command} 스킬로${tail} 진행해줘`;
    default: return null;
  }
}

const OPEN_TASK = new Set(['open', 'accepted', 'blocked']);

export function nextCommand({ agent, features = [], tasks = [] }) {
  const pick = (command, args, reason) => {
    const text = commandFor(agent.kind, command, args);
    return text ? { command, args, text, reason } : null;
  };
  const task = tasks.find((t) => t.to === agent.author && OPEN_TASK.has(t.status ?? 'open'));
  if (task) return pick('work', task.id, task.phase === 'any' ? `PM이 배정한 ${task.feature} 업무` : `PM이 배정한 ${task.feature} ${task.phase} 업무`);
  const feature = agent.feature && features.find((f) => f.id === agent.feature);
  if (feature && feature.phase !== 'done') return pick(feature.phase, feature.id, `${feature.id}의 현재 단계`);
  return pick('status', feature ? feature.id : '', feature ? `${feature.id}은(는) 완료됨` : '맡은 작업 없음');
}

export function assignmentCommand(kind) {
  return commandFor(kind, 'work');
}
