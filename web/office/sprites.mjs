import { t } from '../messages-catalog.mjs';
const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(t('office.sprites.couldntLoadTheImage', src)));
  image.src = src;
});

export const assetProgress = new EventTarget();

export async function loadSideAssets(base = '/office/side/') {
  try {
    const response = await fetch(`${base}manifest.json`);
    if (!response.ok) throw new Error(`manifest.json ${response.status}`);
    const manifest = await response.json();
    if (manifest.schema !== 3) throw new Error(t('office.sprites.manifestSchemaIsNot', manifest.schema));
    const images = [...Object.values(manifest.characters).flatMap((entry) => [...Object.values(entry.views), ...Object.values(entry.poses ?? {})]).flatMap((info) => [info.file, info.mask]),
      ...Object.values(manifest.backgrounds ?? {}), ...Object.values(manifest.props ?? {}).map((info) => info.file)].filter(Boolean);
    let loaded = 0;
    const counted = (src) => loadImage(src).then((image) => { loaded++; assetProgress.dispatchEvent(new CustomEvent('progress', { detail: { loaded, total: images.length } })); return image; });
    const load = async (info) => ({ ...info, image: await counted(base + info.file), mask: info.mask ? await counted(base + info.mask) : null });
    const all = (entries, fn) => Promise.all(entries.map(async ([key, value]) => [key, await fn(value)])).then(Object.fromEntries);
    const [characters, backgrounds, props] = await Promise.all([
      all(Object.entries(manifest.characters), async (entry) => ({ npc: entry.npc, recolor: entry.recolor ?? false, views: await all(Object.entries(entry.views), load), poses: await all(Object.entries(entry.poses ?? {}), load) })),
      all(Object.entries(manifest.backgrounds ?? {}), (file) => counted(base + file)),
      all(Object.entries(manifest.props ?? {}), async (info) => ({ ...info, image: await counted(base + info.file) })),
    ]);
    const personas = Object.keys(characters).filter((id) => !characters[id].npc).sort();
    return { manifest, characters, personas, backgrounds, props, characterHeight: manifest.standHeight ?? 180, variants: manifest.variants ?? {} };
  } catch (error) {
    console.warn(t('office.sprites.waxOfficeCouldNot'), error);
    return null;
  }
}
