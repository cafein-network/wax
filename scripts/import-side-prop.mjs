import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';

const OUT = new URL('../web/office/side/', import.meta.url);

export function decodePng(buffer) {
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
      if (data[8] !== 8 || ![2, 6].includes(colorType) || data[12] !== 0) throw new Error('8비트 RGB/RGBA, 비인터레이스 PNG만 읽습니다.');
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3, stride = width * channels, raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0, b = y ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y ? pixels[(y - 1) * stride + i - channels] : 0;
      const paeth = () => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      const predict = [0, a, b, (a + b) >> 1, filter === 4 ? paeth() : 0][filter];
      pixels[y * stride + i] = (line[i] + predict) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) rgba[i * 4 + k] = pixels[i * channels + k];
    rgba[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3] : 255;
  }
  return { width, height, rgba };
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function removeBackground({ width, height, rgba }) {
  const isBackground = (i) => {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
    return (min >= 236 && max - min <= 14) || (min >= 80 && max - min <= 48 && b >= r);
  };
  const seen = new Uint8Array(width * height), stack = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || !isBackground(i)) continue;
    seen[i] = 1; rgba[i * 4 + 3] = 0;
    const x = i % width;
    if (x > 0) stack.push(i - 1); if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width); if (i < width * (height - 1)) stack.push(i + width);
  }
}

export function cropToContent({ width, height, rgba }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) throw new Error('배경을 지우고 나니 남은 그림이 없습니다.');
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) rgba.copy(out, y * w * 4, ((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4);
  return { width: w, height: h, rgba: out };
}

export function resize({ width, height, rgba }, targetWidth) {
  const w = targetWidth, h = Math.max(1, Math.round((height * targetWidth) / width)), out = Buffer.alloc(w * h * 4);
  const sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.min(height, Math.ceil((y + 1) * sy)); yy++) {
      for (let xx = Math.floor(x * sx); xx < Math.min(width, Math.ceil((x + 1) * sx)); xx++) {
        const i = (yy * width + xx) * 4, alpha = rgba[i + 3];
        r += rgba[i] * alpha; g += rgba[i + 1] * alpha; b += rgba[i + 2] * alpha; a += alpha; n++;
      }
    }
    const o = (y * w + x) * 4, coverage = a / n;
    if (coverage < 128) continue;
    out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = 255;
  }
  return { width: w, height: h, rgba: out };
}

export function removeStrays({ width: w, height: h, rgba }, { minPart = 0.02 } = {}) {
  const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] > 0;
  let removed = 0;
  for (let changed = true; changed;) {
    changed = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && opaque(x + dx, y + dy)) n++;
      if (n <= 2) { rgba[(y * w + x) * 4 + 3] = 0; removed++; changed = true; }
    }
  }
  const part = new Int32Array(w * h).fill(-1), sizes = [];
  for (let s = 0; s < w * h; s++) {
    if (!rgba[s * 4 + 3] || part[s] >= 0) continue;
    const id = sizes.length, stack = [s];
    let size = 0;
    part[s] = id;
    while (stack.length) {
      const q = stack.pop(), x = q % w, y = (q - x) / w;
      size++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const r = (y + dy) * w + x + dx;
        if (opaque(x + dx, y + dy) && part[r] < 0) { part[r] = id; stack.push(r); }
      }
    }
    sizes.push(size);
  }
  const minSize = Math.max(0, ...sizes) * minPart;
  for (let s = 0; s < w * h; s++) if (part[s] >= 0 && sizes[part[s]] < minSize) { rgba[s * 4 + 3] = 0; removed++; }
  return removed;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === '--strays') {
  for (const name of process.argv.slice(3)) {
    const url = new URL(`prop-${name}.png`, OUT);
    const image = decodePng(await readFile(url));
    const removed = removeStrays(image);
    await writeFile(url, encodePng(image.width, image.height, image.rgba));
    console.log(`prop-${name}.png 떠다니는 화소 ${removed}개 정리`);
  }
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const [source, name] = process.argv.slice(2);
  const width = Number(process.argv[process.argv.indexOf('--width') + 1]);
  if (!source || !/^[a-z0-9-]+$/.test(name ?? '') || !Number.isInteger(width) || width < 8) {
    console.error('사용: node scripts/import-side-prop.mjs <원본.png> <이름> --width <화면 폭(화소)>');
    process.exit(1);
  }
  const image = decodePng(await readFile(source));
  removeBackground(image);
  const sprite = resize(cropToContent(image), width);
  if (process.argv.includes('--strays')) removeStrays(sprite);
  await writeFile(new URL(`prop-${name}.png`, OUT), encodePng(sprite.width, sprite.height, sprite.rgba));
  const manifestUrl = new URL('manifest.json', OUT);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  manifest.props[name] = { file: `prop-${name}.png`, width: sprite.width, height: sprite.height, native: true };
  manifest.props = Object.fromEntries(Object.entries(manifest.props).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`prop-${name}.png ${sprite.width}×${sprite.height}`);
}
