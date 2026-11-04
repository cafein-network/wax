import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { decodePng, encodePng, removeBackground, cropToContent, resize } from './import-side-prop.mjs';

const source = process.argv[2];
if (!source) throw new Error('Midjourney 원본 PNG 폴더가 필요합니다.');
const output = new URL('../web/office/side/', import.meta.url);
const manifestFile = new URL('manifest.json', output);
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const background = decodePng(await readFile(join(resolve(source), 'background.png')));
const width = 1424, height = 420, wallBottom = 300;
const sourceFloor = Math.round(background.height * .87), rgba = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  const sy = y < wallBottom ? Math.floor(y / wallBottom * sourceFloor) : Math.min(background.height - 1, sourceFloor + Math.floor((y - wallBottom) / (height - wallBottom) * (background.height - sourceFloor)));
  for (let x = 0; x < width; x++) {
    const sx = Math.min(background.width - 1, Math.floor(x / width * background.width));
    background.rgba.copy(rgba, (y * width + x) * 4, (sy * background.width + sx) * 4, (sy * background.width + sx) * 4 + 4);
  }
}
await writeFile(new URL('bg-studio.png', output), encodePng(width, height, rgba));
manifest.backgrounds.studio = 'bg-studio.png';
const interiorBackground = {
  'design-desk': [[.31, .70], [.50, .70], [.70, .70], [.35, .505], [.43, .505], [.63, .502]],
  moodboard: [[.45, .664], [.592, .664]],
  softbox: [[.38, .82], [.46, .82], [.445, .838], [.44, .60]],
};
for (const [name, target] of [['design-desk', 112], ['moodboard', 100], ['softbox', 52]]) {
  const image = decodePng(await readFile(join(resolve(source), `${name}.png`)));
  removeBackground(image, { seeds: interiorBackground[name].map(([x, y]) => [Math.floor(x * image.width), Math.floor(y * image.height)]) });
  const sprite = resize(cropToContent(image), target);
  await writeFile(new URL(`prop-${name}.png`, output), encodePng(sprite.width, sprite.height, sprite.rgba));
  manifest.props[name] = { file: `prop-${name}.png`, width: sprite.width, height: sprite.height, native: true };
  console.log(`${name}: ${sprite.width}x${sprite.height}`);
}
manifest.props = Object.fromEntries(Object.entries(manifest.props).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('studio: 1424x420');
