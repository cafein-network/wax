import { t } from '../messages-catalog.mjs';
import { lookFor, pickPersona } from './model.mjs';

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(t('office.faces.couldntLoadTheImage', src)));
  image.src = src;
});

export async function loadFaceAssets(base = new URL('./side/', import.meta.url).href) {
  try {
    const response = await fetch(`${base}faces.json`);
    if (!response.ok) throw new Error(`faces.json ${response.status}`);
    const index = await response.json();
    if (index.schema !== 1 || !Array.isArray(index.personas) || !Array.isArray(index.kinds)) throw new Error(t('office.faces.invalidFacesJsonFormat'));
    const atlas = await loadImage(`${base}faces.png`);
    return {
      atlas, size: index.size, kinds: index.kinds, rows: new Map(index.personas.map((item, row) => [item.id, row])),
      npcs: new Set(index.personas.filter((item) => item.npc).map((item) => item.id)),
      characters: Object.fromEntries(index.personas.filter((item) => !item.npc).map((item) => [item.id, { recolor: Boolean(item.recolor) }])),
      personas: index.personas.filter((item) => !item.npc).map((item) => item.id).sort(), variants: index.variants ?? {},
    };
  } catch (error) {
    console.warn(t('office.faces.waxChatCouldNot'), error);
    return null;
  }
}

export function faceThumb(assets, persona, kind, author) {
  const row = assets?.rows?.get(persona);
  if (row === undefined) return null;
  const col = assets.npcs?.has(persona) ? 0 : Math.max(0, assets.kinds.indexOf(assets.kinds.includes(kind) ? kind : 'other'));
  const size = assets.size;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${author} 얼굴`);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(assets.atlas, col * size, row * size, size, size, 0, 0, size, size);
  return canvas;
}

export function assignPersonas(agents, assets, reserved = new Map(), { humans = false } = {}) {
  const result = new Map(reserved);
  if (!assets?.personas?.length) return result;
  const used = new Map();
  for (const { persona, kind } of reserved.values()) used.set(persona, [...(used.get(persona) ?? []), kind]);
  for (const { author, kind } of [...agents].filter((agent) => humans || agent.kind !== 'human').sort((a, b) => a.author.localeCompare(b.author))) {
    const kept = result.get(author);
    if (kept) {
      if (kind && kept.kind !== kind) result.set(author, { ...kept, kind, look: lookFor(assets.characters[kept.persona], kind, assets.variants) });
      continue;
    }
    const persona = pickPersona(author, kind ?? 'other', assets.personas, assets.characters, used);
    if (!persona) continue;
    used.set(persona, [...(used.get(persona) ?? []), kind ?? 'other']);
    result.set(author, { persona, kind: kind ?? 'other', look: lookFor(assets.characters[persona], kind ?? 'other', assets.variants) });
  }
  return result;
}

export function reservedFrom(list, assets) {
  const result = new Map();
  if (!Array.isArray(list) || !assets?.characters) return result;
  for (const item of list) {
    if (typeof item?.author !== 'string' || typeof item.persona !== 'string' || !Object.hasOwn(assets.characters, item.persona)) continue;
    const kind = typeof item.kind === 'string' ? item.kind : 'other';
    result.set(item.author, { persona: item.persona, kind, look: lookFor(assets.characters[item.persona], kind, assets.variants) });
  }
  return result;
}

export function keepFaces(previous, office = new Map()) {
  const reserved = new Map(office), taken = new Set([...office.values()].map((face) => face.persona));
  for (const [author, face] of previous) if (!reserved.has(author) && !taken.has(face.persona)) { reserved.set(author, face); taken.add(face.persona); }
  return reserved;
}
