import { PHASES, WaxError, validId } from '../workflow.mjs';

export const LIMITS = { body: 8000, report: 100_000, author: 40, note: 200, recipients: 10, readDefault: 100, readMax: 1000 };
export const KINDS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'human', 'other'];
export const MESSAGE_TYPES = ['message', 'opinion', 'question', 'answer', 'decision'];
export const NOTE_TYPES = ['opinion', 'question', 'answer', 'decision'];
export const STANCES = ['agree', 'disagree'];
export const STATES = ['working', 'discussing', 'reviewing', 'idle', 'away'];
export const GENERAL = 'general';

const oneOf = (list, label) => (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new WaxError(`${label}이(가) 필요합니다.`);
  }
  if (!list.includes(value)) throw new WaxError(`${label}은(는) ${list.join(', ')} 중 하나여야 합니다.`);
  return value;
};

export const kind = oneOf(KINDS, '종류(kind)');
export const messageType = oneOf(MESSAGE_TYPES, '메시지 유형');
export const noteType = oneOf(NOTE_TYPES, '노트 유형');
export const state = oneOf(STATES, '상태');

export function channelId(value) {
  try { return validId(value); }
  catch { throw new WaxError('채널 ID는 영문 소문자·숫자로 시작하는 1~64자의 영문 소문자·숫자·하이픈이어야 합니다.'); }
}

export function author(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u.test(value)) {
    throw new WaxError(`작성자는 글자·숫자로 시작하는 ${LIMITS.author}자 이하의 이름이어야 합니다(공백·_·.·- 허용).`);
  }
  return value;
}

export function body(value, max = LIMITS.body, label = '본문') {
  if (typeof value !== 'string' || !value.trim()) throw new WaxError(`${label}이(가) 비어 있습니다.`);
  if (value.length > max) throw new WaxError(`${label}은(는) ${max}자 이하여야 합니다.`);
  return value.replace(/\r\n/g, '\n').trim();
}

export function model(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9._:/@() -]*$/.test(text)) throw new WaxError('모델 이름은 영문·숫자로 시작하는 60자 이하여야 합니다(예: claude-sonnet-4-5).');
  return text;
}

export function peer(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text)) throw new WaxError('세션 간 통신 이름은 영문·숫자로 시작하는 64자 이하여야 합니다(영문·숫자·. _ - 허용, 예: wax-0f).');
  return text;
}

export function optionalText(value, max, label) {
  if (value === undefined || value === null || value === '') return null;
  return body(value, max, label);
}

export function recipients(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((name) => String(name).trim()).filter(Boolean);
  if (list.length > LIMITS.recipients) throw new WaxError(`받는 사람은 ${LIMITS.recipients}명 이하여야 합니다.`);
  return [...new Set(list.map(author))];
}

export function stance(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!STANCES.includes(value)) throw new WaxError(`stance는 ${STANCES.join(', ')} 중 하나여야 합니다.`);
  return value;
}

export function phase(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value !== 'done' && !PHASES.includes(value)) throw new WaxError(`단계는 ${[...PHASES, 'done'].join(', ')} 중 하나여야 합니다.`);
  return value;
}

const ID_PATTERN = { m: /^m-(\d{6,})-[0-9a-f]{6}$/, n: /^n-(\d{6,})-[0-9a-f]{6}$/, r: /^r-(\d{6,})-[0-9a-f]{6}$/, d: /^d-(\d{6,})-[0-9a-f]{6}$/, t: /^t-(\d{6,})-[0-9a-f]{6}$/, s: /^s-(\d{6,})-[0-9a-f]{6}$/ };

export function seqOf(value, prefixes, label = 'ID') {
  for (const prefix of prefixes) {
    const match = typeof value === 'string' && value.match(ID_PATTERN[prefix]);
    if (match) return Number(match[1]);
  }
  throw new WaxError(`${label} 형식이 올바르지 않습니다.`);
}

export function limit(value) {
  if (value === undefined || value === null || value === '') return LIMITS.readDefault;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > LIMITS.readMax) throw new WaxError(`limit은 1~${LIMITS.readMax} 사이의 정수여야 합니다.`);
  return number;
}
