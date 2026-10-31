import { t } from '../messages-catalog.mjs';
import { dateLocale, el } from '/dom.mjs';
import { dressed } from './paint.mjs';
import { icon, achievementIcon } from '../icons.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (name, attrs = {}, ...children) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
};

export function faceShot(sprite, look, author, size = 88) {
  const front = sprite?.views?.front;
  const image = front && dressed(front, look);
  if (!image) return el('div', { class: 'card-face card-face-empty', 'aria-hidden': 'true', text: [...author][0]?.toUpperCase() ?? '?' });
  const canvas = el('canvas', { class: 'card-face', width: size, height: size, role: 'img', 'aria-label': `${author} 얼굴` });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const crop = Math.round(front.width * 0.95);
  const sx = Math.round((front.width - crop) / 2);
  ctx.drawImage(image, sx, 0, crop, crop, 0, 0, size, size);
  return canvas;
}

const DEFAULT_AXES = [t('office.card.planningDesign'), t('office.card.implement'), t('office.card.review'), t('office.card.tests'), t('office.card.communication'), t('office.card.report')].map((label) => ({ label, score: 50, grade: t('office.card.average') }));

export function radarChart(axes, size = 260) {
  const c = size / 2, r = size * 0.32;
  const at = (i, ratio) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
    return [c + Math.cos(angle) * r * ratio, c + Math.sin(angle) * r * ratio];
  };
  const ring = (ratio) => axes.map((_, i) => at(i, ratio).map((n) => n.toFixed(1)).join(',')).join(' ');
  const chart = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'radar', role: 'img', 'aria-label': axes.map((a) => t('office.card.points', a.label, a.score, a.grade)).join(', ') });
  for (const ratio of [0.25, 0.75, 1]) chart.append(svg('polygon', { points: ring(ratio), class: 'radar-grid' }));
  chart.append(svg('polygon', { points: ring(0.5), class: 'radar-normal' }));
  axes.forEach((_, i) => { const [x, y] = at(i, 1); chart.append(svg('line', { x1: c, y1: c, x2: x.toFixed(1), y2: y.toFixed(1), class: 'radar-grid' })); });
  chart.append(svg('polygon', { points: axes.map((a, i) => at(i, a.score / 100).map((n) => n.toFixed(1)).join(',')).join(' '), class: 'radar-area' }));
  axes.forEach((a, i) => {
    const [x, y] = at(i, 1.3);
    const label = svg('text', { x: x.toFixed(1), y: y.toFixed(1), class: 'radar-label', 'text-anchor': Math.abs(x - c) < 4 ? 'middle' : x < c ? 'end' : 'start', 'dominant-baseline': 'middle' });
    label.append(svg('tspan', { x: x.toFixed(1), dy: '-0.4em' }, a.label), svg('tspan', { x: x.toFixed(1), dy: '1.2em', class: `radar-score grade-${a.score >= 70 ? 'up' : a.score < 45 ? 'down' : 'mid'}` }, `${a.score} ${a.grade}`));
    chart.append(label);
  });
  return chart;
}

let tabSeq = 0;
export function cardTabs(panels) {
  const list = panels.filter((p) => p?.content);
  const id = `hr-tabs-${++tabSeq}`;
  const bar = el('div', { class: 'tabs hr-tabs', role: 'tablist', 'aria-label': t('office.card.cardSections') });
  const bodies = list.map((p, i) => el('section', { class: 'hr-tabpanel', role: 'tabpanel', id: `${id}-p${i}`, 'aria-labelledby': `${id}-t${i}`, tabindex: '0', hidden: i ? '' : null }, p.content));
  const buttons = list.map((p, i) => el('button', { type: 'button', role: 'tab', id: `${id}-t${i}`, 'aria-controls': `${id}-p${i}`, 'aria-selected': String(!i), tabindex: i ? '-1' : '0', text: p.label }));
  const select = (index, focus = false) => {
    buttons.forEach((b, i) => { b.setAttribute('aria-selected', String(i === index)); b.tabIndex = i === index ? 0 : -1; bodies[i].hidden = i !== index; });
    if (focus) buttons[index].focus();
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(i));
    b.addEventListener('keydown', (event) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      select((to + buttons.length) % buttons.length, true);
    });
  });
  bar.append(...buttons);
  return el('div', { class: 'hr-tabbed' }, bar, ...bodies);
}

const hours = (ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}시간` : `${Math.round(ms / 60_000)}분`);
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(dateLocale()) : '-');

export function profileCard({ author, kindLabel, profile, sprite, look, face, extra, department, lead = false, tabs = [] }) {
  const m = profile?.metrics ?? { bugRate: null, bugsFound: 0, commits: 0, workMs: 0, tasksDone: 0, tests: 0 };
  const earned = profile?.badges.filter((b) => b.earned).length ?? 0;
  return el('article', { class: 'hr-card' },
    el('header', { class: 'hr-head' },
      el('div', { class: 'hr-portrait' }, face ?? faceShot(sprite, look, author, 112), el('span', { class: 'hr-level', 'aria-label': `레벨 ${profile?.level ?? 1}` }, el('small', { text: 'Lv' }), String(profile?.level ?? 1))),
      el('div', { class: 'hr-id' },
        el('div', { class: 'hr-kicker', text: t('office.card.hrRecordCard') }),
        el('strong', { class: 'hr-name', text: author }),
        el('div', { class: 'hr-tags' },
          el('span', { class: `hr-chip hr-team${lead ? ' hr-lead' : ''}`, text: `${department} ${lead ? '팀장' : '팀원'}` }),
          el('span', { class: 'hr-chip', text: kindLabel }),
          el('span', { class: 'hr-chip hr-join', text: `입사 ${date(profile?.firstAt)}` })),
        extra ?? null)),
    el('p', { class: 'hr-summary', text: profile?.summary ?? t('office.card.thereIsLittleHistory') }),
    cardTabs([
      { label: t('office.card.skills'), content: radarChart(profile?.axes ?? DEFAULT_AXES) },
      { label: t('office.card.verificationMetrics'), content: el('dl', { class: 'hr-metrics' },
        el('div', {}, el('dt', { text: t('office.card.bugRate') }), el('dd', { text: m.bugRate === null ? '-' : `${Math.round(m.bugRate * 100)}%` }), el('span', { class: 'kind', text: `내 작업 테스트 ${m.tests}회` })),
        el('div', {}, el('dt', { text: t('office.card.bugsFound') }), el('dd', { text: `${m.bugsFound}건` }), el('span', { class: 'kind', text: t('office.card.failingTestsDuringReview') })),
        el('div', {}, el('dt', { text: t('office.card.commits') }), el('dd', { text: `${m.commits}건` }), el('span', { class: 'kind', text: t('office.card.linkedToAssignedWork') })),
        el('div', {}, el('dt', { text: t('office.card.workTime') }), el('dd', { text: hours(m.workMs) }), el('span', { class: 'kind', text: `업무 ${m.tasksDone}건 수락→완료` }))) },
      { label: t('office.card.earnedBadges', earned, profile?.badges.length ?? 0), content: el('ul', { class: 'hr-badges' }, (profile?.badges ?? []).map((b) => el('li', { class: b.earned ? 'earned' : 'locked', title: `${b.desc} (${b.progress}/${b.goal})` },
        el('span', { class: 'hr-badge-icon', 'aria-hidden': 'true' }, achievementIcon(b.id), el('span', { class: 'hr-badge-state' }, icon(b.earned ? 'passed' : 'lock', 12))),
        el('span', { class: 'hr-badge-label', text: b.label }),
        el('span', { class: 'kind', text: b.earned ? t('office.card.achievements') : t('office.card.notEarned', b.progress, b.goal) }),
        el('span', { class: 'hr-badge-desc', text: b.desc })))) },
      ...tabs,
    ]),
    el('p', { class: 'kind hr-note', text: t('office.card.scoresAndLevelsCome') }),
  );
}

const metric = (label, value, note, small = false) => el('div', {}, el('dt', { text: label }), el('dd', { class: small ? 'small' : null, text: value }), el('span', { class: 'kind', text: note }));

export function ceoCard({ author, profile, sprite, look, face, team, department, tabs = [] }) {
  const c = profile?.counts ?? {};
  return el('article', { class: 'hr-card hr-ceo' },
    el('header', { class: 'hr-head' },
      el('div', { class: 'hr-portrait' }, face ?? faceShot(sprite, look, author, 112), el('span', { class: 'hr-level hr-crown', 'aria-hidden': 'true', text: '👑' })),
      el('div', { class: 'hr-id' },
        el('div', { class: 'hr-kicker', text: t('office.card.ceoCard') }),
        el('strong', { class: 'hr-name', text: author }),
        el('div', { class: 'hr-tags' },
          el('span', { class: 'hr-chip hr-team', text: t('office.card.ceo') }),
          team.pm === author ? el('span', { class: 'hr-chip hr-role', text: `${department} 팀장 겸임` }) : null,
          el('span', { class: 'hr-chip hr-join', text: `입사 ${date(profile?.firstAt)}` })))),
    el('p', { class: 'hr-summary', text: t('office.card.theCeoGivesInstructions') }),
    cardTabs([
      { label: t('office.card.teamOverview'), content: el('dl', { class: 'hr-metrics' },
        metric(t('office.card.aiSessions'), `${team.ai}명`, `일하는 중 ${team.working}명`),
        metric(t('office.card.activeTasks'), `${team.active}건`, `완료 ${team.done}건`),
        metric(t('office.card.openAssignments'), `${team.openTasks}건`, team.blocked ? `막힘 ${team.blocked}건: PM 보고를 받아 보세요` : t('office.card.noBlockedAssignments')),
        metric(t('office.card.projectPm'), team.pm ?? t('office.card.none'), team.pm ? t('office.card.adviceAssignmentsProgressReports') : t('office.card.setInTheDashboard'), true)) },
      { label: t('office.card.ceoActivity'), content: el('dl', { class: 'hr-metrics' },
        metric(t('office.card.decision'), `${c.decisions ?? 0}건`, t('office.card.decisionsInChannelsAnd')),
        metric(t('office.card.question'), `${c.questions ?? 0}건`, t('office.card.questionsToTheTeam')),
        metric(t('office.card.message'), `${c.messages ?? 0}건`, t('office.card.channelPosts')),
        metric(t('office.card.activeDays'), `${c.days ?? 0}일`, `마지막 활동 ${date(profile?.lastAt)}`)) },
      ...tabs,
    ]),
    el('p', { class: 'kind hr-note', text: t('office.card.onlyAiSessionsReceive') }),
  );
}
