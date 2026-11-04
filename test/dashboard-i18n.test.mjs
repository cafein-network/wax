import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dashboardStrings, jsStrings, htmlStrings } from '../scripts/i18n-strings.mjs';
import { covers, message, pickLanguage, translate } from '../web/locale-core.mjs';
import { phrases, patterns, notShown } from '../web/messages-en.mjs';
import { messages, t } from '../web/messages-catalog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every Korean text in the dashboard has an English translation or is marked as never shown', async () => {
  const hidden = new Set(notShown);
  const missing = [...(await dashboardStrings())].filter(([text]) => !covers(text) && !hidden.has(text)).map(([text, files]) => `${JSON.stringify(text)} (${[...files].join(', ')})`);
  assert.deepEqual(missing, [], `번역이 없는 화면 문구 ${missing.length}개 — web/messages-catalog.mjs에 ID로 추가하고 t('ID')로 쓰세요`);
});

test('every translation is still used by the dashboard or by server messages it shows', async () => {
  const { readdir } = await import('node:fs/promises');
  const texts = [...(await dashboardStrings()).keys()];
  for (const file of await readdir(new URL('../src/', import.meta.url), { recursive: true })) {
    if (file.endsWith('.mjs')) texts.push(...jsStrings(await readFile(new URL(`../src/${file.replaceAll('\\', '/')}`, import.meta.url), 'utf8')));
  }
  texts.push(...Object.values(messages).map(([source]) => source));
  const all = texts.join('\n');
  const unused = Object.keys(phrases).filter((key) => !all.includes(key));
  assert.deepEqual(unused, [], `쓰이지 않는 번역 ${unused.length}개 — web/messages-en.mjs에서 지우세요`);
});

test('translations keep their placeholders and contain no Korean', () => {
  const holes = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join();
  for (const [source, target] of [...patterns, ...Object.values(messages)]) assert.equal(holes(target), holes(source), source);
  for (const [source, target] of [...Object.entries(phrases), ...patterns, ...Object.values(messages)]) assert.doesNotMatch(target.replaceAll('[근거:', ''), /[가-힣]/, source);
});

async function codeFiles() {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const dir of ['web', 'src', 'bin']) {
    for (const file of await readdir(`${root}${dir}`, { recursive: true })) {
      if (file.endsWith('.mjs') && !/messages-[a-z]+\.mjs$/.test(file)) out.push([`${dir}/${file.replaceAll('\\', '/')}`, await readFile(`${root}${dir}/${file}`, 'utf8')]);
    }
  }
  return out;
}

test('every message ID in the code is in the catalog, and every catalog ID is used', async () => {
  const files = await codeFiles();
  const missing = files.flatMap(([file, code]) => [...code.matchAll(/\b(?:t|say)\(\s*'([^']+)'/g)].map((m) => m[1]).filter((id) => !messages[id]).map((id) => `${id} (${file})`));
  assert.deepEqual(missing, [], '번역표에 없는 ID — web/messages-catalog.mjs에 추가하세요');
  const all = files.map(([, code]) => code).join('\n');
  const unused = Object.keys(messages).filter((id) => !all.includes(`'${id}'`));
  assert.deepEqual(unused, [], `쓰이지 않는 ID ${unused.length}개 — web/messages-catalog.mjs에서 지우세요`);
  for (const id of Object.keys(messages)) assert.match(id, /^[a-z][\w]*(\.[a-z][\w]*)+$/i, id);
});

test('the same Korean text has one English translation in both tables', () => {
  const normal = (source, target) => {
    const names = (source.match(/\{\w+\}/g) ?? []);
    return [source.trim().replace(/\{\w+\}/g, '{}'), target.replace(/\{\w+\}/g, (hole) => `{${names.indexOf(hole)}}`)];
  };
  const seen = new Map([...Object.entries(phrases), ...patterns].map(([source, target]) => { const [key, value] = normal(source, target); return [key, [value, 'messages-en.mjs']]; }));
  for (const [id, [source, target]] of Object.entries(messages)) {
    const [key, value] = normal(source, target), before = seen.get(key);
    if (before) assert.equal(value, before[0], `${id}: ${JSON.stringify(source)} is ${JSON.stringify(before[0])} in ${before[1]}`);
    else seen.set(key, [value, id]);
  }
});

test('message IDs give Korean to draw and English on request, with values filled once', () => {
  const [id] = Object.entries(messages).find(([, [source]]) => source === '{0}초');
  assert.equal(t(id, 3), '3초');
  assert.equal(message('en', id, 3), '3s');
  assert.equal(message('ko', id, '{0}'), '{0}초', 'a value is not filled again');
  assert.equal(translate(t(id, 3)), '3s', 'the screen translates what t() drew');
  const [replyTo] = Object.entries(messages).find(([, [source]]) => source === '↳ {0}에게 답장: {1}');
  assert.equal(message('en', replyTo, '대표', '사람이 쓴 답'), '↳ Reply to CEO: 사람이 쓴 답', 'values are translated when known');
  assert.equal(t('no.such.id'), 'no.such.id');
});

test('translate: exact text, filled-in templates, joined pieces, and text it does not know', () => {
  assert.equal(translate('  대표  '), '  CEO  ', 'surrounding spaces stay');
  const [source, target] = patterns.find(([text]) => /^\{\w+\}명$/.test(text));
  assert.equal(translate(source.replace(/\{\w+\}/, '3')), target.replace(/\{\w+\}/, '3'));
  assert.equal(translate('대표 · 기획'), `${translate('대표')} · ${translate('기획')}`);
  assert.equal(translate('사람이 쓴 처음 보는 문장입니다'), '사람이 쓴 처음 보는 문장입니다');
  assert.equal(translate('already English'), 'already English');
  assert.equal(translate('나'), 'Me', 'the request author label is a person, not the word "or"');
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
