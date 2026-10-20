import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BIN, createTestSymlink, project } from './chat-helpers.mjs';
import { createFeature, getFeature, updateFeature } from '../src/workflow.mjs';
import { captureArtifact } from '../src/capture.mjs';
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
