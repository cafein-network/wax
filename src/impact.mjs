import { readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { gitRead, taskChanges } from './secrets.mjs';
import { dependencyChanges, depsPrompt } from './deps.mjs';

export const IMPACT_LIMITS = { changed: 500, tests: 2000, bytes: 32 * 1024 * 1024, shown: 30 };

const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/;
export const isTestPath = (path) => TEST_PATH.test(path) && !/(?:^|\/)(?:fixtures?|__snapshots__|node_modules)\//.test(path) && /\.(?:[cm]?[jt]sx?|py|go)$/.test(path);
const RUNNER = /(?:^|[\s/\\])(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?test(?::[\w-]+)?\b|node(?:\.exe)?\s(?:.*\s)?--test\b|vitest|jest|mocha|pytest|go\s+test)/;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const STEM = (path) => basename(path).replace(/(?:\.(?:test|spec))?\.[^.]+$/, '').replace(/^test_|_test$/, '').toLowerCase();
const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '/index.js', '/index.mjs', '/index.ts'];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

export function importedPaths(testPath, text) {
  const dir = posix.dirname(testPath);
  return [...text.matchAll(SPECIFIER)].map((match) => posix.normalize(posix.join(dir, match[1]))).filter((path) => !path.startsWith('..'));
}

export function commandCovers(command, testPath, testPaths) {
  const line = command.join(' ').replace(/\\/g, '/');
  if (line.includes(testPath) || command.some((arg) => arg.replace(/\\/g, '/').endsWith(`/${basename(testPath)}`) || arg === basename(testPath))) return true;
  const picksFiles = command.slice(1).some((arg) => { const path = arg.replace(/\\/g, '/').replace(/^\.\//, ''); return testPaths.has(path) || isTestPath(path); });
  return !picksFiles && RUNNER.test(line);
}

export function relateTests(changed, tests, proofs = []) {
  const testPaths = new Set(tests.map((test) => test.path));
  const resolveSet = new Map();
  for (const test of tests) resolveSet.set(test.path, new Set(importedPaths(test.path, test.text).flatMap((path) => EXTENSIONS.map((ext) => path + ext))));
  const related = new Map();
  const add = (test, file) => { if (!related.has(test)) related.set(test, new Set()); related.get(test).add(file); };
  const untested = [];
  for (const file of changed) {
    if (testPaths.has(file) || isTestPath(file)) { add(file, file); continue; }
    if (!SOURCE.test(file) && !/\.(?:py|go)$/.test(file)) continue;
    let found = false;
    for (const test of tests) {
      if (resolveSet.get(test.path).has(file) || (STEM(test.path) === STEM(file) && STEM(file).length > 2)) { add(test.path, file); found = true; }
    }
    if (!found) untested.push(file);
  }
  const runs = [...proofs].filter((proof) => proof.kind === 'test').sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    related: [...related].sort(([a], [b]) => a.localeCompare(b)).map(([test, because]) => {
      const proof = runs.filter((item) => commandCovers(item.command, test, testPaths)).at(-1);
      return { test, because: [...because].sort(), run: Boolean(proof), proofId: proof?.id ?? null, passed: proof ? proof.exitCode === 0 && !proof.timedOut : null };
    }),
    untested: untested.sort(),
  };
}

export async function changeImpact(root, feature) {
  const changes = await taskChanges(root, { base: feature.history?.find((event) => event.action === 'create')?.head });
  if (!changes.ok) return { state: 'unknown', reason: changes.reason, changed: 0, related: [], untested: [], more: 0 };
  const changed = [...changes.paths].map((path) => path.replace(/\\/g, '/'));
  if (changed.length > IMPACT_LIMITS.changed) return { state: 'unknown', reason: 'too-many-files', base: changes.base, changed: changed.length, related: [], untested: [], more: 0 };
  let tracked;
  try { tracked = (await gitRead(root, ['ls-files', '-z', '--', '.'])).toString('utf8').split('\0').filter(Boolean); }
  catch { return { state: 'unknown', reason: 'git-failed', base: changes.base, changed: changed.length, related: [], untested: [], more: 0 }; }
  const candidates = [...new Set([...tracked, ...changed])].filter(isTestPath);
  if (candidates.length > IMPACT_LIMITS.tests) return { state: 'unknown', reason: 'too-many-tests', base: changes.base, changed: changed.length, related: [], untested: [], more: 0 };
  const tests = [];
  let bytes = 0;
  for (const path of candidates) {
    let text;
    try { text = await readFile(join(root, path), 'utf8'); } catch { continue; }
    if ((bytes += text.length) > IMPACT_LIMITS.bytes) return { state: 'unknown', reason: 'too-large', base: changes.base, changed: changed.length, related: [], untested: [], more: 0 };
    tests.push({ path, text });
  }
  const proofs = (feature.proofs ?? []).filter((proof) => proof.iteration === feature.iteration);
  const { related, untested } = relateTests(changed, tests, proofs);
  return { state: 'ok', base: changes.base, changed: changed.length, related: related.slice(0, IMPACT_LIMITS.shown), untested: untested.slice(0, IMPACT_LIMITS.shown),
    more: Math.max(0, related.length - IMPACT_LIMITS.shown) + Math.max(0, untested.length - IMPACT_LIMITS.shown) };
}

export function impactPrompt(impact) {
  if (impact?.state !== 'ok') return '';
  const notRun = impact.related.filter((item) => !item.run);
  const failed = impact.related.filter((item) => item.run && item.passed === false);
  if (!notRun.length && !failed.length && !impact.untested.length) return '';
  const lines = ['변경 영향(관찰값, 판정 아님): 이 작업에서 바뀐 파일과 관련된 테스트 중 현재 주기 근거와 맞춰 본 결과입니다. 관련 있으면 CLI test로 실행해 근거를 남기고, 관련 없으면 검토 문서에 이유를 적으세요.'];
  if (notRun.length) lines.push(`- 돌리지 않은 관련 테스트: ${notRun.map((item) => `${item.test}(${item.because.join(', ')})`).join('; ')}`);
  if (failed.length) lines.push(`- 마지막 실행이 실패한 관련 테스트: ${failed.map((item) => item.test).join(', ')}`);
  if (impact.untested.length) lines.push(`- 관련 테스트를 찾지 못한 바뀐 소스: ${impact.untested.join(', ')}`);
  return lines.join('\n');
}

export async function reviewNotes(root, feature) {
  const [impact, deps] = await Promise.all([changeImpact(root, feature).catch(() => null), dependencyChanges(root, feature).catch(() => null)]);
  return [impactPrompt(impact), depsPrompt(deps)].filter(Boolean).join('\n\n');
}
