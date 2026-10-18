const paths = {
  message: ['M4 4h16v12h-5l-3 4-3-4H4Z', 'M8 8h8M8 12h5'],
  target: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM12 12l8-8M16 4h4v4'],
  medal: ['M17 9a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z', 'm8 13-2 9 6-3 6 3-2-9'],
  hammer: ['m14 3 7 7-4 4-3-3L5 21l-3-3L12 8 9 5Z'],
  search: ['M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'm15 15 6 6'],
  bug: ['M8 7h8v8a4 4 0 0 1-8 0ZM9 7V5l-2-2m8 4V5l2-2M3 9l5 2M3 15h5m-3 6 4-4m12-8-5 2m5 4h-5m3 6-4-4M12 8v11'],
  sparkle: ['m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z', 'M20 2v4m-2-2h4'],
  link: ['m10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3', 'm8 16 8-8'],
  scales: ['M12 3v18M7 21h10M4 6h16', 'm5 6-4 9h8Zm14 0-4 9h8Z'],
  crown: ['m2 5 5 5 5-7 5 7 5-5-3 14H5Z', 'M6 15h12'],
  calendar: ['M3 5h18v16H3ZM3 10h18M7 2v6M17 2v6', 'm8 15 3 3 5-5'],
  star: ['m12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1Z'],
  lock: ['M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4M12 15v2'],
  plan: ['M9 18h6M10 21h4', 'M8 13a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z'],
  design: ['m4 16 12-12 4 4L8 20H4Z', 'm13 7 4 4M7 4l-3 3 3 3M17 14l3 3-3 3'],
  implement: ['m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18'],
  review: ['M21 11v1a9 9 0 1 1-5-8', 'm9 11 3 3L22 4'],
  report: ['M14 2H5v20h14V7Z', 'M14 2v6h5M8 12h8M8 16h8'],
  play: ['m8 4 13 8-13 8Z'], pause: ['M8 4v16M16 4v16'], reset: ['M3 10a9 9 0 1 1 1 8', 'M3 3v7h7'],
  previous: ['m19 5-9 7 9 7ZM5 5v14'],
  next: ['m5 5 9 7-9 7ZM19 5v14'], team: ['M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3M17 4a4 4 0 0 1 0 8M22 21v-3a4 4 0 0 0-3-4', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  board: ['M3 4h18v13H3ZM8 21l4-4 4 4M7 8h4M7 12h10'],
  test: ['M9 3h6M10 3v7l-6 9v2h16v-2l-6-9V3M8 16h8'],
  passed: ['m5 12 4 4L20 5'], failed: ['m6 6 12 12M6 18 18 6'], question: ['M9 7a3 3 0 1 1 5 3c-2 1-2 2-2 4M12 18h.01', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
};
export function icon(name, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ux-icon' })) svg.setAttribute(key, value);
  for (const d of paths[name] ?? paths.plan) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

const achievementIcons = {
  first: 'target', 'first-task': 'target', 'task-10': 'medal', planner: 'design',
  builder: 'hammer', reviewer: 'search', green: 'review', 'bug-hunter': 'bug',
  clean: 'sparkle', committer: 'link', answerer: 'plan', decider: 'scales',
  reporter: 'report', pm: 'crown', steady: 'calendar', 'all-rounder': 'star',
};
export function achievementIcon(id, size = 30) {
  return icon(achievementIcons[id] ?? 'medal', size);
}
