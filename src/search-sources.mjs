import { LABELS } from './workflow.mjs';

export const SOURCES = [
  { kind: 'channel', format: 'jsonl', dir: ['.wax', 'chat', 'channels'], name: /^[a-z0-9][a-z0-9-]{0,63}\.jsonl$/ },
  { kind: 'board', format: 'jsonl', dir: ['.wax', 'chat', 'board'], name: /^[a-z0-9][a-z0-9-]{0,63}\.jsonl$/ },
  { kind: 'tasks', format: 'jsonl', dir: ['.wax', 'chat'], name: /^assignments\.jsonl$/ },
  { kind: 'daily', format: 'jsonl', dir: ['.wax', 'chat'], name: /^daily\.jsonl$/ },
  { kind: 'feature', format: 'json', dir: ['.wax', 'features'], name: /^[a-z0-9][a-z0-9-]{0,63}\.json$/ },
  { kind: 'request', format: 'json', dir: ['.wax', 'chat', 'requests'], name: /^request-[a-f0-9-]{36}\.json$/ },
  { kind: 'design', format: 'json', dir: ['.wax', 'design', 'jobs'], name: /^design-[a-f0-9-]{36}\.json$/ },
];

export const DOC_KINDS = {
  message: '채널 메시지', note: '화이트보드 노트', report: '보고서', task: '업무 배정·상태', feature: '작업', document: '단계 문서',
  evidence: '완료 근거', history: '개선 이력', test: '테스트 근거', commit: '커밋 근거', request: '요청 대화', design: '디자인 작업',
};

const text = (value, max = 20_000) => (typeof value === 'string' ? value.slice(0, max) : '');
const id = (value) => (typeof value === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(value) ? value : null);
const name = (value) => (typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u.test(value) ? value : null);
const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
const feature = (value) => (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null);
const doc = (fields) => ({ feature: null, channel: null, author: null, type: null, phase: null, status: null, at: null, seq: null, title: '', ...fields, body: fields.body ?? '' });

function referenced(file, fields) {
  return doc({ ...fields, body: file.state === 'ok' ? text(file.text, 100_000) : '', status: file.state === 'ok' ? null : `file-${file.state}`, file: { path: fields.pointer, state: file.state, key: file.key } });
}

export async function lineDocs(source, record, { rel, files, taskFeature }) {
  if (!record || typeof record !== 'object' || !id(record.id)) return [];
  const base = { pointer: `${rel}#${record.id}`, seq: Number.isSafeInteger(record.seq) ? record.seq : null, at: iso(record.at), author: name(record.author) };
  if (source.kind === 'channel') {
    const channel = rel.split('/').at(-1).replace(/\.jsonl$/, '');
    return [doc({ ...base, ref: `message:${channel}:${record.id}`, kind: 'message', channel, feature: channel === 'general' ? null : channel, type: id(record.type),
      phase: id(record.phase), body: text(record.body), link: `/chat?channel=${encodeURIComponent(channel)}#${record.id}` })];
  }
  if (source.kind === 'board') {
    const board = rel.split('/').at(-1).replace(/\.jsonl$/, '');
    const link = `/manage?feature=${encodeURIComponent(board)}`;
    if (record.record === 'note') return [doc({ ...base, ref: `note:${board}:${record.id}`, kind: 'note', feature: board, type: id(record.type), phase: id(record.phase), body: text(record.body), link })];
    if (record.record === 'report' && typeof record.path === 'string') {
      return [referenced(await files(record.path), { ...base, ref: `report:${board}:${record.id}`, kind: 'report', feature: board, type: 'board', title: `${board} 화이트보드 보고서 ${record.number}`, pointer: record.path, link })];
    }
    return [];
  }
  if (source.kind === 'tasks') {
    if (record.record === 'task') {
      return [doc({ ...base, ref: `task:${record.id}`, kind: 'task', feature: feature(record.feature), author: name(record.by), type: 'assign', phase: id(record.phase),
        status: 'open', title: `업무 ${record.id} → ${name(record.to) ?? ''}`, body: text(record.note), link: `/manage?feature=${encodeURIComponent(record.feature ?? '')}` })];
    }
    if (record.record === 'status' && id(record.task)) {
      const owner = await taskFeature(record.task);
      return [doc({ ...base, ref: `task:${record.id}`, kind: 'task', feature: owner, type: id(record.status), status: id(record.status),
        title: `업무 ${record.task} ${record.status}`, body: text(record.note) || String(record.status), link: owner ? `/manage?feature=${encodeURIComponent(owner)}` : '/manage' })];
    }
    return [];
  }
  if (source.kind === 'daily' && record.record === 'daily' && typeof record.path === 'string') {
    return [referenced(await files(record.path), { ...base, ref: `daily:${record.id}`, kind: 'report', type: 'daily', title: `일일 업무보고 ${record.date} #${record.number}`,
      pointer: record.path, link: `/manage?date=${encodeURIComponent(record.date)}` })];
  }
  return [];
}

export function fileDocs(source, data, { rel }) {
  if (!data || typeof data !== 'object') return [];
  const at = (value) => iso(value) ?? iso(data.updatedAt) ?? iso(data.createdAt);
  if (source.kind === 'feature') {
    const key = feature(data.id);
    if (!key) return [];
    const link = `/manage?feature=${encodeURIComponent(key)}`, base = { feature: key, link };
    const docs = [doc({ ...base, ref: `feature:${key}`, kind: 'feature', title: text(data.title, 200), body: text(data.description), phase: id(data.phase),
      status: data.archivedAt ? 'archived' : null, at: at(data.updatedAt), pointer: `${rel}#/title` })];
    for (const [phase, content] of Object.entries(data.artifacts ?? {})) {
      docs.push(doc({ ...base, ref: `document:${key}:${phase}`, kind: 'document', phase, title: `${data.title ?? key} ${LABELS[phase] ?? phase} 문서`, body: text(content, 100_000), at: at(data.updatedAt), pointer: `${rel}#/artifacts/${phase}` }));
    }
    for (const [phase, done] of Object.entries(data.completed ?? {})) {
      if (done && typeof done === 'object') docs.push(doc({ ...base, ref: `evidence:${key}:${phase}`, kind: 'evidence', phase, title: `${LABELS[phase] ?? phase} 완료 근거`, body: text(done.evidence), at: at(done.at), status: id(done.verdict), pointer: `${rel}#/completed/${phase}` }));
    }
    (Array.isArray(data.history) ? data.history : []).forEach((event, index) => {
      const body = [text(event?.reason), text(event?.evidence)].filter(Boolean).join('\n');
      if (body) docs.push(doc({ ...base, ref: `history:${key}:${index}`, kind: 'history', type: id(event.action), phase: id(event.phase), title: `${event.action ?? '이력'} 기록`, body, at: at(event.at), pointer: `${rel}#/history/${index}` }));
    });
    (Array.isArray(data.proofs) ? data.proofs : []).forEach((proof, index) => {
      if (!proof || typeof proof !== 'object') return;
      const common = { ...base, phase: id(proof.phase), at: at(proof.at), pointer: `${rel}#/proofs/${index}` };
      if (proof.kind === 'git') {
        docs.push(doc({ ...common, ref: `commit:${key}:${proof.id}`, kind: 'commit', type: 'git', title: `커밋 ${String(proof.commit).slice(0, 12)}`,
          body: [text(proof.commit, 64), text(proof.message, 2000), ...(Array.isArray(proof.files) ? proof.files.slice(0, 200).map((f) => text(f, 300)) : [])].filter(Boolean).join('\n') }));
      } else if (proof.kind === 'test') {
        const passed = proof.exitCode === 0 && !proof.timedOut;
        docs.push(doc({ ...common, ref: `test:${key}:${proof.id}`, kind: 'test', type: id(proof.verification) ?? 'test', status: passed ? 'pass' : 'fail',
          title: `테스트 ${passed ? '통과' : `실패 (exit ${proof.exitCode ?? '없음'})`}`,
          body: [Array.isArray(proof.command) ? proof.command.map((a) => text(a, 300)).join(' ') : '', text(proof.commit ?? proof.head, 64), ...(Array.isArray(proof.checks) ? proof.checks : []), text(proof.output, 4000)].filter(Boolean).join('\n') }));
      }
    });
    return docs;
  }
  if (source.kind === 'request') {
    const key = typeof data.id === 'string' && /^request-[a-f0-9-]{36}$/.test(data.id) ? data.id : null;
    if (!key) return [];
    const link = `/?request=${encodeURIComponent(key)}`, title = text(data.title, 200);
    const docs = (Array.isArray(data.messages) ? data.messages : []).map((message, index) => doc({
      ref: `request:${key}:${index}`, kind: 'request', feature: key, type: message?.role === 'user' ? 'user' : 'assistant', author: message?.role === 'user' ? name(data.author) : name(data.agent) ?? id(data.tool),
      phase: id(message?.phase), status: id(data.status), title, body: text(message?.text), at: at(message?.at), link, pointer: `${rel}#/messages/${index}` }));
    if (typeof data.workflow?.document === 'string') docs.push(doc({ ref: `request:${key}:workflow`, kind: 'document', feature: key, phase: 'plan', status: id(data.status), title: `${title} 워크플로우`, body: text(data.workflow.document, 100_000), at: at(data.updatedAt), link, pointer: `${rel}#/workflow/document` }));
    return docs;
  }
  if (source.kind === 'design') {
    const key = typeof data.id === 'string' && /^design-[a-f0-9-]{36}$/.test(data.id) ? data.id : null;
    if (!key) return [];
    const base = { feature: feature(data.feature), status: id(data.status), link: '/office?studio=1' }, title = text(data.title, 200);
    const docs = [doc({ ...base, ref: `design:${key}`, kind: 'design', type: id(data.tool), author: name(data.author), title, body: text(data.brief), at: at(data.createdAt), pointer: `${rel}#/brief` })];
    (Array.isArray(data.feedback) ? data.feedback : []).forEach((note, index) => docs.push(doc({ ...base, ref: `design:${key}:feedback:${index}`, kind: 'design', type: 'feedback', author: name(note?.author), title: `${title} v${note?.version} 수정 의견`, body: text(note?.text), at: at(note?.at), pointer: `${rel}#/feedback/${index}` })));
    (Array.isArray(data.versions) ? data.versions : []).forEach((version, index) => docs.push(doc({ ...base, ref: `design:${key}:v${version?.n}`, kind: 'design', type: 'version', title: `${title} v${version?.n}`,
      body: [text(version?.changes), text(version?.report), text(version?.preview, 300), text(version?.source?.nodeId, 40), text(version?.source?.file, 300)].filter(Boolean).join('\n'), at: at(version?.at), pointer: `${rel}#/versions/${index}` })));
    if (data.handoff && typeof data.handoff === 'object') docs.push(doc({ ...base, ref: `design:${key}:handoff`, kind: 'design', type: 'handoff', title: `${title} 개발 인계 v${data.handoff.version}`, body: [text(data.handoff.doc, 300), text(data.handoff.preview, 300)].join('\n'), at: at(data.handoff.at), pointer: `${rel}#/handoff` }));
    return docs;
  }
  return [];
}
