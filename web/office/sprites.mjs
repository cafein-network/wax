const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`이미지를 불러오지 못했습니다: ${src}`));
  image.src = src;
});

export async function loadSideAssets(base = '/office/side/') {
  try {
    const response = await fetch(`${base}manifest.json`);
    if (!response.ok) throw new Error(`manifest.json ${response.status}`);
    const manifest = await response.json();
    if (manifest.schema !== 3) throw new Error(`manifest schema ${manifest.schema}은(는) 사이드뷰가 아닙니다.`);
    const load = async (info) => ({ ...info, image: await loadImage(base + info.file), mask: info.mask ? await loadImage(base + info.mask) : null });
    const all = (entries, fn) => Promise.all(entries.map(async ([key, value]) => [key, await fn(value)])).then(Object.fromEntries);
    const [characters, backgrounds, props] = await Promise.all([
      all(Object.entries(manifest.characters), async (entry) => ({ npc: entry.npc, recolor: entry.recolor ?? false, views: await all(Object.entries(entry.views), load), poses: await all(Object.entries(entry.poses ?? {}), load) })),
      all(Object.entries(manifest.backgrounds ?? {}), (file) => loadImage(base + file)),
      all(Object.entries(manifest.props ?? {}), async (info) => ({ ...info, image: await loadImage(base + info.file) })),
    ]);
    const personas = Object.keys(characters).filter((id) => !characters[id].npc).sort();
    return { manifest, characters, personas, backgrounds, props, characterHeight: manifest.standHeight ?? 180, variants: manifest.variants ?? {} };
  } catch (error) {
    console.warn('wax 사무실(사이드뷰): 에셋을 불러오지 못했습니다.', error);
    return null;
  }
}
