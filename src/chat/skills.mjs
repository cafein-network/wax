import { listFeatures } from '../workflow.mjs';
import { readRecords } from './store.mjs';
import { listPresence } from './presence.mjs';
import { readTaskRecords } from './team.mjs';
import { chatFiles, listDailyReports } from './daily.mjs';

export const AXES = [
  { key: 'plan', label: '기획·설계', k: 3, value: (c) => c.tasks.plan + c.tasks.design },
  { key: 'build', label: '구현', k: 3, value: (c) => c.tasks.implement + c.commits * 0.5, neg: (c) => c.tasksBlocked },
  { key: 'review', label: '검토', k: 3, value: (c) => c.tasks.review + c.bugsFound * 0.5 + c.opinions * 0.5 },
  { key: 'test', label: '테스트', k: 5, value: (c) => c.testsPassed, neg: (c) => c.testsFailed * 2 },
  { key: 'talk', label: '소통', k: 5, value: (c) => c.answers + c.decisions + c.questions * 0.5 },
  { key: 'report', label: '보고', k: 3, value: (c) => c.tasks.report + c.dailyReports + c.boardReports },
];

export const BADGES = [
  { id: 'first-task', label: '첫 업무', icon: '🎯', desc: '배정받은 업무를 처음 완료', goal: 1, value: (c) => c.tasksDone },
  { id: 'task-10', label: '업무 달인', icon: '🏅', desc: '업무 10건 완료', goal: 10, value: (c) => c.tasksDone },
  { id: 'planner', label: '설계자', icon: '📐', desc: '기획·설계 업무 3건 완료', goal: 3, value: (c) => c.tasks.plan + c.tasks.design },
  { id: 'builder', label: '구현 장인', icon: '🔨', desc: '구현 업무 5건 완료', goal: 5, value: (c) => c.tasks.implement },
  { id: 'reviewer', label: '꼼꼼한 검토자', icon: '🔍', desc: '검토 업무 3건 완료', goal: 3, value: (c) => c.tasks.review },
  { id: 'green', label: '초록불', icon: '✅', desc: '맡은 업무 중 테스트 10번 통과', goal: 10, value: (c) => c.testsPassed },
  { id: 'bug-hunter', label: '버그 헌터', icon: '🐞', desc: '검토 중 실패하는 테스트로 버그 3건 발견', goal: 3, value: (c) => c.bugsFound },
  { id: 'clean', label: '클린 코더', icon: '🧼', desc: '내 작업 테스트 10번 이상, 실패율 10% 이하', goal: 10, value: (c) => (bugRate(c) ?? 1) <= 0.1 ? c.testsPassed + c.testsFailed : 0 },
  { id: 'committer', label: '커밋 연결', icon: '🔗', desc: '맡은 업무 중 커밋 5건 연결', goal: 5, value: (c) => c.commits },
  { id: 'answerer', label: '해결사', icon: '💡', desc: '질문에 5번 답변', goal: 5, value: (c) => c.answers },
  { id: 'decider', label: '결단력', icon: '⚖️', desc: '결정 3건 기록', goal: 3, value: (c) => c.decisions },
  { id: 'reporter', label: '성실한 보고', icon: '📝', desc: '일일·화이트보드 보고서 5건', goal: 5, value: (c) => c.dailyReports + c.boardReports },
  { id: 'pm', label: '팀장', icon: '👑', desc: 'PM으로 업무 5건 배정', goal: 5, value: (c) => c.assigned },
  { id: 'steady', label: '꾸준함', icon: '📅', desc: '5일 이상 활동', goal: 5, value: (c) => c.days.size },
  { id: 'all-rounder', label: '올라운더', icon: '🌟', desc: '여섯 능력치가 모두 우수(70점) 이상', goal: 6, value: (c, axes) => axes.filter((axis) => axis.score >= 70).length },
];

export const bugRate = (c) => (c.testsPassed + c.testsFailed ? c.testsFailed / (c.testsPassed + c.testsFailed) : null);

const PHASE_KEYS = ['plan', 'design', 'implement', 'review', 'report'];

export const proofOwners = (proof, feature, workingOn) => (proof.author ? [proof.author] : [...new Set(workingOn(feature, proof.phase, proof.at))]);

export function taskWindows(records) {
  const tasks = new Map();
  for (const record of records) {
    if (record.record === 'task') tasks.set(record.id, { ...record, acceptedAt: null, endedAt: null });
    else if (record.record === 'status' && tasks.has(record.task)) {
      const task = tasks.get(record.task);
      if (record.status === 'accepted' && !task.acceptedAt) task.acceptedAt = record.at;
      if ((record.status === 'done' || record.status === 'cancelled') && !task.endedAt) task.endedAt = record.at;
    }
  }
  return (feature, phase, at) => [...tasks.values()]
    .filter((t) => t.feature === feature && (t.phase === phase || t.phase === 'any') && t.acceptedAt && t.acceptedAt <= at && (!t.endedAt || at <= t.endedAt))
    .map((t) => t.to);
}
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function blank() {
  return { kind: null, tasks: Object.fromEntries([...PHASE_KEYS, 'any'].map((p) => [p, 0])), tasksDone: 0, tasksBlocked: 0, assigned: 0, testsPassed: 0, testsFailed: 0, bugsFound: 0, reviewTests: 0, commits: 0, workMs: 0, answers: 0, decisions: 0, questions: 0, opinions: 0, messages: 0, dailyReports: 0, boardReports: 0, days: new Set(), firstAt: null, lastAt: null };
}

export const BASELINE = 50;

export function grade(score) {
  return score >= 85 ? '탁월' : score >= 70 ? '우수' : score >= 45 ? '보통' : score >= 30 ? '미흡' : '부족';
}

export function scoreAxes(counts) {
  return AXES.map(({ key, label, k, value, neg }) => {
    const raw = value(counts) || 0, bad = (neg && neg(counts)) || 0;
    const up = (100 - BASELINE) * (1 - Math.exp(-raw / k)), down = BASELINE * (1 - Math.exp(-bad / k));
    const score = Math.max(0, Math.min(100, Math.round(BASELINE + up - down)));
    return { key, label, value: Math.round(raw * 10) / 10, score, grade: grade(score) };
  });
}

export async function collectCounts(root) {
  const people = new Map();
  const of = (author, kind, at) => {
    if (!author) return null;
    if (!people.has(author)) people.set(author, blank());
    const c = people.get(author);
    if (kind) c.kind = kind;
    if (at) { c.days.add(localDay(at)); if (!c.lastAt || at > c.lastAt) c.lastAt = at; if (!c.firstAt || at < c.firstAt) c.firstAt = at; }
    return c;
  };

  const records = await readTaskRecords(root);
  const tasks = new Map();
  for (const record of records) {
    if (record.record === 'task') {
      tasks.set(record.id, { ...record, acceptedAt: null, endedAt: null });
      of(record.by, record.kind, record.at).assigned++;
    } else if (record.record === 'status' && tasks.has(record.task)) {
      const task = tasks.get(record.task);
      if (record.status === 'accepted' && !task.acceptedAt) task.acceptedAt = record.at;
      if ((record.status === 'done' || record.status === 'cancelled') && !task.endedAt) task.endedAt = record.at;
      if (record.status === 'done') {
        const c = of(task.to, null, record.at);
        c.tasksDone++;
        if (task.acceptedAt) c.workMs += Math.max(0, Date.parse(record.at) - Date.parse(task.acceptedAt));
        c.tasks[task.phase in c.tasks ? task.phase : 'any']++;
      }
      if (record.status === 'blocked') of(task.to, null, record.at).tasksBlocked++;
    }
  }
  const workingOn = taskWindows(records);

  for (const feature of await listFeatures(root)) {
    for (const proof of feature.proofs ?? []) {
      for (const author of proofOwners(proof, feature.id, workingOn)) {
        const c = of(author, null, proof.at);
        const passed = proof.exitCode === 0 && !proof.timedOut;
        if (proof.kind === 'git') c.commits++;
        else if (proof.phase === 'review') { c.reviewTests++; if (!passed) c.bugsFound++; }
        else if (passed) c.testsPassed++;
        else c.testsFailed++;
      }
    }
  }

  const tally = (c, type) => {
    if (type === 'answer') c.answers++;
    else if (type === 'decision') c.decisions++;
    else if (type === 'question') c.questions++;
    else if (type === 'opinion') c.opinions++;
  };
  for (const { file } of await chatFiles(root, 'channels')) {
    for (const message of (await readRecords(file)).records) {
      const c = of(message.author, message.kind, message.at);
      if (!c) continue;
      c.messages++;
      tally(c, message.type);
    }
  }
  for (const { file } of await chatFiles(root, 'board')) {
    for (const record of (await readRecords(file)).records) {
      const c = of(record.author, record.kind, record.at);
      if (!c) continue;
      if (record.record === 'note') tally(c, record.type);
      else if (record.record === 'report') c.boardReports++;
    }
  }
  for (const report of await listDailyReports(root)) of(report.author, report.kind, report.at).dailyReports++;
  for (const agent of await listPresence(root)) {
    const c = of(agent.author, agent.kind, null);
    if (!c.firstAt && agent.stateAt) c.firstAt = agent.stateAt;
  }
  return people;
}

export function summarize(axes, metrics) {
  if (axes.every((axis) => axis.score === BASELINE)) return '아직 기록이 적어 모든 능력치가 보통(50)입니다. 업무를 완료하고 테스트·보고를 남기면 달라집니다.';
  const sorted = [...axes].sort((a, b) => b.score - a.score);
  const strong = sorted.filter((axis) => axis.score > BASELINE && axis.score >= sorted[0].score - 10).map((axis) => axis.label);
  const weak = sorted.filter((axis) => axis.score < 45).map((axis) => axis.label);
  const parts = [strong.length ? `강점 ${strong.join('·')}` : '두드러진 강점 없음'];
  if (weak.length) parts.push(`보완 ${weak.join('·')}`);
  if (metrics.bugRate !== null) parts.push(`버그 발생률 ${Math.round(metrics.bugRate * 100)}%`);
  return parts.join(' / ');
}

export async function listProfiles(root) {
  const profiles = [];
  for (const [author, c] of await collectCounts(root)) {
    const axes = scoreAxes(c);
    const xp = Math.round(AXES.reduce((sum, axis) => sum + axis.value(c), 0) * 10);
    profiles.push({
      author, kind: c.kind ?? 'other', level: 1 + Math.floor(Math.sqrt(xp / 10)), xp, axes,
      badges: BADGES.map(({ id, label, icon, desc, goal, value }) => { const progress = value(c, axes); return { id, label, icon, desc, goal, progress: Math.min(progress, goal), earned: progress >= goal }; }),
      firstAt: c.firstAt,
      metrics: { bugRate: bugRate(c), bugsFound: c.bugsFound, commits: c.commits, workMs: c.workMs, tasksDone: c.tasksDone, tests: c.testsPassed + c.testsFailed },
      counts: { tasksDone: c.tasksDone, tasksBlocked: c.tasksBlocked, assigned: c.assigned, testsPassed: c.testsPassed, testsFailed: c.testsFailed, reviewTests: c.reviewTests, bugsFound: c.bugsFound, commits: c.commits, workMs: c.workMs, answers: c.answers, decisions: c.decisions, questions: c.questions, opinions: c.opinions, messages: c.messages, dailyReports: c.dailyReports, boardReports: c.boardReports, days: c.days.size },
      lastAt: c.lastAt,
    });
    profiles.at(-1).summary = summarize(axes, profiles.at(-1).metrics);
  }
  return profiles.sort((a, b) => b.xp - a.xp || a.author.localeCompare(b.author));
}
