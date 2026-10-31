import { t } from '../messages-catalog.mjs';
import { TOOLS, nextCommand } from '../commands.mjs';
import { CLI_NEWS, newerThan } from './cli-news.mjs';


const SELF = {
  typing: [t('office.chatter.whatShouldIName'), t('office.chatter.maybeRunTheTests'), t('office.chatter.aLittleMorePolish'), t('office.chatter.thinkingAboutTheCommit'), t('office.chatter.iShouldAddA'), t('office.chatter.idLikeToTidy'), t('office.chatter.focusFocus')],
  reading: [t('office.chatter.whyIsThisCondition'), t('office.chatter.rereadingTheFeatureDocs'), t('office.chatter.thereMayBeAn'), t('office.chatter.willTheTestsCatch'), t('office.chatter.oneLineAtA')],
  talking: [t('office.chatter.thatDirectionLooksGood'), t('office.chatter.doesTheScheduleWork'), t('office.chatter.shallWeTrimThe'), t('office.chatter.oneQuickQuestion'), t('office.chatter.soToSummarize')],
  coffee: [t('office.chatter.refuelingWithCoffee'), t('office.chatter.takingAQuickBreather'), t('office.chatter.whatsForLunch'), t('office.chatter.backToItAfter'), t('office.chatter.lovelyWeatherOutThere')],
  posting: [t('office.chatter.illPutItOn'), t('office.chatter.everyoneShouldSeeThis'), t('office.chatter.oneMoreNote')],
  chat: [t('office.chatter.aNiceBreezeUp'), t('office.chatter.thisClearsMyHead'), t('office.chatter.theFlowersAreOut'), t('office.chatter.takeAShortBreak'), t('office.chatter.lookAtThatSky')],
};
const PEER = {
  typing: [t('office.chatter.peerCanYouTake'), t('office.chatter.howsItGoingPeer'), t('office.chatter.youveGotThisPeer')],
  reading: [t('office.chatter.peerWhatWasThe'), t('office.chatter.peerLetsCheckIt')],
  talking: [t('office.chatter.whatDoYouThink'), t('office.chatter.iAgreeWithPeer')],
  coffee: [t('office.chatter.coffeePeer'), t('office.chatter.peerTakeALittle')],
  posting: [t('office.chatter.peerPleaseCheckThe')],
  chat: [t('office.chatter.howHaveYouBeen'), t('office.chatter.takeABreakToo'), t('office.chatter.peerLetsFinishThat'), t('office.chatter.anotherCoffeePeer')],
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
  { id: 'news', room: 'dev', name: t('office.chatter.jake'), persona: 'm1', side: 'jake', height: 1.1, jacket: { hue: 46, saturation: 1, lightness: 0.02 }, color: '#d4a72c', spots: ['sofa0', 'lounge', 'rug'] },
  { id: 'guide', room: 'dev', name: t('office.chatter.sunny'), persona: 'f2', side: 'f13', height: 1.03, jacket: { hue: 335, saturation: 0.9, lightness: 0.04 }, color: '#e0709a', every: 20_000, spots: ['sofa1', 'coffee', 'lounge', 'nb2'] },
  { id: 'meeting', room: 'meeting', name: t('office.chatter.emily'), persona: 'f1', side: 'emily', height: 1.05, jacket: { hue: 356, saturation: 1, lightness: -0.04 }, color: '#d2463c', spots: ['p1', 'p0'] },
  { id: 'tools', room: 'lab', name: t('office.chatter.rina'), persona: 'f1', side: 'sunny', height: 1.05, jacket: { hue: 150, saturation: 0.55, lightness: 0.02 }, color: '#5f9e3c', spots: ['nb', 'nc'] },
  { id: 'qa', room: 'roof', name: t('office.chatter.tess'), persona: 'm1', side: 'm08', height: 1.0, jacket: { hue: 40, saturation: 0.15, lightness: 0.3 }, color: '#c9b98f', spots: ['elder', 'elder2'] },
  { id: 'secretary', room: 'boss', name: t('office.chatter.brian'), persona: 'm2', side: 'brian', height: 1.1, jacket: { hue: 220, saturation: 0.15, lightness: -0.18 }, color: '#4a5260', spots: ['center', 'front'] },
  { id: 'design', room: 'studio', name: t('office.chatter.jenny'), persona: 'f1', side: 'f06', height: 1.03, jacket: { hue: 285, saturation: 0.65, lightness: 0.08 }, color: '#ad7bc7', spots: ['jenny', 'jenny2'] },
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
  ({ pm }) => (pm ? `📢 이 프로젝트의 PM은 ${pm}님이에요. 업무 배정은 사장실에서!` : t('office.chatter.noPmYetSelect')),
  () => t('office.chatter.selectMeForAn'),
];
function timeLine(hour) {
  if (hour >= 6 && hour < 11) return t('office.chatter.goodMorningShallWe');
  if (hour === 11) return t('office.chatter.almostLunchtime');
  if (hour >= 12 && hour < 14) return t('office.chatter.enjoyedLunch');
  if (hour >= 14 && hour < 17) return t('office.chatter.timeForAnAfternoon');
  if (hour >= 17 && hour < 20) return t('office.chatter.timeToWrapUp');
  return t('office.chatter.workingLateTakeCare');
}

const OPEN_TASK = new Set(['open', 'accepted', 'blocked']);
const openTasks = (tasks = []) => tasks.filter((task) => OPEN_TASK.has(task.status ?? 'open'));
const toolLabel = (kind) => TOOLS.find((tool) => tool.kind === kind)?.label ?? (kind === 'human' ? t('office.chatter.ceo') : t('office.chatter.session'));

export function nextSteps({ features = [], pm, tasks = [], agents = [] }) {
  const steps = [];
  const live = features.filter((feature) => feature.phase !== 'done');
  if (!features.length) steps.push(t('office.chatter.noTasksYetStart'));
  else if (!live.length) steps.push(t('office.chatter.noActiveTasksCreate'));
  if (!pm) steps.push(t('office.chatter.chooseAPmBefore'));
  const open = openTasks(tasks);
  if (open.length) steps.push(`남은 배정 업무가 ${open.length}건이에요. 담당 세션에서 work 명령으로 시작해요(팀 패널의 "다음 명령" 참고)`);
  if (!agents.some((agent) => agent.kind && agent.kind !== 'human')) steps.push(t('office.chatter.noAiSessionsYet'));
  return steps;
}

const GUIDE_LINES = [
  t('office.chatter.toolsUseDifferentCommand'),
  t('office.chatter.claudeAndGeminiUse'),
  t('office.chatter.inGithubCopilotCli'),
  t('office.chatter.selectMeForCurrent'),
  t('office.chatter.selectACharacterFor'),
  t('office.chatter.aGlowAroundA'),
  t('office.chatter.useAPmAssignment'),
  t('office.chatter.anNameMentionWakes'),
  t('office.chatter.turnTheDaysRecords'),
  t('office.chatter.sessionsDiscussingTheSame'),
  t('office.chatter.floorsGoFromDiscussion'),
  t('office.chatter.thePmWorksIn'),
  t('office.chatter.idleSessionsRelaxAnd'),
  t('office.chatter.selectAWhiteboardFor'),
  t('office.chatter.after3QuietMinutes'),
  t('office.chatter.seeHelpInThe'),
];
const WHATS_NEW = [
  t('office.chatter.theFirstSessionUses'),
  t('office.chatter.duplicateSessionNamesGet'),
  t('office.chatter.theTeamPanelShows'),
  t('office.chatter.assignmentsPreviewTheCommand'),
  t('office.chatter.sessionsCanShowBoth'),
  t('office.chatter.selectACharacterForIts'),
  t('office.chatter.startATaskOn'),
  t('office.chatter.installOnceFromGithub'),
];

const MEETING_RULES = [
  t('office.chatter.postAgreementsAsDecision'),
  t('office.chatter.postAQuestionTo'),
  t('office.chatter.askThePmTo'),
  t('office.chatter.shortMeetingsClearDecisions'),
];
const MEETING_LINES = [
  ({ meetings }) => (meetings?.length ? `🗣️ 지금 ${meetings.join(', ')} 회의 중이에요` : t('office.chatter.sessionsDiscussingTheSameChannel')),
  () => `📝 ${MEETING_RULES[0]}`,
  () => `❓ ${MEETING_RULES[1]}`,
  () => `⏱️ ${MEETING_RULES[3]}`,
  () => `🙋 ${MEETING_RULES[2]}`,
  () => t('office.chatter.selectMeForMeeting'),
];
const ASSIGN_RULES = [
  t('office.chatter.theCeoGivesDirection'),
  t('office.chatter.thePmReportsProgress'),
  t('office.chatter.onlyThePmCan'),
  t('office.chatter.assignmentsAuthorizeThatStage'),
  t('office.chatter.assignedSessionsStartWith'),
  t('office.chatter.reportingToThePm'),
];
const QA_RULES = [
  t('office.chatter.runTestsAfterA'),
  t('office.chatter.reproduceABugWith'),
  t('office.chatter.aDifferentSessionShould'),
  t('office.chatter.boundariesEmptyValuesSlow'),
  t('office.chatter.failingReviewTestsCount'),
];
const QA_LINES = [
  ({ features = [], labels }) => { const review = features.filter((feature) => feature.phase === 'review' && !feature.archivedAt); return review.length ? `🧪 지금 검토 단계인 작업: ${review.map((feature) => feature.id).join(', ')}. 꼼꼼히 맛을 봐야지` : null; },
  ({ features = [] }) => { const ready = features.filter((feature) => feature.phase === 'implement' && !feature.archivedAt); return ready.length ? `🍗 ${ready[0].id}는 구현 중이구먼. 다 되면 연구소에서 검토 받게나` : null; },
  ...QA_RULES.map((rule) => () => `👴 ${rule}`),
  () => t('office.chatter.selectMeForReview'),
];

const SECRETARY_LINES = [
  ({ pm }) => (pm ? `🗂️ 이 프로젝트의 PM은 ${pm}님이에요` : t('office.chatter.noPmYetUse')),
  () => `👔 ${ASSIGN_RULES[0]}`,
  () => `📈 ${ASSIGN_RULES[1]}`,
  () => `📋 ${ASSIGN_RULES[2]}`,
  () => `🔒 ${ASSIGN_RULES[3]}`,
  () => t('office.chatter.startAssignedWorkWith'),
  ({ tasks }) => (openTasks(tasks).length ? `📌 남은 배정 업무가 ${openTasks(tasks).length}건이에요` : null),
  ({ limits = [] }) => { const high = limits.filter((l) => l.kind !== 'spend_limit' && l.percentUsed >= 80).sort((a, b) => b.percentUsed - a.percentUsed)[0]; return high ? `⚠️ Claude ${high.kind === 'five_hour' ? '5시간' : '주간'} 사용량이 ${high.percentUsed}%예요. 큰 작업은 초기화 뒤로 나누는 것도 방법이에요` : null; },
  ({ limits = [] }) => (limits.length ? t('office.chatter.selectTheWallMonitor') : null),
  () => `📨 ${ASSIGN_RULES[5]}`,
  () => t('office.chatter.selectMeForAssignment'),
];

const DOING = { working: (f) => (f ? `지금 ${f} 작업 중!` : t('office.chatter.workingNow')), reviewing: (f) => (f ? `지금 ${f} 검토 중!` : t('office.chatter.reviewingNow')), discussing: () => t('office.chatter.discussingNow'), idle: () => t('office.chatter.takingAShortBreak'), away: () => t('office.chatter.awayRightNow') };

function guideDeck({ project, description, features = [], labels, agents = [], tasks = [] }) {
  const deck = [];
  const name = project ?? t('office.chatter.thisProject');
  const phaseOf = (phase) => (phase === 'done' ? t('office.chatter.done') : labels?.[phase] ?? phase);
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
    const who = agent.kind === 'human' ? t('office.chatter.theCeoCanPost') : `${toolLabel(agent.kind)}${agent.model ? `(${agent.model})` : ''} 세션이에요`;
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
  return [...lines, t('office.chatter.selectMeForOfficial')];
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
  if (npcId === 'design') return { text: pick([
    t('office.chatter.imJennySelectMe'),
    t('office.chatter.connectAFigmaFrame'),
    t('office.chatter.checkReadAndWrite'),
    t('office.chatter.reviewThePreviewAnd'),
    t('office.chatter.approveYourChosenVersion'),
  ]), topic: 'guide' };
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
  const phaseOf = (phase) => (phase === 'done' ? t('office.chatter.done') : labels?.[phase] ?? phase);
  if (npcId === 'design') return {
    title: t('office.chatter.jennysDesignGuide'), role: t('office.chatter.illGuideYouThrough'),
    sections: [
      { heading: t('office.chatter.gettingStarted'), items: [t('office.chatter.openDesignDeliverablesAnd'), t('office.chatter.connectTheMcpFor'), t('office.chatter.chooseADesignTarget')] },
      { heading: t('office.chatter.reviewAndHandoff'), items: [t('office.chatter.checkTheFinishedPreview'), t('office.chatter.describeSpecificChangesTo'), t('office.chatter.approveYourChosenVersionAnd')] },
      { heading: t('office.chatter.choosingATool'), items: [t('office.chatter.figmaForScreenLayouts'), t('office.chatter.blenderFor3dProps'), t('office.chatter.iExplainTheWorkflow')] },
    ],
  };
  if (npcId === 'news') {
    const live = features.filter((feature) => feature.phase !== 'done');
    return {
      title: t('office.chatter.jakesProgressUpdate'), role: t('office.chatter.seeHowTheProjects'),
      sections: [
        { heading: t('office.chatter.stagesByTask'), items: features.length ? features.map((feature) => `${feature.id}${feature.title && feature.title !== feature.id ? ` (${feature.title})` : ''} — ${phaseOf(feature.phase)}`) : [t('office.chatter.noTasksYetSelect')] },
        { heading: t('office.chatter.atAGlance'), items: [`진행 ${live.length}건 · 완료 ${features.length - live.length}건`, pm ? `프로젝트 PM: ${pm}` : t('office.chatter.noPmYetUseTake')] },
      ],
    };
  }
  if (npcId === 'meeting') {
    return {
      title: t('office.chatter.emilysMeetingGuide'), role: t('office.chatter.sessionsDiscussingTheSameChannelGather'),
      sections: [
        { heading: t('office.chatter.currentMeetings'), items: meetings.length ? meetings.map((name) => `${name} 채널에서 논의 중`) : [t('office.chatter.noChannelMeetingsRight')] },
        { heading: t('office.chatter.meetingGuidelines'), items: MEETING_RULES },
      ],
    };
  }
  if (npcId === 'tools') {
    const tools = context.tools ?? [];
    const installed = (kind) => tools.find((tool) => tool.kind === kind);
    return {
      title: t('office.chatter.rinasToolNews'), role: t('office.chatter.newCodingToolFeatures'),
      sections: [
        { heading: t('office.chatter.toolsOnThisComputer'), items: TOOLS.map((tool) => {
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
        { heading: t('office.chatter.newsChecked'), items: [
          ...TOOLS.filter(tool => newsOf(tool.kind, context)).map(tool => { const news = newsOf(tool.kind, context); return `${tool.label} · ${news?.verifiedAt ? `공식 확인 ${new Date(news.verifiedAt).toLocaleString(globalThis.document?.documentElement.lang === 'en' ? 'en-US' : 'ko-KR')}` : `기본 자료 ${CLI_NEWS.asOf}`}${news?.checkStatus === 'unavailable' ? ' · 공식 조회 실패, 마지막 자료 유지' : ''}`; }),
          (context.toolNews?.mode === 'bundled' ? t('office.chatter.thisScreenUsesBundled') : t('office.chatter.officialReleasesAreChecked')),
        ] },
        { heading: t('office.chatter.goodToKnow'), items: [t('office.chatter.checkOfficialChangelogsFor'), t('office.chatter.installedVersionsAreChecked'), t('office.chatter.officialNewsChecksSend')] },
      ],
    };
  }
  if (npcId === 'qa') {
    const live = features.filter((feature) => !feature.archivedAt);
    return {
      title: t('office.chatter.tesssReviewGuide'), role: t('office.chatter.aRooftopGuideSharing'),
      sections: [
        { heading: t('office.chatter.tasksToReview'), items: live.filter((feature) => feature.phase === 'review').map((feature) => `${feature.id} — 검토 단계`).concat(live.some((feature) => feature.phase === 'review') ? [] : [t('office.chatter.noTasksAreIn')]) },
        { heading: t('office.chatter.reviewTips'), items: QA_RULES },
        { heading: t('office.chatter.command'), items: [t('office.chatter.startAReviewWith'), t('office.chatter.saveTestResultsAs')] },
      ],
    };
  }
  if (npcId === 'secretary') {
    const open = openTasks(tasks);
    return {
      title: t('office.chatter.briansAssignmentGuide'), role: t('office.chatter.howAPmDistributes'),
      sections: [
        { heading: 'PM', items: [pm ? `이 프로젝트의 PM은 ${pm}님이에요. PM은 대표가 교체를 요청할 때만 바뀌어요.` : t('office.chatter.noPmYetUseTakePm')] },
        { heading: t('office.chatter.openAssignments'), items: open.length ? open.map((task) => `${task.to} ← ${task.feature} ${task.phase === 'any' ? '현재 단계' : phaseOf(task.phase)}${task.note ? `: ${task.note}` : ''}`) : [t('office.chatter.noOpenAssignments')] },
        { heading: t('office.chatter.assignmentRules'), items: ASSIGN_RULES },
      ],
    };
  }
  const commands = agents.filter((agent) => agent.kind !== 'human').map((agent) => {
    const next = nextCommand({ agent: { author: agent.name, kind: agent.kind, feature: agent.feature }, features, tasks });
    return next ? `${agent.name} (${toolLabel(agent.kind)}${agent.model ? ` · ${agent.model}` : ''}) — ${next.text} · ${next.reason}` : null;
  }).filter(Boolean);
  const steps = nextSteps(context);
  return {
    title: t('office.chatter.sunnysUsageGuide'), role: t('office.chatter.aSharedWorkflowAcross'),
    sections: [
      { heading: t('office.chatter.whatToDoNow'), items: steps.length ? steps : [t('office.chatter.nothingNeedsAttentionRight')] },
      { heading: t('office.chatter.nextCommandsBySession'), items: commands.length ? commands : [t('office.chatter.noAiSessionsHave')] },
      { heading: t('office.chatter.howToReadThe'), items: GUIDE_LINES.filter((line) => line.startsWith('💡') && /회의실|건물|사장실|옥상|화이트보드|조용하면/.test(line)).map((line) => line.replace(/^💡 /, '')) },
    ],
    commandTable: true,
  };
}

const REACTIONS = {
  news: [t('office.chatter.niceProgress'), t('office.chatter.illTakeALook'), t('office.chatter.greatKeepGoing'), t('office.chatter.thankYou')],
  guide: [t('office.chatter.ahISee'), t('office.chatter.goodTip'), t('office.chatter.iDidntKnowThat'), t('office.chatter.illRemember')],
  intro: [t('office.chatter.niceToMeetYou'), t('office.chatter.lookingForwardToIt'), t('office.chatter.illDoMyBest')],
  project: [t('office.chatter.ohThatsTheProject'), t('office.chatter.thanksForTheSummary'), t('office.chatter.iGetItNow')],
  time: [t('office.chatter.already'), t('office.chatter.goodIdea'), t('office.chatter.gotIt')],
};

export function pickReaction(topic, random = Math.random) {
  const list = REACTIONS[topic] ?? REACTIONS.news;
  return list[Math.floor(random() * list.length) % list.length];
}
