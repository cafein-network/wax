import { PHASES } from './workflow.mjs';

const time = (value) => (typeof value === 'string' ? Date.parse(value) : NaN);

export function phaseDurations(feature, now = Date.now()) {
  const phases = {};
  let open = null, since = null, last = null, paused = false;
  const enter = (phase, at) => {
    open = PHASES.includes(phase) ? phase : null;
    since = open && !paused ? at : null;
    if (open) (phases[open] ??= { ms: 0, visits: 0 }).visits += 1;
  };
  const close = (at) => {
    if (open && since !== null && at >= since) phases[open].ms += at - since;
    since = null;
  };
  const history = Array.isArray(feature?.history) ? feature.history : [];
  for (const event of history) {
    if (event === null || typeof event !== 'object') continue;
    const at = time(event.at);
    if (!Number.isFinite(at) || (last !== null && at < last)) continue;
    const { action, phase } = event;
    if (!PHASES.includes(phase) && phase !== 'done') continue;
    if (action === 'create') { paused = false; enter(phase, at); }
    else if (action === 'complete') {
      if (open === phase) close(at);
      enter(PHASES.includes(phase) ? PHASES[PHASES.indexOf(phase) + 1] : null, at);
    } else if (action === 'iterate') {
      if (open === phase) close(at);
      enter('implement', at);
    } else if (action === 'archive-feature') { close(at); paused = true; }
    else if (action === 'restore') { paused = false; if (open) since = at; }
    else if (action === 'import') {
      if (last !== null) close(last);
      if (open !== phase) { open = null; enter(phase, at); }
      else if (open && !paused) since = at;
    } else if (action !== 'archive' && PHASES.includes(phase) && open !== phase) {
      close(at); enter(phase, at);
    }
    last = at;
  }
  const end = now instanceof Date ? now.getTime() : Number(now);
  const inProgress = open && since !== null && Number.isFinite(end) && end >= since ? open : null;
  if (inProgress) close(end);
  const totalMs = Object.values(phases).reduce((sum, { ms }) => sum + ms, 0);
  return { phases, inProgress, totalMs };
}
