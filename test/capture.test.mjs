import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BIN, createTestSymlink, project } from './chat-helpers.mjs';
import { createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { captureArtifact, listCaptures } from '../src/capture.mjs';
import { buildPrBody } from '../src/pr-body.mjs';
import { buildRunTrace } from '../src/run-trace.mjs';
import { windowsCommandHint } from '../src/evidence.mjs';
import { artifactFile } from '../src/quality.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const writePng = (file) => [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64'))`];

test('capture runs the command without a shell, keeps the image under .wax/artifacts and satisfies the design preview check', async t => {
  const root = await project(t);
  let feature = await createFeature(root, { id: 'site', title: '웹 서비스 홈', projectType: 'web' });
  feature = await updateFeature(root, 'site', 'save', { phase: 'plan', content: '# 기획', revision: feature.revision });
  feature = await updateFeature(root, 'site', 'complete', { phase: 'plan', evidence: '픽스처', revision: feature.revision });
  const result = await captureArtifact(root, 'site', { check: 'design-preview', file: 'home.png', command: writePng('home.png'), revision: feature.revision });
  assert.match(result.artifact, /^\.wax\/artifacts\/site\/design-0\/design-preview-.+\.png$/);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await readFile(join(root, result.artifact)), png);
  assert.ok(await artifactFile(root, result.artifact, 'preview'));
  assert.equal((await getFeature(root, 'site')).revision, feature.revision, 'capture does not change the feature record');
  feature = await updateFeature(root, 'site', 'save', { phase: 'design', content: '# 설계', revision: feature.revision });
  feature = await updateFeature(root, 'site', 'complete', { phase: 'design', evidence: '시안 캡처', revision: feature.revision,
    checks: [{ id: 'design-preview', status: 'pass', detail: '모바일 캡처', artifact: result.artifact, proofIds: [] }] });
  assert.equal(feature.phase, 'implement');
});

test('capture rejects failed commands, files outside the project, non-captures, stale revisions and symlinked storage', async t => {
  const root = await project(t, ['site']);
  const feature = await getFeature(root, 'site');
  await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png', command: [process.execPath, '-e', 'process.exit(3)'] }), /캡처 명령이 실패했습니다\(종료 코드 3\)/);
  await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: 'missing.png' }), /캡처 파일을 확인하세요/);
  await writeFile(join(root, 'notes.html'), '<p>시안</p>');
  await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: 'notes.html' }), /캡처 파일을 확인하세요/);
  await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: '../outside.png' }), /캡처 파일을 확인하세요/);
  await assert.rejects(captureArtifact(root, 'site', { check: 'Bad', file: 'shot.png' }), /검증 항목 ID/);
  await writeFile(join(root, 'shot.png'), png);
  await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png', revision: feature.revision + 1 }), (error) => error.status === 409);
  assert.deepEqual((await readdir(join(root, '.wax'))).sort(), ['features']);
  const outside = await project(t);
  if (!await createTestSymlink(t, outside, join(root, '.wax', 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png' }), /일반 디렉터리/);
  assert.deepEqual(await readdir(outside), []);
});

test('wax capture CLI passes the command after -- and prints the artifact path', async t => {
  const root = await project(t, ['site']);
  await mkdir(join(root, 'shots'));
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, '--project', root, 'capture', 'site', '--check', 'ui-review', '--file', 'shots/a.png', '--', ...writePng('shots/a.png')], { cwd: root });
  const result = JSON.parse(stdout);
  assert.equal(result.check, 'ui-review');
  assert.ok(await artifactFile(root, result.artifact, 'visual'));
});

test('concurrent captures create the storage folders once and never collide on file names', async t => {
  const root = await project(t, ['site']);
  await writeFile(join(root, 'shot.png'), png);
  const results = await Promise.all(Array.from({ length: 8 }, () => captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png' })));
  assert.equal(new Set(results.map(r => r.artifact)).size, 8);
  assert.equal((await readdir(join(root, '.wax', 'artifacts', 'site', 'plan-0'))).length, 8);
});

test('Windows command failures explain that npm .cmd shims need the node entry point', () => {
  assert.match(windowsCommandHint(['npx', 'playwright', 'test'], 'win32'), /node node_modules\/@playwright\/test\/cli\.js/);
  assert.match(windowsCommandHint(['playwright-cli.cmd'], 'win32'), /\.cmd/);
  assert.equal(windowsCommandHint(['C:\\Program Files\\nodejs\\node.exe'], 'win32'), '');
  assert.equal(windowsCommandHint(['npx'], 'darwin'), '');
});

test('capture labels (viewport, scroll, state) are validated, kept next to the capture and old captures still list', async t => {
  const root = await project(t, ['site']);
  await writeFile(join(root, 'shot.png'), png);
  const old = await captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png' });
  assert.equal(old.viewport, undefined);
  const labelled = await captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png', viewport: '1920x1080', scroll: 'bottom', state: 'hover' });
  assert.deepEqual([labelled.viewport, labelled.scroll, labelled.state], ['1920x1080', 'bottom', 'hover']);
  assert.deepEqual(JSON.parse(await readFile(join(root, `${labelled.artifact}.json`), 'utf8')), { check: 'ui-review', viewport: '1920x1080', scroll: 'bottom', state: 'hover' });
  const pixel = await captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png', viewport: '360x800', scroll: '1200' });
  for (const [option, value] of [['viewport', '1280'], ['viewport', '0x800'], ['viewport', '20000x800'], ['scroll', '-5'], ['scroll', 'middle'], ['state', 'Hover'], ['state', 'a b'], ['state', 'x'.repeat(40)]]) {
    await assert.rejects(captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png', [option]: value }), new RegExp(`--${option}`), `${option}=${value}`);
  }
  const { captures, total } = await listCaptures(root, 'site', 'plan', 0);
  assert.equal(total, 3, 'rejected labels store nothing');
  const byPath = Object.fromEntries(captures.map((c) => [c.artifact, c]));
  assert.deepEqual(byPath[old.artifact], { artifact: old.artifact, check: 'ui-review', at: byPath[old.artifact].at });
  assert.ok(Number.isFinite(Date.parse(byPath[old.artifact].at)));
  assert.equal(byPath[labelled.artifact].state, 'hover');
  assert.deepEqual([byPath[pixel.artifact].viewport, byPath[pixel.artifact].scroll, byPath[pixel.artifact].state], ['360x800', '1200', undefined]);
  await writeFile(join(root, `${pixel.artifact}.json`), '{"viewport": "bad"');
  assert.equal((await listCaptures(root, 'site', 'plan', 0)).captures.find((c) => c.artifact === pixel.artifact).viewport, undefined);
  assert.deepEqual(await listCaptures(root, 'site', 'design', 0), { captures: [], total: 0 });
});

test('wax capture CLI takes --viewport, --scroll and --state and rejects a bad format', async t => {
  const root = await project(t, ['site']);
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [BIN, '--project', root, 'capture', 'site', '--check', 'ui-review', '--file', 'a.png', '--viewport', '768x1024', '--scroll', 'top', '--state', 'open', '--', ...writePng('a.png')], { cwd: root });
  assert.deepEqual((({ viewport, scroll, state }) => ({ viewport, scroll, state }))(JSON.parse(stdout)), { viewport: '768x1024', scroll: 'top', state: 'open' });
  await assert.rejects(run(process.execPath, [BIN, '--project', root, 'capture', 'site', '--check', 'ui-review', '--file', 'a.png', '--viewport', 'wide'], { cwd: root, env: { ...process.env, WAX_LANG: 'en' } }), (error) => /--viewport must be <width>x<height>/.test(error.stderr));
});

test('the PR body and the run trace list captures with their viewport, scroll and state labels', async t => {
  const root = await project(t, ['site']);
  await writeFile(join(root, 'shot.png'), png);
  const labelled = await captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png', viewport: '1280x800', scroll: 'top', state: 'error' });
  const plain = await captureArtifact(root, 'site', { check: 'ui-review', file: 'shot.png' });
  const { body } = await buildPrBody(root, 'site', { language: 'en' });
  assert.match(body, /### Screen captures/);
  assert.ok(body.includes(`- \`ui-review\` 1280x800 · scroll top · error — plan, \`${labelled.artifact}\``), body);
  assert.ok(body.includes(`- \`ui-review\` — plan, \`${plain.artifact}\``));
  assert.match((await buildPrBody(root, 'site', { language: 'ko' })).body, /### 화면 캡처[\s\S]*1280x800 · 스크롤 top · error/);
  const trace = await buildRunTrace(root, 'site', { language: 'en' });
  const visit = trace.visits.find((v) => v.phase === 'plan');
  assert.deepEqual(visit.captures.map((c) => c.artifact).sort(), [labelled.artifact, plain.artifact].sort());
  assert.equal(visit.captures.find((c) => c.artifact === labelled.artifact).viewport, '1280x800');
  assert.ok(trace.markdown.includes(`- \`ui-review\` 1280x800 · scroll top · error — \`${labelled.artifact}\``), trace.markdown);
  const bare = await project(t, ['site']);
  assert.doesNotMatch((await buildPrBody(bare, 'site', { language: 'en' })).body, /Screen captures/);
});

test('generated commands and skills carry the web width matrix guidance for every host', async () => {
  const files = ['design', 'review'].flatMap((command) => [`commands/${command}.md`, `commands/wax/${command}.toml`, `skills/${command}/SKILL.md`]);
  for (const name of files) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const phrase of ['360, 768, 1280 and one wider than the design width', '--viewport <WxH> --scroll <top|bottom|y> --state <default|hover|focus|open|loading|error|empty>',
      'scroll, click, hover or time', 'horizontal overflow', 'extension does not match the real format', 'font weights used are actually loaded', 'in order layout/geometry, missing elements, typography, cropping, spacing/motion, never claiming a pixel-perfect match', 'labels as design-preview', 'our own design is the only baseline', "this project's own screens"]) {
      assert.ok(text.includes(phrase), `${name}: ${phrase}`);
    }
  }
});
