import { commandFor } from './commands.mjs';

const OPEN = new Set(['open', 'accepted', 'blocked']);
const BUSY = new Set(['working', 'reviewing']);

export function requestAction(request, requests = []) {
  if (!request) return { title: '아직 실행을 요청하지 않았어요', detail: '아래에 할 일을 적고 시작하기를 누르면 선택한 도구가 기획부터 결과 보고까지 진행합니다.' };
  switch (request.status) {
    case 'workflow': return { title: '프로젝트 워크플로우가 준비됐어요', detail: '아래 작업 순서와 완료 기준을 확인하세요. 수정할 점을 보내거나, 이 워크플로우로 시작을 누르면 실행합니다.', action: 'workflow', label: '이 워크플로우로 시작' };
    case 'queued': {
      const ahead = requests.filter((r) => ['queued', 'running'].includes(r.status) && (r.createdAt < request.createdAt || r.status === 'running') && r.id !== request.id).length;
      return { title: ahead ? `앞선 요청 ${ahead}건을 기다리고 있어요` : 'AI 실행을 준비하고 있어요', detail: '이 프로젝트의 자동 요청은 한 번에 하나씩 실행합니다. 같은 요청을 다시 보낼 필요가 없습니다.' };
    }
    case 'running': return { title: `${request.agent || '담당 AI'}가 작업하고 있어요`, detail: '현재 단계의 결과가 나오면 여기에 보고합니다. 실행 승인 카드가 나타나면 내용을 확인해 응답해 주세요.' };
    case 'question': return { title: '답변을 기다리고 있어요', detail: '아래 질문에 답하고 보내기를 누르면 멈춘 단계부터 계속합니다.', action: 'reply', label: '답변 입력하기' };
    case 'blocked': if (request.newRequest) return { title: '새 요청이 필요해요', detail: '다른 세션이 이 프로젝트의 단계를 바꿔 같은 요청에서는 이어갈 수 없습니다. 상세 기록을 확인한 뒤 새 요청으로 워크플로우를 작성하세요.', action: 'new', label: '새 요청 만들기' };
      if (request.needsFix) return { title: '검증에서 결함을 발견했어요', detail: '수정 후 다시 검증을 누르면 개발 단계로 돌아가 결함을 수정하고 새 실행 근거로 다시 확인합니다.', action: 'resume', label: '수정 후 다시 검증' };
      return { title: '진행이 막힌 이유를 확인해 주세요', detail: '위에 표시된 원인을 해결한 뒤 이어서 진행을 누르세요. 필요한 정보는 아래에 입력해 보낼 수 있습니다.', action: 'resume', label: '이어서 진행' };
    case 'paused': return { title: '저장된 단계에서 멈춰 있어요', detail: '이어서 진행을 누르면 저장된 단계부터 다시 실행합니다.', action: 'resume', label: '이어서 진행' };
    case 'completed': return { title: '요청한 작업을 마쳤어요', detail: '결과와 검증 보고를 확인하세요. 수정할 점을 아래에 보내면 같은 작업을 이어갑니다.' };
    default: return { title: '실행 상태를 확인해 주세요', detail: '상세 기록에서 현재 작업과 마지막 보고를 확인할 수 있습니다.' };
  }
}

export function sessionGuide(agent, { tasks = [], features = [] } = {}) {
  const state = agent.effectiveState ?? agent.state;
  const task = tasks.filter((t) => t.to === agent.author && OPEN.has(t.status))
    .sort((a, b) => Number(b.status === 'accepted') - Number(a.status === 'accepted') || (a.at ?? '').localeCompare(b.at ?? ''))[0];
  const feature = features.find((f) => f.id === (task?.feature || agent.feature));
  const command = (name, args = '') => commandFor(agent.kind, name, args);
  if (state === 'away') return { title: '세션 응답 확인 필요', detail: '마지막 활동이 오래됐습니다. 원래 AI 세션을 열고 다시 참여해 주세요.', command: command('join') };
  if (task?.status === 'blocked') return { title: '배정 업무가 막혀 있어요', detail: task.updates?.at(-1)?.note || 'PM과 막힌 이유를 확인한 뒤 원래 세션에서 다시 실행하세요.', command: command('work', task.id) };
  if (task && task.phase !== 'any' && feature && feature.phase !== task.phase) return { title: '이전 단계 확인 필요', detail: `${task.feature}의 현재 단계는 ${feature.phase}입니다. PM이 단계 순서를 확인하고 배정을 조정해야 합니다.`, command: command('status', task.feature) };
  if (task?.status === 'accepted') return { title: '업무 수락됨 · 마지막 기록', detail: `${task.feature} 업무를 수락했습니다. 결과가 갱신되지 않으면 원래 세션을 확인하세요.`, command: command('work', task.id) };
  if (task) return { title: '배정됨 · 실행 확인 필요', detail: agent.listening ? '알림을 듣고 있습니다. 실행이 시작되지 않으면 원래 세션에서 아래 명령을 실행하세요.' : '원래 AI 세션에서 아래 명령을 실행해야 배정 업무를 시작합니다.', command: command('work', task.id) };
  if (BUSY.has(state)) return { title: '작업 중 · 마지막 기록', detail: agent.note || '원래 세션이 남긴 작업 상태입니다. 실제 진행과 결과는 해당 세션에서 확인하세요.' };
  return { title: '대기 · 배정된 업무 없음', detail: '참여만 한 상태입니다. PM이 업무를 배정하거나 이 세션에서 작업 단계 명령을 실행하세요.', command: feature && feature.phase !== 'done' ? command(feature.phase, feature.id) : null };
}
