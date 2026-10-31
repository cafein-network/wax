#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const VERSION_FILES = [
  ['package.json', 1], ['plugin.json', 1], ['.claude-plugin/plugin.json', 1], ['.codex-plugin/plugin.json', 1],
  ['gemini-extension.json', 1], ['.claude-plugin/marketplace.json', 2], ['.github/plugin/marketplace.json', 2],
];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const newer = (next, current) => {
  const a = SEMVER.exec(next).slice(1).map(Number), b = SEMVER.exec(current).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

export async function bumpVersion(root, next, { date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!SEMVER.test(next ?? '')) throw new Error('새 버전을 0.13.8처럼 X.Y.Z 형식으로 지정하세요.');
  const current = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (!newer(next, current)) throw new Error(`새 버전 ${next}은(는) 현재 버전 ${current}보다 커야 합니다.`);
  const field = (version) => new RegExp(`("version"\\s*:\\s*)"${version.replaceAll('.', '\\.')}"`, 'g');
  const files = [];
  for (const [file, expected] of VERSION_FILES) {
    const text = await readFile(join(root, file), 'utf8');
    const found = text.match(field(current))?.length ?? 0;
    if (found !== expected) throw new Error(`${file}에서 버전 ${current}을(를) ${expected}곳 찾아야 하는데 ${found}곳 찾았습니다.`);
    files.push([file, text.replace(field(current), `$1"${next}"`)]);
  }
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  if (new RegExp(`^## ${next.replaceAll('.', '\\.')} `, 'm').test(changelog)) throw new Error(`CHANGELOG.md에 ${next} 항목이 이미 있습니다.`);
  if (!changelog.startsWith('# 변경 이력\n\n')) throw new Error('CHANGELOG.md가 "# 변경 이력" 제목으로 시작해야 합니다.');
  for (const [file, text] of files) await writeFile(join(root, file), text);
  await writeFile(join(root, 'CHANGELOG.md'), changelog.replace('# 변경 이력\n\n', `# 변경 이력\n\n## ${next} — ${date}\n\n`));
  return { from: current, to: next, files: VERSION_FILES.map(([file]) => file) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' } } });
  try {
    const result = await bumpVersion(values.root ?? fileURLToPath(new URL('../', import.meta.url)), positionals[0]);
    console.log(`${result.from} → ${result.to}: ${result.files.length}개 매니페스트를 바꾸고 CHANGELOG.md에 ${result.to} 항목을 열었습니다. 변경 내용을 적은 뒤 npm run check와 npm test를 실행하세요.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
