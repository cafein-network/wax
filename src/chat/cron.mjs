import { t } from '../../web/messages-catalog.mjs';
import { WaxError } from '../workflow.mjs';

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'weekday', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
const DAY = 86_400_000;
const invalid = (expr) => new WaxError(t('errors.chat.cron.invalidExpression', expr));

function value(text, field, expr) {
  const index = field.names?.indexOf(text.toLowerCase()) ?? -1;
  if (index >= 0) return index + (field.name === 'month' ? 1 : 0);
  if (!/^\d{1,2}$/.test(text)) throw invalid(expr);
  const number = Number(text);
  if (number < field.min || number > field.max) throw invalid(expr);
  return number;
}

function parseField(text, field, expr) {
  const out = new Set();
  for (const part of text.split(',')) {
    const match = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw invalid(expr);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) throw invalid(expr);
    let from, to;
    if (match[1] === '*') { from = field.min; to = field.max; }
    else {
      const range = match[1].split('-');
      if (range.length > 2) throw invalid(expr);
      from = value(range[0], field, expr);
      to = range.length === 2 ? value(range[1], field, expr) : (match[2] === undefined ? from : field.max);
      if (to < from) throw invalid(expr);
    }
    for (let n = from; n <= to; n += step) out.add(field.name === 'weekday' && n === 7 ? 0 : n);
  }
  return out;
}

export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.length > 120) throw invalid(String(expr).slice(0, 120));
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw invalid(expr);
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index], expr));
  return { minutes: [...minutes].sort((a, b) => a - b), hours: [...hours].sort((a, b) => a - b), days, months, weekdays, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' };
}

const formatters = new Map();
function formatter(timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    try { format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
    catch { throw new WaxError(t('errors.chat.cron.unknownTimeZone', timeZone)); }
    if (formatters.size > 64) formatters.clear();
    formatters.set(timeZone, format);
  }
  return format;
}

export function checkTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) throw new WaxError(t('errors.chat.cron.unknownTimeZone', String(timeZone).slice(0, 64)));
  formatter(timeZone);
  return timeZone;
}

export function localParts(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
const offsetAt = (ms, timeZone) => {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

export function zonedTime(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY, timeZone), after = offsetAt(wall + DAY, timeZone);
  const valid = [...new Set([wall - before, wall - after])].filter((ms) => ms + offsetAt(ms, timeZone) === wall);
  return valid.length ? Math.min(...valid) : wall - before;
}

export function localLabel(ms, timeZone) {
  const p = localParts(ms, timeZone), two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

export function occurrences(cron, timeZone, after, { until = Infinity, limit = 1000, maxDays = 8 * 366 } = {}) {
  const spec = typeof cron === 'string' ? parseCron(cron) : cron;
  checkTimeZone(timeZone);
  const out = [], seen = new Set();
  const start = localParts(after, timeZone);
  for (let n = -1; n <= maxDays && out.length < limit; n++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day) + n * DAY);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    if (!spec.months.has(month)) continue;
    const dayMatch = spec.days.has(day), weekdayMatch = spec.weekdays.has(date.getUTCDay());
    if (!(spec.anyDay && spec.anyWeekday ? true : spec.anyDay ? weekdayMatch : spec.anyWeekday ? dayMatch : dayMatch || weekdayMatch)) continue;
    const found = [];
    for (const hour of spec.hours) for (const minute of spec.minutes) {
      const ms = zonedTime(year, month, day, hour, minute, timeZone);
      if (ms > after && ms <= until && !seen.has(ms)) { seen.add(ms); found.push(ms); }
    }
    found.sort((a, b) => a - b);
    for (const ms of found) { if (out.length < limit) out.push(ms); }
    if (Date.UTC(year, month - 1, day) - DAY * 2 > until) break;
  }
  return out.sort((a, b) => a - b).slice(0, limit);
}

export const nextRun = (cron, timeZone, after) => occurrences(cron, timeZone, after, { limit: 1 })[0] ?? null;
