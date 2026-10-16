import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './import-side-prop.mjs';
import { paintPixels } from '../web/office/paint.mjs';
import { lookFor } from '../web/office/model.mjs';
import { NPCS } from '../web/office/chatter.mjs';

const DIR = new URL('../web/office/side/', import.meta.url);
export const FACE_SIZE = 64;
export const FACE_KINDS = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'human', 'other'];

const png = async (name) => decodePng(await readFile(new URL(name, DIR)));

export async function buildFaces() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', DIR), 'utf8'));
  const entries = Object.entries(manifest.characters).filter(([, entry]) => !entry.npc && entry.views?.front).sort(([a], [b]) => a.localeCompare(b));
  const npcs = NPCS.filter((npc) => manifest.characters[npc.side]?.views?.front);
  if (new Set(npcs.map((npc) => npc.side)).size !== npcs.length) throw new Error('같은 그림을 쓰는 NPC가 둘 이상입니다.');
  const rows = [...entries.map(([id, entry]) => ({ id, entry, looks: FACE_KINDS.map((kind) => lookFor({ recolor: entry.recolor ?? false }, kind, manifest.variants ?? {})) })),
    ...npcs.map((npc) => ({ id: npc.side, entry: manifest.characters[npc.side], npc: true, looks: [{ jacket: npc.jacket }] }))];
  const size = FACE_SIZE, width = size * FACE_KINDS.length, height = size * rows.length;
  const atlas = Buffer.alloc(width * height * 4);
  for (const [row, { entry, looks }] of rows.entries()) {
    const front = entry.views.front;
    const image = await png(front.file), mask = front.mask ? await png(front.mask) : null;
    const crop = Math.round(image.width * 0.95), sx = Math.round((image.width - crop) / 2);
    for (const [col, look] of looks.entries()) {
      const px = Buffer.from(image.rgba);
      if (look && mask) paintPixels(px, mask.rgba, look);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const srcX = sx + Math.floor((x * crop) / size), srcY = Math.floor((y * crop) / size);
        if (srcX < 0 || srcX >= image.width || srcY >= image.height) continue;
        px.copy(atlas, ((row * size + y) * width + col * size + x) * 4, (srcY * image.width + srcX) * 4, (srcY * image.width + srcX) * 4 + 4);
      }
    }
  }
  const index = { schema: 1, size, kinds: FACE_KINDS, personas: rows.map(({ id, entry, npc }) => ({ id, recolor: entry.recolor ?? false, ...(npc ? { npc: true } : {}) })), variants: manifest.variants ?? {} };
  return { png: encodePng(width, height, atlas), json: `${JSON.stringify(index, null, 2)}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { png: image, json } = await buildFaces();
  if (process.argv.includes('--check')) {
    const same = async (name, data) => Buffer.from(data).equals(await readFile(new URL(name, DIR)).catch(() => Buffer.alloc(0)));
    if (!(await same('faces.png', image)) || !(await same('faces.json', json))) { console.error('faces.png/faces.json is out of date; run node scripts/build-faces.mjs'); process.exit(1); }
    console.log('Face thumbnails are up to date.');
  } else {
    await writeFile(new URL('faces.png', DIR), image);
    await writeFile(new URL('faces.json', DIR), json);
    console.log(`faces.png ${image.length} bytes`);
  }
}
