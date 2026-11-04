import { fill, messages } from '../web/messages-catalog.mjs';
import { translate } from '../web/locale-core.mjs';

export function cliLanguage(env = process.env) {
  const chosen = /^(en|ko)(?![a-z])/i.exec(env.WAX_LANG?.trim() ?? '')?.[1].toLowerCase();
  if (chosen) return chosen;
  return /^en(?![a-z])/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ? 'en' : 'ko';
}

export function cliText(language = cliLanguage()) {
  const index = language === 'en' ? 1 : 0;
  return {
    language,
    say: (id, ...values) => fill(messages[id]?.[index] ?? id, values),
    localize: (text) => (index && typeof text === 'string' ? translate(text) : text),
  };
}
