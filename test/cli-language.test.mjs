import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliLanguage, cliText } from '../src/cli-locale.mjs';
import { run } from '../src/chat/cli.mjs';
import { covers } from '../web/locale-core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin/wax.mjs');
const HANGUL = /[가-힣]/;
const wax = (args, lang = {}) => {
  const env = { ...process.env };
  for (const key of ['WAX_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) delete env[key];
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...env, ...lang } });
};

test('the CLI language is WAX_LANG, then the locale variables, then Korean', () => {
  assert.equal(cliLanguage({}), 'ko');
  assert.equal(cliLanguage({ WAX_LANG: 'en' }), 'en');
  assert.equal(cliLanguage({ WAX_LANG: 'EN_us' }), 'en');
  assert.equal(cliLanguage({ WAX_LANG: 'ko', LANG: 'en_US.UTF-8' }), 'ko', 'WAX_LANG wins over the locale');
  assert.equal(cliLanguage({ WAX_LANG: 'fr', LANG: 'en_US.UTF-8' }), 'en', 'an unknown WAX_LANG falls back to the locale');
  assert.equal(cliLanguage({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(cliLanguage({ LANG: 'en' }), 'en');
  assert.equal(cliLanguage({ LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }), 'ko', 'LC_ALL comes first');
  assert.equal(cliLanguage({ LC_MESSAGES: 'en_GB.UTF-8', LANG: 'ko_KR.UTF-8' }), 'en', 'LC_MESSAGES before LANG');
  assert.equal(cliLanguage({ LC_ALL: '', LANG: 'en_US.UTF-8' }), 'en', 'an empty variable is skipped');
  assert.equal(cliLanguage({ LANG: 'C.UTF-8' }), 'ko');
  assert.equal(cliLanguage({ LANG: 'english' }), 'ko');
});

test('say picks the language and keeps values as given; localize translates Korean messages only in English', () => {
  const en = cliText('en'), ko = cliText('ko');
  assert.equal(en.say('cli.wiki.skipped', 3), 'Marked as done (3 in total).');
  assert.equal(ko.say('cli.wiki.skipped', 3), '반영한 것으로 표시했습니다(누적 3개).');
  assert.equal(en.say('cli.chat.memoSaved', 'm-1', '대표'), 'Memo saved (m-1). See the work notes with wax chat notes 대표.', 'names stay as written');
  assert.equal(en.localize('알 수 없는 명령: foo'), 'Unknown command: foo');
  assert.equal(ko.localize('알 수 없는 명령: foo'), '알 수 없는 명령: foo');
});

test('wax --help and errors follow the language; --json output does not', async () => {
  const korean = wax(['--help']), english = wax(['--help'], { WAX_LANG: 'en' });
  assert.match(korean.stdout, /기획에서 검증까지/);
  assert.match(english.stdout, /from planning to verification/);
  assert.doesNotMatch(english.stdout, HANGUL);
  assert.equal(korean.stdout.split('\n').length, english.stdout.split('\n').length, 'the same lines in both languages');
  assert.equal(wax(['--help'], { LANG: 'en_US.UTF-8' }).stdout, english.stdout, 'an English locale selects English');
  assert.equal(wax(['--help'], { LANG: 'en_US.UTF-8', WAX_LANG: 'ko' }).stdout, korean.stdout);

  const project = await mkdtemp(join(tmpdir(), 'wax-cli-language-'));
  try {
    assert.equal(wax(['status', 'missing', '--project', project]).stderr.trim(), 'wax: 작업 missing을 찾을 수 없습니다.');
    assert.equal(wax(['status', 'missing', '--project', project], { WAX_LANG: 'en' }).stderr.trim(), 'wax: Task missing not found.');
    assert.equal(wax(['nope'], { WAX_LANG: 'en' }).stderr.trim(), 'wax: Unknown command: nope. See --help.');
    const made = { ko: JSON.parse(wax(['start', 'one', '--title', '하나', '--project', project]).stdout), en: JSON.parse(wax(['start', 'two', '--title', '둘', '--project', project], { WAX_LANG: 'en' }).stdout) };
    assert.deepEqual(Object.keys(made.en), Object.keys(made.ko));
    assert.equal(made.en.title, '둘', 'records keep what was written');
    const list = (lang) => wax(['status', '--project', project], lang).stdout;
    assert.equal(list({ WAX_LANG: 'en' }), list({ WAX_LANG: 'ko' }), 'JSON output is the same in both languages');
    const search = wax(['search', 'status', '--json', '--project', project], { WAX_LANG: 'en' });
    assert.deepEqual(Object.keys(JSON.parse(search.stdout)), Object.keys(JSON.parse(wax(['search', 'status', '--json', '--project', project]).stdout)));

    let out = '';
    const io = { cwd: project, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
    await run(['--project', project, 'read', 'general'], { ...io, env: { WAX_LANG: 'en' } });
    assert.equal(out, '(no messages)\n');
    out = '';
    await run(['--project', project, 'read', 'general'], { ...io, env: {} });
    assert.equal(out, '(메시지 없음)\n');
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('every subcommand help has English', () => {
  for (const args of [['chat', '--help'], ['search', '--help'], ['wiki', '--help'], ['recall', '--help'], ['approvals', '--help']]) {
    const english = wax(args, { WAX_LANG: 'en' }), korean = wax(args);
    assert.ok(english.stdout.trim(), args.join(' '));
    assert.doesNotMatch(english.stdout.replaceAll('[근거:', ''), HANGUL, args.join(' '));
    assert.match(korean.stdout, HANGUL, args.join(' '));
  }
});

test('every Korean error message and CLI text has an English translation', async () => {
  const { jsStrings } = await import('../scripts/i18n-strings.mjs');
  const files = [...(await readdir(join(root, 'src'), { recursive: true })).filter((f) => f.endsWith('.mjs')).map((f) => `src/${f.replaceAll('\\', '/')}`), 'bin/wax.mjs'];
  const CLI = new Set(['bin/wax.mjs', 'src/chat/cli.mjs', 'src/search-cli.mjs', 'src/wiki-cli.mjs', 'src/approval-cli.mjs']);
  const missing = [];
  for (const file of files) {
    const code = await readFile(join(root, file), 'utf8');
    const thrown = [...code.matchAll(/\b(?:WaxError|UsageError|Error)\(\s*(['"`])[^\n]*/g)].flatMap((m) => jsStrings(m[0].slice(m[0].indexOf(m[1]))).slice(0, 1));
    const texts = CLI.has(file) ? jsStrings(code) : thrown;
    for (const text of texts) if (!covers(text)) missing.push(`${file}: ${JSON.stringify(text.slice(0, 80))}`);
  }
  assert.deepEqual(missing, [], '영어가 없는 CLI 문구 — web/messages-catalog.mjs에 ID로 넣고 t()·say()로 쓰세요');
});
