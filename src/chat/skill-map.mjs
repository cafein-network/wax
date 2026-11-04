import { readdir } from 'node:fs/promises';
import { LABELS, PHASES, listFeatures } from '../workflow.mjs';
import { listPresence } from './presence.mjs';
import { readTaskRecords } from './team.mjs';
import { proofOwners, taskWindows } from './skills.mjs';

export const GROUPS = { phase: '단계', check: '검증', area: '코드 영역' };
const CHECKS = { test: '테스트', static: '정적 검사', runtime: '실행 검증', integration: '연동 검증', visual: '화면 검증' };
const CONTAINERS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'services', 'web']);
const IGNORED = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'vendor']);
const MAX_AREAS = 24;

export function areaOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return '(루트 파일)';
  return CONTAINERS.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

async function topFolders(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED.has(entry.name)).map((entry) => entry.name);
  } catch { return []; }
}

export async function buildSkillMap(root, { now = new Date() } = {}) {
  const people = new Map(), cells = new Map(), columns = new Map();
  const person = (author, kind) => {
    if (!people.has(author)) people.set(author, { author, kind: kind ?? 'other' });
    else if (kind && people.get(author).kind === 'other') people.get(author).kind = kind;
    return author;
  };
  const column = (group, id, label) => {
    const key = `${group}:${id}`;
    if (!columns.has(key)) columns.set(key, { key, group, label });
    return key;
  };
  const add = (author, key, passed = true) => {
    if (!cells.has(author)) cells.set(author, {});
    const cell = (cells.get(author)[key] ??= { count: 0, failed: 0 });
    if (passed) cell.count++; else cell.failed++;
  };
  for (const phase of PHASES) column('phase', phase, LABELS[phase]);
  for (const [id, label] of Object.entries(CHECKS)) column('check', id, label);

  const records = await readTaskRecords(root);
  const tasks = new Map();
  for (const record of records) {
    if (record.record === 'task') tasks.set(record.id, record);
    else if (record.record === 'status' && record.status === 'done' && tasks.has(record.task)) {
      const task = tasks.get(record.task);
      if (PHASES.includes(task.phase)) add(person(task.to), `phase:${task.phase}`);
    }
  }

  const workingOn = taskWindows(records);
  let unattributed = 0;
  for (const feature of await listFeatures(root)) {
    for (const proof of feature.proofs ?? []) {
      const owners = proofOwners(proof, feature.id, workingOn);
      if (!owners.length) { unattributed++; continue; }
      if (proof.kind === 'git') {
        const areas = new Set(proof.files.map(areaOf).filter((area) => !area.startsWith('.wax')));
        for (const author of owners) for (const area of areas) add(person(author), column('area', area, area));
      } else {
        const passed = proof.exitCode === 0 && !proof.timedOut;
        for (const author of owners) add(person(author), `check:${proof.verification ?? 'test'}`, passed);
      }
    }
  }
  for (const agent of await listPresence(root, { now })) person(agent.author, agent.kind);

  const touched = [...columns.values()].filter((c) => c.group === 'area').map((c) => c.label);
  for (const folder of await topFolders(root)) {
    if (!touched.some((area) => area === folder || area.startsWith(`${folder}/`))) column('area', folder, folder);
  }

  const list = [...columns.values()].map((c) => {
    const owners = [...cells].filter(([, row]) => row[c.key]?.count > 0);
    return { ...c, holders: owners.length, total: owners.reduce((sum, [, row]) => sum + row[c.key].count, 0), only: owners.length === 1 ? owners[0][0] : null };
  });
  const areas = list.filter((c) => c.group === 'area').sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const shown = [...list.filter((c) => c.group !== 'area'), ...areas.slice(0, MAX_AREAS)];
  const rows = [...people.values()].map((p) => {
    const row = cells.get(p.author) ?? {};
    return { ...p, total: Object.values(row).reduce((sum, cell) => sum + cell.count, 0), cells: row };
  }).sort((a, b) => b.total - a.total || a.author.localeCompare(b.author));
  return {
    generatedAt: now.toISOString(), groups: GROUPS, columns: shown, people: rows, unattributed,
    hiddenAreas: Math.max(0, areas.length - MAX_AREAS),
    gaps: { empty: shown.filter((c) => c.holders === 0).map((c) => c.label), single: shown.filter((c) => c.only).map((c) => ({ label: c.label, author: c.only })) },
  };
}

export function formatSkillMap(map) {
  if (!map.people.length) return '아직 참여한 세션이나 기록이 없습니다. wax chat join으로 참여하고 업무·근거를 남기면 지도가 채워집니다.';
  const cell = (row, key) => { const c = row.cells[key]; return !c ? '·' : `${c.count}${c.failed ? `(실패 ${c.failed})` : ''}`; };
  const lines = [
    `| 사원 | ${map.columns.map((c) => `${GROUPS[c.group]}: ${c.label}`).join(' | ')} |`,
    `| --- | ${map.columns.map(() => '---').join(' | ')} |`,
    ...map.people.map((row) => `| ${row.author} | ${map.columns.map((c) => cell(row, c.key)).join(' | ')} |`),
    '',
    `빈 분야(기록 없음): ${map.gaps.empty.length ? map.gaps.empty.join(', ') : '없음'}`,
    `한 명만 기록이 있는 분야: ${map.gaps.single.length ? map.gaps.single.map((g) => `${g.label}(${g.author})`).join(', ') : '없음'}`,
  ];
  if (map.hiddenAreas) lines.push(`기록이 적은 코드 영역 ${map.hiddenAreas}개는 생략했습니다.`);
  if (map.unattributed) lines.push(`작성자를 알 수 없는 근거 ${map.unattributed}개는 세지 않았습니다(wax test·evidence에 --author를 붙이면 셉니다).`);
  return lines.join('\n');
}
