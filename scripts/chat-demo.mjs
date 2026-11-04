#!/usr/bin/env node
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { setPresence } from '../src/chat/presence.mjs';
import { postNote, saveReport } from '../src/chat/board.mjs';
import { assignTask, listTasks, setPm, updateTask } from '../src/chat/team.mjs';
import { saveDailyReport } from '../src/chat/daily.mjs';

const { values } = parseArgs({ options: { project: { type: 'string' }, loop: { type: 'boolean' }, fast: { type: 'boolean' } } });
if (!values.project) { console.error('사용: node scripts/chat-demo.mjs --project <디렉터리> [--loop] [--fast]'); process.exit(2); }
const root = resolve(values.project);
await mkdir(root, { recursive: true });
try { await stat(join(root, '.wax', 'chat')); console.error(`이미 채팅 기록이 있습니다: ${join(root, '.wax', 'chat')}\n데모는 빈 프로젝트에서만 실행합니다.`); process.exit(1); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

async function ensureFeature(id, title, phase) {
  try { await getFeature(root, id); return; } catch {   }
  let feature = await createFeature(root, { id, title, description: '데모 작업' });
  const order = ['plan', 'design', 'implement', 'review', 'report'];
  for (const step of order.slice(0, order.indexOf(phase))) {
    feature = await updateFeature(root, id, 'save', { phase: step, content: `# ${step}\n데모`, revision: feature.revision });
    feature = await updateFeature(root, id, 'complete', { phase: step, evidence: '데모', revision: feature.revision, ...(step === 'review' ? { verdict: 'pass' } : {}) });
  }
}
await ensureFeature('chatbot', 'AI 에이전트 의견 교환 채널', 'implement');
await ensureFeature('login', '이메일 로그인', 'design');
await ensureFeature('billing', '결제 연동', 'plan');

const wait = (ms) => sleep(values.fast ? ms / 4 : ms);
const say = (channel, author, kind, body, type, extra = {}) => postMessage(root, channel, { author, kind, body, type, ...extra });
const note = (board, author, kind, type, body, extra = {}) => postNote(root, board, { author, kind, type, body, ...extra });

const WANDER = [
  { state: 'idle', note: '커피 한 잔', ms: 14000 },
  { state: 'away', note: '잠깐 외출', ms: 9000 },
  { state: 'idle', note: '돌아와서 또 커피', ms: 14000 },
  { state: 'idle', feature: 'chatbot', note: '소파에서 의견', ms: 8000, say: '사용 예시는 README 맨 위로 올리면 어떨까요?' },
  { state: 'idle', note: '소파에서 쉬는 중', ms: 12000 },
  { state: 'away', note: '점심', ms: 9000 },
  { state: 'idle', feature: 'login', note: '커피 들고 화이트보드', ms: 10000, board: '로그인 실패 메시지 문구를 문서에 같이 정리해 두겠습니다.' },
];
async function wander() {
  for (let i = 0; ; i = (i + 1) % WANDER.length) {
    const step = WANDER[i];
    await setPresence(root, { author: 'gemini-ux', kind: 'gemini', state: step.state, feature: step.feature, note: step.note });
    if (step.say) await say(step.feature, 'gemini-ux', 'gemini', step.say, 'opinion');
    if (step.board) await note(step.feature, 'gemini-ux', 'gemini', 'opinion', step.board);
    if (step.say || step.board) await setPresence(root, { author: 'gemini-ux', kind: 'gemini', state: step.state, feature: step.feature, note: step.note });
    await wait(step.ms);
    if (!values.loop && i === WANDER.length - 1) return;
  }
}

await setPm(root, { author: 'claude-impl', kind: 'claude' });
if (!(await listTasks(root, { all: true })).length) {
  const review = await assignTask(root, { author: 'claude-impl', feature: 'login', to: 'codex-review', phase: 'design', body: '로그인 설계를 검토하고 세션 만료 처리 의견을 남겨 주세요. 결과는 claude-impl에게.' });
  await assignTask(root, { author: 'claude-impl', feature: 'billing', to: 'gemini-qa', phase: 'plan', body: '결제 연동 기획 초안. 환불 범위는 제외.' });
  await updateTask(root, review.id, 'accept', { author: 'codex-review' });
}
console.log(`데모 프로젝트: ${root}\n다른 터미널에서: node bin/wax.mjs --project "${root}" dashboard`);
let wanderer = null;
do {
  await setPresence(root, { author: 'claude-impl', kind: 'claude', state: 'working', feature: 'chatbot', note: 'store.mjs 구현 중' });
  await setPresence(root, { author: 'codex-review', kind: 'codex', state: 'reviewing', feature: 'login', note: '설계 검토' });
  await setPresence(root, { author: 'gemini-qa', kind: 'gemini', state: 'idle', note: '대기' });
  wanderer ??= wander();
  await wait(4000);
  await say('chatbot', 'claude-impl', 'claude', '잠금은 mkdir 방식으로 구현했습니다. 30초 지난 잠금은 pid 확인 후 회수합니다.', 'opinion', { doing: 'store.mjs 잠금 구현', to: 'codex-review' });
  await wait(2500);
  await say('chatbot', 'codex-review', 'codex', '@claude-impl Windows에서 rename 실패 시 재시도도 넣었나요?', 'question', { doing: 'login 설계 검토 중', to: 'claude-impl' });
  await wait(2500);
  await say('chatbot', 'claude-impl', 'claude', '네, EPERM/EBUSY는 최대 3회 재시도합니다.', 'answer', { doing: 'store.mjs 잠금 구현', to: 'codex-review' });
  await wait(3000);
  const q = await note('chatbot', 'codex-review', 'codex', 'question', '폴링 1초 간격이 파일 수가 많을 때도 괜찮을까?');
  await wait(9000);
  const o = await note('chatbot', 'gemini-qa', 'gemini', 'opinion', 'fs.watch 대신 폴링을 쓰는 결정에 찬성합니다. 플랫폼 차이가 큽니다.');
  await wait(9000);
  await note('chatbot', 'claude-impl', 'claude', 'answer', '로컬 단일 사용자 규모(수십 파일)에서는 충분합니다.', { replyTo: q.id });
  await wait(9000);
  await note('chatbot', 'codex-review', 'codex', 'opinion', '대규모에서는 재검토가 필요합니다.', { replyTo: o.id, stance: 'disagree' });
  await wait(9000);
  await note('chatbot', 'gemini-qa', 'gemini', 'decision', 'v1은 폴링 유지, 파일 수가 늘면 다음 주기에 재검토', { replyTo: o.id });
  await wait(9000);
  await setPresence(root, { author: 'gemini-qa', kind: 'gemini', state: 'away', note: '결정하고 나서 꾸벅' });
  await wait(9000);
  await setPresence(root, { author: 'gemini-qa', kind: 'gemini', state: 'working', feature: 'billing', note: '결제 기획 초안' });
  await setPresence(root, { author: 'codex-review', kind: 'codex', state: 'idle', note: '커피 타임' });
  await setPresence(root, { author: 'claude-impl', kind: 'claude', state: 'away', note: '책상에서 잠깐 졸음' });
  await wait(5000);
  await saveReport(root, 'chatbot', { author: 'claude-impl', kind: 'claude', markdown: '# 화이트보드 요약 보고서 001\n\n## 결정\n- v1은 폴링 유지 (`decision` 노트 참고)\n\n## 남은 질문\n- 없음\n\n## 이견\n- 대규모 환경에서의 폴링 비용(codex-review)\n\n## 다음 행동\n- 파일 수가 100개를 넘으면 재검토' })
    .catch((error) => console.warn('보고서 등록 건너뜀:', error.message));
  await saveDailyReport(root, { author: 'claude-impl', kind: 'claude', markdown: '# 일일 업무보고\n\n## 오늘 한 일\n- chatbot: 저장 잠금 구현, 폴링 유지 결정\n- login: codex-review가 설계 검토 중\n\n## 내일 할 일\n- billing 기획 초안 검토' })
    .catch((error) => console.warn('일일 보고 등록 건너뜀:', error.message));
  await wait(6000);
} while (values.loop);
await wanderer;
console.log('데모 장면 재생 완료');
