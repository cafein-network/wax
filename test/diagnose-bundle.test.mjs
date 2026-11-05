import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { BUNDLE_MARK, OMITTED, buildZip, crc32, makeBundle, recheckText, zipBundle } from '../src/diagnose-bundle.mjs';
import { diagnoseCli } from '../src/diagnose-cli.mjs';
import { diagnose } from '../src/diagnose.mjs';
import { jsonString, rewriteJsonStrings } from '../src/json-lines.mjs';
import { scrubContext, scrubText } from '../src/scrub.mjs';
import { bundleCommand } from '../web/diagnose-panel.mjs';

const GOAL = 'goal-0000abcd', OTHER = 'goal-ffff0000', FEATURE = 'shop-login';
const BASE = Date.parse('2026-11-05T00:00:00.000Z');
const iso = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
const SECRET = ['gh', 'p_', 'a1'.repeat(18)].join('');
const BEARER = ['Bearer ', 'x'.repeat(10), '.', 'y'.repeat(10)].join('');
const EMAIL = ['someone', '@', 'example.com'].join('');
const USER = 'zelda-user';
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const proofId = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

async function makeProject() {
  const base = await mkdtemp(path.join(tmpdir(), 'wax-bundle-'));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home', USER);
  const wax = (...parts) => path.join(root, '.wax', ...parts);
  for (const dir of [['features'], ['chat', 'pm-loop'], ['chat', 'snapshots', 'objects.git'], ['approvals'], ['usage']]) await mkdir(wax(...dir), { recursive: true });
  await mkdir(home, { recursive: true });
  const failing = (n, minutes) => ({ id: proofId(n), kind: 'test', phase: 'implement', iteration: 1, at: iso(minutes), command: ['node', '--test', 'test/login.test.mjs'], exitCode: 1,
    output: `not ok 1 - login\n  at ${root}/src/login.mjs:3 ${SECRET}`, durationMs: 9, tree: { head: 'a'.repeat(40), files: { 'src/login.mjs': 'c'.repeat(40) } } });
  const feature = { schemaVersion: 1, id: FEATURE, title: 'Login', description: `ask ${EMAIL}`, createdAt: iso(0), updatedAt: iso(90), iteration: 1, phase: 'implement', revision: 3,
    artifacts: { plan: `# Plan\n- AC-1: login works for ${home}` }, proofs: [failing(1, 20), failing(2, 25), failing(3, 30)],
    completed: { plan: { at: iso(5), evidence: `plan done in /srv/${USER}/x` } }, history: [{ action: 'create', phase: 'plan', at: iso(0) }, { action: 'complete', phase: 'plan', at: iso(5) }] };
  await writeFile(wax('features', `${FEATURE}.json`), `${JSON.stringify(feature, null, 2)}\n`);
  await writeFile(wax('chat', 'pm-loop', `${GOAL}.json`), `${JSON.stringify({ id: GOAL, title: 'Ship login', features: [FEATURE], state: 'stopped', stoppedBy: 'auto',
    stoppedReason: `stuck at ${root}`, stoppedAt: iso(95), createdAt: iso(0) }, null, 2)}\n`);
  await writeFile(wax('chat', 'pm-loop', `${OTHER}.json`), `${JSON.stringify({ id: OTHER, features: ['other'], state: 'running', createdAt: iso(0) }, null, 2)}\n`);
  const decision = (seq, minutes, fields) => JSON.stringify({ schema: 1, record: 'decision', id: `pd-${String(seq).padStart(6, '0')}-abcdef`, seq, goal: GOAL, ...fields, at: iso(minutes) });
  const log = [
    decision(1, 0, { kind: 'goal', outcome: 'created', by: 'ceo', reason: 'Ship login' }),
    decision(2, 15, { kind: 'worker', outcome: 'launched', worker: 'w-1', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, task: 't-1', by: 'auto' }),
    decision(3, 31, { kind: 'worker', outcome: 'failed', worker: 'w-1', tool: 'claude', feature: FEATURE, phase: 'implement', iteration: 1, task: 't-1', by: 'pm-loop', reason: 'failed',
      report: `I tried ${home}/notes`, output: { source: 'stderr', tail: `Error ${SECRET}\nAuthorization: ${BEARER}\nmail ${EMAIL}\nat ${root}/x \u202e`, bytes: 100, kept: 90, scrubbed: 0 } }),
    '{"schema":1,"seq":4, broken ' + SECRET,
    decision(5, 95, { kind: 'goal', outcome: 'stopped', by: 'auto', reason: `stuck at ${root}` }),
  ];
  await writeFile(wax('chat', 'pm-loop', `${GOAL}.jsonl`), `${log.join('\n')}\n`);
  const approval = (n, fields) => writeFile(wax('approvals', `${uuid(n)}.json`), `${JSON.stringify({ schema: 1, id: uuid(n), project: root, tool: 'claude', session: 's', callId: `c${n}`, action: 'Bash',
    details: { input: { command: `curl -H "x-api-token: ${'f'.repeat(48)}" https://h/x` } }, createdAt: BASE + 20 * 60_000, expiresAt: BASE + 80 * 60_000, secretHash: 'e'.repeat(64), events: [], goal: GOAL, ...fields }, null, 2)}\n`);
  await approval(1, { status: 'delivered', decision: 'allow', decidedBy: 'ceo', decidedAt: BASE + 35 * 60_000 });
  await approval(2, { status: 'pending', goal: OTHER });
  await writeFile(wax('chat', 'tool-health.jsonl'), `${[
    JSON.stringify({ schema: 1, record: 'tool-health', id: 'th-0', seq: 1, kind: 'failure', tool: 'codex', shape: 'quota', rule: 'r', goal: OTHER, excerpt: 'other goal text', at: iso(10) }),
    JSON.stringify({ schema: 1, record: 'tool-health', id: 'th-1', seq: 2, kind: 'failure', tool: 'codex', shape: 'quota', rule: 'codex-usage-limit', goal: GOAL, feature: FEATURE, excerpt: `quota ${EMAIL}`, at: iso(60) }),
  ].join('\n')}\n`);
  await writeFile(wax('.env'), `API_KEY=${SECRET}\n`);
  await writeFile(wax('usage', 'claude.json'), '{"never":"usage"}\n');
  await writeFile(wax('chat', 'snapshots', 'objects.git', 'pack'), 'never-snapshot-object');
  const context = scrubContext({ roots: [root], homes: [home], user: USER, env: {} });
  return { base, root, home, context };
}

async function readTree(dir) {
  const out = {};
  async function visit(abs, rel) {
    for (const name of (await readdir(abs)).sort()) {
      const child = path.join(abs, name), childRel = rel ? `${rel}/${name}` : name;
      if ((await lstat(child)).isDirectory()) await visit(child, childRel); else out[childRel] = await readFile(child);
    }
  }
  await visit(dir, '');
  return out;
}
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20), length = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + length).toString('utf8');
    assert.equal(flags & 0x0800, 0x0800, 'UTF-8 names');
    const localName = buffer.readUInt16LE(offset + 26), localExtra = buffer.readUInt16LE(offset + 28);
    const body = buffer.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, `crc ${name}`);
    files[name] = data;
    at += 46 + length + extra + comment;
  }
  return files;
}

test('rewriteJsonStrings: only strings change, every other byte and the line count stay, ranges and escapes', () => {
  const text = '{\n  "a": "x",\n  "list": [\n    1, true, null, "y"\n  ],\n  "n": -1.5e3\n}\n';
  const seen = [];
  const done = rewriteJsonStrings(text, (value, { parts, key, line }) => { seen.push([value, parts.join('.'), key, line]); return key ? value : `<${value}>\n\u202e`; }, { want: new Set(['/list', '/list/3', '/a']) });
  assert.equal(lineCount(done.text), lineCount(text));
  assert.equal(done.text, '{\n  "a": "<x>\\n\\u202e",\n  "list": [\n    1, true, null, "<y>\\n\\u202e"\n  ],\n  "n": -1.5e3\n}\n');
  assert.deepEqual(JSON.parse(done.text).list, [1, true, null, '<y>\n\u202e']);
  assert.deepEqual([...done.ranges], [['/a', [2, 2]], ['/list/3', [4, 4]], ['/list', [3, 5]]]);
  assert.deepEqual(seen.map((item) => item.slice(0, 3)), [['a', '', true], ['x', 'a', false], ['list', '', true], ['y', 'list.3', false], ['n', '', true]]);
  assert.throws(() => rewriteJsonStrings('{"a": "x", broken', () => 'z'), SyntaxError);
  assert.equal(jsonString('a\u2028b\u0085c\u{e0001}'), '"a\\u2028b\\u0085c\\udb40\\udc01"');
});

test('scrubText is idempotent, so the --zip second check does not flag what the bundle already scrubbed', () => {
  const context = scrubContext({ roots: ['/work/proj'], homes: ['/Users/zelda-user', 'C:\\Users\\zelda-user', 'C:\\Users\\ZELDA~1'], user: USER, env: {} });
  for (const sample of [`Authorization: ${BEARER}`, '"authorization": "token abc123"', 'Authorization: Basic Zm9vOmJhcg==', 'https://bob:pw@host/x?token=abc&code=1', `x-chat-token: ${'f'.repeat(64)}`,
    'password=hunter2', `key ${SECRET}`, `mail ${EMAIL}`, '/Users/zelda-user/proj', 'C:\\Users\\ZELDA~1\\x', 'c:/users/zelda-user/y', '/work/proj/src', `/srv/${USER}/x`,
    ['-----BEGIN ', 'RSA PRIVATE KEY-----\nabc\n-----END RSA ', 'PRIVATE KEY-----'].join('')]) {
    const once = scrubText(sample, context);
    assert.ok(once.count > 0, sample);
    assert.equal(scrubText(once.text, context).count, 0, `${sample} → ${once.text}`);
  }
});

test('bundle skeleton: report, cited lines at their own line numbers, bodies omitted, nothing leaks, nothing outside the records', async (t) => {
  const { base, root, home, context } = await makeProject();
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'out', 'bundle');
  await mkdir(path.dirname(dir));
  const done = await makeBundle(root, GOAL, dir, { context });
  assert.equal(done.level, 'skeleton');
  const tree = await readTree(dir);
  const names = Object.keys(tree);
  for (const name of ['README.txt', 'files.txt', 'scrub-log.txt', 'report.md', 'report.json']) assert.ok(names.includes(name), name);
  assert.ok(names.includes(`records/chat/pm-loop/${GOAL}.jsonl`) && names.includes(`records/features/${FEATURE}.json`), names.join(' '));
  assert.ok(names.every((name) => ['README.txt', 'files.txt', 'scrub-log.txt', 'report.md', 'report.json'].includes(name) || name.startsWith('records/')), names.join(' '));
  assert.ok(!names.some((name) => /\.env|usage|objects\.git|tool-health/.test(name) && !name.endsWith('tool-health.jsonl')), names.join(' '));
  assert.ok(!names.includes(`records/chat/pm-loop/${OTHER}.json`), 'the other goal is not in the bundle');
  const all = Object.values(tree).map((data) => data.toString('utf8')).join('\n');
  for (const leak of [SECRET, root, home, EMAIL, USER, 'x'.repeat(10), 'never-snapshot-object', '"never"', 'other goal text', 'e'.repeat(64), '\u202e']) assert.ok(!all.includes(leak), `leaked ${leak}`);
  const original = await readFile(path.join(root, '.wax', 'chat', 'pm-loop', `${GOAL}.jsonl`), 'utf8');
  const copy = tree[`records/chat/pm-loop/${GOAL}.jsonl`].toString('utf8');
  assert.equal(lineCount(copy), lineCount(original));
  const rows = copy.split('\n');
  assert.match(rows[2], /"outcome":"failed"/);
  assert.deepEqual(JSON.parse(rows[2]).output, { source: OMITTED, tail: OMITTED, bytes: 100, kept: 90, scrubbed: 0 }, 'the output tail is omitted at skeleton');
  assert.equal(JSON.parse(rows[2]).report, OMITTED);
  assert.equal(rows[3], OMITTED, 'a cited unreadable line is omitted at skeleton');
  assert.match(rows[4], /"outcome":"stopped".*<project>/);
  const report = JSON.parse(tree['report.json'].toString('utf8'));
  const cited = new Set(report.dimensions.flatMap((dimension) => dimension.findings.flatMap((item) => item.cites)).filter((cite) => cite.file === `.wax/chat/pm-loop/${GOAL}.jsonl`).map((cite) => cite.line));
  rows.slice(0, -1).forEach((row, index) => assert.equal(Boolean(row), cited.has(index + 1), `line ${index + 1}`));
  const featureCopy = tree[`records/features/${FEATURE}.json`].toString('utf8');
  const featureOriginal = await readFile(path.join(root, '.wax', 'features', `${FEATURE}.json`), 'utf8');
  assert.equal(lineCount(featureCopy), lineCount(featureOriginal));
  assert.match(featureCopy, /"output": "<omitted>"/);
  assert.doesNotMatch(featureCopy, /"artifacts"|AC-1/, 'uncited stage documents stay out');
  const proofLine = featureOriginal.split('\n').findIndex((row) => row.includes(`"id": "${proofId(1)}"`));
  assert.equal(featureCopy.split('\n')[proofLine], featureOriginal.split('\n')[proofLine]);
  assert.equal(report.bundle.level, 'skeleton');
  assert.match(tree['report.md'].toString('utf8'), /<secret:github-token>|<project>/);
  const readme = tree['README.txt'].toString('utf8');
  assert.equal(readme.split('\n')[0], BUNDLE_MARK);
  assert.match(readme, /skeleton/);
  assert.match(readme, /Claude Code/);
  assert.match(readme, new RegExp(`Node ${process.version.replace(/\./g, '\\.')}`));
  const log = tree['scrub-log.txt'].toString('utf8');
  assert.match(log, /secret:github-token\t\d+/);
  assert.match(log, /project\t\d+/);
  assert.ok(done.scrubbed > 0 && done.omitted > 0);
  const listed = tree['files.txt'].toString('utf8').split('\n').slice(1).filter(Boolean).map((row) => row.split('\t'));
  for (const [bytes, name] of listed) if (name !== 'files.txt') assert.equal(Number(bytes), tree[name].length, name);
  assert.deepEqual(listed.map(([, name]) => name).sort(), names.slice().sort());
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, 'report.md'))).mode & 0o777, 0o600);
  }
});

test('bundle levels: evidence keeps cited bodies (scrubbed), full keeps every line of this target but not other goals', async (t) => {
  const { base, root, context } = await makeProject();
  t.after(() => rm(base, { recursive: true, force: true }));
  await makeBundle(root, GOAL, path.join(base, 'evidence'), { level: 'evidence', context });
  const evidence = await readTree(path.join(base, 'evidence'));
  const row = JSON.parse(evidence[`records/chat/pm-loop/${GOAL}.jsonl`].toString('utf8').split('\n')[2]);
  assert.match(row.output.tail, /<secret:github-token>[\s\S]*Authorization: Bearer <token>[\s\S]*<email>[\s\S]*<project>\/x/);
  assert.match(evidence[`records/chat/pm-loop/${GOAL}.jsonl`].toString('utf8').split('\n')[3], /broken <secret:github-token>/);
  assert.ok(!Object.values(evidence).some((data) => data.toString('utf8').includes(SECRET)));

  await makeBundle(root, GOAL, path.join(base, 'full'), { level: 'full', context });
  const full = await readTree(path.join(base, 'full'));
  const feature = JSON.parse(full[`records/features/${FEATURE}.json`].toString('utf8'));
  assert.match(feature.artifacts.plan, /AC-1: login works for ~/);
  assert.equal(feature.completed.plan.evidence, 'plan done in /srv/<user>/x', 'the user name as a path part');
  assert.equal(feature.description, 'ask <email>');
  const approval = JSON.parse(full[`records/approvals/${uuid(1)}.json`].toString('utf8'));
  assert.match(approval.details.input.command, /x-api-token: <token>/, 'approval commands are kept from evidence on, scrubbed');
  assert.equal(approval.secretHash, OMITTED, 'secret-named fields are omitted at every level');
  assert.equal(approval.project, '<project>');
  assert.ok(!full[`records/approvals/${uuid(2)}.json`], 'the other goal’s approval is not included');
  const health = full['records/chat/tool-health.jsonl'].toString('utf8').split('\n');
  assert.equal(health[0], '', 'the other goal’s line of a shared log stays blank');
  assert.match(health[1], /"goal":"goal-0000abcd".*quota <email>/);
  for (const data of Object.values(full)) for (const leak of [SECRET, root, 'other goal text']) assert.ok(!data.toString('utf8').includes(leak), leak);

  await makeBundle(root, GOAL, path.join(base, 'mail'), { level: 'evidence', context: scrubContext({ ...context, roots: [root], homes: [...context.homes], user: USER, keepEmail: true, env: {} }) });
  const mail = await readTree(path.join(base, 'mail'));
  assert.ok(mail[`records/chat/pm-loop/${GOAL}.jsonl`].toString('utf8').includes(EMAIL), '--keep-email keeps emails');
});

test('bundle: a folder that exists, a link, inside .wax or .git, a missing parent or a bad level is refused and nothing is overwritten', async (t) => {
  const { base, root, context } = await makeProject();
  t.after(() => rm(base, { recursive: true, force: true }));
  const taken = path.join(base, 'taken');
  await mkdir(taken);
  await writeFile(path.join(taken, 'README.txt'), 'mine');
  await assert.rejects(makeBundle(root, GOAL, taken, { context }), /이미 있습니다/);
  assert.equal(await readFile(path.join(taken, 'README.txt'), 'utf8'), 'mine');
  const elsewhere = path.join(base, 'elsewhere');
  await mkdir(elsewhere);
  let linked = true;
  try { await symlink(elsewhere, path.join(base, 'link'), 'dir'); } catch { linked = false; }
  if (linked) {
    await assert.rejects(makeBundle(root, GOAL, path.join(base, 'link'), { context }), /이미 있습니다/);
    assert.deepEqual(await readdir(elsewhere), [], 'the link target stays empty');
  }
  await assert.rejects(makeBundle(root, GOAL, path.join(root, '.wax', 'bundle'), { context }), /\.wax/);
  await assert.rejects(makeBundle(root, GOAL, path.join(root, '.git', 'bundle'), { context }), /\.git/);
  await assert.rejects(makeBundle(root, GOAL, path.join(base, 'no', 'such', 'bundle'), { context }), /상위 폴더/);
  await assert.rejects(makeBundle(root, GOAL, path.join(base, 'x'), { level: 'everything', context }), /--level/);
  await assert.rejects(makeBundle(root, 'goal-12345678', path.join(base, 'y'), { context }), /찾지 못했습니다/);
  assert.equal(await lstat(path.join(base, 'y')).catch(() => null), null, 'no folder is made for a missing target');
});

test('zip: the second check refuses scrub-rule lines with their place and no value, links and non-bundles; a clean folder unzips to the same files', async (t) => {
  const { base, root, context } = await makeProject();
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'bundle');
  await makeBundle(root, GOAL, dir, { level: 'evidence', context });
  await writeFile(path.join(dir, '메모.txt'), '사람이 더한 설명\n');
  const done = await zipBundle(root, dir, { context, now: new Date(2026, 10, 5, 9, 30, 0) });
  assert.equal(done.zip, `${dir}.zip`);
  const files = unzip(await readFile(done.zip));
  const tree = await readTree(dir);
  assert.deepEqual(Object.keys(files).sort(), Object.keys(tree).map((name) => `wax-diagnose/${name}`).sort());
  for (const [name, data] of Object.entries(tree)) assert.ok(files[`wax-diagnose/${name}`].equals(data), name);
  await assert.rejects(zipBundle(root, dir, { context }), /이미 있습니다/, 'an existing ZIP is not overwritten');

  const dirty = path.join(base, 'dirty');
  await makeBundle(root, GOAL, dirty, { context });
  await writeFile(path.join(dirty, 'report.md'), `${await readFile(path.join(dirty, 'report.md'), 'utf8')}pasted ${SECRET} from ${root}\n`);
  const error = await zipBundle(root, dirty, { context }).catch((caught) => caught);
  assert.match(error.message, /report\.md:\d+ project,secret:github-token/);
  assert.ok(!error.message.includes(SECRET) && !error.message.includes(root));
  assert.equal(await lstat(`${dirty}.zip`).catch(() => null), null);
  assert.deepEqual(recheckText('a.txt', `ok\nmail ${EMAIL}`, context), [{ file: 'a.txt', line: 2, rules: ['email'] }]);
  assert.deepEqual(recheckText('a.txt', `mail ${EMAIL}`, scrubContext({ roots: [], homes: [], user: null, keepEmail: true, env: {} })), []);

  const plain = path.join(base, 'plain');
  await mkdir(plain);
  await writeFile(path.join(plain, 'README.txt'), 'not a bundle\n');
  await assert.rejects(zipBundle(root, plain, { context }), /묶음 폴더가 아닙니다/);
  const linkedDir = path.join(base, 'linked');
  await makeBundle(root, GOAL, linkedDir, { context });
  try { await symlink(path.join(root, '.wax', '.env'), path.join(linkedDir, 'env-link')); } catch { return; }
  await assert.rejects(zipBundle(root, linkedDir, { context }), /링크나 특수 파일.*env-link/);
});

test('zip: a full bundle with approval repeatKey and checks.key hashes zips, a token under a key-named field is scrubbed, a planted token still refuses', async (t) => {
  const { base, root, context } = await makeProject();
  t.after(() => rm(base, { recursive: true, force: true }));
  const HASH = 'ab12'.repeat(16), HASH2 = 'cd34'.repeat(16);
  const TOKEN = ['Zq', 'x9'.repeat(23)].join('');
  await writeFile(path.join(root, '.wax', 'approvals', `${uuid(3)}.json`), `${JSON.stringify({ schema: 1, id: uuid(3), project: root, tool: 'claude', session: 's', callId: 'c3', action: 'Bash',
    details: { input: { command: 'node --test', apiKey: TOKEN } }, createdAt: BASE + 21 * 60_000, expiresAt: BASE + 80 * 60_000, secretHash: 'e'.repeat(64), events: [], goal: GOAL,
    status: 'delivered', decision: 'allow', decidedBy: `goal-allow:${GOAL}`, decidedAt: BASE + 21 * 60_000, repeatKey: HASH, repeat: 1 }, null, 2)}\n`);
  const logFile = path.join(root, '.wax', 'chat', 'pm-loop', `${GOAL}.jsonl`);
  await writeFile(logFile, `${await readFile(logFile, 'utf8')}${JSON.stringify({ schema: 1, record: 'decision', id: 'pd-000006-abcdef', seq: 6, goal: GOAL, kind: 'worktree', outcome: 'checks', feature: FEATURE,
    checks: { seq: 1, key: HASH2, outcome: 'passed' }, rootCause: { attempt: 1, repeatKey: HASH }, at: iso(96) })}\n`);
  const dir = path.join(base, 'full');
  await makeBundle(root, GOAL, dir, { level: 'full', context });
  const approval = JSON.parse(await readFile(path.join(dir, 'records', 'approvals', `${uuid(3)}.json`), 'utf8'));
  assert.equal(approval.repeatKey, HASH, 'the repeat key hash is kept (not a secret)');
  assert.equal(approval.details.input.apiKey, '<token>', 'a token under a key-named field is scrubbed by the bundle, not only caught by --zip');
  assert.equal(approval.secretHash, OMITTED);
  const row = (await readFile(path.join(dir, 'records', 'chat', 'pm-loop', `${GOAL}.jsonl`), 'utf8')).split('\n').find((line) => line.includes('"checks"'));
  assert.deepEqual([JSON.parse(row).checks.key, JSON.parse(row).rootCause.repeatKey], [HASH2, HASH]);
  const done = await zipBundle(root, dir, { context });
  assert.ok(Object.keys(unzip(await readFile(done.zip))).includes(`wax-diagnose/records/approvals/${uuid(3)}.json`));

  const dirty = path.join(base, 'dirty');
  await makeBundle(root, GOAL, dirty, { level: 'full', context });
  const file = path.join(dirty, 'records', 'approvals', `${uuid(3)}.json`);
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(`"repeatKey": "${HASH}"`, `"repeatKey": "${TOKEN}", "sessionToken": "${TOKEN}", "apiKey": "${HASH}"`));
  const error = await zipBundle(root, dirty, { context }).catch((caught) => caught);
  const line = text.split('\n').findIndex((item) => item.includes('"repeatKey"')) + 1;
  assert.match(error.message, new RegExp(`approvals/${uuid(3)}\\.json:${line} token`));
  assert.ok(!error.message.includes(TOKEN));
  assert.equal(await lstat(`${dirty}.zip`).catch(() => null), null);

  assert.deepEqual(recheckText('a.json', `\n  "repeatKey": "${HASH}",\n\n`, context), []);
  assert.deepEqual(recheckText('a.json', `\n  "repeatKey": "${HASH}", "token": "${HASH}"\n`, context), [{ file: 'a.json', line: 2, rules: ['token'] }]);
  assert.deepEqual(recheckText('a.jsonl', `${JSON.stringify({ checks: { key: HASH } })}\n${JSON.stringify({ other: { key: HASH } })}\n{"broken": "key ${HASH}"\n`, context),
    [{ file: 'a.jsonl', line: 2, rules: ['token'] }, { file: 'a.jsonl', line: 3, rules: ['token'] }]);
  assert.deepEqual(recheckText('a.txt', `"repeatKey": "${HASH}"`, context), [{ file: 'a.txt', line: 1, rules: ['token'] }], 'text files get no exemption');
});

test('buildZip: stores what does not shrink, deflates the rest, UTF-8 names, CRC-32', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = buildZip([{ name: 'a/짧음.txt', data: Buffer.from('x') }, { name: 'b.txt', data: Buffer.from('y'.repeat(5000)) }, { name: 'empty', data: Buffer.alloc(0) }], new Date(2026, 0, 2, 3, 4, 6));
  const files = unzip(zip);
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, data.toString()])), { 'a/짧음.txt': 'x', 'b.txt': 'y'.repeat(5000), empty: '' });
  assert.equal(zip.readUInt16LE(8), 0, 'a one-byte file is stored');
  assert.ok(zip.length < 5000, 'the long file is deflated');
});

test('diagnose CLI: --bundle prints the file list and ends with the review line, --zip, usage errors and workers are refused', async (t) => {
  const { base, root } = await makeProject();
  t.after(() => rm(base, { recursive: true, force: true }));
  let text = '';
  const out = (chunk) => { text += chunk; };
  const dir = path.join(base, 'cli-bundle');
  await diagnoseCli(['--project', root, GOAL, '--bundle', dir], { out, env: {} });
  const lines = text.trim().split('\n');
  assert.match(lines[0], /진단 묶음을 썼습니다: .*cli-bundle \(수준 skeleton\)/);
  assert.ok(lines.some((line) => /^\s+\d+\s+README\.txt$/.test(line)));
  assert.ok(lines.some((line) => line.includes(`wax diagnose --zip ${dir}`)));
  assert.equal(lines.at(-1), '모든 파일을 열어 보고 공유하세요. 지우기는 빠뜨릴 수 있습니다.');
  text = '';
  await diagnoseCli(['--project', root, '--zip', dir], { out, env: {} });
  assert.match(text, /ZIP을 썼습니다: .*cli-bundle\.zip/);
  for (const args of [['--zip', dir, GOAL], [GOAL, '--level', 'full'], [GOAL, '--keep-email'], [GOAL, '--bundle', dir, '--json'], ['--zip', dir, '--level', 'full']]) {
    await assert.rejects(diagnoseCli(['--project', root, ...args], { out, env: {} }), /사용법/, args.join(' '));
  }
  await assert.rejects(diagnoseCli(['--project', root, GOAL, '--bundle', path.join(base, 'w')], { out, env: { WAX_WORKER: '1' } }), /사람이 터미널/);
  await assert.rejects(diagnoseCli(['--project', root, '--zip', dir], { out, env: { WAX_WORKER: '1' } }), /사람이 터미널/);
  text = '';
  await diagnoseCli(['--project', root, GOAL], { out, env: {} });
  assert.match(text, /^# wax 진단: goal-0000abcd/);
  assert.equal((await diagnose(root, GOAL)).target.id, GOAL);
});

test('dashboard: the copy line is the --bundle command into a new folder next to the project', () => {
  assert.equal(bundleCommand('goal-0000abcd'), 'wax diagnose goal-0000abcd --bundle ../wax-diagnose-goal-0000abcd');
});
