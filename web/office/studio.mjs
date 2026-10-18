import { clear, el } from '/dom.mjs';

export const CHECK_LABELS = { unchecked: '검사 전', unsupported: '지원 안 함', 'not-configured': '미연결', 'auth-required': '인증 필요', error: '연결 오류',
  'target-mismatch': '대상 불일치', 'read-only': '읽기 전용', 'read-write': '읽기·쓰기 가능', connected: '연결됨 · 대상은 제작 때 확인' };
export const JOB_LABELS = { queued: '준비 중', producing: '제작 중', review: '대표 검토', blocked: '확인 필요', failed: '실패', stopped: '중지됨', approved: '확정', 'handed-off': '개발 인계됨' };
const USABLE = new Set(['read-write', 'connected']);
const AGENTS = [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude Code' }];
const TOOL_LABELS = { figma: 'Figma', blender: 'Blender' };
const drafts = new Map(), pending = new Set(), keys = new Map();
let notice = '';

function field(id, tag, attrs) {
  const node = el(tag, { id, ...attrs });
  if (drafts.has(id)) node.value = drafts.get(id);
  node.addEventListener('input', () => drafts.set(id, node.value));
  return node;
}
const pad = (n) => String(n).padStart(2, '0');
const when = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const clearDrafts = (...ids) => ids.forEach((id) => drafts.delete(id));
const restore = (node) => { if (drafts.has(node.id)) node.value = drafts.get(node.id); return node; };
const keyFor = (action) => { if (!keys.has(action)) keys.set(action, crypto.randomUUID()); return keys.get(action); };

export function targetSummary(target) {
  return target.tool === 'figma' ? `Figma 파일 ${target.figma.fileKey} · 프레임 ${target.figma.nodeId}` : `${target.blender.file} · 장면 ${target.blender.scene} · 컬렉션 ${target.blender.collection}`;
}
export function usableAgents(target) { return AGENTS.filter((agent) => USABLE.has(target.checks?.[agent.id]?.state)); }

export function jobNext(job) {
  const n = job.versions.at(-1)?.n;
  return ({
    queued: '순서를 기다리고 있습니다. 같은 요청을 다시 보낼 필요가 없습니다.',
    producing: '디자인 도구에서 만드는 중입니다. 멈추려면 중지를 누르세요.',
    review: `v${n} 미리보기를 확인하고 수정 의견을 보내거나 이 버전을 확정하세요.`,
    blocked: '담당 AI가 멈춘 이유를 확인하고 답을 보내거나 연결을 고친 뒤 이어서 제작하세요.',
    failed: '실패 이유를 해결한 뒤 이어서 제작하세요. 실패한 결과는 버전으로 남기지 않습니다.',
    stopped: '이어서 제작하면 저장된 의견부터 다시 진행합니다.',
    approved: `확정한 v${job.approved?.version} 버전을 개발에 인계하세요. 더 고칠 점이 있으면 확정을 취소하세요.`,
    'handed-off': '개발 담당이 인계 문서와 확정 미리보기를 기준으로 구현합니다.',
  })[job.status] ?? '';
}

export function renderStudioCollab(panel, { data, features = [], api, token, refresh, demo = false }) {
  const { targets = [], jobs = [] } = data ?? {};
  const status = el('p', { class: 'studio-status', role: 'alert', text: notice });
  const run = async (key, action, done) => {
    if (pending.has(key)) return;
    pending.add(key); notice = ''; status.textContent = ''; render();
    try { await action(); done?.(); }
    catch (error) { notice = error.message; status.textContent = notice; status.scrollIntoView?.({ block: 'nearest' }); }
    finally { pending.delete(key); await refresh(); }
  };
  const post = (path, body) => api(path, { method: 'POST', body, token });
  const busy = (key) => pending.has(key);

  function targetCard(target) {
    const checks = el('ul', { class: 'studio-checks' }, ...AGENTS.map((agent) => {
      const check = target.checks?.[agent.id];
      const state = check?.state ?? 'unchecked', key = `check:${target.id}:${agent.id}`;
      return el('li', { 'data-state': state },
        el('strong', { text: `${agent.label}: ${CHECK_LABELS[state] ?? state}` }),
        check?.detail ? el('span', { text: ` ${check.detail}` }) : null,
        check?.next ? el('p', { class: 'studio-next', text: `다음 행동: ${check.next}` }) : null,
        check?.checkedAt ? el('small', { text: ` 검사 ${when(check.checkedAt)}` }) : null,
        el('button', { type: 'button', disabled: busy(key) || demo, onclick: () => run(key, () => post(`/api/design/targets/${target.id}/check`, { agent: agent.id })) }, busy(key) ? '검사 중…' : '연결 검사'));
    }));
    return el('section', { class: 'card studio-target' },
      el('h4', { translate: 'no', text: `${TOOL_LABELS[target.tool]} · ${target.label}` }),
      el('p', { class: 'kind' }, targetSummary(target), target.tool === 'figma' ? el('a', { href: target.figma.url, target: '_blank', rel: 'noopener', text: ' 원본 열기 ↗' }) : null),
      checks);
  }

  function targetForm() {
    const tool = drafts.get('studio-new-tool') ?? 'figma';
    const select = field('studio-new-tool', 'select', { 'aria-label': '디자인 도구' });
    select.append(el('option', { value: 'figma', text: 'Figma 프레임' }), el('option', { value: 'blender', text: 'Blender 컬렉션' }));
    select.value = tool;
    select.addEventListener('change', render);
    const inputs = tool === 'figma'
      ? [field('studio-new-url', 'input', { type: 'url', placeholder: 'https://www.figma.com/design/…?node-id=…', 'aria-label': 'Figma 프레임 링크' })]
      : [field('studio-new-file', 'input', { placeholder: 'design/blender/prop.blend', 'aria-label': 'Blender 파일(프로젝트 안 상대 경로)' }),
        field('studio-new-scene', 'input', { placeholder: 'Scene', 'aria-label': '장면 이름' }), field('studio-new-collection', 'input', { placeholder: 'WAX_Prop', 'aria-label': '컬렉션 이름' })];
    const key = 'target:new';
    return el('form', { class: 'studio-form', onsubmit: (event) => { event.preventDefault(); run(key, () => post('/api/design/targets', {
      tool, label: drafts.get('studio-new-label') || undefined, url: drafts.get('studio-new-url'), file: drafts.get('studio-new-file'), scene: drafts.get('studio-new-scene'), collection: drafts.get('studio-new-collection'),
    }), () => clearDrafts('studio-new-url', 'studio-new-file', 'studio-new-scene', 'studio-new-collection', 'studio-new-label')); } },
      el('p', { class: 'studio-note', text: tool === 'figma' ? 'Figma에서 작업할 프레임을 선택하고 “선택 항목 링크 복사”로 받은 링크를 붙여 넣으세요. 그 프레임 안에서만 만들고 고칩니다.' : '이 프로젝트 안의 .blend 파일과 장면·컬렉션을 지정하세요. 그 파일이 Blender에 열려 있을 때만, 그 컬렉션 안에서만 만들고 고칩니다.' }),
      select, ...inputs, field('studio-new-label', 'input', { placeholder: '대상 이름(선택)', 'aria-label': '대상 이름' }),
      el('button', { type: 'submit', disabled: busy(key) || demo }, '연결 대상 추가'));
  }

  function jobForm() {
    const ready = targets.filter((t) => usableAgents(t).length);
    if (!ready.length) return el('p', { class: 'empty', text: '연결 검사를 통과한 대상이 없어 제작을 요청할 수 없습니다. 위에서 대상을 추가하고 연결 검사의 다음 행동을 따라 주세요.' });
    const targetSelect = field('studio-job-target', 'select', { 'aria-label': '디자인 대상' });
    for (const t of ready) targetSelect.append(el('option', { value: t.id, text: `${TOOL_LABELS[t.tool]} · ${t.label}` }));
    restore(targetSelect);
    if (!ready.some((t) => t.id === targetSelect.value)) targetSelect.value = ready[0].id;
    targetSelect.addEventListener('change', render);
    const target = ready.find((t) => t.id === targetSelect.value);
    const agentSelect = field('studio-job-agent', 'select', { 'aria-label': '실행 도구' });
    for (const a of usableAgents(target)) agentSelect.append(el('option', { value: a.id, text: `${a.label}에서 실행` }));
    restore(agentSelect);
    if (!usableAgents(target).some((a) => a.id === agentSelect.value)) agentSelect.value = usableAgents(target)[0].id;
    const featureSelect = field('studio-job-feature', 'select', { 'aria-label': '연결할 작업' });
    featureSelect.append(el('option', { value: '', text: '연결할 작업 없음' }), ...features.map((f) => el('option', { value: f.id, text: `인계 받을 작업: ${f.title}` })));
    restore(featureSelect);
    const key = 'job:new';
    return el('form', { class: 'studio-form', onsubmit: (event) => { event.preventDefault(); run(key, () => post('/api/design/jobs', {
      targetId: targetSelect.value, agent: agentSelect.value, feature: featureSelect.value || undefined, title: drafts.get('studio-job-title'), brief: drafts.get('studio-job-brief'), clientId: keyFor(key),
    }), () => { keys.delete(key); clearDrafts('studio-job-title', 'studio-job-brief'); }); } },
      targetSelect, agentSelect, featureSelect,
      field('studio-job-title', 'input', { placeholder: '예: 룩북 업로드 화면', 'aria-label': '작업 제목', maxlength: '100' }),
      field('studio-job-brief', 'textarea', { placeholder: '만들 화면이나 소품, 꼭 들어갈 요소와 분위기를 적어 주세요.', 'aria-label': '요청 내용', rows: '3', maxlength: '4000' }),
      el('button', { type: 'submit', disabled: busy(key) || demo }, busy(key) ? '요청 중…' : '제작 요청'));
  }

  function version(job, v, current) {
    const url = demo ? v.previewUrl : `/api/design/jobs/${job.id}/versions/${v.n}/preview`;
    const link = job.tool === 'figma' ? `https://www.figma.com/design/${v.source.fileKey}/?node-id=${v.source.nodeId.replace(':', '-')}` : null;
    return el('li', { class: current ? 'studio-version current' : 'studio-version' },
      el('strong', { text: `v${v.n}${job.approved?.version === v.n ? ' · 확정' : ''}` }),
      url ? el('img', { src: url, alt: `${job.title} v${v.n} 미리보기`, class: current ? 'studio-preview-image' : 'studio-thumb', loading: 'lazy' }) : null,
      v.changes ? el('p', {}, '바뀐 점: ', el('span', { translate: 'no', text: v.changes })) : null,
      el('p', { class: 'kind' }, job.tool === 'figma' ? `결과 프레임 ${v.source.nodeId}` : `오브젝트 ${v.source.objects.join(', ') || '-'}${v.source.exported ? ` · 내보낸 파일 ${v.source.exported}` : ''}`,
        link ? el('a', { href: link, target: '_blank', rel: 'noopener', text: ' Figma에서 열기 ↗' }) : null));
  }

  function jobCard(job) {
    const latest = job.versions.at(-1), n = latest?.n ?? 0;
    const actions = el('div', { class: 'studio-actions' });
    const act = (action, label, body = {}) => {
      const key = `${action}:${job.id}`;
      return el('button', { type: 'button', disabled: busy(key) || demo, onclick: () => run(key, () => post(`/api/design/jobs/${job.id}/${action}`, { version: n, revision: job.revision, ...body })) }, label);
    };
    if (['queued', 'producing'].includes(job.status)) actions.append(act('stop', '중지'));
    if (['review', 'blocked', 'failed', 'stopped'].includes(job.status)) {
      const id = `studio-feedback-${job.id}`, key = `feedback:${job.id}`;
      actions.append(field(id, 'textarea', { rows: '2', maxlength: '4000', 'aria-label': `${job.title} 수정 의견`, placeholder: job.status === 'review' ? `v${n}에서 바꿀 점을 적어 주세요` : '담당 AI에게 답하거나 바꿀 점을 적어 주세요' }),
        el('button', { type: 'button', disabled: busy(key) || demo, onclick: () => run(key, () => post(`/api/design/jobs/${job.id}/feedback`, { version: n, revision: job.revision, text: drafts.get(id), clientId: keyFor(key) }), () => { keys.delete(key); clearDrafts(id); }) }, n ? `수정 요청 → v${n + 1}` : '의견 보내고 다시 제작'));
    }
    if (job.status === 'review') actions.append(act('approve', `v${n} 확정`));
    if (['blocked', 'failed', 'stopped'].includes(job.status)) actions.append(act('resume', '이어서 제작'));
    if (job.status === 'approved') actions.append(act('handoff', `확정 v${job.approved.version} 개발에 인계`, { version: job.approved.version }), act('reopen', '확정 취소', { version: job.approved.version }));
    const versions = el('ol', { class: 'studio-versions', reversed: '' }, ...[...job.versions].reverse().map((v) => version(job, v, v.n === n)));
    return el('section', { class: 'card studio-job', 'data-status': job.status },
      el('h4', { translate: 'no', text: job.title }),
      el('p', { class: 'kind', text: `${TOOL_LABELS[job.tool]} · ${AGENTS.find((a) => a.id === job.agent)?.label ?? job.agent} · ${JOB_LABELS[job.status] ?? job.status}${job.feature ? ` · 인계 대상 ${job.feature}` : ''}` }),
      el('p', { text: job.detail }), el('p', { class: 'studio-next', text: `다음 행동: ${jobNext(job)}` }),
      job.versions.length ? versions : el('p', { class: 'empty', text: '아직 받은 버전이 없습니다. 디자인 도구에서 결과를 받아 와야 버전이 생깁니다.' }),
      job.feedback.length ? el('details', {}, el('summary', { text: `대표 의견 ${job.feedback.length}건` }), el('ul', {}, ...job.feedback.map((f) => el('li', { translate: 'no', text: `v${f.version}: ${f.text}` })))) : null,
      job.handoff ? el('p', { class: 'studio-handoff', text: `개발 인계: v${job.handoff.version} · ${job.handoff.doc} · 미리보기 ${job.handoff.preview}` }) : null,
      actions);
  }

  function render() {
    const active = document.activeElement?.id?.startsWith('studio-') ? document.activeElement : null;
    const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    clear(panel).append(
      ...(demo ? [el('p', { class: 'studio-demo', text: '데모 예시 화면입니다. 실제 Figma·Blender MCP 실행이나 연결 검사 결과가 아닙니다.' })] : []),
      status,
      el('h3', { text: '디자인 도구 연결' }),
      el('p', { class: 'studio-note', text: '디자인 도구는 실행 도구(Codex·Claude Code)에 등록한 MCP와 로그인을 그대로 씁니다. 연결 검사는 그 실행 도구에서 실제로 대상을 읽어 확인하며, 비밀 토큰은 wax에 저장하지 않습니다.' }),
      ...(targets.length ? targets.map(targetCard) : [el('p', { class: 'empty', text: '연결한 디자인 대상이 없습니다.' })]),
      el('details', { open: !targets.length || undefined }, el('summary', { text: '연결 대상 추가' }), targetForm()),
      el('h3', { text: '디자인 작업' }),
      el('p', { class: 'studio-note', text: '요청 → 제작 → 미리보기·대표 검토 → 수정 요청(같은 대상의 다음 버전) → 확정 → 개발 인계' }),
      jobForm(),
      ...(jobs.length ? jobs.map(jobCard) : [el('p', { class: 'empty', text: '디자인 작업이 없습니다.' })]));
    const again = active && panel.querySelector(`#${CSS.escape(active.id)}`);
    if (again) { again.focus(); if (caret) try { again.setSelectionRange(...caret); } catch {   } }
    if (notice) status.scrollIntoView?.({ block: 'nearest' });
  }
  render();
}
