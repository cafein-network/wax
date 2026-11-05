const MENTION = /(^|[^\p{L}\p{N}_`/@.+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?)?)/gu;
export const unmention = (text) => text.replace(MENTION, (_, before, name) => `${before}\`@${name}\``);
