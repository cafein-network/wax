import { TOOLS, nextCommand } from '../commands.mjs';
import { CLI_NEWS, newerThan } from './cli-news.mjs';


const SELF = {
  typing: ['이 함수 이름 뭐로 하지…', '테스트 한 번 더 돌려볼까', '{feature} 조금만 더 다듬자', '커밋 메시지 고민되네', '로그를 좀 찍어 봐야겠다', '이 부분 깔끔하게 정리하고 싶다', '집중, 집중!'],
  reading: ['음, 이 조건은 왜 있지?', '{feature} 문서 다시 읽는 중', '여기 엣지 케이스 있겠는데', '테스트가 이걸 잡아줄까?', '천천히 한 줄씩 보자'],
  talking: ['그 방향 좋네요', '일정은 괜찮을까요?', '범위를 조금 줄여 볼까요', '질문 하나만요!', '정리하면 이런 거죠?'],
  coffee: ['커피 수혈 중 ☕', '잠깐 머리 식히는 중', '오늘 점심 뭐 먹지', '이거 마시고 다시 달린다', '창밖 날씨 좋네'],
  posting: ['보드에 붙여 둘게요', '이건 다들 봐야 해서요', '메모 하나 추가!'],
  chat: ['옥상 바람 시원하다', '여기 오면 머리가 맑아져요', '꽃이 많이 폈네', '잠깐 쉬었다 가요', '하늘 좀 봐요, 날씨 좋다'],
};
const PEER = {
  typing: ['{peer}, 잠깐 이거 봐 줄 수 있어요?', '{peer} 쪽은 잘 돼 가요?', '{peer}, 화이팅!'],
  reading: ['{peer}, 이 부분 의도가 뭐였죠?', '{peer}, 나중에 같이 봐요'],
  talking: ['{peer} 생각은 어때요?', '{peer} 말에 동의해요'],
  coffee: ['{peer}도 커피 한 잔?', '{peer}, 잠깐 쉬었다 해요'],
  posting: ['{peer}, 보드 한번 봐 주세요'],
  chat: ['{peer}, 요즘 어때요?', '{peer}도 잠깐 쉬어요', '{peer}, 아까 그 얘기 마저 해요', '{peer}, 커피 한 잔 더 할래요?'],
};

export const CHATTER_MS = 4500;

export const SHORT_TEXT = 15;
export function bubbleMs(text, ms = 0) {
  const length = String(text ?? '').replace(/\s+/g, ' ').trim().length;
  if (length <= SHORT_TEXT) return 3000;
  return Math.min(10_000, Math.max(5000, ms, length * 160));
}
export const CHATTER_MIN_GAP_MS = 60_000;
export const CHATTER_MAX_GAP_MS = 150_000;
export const CHATTER_PER_ROOM = 2;
const PEER_CHANCE = 0.35;

export const BUSY_WINDOW_MS = 3 * 60 * 1000;
export const BUSY_EVENTS = 3;
export const SELF_QUIET_MS = 2 * 60 * 1000;

export function chatterAllowed(events, now, author = null) {
  const since = (ms) => events.filter((event) => { const at = Date.parse(event.at); return now - at < ms && at <= now + 1000; });
  if (since(BUSY_WINDOW_MS).length >= BUSY_EVENTS) return false;
  return !author || !since(SELF_QUIET_MS).some((event) => event.author === author);
}

export const canChatter = (activity) => Object.hasOwn(SELF, activity);

export const chatterGap = (random = Math.random()) => CHATTER_MIN_GAP_MS + Math.floor(random * (CHATTER_MAX_GAP_MS - CHATTER_MIN_GAP_MS));

export function pickChatter({ activity, feature = null, peers = [], random = Math.random }) {
  if (!canChatter(activity)) return null;
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  if (peers.length && PEER[activity] && random() < PEER_CHANCE) {
    return pick(PEER[activity]).replaceAll('{peer}', pick(peers));
  }
  const lines = SELF[activity].filter((line) => feature || !line.includes('{feature}'));
  return pick(lines).replaceAll('{feature}', feature ?? '');
}


const EMOTES = {
  typing: ['💻', '⌨️', '🧠', '🤔', '❗', '💡', '🔧', '✅', '☕', '🧃'],
  reading: ['🔍', '🧐', '❓', '❗', '🧠', '📝', '☕', '🥤'],
  talking: ['💬', '👍', '🙋', '💡', '🤝'],
  coffee: ['☕', '😌', '🍪', '🎵', '🧃', '🥤'],
  posting: ['📌', '📝', '👀'],
  chat: ['😄', '👍', '☕', '🌤️', '🎵', '😆', '🥤'],
};
const REACT_EMOTES = ['😄', '👍', '😆', '❗', '💡', '🙌', '🤔'];
export const EMOTE_MS = 2200;
export const EMOTE_MIN_GAP_MS = 14_000;
export const EMOTE_MAX_GAP_MS = 40_000;
export const EMOTE_PER_FLOOR = 2;
export const emoteGap = (random = Math.random()) => EMOTE_MIN_GAP_MS + Math.floor(random * (EMOTE_MAX_GAP_MS - EMOTE_MIN_GAP_MS));

export function pickEmote({ activity, reaction = false, random = Math.random }) {
  const list = reaction ? REACT_EMOTES : EMOTES[activity];
  return list ? list[Math.floor(random() * list.length) % list.length] : null;
}


export const NPCS = [
  { id: 'news', room: 'dev', name: '제이크', persona: 'm1', side: 'jake', height: 1.1, jacket: { hue: 46, saturation: 1, lightness: 0.02 }, color: '#d4a72c', spots: ['sofa0', 'lounge', 'rug'] },
  { id: 'guide', room: 'dev', name: '써니', persona: 'f2', side: 'f13', height: 1.03, jacket: { hue: 335, saturation: 0.9, lightness: 0.04 }, color: '#e0709a', every: 20_000, spots: ['sofa1', 'coffee', 'lounge', 'nb2'] },
  { id: 'meeting', room: 'meeting', name: '에밀리', persona: 'f1', side: 'emily', height: 1.05, jacket: { hue: 356, saturation: 1, lightness: -0.04 }, color: '#d2463c', spots: ['p1', 'p0'] },
  { id: 'tools', room: 'lab', name: '리나', persona: 'f1', side: 'sunny', height: 1.05, jacket: { hue: 150, saturation: 0.55, lightness: 0.02 }, color: '#5f9e3c', spots: ['nb', 'nc'] },
  { id: 'qa', room: 'roof', name: '테스', persona: 'm1', side: 'm08', height: 1.0, jacket: { hue: 40, saturation: 0.15, lightness: 0.3 }, color: '#c9b98f', spots: ['elder', 'elder2'] },
  { id: 'secretary', room: 'boss', name: '브라이언', persona: 'm2', side: 'brian', height: 1.1, jacket: { hue: 220, saturation: 0.15, lightness: -0.18 }, color: '#4a5260', spots: ['center', 'front'] },
];
export const NPC_MS = 6500;
export const NPC_MIN_GAP_MS = 45_000;
export const NPC_MAX_GAP_MS = 90_000;
export const REPLY_DELAY_MS = 1800;
export const npcGap = (random = Math.random()) => NPC_MIN_GAP_MS + Math.floor(random * (NPC_MAX_GAP_MS - NPC_MIN_GAP_MS));

const NEWS_LINES = [
  ({ features, labels }, random) => {
    const live = features.filter((feature) => feature.phase && feature.phase !== 'done');
    if (!live.length) return null;
    const pick = live[Math.floor(random() * live.length) % live.length];
    return `📢 ${pick.id} 작업은 지금 ${labels?.[pick.phase] ?? pick.phase} 단계예요`;
  },
  ({ features }) => {
    const done = features.filter((feature) => feature.phase === 'done').length;
    return done ? `📢 지금까지 끝낸 작업이 ${done}건이에요. 수고 많았어요!` : null;
  },
  ({ active }) => (active ? `📢 진행 중인 작업이 ${active}건이에요` : null),
  ({ working }) => (working ? `📢 ${working}명이 집중해서 작업 중이에요. 조용히!` : null),
  ({ pm }) => (pm ? `📢 이 프로젝트의 PM은 ${pm}님이에요. 업무 배정은 사장실에서!` : '📢 아직 PM이 없어요. 대시보드의 "내가 PM 맡기"로 정할 수 있어요'),
  () => '📢 저를 누르면 작업별 진행 상황을 한눈에 펼쳐 드려요',
];
function timeLine(hour) {
  if (hour >= 6 && hour < 11) return '☀️ 좋은 아침이에요! 오늘 할 일부터 정리해 볼까요?';
  if (hour === 11) return '🍚 곧 점심시간이에요';
  if (hour >= 12 && hour < 14) return '🍵 점심 맛있게 드셨나요?';
  if (hour >= 14 && hour < 17) return '🙆 오후엔 스트레칭 한 번 하고 가요';
  if (hour >= 17 && hour < 20) return '🌇 오늘 마무리할 일 정리할 시간이에요';
  return '🌙 늦게까지 수고 많아요. 무리하지 마세요';
}

const OPEN_TASK = new Set(['open', 'accepted', 'blocked']);
const openTasks = (tasks = []) => tasks.filter((task) => OPEN_TASK.has(task.status ?? 'open'));
const toolLabel = (kind) => TOOLS.find((tool) => tool.kind === kind)?.label ?? (kind === 'human' ? '사용자' : '세션');

export function nextSteps({ features = [], pm, tasks = [], agents = [] }) {
  const steps = [];
  const live = features.filter((feature) => feature.phase !== 'done');
  if (!features.length) steps.push('아직 작업이 없어요. 대시보드의 "새 작업 만들기"나 plan 명령으로 첫 작업을 시작해요');
  else if (!live.length) steps.push('진행 중인 작업이 없어요. 새 작업을 만들면 다시 배정할 수 있어요');
  if (!pm) steps.push('PM이 없으면 업무를 배정할 수 없어요. 대시보드에서 "내가 PM 맡기"를 누르거나 pm 명령을 써요');
  const open = openTasks(tasks);
  if (open.length) steps.push(`남은 배정 업무가 ${open.length}건이에요. 담당 세션에서 work 명령으로 시작해요(팀 패널의 "다음 명령" 참고)`);
  if (!agents.some((agent) => agent.kind && agent.kind !== 'human')) steps.push('참여한 AI 세션이 없어요. 처음 세션은 init, 다른 세션은 join 명령을 실행하면 사무실에 들어와요');
  return steps;
}

const GUIDE_LINES = [
  '💡 같은 명령도 도구마다 부르는 법이 달라요. 팀 패널의 "다음 명령"을 복사해 그 세션에 붙여 넣어요',
  '💡 Claude·Gemini는 /wax:plan, Codex는 $wax:plan, Antigravity는 /plan으로 불러요',
  '💡 GitHub Copilot CLI는 "wax plan 스킬로"처럼 스킬 이름을 밝혀 불러요',
  '💡 저를 누르면 지금 할 일과 도구별 명령표를 화면에 펼쳐 드려요',
  '💡 캐릭터를 누르면 인사기록 카드와 그 세션의 다음 명령이 나와요',
  '✨ 머리 주변이 빛나면 방금 남긴 기록으로 그 능력치가 오른 거예요',
  '💡 다른 세션에 일을 맡길 땐 채널 글 대신 PM 배정을 써요',
  '💡 @이름으로 부르면 --watch로 기다리는 Claude Code 세션이 바로 답해요',
  '💡 하루 기록은 daily 명령으로 일일 보고서가 돼요',
  '💡 같은 채널에서 둘 이상이 논의하면 회의실로 모여요',
  '💡 건물은 아래에서 위로 회의 → 개발 → 검토 → 보고 순서예요',
  '💡 PM은 사장실에 있어요. PM에게 메시지를 보내면 잠깐 방문하러 가요',
  '💡 쉬는 세션은 옥상 정원에 올라가 담소를 나눠요',
  '💡 화이트보드를 누르면 작업별 의견·질문·결정 노트를 볼 수 있어요',
  '💡 3분 넘게 조용하면 "…", 10분이 지나면 책상에서 잠들어요',
  '📖 더 자세한 건 위쪽 메뉴의 도움말에 있어요',
];
const WHATS_NEW = [
  '🆕 처음 세션은 init 한 번으로 참여·작업·대시보드·PM을 정하고, 다른 세션은 join으로 들어와요',
  '🆕 같은 이름의 세션이 이미 있으면 -2, -3을 붙여 따로 들어와요',
  '🆕 팀 패널에 세션마다 그 도구의 문법으로 다음 명령이 나와요',
  '🆕 업무를 배정하면 그 세션이 실행할 명령을 미리 보여 줘요',
  '🆕 세션이 밝힌 모델도 "도구 · 모델"로 함께 보여요',
  '🆕 캐릭터를 누르면 기록으로 매긴 인사기록 카드가 나와요',
  '🆕 대시보드의 "새 작업 만들기"로 웹에서 바로 작업을 시작해요',
  '🆕 GitHub(cafein-network/wax)에서 한 번 설치하면 모든 프로젝트에서 써요',
];

const MEETING_RULES = [
  '정해진 건 화이트보드에 "결정"으로 남기면 모두가 따라요',
  '답이 필요한 건 "질문"으로 남기면 대시보드의 미해결 질문에 모여요',
  '다른 세션에 일을 맡길 땐 PM에게 배정을 부탁해요',
  '회의는 짧게, 결정은 분명하게!',
];
const MEETING_LINES = [
  ({ meetings }) => (meetings?.length ? `🗣️ 지금 ${meetings.join(', ')} 회의 중이에요` : '🗣️ 같은 채널에서 둘 이상이 논의하면 여기로 모여요'),
  () => `📝 ${MEETING_RULES[0]}`,
  () => `❓ ${MEETING_RULES[1]}`,
  () => `⏱️ ${MEETING_RULES[3]}`,
  () => `🙋 ${MEETING_RULES[2]}`,
  () => '💡 저를 누르면 회의 규칙을 펼쳐 드려요',
];
const ASSIGN_RULES = [
  '대표가 지시하면 PM이 선택지와 추천안을 드리고, 대표가 결정하면 PM이 업무를 배정해요',
  '진행 상황과 지연은 PM이 대표에게 보고해요. pm 명령을 다시 부르면 보고를 받을 수 있어요',
  '업무 배정은 PM만 할 수 있어요',
  '배정은 그 단계의 작업만 허락해요. 사용자 지시가 늘 우선이에요',
  '배정받은 세션은 work 명령으로 시작하고, 끝나면 업무 상태로 결과를 남겨요',
  'PM에게 보고하면 잠깐 이 방에 들르게 돼요',
];
const QA_RULES = [
  '고친 다음엔 꼭 테스트를 돌려서 근거로 남겨야 한다네. 말로만 "됐어요"는 통과가 아니야',
  '버그는 먼저 실패하는 테스트로 재현하고, 그다음에 고치는 게 순서지',
  '검토는 만든 사람 말고 다른 세션이 하는 게 좋아. 내 눈엔 내 실수가 안 보이거든',
  '경계값·빈 값·느린 네트워크… 손님은 늘 예상 못 한 길로 온다네',
  '검토에서 찾은 실패 테스트는 버그 발견으로 기록돼. 부끄러운 게 아니라 훈장이지',
];
const QA_LINES = [
  ({ features = [], labels }) => { const review = features.filter((feature) => feature.phase === 'review' && !feature.archivedAt); return review.length ? `🧪 지금 검토 단계인 작업: ${review.map((feature) => feature.id).join(', ')}. 꼼꼼히 맛을 봐야지` : null; },
  ({ features = [] }) => { const ready = features.filter((feature) => feature.phase === 'implement' && !feature.archivedAt); return ready.length ? `🍗 ${ready[0].id}는 구현 중이구먼. 다 되면 연구소에서 검토 받게나` : null; },
  ...QA_RULES.map((rule) => () => `👴 ${rule}`),
  () => '💡 나를 누르면 검토 요령을 정리해 보여 주지',
];

const SECRETARY_LINES = [
  ({ pm }) => (pm ? `🗂️ 이 프로젝트의 PM은 ${pm}님이에요` : '🗂️ 아직 PM이 없어요. 대시보드 "내가 PM 맡기"나 pm 명령으로 정해요'),
  () => `👔 ${ASSIGN_RULES[0]}`,
  () => `📈 ${ASSIGN_RULES[1]}`,
  () => `📋 ${ASSIGN_RULES[2]}`,
  () => `🔒 ${ASSIGN_RULES[3]}`,
  () => '▶️ 배정받은 업무는 work 명령으로 시작해요. 팀 패널에 도구별 명령이 나와요',
  ({ tasks }) => (openTasks(tasks).length ? `📌 남은 배정 업무가 ${openTasks(tasks).length}건이에요` : null),
  ({ limits = [] }) => { const high = limits.filter((l) => l.kind !== 'spend_limit' && l.percentUsed >= 80).sort((a, b) => b.percentUsed - a.percentUsed)[0]; return high ? `⚠️ Claude ${high.kind === 'five_hour' ? '5시간' : '주간'} 사용량이 ${high.percentUsed}%예요. 큰 작업은 초기화 뒤로 나누는 것도 방법이에요` : null; },
  ({ limits = [] }) => (limits.length ? '📊 벽의 모니터를 누르면 Claude 사용량을 자세히 볼 수 있어요' : null),
  () => `📨 ${ASSIGN_RULES[5]}`,
  () => '💡 저를 누르면 배정 현황을 펼쳐 드려요',
];

const DOING = { working: (f) => (f ? `지금 ${f} 작업 중!` : '지금 작업 중!'), reviewing: (f) => (f ? `지금 ${f} 검토 중!` : '지금 검토 중!'), discussing: () => '지금 논의 중!', idle: () => '잠깐 쉬는 중이에요', away: () => '지금은 자리를 비웠어요' };

function guideDeck({ project, description, features = [], labels, agents = [], tasks = [] }) {
  const deck = [];
  const name = project ?? '이 프로젝트';
  const phaseOf = (phase) => (phase === 'done' ? '완료' : labels?.[phase] ?? phase);
  if (description) deck.push({ text: `📘 ${name}: ${description}`, topic: 'project' });
  if (features.length) {
    const done = features.filter((feature) => feature.phase === 'done').length;
    const names = features.slice(0, 3).map((feature) => feature.id).join(', ');
    deck.push({ text: `📘 ${name}에는 wax 작업이 ${features.length}개 있어요(${names}${features.length > 3 ? ' 외' : ''}). 완료 ${done}개, 진행 ${features.length - done}개예요`, topic: 'project' });
    for (const feature of features) {
      deck.push({ text: `📘 ${feature.id}${feature.title && feature.title !== feature.id ? `(${feature.title})` : ''} 작업은 지금 ${phaseOf(feature.phase)} 단계예요`, topic: 'project' });
    }
  } else {
    deck.push({ text: `📘 ${name}에는 아직 wax 작업이 없어요. "새 작업 만들기"나 plan 명령으로 시작해 보세요`, topic: 'project' });
  }
  for (const agent of agents) {
    const doing = (DOING[agent.state] ?? (() => ''))(agent.feature);
    const who = agent.kind === 'human' ? '사용자예요. 대시보드에서 글을 쓰고 PM도 맡을 수 있어요' : `${toolLabel(agent.kind)}${agent.model ? `(${agent.model})` : ''} 세션이에요`;
    deck.push({ text: `👋 ${agent.name}님은 ${who}. ${doing}`.trim(), topic: 'intro', subject: agent.name });
    const next = agent.kind === 'human' ? null : nextCommand({ agent: { author: agent.name, kind: agent.kind, feature: agent.feature }, features, tasks });
    if (next) deck.push({ text: `▶️ ${agent.name}님 다음 명령: ${next.text}`, topic: 'intro', subject: agent.name });
  }
  return deck;
}

const newsOf = (kind, context = {}) => (context.toolNews ?? CLI_NEWS).tools[kind] ?? null;
const behind = (tool, context = {}) => { const news = newsOf(tool.kind, context); return tool.installed && news?.latest && newerThan(news.latest, tool.version) ? news : null; };
const labLines = (context) => {
  const tools = context.tools ?? [], old = tools.find(tool => behind(tool, context));
  const lines = [];
  if (old) { const news = behind(old, context); lines.push(`⬆️ ${old.label} ${news.latest}가 나왔어요(이 PC는 ${old.version}).${news.update ? ` 업데이트: ${news.update}` : ''}`); }
  const installed = new Set(tools.filter(tool => tool.installed).map(tool => tool.kind));
  const entries = Object.entries((context.toolNews ?? CLI_NEWS).tools).sort(([a], [b]) => Number(installed.has(b)) - Number(installed.has(a)));
  for (const [kind, news] of entries) {
    const current = news.items.filter(item => item.version === news.latest);
    for (const item of (current.length ? current : news.items.slice(-2)).slice(0, 2)) lines.push(`📰 ${toolLabel(kind)} ${item.version ?? news.latest}: ${item.text}`);
  }
  return [...lines, '💡 저를 누르면 공식 소식과 이 PC의 설치 버전을 확인할 수 있어요'];
};

export function npcLine(npcId, context, random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  if (npcId === 'news') {
    const lines = NEWS_LINES.map((line) => line({ features: [], ...context }, random)).filter(Boolean);
    return { text: pick(lines), topic: 'news' };
  }
  if (npcId === 'meeting') return { text: pick(MEETING_LINES.map((line) => line(context)).filter(Boolean)), topic: 'guide' };
  if (npcId === 'secretary') return { text: pick(SECRETARY_LINES.map((line) => line(context)).filter(Boolean)), topic: 'guide' };
  if (npcId === 'tools') return { text: pick(labLines(context)), topic: 'news' };
  if (npcId === 'qa') return { text: pick(QA_LINES.map((line) => line(context)).filter(Boolean)), topic: 'guide' };
  const steps = nextSteps(context).map((text) => ({ text: `🧭 ${text}`, topic: 'guide' }));
  const deck = [...steps, ...guideDeck(context)];
  const turn = context.turn ?? 0;
  const slot = turn % (deck.length + 1);
  if (slot < deck.length) return deck[slot];
  const round = Math.floor(turn / (deck.length + 1));
  if (round % 4 === 3) return { text: timeLine(context.hour), topic: 'time' };
  const tips = [...WHATS_NEW, ...GUIDE_LINES];
  return { text: tips[(round - Math.floor(round / 4)) % tips.length], topic: 'guide' };
}

export function npcGuide(npcId, context = {}) {
  const { features = [], labels, pm, meetings = [], agents = [], tasks = [] } = context;
  const phaseOf = (phase) => (phase === 'done' ? '완료' : labels?.[phase] ?? phase);
  if (npcId === 'news') {
    const live = features.filter((feature) => feature.phase !== 'done');
    return {
      title: '제이크의 진행 소식', role: '프로젝트 작업이 어디까지 왔는지 알려 드려요.',
      sections: [
        { heading: '작업별 단계', items: features.length ? features.map((feature) => `${feature.id}${feature.title && feature.title !== feature.id ? ` (${feature.title})` : ''} — ${phaseOf(feature.phase)}`) : ['아직 작업이 없어요. 대시보드의 "새 작업 만들기"로 시작해요.'] },
        { heading: '한눈에', items: [`진행 ${live.length}건 · 완료 ${features.length - live.length}건`, pm ? `프로젝트 PM: ${pm}` : 'PM이 아직 없어요. 대시보드에서 "내가 PM 맡기"로 정할 수 있어요.'] },
      ],
    };
  }
  if (npcId === 'meeting') {
    return {
      title: '에밀리의 회의 안내', role: '같은 채널에서 둘 이상이 논의하면 이 회의실로 모여요.',
      sections: [
        { heading: '지금 회의', items: meetings.length ? meetings.map((name) => `${name} 채널에서 논의 중`) : ['지금은 회의 중인 채널이 없어요.'] },
        { heading: '회의 규칙', items: MEETING_RULES },
      ],
    };
  }
  if (npcId === 'tools') {
    const tools = context.tools ?? [];
    const installed = (kind) => tools.find((tool) => tool.kind === kind);
    return {
      title: '리나의 도구 소식', role: '코딩 도구들의 새 기능과 이 PC에 설치된 버전을 알려 드려요.',
      sections: [
        { heading: '이 PC에 설치된 도구', items: TOOLS.map((tool) => {
          const found = installed(tool.kind), news = newsOf(tool.kind, context);
          if (!found) return `${tool.label} — 확인 중`;
          if (!found.installed) return `${tool.label} — 설치 안 됨`;
          const old = behind(found, context);
          return `${tool.label} ${found.version}${old ? ` → 새 버전 ${old.latest}${old.update ? ` (업데이트: ${old.update})` : ''}` : news?.latest ? newerThan(found.version, news.latest) ? ` (소식 기준 ${news.latest}보다 새로 설치됨)` : ' (소식 기준 버전과 일치)' : ''}`;
        }) },
        ...TOOLS.filter((tool) => newsOf(tool.kind, context)?.items.length).map((tool) => {
          const news = newsOf(tool.kind, context);
          return { heading: `${tool.label} 소식${news.latest ? ` · 확인된 릴리스 ${news.latest}` : ''}`, items: [...news.items.map((item) => `${item.version ? `${item.version} · ` : ''}${item.original ? '공식 원문 · ' : ''}${item.text}`), ...(news.source ? [`출처: ${news.source}`] : [])] };
        }),
        { heading: '소식 확인', items: [
          ...TOOLS.map(tool => { const news = newsOf(tool.kind, context); return `${tool.label} · ${news?.verifiedAt ? `공식 확인 ${new Date(news.verifiedAt).toLocaleString('ko-KR')}` : `기본 자료 ${CLI_NEWS.asOf}`}${news?.checkStatus === 'unavailable' ? ' · 공식 조회 실패, 마지막 자료 유지' : ''}`; }),
          (context.toolNews?.mode === 'bundled' ? '이 화면은 기본 자료를 사용해요. 공개 데모는 외부에 접속하지 않아요.' : '공식 릴리스는 화면을 사용하는 동안 1시간 간격으로 확인해요. 조회에 실패하면 마지막 자료를 유지하고 5분 후 다시 시도해요.'),
        ] },
        { heading: '알아 두기', items: ['새 릴리스는 공식 변경 이력에서 확인해요. 검토된 한국어 요약이 아직 없는 새 소식은 공식 원문으로 표시해요. 설치 버전과 소식 기준은 별도로 보여 드려요.', '설치 버전은 이 PC의 --version을 10분마다 읽어요. 아래 버튼으로 설치 버전과 공식 소식을 각각 즉시 다시 확인할 수 있어요.', '공식 소식 조회에는 프로젝트·설치 버전·세션 정보를 보내지 않아요. 오프라인으로 쓰려면 서버 실행 시 WAX_TOOL_NEWS=off를 설정하세요.'] },
      ],
    };
  }
  if (npcId === 'qa') {
    const live = features.filter((feature) => !feature.archivedAt);
    return {
      title: '테스의 검토 안내', role: '옥상에서 쉬는 세션들에게 검토(QA) 요령을 일러 주는 할아버지예요.',
      sections: [
        { heading: '검토할 작업', items: live.filter((feature) => feature.phase === 'review').map((feature) => `${feature.id} — 검토 단계`).concat(live.some((feature) => feature.phase === 'review') ? [] : ['지금 검토 단계인 작업이 없어요.']) },
        { heading: '검토 요령', items: QA_RULES },
        { heading: '명령', items: ['검토는 review 명령으로 시작해요(도구별 문법은 써니의 명령표 참고).', '테스트 결과는 근거로 남겨야 다음 단계로 넘어가요.'] },
      ],
    };
  }
  if (npcId === 'secretary') {
    const open = openTasks(tasks);
    return {
      title: '브라이언의 배정 안내', role: 'PM이 세션들에게 일을 나누는 방법을 알려 드려요.',
      sections: [
        { heading: 'PM', items: [pm ? `이 프로젝트의 PM은 ${pm}님이에요. PM은 대표가 교체를 요청할 때만 바뀌어요.` : '아직 PM이 없어요. 대시보드의 "내가 PM 맡기"나 pm 명령으로 정해요.'] },
        { heading: '남은 배정 업무', items: open.length ? open.map((task) => `${task.to} ← ${task.feature} ${task.phase === 'any' ? '현재 단계' : phaseOf(task.phase)}${task.note ? `: ${task.note}` : ''}`) : ['남은 배정 업무가 없어요.'] },
        { heading: '배정 규칙', items: ASSIGN_RULES },
      ],
    };
  }
  const commands = agents.filter((agent) => agent.kind !== 'human').map((agent) => {
    const next = nextCommand({ agent: { author: agent.name, kind: agent.kind, feature: agent.feature }, features, tasks });
    return next ? `${agent.name} (${toolLabel(agent.kind)}${agent.model ? ` · ${agent.model}` : ''}) — ${next.text} · ${next.reason}` : null;
  }).filter(Boolean);
  const steps = nextSteps(context);
  return {
    title: '써니의 사용 안내', role: '도구가 달라도 같은 방법으로 쓸 수 있게 도와드려요.',
    sections: [
      { heading: '지금 할 일', items: steps.length ? steps : ['지금은 따로 챙길 일이 없어요. 각 세션의 다음 명령을 이어 가면 돼요.'] },
      { heading: '세션별 다음 명령', items: commands.length ? commands : ['참여한 AI 세션이 없어요.'] },
      { heading: '사무실 읽는 법', items: GUIDE_LINES.filter((line) => line.startsWith('💡') && /회의실|건물|사장실|옥상|화이트보드|조용하면/.test(line)).map((line) => line.replace(/^💡 /, '')) },
    ],
    commandTable: true,
  };
}

const REACTIONS = {
  news: ['오, 진도 잘 나가네요', '저도 확인해 볼게요', '좋아요, 계속 가 봐요', '고마워요!'],
  guide: ['아, 그렇군요', '좋은 팁이네요', '몰랐어요!', '기억해 둘게요'],
  intro: ['네, 반가워요!', '잘 부탁해요!', '열심히 할게요'],
  project: ['오, 그런 프로젝트였군요', '정리 고마워요', '이제 감이 와요'],
  time: ['벌써 그렇게 됐나요?', '좋은 생각이에요', '네, 알겠어요!'],
};

export function pickReaction(topic, random = Math.random) {
  const list = REACTIONS[topic] ?? REACTIONS.news;
  return list[Math.floor(random() * list.length) % list.length];
}
