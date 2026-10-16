
export const NOTE_COLORS = { opinion: '#f7d154', question: '#6fb7f2', answer: '#f29ac0', decision: '#7fd17a' };

const ZZ = ['#####', '...#.', '..#..', '.#...', '#####'];
function drawGlyph(ctx, rows, x, y, size, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  rows.forEach((row, ry) => [...row].forEach((cell, rx) => { if (cell === '#') ctx.fillRect(x + rx * size - 1, y + ry * size - 1, size + 2, size + 2); }));
  ctx.fillStyle = '#27342b';
  rows.forEach((row, ry) => [...row].forEach((cell, rx) => { if (cell === '#') ctx.fillRect(x + rx * size, y + ry * size, size, size); }));
  ctx.globalAlpha = 1;
}

export function drawZz(ctx, x, y, progress) {
  if (progress === null || progress === undefined) {
    drawGlyph(ctx, ZZ, x, y - 18, 3, 1);
    drawGlyph(ctx, ZZ, x + 20, y - 36, 2, 1);
    return;
  }
  for (let i = 0; i < 3; i++) {
    const p = (progress + i / 3) % 1;
    const alpha = p < 0.15 ? p / 0.15 : p > 0.75 ? (1 - p) / 0.25 : 1;
    drawGlyph(ctx, ZZ, Math.round(x + p * 26), Math.round(y - 10 - p * 46), p < 0.4 ? 2 : 3, alpha);
  }
}


const PART_KEYS = [null, 'jacket', 'hair', 'skin', 'pants'];
const dressCache = new Map();
const rgb2hsl = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return [(h + 360) % 360, s, l];
};
const hsl2rgb = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); };
  return [f(0), f(8), f(4)];
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
export function dressed(info, look) {
  if (!info?.image) return null;
  if (!look || !info.mask || typeof document === 'undefined' || !PART_KEYS.some((key) => key && look[key])) return info.image;
  const key = PART_KEYS.map((part) => (part && look[part] ? JSON.stringify(look[part]) : '')).join('|');
  let byLook = dressCache.get(info.image);
  if (!byLook) dressCache.set(info.image, byLook = new Map());
  if (byLook.has(key)) return byLook.get(key);
  const { width, height } = info;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  try {
    c.drawImage(info.mask, 0, 0);
    const mask = c.getImageData(0, 0, width, height).data;
    c.clearRect(0, 0, width, height);
    c.drawImage(info.image, 0, 0);
    const data = c.getImageData(0, 0, width, height);
    const px = data.data;
    const sum = PART_KEYS.map(() => [0, 0, 0]);
    for (let i = 0; i < px.length; i += 4) {
      const part = mask[i + 3] ? mask[i] : 0;
      if (part < 2 || !px[i + 3]) continue;
      const [, s, l] = rgb2hsl(px[i], px[i + 1], px[i + 2]);
      sum[part][0] += s; sum[part][1] += l; sum[part][2] += 1;
    }
    const own = sum.map(([s, l, n]) => (n ? { s: s / n, l: l / n } : null));
    for (let i = 0; i < px.length; i += 4) {
      const part = mask[i + 3] ? PART_KEYS[mask[i]] : null;
      const to = part && look[part];
      if (!to || !px[i + 3]) continue;
      const [, s, l] = rgb2hsl(px[i], px[i + 1], px[i + 2]);
      let rgb;
      if (part === 'jacket') rgb = hsl2rgb(to.hue, clamp01(s * (to.saturation ?? 1)), clamp01(l + (to.lightness ?? 0)));
      else {
        const base = own[mask[i]];
        rgb = hsl2rgb(to.h, clamp01(to.s + (s - base.s) * 0.5), clamp01(to.l + (l - base.l) * 0.55));
      }
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
    }
    c.putImageData(data, 0, 0);
  } catch { return info.image; }
  byLook.set(key, canvas);
  return canvas;
}
