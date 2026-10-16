import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
async function files(dir, ext) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path, ext));
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(path);
  }
  return out;
}

test('웹 UI는 HTML 문자열 삽입 API를 쓰지 않는다', async () => {
  for (const file of await files('web', ['.mjs', '.html'])) {
    const text = await readFile(join(root, file), 'utf8');
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, file);
    if (file.endsWith('.html')) assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/, `${file}: 인라인 스크립트 금지`);
  }
});

const networkCall = /\b(?:fetch|fetcher)\s*\(|\bglobalThis\s*\.\s*fetch\b|https?\.request\s*\(|node:https|from ['"]node:net['"]/;

test('네트워크 검사는 fetch 별칭과 전역 fetch도 감지한다', () => {
  for (const code of ['fetch(url)', 'fetcher (url)', 'globalThis.fetch(url)', 'const f = globalThis.fetch;', "import https from 'node:https'"]) assert.match(code, networkCall);
});

test('대시보드의 외부 조회는 공식 도구 소식 모듈에 한정하며 보고서는 자동 생성하지 않는다', async () => {
  for (const file of [...await files(join('src', 'chat'), ['.mjs']), ...await files('bin', ['.mjs'])]) {
    const text = await readFile(join(root, file), 'utf8');
    if (file !== join('src', 'chat', 'tool-news.mjs')) assert.doesNotMatch(text, networkCall, file);
    assert.doesNotMatch(text, /setInterval\([^)]*(digest|Report|daily)/i, file);
  }
  const server = await readFile(join(root, 'src', 'chat', 'server.mjs'), 'utf8');
  assert.doesNotMatch(server, /saveReport|saveDailyReport/, '서버는 보고서를 만들지 않는다');
});

test('플러그인은 런타임 의존성이 없다', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
