import { t } from './messages-catalog.mjs';
import { api, el, clear, timeLabel, commandLine, tr } from './dom.mjs';
import { commandFor } from './commands.mjs';
import { openEvents } from './events.mjs';
import { requestAction, sessionGuide } from './start-guide.mjs';
import { PHASE_ROOMS, PROJECT_TYPES, projectType, qualityRequirements } from './project-types.mjs';

const $ = (id) => document.getElementById(id);
const PHASES = ['plan', 'design', 'implement', 'review', 'report'];
const PHASE_LABELS = { plan: t('home.workflow'), design: t('home.design'), implement: t('home.implement'), review: t('home.review'), report: t('home.report') };
const SM_LABELS = { plan: t('home.intakeAnalysis'), design: t('home.impactCheck'), implement: t('home.fix'), review: t('home.regressionCheck'), report: t('home.resolutionReport') };
const labelsFor = (mode) => mode === 'project' ? PHASE_LABELS : SM_LABELS;
const modeLabel = (mode) => mode === 'project' ? t('home.project') : t('home.smMaintenance');
const STATUS = { queued: t('home.queued'), running: t('home.inProgress'), workflow: t('home.reviewWorkflow'), question: t('home.answerNeeded'), blocked: t('home.needsAttention'), paused: t('home.paused'), completed: t('home.done') };
let config, requests = [], currentId = new URLSearchParams(location.search).get('request'), sending = false, online = false, loading, again = false;
let createId, submittedBody, submittedType, replyId, repliedBody, replyTarget, messageSignature = '', listSignature = '';
let preferredType = 'auto';
const drafts = new Map();
let tools = [], preferred = 'codex', submittedTool;
const requestedMode = new URLSearchParams(location.search).get('mode');
let preferredMode = ['project', 'sm'].includes(requestedMode) ? requestedMode : 'project', modeLoaded = false, submittedMode, startingWorkflow = false;
let team, teamSignature = '', checkingTools = false, teamGuideInitialized = false;
try { preferred = localStorage.getItem('wax-request-tool') || preferred; } catch {   }
const selectedTool = () => current()?.tool || preferred;
const toolLabel = () => tools.find((tool) => tool.id === selectedTool())?.label || selectedTool();
const active = (r) => ['queued', 'running'].includes(r.status);
const current = () => requests.find((r) => r.id === currentId);
const selectedMode = () => current() ? current().mode || 'sm' : preferredMode;
const showError = (error) => { $('error').hidden = !error; $('error').textContent = error?.message ?? ''; };
function select(id) {
  if (id !== currentId) {
    drafts.set(currentId, $('request-body').value);
    $('request-body').value = drafts.get(id) ?? '';
    clear($('conversation'));
  }
  currentId = id; messageSignature = '';
  history.replaceState(null, '', id ? `${location.pathname}?request=${encodeURIComponent(id)}` : location.pathname);
  render();
}
function render() {
  const mode = selectedMode(), labels = labelsFor(mode);
  $('connection').dataset.online = String(online);
  $('connection').textContent = online ? t('home.connected') : t('home.checkingConnection');
  $('send').disabled = sending || !online || current()?.newRequest || (!current() && !tools.some((tool) => tool.id === preferred && tool.installed));
  $('request-body').disabled = Boolean(current()?.newRequest);
  $('request-tool').disabled = Boolean(current()) || sending;
  $('request-tool').value = selectedTool();
  $('request-mode').disabled = Boolean(current()) || sending;
  $('project-type').disabled = Boolean(current()) || sending;
  $('project-type').value = current()?.projectType || preferredType;
  const type = projectType(current()?.projectType || preferredType, $('request-body').value, config?.repoType);
  $('project-type-note').textContent = `${preferredType === 'auto' && !current() ? '요청 기준: ' : ''}${PROJECT_TYPES[type].label} · ${PROJECT_TYPES[type].brief}`;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
  $('guide-request-detail').textContent = mode === 'project' ? t('home.enterAProjectGoal') : t('home.describeTheBugOr');
  $('guide-flow-detail').textContent = mode === 'project' ? t('home.checkTheScopeTask') : t('home.intakeAnalysisImpactCheck');
  const installed = tools.find((tool) => tool.id === selectedTool())?.installed;
  $('tool-note').textContent = !tools.length ? t('home.checkingExecutionTools') : !installed ? t('home.installThisCliAnd') : selectedTool() === 'antigravity' ? t('home.usageCountsAgainstYour') : t('home.installationFoundFinishSigning', toolLabel());
  $('guide-tool').dataset.ready = String(Boolean(installed));
  $('guide-tool-detail').textContent = !tools.length ? t('home.checkingTheAiTools') : installed ? t('home.installationFoundYouCan', toolLabel()) : t('home.couldntFindTheSelected');
  $('check-tools').disabled = checkingTools || !online;
  renderTeamGuide();
  const r = current();
  $('welcome').hidden = Boolean(r); $('progress').hidden = !r;
  $('send').firstChild.textContent = sending ? '보내는 중 ' : r?.status === 'workflow' ? '워크플로우 수정 ' : r ? '보내기 ' : mode === 'project' ? '워크플로우 만들기 ' : '시작하기 ';
  $('request-body').placeholder = r?.newRequest ? t('home.thisRequestCantBe') : r?.status === 'workflow' ? t('home.enterWhatToChange') : r ? t('home.enterAnAdditionalRequest') : mode === 'project' ? t('home.eGIWant') : t('home.eGFindAnd');
  $('composer-hint').textContent = r && active(r) ? t('home.additionalRequestsApplyOnce') : t('home.worksOnThisProject', toolLabel());
  $('request-count').textContent = requests.length || '';
  const nextList = JSON.stringify([currentId, requests.map((item) => [item.id, item.title, item.status, item.phase, item.mode])]);
  if (listSignature !== nextList) {
    listSignature = nextList;
    clear($('requests')).append(...requests.map((item) => el('li', {}, el('button', { type: 'button', 'aria-current': String(item.id === currentId), onclick: () => select(item.id) },
      el('span', { class: 'request-name', translate: 'no', text: item.title }), el('span', { class: 'request-meta', text: `${modeLabel(item.mode)} · ${STATUS[item.status] ?? item.status} · ${labelsFor(item.mode)[item.phase] ?? '완료'}` })))));
  }
  if (r) {
    const next = requestAction(r, requests);
    $('request-next-title').textContent = next.title;
    $('request-next-detail').textContent = next.detail;
    $('request-next-action').hidden = !next.action;
    $('request-next-action').textContent = next.label ?? '';
    $('request-next-action').dataset.action = next.action ?? '';
    $('request-next-action').disabled = !online || startingWorkflow;
    $('progress').dataset.state = r.status;
    $('request-title').textContent = r.title;
    $('request-mode-label').textContent = modeLabel(mode);
    $('request-status').textContent = STATUS[r.status] ?? r.status;
    $('progress-detail').textContent = r.detail;
    $('stop').hidden = !active(r); $('resume').hidden = !['paused', 'blocked'].includes(r.status) || r.newRequest;
    $('stop').disabled = !online; $('resume').disabled = !online;
    $('resume').textContent = r.needsFix ? t('home.fixAndRetest') : t('home.continue');
    const room = PHASE_ROOMS[r.phase] || PHASE_ROOMS.plan;
    $('mission-room').textContent = room.label;
    $('mission-type').textContent = PROJECT_TYPES[r.projectType]?.label || t('home.generalProject');
    $('mission-office').href = `/office?room=${room.id}&board=${encodeURIComponent(r.id)}`;
    const requirements = qualityRequirements(r.projectType, r.phase, r.mode);
    const previous = r.quality;
    const visible = requirements.length ? requirements : r.status === 'completed' ? previous?.checks || [] : [];
    $('mission-goal').textContent = r.needsFix ? t('home.fixTheDefectFound') : r.status === 'completed' ? t('home.checkTheVerificationEvidence') : r.phase === 'plan' ? t('home.firstDecideTheRuntime') : r.phase === 'design' ? t('home.createTheMockupsAnd') : r.phase === 'implement' ? t('home.connectOneSmallFlow') : r.phase === 'review' ? t('home.verifyTheUserFlow') : t('home.reportTheActualChanges');
    clear($('mission-checks')).append(...visible.map(rule => {
      const saved = previous?.phase === r.phase || r.status === 'completed' ? previous?.checks?.find(check => check.id === rule.id) : null;
      return el('li', { text: `${saved?.status === 'pass' ? '확인됨' : saved?.status === 'fail' ? '수정 필요' : '검증 필요'} · ${rule.label}` });
    }));
    $('detail-link').href = `/manage?feature=${encodeURIComponent(r.id)}`;
    const index = r.phase === 'done' ? 5 : PHASES.indexOf(r.phase);
    clear($('steps')).append(...PHASES.map((phase, i) => el('li', { class: i < index ? 'done' : i === index ? 'current' : '', 'aria-current': i === index ? 'step' : undefined, text: mode === 'project' && phase === 'plan' ? t('home.workflow') : labels[phase] })));
  }
  $('workflow-preview').hidden = !r?.workflow;
  $('workflow-document').textContent = r?.workflow?.document ?? '';
  $('workflow-note').textContent = r?.workflow?.started ? t('home.thisIsTheConfirmed') : t('home.beforeProceedingCheckThe');
  const messages = r?.messages ?? [];
  const signature = JSON.stringify([currentId, messages]);
  if (signature !== messageSignature) {
    const previousIds = new Set([...$('conversation').children].map((node) => node.dataset.message));
    if (messageSignature && !messages.some((m) => previousIds.has(m.id))) clear($('conversation'));
    if (!r) clear($('conversation'));
    for (const m of messages) {
      if (previousIds.has(m.id)) continue;
      $('conversation').append(el('article', { class: m.role === 'user' ? 'user-message' : 'assistant-message', dataset: { message: m.id } },
        el('header', {}, el('strong', { text: m.role === 'user' ? t('home.me') : toolLabel() }), el('span', { text: `${m.phase ? labels[m.phase] + ' · ' : ''}${timeLabel(m.at)}` })),
        el('div', { class: 'message-body', translate: 'no', text: m.text })));
    }
    messageSignature = signature;
  }
}
function renderTeamGuide() {
  if (!team) return;
  const signature = JSON.stringify([team, preferred, online, requests.map((r) => r.agent)]);
  if (signature === teamSignature) return;
  teamSignature = signature;
  const managed = new Set(requests.map((r) => r.agent).filter(Boolean));
  const agents = team.agents.filter((a) => !['human', 'other'].includes(a.kind) && !managed.has(a.author));
  if (!teamGuideInitialized) {
    teamGuideInitialized = true;
    $('terminal-guide').open = location.hash === '#terminal-guide' || (agents.length > 0 && requests.length === 0);
  }
  const waiting = agents.filter((a) => ['idle', 'away'].includes(a.effectiveState ?? a.state)).length;
  $('team-status').textContent = t('home.sessionsJoinedWaitingOr', agents.length, waiting);
  $('command-syntax').textContent = t('home.enterCommandsInEach');
  clear($('join-command')).append(commandLine(t('home.inANewAi'), commandFor(preferred, 'join'), t('home.enterThisCommandIn')));
  const pm = team.pm;
  $('pm-guide').textContent = !pm ? t('home.theresNoPmSo') : pm.kind === 'human' ? t('home.isThePmIn', pm.author) : t('home.thePmIsGive', pm.author);
  clear($('pm-command'));
  const pmText = commandFor(pm?.kind || preferred, 'pm', tr(t('home.goalToPursue')));
  if (pmText) $('pm-command').append(commandLine(pm ? t('home.inTheSession', pm.author) : t('home.inTheSessionTo'), pmText, t('home.replaceGoalToPursue')));
  clear($('session-guide')).append(...(agents.length ? agents.map((agent) => {
    const guide = sessionGuide(agent, team);
    return el('li', {}, el('strong', { text: `${agent.author} · ${guide.title}` }), el('p', { text: guide.detail }),
      guide.command ? commandLine(t('home.inTheSession', agent.author), guide.command) : null);
  }) : [el('li', { text: t('home.noTerminalAiSessions') })]));
}
async function loadTools() {
  const data = await api('/api/request-tools');
  tools = data.tools;
  if (!tools.some((tool) => tool.id === preferred && tool.installed)) preferred = tools.find((tool) => tool.installed)?.id || tools[0]?.id || 'codex';
  clear($('request-tool')).append(...tools.map((tool) => el('option', { value: tool.id, text: tool.label + (tool.installed ? '' : ' · 설치 필요') })));
}
async function refresh() {
  if (loading) { again = true; return loading; }
  loading = (async () => {
    try {
      config = await api('/api/config');
      if (!modeLoaded) {
        modeLoaded = true;
        try {
          const saved = localStorage.getItem(`wax-request-mode:${config.root}`);
          if (['project', 'sm'].includes(requestedMode)) localStorage.setItem(`wax-request-mode:${config.root}`, preferredMode);
          else if (['project', 'sm'].includes(saved)) preferredMode = saved;
        } catch {   }
      }
      if (!tools.length) await loadTools();
      const data = await api('/api/requests');
      requests = data.requests; online = true;
      $('project').textContent = config.project;
      $('project').title = config.root;
      render();
      const snapshot = await Promise.allSettled([api('/api/presence'), api('/api/team'), api('/api/features')]);
      if (snapshot.every((r) => r.status === 'fulfilled')) {
        team = { agents: snapshot[0].value, ...snapshot[1].value, features: snapshot[2].value };
        $('team-error').hidden = true;
        renderTeamGuide();
      } else {
        team = null; teamSignature = '';
        $('team-status').textContent = t('home.teamRecordsNeedChecking');
        clear($('session-guide')); clear($('pm-command')); clear($('join-command'));
        $('pm-guide').textContent = '';
        $('team-error').hidden = false;
        $('team-error').textContent = t('home.couldntReadTheTeam', snapshot.find((r) => r.status === 'rejected').reason.message);
      }
    } catch (error) { online = false; render(); showError(error); }
    finally { loading = null; if (again) { again = false; void refresh(); } }
  })();
  return loading;
}
$('guide-start').addEventListener('click', () => { $('request-body').focus(); $('request-form').scrollIntoView({ block: 'center', behavior: 'auto' }); });
$('check-tools').addEventListener('click', async () => {
  if (checkingTools) return;
  checkingTools = true; render();
  $('tool-check-status').textContent = t('home.checkingInstallation');
  try { await loadTools(); $('tool-check-status').textContent = tools.some((tool) => tool.installed) ? t('home.checkedTheInstalledTools') : t('home.ifTheCliDoesnt'); }
  catch (error) { $('tool-check-status').textContent = error.message; }
  finally { checkingTools = false; render(); }
});
$('request-next-action').addEventListener('click', async () => {
  if ($('request-next-action').dataset.action === 'workflow') {
    const r = current();
    if (!r?.workflow || startingWorkflow || !online) return;
    if ($('request-body').value.trim()) { showError(new Error(t('home.sendOrClearThe'))); return; }
    startingWorkflow = true; showError(null); render();
    try {
      await api(`/api/requests/${r.id}/reply`, { method: 'POST', token: config.token, body: { approveWorkflow: true, workflowRevision: r.workflow.revision } });
      await refresh();
    } catch (error) { showError(error); }
    finally { startingWorkflow = false; render(); }
  } else if ($('request-next-action').dataset.action === 'resume') $('resume').click();
  else if ($('request-next-action').dataset.action === 'new') $('new-request').click();
  else $('request-body').focus();
});
$('request-mode').addEventListener('change', (event) => {
  if (current() || !['project', 'sm'].includes(event.target.value)) return;
  preferredMode = event.target.value;
  try { localStorage.setItem(`wax-request-mode:${config.root}`, preferredMode); } catch {   }
  render();
});
$('request-tool').addEventListener('change', () => {
  preferred = $('request-tool').value;
  try { localStorage.setItem('wax-request-tool', preferred); } catch {   }
  render();
});
$('project-type').addEventListener('change', () => { preferredType = $('project-type').value; render(); });
$('request-body').addEventListener('input', () => { if (!current()) render(); });
$('new-request').addEventListener('click', () => { select(null); $('request-body').focus(); });
for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => { $('request-body').value = button.dataset.example; preferredType = button.dataset.projectType || 'auto'; render(); $('request-body').focus(); });
$('request-body').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('request-form').requestSubmit(); } });
$('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !online || current()?.newRequest || (!current() && !tools.some((tool) => tool.id === preferred && tool.installed))) return;
  const body = $('request-body').value.trim();
  if (!body) return;
  const target = current()?.id ?? null, tool = selectedTool(), mode = selectedMode(), type = preferredType;
  sending = true; showError(null); render();
  try {
    if (!target && (!createId || submittedBody !== body || submittedTool !== tool || submittedMode !== mode || submittedType !== type)) { createId = `request-${crypto.randomUUID()}`; submittedBody = body; submittedTool = tool; submittedMode = mode; submittedType = type; }
    if (target && (!replyId || repliedBody !== body || replyTarget !== target)) { replyId = crypto.randomUUID(); repliedBody = body; replyTarget = target; }
    const result = await api(target ? `/api/requests/${target}/reply` : '/api/requests', { method: 'POST', token: config.token, body: target ? { body, messageId: replyId } : { id: createId, body, tool, mode, projectType: type } });
    if (currentId === target && $('request-body').value.trim() === body) $('request-body').value = '';
    if (drafts.get(target)?.trim() === body) drafts.delete(target);
    createId = null; submittedBody = null;
    replyId = null; repliedBody = null; replyTarget = null;
    await refresh();
    if (currentId === target) { select(result.id); $('request-body').focus(); }
  } catch (error) { showError(error); }
  finally { sending = false; render(); }
});
for (const [button, action, body] of [['stop', 'stop', {}], ['resume', 'reply', { resume: true }]]) {
  $(button).addEventListener('click', async () => {
    if (!currentId || !online) return;
    $(button).disabled = true; showError(null);
    try { await api(`/api/requests/${currentId}/${action}`, { method: 'POST', token: config.token, body }); await refresh(); }
    catch (error) { showError(error); }
    finally { $(button).disabled = !online; }
  });
}
const approvals = $('approvals');
new MutationObserver(() => { approvals.hidden = !approvals.querySelector('.approval-card') || approvals.querySelectorAll('.approval-card button').length === 0; }).observe(approvals, { childList: true, subtree: true });
await refresh();
const events = openEvents();
for (const type of ['requests', 'resync']) events.addEventListener(type, () => { void refresh(); });
for (const type of ['presence', 'tasks', 'features']) events.addEventListener(type, () => { void refresh(); });
events.onopen = () => { void refresh(); };
events.onerror = () => { online = false; render(); };
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
window.addEventListener('pagehide', () => { clearInterval(poll); events.close(); });
