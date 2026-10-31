import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { getFeature, LABELS } from './workflow.mjs';
import { artifactFile } from './quality.mjs';
import { captureLabelText, listCaptures } from './capture.mjs';
import { code, inline } from './pr-body.mjs';
import { cliText } from './cli-locale.mjs';

export const COMPARE_LIMITS = { captures: 200, pairs: 40, unpaired: 20, pixels: 25_000_000, cache: 200 };
const LABEL_NAMES = ['viewport', 'scroll', 'state'];
const labelsOf = (capture) => Object.fromEntries(LABEL_NAMES.filter((name) => capture?.[name] !== undefined).map((name) => [name, capture[name]]));
const keyOf = (capture) => LABEL_NAMES.map((name) => capture?.[name] ?? '').join('|');
const KEY_ORDER = (a, b) => a.localeCompare(b, 'en', { numeric: true });

export function pairCaptures(baseline = [], review = []) {
  const latest = (captures) => {
    const map = new Map();
    let unlabeled = 0;
    for (const capture of captures) {
      if (!LABEL_NAMES.some((name) => capture?.[name] !== undefined)) { unlabeled += 1; continue; }
      const key = keyOf(capture), seen = map.get(key);
      if (!seen || String(capture.at ?? '') >= String(seen.at ?? '')) map.set(key, capture);
    }
    return { map, unlabeled };
  };
  const base = latest(baseline), shot = latest(review);
  const pick = (capture) => ({ artifact: capture.artifact, at: capture.at ?? null });
  const pairs = [], missingBaseline = [], notRecaptured = [];
  for (const key of [...shot.map.keys()].sort(KEY_ORDER)) {
    const capture = shot.map.get(key), match = base.map.get(key);
    if (match) pairs.push({ ...labelsOf(capture), baseline: pick(match), review: pick(capture) });
    else missingBaseline.push({ ...labelsOf(capture), ...pick(capture) });
  }
  for (const key of [...base.map.keys()].sort(KEY_ORDER)) if (!shot.map.has(key)) notRecaptured.push({ ...labelsOf(base.map.get(key)), ...pick(base.map.get(key)) });
  return { pairs, missingBaseline, notRecaptured, unlabeled: { baseline: base.unlabeled, review: shot.unlabeled } };
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function pngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE) || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bitDepth: buffer[24], colorType: buffer[25], interlace: buffer[28] };
}

export function decodePng(buffer, maxPixels = COMPARE_LIMITS.pixels) {
  const info = pngInfo(buffer);
  const channels = CHANNELS[info?.colorType];
  if (!info || info.bitDepth !== 8 || info.interlace !== 0 || !channels || !info.width || !info.height || info.width * info.height > maxPixels) return null;
  const idat = [];
  let palette = null, alpha = null;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8), end = offset + 8 + length;
    if (end + 4 > buffer.length) return null;
    const data = buffer.subarray(offset + 8, end);
    if (type === 'IDAT') idat.push(data); else if (type === 'PLTE') palette = data; else if (type === 'tRNS') alpha = data; else if (type === 'IEND') break;
    offset = end + 4;
  }
  if (info.colorType === 3 && !palette) return null;
  const stride = info.width * channels, size = (stride + 1) * info.height;
  let raw;
  const stream = Buffer.concat(idat);
  if (stream.length < 3 || (stream[0] & 0x0f) !== 8) return null;
  try { raw = inflateRawSync(stream.subarray(2), { maxOutputLength: size }); } catch { return null; }
  if (raw.length !== size) return null;
  const out = new Uint8Array(info.width * info.height * 4);
  let previous = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (stride + 1)], start = y * (stride + 1) + 1;
    if (filter > 4) return null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a; else if (filter === 2) predictor = b; else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (raw[start + i] + predictor) & 255;
    }
    for (let x = 0, o = y * info.width * 4; x < info.width; x += 1, o += 4) {
      const s = x * channels;
      if (info.colorType === 3) { const index = line[s]; out[o] = palette[index * 3] ?? 0; out[o + 1] = palette[index * 3 + 1] ?? 0; out[o + 2] = palette[index * 3 + 2] ?? 0; out[o + 3] = alpha?.[index] ?? 255; }
      else if (channels <= 2) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = channels === 2 ? line[s + 1] : 255; }
      else { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = channels === 4 ? line[s + 3] : 255; }
    }
    [previous, line] = [line, previous];
  }
  return { width: info.width, height: info.height, data: out };
}

export function pixelDiff(baseline, review) {
  const a = pngInfo(baseline), b = pngInfo(review);
  if (!a || !b) return { state: 'skipped', reason: 'format' };
  if (a.width !== b.width || a.height !== b.height) return { state: 'size', baseline: `${a.width}x${a.height}`, review: `${b.width}x${b.height}` };
  if (a.width * a.height > COMPARE_LIMITS.pixels) return { state: 'skipped', reason: 'large' };
  const left = decodePng(baseline), right = decodePng(review);
  if (!left || !right) return { state: 'skipped', reason: 'format' };
  const x = new Uint32Array(left.data.buffer), y = new Uint32Array(right.data.buffer);
  let differing = 0;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) differing += 1;
  return { state: 'compared', ratio: differing / x.length, differing, total: x.length, size: `${a.width}x${a.height}` };
}

const cache = new Map();
async function diffFiles(root, baseline, review) {
  const key = `${root}\0${baseline}\0${review}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  if (extname(baseline).toLowerCase() !== '.png' || extname(review).toLowerCase() !== '.png') result = { state: 'skipped', reason: 'format' };
  else {
    const [left, right] = await Promise.all([artifactFile(root, baseline, 'visual'), artifactFile(root, review, 'visual')]);
    result = left && right ? pixelDiff(await readFile(left), await readFile(right)) : { state: 'skipped', reason: 'missing' };
  }
  if (result.reason !== 'missing') { cache.set(key, result); if (cache.size > COMPARE_LIMITS.cache) cache.delete(cache.keys().next().value); }
  return result;
}

export async function compareCaptures(root, id, { iteration, diff = true, handoffs = true } = {}) {
  const feature = await getFeature(root, id);
  const at = Number.isSafeInteger(iteration) && iteration >= 0 ? iteration : feature.iteration;
  const review = (await listCaptures(root, feature.id, 'review', at, COMPARE_LIMITS.captures)).captures.filter((capture) => capture.check === 'ui-review');
  let baseline = [], baselineIteration = null;
  for (let k = at; k >= 0 && baselineIteration === null; k -= 1) {
    const found = (await listCaptures(root, feature.id, 'design', k, COMPARE_LIMITS.captures)).captures.filter((capture) => capture.check === 'design-preview');
    if (found.length) { baseline = found; baselineIteration = k; }
  }
  const paired = pairCaptures(baseline, review);
  const pairs = paired.pairs.slice(0, COMPARE_LIMITS.pairs);
  if (diff) for (const pair of pairs) pair.diff = await diffFiles(root, pair.baseline.artifact, pair.review.artifact);
  let references = [];
  if (handoffs) {
    try {
      const { designHandoffs } = await import('./chat/design.mjs');
      references = (await designHandoffs(root, feature.id)).filter((item) => typeof item.preview === 'string').slice(0, 5).map((item) => ({ version: item.version, doc: item.doc, preview: item.preview }));
    } catch { references = []; }
  }
  return {
    id: feature.id, title: feature.title, iteration: at,
    baseline: { phase: 'design', iteration: baselineIteration, count: baseline.length }, review: { phase: 'review', iteration: at, count: review.length },
    pairs, omittedPairs: paired.pairs.length - pairs.length,
    missingBaseline: paired.missingBaseline.slice(0, COMPARE_LIMITS.unpaired), notRecaptured: paired.notRecaptured.slice(0, COMPARE_LIMITS.unpaired),
    omittedUnpaired: Math.max(0, paired.missingBaseline.length - COMPARE_LIMITS.unpaired) + Math.max(0, paired.notRecaptured.length - COMPARE_LIMITS.unpaired),
    counts: { pairs: paired.pairs.length, missingBaseline: paired.missingBaseline.length, notRecaptured: paired.notRecaptured.length },
    unlabeled: paired.unlabeled, handoffs: references,
  };
}

export function diffText(diff, say) {
  if (!diff) return '';
  if (diff.state === 'compared') return say('compare.ratio', (diff.ratio * 100).toFixed(2), diff.size);
  if (diff.state === 'size') return say('compare.sizeDiffers', diff.baseline, diff.review);
  return say(diff.reason === 'large' ? 'compare.skippedLarge' : diff.reason === 'missing' ? 'compare.skippedMissing' : 'compare.skippedFormat');
}

export const unpairedText = (item, kind, say) => say(kind === 'missing' ? 'compare.noBaseline' : 'compare.notRecaptured', captureLabelText(item, say));

export const hasComparison = (compare) => Boolean(compare && (compare.baseline.count || compare.review.count));

export function compareLines(compare, say, limit = 8) {
  const { counts } = compare;
  const lines = [say('compare.summary', counts.pairs, counts.missingBaseline, counts.notRecaptured), ''];
  for (const pair of compare.pairs.slice(0, limit)) lines.push(`- ${inline(captureLabelText(pair, say), 80)}: ${pair.diff ? diffText(pair.diff, say) : '-'}`);
  const unpaired = [...compare.missingBaseline.map((item) => unpairedText(item, 'missing', say)), ...compare.notRecaptured.map((item) => unpairedText(item, 'stale', say))];
  for (const text of unpaired.slice(0, limit)) lines.push(`- ${inline(text, 120)}`);
  const hidden = Math.max(0, counts.pairs - limit) + Math.max(0, counts.missingBaseline + counts.notRecaptured - limit);
  if (hidden) lines.push(say('compare.more', hidden, code(`wax compare ${compare.id}`)));
  lines.push('', say('compare.note'));
  return lines;
}

export function renderCompareMarkdown(compare, language = cliText().language) {
  const { say } = cliText(language);
  const phase = (name) => (language === 'en' ? name : LABELS[name] ?? name);
  const lines = [`# ${say('compare.heading', inline(compare.title ?? compare.id))}`, '', say('compare.generated', code(`wax compare ${compare.id}`)), ''];
  lines.push(say('compare.sides', compare.baseline.iteration === null ? say('compare.noBaselineCaptures') : `${phase('design')} · ${say('trace.iteration', compare.baseline.iteration)} · ${code('design-preview')} ${compare.baseline.count}`,
    `${phase('review')} · ${say('trace.iteration', compare.review.iteration)} · ${code('ui-review')} ${compare.review.count}`), '', say('compare.note'));
  lines.push('', `## ${say('compare.pairs', compare.counts.pairs)}`, '');
  if (!compare.pairs.length) lines.push(say('compare.noPairs'));
  for (const pair of compare.pairs) {
    lines.push(`- ${inline(captureLabelText(pair, say), 80)}${pair.diff ? ` — ${diffText(pair.diff, say)}` : ''}`,
      `  - ${say('compare.baseline')}: ${code(pair.baseline.artifact, 200)}`, `  - ${say('compare.implementation')}: ${code(pair.review.artifact, 200)}`);
  }
  if (compare.omittedPairs) lines.push(say('compare.omitted', compare.omittedPairs));
  lines.push('', `## ${say('compare.remaining')}`, '');
  const remaining = [
    ...compare.pairs.filter((pair) => pair.diff && (pair.diff.state === 'size' || (pair.diff.state === 'compared' && pair.diff.differing > 0))).map((pair) => `- ${inline(captureLabelText(pair, say), 80)}: ${diffText(pair.diff, say)}`),
    ...compare.missingBaseline.map((item) => `- ${inline(unpairedText(item, 'missing', say), 120)} — ${code(item.artifact, 200)}`),
    ...compare.notRecaptured.map((item) => `- ${inline(unpairedText(item, 'stale', say), 120)} — ${code(item.artifact, 200)}`),
  ];
  if (compare.omittedUnpaired) remaining.push(say('compare.omitted', compare.omittedUnpaired));
  if (compare.unlabeled.baseline || compare.unlabeled.review) remaining.push(`- ${say('compare.unlabeled', compare.unlabeled.baseline, compare.unlabeled.review)}`);
  for (const item of compare.handoffs) remaining.push(`- ${say('compare.handoff', item.version, code(item.preview, 200))}`);
  lines.push(...(remaining.length ? remaining : [say('compare.noRemaining')]));
  lines.push('', '---', say('compare.footer'));
  return `${lines.join('\n')}\n`;
}
