import { t } from './messages-catalog.mjs';
import { commandFor } from './commands.mjs';

const OPEN = new Set(['open', 'accepted', 'blocked']);
const BUSY = new Set(['working', 'reviewing']);

export function requestAction(request, requests = []) {
  if (!request) return { title: t('startGuide.noRunRequestedYet'), detail: t('startGuide.writeWhatYouNeed') };
  switch (request.status) {
    case 'workflow': return { title: t('startGuide.theProjectWorkflowIs'), detail: t('startGuide.checkTheTaskOrder'), action: 'workflow', label: t('startGuide.startWithThisWorkflow') };
    case 'queued': {
      const ahead = requests.filter((r) => ['queued', 'running'].includes(r.status) && (r.createdAt < request.createdAt || r.status === 'running') && r.id !== request.id).length;
      return { title: ahead ? t('startGuide.waitingForEarlierRequests', ahead) : t('startGuide.preparingTheAiRun'), detail: t('startGuide.automaticRequestsInThis') };
    }
    case 'running': return { title: `${request.agent || '담당 AI'}가 작업하고 있어요`, detail: t('startGuide.resultsOfTheCurrent') };
    case 'question': return { title: t('startGuide.waitingForYourAnswer'), detail: t('startGuide.answerTheQuestionBelow'), action: 'reply', label: t('startGuide.enterAnswer') };
    case 'blocked': if (request.newRequest) return { title: t('startGuide.aNewRequestIs'), detail: t('startGuide.anotherSessionChangedThis'), action: 'new', label: t('startGuide.newRequest') };
      if (request.needsFix) return { title: t('startGuide.aDefectWasFound'), detail: t('startGuide.pressFixAndRetest'), action: 'resume', label: t('startGuide.fixAndRetest') };
      return { title: t('startGuide.pleaseCheckWhyProgress'), detail: t('startGuide.resolveTheCauseShown'), action: 'resume', label: t('startGuide.continue') };
    case 'paused': return { title: t('startGuide.stoppedAtTheSaved'), detail: t('startGuide.pressContinueToRun'), action: 'resume', label: t('startGuide.continue') };
    case 'completed': return { title: t('startGuide.theRequestedTaskIs'), detail: t('startGuide.checkTheResultsAnd') };
    default: return { title: t('startGuide.pleaseCheckTheRun'), detail: t('startGuide.youCanSeeThe') };
  }
}

export function sessionGuide(agent, { tasks = [], features = [] } = {}) {
  const state = agent.effectiveState ?? agent.state;
  const task = tasks.filter((item) => item.to === agent.author && OPEN.has(item.status))
    .sort((a, b) => Number(b.status === 'accepted') - Number(a.status === 'accepted') || (a.at ?? '').localeCompare(b.at ?? ''))[0];
  const feature = features.find((f) => f.id === (task?.feature || agent.feature));
  const command = (name, args = '') => commandFor(agent.kind, name, args);
  if (state === 'away') return { title: t('startGuide.sessionResponseNeedsChecking'), detail: t('startGuide.theLastActivityWas'), command: command('join') };
  if (task?.status === 'blocked') return { title: t('startGuide.theAssignedTaskIs'), detail: task.updates?.at(-1)?.note || t('startGuide.checkTheReasonIts'), command: command('work', task.id) };
  if (task && task.phase !== 'any' && feature && feature.phase !== task.phase) return { title: t('startGuide.previousStageNeedsChecking'), detail: t('startGuide.theCurrentStageOf', task.feature, feature.phase), command: command('status', task.feature) };
  if (task?.status === 'accepted') return { title: t('startGuide.taskAcceptedLastRecord'), detail: t('startGuide.acceptedTheTaskIf', task.feature), command: command('work', task.id) };
  if (task) return { title: t('startGuide.assignedRunNeedsChecking'), detail: agent.listening ? t('startGuide.listeningForNotificationsIf') : t('startGuide.runTheCommandBelow'), command: command('work', task.id) };
  if (BUSY.has(state)) return { title: t('startGuide.workingLastRecord'), detail: agent.note || t('startGuide.thisIsTheTask') };
  return { title: t('startGuide.waitingNoAssignment'), detail: t('startGuide.joinedOnlyHaveThe'), command: feature && feature.phase !== 'done' ? command(feature.phase, feature.id) : null };
}
