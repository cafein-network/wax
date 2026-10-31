import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { BIN, createTestSymlink, project } from './chat-helpers.mjs';
import { createFeature, updateFeature } from '../src/workflow.mjs';
import { runTestProof } from '../src/evidence.mjs';
import { captureArtifact, captureImageFile } from '../src/capture.mjs';
import { compareCaptures, decodePng, pairCaptures, pixelDiff, pngInfo, renderCompareMarkdown } from '../src/visual-compare.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { createChatServer } from '../src/chat/server.mjs';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, tail]);
};
function encodePng(width, height, pixels, { colorType = 6, palette, bitDepth = 8 } = {}) {
  const channels = { 2: 3, 3: 1, 6: 4 }[colorType], stride = width * channels;
  const rows = [];
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const line = Uint8Array.from(pixels[y]), filter = y % 5, out = new Uint8Array(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      out[i + 1] = (line[i] - predictor) & 255;
    }
    rows.push(out); previous = line;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = bitDepth; ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const solid = (width, height, rgba, change = () => null) => encodePng(width, height,
  Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => change(x, y) ?? rgba).flat()));

test('pairCaptures pairs the same viewport, scroll and state and lists every unpaired side explicitly', () => {
  const shot = (artifact, labels, at = '2026-10-01T00:00:00.000Z') => ({ artifact, at, check: 'x', ...labels });
  const desktop = { viewport: '1280x800', scroll: 'top', state: 'default' }, tablet = { viewport: '768x1024', state: 'error' };
  let result = pairCaptures([shot('d1', desktop), shot('d1b', desktop, '2026-10-02T00:00:00.000Z'), shot('d2', tablet)], [shot('r2', tablet), shot('r1', desktop)]);
  assert.deepEqual(result.pairs.map((pair) => [pair.viewport, pair.baseline.artifact, pair.review.artifact]), [['768x1024', 'd2', 'r2'], ['1280x800', 'd1b', 'r1']]);
  assert.deepEqual([result.missingBaseline, result.notRecaptured, result.unlabeled], [[], [], { baseline: 0, review: 0 }]);
  result = pairCaptures([shot('d1', desktop)], [shot('r1', desktop), shot('r2', tablet), shot('r3', { ...desktop, state: 'hover' })]);
  assert.equal(result.pairs.length, 1);
  assert.deepEqual(result.missingBaseline.map((item) => [item.artifact, item.viewport, item.state]), [['r2', '768x1024', 'error'], ['r3', '1280x800', 'hover']]);
  result = pairCaptures([shot('d1', desktop), shot('d2', tablet)], [shot('r1', desktop)]);
  assert.deepEqual(result.notRecaptured.map((item) => item.artifact), ['d2']);
  assert.equal(result.notRecaptured[0].scroll, undefined, 'missing labels stay missing');
  result = pairCaptures([shot('old-d', {}), shot('d1', desktop)], [shot('old-r', {}), shot('old-r2', {}), shot('r1', desktop)]);
  assert.equal(result.pairs.length, 1);
  assert.deepEqual(result.unlabeled, { baseline: 1, review: 2 });
  assert.deepEqual([result.missingBaseline, result.notRecaptured], [[], []]);
  assert.deepEqual(pairCaptures(), { pairs: [], missingBaseline: [], notRecaptured: [], unlabeled: { baseline: 0, review: 0 } });
});

test('the PNG decoder restores every filter and pixelDiff reports a ratio, a size note or a skip', () => {
  const white = [255, 255, 255, 255], red = [255, 0, 0, 255];
  const a = solid(4, 5, white, (x, y) => (x === y ? [x * 40, y * 30, 7, 200] : null));
  const decoded = decodePng(a);
  assert.deepEqual([decoded.width, decoded.height], [4, 5]);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [0, 0, 7, 200]);
  assert.deepEqual([...decoded.data.subarray((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4)], [80, 60, 7, 200]);
  assert.deepEqual([...decoded.data.subarray(4, 8)], white);
  assert.deepEqual(pixelDiff(a, Buffer.from(a)), { state: 'compared', ratio: 0, differing: 0, total: 20, size: '4x5' });
  const b = solid(4, 5, white, (x, y) => (x === y ? [x * 40, y * 30, 7, 200] : y === 4 ? red : null));
  assert.deepEqual(pixelDiff(a, b), { state: 'compared', ratio: 4 / 20, differing: 4, total: 20, size: '4x5' });
  assert.deepEqual(pixelDiff(a, solid(4, 6, white)), { state: 'size', baseline: '4x5', review: '4x6' });
  const rgb = encodePng(2, 2, [[255, 0, 0, 0, 0, 255], [0, 255, 0, 255, 255, 255]], { colorType: 2 });
  const indexed = encodePng(2, 2, [[0, 1], [2, 3]], { colorType: 3, palette: [255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255] });
  assert.deepEqual(pixelDiff(rgb, indexed).ratio, 0);
  const real = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  assert.equal(decodePng(real).data.length, 4);
  assert.equal(decodePng(encodePng(1, 1, [[0, 0, 0, 0, 0, 0]], { colorType: 2, bitDepth: 16 })), null);
  assert.deepEqual(pixelDiff(Buffer.from('not a png at all, just some text bytes'), a), { state: 'skipped', reason: 'format' });
  assert.equal(pngInfo(Buffer.alloc(10)), null);
  const broken = Buffer.from(a); broken.fill(0, 40);
  assert.equal(decodePng(broken), null);
  assert.equal(pixelDiff(broken, Buffer.from(broken)).state, 'skipped');
});

async function reviewed(t, { reviewShots = true } = {}) {
  const root = await project(t);
  const id = 'site';
  await createFeature(root, { id, title: '홈 화면' });
  const put = async (name, png) => { await writeFile(join(root, name), png); return name; };
  const shoot = (check, file, labels) => captureArtifact(root, id, { check, file, ...labels });
  await updateFeature(root, id, 'save', { phase: 'plan', content: '- AC-1: 홈이 보인다 — 검증: 캡처' });
  await updateFeature(root, id, 'complete', { phase: 'plan', evidence: '범위' });
  const white = [255, 255, 255, 255];
  const desktop = { viewport: '1280x800', scroll: 'top', state: 'default' }, phone = { viewport: '390x844', scroll: 'top', state: 'default' }, wide = { viewport: '1920x1080', scroll: 'bottom' };
  await shoot('design-preview', await put('d-desktop.png', solid(4, 4, white)), desktop);
  await shoot('design-preview', await put('d-phone.png', solid(2, 4, white)), phone);
  await shoot('design-preview', await put('d-wide.png', solid(4, 2, white)), wide);
  await shoot('design-preview', await put('d-old.png', solid(1, 1, white)), {});
  await updateFeature(root, id, 'save', { phase: 'design', content: '# 설계' });
  await updateFeature(root, id, 'complete', { phase: 'design', evidence: '시안 캡처' });
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
  const proof = (await runTestProof(root, id, [process.execPath, '-e', 'process.exit(0)'])).proof;
  await updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현', proofIds: [proof.id] });
  if (reviewShots) {
    await shoot('ui-review', await put('r-desktop.png', solid(4, 4, white, (x, y) => (y === 0 && x < 2 ? [0, 0, 0, 255] : null))), desktop);
    await shoot('ui-review', await put('r-phone.png', solid(2, 5, white)), phone);
    await shoot('ui-review', await put('r-error.png', solid(2, 2, white)), { viewport: '768x1024', state: 'error' });
    await writeFile(join(root, 'r-video.mp4'), 'mp4');
  }
  return { root, id };
}

test('compareCaptures uses the latest design-preview captures of the iteration as the only baseline', async t => {
  const { root, id } = await reviewed(t);
  const compare = await compareCaptures(root, id);
  assert.deepEqual([compare.baseline, compare.review], [{ phase: 'design', iteration: 0, count: 4 }, { phase: 'review', iteration: 0, count: 3 }]);
  assert.deepEqual(compare.pairs.map((pair) => [pair.viewport, pair.diff]), [
    ['390x844', { state: 'size', baseline: '2x4', review: '2x5' }],
    ['1280x800', { state: 'compared', ratio: 2 / 16, differing: 2, total: 16, size: '4x4' }],
  ]);
  assert.deepEqual(compare.missingBaseline.map((item) => [item.viewport, item.state]), [['768x1024', 'error']]);
  assert.deepEqual(compare.notRecaptured.map((item) => [item.viewport, item.scroll]), [['1920x1080', 'bottom']]);
  assert.deepEqual(compare.unlabeled, { baseline: 1, review: 0 });
  assert.deepEqual(compare.counts, { pairs: 2, missingBaseline: 1, notRecaptured: 1 });
  assert.deepEqual(compare.handoffs, []);
  await mkdir(join(root, '.wax', 'design', 'jobs'), { recursive: true });
  await writeFile(join(root, '.wax', 'design', 'jobs', 'design-00000000-0000-4000-8000-000000000001.json'), JSON.stringify({ title: '홈', feature: id,
    handoff: { version: 2, doc: 'docs/wax/design/design-1/handoff-v2.md', preview: 'docs/wax/design/design-1/v2.png' } }));
  const withHandoff = await compareCaptures(root, id);
  assert.deepEqual(withHandoff.handoffs, [{ version: 2, doc: 'docs/wax/design/design-1/handoff-v2.md', preview: 'docs/wax/design/design-1/v2.png' }]);
  assert.equal(withHandoff.pairs.length, 2, 'the handoff image is not a paired baseline');
  assert.match(renderCompareMarkdown(withHandoff, 'en'), /Design handoff v2 preview `docs\/wax\/design\/design-1\/v2\.png` has no viewport, scroll or state labels, so it was not paired\./);
  await updateFeature(root, id, 'iterate', { reason: '간격 조정' });
  const next = await compareCaptures(root, id);
  assert.deepEqual([next.iteration, next.baseline.iteration, next.review.count, next.pairs.length, next.notRecaptured.length], [1, 0, 0, 0, 3]);
});

test('wax compare prints Markdown pairs and remaining differences (ko/en) and JSON, read-only', async t => {
  const { root, id } = await reviewed(t);
  const before = await readdir(join(root, '.wax', 'artifacts', id, 'review-0'));
  const run = (args, lang = 'ko') => spawnSync(process.execPath, [BIN, '--project', root, ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: lang } });
  const ko = run(['compare', id]);
  assert.equal(ko.status, 0, ko.stderr);
  assert.match(ko.stdout, /^# 시안 비교: 홈 화면/);
  assert.match(ko.stdout, /## 같은 조건 짝 2개/);
  assert.match(ko.stdout, /- 1280x800 · 스크롤 top · default — 다른 픽셀 12\.50% \(4x4\)/);
  assert.match(ko.stdout, /- 390x844 · 스크롤 top · default — 크기가 다름: 시안 2x4 \/ 구현 2x5/);
  assert.match(ko.stdout, /## 남은 차이[\s\S]*- 시안 없음: 768x1024 · error — `\.wax\/artifacts\/site\/review-0\/ui-review-/);
  assert.match(ko.stdout, /- 다시 캡처하지 않은 시안: 1920x1080 · 스크롤 bottom — /);
  assert.match(ko.stdout, /라벨 없는 캡처\(시안 1개, 구현 0개\)/);
  assert.match(ko.stdout, /일치 판정이 아닙니다/);
  assert.doesNotMatch(ko.stdout, /pixel-perfect|픽셀 일치/);
  const en = run(['compare', id], 'en');
  assert.match(en.stdout, /^# Design comparison: /);
  assert.match(en.stdout, /12\.50% of pixels differ \(4x4\)/);
  assert.match(en.stdout, /no baseline at 768x1024 · error/);
  assert.match(en.stdout, /baseline not re-captured: 1920x1080 · scroll bottom/);
  const json = JSON.parse(run(['compare', id, '--json']).stdout);
  assert.equal(json.pairs[0].baseline.artifact.startsWith('.wax/artifacts/site/design-0/design-preview-'), true);
  assert.equal(run(['compare']).status, 1);
  assert.match(run(['compare', id, '--out', 'x.md'], 'en').stderr, /Usage: compare <id> \[--json\]/);
  assert.deepEqual(await readdir(join(root, '.wax', 'artifacts', id, 'review-0')), before, 'compare writes nothing');
  const empty = await project(t, ['blank']);
  const markdown = renderCompareMarkdown(await compareCaptures(empty, 'blank'), 'en');
  assert.match(markdown, /no design captures/);
  assert.match(markdown, /No captures share the same labels/);
});

test('pr-body and the run trace carry a bounded visual comparison section', async t => {
  const { root, id } = await reviewed(t);
  const { body } = await buildPrBody(root, id, { language: 'en' });
  const section = body.slice(body.indexOf('### Visual comparison'));
  assert.match(section, /^### Visual comparison\n\n2 same-condition pairs · 1 without baseline · 1 baselines not re-captured\n\n- 390x844 · scroll top · default: size differs: design 2x4 \/ implementation 2x5\n- 1280x800 · scroll top · default: 12\.50% of pixels differ \(4x4\)\n- no baseline at 768x1024 · error\n- baseline not re-captured: 1920x1080 · scroll bottom\n\n_Pixel ratios are observations/);
  const trace = await buildRunTrace(root, id, { language: 'ko' });
  const review = trace.visits.find((visit) => visit.phase === 'review');
  assert.equal(review.compare.counts.pairs, 2);
  assert.equal(trace.visits.filter((visit) => visit.compare).length, 1);
  assert.match(trace.markdown, /### 시안 비교\n\n같은 조건 짝 2개 · 시안 없음 1개 · 다시 캡처하지 않은 시안 1개/);
  const plain = await project(t, ['plain']);
  assert.doesNotMatch((await buildPrBody(plain, 'plain')).body, /시안 비교/);
});

test('pr-body limits the comparison lines and points to wax compare for the rest', async t => {
  const root = await project(t, ['many']);
  const review = join(root, '.wax', 'artifacts', 'many', 'review-0');
  await mkdir(review, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const name = `ui-review-2026-10-01T00-00-00-${String(i).padStart(3, '0')}Z-${String(i).padStart(8, '0')}.png`;
    await writeFile(join(review, name), solid(1, 1, [i, i, i, 255]));
    await writeFile(join(review, `${name}.json`), JSON.stringify({ check: 'ui-review', viewport: `${400 + i}x800` }));
  }
  const { body } = await buildPrBody(root, 'many', { language: 'en' });
  const section = body.slice(body.indexOf('### Visual comparison'));
  assert.match(section, /^### Visual comparison\n\n0 same-condition pairs · 12 without baseline · 0 baselines not re-captured/);
  assert.equal(section.split('\n').filter((line) => line.startsWith('- no baseline at')).length, 8);
  assert.match(section, /_4 more: see `wax compare many`\._/);
});

test('the capture image route serves only stored capture images of that feature', async t => {
  const { root, id } = await reviewed(t);
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  t.after(() => server.shutdown());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const [name] = (await readdir(join(root, '.wax', 'artifacts', id, 'review-0'))).filter((file) => file.endsWith('.png'));
  const ok = await fetch(`${base}/api/features/${id}/captures/review-0/${name}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.ok(pngInfo(Buffer.from(await ok.arrayBuffer())));
  await writeFile(join(root, '.wax', 'artifacts', id, 'review-0', 'ui-review-2026-10-01T00-00-00-000Z-abcdef12.html'), '<script>alert(1)</script>');
  await writeFile(join(root, '.wax', 'artifacts', id, 'review-0', `${name}.json.png`), 'x');
  for (const path of [`review-0/${name}.json`, `review-0/ui-review-2026-10-01T00-00-00-000Z-abcdef12.html`, `review-0/${name}.json.png`, `review-9/${name}`, `other-0/${name}`,
    `review-0/..%2F..%2F..%2F..%2FREADME.png`, `..%2Freview-0/${name}`, `review-0/%2e%2e`]) {
    assert.equal((await fetch(`${base}/api/features/${id}/captures/${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/api/features/other/captures/review-0/${name}`)).status, 404);
  const outside = await project(t);
  await mkdir(join(outside, 'review-1'));
  await writeFile(join(outside, 'review-1', name), solid(1, 1, [0, 0, 0, 255]));
  if (!await createTestSymlink(t, join(outside, 'review-1'), join(root, '.wax', 'artifacts', id, 'review-1'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  assert.equal(await captureImageFile(root, id, 'review-1', name), null);
  assert.equal((await fetch(`${base}/api/features/${id}/captures/review-1/${name}`)).status, 404);
  if (process.platform !== 'win32') {
    await symlink(join(outside, 'review-1', name), join(root, '.wax', 'artifacts', id, 'review-0', name.replace(/[a-f0-9]{8}\.png$/, '00000000.png')));
    assert.equal(await captureImageFile(root, id, 'review-0', name.replace(/[a-f0-9]{8}\.png$/, '00000000.png')), null);
  }
  assert.ok(await captureImageFile(root, id, 'review-0', name));
});
