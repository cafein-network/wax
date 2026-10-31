import { t } from '../../web/messages-catalog.mjs';
import { PHASES, WaxError, validId, validVia } from '../workflow.mjs';

export const LIMITS = { body: 8000, report: 100_000, author: 40, note: 200, recipients: 10, readDefault: 100, readMax: 1000 };
export const KINDS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'grok', 'human', 'other'];
export const MESSAGE_TYPES = ['message', 'opinion', 'question', 'answer', 'decision'];
export const NOTE_TYPES = ['opinion', 'question', 'answer', 'decision'];
export const STANCES = ['agree', 'disagree'];
export const STATES = ['working', 'discussing', 'reviewing', 'idle', 'away'];
export const GENERAL = 'general';

const oneOf = (list, label) => (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new WaxError(t('errors.chat.validate.isRequired', label));
  }
  if (!list.includes(value)) throw new WaxError(t('errors.chat.validate.mustBeOneOf', label, list.join(', ')));
  return value;
};

export const kind = oneOf(KINDS, '종류(kind)');
export const messageType = oneOf(MESSAGE_TYPES, '메시지 유형');
export const noteType = oneOf(NOTE_TYPES, '노트 유형');
export const state = oneOf(STATES, '상태');

export function channelId(value) {
  if (typeof value === 'string' && value in Object.prototype) throw new WaxError(t('errors.chat.validate.aReservedNameCannot'));
  try { return validId(value); }
  catch { throw new WaxError(t('errors.chat.validate.theChannelIdMust')); }
}

export function author(value) {
  if (typeof value !== 'string' || value in Object.prototype || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u.test(value)) {
    throw new WaxError(t('errors.chat.validate.theAuthorMustBe', LIMITS.author));
  }
  return value;
}

export function body(value, max = LIMITS.body, label = '본문') {
  if (typeof value !== 'string' || !value.trim()) throw new WaxError(t('errors.chat.validate.isEmpty', label));
  if (value.length > max) throw new WaxError(t('errors.chat.validate.mustBeCharactersOr', label, max));
  return value.replace(/\r\n/g, '\n').trim();
}

export function model(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9._:/@() -]*$/.test(text)) throw new WaxError(t('errors.chat.validate.theModelNameMust'));
  return text;
}

export function peer(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text)) throw new WaxError(t('errors.chat.validate.theCrossSessionName'));
  return text;
}

export function optionalText(value, max, label) {
  if (value === undefined || value === null || value === '') return null;
  return body(value, max, label);
}

export function recipients(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((name) => String(name).trim()).filter(Boolean);
  if (list.length > LIMITS.recipients) throw new WaxError(t('errors.chat.validate.thereCanBeAt', LIMITS.recipients));
  return [...new Set(list.map(author))];
}

export const via = (value) => validVia(value);

export function stance(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!STANCES.includes(value)) throw new WaxError(t('errors.chat.validate.stanceMustBeOne', STANCES.join(', ')));
  return value;
}

export function phase(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value !== 'done' && !PHASES.includes(value)) throw new WaxError(t('errors.chat.validate.theStageMustBe', [...PHASES, 'done'].join(', ')));
  return value;
}

const ID_PATTERN = { m: /^m-(\d{6,})-[0-9a-f]{6}$/, n: /^n-(\d{6,})-[0-9a-f]{6}$/, r: /^r-(\d{6,})-[0-9a-f]{6}$/, d: /^d-(\d{6,})-[0-9a-f]{6}$/, t: /^t-(\d{6,})-[0-9a-f]{6}$/, s: /^s-(\d{6,})-[0-9a-f]{6}$/ };

export function seqOf(value, prefixes, label = 'ID') {
  for (const prefix of prefixes) {
    const match = typeof value === 'string' && value.match(ID_PATTERN[prefix]);
    if (match) return Number(match[1]);
  }
  throw new WaxError(t('errors.chat.validate.hasAnInvalidFormat', label));
}

export function limit(value) {
  if (value === undefined || value === null || value === '') return LIMITS.readDefault;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > LIMITS.readMax) throw new WaxError(t('errors.chat.validate.limitMustBeAn', LIMITS.readMax));
  return number;
}
