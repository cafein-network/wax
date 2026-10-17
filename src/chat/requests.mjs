import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, createFeature, getFeature, updateFeature, PHASES, LABELS, WaxError } from '../workflow.mjs';
import { runAgentSession } from '../agent-session.mjs';
import { agentTool } from '../agent-tools.mjs';
import { chatDir, checkFile, safeDir } from './paths.mjs';
import { withLock, processAlive } from './lock.mjs';
import { writeJsonAtomic } from './store.mjs';
import { joinPresence as joinSession, setPresence as updatePresence } from './presence.mjs';
import * as v from './validate.mjs';

const ACTIVE = new Set(['queued', 'running']);
const modeOf = (mode = 'sm') => {
  if (!['project', 'sm'].includes(mode)) throw new WaxError('진행 모드는 project 또는 sm이어야 합니다.');
  return mode;
};
const replanned = () => Object.assign(new WaxError('다른 세션이 프로젝트 단계를 변경해 이 요청은 이어서 진행할 수 없습니다. 상세 기록을 확인하고 새 프로젝트 요청으로 워크플로우를 작성하세요.'), { newRequest: true });
const SM_LABELS = { plan: '접수·분석', design: '영향 확인', implement: '수정', review: '회귀 검증', report: '처리 보고' };
const phaseLabel = (request, phase) => request.mode === 'sm' ? SM_LABELS[phase] : phase === 'plan' ? '워크플로우 작성' : LABELS[phase];
const CLI = fileURLToPath(new URL('../../bin/wax.mjs', import.meta.url));
const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['complete', 'question', 'blocked'] },
    report: { type: 'string' }, document: { type: 'string' }, evidence: { type: 'string' },
    proofIds: { type: 'array', items: { type: 'string' } },
  }, required: ['outcome', 'report', 'document', 'evidence', 'proofIds'],
};
function requestId(id) {
  if (typeof id !== 'string' || !/^request-[a-f0-9-]{36}$/.test(id)) throw new WaxError('잘못된 요청 ID입니다.');
  return id;
}
async function requestFile(root, id, create = false) {
  const dir = await chatDir(root, 'requests', { create });
  return dir ? checkFile(join(dir, `${requestId(id)}.json`)) : null;
}
async function read(root, id) {
  const file = await requestFile(root, id);
  try {
    if (!file) throw Object.assign(new Error(), { code: 'ENOENT' });
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.tool = agentTool(record.tool).id;
    record.mode = modeOf(record.mode);
    if (record.id !== id || !Array.isArray(record.messages) || !PHASES.includes(record.phase) && record.phase !== 'done') throw new Error('invalid record');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') throw new WaxError('요청을 찾을 수 없습니다.', 404);
    throw new WaxError('요청 기록을 읽지 못했습니다. 원본을 확인해 주세요.', 500);
  }
}
const interrupted = (r) => ACTIVE.has(r.status) && r.owner && !processAlive(r.owner.pid);
function publicRecord(r) {
  const { thread, owner, ...data } = r;
  return interrupted(r) ? { ...data, status: 'paused', detail: '실행 연결이 종료되었습니다. 이어서 진행하면 저장된 단계부터 계속합니다.' } : data;
}
async function mutate(root, id, change) {
  const file = await requestFile(root, id, true);
  return withLock(`${file}.lock`, async () => {
    const r = await read(root, id);
    await change(r);
    r.updatedAt = new Date().toISOString();
    await writeJsonAtomic(file, r);
    return r;
  });
}
const addMessage = (r, role, text, extra = {}) => r.messages.push({ id: randomUUID(), role, text, at: new Date().toISOString(), ...extra });

export function requestPrompt(request, feature) {
  return [
    '사용자가 한 줄로 요청한 작업을 기획부터 결과 보고까지 진행하는 wax 담당자입니다.',
    request.mode === 'project'
      ? '프로젝트 모드입니다. plan에서는 구현에 앞서 워크플로우를 작성하세요: 목표, 범위와 제외 범위, 기능별 작업 순서와 선행 관계, 단계별 산출물, 완료 기준과 검증 방법을 구체적으로 정리하세요. 실행 담당은 이 요청에서 선택한 도구의 별도 세션입니다. 다른 AI에 실제 배정했다고 주장하지 마세요. 워크플로우 문서는 사용자가 확인하고 시작할 때까지 plan에 머뭅니다. plan 중에는 제품 코드를 변경하거나 구현을 시작하지 마세요. 이후 단계는 확정한 워크플로우를 따르세요.'
      : 'SM(유지보수) 모드입니다. 기존 동작을 보존하며 요청 단위로 접수·원인 분석(plan), 영향·수정 방안 확인(design), 수정(implement), 회귀 검증(review), 처리 보고(report)를 이어서 진행하세요. plan/design은 요청 규모에 맞게 간결히 작성하고 새 프로젝트 전체의 기획이나 사용자가 요구하지 않은 재설계를 반복하지 마세요. 재현 조건, 영향 범위, 최소 수정, 회귀 검사와 남은 위험을 기록하세요.',
    '사용자는 아래 요청의 전체 작업 흐름을 허용했습니다. 이 호출에서는 지정된 현재 단계 하나만 수행하세요.',
    '저장소 AGENTS.md를 먼저 읽고 다른 세션의 변경과 배포 담당 범위를 존중하세요. 배포·게시·외부 전송은 별도 명시적 요청 없이는 하지 마세요.',
    '일반적인 선택은 판단해서 진행하고, 실제로 진행을 막는 질문만 outcome=question으로 반환하세요.',
    'wax init/join/work 등 대화형 스킬을 다시 시작하지 마세요. 배정과 단계 저장은 이 실행기가 처리합니다.',
    '상태 JSON, 요청 기록을 직접 수정하거나 단계를 완료/이동하지 마세요. 결과 document는 실행기가 저장합니다.',
    `현재 작업: ${feature.id}, 현재 단계: ${feature.phase}. CLI 실행 파일: ${JSON.stringify(CLI)}. 프로젝트: ${JSON.stringify(request.root)}.`,
    '구현·검토 단계에서는 관련 검사를 실제로 실행하고 CLI test <id> --revision <현재 revision> -- <실행파일> <인수>로 근거를 저장하세요.',
    '테스트 기록으로 revision이 바뀌면 최신 status를 읽으세요. 통과한 현재 단계·주기의 proof ID를 proofIds에 반환하세요.',
    '구현·검토는 통과한 테스트 근거 없이는 완료되지 않습니다. 검사 환경이 없으면 막힌 이유를 보고하세요. 실패를 통과로 꾸미지 마세요.',
    '보고에는 실제 변경과 검증, 다음 할 일을 간결한 한국어로 적으세요. document는 해당 단계의 구체적인 Markdown 문서입니다.',
    '반환 형식: outcome(complete/question/blocked), report, document, evidence, proofIds. 질문/막힘일 때는 사용자에게 필요한 질문과 이유를 report에 적으세요.',
    `사용자 요청과 추가 지시(최신 지시를 반영):\n${JSON.stringify(request.messages.filter((m) => m.role === 'user').map((m) => m.text))}`,
    buildPrompt(feature),
  ].join('\n\n');
}

export function createRequestRunner({ root, execute = runAgentSession, notify = () => {}, phaseTimeoutMs = 30 * 60_000 } = {}) {
  const instance = randomUUID(), owner = { pid: process.pid, instance };
  const jobs = new Map(), controllers = new Map();
  let stopped = false;
  const identities = new Map();
  const changed = () => notify('requests', {});
  const patch = async (id, change) => { const result = await mutate(root, id, change); changed(); return result; };

  async function list() {
    const dir = await chatDir(root, 'requests');
    if (!dir) return [];
    const ids = (await readdir(dir)).filter((f) => /^request-[a-f0-9-]{36}\.json$/.test(f)).map((f) => f.slice(0, -5));
    return (await Promise.all(ids.map((id) => read(root, id)))).map(publicRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function perform(id) {
    const dir = await chatDir(root, 'requests', { create: true });
    await withLock(join(dir, 'runner.lock'), async () => {
      if (stopped) return;
      let r = await read(root, id);
      if (r.status !== 'queued' || r.owner.instance !== instance) return;
      const controller = new AbortController(); controllers.set(id, controller);
      let agent, heartbeat, timeout;
      try {
        const identity = identities.get(r.tool);
        agent = await joinSession(root, { author: identity?.author ?? (r.tool === 'codex' ? 'wax-pm' : `wax-${r.tool}`), session: identity?.session, kind: r.tool, state: 'working', feature: id, note: '요청을 기획하고 진행합니다' });
        identities.set(r.tool, agent);
        let feature;
        try { feature = await getFeature(root, id); }
        catch (error) { if (error.status !== 404) throw error; feature = await createFeature(root, { id, title: r.title, description: r.messages[0].text }); }
        if (feature.archivedAt) throw new WaxError('보관된 작업입니다. 상세 기록에서 복원한 뒤 이어서 진행하세요.');
        if (r.mode === 'project' && r.workflow?.approved && !r.workflow.started) {
          let stale = false;
          r = await patch(id, async (current) => {
            if (!ACTIVE.has(current.status) || !current.workflow?.approved || current.workflow.started || controller.signal.aborted) return;
            const workflow = current.workflow, tracked = Number.isInteger(workflow.historyLength);
            const moves = tracked ? feature.history.slice(workflow.historyLength).filter((event) => event.action !== 'attach-evidence') : [];
            const same = feature.iteration === workflow.iteration && feature.artifacts.plan === workflow.document;
            if (same && feature.phase === 'plan' && (feature.revision === workflow.revision || tracked && !moves.length)) {
              feature = await updateFeature(root, id, 'complete', { phase: 'plan', evidence: workflow.evidence, proofIds: workflow.proofIds, revision: feature.revision });
            } else if (!(same && tracked && feature.phase === 'design' && moves.length === 1 && moves[0].action === 'complete' && moves[0].phase === 'plan' && feature.completed.plan?.evidence === workflow.evidence)) {
              current.workflow = null; stale = true; return;
            }
            workflow.started = true;
          });
          if (stale) throw feature.phase === 'plan' ? new WaxError('워크플로우가 변경되었습니다. 이어서 진행하면 최신 내용으로 워크플로우를 다시 작성합니다.') : replanned();
          if (!ACTIVE.has(r.status) || controller.signal.aborted) return;
        }
        if (r.mode === 'project' && feature.phase !== 'plan' && !r.workflow?.started) throw replanned();
        if (feature.phase === 'done') feature = await updateFeature(root, id, 'iterate', { revision: feature.revision, reason: r.messages.filter((m) => m.role === 'user').at(-1).text.slice(0, 5000) });
        let polling = false, lastPresence = 0;
        heartbeat = setInterval(async () => {
          if (polling) return; polling = true;
          try {
            const current = await read(root, id);
            if (!ACTIVE.has(current.status) || current.owner.instance !== instance) controller.abort();
            if (!controller.signal.aborted && Date.now() - lastPresence > 30_000) {
              lastPresence = Date.now();
              await updatePresence(root, { author: agent.author, session: agent.session, kind: r.tool, state: 'working', feature: id, note: `${phaseLabel(current, current.phase)} 진행 중` });
            }
          } catch { controller.abort(); }
          finally { polling = false; }
        }, 1000);
        heartbeat.unref();
        for (let step = 0; step < PHASES.length; step++) {
          if (stopped || controller.signal.aborted) break;
          r = await patch(id, (current) => {
            if (!ACTIVE.has(current.status)) { controller.abort(); return; }
            current.status = 'running'; current.phase = feature.phase; current.agent = agent.author; current.detail = `${phaseLabel(current, feature.phase)} 진행 중`;
          });
          if (controller.signal.aborted) break;
          const phase = feature.phase, inputCount = r.messages.filter((m) => m.role === 'user').length;
          timeout = setTimeout(() => controller.abort(), phaseTimeoutMs);
          const result = await execute(root, { tool: r.tool, prompt: requestPrompt({ ...r, root }, feature), thread: r.thread,
            outputSchema: RESULT_SCHEMA, signal: controller.signal, output() {}, log() {} });
          clearTimeout(timeout);
          if (controller.signal.aborted) break;
          let reply;
          try { reply = JSON.parse(result.message); } catch { throw new WaxError('AI 보고 형식을 읽지 못했습니다. 이어서 진행으로 다시 연결하세요.'); }
          if (!['complete', 'question', 'blocked'].includes(reply?.outcome) || typeof reply.report !== 'string' || !reply.report.trim() || reply.report.length > 16000) throw new WaxError('AI 보고 내용이 올바르지 않습니다.');
          r = await patch(id, (current) => {
            current.thread = result.threadId;
            addMessage(current, 'assistant', reply.report, { phase, outcome: reply.outcome });
          });
          if (!ACTIVE.has(r.status)) break;
          if (reply.outcome !== 'complete') {
            await patch(id, (current) => { current.status = reply.outcome === 'question' ? 'question' : 'blocked'; current.detail = reply.report; });
            break;
          }
          const latest = await getFeature(root, id);
          if (latest.phase !== phase || latest.iteration !== feature.iteration || latest.archivedAt || latest.history.slice(feature.history.length).some((event) => event.action !== 'attach-evidence')) throw new WaxError('다른 세션이 작업을 변경했습니다. 기록을 확인한 뒤 이어서 진행하세요.');
          if (['implement', 'review'].includes(phase) && !reply.proofIds?.some((proofId) => latest.proofs?.some((p) => p.id === proofId && p.kind === 'test' && p.phase === phase && p.iteration === latest.iteration && p.exitCode === 0 && !p.timedOut))) throw new WaxError('실제 통과한 테스트 근거가 없어 완료하지 않았습니다. 검사 결과를 확인해 주세요.');
          if (typeof reply.document !== 'string' || !reply.document.trim() || reply.document.length > 100000 || typeof reply.evidence !== 'string' || !reply.evidence.trim() || reply.evidence.length > 5000 || !Array.isArray(reply.proofIds)) throw new WaxError('단계 문서 또는 완료 근거가 빠져 있어 멈췄습니다.');
          if (controller.signal.aborted || !ACTIVE.has((await read(root, id)).status)) break;
          const docs = await safeDir(root, ['docs', 'wax', id], { create: true });
          await writeFile(await checkFile(join(docs, `${phase}.md`)), `${reply.document}\n`, { mode: 0o600 });
          feature = await updateFeature(root, id, 'save', { phase, content: reply.document, revision: latest.revision });
          if (r.mode === 'project' && phase === 'plan') {
            await patch(id, (current) => {
              if (!ACTIVE.has(current.status)) return;
              const hasNewInput = current.messages.filter((m) => m.role === 'user').length > inputCount;
              current.phase = 'plan';
              current.status = hasNewInput ? 'queued' : 'workflow';
              current.workflow = hasNewInput ? null : { document: feature.artifacts.plan, evidence: reply.evidence, proofIds: reply.proofIds, revision: feature.revision, iteration: feature.iteration, historyLength: feature.history.length, approved: false };
              current.detail = hasNewInput ? '추가 요청을 반영해 워크플로우를 다시 작성합니다.' : '워크플로우를 만들었습니다. 내용을 확인한 뒤 이 워크플로우로 시작을 눌러주세요.';
            });
            break;
          }
          feature = await updateFeature(root, id, 'complete', { phase, evidence: reply.evidence, proofIds: reply.proofIds, verdict: phase === 'review' ? 'pass' : undefined, revision: feature.revision });
          r = await patch(id, (current) => {
            current.phase = feature.phase;
            if (!ACTIVE.has(current.status)) return;
            const hasNewInput = current.messages.filter((m) => m.role === 'user').length > inputCount;
            current.status = feature.phase === 'done' ? (hasNewInput ? 'queued' : 'completed') : 'running';
            current.detail = hasNewInput && feature.phase === 'done' ? '추가 요청을 이어서 반영합니다.' : feature.phase === 'done' ? '요청한 작업을 마쳤습니다.' : `${phaseLabel(current, phase)} 완료 · ${phaseLabel(current, feature.phase)} 준비 중`;
          });
          if (!ACTIVE.has(r.status) || feature.phase === 'done') break;
        }
      } catch (error) {
        await patch(id, (current) => {
          if (!ACTIVE.has(current.status)) return;
          current.status = controller.signal.aborted ? 'paused' : 'blocked';
          if (error.newRequest && !controller.signal.aborted) current.newRequest = true;
          current.detail = controller.signal.aborted ? '실행이 중단되었거나 제한 시간을 초과했습니다. 저장된 단계부터 이어갈 수 있습니다.' : String(error.message).slice(0, 2000);
          addMessage(current, 'assistant', current.detail, { outcome: 'blocked' });
        });
      } finally {
        clearInterval(heartbeat); clearTimeout(timeout); controllers.delete(id);
        if (controller.signal.aborted) await patch(id, (current) => { if (ACTIVE.has(current.status) || current.status === 'paused') { current.status = 'paused'; current.detail = '진행을 멈췄습니다. 저장된 단계부터 이어갈 수 있습니다.'; } });
        if (agent) await updatePresence(root, { author: agent.author, session: agent.session, kind: r.tool, state: 'idle', feature: id, note: '요청 처리 종료' }).catch(() => {});
      }
    }, { timeoutMs: 1000 });
  }
  function schedule(id) {
    if (stopped || jobs.has(id)) return;
    const previous = [...jobs.values()].at(-1) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => perform(id)).catch(async (error) => {
      await patch(id, (r) => { if (ACTIVE.has(r.status)) { r.status = 'blocked'; r.detail = error.message; } });
    }).finally(async () => {
      jobs.delete(id);
      const r = await read(root, id);
      if (r.status === 'queued' && r.owner.instance === instance) schedule(id);
    });
    jobs.set(id, job);
    job.catch(() => {});
  }
  async function submit({ id = `request-${randomUUID()}`, body, author, tool = 'codex', mode = 'sm' }) {
    if (stopped) throw new WaxError('실행 연결이 종료되었습니다. 새로고침하세요.', 409);
    requestId(id); body = v.body(body, 8000, '요청'); author = v.author(author); tool = agentTool(tool).id; mode = modeOf(mode);
    const file = await requestFile(root, id, true);
    const r = await withLock(`${file}.lock`, async () => {
      try {
        const existing = await read(root, id);
        if (existing.author !== author || existing.messages[0].text !== body || existing.tool !== tool || existing.mode !== mode) throw new WaxError('같은 요청 ID에 다른 내용, 실행 도구 또는 진행 모드가 있습니다.', 409);
        return existing;
      } catch (error) { if (error.status !== 404) throw error; }
      const now = new Date().toISOString();
      const created = { schema: 1, id, author, tool, mode, title: body.replace(/\s+/g, ' ').slice(0, 100), phase: 'plan', status: 'queued', detail: mode === 'project' ? '프로젝트 워크플로우를 준비하고 있습니다.' : '유지보수 요청을 접수하고 있습니다.', owner, createdAt: now, updatedAt: now, messages: [] };
      addMessage(created, 'user', body);
      await writeJsonAtomic(file, created);
      return created;
    });
    if (r.status === 'queued' && r.owner.instance === instance) schedule(id);
    changed(); return publicRecord(r);
  }
  async function reply(id, { body, messageId = randomUUID(), resume = false, approveWorkflow = false, workflowRevision } = {}) {
    if (stopped) throw new WaxError('실행 연결이 종료되었습니다.', 409);
    if (body !== undefined) body = v.body(body, 8000, '메시지');
    if (typeof messageId !== 'string' || !/^[a-f0-9-]{36}$/.test(messageId)) throw new WaxError('잘못된 메시지 ID입니다.');
    if (!body && !resume && !approveWorkflow) throw new WaxError('메시지 또는 이어서 진행 요청이 필요합니다.');
    if (approveWorkflow && (body || resume)) throw new WaxError('워크플로우 시작과 수정 요청은 따로 보내주세요.');
    const r = await patch(id, (current) => {
      if (approveWorkflow) {
        if (current.mode !== 'project' || !current.workflow || current.workflow.revision !== workflowRevision) throw new WaxError('시작할 워크플로우가 변경되었습니다. 새로고침해 최신 내용을 확인하세요.', 409);
        if (current.workflow.approved) return;
        if (current.status !== 'workflow') throw new WaxError('워크플로우를 먼저 작성하고 확인해 주세요.', 409);
        if (jobs.has(id)) throw new WaxError('현재 실행을 마무리하고 있습니다. 잠시 후 다시 시작해 주세요.', 409);
        current.workflow.approved = true;
        current.status = 'queued'; current.owner = owner; current.detail = '확인한 워크플로우로 프로젝트를 시작합니다.';
        return;
      }
      if (current.newRequest) throw new WaxError('이 요청은 이어서 진행할 수 없습니다. 새 프로젝트 요청을 만들어 주세요.', 409);
      if (!body && current.status === 'workflow') throw new WaxError('워크플로우를 확인하고 이 워크플로우로 시작을 눌러주세요.', 409);
      const duplicate = current.messages.find((m) => m.id === messageId);
      if (duplicate) {
        if (duplicate.role !== 'user' || duplicate.text !== body) throw new WaxError('같은 메시지 ID에 다른 내용이 있습니다.', 409);
        return;
      }
      if (!ACTIVE.has(current.status) && jobs.has(id)) throw new WaxError('현재 실행을 마무리하고 있습니다. 잠시 후 다시 보내주세요.', 409);
      if (body) {
        if (current.messages.filter((m) => m.role === 'user').reduce((sum, m) => sum + m.text.length, body.length) > 40000) throw new WaxError('대화가 길어졌습니다. 새 요청으로 이어주세요.');
        addMessage(current, 'user', body, { id: messageId });
        if (current.phase === 'plan' && !current.workflow?.started) current.workflow = null;
      }
      if (!ACTIVE.has(current.status) || interrupted(current)) {
        if (current.status === 'completed' && !body) throw new WaxError('완료된 작업입니다. 추가 요청을 입력하세요.');
        current.status = 'queued'; current.owner = owner; current.detail = '추가 내용을 반영해 이어서 진행합니다.';
      } else current.detail = body ? '추가 요청을 받았습니다. 현재 단계가 끝나면 반영합니다.' : current.detail;
    });
    if (r.status === 'queued' && r.owner.instance === instance) schedule(id);
    return publicRecord(r);
  }
  async function stop(id) {
    const r = await patch(id, (current) => {
      if (!ACTIVE.has(current.status)) return;
      current.status = 'paused'; current.detail = '중지를 요청했습니다. 진행 중인 실행을 종료합니다.';
    });
    controllers.get(id)?.abort();
    return publicRecord(r);
  }
  async function close() {
    stopped = true;
    for (const id of jobs.keys()) await stop(id);
    await Promise.allSettled([...jobs.values()]);
  }
  return { list, submit, reply, stop, close, settled: () => Promise.allSettled([...jobs.values()]) };
}
