import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dashboardStrings, jsStrings, htmlStrings } from '../scripts/i18n-strings.mjs';
import { covers, pickLanguage, translate } from '../web/locale-core.mjs';
import { phrases, patterns, notShown } from '../web/messages-en.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every Korean text in the dashboard has an English translation or is marked as never shown', async () => {
  const hidden = new Set(notShown);
  const missing = [...(await dashboardStrings())].filter(([text]) => !covers(text) && !hidden.has(text)).map(([text, files]) => `${JSON.stringify(text)} (${[...files].join(', ')})`);
  assert.deepEqual(missing, [], `번역이 없는 화면 문구 ${missing.length}개 — web/messages-en.mjs에 추가하세요`);
});

test('translations keep their placeholders and contain no Korean', () => {
  const holes = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [source, target] of patterns) assert.equal(holes(target), holes(source), source);
  for (const [source, target] of [...Object.entries(phrases), ...patterns]) assert.doesNotMatch(target, /[가-힣]/, source);
});

test('translate: exact text, filled-in templates, joined pieces, and text it does not know', () => {
  assert.equal(translate('  대표  '), '  CEO  ', 'surrounding spaces stay');
  const [source, target] = patterns.find(([text]) => /^\{\w+\}명$/.test(text));
  assert.equal(translate(source.replace(/\{\w+\}/, '3')), target.replace(/\{\w+\}/, '3'));
  assert.equal(translate('대표 · 기획'), `${translate('대표')} · ${translate('기획')}`);
  assert.equal(translate('사람이 쓴 처음 보는 문장입니다'), '사람이 쓴 처음 보는 문장입니다');
  assert.equal(translate('already English'), 'already English');
});

test('the language is the address, then the saved choice, then the browser', () => {
  assert.equal(pickLanguage({ search: '?lang=en', saved: 'ko', browser: ['ko-KR'] }), 'en');
  assert.equal(pickLanguage({ search: '', saved: 'ko', browser: ['en-US'] }), 'ko');
  assert.equal(pickLanguage({ browser: ['ko-KR', 'en'] }), 'ko');
  assert.equal(pickLanguage({ browser: ['en-US'] }), 'en');
  assert.equal(pickLanguage({ search: '?lang=fr', browser: ['ja'] }), 'en');
});

test('every page loads the language first, and people’s writing is never translated', async () => {
  for (const page of ['index', 'home', 'chat', 'help', 'search', 'workflow-demo', 'office/index']) {
    const html = await readFile(`${root}web/${page}.html`, 'utf8');
    const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(scripts[0], '/locale.mjs', page);
  }
  const dom = await readFile(`${root}web/dom.mjs`, 'utf8');
  assert.match(dom, /richText[\s\S]*translate: 'no'/);
  assert.match(await readFile(`${root}web/index.html`, 'utf8'), /id="doc-body" translate="no"/);
  assert.match(await readFile(`${root}web/home.mjs`, 'utf8'), /message-body', translate: 'no'/);
  assert.match(await readFile(`${root}web/search.mjs`, 'utf8'), /search-snippet', translate: 'no'/);
});

test('the string scanner reads templates, escapes and HTML text', () => {
  assert.deepEqual(jsStrings("const a = '하나'; // '주석'\nconst b = `둘 ${n}개\\n줄`; const r = /'셋'/;"), ['하나', '둘 {0}개\n줄']);
  assert.deepEqual(htmlStrings('<p title="제목">본문 <code>x</code>를 실행</p><script>"스크립트"</script>'), ['제목', '본문', '를 실행']);
});
