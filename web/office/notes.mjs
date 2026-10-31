import { MEETING_WINDOW_MS } from './model.mjs';

export const NOTE_SPEED = 900;
export const NOTE_MAX_MS = 2600;
export const NOTE_LIFT = 62;
export const NOTE_TRAIL = 5;
export const NOTE_GAP = 34;
export const LAND_MS = 450;
export const STREAM_LENGTH = 220;

export function deliveryTargets(message, events, now, windowMs = MEETING_WINDOW_MS) {
  if (message.to?.length) return [...new Set(message.to)].filter((name) => name !== message.author);
  const at = Date.parse(message.at);
  const last = events
    .filter((event) => event.channel === message.channel && event.author !== message.author && Date.parse(event.at) <= at && now - Date.parse(event.at) <= windowMs)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return last ? [last.author] : [];
}

export function noteRoute(floorPoints, end, lift = NOTE_LIFT) {
  const points = floorPoints.map((p) => ({ x: p.x, y: p.y - lift }));
  if (end) points.push({ x: end.x, y: end.y });
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
}

export const noteSpeed = (length) => Math.max(NOTE_SPEED, length / (NOTE_MAX_MS / 1000));

export function noteTrain(points, dist, length, { count = NOTE_TRAIL, gap = NOTE_GAP } = {}) {
  const train = [];
  for (let i = 0; i < count; i++) {
    const d = dist - i * gap;
    if (d < 0 || d >= length) continue;
    const at = pointAt(points, d);
    train.push({ x: at.x, y: at.y, angle: Math.atan2(at.dy, at.dx), alpha: i ? 0.7 - i * 0.12 : 1, size: i ? 0.8 - i * 0.1 : 1, lead: i === 0 });
  }
  return train;
}

function pointAt(points, distance) {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= segment) { const t = segment ? left / segment : 1; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: b.x - a.x, dy: b.y - a.y }; }
    left -= segment;
  }
  const last = points.at(-1), prev = points.at(-2) ?? last;
  return { x: last.x, y: last.y, dx: last.x - prev.x, dy: last.y - prev.y };
}

function drawNote(ctx, { x, y, angle, alpha, size }, tone, t, reduced) {
  const w = 30 * size, h = 21 * size;
  const wobble = reduced ? 0 : Math.sin(t / 90 + x / 40) * 0.18;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate((Math.abs(Math.cos(angle)) > 0.3 ? 0 : 0.25) + wobble);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w, h);
  ctx.fillStyle = '#fff8e1';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = tone;
  ctx.fillRect(-w / 2, -h / 2, w, 5 * size);
  ctx.strokeStyle = 'rgba(80,60,30,0.45)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
  ctx.beginPath(); ctx.moveTo(-w / 2 + 5, 1 * size); ctx.lineTo(w / 2 - 5, 1 * size); ctx.moveTo(-w / 2 + 5, 6 * size); ctx.lineTo(w / 5, 6 * size); ctx.stroke();
  ctx.restore();
}

export function streamPoints(points, dist, length, span = STREAM_LENGTH, step = 10) {
  const head = Math.min(dist, length), tail = Math.max(0, dist - span);
  const out = [];
  for (let d = tail; d <= head; d += step) out.push({ ...pointAt(points, d), alpha: span ? 1 - (head - d) / span : 1 });
  return out;
}

function drawStream(ctx, flight) {
  const dots = streamPoints(flight.points, flight.dist, flight.length);
  ctx.save();
  ctx.strokeStyle = flight.tone; ctx.lineCap = 'round'; ctx.lineWidth = 5;
  for (let i = 1; i < dots.length; i++) {
    ctx.globalAlpha = 0.35 * dots[i].alpha;
    ctx.beginPath(); ctx.moveTo(dots[i - 1].x, dots[i - 1].y); ctx.lineTo(dots[i].x, dots[i].y); ctx.stroke();
  }
  ctx.restore();
}

export function drawNotes(ctx, flights, time, reduced = false) {
  for (const flight of flights) {
    drawStream(ctx, flight);
    if (flight.landedAt != null) {
      const p = (time - flight.landedAt) / LAND_MS, end = flight.points.at(-1);
      if (p >= 1 || reduced) continue;
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = flight.tone; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(end.x, end.y, 8 + p * 22, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    for (const note of noteTrain(flight.points, flight.dist, flight.length).reverse()) drawNote(ctx, note, flight.tone, time, reduced);
  }
}
