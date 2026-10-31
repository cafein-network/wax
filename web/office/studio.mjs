import { t } from '../messages-catalog.mjs';
import { clear, el, tr, trFill } from '/dom.mjs';

export const CHECK_LABELS = { unchecked: t('office.studio.notChecked'), unsupported: t('office.studio.notSupported'), 'not-configured': t('office.studio.notConnected'), 'auth-required': t('office.studio.signInRequired'), error: t('office.studio.connectionError'),
  'target-mismatch': t('office.studio.targetMismatch'), 'read-only': t('office.studio.readOnly'), 'read-write': t('office.studio.readAndWrite'), connected: t('office.studio.connectedTargetConfirmedWhen') };
export const JOB_LABELS = { queued: t('office.studio.queued'), producing: t('office.studio.making'), review: t('office.studio.ceoReview'), blocked: t('office.studio.needsAttention'), failed: t('office.studio.failed'), stopped: t('office.studio.stopped'), approved: t('office.studio.approved'), 'handed-off': t('office.studio.handedOff') };
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
  return target.tool === 'figma' ? t('office.studio.figmaFileFrame', target.figma.fileKey, target.figma.nodeId) : t('office.studio.sceneCollection', target.blender.file, target.blender.scene, target.blender.collection);
}
export function usableAgents(target) { return AGENTS.filter((agent) => USABLE.has(target.checks?.[agent.id]?.state)); }

export function jobNext(job) {
  const n = job.versions.at(-1)?.n;
  return ({
    queued: t('office.studio.waitingItsTurnYou'),
    producing: t('office.studio.beingMadeInThe'),
    review: `v${n} 미리보기를 확인하고 수정 의견을 보내거나 이 버전을 확정하세요.`,
    blocked: t('office.studio.findOutWhyThe'),
    failed: t('office.studio.resolveTheCauseOf'),
    stopped: t('office.studio.continuingProductionResumesFrom'),
    approved: `확정한 v${job.approved?.version} 버전을 개발에 인계하세요. 더 고칠 점이 있으면 확정을 취소하세요.`,
    'handed-off': t('office.studio.developmentBuildsFromThe'),
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
        el('button', { type: 'button', disabled: busy(key) || demo, onclick: () => run(key, () => post(`/api/design/targets/${target.id}/check`, { agent: agent.id })) }, busy(key) ? t('office.studio.checking') : t('office.studio.checkConnection')));
    }));
    return el('section', { class: 'card studio-target' },
      el('h4', { translate: 'no', text: `${TOOL_LABELS[target.tool]} · ${target.label}` }),
      el('p', { class: 'kind' }, targetSummary(target), target.tool === 'figma' ? el('a', { href: target.figma.url, target: '_blank', rel: 'noopener', text: ' 원본 열기 ↗' }) : null),
      checks);
  }

  function targetForm() {
    const tool = drafts.get('studio-new-tool') ?? 'figma';
    const select = field('studio-new-tool', 'select', { 'aria-label': t('office.studio.designTool') });
    select.append(el('option', { value: 'figma', text: t('office.studio.figmaFrame') }), el('option', { value: 'blender', text: t('office.studio.blenderCollection') }));
    select.value = tool;
    select.addEventListener('change', render);
    const inputs = tool === 'figma'
      ? [field('studio-new-url', 'input', { type: 'url', placeholder: 'https://www.figma.com/design/…?node-id=…', 'aria-label': t('office.studio.figmaFrameLink') })]
      : [field('studio-new-file', 'input', { placeholder: 'design/blender/prop.blend', 'aria-label': t('office.studio.blenderFilePathInside') }),
        field('studio-new-scene', 'input', { placeholder: 'Scene', 'aria-label': t('office.studio.sceneName') }), field('studio-new-collection', 'input', { placeholder: 'WAX_Prop', 'aria-label': t('office.studio.collectionName') })];
    const key = 'target:new';
    return el('form', { class: 'studio-form', onsubmit: (event) => { event.preventDefault(); run(key, () => post('/api/design/targets', {
      tool, label: drafts.get('studio-new-label') || undefined, url: drafts.get('studio-new-url'), file: drafts.get('studio-new-file'), scene: drafts.get('studio-new-scene'), collection: drafts.get('studio-new-collection'),
    }), () => clearDrafts('studio-new-url', 'studio-new-file', 'studio-new-scene', 'studio-new-collection', 'studio-new-label')); } },
      el('p', { class: 'studio-note', text: tool === 'figma' ? t('office.studio.inFigmaSelectThe') : t('office.studio.nameABlendFile') }),
      select, ...inputs, field('studio-new-label', 'input', { placeholder: t('office.studio.targetNameOptional'), 'aria-label': t('office.studio.targetName') }),
      el('button', { type: 'submit', disabled: busy(key) || demo }, t('office.studio.addATarget')));
  }

  function jobForm() {
    const ready = targets.filter((item) => usableAgents(item).length);
    if (!ready.length) return el('p', { class: 'empty', text: t('office.studio.noTargetHasPassed') });
    const targetSelect = field('studio-job-target', 'select', { 'aria-label': t('office.studio.designTarget') });
    for (const item of ready) targetSelect.append(el('option', { value: item.id, translate: 'no', text: `${TOOL_LABELS[item.tool]} · ${item.label}` }));
    restore(targetSelect);
    if (!ready.some((item) => item.id === targetSelect.value)) targetSelect.value = ready[0].id;
    targetSelect.addEventListener('change', render);
    const target = ready.find((item) => item.id === targetSelect.value);
    const agentSelect = field('studio-job-agent', 'select', { 'aria-label': t('office.studio.executionTool') });
    for (const a of usableAgents(target)) agentSelect.append(el('option', { value: a.id, text: `${a.label}에서 실행` }));
    restore(agentSelect);
    if (!usableAgents(target).some((a) => a.id === agentSelect.value)) agentSelect.value = usableAgents(target)[0].id;
    const featureSelect = field('studio-job-feature', 'select', { 'aria-label': t('office.studio.linkedTask') });
    featureSelect.append(el('option', { value: '', text: t('office.studio.noLinkedTask') }), ...features.map((f) => el('option', { value: f.id, translate: 'no', text: trFill('인계 받을 작업: {0}', f.title) })));
    restore(featureSelect);
    const key = 'job:new';
    return el('form', { class: 'studio-form', onsubmit: (event) => { event.preventDefault(); run(key, () => post('/api/design/jobs', {
      targetId: targetSelect.value, agent: agentSelect.value, feature: featureSelect.value || undefined, title: drafts.get('studio-job-title'), brief: drafts.get('studio-job-brief'), clientId: keyFor(key),
    }), () => { keys.delete(key); clearDrafts('studio-job-title', 'studio-job-brief'); }); } },
      targetSelect, agentSelect, featureSelect,
      field('studio-job-title', 'input', { placeholder: t('office.studio.eGLookbookUpload'), 'aria-label': t('office.studio.jobTitle'), maxlength: '100' }),
      field('studio-job-brief', 'textarea', { placeholder: t('office.studio.describeTheScreenOr'), 'aria-label': t('office.studio.request'), rows: '3', maxlength: '4000' }),
      el('button', { type: 'submit', disabled: busy(key) || demo }, busy(key) ? t('office.studio.requesting') : t('office.studio.requestDesign')));
  }

  function version(job, v, current) {
    const url = demo ? v.previewUrl : `/api/design/jobs/${job.id}/versions/${v.n}/preview`;
    const link = job.tool === 'figma' ? `https://www.figma.com/design/${v.source.fileKey}/?node-id=${v.source.nodeId.replace(':', '-')}` : null;
    return el('li', { class: current ? 'studio-version current' : 'studio-version' },
      el('strong', { text: `v${v.n}${job.approved?.version === v.n ? ' · 확정' : ''}` }),
      url ? el('img', { src: url, alt: trFill('{0} v{1} 미리보기', job.title, v.n), translate: 'no', class: current ? 'studio-preview-image' : 'studio-thumb', loading: 'lazy' }) : null,
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
    if (['queued', 'producing'].includes(job.status)) actions.append(act('stop', t('office.studio.stop')));
    if (['review', 'blocked', 'failed', 'stopped'].includes(job.status)) {
      const id = `studio-feedback-${job.id}`, key = `feedback:${job.id}`;
      actions.append(field(id, 'textarea', { rows: '2', maxlength: '4000', 'aria-label': trFill('{0} 수정 의견', job.title), translate: 'no', placeholder: tr(job.status === 'review' ? `v${n}에서 바꿀 점을 적어 주세요` : t('office.studio.answerTheDesignAgent')) }),
        el('button', { type: 'button', disabled: busy(key) || demo, onclick: () => run(key, () => post(`/api/design/jobs/${job.id}/feedback`, { version: n, revision: job.revision, text: drafts.get(id), clientId: keyFor(key) }), () => { keys.delete(key); clearDrafts(id); }) }, n ? `수정 요청 → v${n + 1}` : t('office.studio.sendNotesAndMake')));
    }
    if (job.status === 'review') actions.append(act('approve', `v${n} 확정`));
    if (['blocked', 'failed', 'stopped'].includes(job.status)) actions.append(act('resume', t('office.studio.continueMaking')));
    if (job.status === 'approved') actions.append(act('handoff', `확정 v${job.approved.version} 개발에 인계`, { version: job.approved.version }), act('reopen', t('office.studio.cancelApproval'), { version: job.approved.version }));
    const versions = el('ol', { class: 'studio-versions', reversed: '' }, ...[...job.versions].reverse().map((v) => version(job, v, v.n === n)));
    return el('section', { class: 'card studio-job', 'data-status': job.status },
      el('h4', { translate: 'no', text: job.title }),
      el('p', { class: 'kind', text: `${TOOL_LABELS[job.tool]} · ${AGENTS.find((a) => a.id === job.agent)?.label ?? job.agent} · ${JOB_LABELS[job.status] ?? job.status}${job.feature ? ` · 인계 대상 ${job.feature}` : ''}` }),
      el('p', { text: job.detail }), el('p', { class: 'studio-next', text: `다음 행동: ${jobNext(job)}` }),
      job.versions.length ? versions : el('p', { class: 'empty', text: t('office.studio.noVersionsYetA') }),
      job.feedback.length ? el('details', {}, el('summary', { text: `대표 의견 ${job.feedback.length}건` }), el('ul', {}, ...job.feedback.map((f) => el('li', { translate: 'no', text: `v${f.version}: ${f.text}` })))) : null,
      job.handoff ? el('p', { class: 'studio-handoff', text: t('office.studio.handoffToDevelopmentV', job.handoff.version, job.handoff.doc, job.handoff.preview) }) : null,
      actions);
  }

  function render() {
    const active = document.activeElement?.id?.startsWith('studio-') ? document.activeElement : null;
    const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    clear(panel).append(
      ...(demo ? [el('p', { class: 'studio-demo', text: t('office.studio.sampleScreenTheseAre') })] : []),
      status,
      el('h3', { text: t('office.studio.designToolConnections') }),
      el('p', { class: 'studio-note', text: t('office.studio.designToolsUseThe') }),
      ...(targets.length ? targets.map(targetCard) : [el('p', { class: 'empty', text: t('office.studio.noDesignTargetsConnected') })]),
      el('details', { open: !targets.length || undefined }, el('summary', { text: t('office.studio.addATarget') }), targetForm()),
      el('h3', { text: t('office.studio.designJobs') }),
      el('p', { class: 'studio-note', text: t('office.studio.requestMakePreviewAnd') }),
      jobForm(),
      ...(jobs.length ? jobs.map(jobCard) : [el('p', { class: 'empty', text: t('office.studio.noDesignJobs') })]));
    const again = active && panel.querySelector(`#${CSS.escape(active.id)}`);
    if (again) { again.focus(); if (caret) try { again.setSelectionRange(...caret); } catch {   } }
    if (notice) status.scrollIntoView?.({ block: 'nearest' });
  }
  render();
}
