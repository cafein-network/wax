import { api, el, clear, timeLabel, commandLine } from './dom.mjs';
import { commandFor } from './commands.mjs';
import { requestAction, sessionGuide } from './start-guide.mjs';
import { PHASE_ROOMS, PROJECT_TYPES, projectType, qualityRequirements } from './project-types.mjs';

const $ = (id) => document.getElementById(id);
const PHASES = ['plan', 'design', 'implement', 'review', 'report'];
const PHASE_LABELS = { plan: '워크플로우', design: '설계', implement: '구현', review: '검토', report: '결과 보고' };
const SM_LABELS = { plan: '접수·분석', design: '영향 확인', implement: '수정', review: '회귀 검증', report: '처리 보고' };
const labelsFor = (mode) => mode === 'project' ? PHASE_LABELS : SM_LABELS;
const modeLabel = (mode) => mode === 'project' ? '프로젝트' : 'SM · 유지보수';
const STATUS = { queued: '준비 중', running: '진행 중', workflow: '워크플로우 확인', question: '답변 필요', blocked: '확인 필요', paused: '일시 중지', completed: '완료' };
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
const toolLabel = () => tools.find((t) => t.id === selectedTool())?.label || selectedTool();
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
  history.replaceState(null, '', id ? `/?request=${encodeURIComponent(id)}` : '/');
  render();
}
function render() {
  const mode = selectedMode(), labels = labelsFor(mode);
  $('connection').dataset.online = String(online);
  $('connection').textContent = online ? '연결됨' : '연결 확인 중';
  $('send').disabled = sending || !online || current()?.newRequest || (!current() && !tools.some((t) => t.id === preferred && t.installed));
  $('request-body').disabled = Boolean(current()?.newRequest);
  $('request-tool').disabled = Boolean(current()) || sending;
  $('request-tool').value = selectedTool();
  $('request-mode').disabled = Boolean(current()) || sending;
  $('project-type').disabled = Boolean(current()) || sending;
  $('project-type').value = current()?.projectType || preferredType;
  const type = projectType(current()?.projectType || preferredType, $('request-body').value);
  $('project-type-note').textContent = `${preferredType === 'auto' && !current() ? '요청 기준: ' : ''}${PROJECT_TYPES[type].label} · ${PROJECT_TYPES[type].brief}`;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
  $('guide-request-detail').textContent = mode === 'project' ? '프로젝트 목표를 입력하면 워크플로우를 먼저 만들어요. PM 지정과 수동 배정은 필요 없어요.' : '오류·개선 요청과 재현 방법을 적고 시작하기를 누르세요. 요청 범위에서 바로 진행합니다.';
  $('guide-flow-detail').textContent = mode === 'project' ? '범위·작업 순서·산출물·완료 기준을 확인한 뒤 이 워크플로우로 시작을 누르세요.' : '접수·분석 → 영향 확인 → 수정 → 회귀 검증 → 처리 보고. 질문과 실행 승인에는 이 화면에서 답하세요.';
  const installed = tools.find((t) => t.id === selectedTool())?.installed;
  $('tool-note').textContent = !tools.length ? '실행 도구 확인 중…' : !installed ? '이 CLI를 설치하고 로그인 또는 API 설정을 마친 뒤 도구 다시 확인을 누르세요. 설치 후에도 보이지 않으면 init으로 대시보드를 다시 실행하세요.' : selectedTool() === 'antigravity' ? 'Antigravity 계정의 사용량이 적용됩니다. 새 권한 요청은 웹에서 승인할 수 없어 터미널 설정 확인이 필요합니다.' : `${toolLabel()} 설치 확인됨 · 로그인 또는 API 설정은 해당 CLI에서 마쳐 주세요. 해당 계정의 한도·비용이 적용됩니다.`;
  $('guide-tool').dataset.ready = String(Boolean(installed));
  $('guide-tool-detail').textContent = !tools.length ? '설치한 AI 도구를 확인하고 있어요.' : installed ? `${toolLabel()} 설치 확인됨. 아래 실행 도구에서 바꿀 수 있어요. 로그인 여부는 실행할 때 확인합니다.` : '선택한 도구를 찾지 못했어요. 아래에서 설치된 도구를 고르거나 CLI 설치 후 도구 다시 확인을 누르세요.';
  $('check-tools').disabled = checkingTools || !online;
  renderTeamGuide();
  const r = current();
  $('welcome').hidden = Boolean(r); $('progress').hidden = !r;
  $('send').firstChild.textContent = sending ? '보내는 중 ' : r?.status === 'workflow' ? '워크플로우 수정 ' : r ? '보내기 ' : mode === 'project' ? '워크플로우 만들기 ' : '시작하기 ';
  $('request-body').placeholder = r?.newRequest ? '이 요청은 이어갈 수 없어요. 새 요청 만들기를 눌러 주세요' : r?.status === 'workflow' ? '워크플로우에서 바꿀 점을 입력하세요' : r ? '추가 요청이나 질문에 대한 답변을 입력하세요' : mode === 'project' ? '예: 예약 서비스를 만들고 싶어. 필요한 기능과 작업 흐름부터 정리해줘' : '예: 회원가입이 안 되는 문제를 찾아서 고쳐줘';
  $('composer-hint').textContent = r && active(r) ? '추가 요청은 현재 단계가 끝나면 반영해요' : `${toolLabel()}가 이 프로젝트에서 작업합니다`;
  $('request-count').textContent = requests.length || '';
  const nextList = JSON.stringify([currentId, requests.map((item) => [item.id, item.title, item.status, item.phase, item.mode])]);
  if (listSignature !== nextList) {
    listSignature = nextList;
    clear($('requests')).append(...requests.map((item) => el('li', {}, el('button', { type: 'button', 'aria-current': String(item.id === currentId), onclick: () => select(item.id) },
      el('span', { class: 'request-name', text: item.title }), el('span', { class: 'request-meta', text: `${modeLabel(item.mode)} · ${STATUS[item.status] ?? item.status} · ${labelsFor(item.mode)[item.phase] ?? '완료'}` })))));
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
    $('resume').textContent = r.needsFix ? '수정 후 다시 검증' : '이어서 진행';
    const room = PHASE_ROOMS[r.phase] || PHASE_ROOMS.plan;
    $('mission-room').textContent = room.label;
    $('mission-type').textContent = PROJECT_TYPES[r.projectType]?.label || '일반 프로젝트';
    $('mission-office').href = `/office?room=${room.id}&board=${encodeURIComponent(r.id)}`;
    const requirements = qualityRequirements(r.projectType, r.phase, r.mode);
    const previous = r.quality;
    const visible = requirements.length ? requirements : r.status === 'completed' ? previous?.checks || [] : [];
    $('mission-goal').textContent = r.needsFix ? '발견한 결함을 수정하고 해당 흐름을 다시 검증하세요.' : r.status === 'completed' ? '결과와 연결된 검증 근거를 확인하세요.' : r.phase === 'plan' ? '실행 환경·작은 목표·작업 순서와 완료 기준을 먼저 정해요.' : r.phase === 'design' ? '개발에 전달할 시안과 실제 산출물을 만들어요.' : r.phase === 'implement' ? '작은 흐름 하나를 실제 실행 환경에서 연결해요.' : r.phase === 'review' ? '사용자 흐름과 화면을 직접 검증해요.' : '실제 변경·검증·남은 일을 보고해요.';
    clear($('mission-checks')).append(...visible.map(rule => {
      const saved = previous?.phase === r.phase || r.status === 'completed' ? previous?.checks?.find(check => check.id === rule.id) : null;
      return el('li', { text: `${saved?.status === 'pass' ? '확인됨' : saved?.status === 'fail' ? '수정 필요' : '검증 필요'} · ${rule.label}` });
    }));
    $('detail-link').href = `/manage?feature=${encodeURIComponent(r.id)}`;
    const index = r.phase === 'done' ? 5 : PHASES.indexOf(r.phase);
    clear($('steps')).append(...PHASES.map((phase, i) => el('li', { class: i < index ? 'done' : i === index ? 'current' : '', 'aria-current': i === index ? 'step' : undefined, text: mode === 'project' && phase === 'plan' ? '워크플로우' : labels[phase] })));
  }
  $('workflow-preview').hidden = !r?.workflow;
  $('workflow-document').textContent = r?.workflow?.document ?? '';
  $('workflow-note').textContent = r?.workflow?.started ? '확인한 프로젝트 워크플로우입니다. 추가 변경은 같은 요청에서 전달하세요.' : '진행 전에 범위·작업 순서·완료 기준을 확인하세요. 수정할 점은 아래 입력창에 보내세요.';
  const messages = r?.messages ?? [];
  const signature = JSON.stringify([currentId, messages]);
  if (signature !== messageSignature) {
    const previousIds = new Set([...$('conversation').children].map((node) => node.dataset.message));
    if (messageSignature && !messages.some((m) => previousIds.has(m.id))) clear($('conversation'));
    if (!r) clear($('conversation'));
    for (const m of messages) {
      if (previousIds.has(m.id)) continue;
      $('conversation').append(el('article', { class: m.role === 'user' ? 'user-message' : 'assistant-message', dataset: { message: m.id } },
        el('header', {}, el('strong', { text: m.role === 'user' ? '나' : toolLabel() }), el('span', { text: `${m.phase ? labels[m.phase] + ' · ' : ''}${timeLabel(m.at)}` })),
        el('div', { class: 'message-body', text: m.text })));
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
    $('terminal-guide').open = agents.length > 0 && requests.length === 0;
  }
  const waiting = agents.filter((a) => ['idle', 'away'].includes(a.effectiveState ?? a.state)).length;
  $('team-status').textContent = `${agents.length}개 세션 참여 · ${waiting}개 대기·자리 비움`;
  $('command-syntax').textContent = '명령은 셸 터미널이 아닌 각 도구의 AI 대화창에 입력하세요. Codex CLI는 $wax:work처럼 $로 스킬을 호출합니다. Codex 입력창의 @는 파일 첨부이며 wax 채널의 @이름 알림과는 다릅니다.';
  clear($('join-command')).append(commandLine('새 AI 세션에서', commandFor(preferred, 'join'), '이 명령은 각 도구의 AI 대화창에 입력합니다'));
  const pm = team.pm;
  $('pm-guide').textContent = !pm ? 'PM이 없어 수동 업무 배정을 시작하지 못하고 있어요. PM으로 쓸 AI 세션에서 아래 명령과 목표를 입력하세요.' : pm.kind === 'human' ? `${pm.author}님이 PM입니다. 상세 기록의 업무 배정에서 작업·담당·현재 단계를 선택하세요.` : `PM은 ${pm.author}입니다. 이 세션에 목표를 전달하면 작업을 만들고 첫 단계를 배정합니다.`;
  clear($('pm-command'));
  const pmText = commandFor(pm?.kind || preferred, 'pm', '<진행할 목표>');
  if (pmText) $('pm-command').append(commandLine(pm ? `${pm.author} 세션에서` : 'PM으로 쓸 세션에서', pmText, '<진행할 목표>를 실제 요청으로 바꾸세요'));
  clear($('session-guide')).append(...(agents.length ? agents.map((agent) => {
    const guide = sessionGuide(agent, team);
    return el('li', {}, el('strong', { text: `${agent.author} · ${guide.title}` }), el('p', { text: guide.detail }),
      guide.command ? commandLine(`${agent.author} 세션에서`, guide.command) : null);
  }) : [el('li', { text: '참여한 터미널 AI 세션이 없습니다. 위의 한 줄 요청은 join 없이 바로 시작할 수 있어요.' })]));
}
async function loadTools() {
  const data = await api('/api/request-tools');
  tools = data.tools;
  if (!tools.some((t) => t.id === preferred && t.installed)) preferred = tools.find((t) => t.installed)?.id || tools[0]?.id || 'codex';
  clear($('request-tool')).append(...tools.map((t) => el('option', { value: t.id, text: t.label + (t.installed ? '' : ' · 설치 필요') })));
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
        $('team-status').textContent = '팀 기록 확인 필요';
        clear($('session-guide')); clear($('pm-command')); clear($('join-command'));
        $('pm-guide').textContent = '';
        $('team-error').hidden = false;
        $('team-error').textContent = `팀 기록을 읽지 못했어요: ${snapshot.find((r) => r.status === 'rejected').reason.message}. 상세 기록에서 확인해 주세요.`;
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
  $('tool-check-status').textContent = '설치 확인 중…';
  try { await loadTools(); $('tool-check-status').textContent = tools.some((t) => t.installed) ? '설치한 도구를 확인했어요.' : 'CLI가 보이지 않으면 설치 후 init으로 대시보드를 다시 실행하세요.'; }
  catch (error) { $('tool-check-status').textContent = error.message; }
  finally { checkingTools = false; render(); }
});
$('request-next-action').addEventListener('click', async () => {
  if ($('request-next-action').dataset.action === 'workflow') {
    const r = current();
    if (!r?.workflow || startingWorkflow || !online) return;
    if ($('request-body').value.trim()) { showError(new Error('입력 중인 수정 내용을 먼저 보내거나 비운 뒤 워크플로우를 시작하세요.')); return; }
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
  if (sending || !online || current()?.newRequest || (!current() && !tools.some((t) => t.id === preferred && t.installed))) return;
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
const events = new EventSource('/api/events');
events.addEventListener('requests', () => { void refresh(); });
for (const type of ['presence', 'tasks', 'features']) events.addEventListener(type, () => { void refresh(); });
events.onopen = () => { void refresh(); };
events.onerror = () => { online = false; render(); };
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
window.addEventListener('pagehide', () => { clearInterval(poll); events.close(); });
