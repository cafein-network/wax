import { fileURLToPath } from 'node:url';
import { leadingCli, shellWords, unwrapShell } from './goal-allow.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));

export const WORKER_FORBIDDEN = Object.freeze({
  chat: Object.freeze(['join', 'presence', 'reset', 'watch', 'post', 'assign', 'task', 'team pm']),
  skills: Object.freeze(['init', 'join', 'work', 'pm', 'chat', 'iterate', 'daily']),
});

export function workerForbiddenPrompt() {
  const chat = WORKER_FORBIDDEN.chat.map((name) => `wax chat ${name}`).join(', ');
  const skills = WORKER_FORBIDDEN.skills.map((name) => `wax:${name}`).join(', ');
  return `작업자가 부를 일이 아닌 명령: ${chat}. 팀 채널 참여·상태 바꾸기·채널 글·배정·업무 상태는 PM 루프와 사람이 합니다. 대화형 스킬(${skills})도 시작하지 마세요. 이런 요청은 승인 화면에 "작업자가 부를 일이 아닌 명령"으로 표시됩니다.`;
}

const FLAGS = new Set(['--all', '--wake', '--rename', '--clear', '--replace', '--status', '--json', '--help', '-h']);
const SKILL = new RegExp(`^wax:(${WORKER_FORBIDDEN.skills.join('|')})$`);
const WAX_WORD = /(?:^|\/)wax(?:\.mjs|\.cmd|\.ps1|\.exe)?$/i;
const NODE_WORD = /(?:^|\/)node(?:\.exe)?$/i;
const MAX_WORDS = 24;

function commandTexts(details) {
  if (!details || typeof details !== 'object') return [];
  const call = details.toolCall && typeof details.toolCall === 'object' ? details.toolCall : null;
  return [details.input?.command, details.command, details.item?.command, call?.rawInput?.command, call?.title].map((value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string')) {
      return value.length === 3 && ['-c', '-lc'].includes(value[1]) ? value[2] : value.join(' ');
    }
    return null;
  }).filter(Boolean);
}

function leadingWords(command, cli) {
  let line = unwrapShell(command).trim();
  if (line.startsWith('& ')) line = line.slice(2).trimStart();
  line = leadingCli(line, cli).replaceAll('\\', '/');
  const pieces = line.replace(/([;&|])/g, ' $1 ').split(' ').filter(Boolean);
  for (let count = Math.min(pieces.length, MAX_WORDS); count > 0; count--) {
    const words = shellWords(pieces.slice(0, count).join(' '), { strict: false });
    if (words) return words;
  }
  return null;
}

function waxArgs(words) {
  if (WAX_WORD.test(words[0])) return words.slice(1);
  if (NODE_WORD.test(words[0]) && words[1] && /(?:^|\/)wax\.mjs$/i.test(words[1])) return words.slice(2);
  return null;
}

function chatCommand(args) {
  let i = 0;
  while (args[i] === '--project' || args[i]?.startsWith('--project=')) i += args[i] === '--project' ? 2 : 1;
  if (args[i] !== 'chat') return null;
  const positionals = [];
  for (i += 1; i < args.length && positionals.length < 2; i++) {
    const word = args[i];
    if (word.startsWith('-')) { if (!word.includes('=') && !FLAGS.has(word)) i++; continue; }
    positionals.push(word);
  }
  const [name, sub] = positionals;
  if (name === 'team') return sub === 'pm' ? 'team pm' : null;
  return name && WORKER_FORBIDDEN.chat.includes(name) ? name : null;
}

export function workerForbidden(request, { cli = CLI } = {}) {
  const details = request?.details;
  if (!details || typeof details !== 'object') return null;
  if (details.tool_name === 'Skill' && typeof details.input?.skill === 'string' && SKILL.test(details.input.skill)) return { command: details.input.skill };
  for (const text of commandTexts(details)) {
    const words = leadingWords(text, cli);
    const args = words && waxArgs(words);
    const name = args && chatCommand(args);
    if (name) return { command: `wax chat ${name}` };
  }
  return null;
}
