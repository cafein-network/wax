import { COMMANDS, commandFor } from './commands.mjs';

const MAX = 8;

export function completionAt(text, caret = text.length) {
  const match = String(text).slice(0, caret).match(/(?:^|\s)([@/#])([^\s@#/]*)$/u);
  if (!match) return null;
  return { trigger: match[1], query: match[2], start: caret - match[2].length - 1, end: caret };
}

const includes = (query, ...values) => values.some((value) => String(value ?? '').toLowerCase().includes(query));
const later = (query, name, item) => Number(!name(item).toLowerCase().startsWith(query));
const startsFirst = (query, name) => (a, b) => later(query, name, a) - later(query, name, b) || name(a).localeCompare(name(b));

export function completions(at, { sessions = [], features = [], kind = null, feature = null } = {}) {
  if (!at) return [];
  const query = at.query.toLowerCase();
  if (at.trigger === '@') {
    return sessions.filter((session) => includes(query, session.author)).sort(startsFirst(query, (session) => session.author)).slice(0, MAX)
      .map((session) => ({ key: `@${session.author}`, label: `@${session.author}`, detail: session.kind ?? '', insert: `@${session.author} `, author: session.author }));
  }
  if (at.trigger === '#') {
    return features.filter((item) => includes(query, item.id, item.title)).sort(startsFirst(query, (item) => item.id)).slice(0, MAX)
      .map((item) => ({ key: `#${item.id}`, label: `#${item.id}`, detail: item.title ?? '', insert: `#${item.id} ` }));
  }
  return COMMANDS.filter((command) => includes(query, command.name, command.label)).sort((a, b) => later(query, (command) => command.name, a) - later(query, (command) => command.name, b)).slice(0, MAX).map((command) => {
    const args = command.args.startsWith('<작업ID>') && feature ? feature : '';
    const text = (kind && commandFor(kind, command.name, args)) || `wax ${command.name}${args ? ` ${args}` : ''}`;
    return { key: `/${command.name}`, label: `/${command.name}`, detail: command.label, insert: `${text} ` };
  });
}

export function applyCompletion(text, at, item) {
  return { text: text.slice(0, at.start) + item.insert + text.slice(at.end), caret: at.start + item.insert.length };
}
