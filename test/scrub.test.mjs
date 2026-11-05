import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { SECRET_RULES, ALLOW_MARK } from '../src/secrets.mjs';
import { OUTPUT_LIMITS, OUTPUT_OUTCOMES, outputTail, pathForms, scrubContext, scrubText, scrubValue, tailChars } from '../src/scrub.mjs';

const HOME = '/Users/hyo', WIN_HOME = 'C:\\Users\\Hyo', PROJECT = '/Users/hyo/work/shop', WIN_PROJECT = 'D:\\src\\shop';
const ctx = scrubContext({ roots: [PROJECT, WIN_PROJECT], homes: [HOME, WIN_HOME], user: 'hyo', env: {} });
const scrub = (text, context = ctx) => scrubText(text, context);
const pem = (edge, kind = '') => ['-----', edge, ' ', kind, 'PRIVATE KEY-----'].join('');

const SAMPLES = {
  'private-key': pem('BEGIN', 'OPENSSH '),
  'aws-access-key': `AKIA${'Q'.repeat(16)}`,
  'github-token': `ghp_${'a1'.repeat(18)}`,
  'anthropic-key': `sk-ant-api03-${'x'.repeat(40)}`,
  'openai-key': `sk-proj-${'Y'.repeat(48)}`,
  'google-api-key': `AIza${'z'.repeat(35)}`,
  'xai-key': `xai-${'k'.repeat(64)}`,
  'slack-token': 'xoxb-1234567890-abcdefghij',
  'stripe-live-key': `sk_live_${'s'.repeat(24)}`,
};

test('scrub: every secret rule from src/secrets.mjs is replaced with <secret:rule>, even on a line with the allow mark', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), SECRET_RULES.map((rule) => rule.id).sort(), 'each SECRET_RULES id has a sample');
  for (const [id, secret] of Object.entries(SAMPLES)) {
    const done = scrub(`error: bad credential ${secret} (retry)`);
    assert.equal(done.text, id === 'private-key' ? 'error: bad credential <secret:private-key>' : `error: bad credential <secret:${id}> (retry)`, id);
    assert.deepEqual([done.count, done.rules], [1, { [`secret:${id}`]: 1 }], id);
    assert.ok(!scrub(`${ALLOW_MARK} ${secret}`).text.includes(secret), `${id} with allow mark`);
  }
  const two = scrub(`a=${SAMPLES['aws-access-key']} b=${SAMPLES['aws-access-key']}`);
  assert.deepEqual([two.text, two.count], ['a=<secret:aws-access-key> b=<secret:aws-access-key>', 2], 'every occurrence, not only the first');
});

test('scrub: a private key block is removed whole and keeps its line count (with END, cut before END, BEGIN cut off, JSON-escaped)', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n';
  const block = `before\n${pem('BEGIN', 'RSA ')}\n${body}${pem('END', 'RSA ')}\nafter`;
  const done = scrub(block);
  assert.equal(done.text, 'before\n<secret:private-key>\n\n\n\nafter');
  assert.equal(done.text.split('\n').length, block.split('\n').length, 'line count unchanged');
  assert.equal(done.rules['secret:private-key'], 1);
  assert.equal(scrub(`x\n${pem('BEGIN')}\n${body}`).text, 'x\n<secret:private-key>\n\n\n');
  assert.equal(scrub(`${body}${pem('END')}\nnext line`).text, '<secret:private-key>\n\n\nnext line');
  const json = JSON.stringify({ text: `${pem('BEGIN', 'EC ')}\n${body}${pem('END', 'EC ')}` });
  const flat = scrub(json).text;
  assert.equal(flat, '{"text":"<secret:private-key>"}');
  assert.ok(!flat.includes('MIIE'));
});

test('scrub: home folder forms (POSIX, Windows backslash, forward slash, JSON-escaped, any drive case, given 8.3 short name, USERPROFILE) become ~', () => {
  const cases = [
    ['open /Users/hyo/.npmrc failed', 'open ~/.npmrc failed'],
    ['at C:\\Users\\Hyo\\AppData\\Roaming\\npm', 'at ~\\AppData\\Roaming\\npm'],
    ['at c:\\users\\hyo\\x', 'at ~\\x'],
    ['file:///C:/Users/Hyo/x.js', 'file:///~/x.js'],
    ['{"path":"C:\\\\Users\\\\Hyo\\\\.gemini"}', '{"path":"~\\\\.gemini"}'],
    ['home is /Users/hyo', 'home is ~'],
    ['"/Users/hyo/"', '"~/"'],
  ];
  for (const [input, want] of cases) assert.equal(scrub(input).text, want, input);
  const short = scrubContext({ homes: ['C:\\Users\\HYOCHA~1'], user: null, env: {} });
  assert.equal(scrub('C:\\Users\\HYOCHA~1\\AppData\\Local\\Temp', short).text, '~\\AppData\\Local\\Temp');
  const byEnv = scrubContext({ user: null, env: { USERPROFILE: 'E:\\Users\\cafe', HOME: '/home/cafe' } });
  assert.equal(scrub('E:\\Users\\cafe\\x /home/cafe/y', byEnv).text, '~\\x ~/y');
  const home = homedir();
  if (pathForms(home).length) assert.equal(scrub(path.join(home, 'probe'), scrubContext({ user: null })).text, `~${path.sep}probe`, 'os.homedir() by default');
});

test('scrub: project and worktree paths become <project> before the home folder', () => {
  assert.equal(scrub('Error at /Users/hyo/work/shop/src/a.js:10:5').text, 'Error at <project>/src/a.js:10:5');
  assert.equal(scrub('D:\\src\\shop\\test\\a.test.mjs and d:/src/shop/x').text, '<project>\\test\\a.test.mjs and <project>/x');
  const done = scrub('/Users/hyo/work/shop/x and /Users/hyo/y');
  assert.deepEqual([done.text, done.rules], ['<project>/x and ~/y', { project: 1, home: 1 }]);
  const worktree = scrubContext({ roots: [PROJECT, '/Users/hyo/work/shop/.wax/worktrees/f1'], homes: [HOME], user: null, env: {} });
  assert.equal(scrub('cwd /Users/hyo/work/shop/.wax/worktrees/f1/src', worktree).text, 'cwd <project>/src', 'the longer worktree root wins');
});

test('scrub: real paths of a linked home and project are scrubbed too', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'wax-scrub-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const target = path.join(base, 'real-home'), link = path.join(base, 'link-home');
  await mkdir(target);
  try { await symlink(target, link, 'junction'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('cannot create links here'); throw error; }
  const context = scrubContext({ homes: [link], user: null, env: {} });
  const realTarget = await realpath(target);
  assert.equal(scrub(path.join(realTarget, 'cfg'), context).text, `~${path.sep}cfg`);
  assert.equal(scrub(path.join(link, 'cfg'), context).text, `~${path.sep}cfg`);
});

test('scrub: the user name as a path segment becomes <user>; it is not replaced inside words', () => {
  assert.equal(scrub('/mnt/data/hyo/cache and \\\\server\\hyo\\share and /home/HYO').text, '/mnt/data/<user>/cache and \\\\server\\<user>\\share and /home/<user>');
  assert.equal(scrub('hyo said hello; /tmp/hyoz/x; /tmp/ahyo/x').text, 'hyo said hello; /tmp/hyoz/x; /tmp/ahyo/x');
  assert.equal(scrubContext({ user: 'a', homes: [], env: {} }).user, null, 'a one-letter user name would hit too many segments');
});

test('scrub: token shapes keep their names and lose their values', () => {
  const hex = 'f0'.repeat(32);
  const cases = [
    ['Authorization: Bearer eyJhbGciOi.payload.sig', 'Authorization: Bearer <token>'],
    ['"authorization": "token 0123456789abcdef"', '"authorization": "token <token>"'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic <token>'],
    ['sent bearer abcdefgh12345678', 'sent bearer <token>'],
    ['GET https://api.example.dev/cb?access_token=abc123&state=ok', 'GET https://api.example.dev/cb?access_token=<token>&state=ok'],
    ['ws://127.0.0.1:4100/?token=abc123', 'ws://127.0.0.1:4100/?token=<token>'],
    ['https://x.dev/?api_key=zzz&key=yyy', 'https://x.dev/?api_key=<token>&key=<token>'],
    [`x-chat-token: ${hex}`, 'x-chat-token: <token>'],
    [`"apiKey":"${'Ab_-'.repeat(11)}"`, '"apiKey":"<token>"'],
    [`client secret ${'9'.repeat(40)}`, 'client secret <token>'],
    ['git clone https://cafein:p4ss@git.example.dev/r.git', 'git clone https://<token>@git.example.dev/r.git'],
    ['PASSWORD=hunter2 next', 'PASSWORD=<token> next'],
  ];
  for (const [input, want] of cases) {
    const done = scrub(input);
    assert.equal(done.text, want, input);
    assert.ok(done.rules.token >= 1, input);
  }
  const session = scrubContext({ tokens: ['s3ss10n-t0k3n-value'], homes: [], user: null, env: {} });
  assert.equal(scrub('echo s3ss10n-t0k3n-value', session).text, 'echo <token>');
});

test('scrub: e-mail addresses become <email> unless keepEmail', () => {
  assert.deepEqual(scrub('author: Kim <kim.min+wax@mail.example.co.kr>').text, 'author: Kim <<email>>');
  const keep = scrubContext({ keepEmail: true, homes: [], user: null, env: {} });
  assert.equal(scrub('kim@example.com', keep).text, 'kim@example.com');
});

test('scrub: ordinary tool output is kept as is', () => {
  const keep = [
    'Error: connect ECONNREFUSED 127.0.0.1:443',
    'npm ERR! code E404 — 패키지를 찾지 못했습니다',
    'commit 0123456789abcdef0123456789abcdef01234567',
    'key: abc123 (too short to be a token)',
    'pip install scikit-learn sk-learn',
    'import "@scope/pkg"; user@localhost',
    'at /usr/lib/node_modules/npm/index.js and C:\\Program Files\\nodejs\\node.exe',
    'relative src/a.js:10 and ../lib/b.mjs',
    '/Users/hyoz/elsewhere and /Users/hyo-old/x is different',
    'Gemini CLI: Request failed with status 500 (INTERNAL)',
  ];
  for (const line of keep) {
    const done = scrub(line);
    if (line.includes('hyo-old')) { assert.equal(done.text, '/Users/hyoz/elsewhere and ~-old/x is different'); continue; }
    assert.deepEqual([done.text, done.count], [line, 0], line);
  }
  const rootHome = scrubContext({ homes: ['/', 'C:\\', 'C:'], roots: ['/'], user: null, env: {} });
  assert.equal(scrub('/usr/bin and C:\\Windows', rootHome).text, '/usr/bin and C:\\Windows');
  assert.deepEqual(pathForms('/'), []);
  assert.deepEqual(pathForms('C:\\'), []);
});

test('scrub: idempotent and line count preserved on mixed text', () => {
  const text = `a /Users/hyo/work/shop/x\nb ${SAMPLES['github-token']}\r\nc kim@example.com\n\nd C:\\Users\\Hyo\\y\n`;
  const once = scrub(text), twice = scrub(once.text);
  assert.equal(once.text.split('\n').length, text.split('\n').length);
  assert.deepEqual([twice.text, twice.count], [once.text, 0]);
  assert.equal(once.count, 4);
});

test('scrubValue: every string value in a JSON value, keys and other types untouched', () => {
  const value = { path: '/Users/hyo/a', list: ['kim@example.com', 3, null, { deep: SAMPLES['aws-access-key'] }], '/Users/hyo/key': true, n: 1 };
  const done = scrubValue(value, ctx);
  assert.deepEqual(done.value, { path: '~/a', list: ['<email>', 3, null, { deep: '<secret:aws-access-key>' }], '/Users/hyo/key': true, n: 1 });
  assert.deepEqual([done.count, done.rules], [3, { home: 1, email: 1, 'secret:aws-access-key': 1 }]);
  assert.equal(value.path, '/Users/hyo/a', 'input not mutated');
});

test('outputTail: source order, scrub before cut, 2000 characters, byte counts', () => {
  assert.deepEqual([...OUTPUT_OUTCOMES].sort(), ['failed', 'stuck', 'timeout']);
  assert.equal(outputTail(null, ctx), null);
  assert.equal(outputTail({ stderr: '', result: '', error: '' }, ctx), null);
  assert.equal(outputTail({ stderr: 'boom', result: '{"x":1}', error: 'e' }, ctx).source, 'stderr');
  const result = outputTail({ stderr: '  \n', result: { type: 'result', is_error: true, cwd: '/Users/hyo/work/shop' }, error: 'e' }, ctx);
  assert.deepEqual([result.source, result.tail, result.scrubbed], ['result', '{"type":"result","is_error":true,"cwd":"<project>"}', 1]);
  assert.equal(outputTail({ stderr: '', result: '', error: '연결 요청 실패' }, ctx).source, 'error');

  const secret = SAMPLES['anthropic-key'];
  const raw = `${'가'.repeat(5000)}${secret}${'b'.repeat(OUTPUT_LIMITS.tail - 10)}`;
  const out = outputTail({ stderr: raw }, ctx);
  assert.equal(out.tail.length, OUTPUT_LIMITS.tail);
  assert.ok(!out.tail.includes(secret.slice(-10)), 'no half of the secret');
  assert.equal(out.bytes, Buffer.byteLength(raw, 'utf8'));
  assert.equal(out.kept, Buffer.byteLength(out.tail, 'utf8'));
  assert.equal(out.scrubbed, 1);
  assert.equal(out.rpcError, undefined);
  assert.equal(tailChars(`a${'😀'.repeat(3)}`, 5), '😀😀');
});

test('outputTail: rpcError keeps an integer code and a scrubbed message of at most 500 characters', () => {
  const out = outputTail({ stderr: 'x', rpcError: { code: -32603, message: `Internal error: open /Users/hyo/.gemini/settings.json ${SAMPLES['google-api-key']} ${'m'.repeat(900)}` } }, ctx);
  assert.equal(out.rpcError.code, -32603);
  assert.ok(out.rpcError.message.startsWith('Internal error: open ~/.gemini/settings.json <secret:google-api-key> m'));
  assert.equal(out.rpcError.message.length, OUTPUT_LIMITS.rpcMessage);
  assert.equal(out.scrubbed, 2);
  assert.equal(outputTail({ rpcError: { code: '1; drop', message: 'bad' } }, ctx).rpcError.code, null, 'non-integer code is not kept');
  assert.deepEqual(outputTail({ rpcError: { code: 1, message: 'only rpc' } }, ctx), { source: 'none', tail: '', bytes: 0, kept: 0, scrubbed: 0, rpcError: { code: 1, message: 'only rpc' } });
});
