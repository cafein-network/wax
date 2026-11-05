import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addedLines, findingText, mask, mergeSecretScans, scanLine, scanSecrets, secretScanMode, sensitiveFile, validSecretScan } from '../src/secrets.mjs';
import { createFeature, featureSecrets, getFeature, updateFeature, validateStored } from '../src/workflow.mjs';
import { characteristicEvidence } from '../src/quality-report.mjs';

const CLI = fileURLToPath(new URL('../bin/wax.mjs', import.meta.url));
const join2 = (...parts) => parts.join('');
const KEYS = {
  aws: join2('AKIA', 'IOSFODNN7', 'EXAMPLE'),
  github: join2('ghp_', 'a'.repeat(36)),
  anthropic: join2('sk-', 'ant-api03-', 'b'.repeat(40)),
  openai: join2('sk-', 'proj-', 'c'.repeat(48)),
  google: join2('AIza', 'd'.repeat(35)),
  slack: join2('xox', 'b-1234567890-abcdef'),
  stripe: join2('sk_', 'live_', 'e'.repeat(24)),
  pem: join2('-----BEGIN ', 'RSA PRIVATE KEY-----'),
};

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'wax-secrets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  await writeFile(join(root, '.gitignore'), '.wax/\nignored.env\n');
  await writeFile(join(root, 'app.js'), `const key = '${KEYS.aws}';\n`);
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  return { root, git, commit: (message = 'change') => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message); } };
}
async function toImplement(root, id = 'pay') {
  await createFeature(root, { id, title: '결제', projectType: 'general' });
  for (const phase of ['plan', 'design']) {
    await updateFeature(root, id, 'save', { phase, content: `# ${phase}` });
    await updateFeature(root, id, 'complete', { phase, evidence: '확인' });
  }
  await updateFeature(root, id, 'save', { phase: 'implement', content: '# 구현' });
}
const completeImplement = (root, id = 'pay') => updateFeature(root, id, 'complete', { phase: 'implement', evidence: '구현', waiver: '단계 진행만 확인' });

test('rules match known key formats only, and the preview never shows more than 4 characters', () => {
  for (const [name, key] of Object.entries(KEYS)) assert.equal(scanLine(`x = "${key}"`).length, 1, name);
  assert.deepEqual(scanLine(`k = '${KEYS.anthropic}'`).map((item) => item.rule), ['anthropic-key'], 'an Anthropic key is not also an OpenAI key');
  assert.deepEqual(scanLine(`a=${KEYS.aws} b=${KEYS.github}`).map((item) => item.rule).sort(), ['aws-access-key', 'github-token']);
  assert.deepEqual(scanLine(`const k = '${KEYS.github}'; // wax-secrets: allow`), []);
  for (const safe of ['const apiKey = process.env.API_KEY;', 'sk-short', 'AKIA1234', 'password = "hunter2hunter2hunter2"', '-----BEGIN PUBLIC KEY-----', 'ghp_short']) assert.deepEqual(scanLine(safe), [], safe);
  assert.equal(mask(KEYS.github), 'ghp_…');
  assert.ok(scanLine(KEYS.openai).every((item) => item.preview.length <= 5));
});

test('sensitive file names, and only lines new since the base count', () => {
  assert.equal(sensitiveFile('.env'), 'env-file');
  assert.equal(sensitiveFile('config/.env.production'), 'env-file');
  assert.equal(sensitiveFile('.env.example'), null);
  assert.equal(sensitiveFile('keys/server.pem'), 'key-file');
  assert.equal(sensitiveFile('id_ed25519'), 'key-file');
  assert.equal(sensitiveFile('id_ed25519.pub'), null);
  assert.equal(sensitiveFile('src/app.js'), null);
  assert.deepEqual(addedLines('a\nb\n', 'a\nx\nb\ny\n'), [{ line: 2, text: 'x' }, { line: 4, text: 'y' }]);
  assert.deepEqual(addedLines(null, 'a\r\nb'), [{ line: 1, text: 'a' }, { line: 2, text: 'b' }]);
  assert.equal(secretScanMode(undefined), 'enforce');
  assert.equal(secretScanMode('warn'), 'warn');
  assert.throws(() => secretScanMode('loud'), /WAX_SECRET_SCAN/);
});

test('scan covers committed and uncommitted changes since the base, but not old lines, ignored files or local .wax/', async (t) => {
  const { root, git, commit } = await repo(t);
  const base = git('rev-parse', 'HEAD').trim();
  assert.deepEqual(await scanSecrets(root, { base }), { state: 'clean', base, files: 0, findings: [], more: 0 });

  await writeFile(join(root, 'committed.js'), `export const token = '${KEYS.github}';\n`); commit();
  await writeFile(join(root, 'app.js'), `const key = '${KEYS.aws}';\nconst other = '${KEYS.stripe}';\n`);
  await writeFile(join(root, 'new.txt'), `${KEYS.pem}\n`);
  await writeFile(join(root, '.env'), 'X=1\n');
  await writeFile(join(root, 'ignored.env'), `K=${KEYS.openai}\n`);
  await mkdir(join(root, '.wax'), { recursive: true });
  await writeFile(join(root, '.wax', 'local.json'), `"${KEYS.github}"`);
  await writeFile(join(root, 'test.js'), `const fake = '${KEYS.google}'; // wax-secrets: allow\n`);

  const scan = await scanSecrets(root, { base });
  assert.equal(scan.state, 'found');
  assert.deepEqual(scan.findings.map(({ file, line, rule }) => [file, line ?? null, rule]).sort(), [
    ['.env', null, 'env-file'], ['app.js', 2, 'stripe-live-key'], ['committed.js', 1, 'github-token'], ['new.txt', 1, 'private-key']].sort());
  assert.ok(validSecretScan(scan));
  assert.doesNotMatch(JSON.stringify(scan), new RegExp(KEYS.github.slice(4)), 'the value itself is never kept');

  await writeFile(join(root, 'docs-allow.txt'), '');
  await mkdir(join(root, 'docs', 'wax'), { recursive: true });
  await writeFile(join(root, 'docs', 'wax', 'secrets-allow.txt'), '# 예시 파일\n.env\nnew.txt\n');
  const allowed = await scanSecrets(root, { base });
  assert.deepEqual(allowed.findings.map((item) => item.file).sort(), ['app.js', 'committed.js']);

  git('add', '-f', '.wax/local.json');
  assert.ok((await scanSecrets(root, { base })).findings.some((item) => item.file === '.wax/local.json' && item.rule === 'wax-record'));
  assert.equal((await scanSecrets(join(tmpdir()), {})).state, 'unknown');
});

test('implement completion is refused while a secret is present; warn records it; off skips it', async (t) => {
  const { root } = await repo(t);
  await toImplement(root);
  await writeFile(join(root, 'client.js'), `fetch(url, { headers: { 'x-api-key': '${KEYS.anthropic}' } });\n`);

  await assert.rejects(completeImplement(root), (error) => error.status === 409 && /client\.js:1 anthropic-key sk-a…/.test(error.message) && !error.message.includes(KEYS.anthropic));
  assert.equal((await getFeature(root, 'pay')).phase, 'implement', 'nothing was written');

  t.after(() => { delete process.env.WAX_SECRET_SCAN; });
  process.env.WAX_SECRET_SCAN = 'warn';
  const warned = await completeImplement(root);
  assert.equal(warned.completed.implement.secretScan.state, 'found');
  assert.deepEqual(warned.completed.implement.secretScan.findings, [{ file: 'client.js', line: 1, rule: 'anthropic-key', preview: 'sk-a…' }]);
  assert.doesNotThrow(() => validateStored(warned));
  const security = characteristicEvidence(warned).find((item) => item.id === 'security');
  assert.deepEqual([security.pass, security.fail], [0, 1]);

  await toImplement(root, 'other');
  process.env.WAX_SECRET_SCAN = 'off';
  assert.equal((await completeImplement(root, 'other')).completed.implement.secretScan, undefined);
});

test('a clean scan is recorded and counts as security evidence; non-Git projects record nothing', async (t) => {
  const { root } = await repo(t);
  await toImplement(root);
  await writeFile(join(root, 'client.js'), 'fetch(url, { headers: { "x-api-key": process.env.API_KEY } });\n');
  const done = await completeImplement(root);
  assert.equal(done.completed.implement.secretScan.state, 'clean');
  assert.equal(done.completed.implement.secretScan.files, 1);
  assert.equal(characteristicEvidence(done).find((item) => item.id === 'security').pass, 1);

  const plain = await mkdtemp(join(tmpdir(), 'wax-secrets-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await toImplement(plain);
  assert.equal((await completeImplement(plain)).completed.implement.secretScan, undefined);
});

test('CLI secrets reports masked findings and exits 1', async (t) => {
  const { root } = await repo(t);
  await createFeature(root, { id: 'pay', title: '결제' });
  const run = (...args) => spawnSync(process.execPath, [CLI, '--project', root, 'secrets', ...args], { encoding: 'utf8', env: { ...process.env, WAX_LANG: 'ko' } });
  let out = run('pay');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /찾은 것 없음/);
  await writeFile(join(root, 'cfg.js'), `module.exports = '${KEYS.slack}';\n`);
  out = run('pay');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /1건을 찾았습니다[\s\S]*- cfg\.js:1 slack-token xoxb…[\s\S]*폐기하고 새로 발급/);
  assert.ok(!out.stdout.includes(KEYS.slack));
  const json = JSON.parse(run('pay', '--json').stdout);
  assert.equal(json.findings[0].rule, 'slack-token');
  assert.match(run().stderr, /사용법: secrets <id>/);
  assert.match(await readFile(join(root, 'cfg.js'), 'utf8'), /xoxb/, 'the scan never edits files');
});

async function worktree(root, { goal = 'goal-0000000a', feature = 'pay', n = 1 } = {}) {
  const real = await realpath(root);
  const id = `${goal}-${n}`, branch = `wax/${goal}/${feature}-${n}`, path = join(real, '.wax', 'worktrees', id);
  await mkdir(join(real, '.wax', 'chat'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, path, 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { schema: 1, seq: n, id, goal, feature, branch, path, base: null, port: null, env: [], setup: null, state: 'active', at: new Date().toISOString(), by: '대표' };
  await appendFile(join(real, '.wax', 'chat', 'worktrees.jsonl'), `${JSON.stringify(record)}\n`);
  return { id, branch, path };
}

test('completing from the project folder also scans the task’s active worktree: findings there block, and a clean worktree is counted, not "0 files"', async (t) => {
  const { root } = await repo(t);
  await toImplement(root);
  const tree = await worktree(root);
  await writeFile(join(tree.path, 'client.js'), `const key = '${KEYS.github}';\n`);
  await assert.rejects(updateFeature(root, 'pay', 'complete', { phase: 'implement', evidence: '구현', waiver: '확인', runFolder: root }),
    (error) => error.status === 409 && error.message.includes(`.wax/worktrees/${tree.id}/client.js:1 github-token ghp_…`) && !error.message.includes(KEYS.github));
  const scan = await featureSecrets(root, 'pay', root);
  assert.deepEqual([scan.state, scan.files, scan.findings[0].worktree, scan.worktrees], ['found', 1, tree.id, [{ id: tree.id, branch: tree.branch }]]);
  assert.ok(validSecretScan(scan));
  assert.equal(findingText(scan.findings[0]), `.wax/worktrees/${tree.id}/client.js:1 github-token ghp_…`);

  await writeFile(join(tree.path, 'client.js'), 'const key = process.env.KEY;\n');
  await writeFile(join(root, 'local.js'), `const s = '${KEYS.slack}';\n`);
  const inside = await featureSecrets(root, 'pay', join(tree.path));
  assert.deepEqual([inside.state, inside.files, inside.worktrees], ['clean', 1, [{ id: tree.id, branch: tree.branch }]]);
  const both = await featureSecrets(root, 'pay', root);
  assert.deepEqual([both.state, both.files, both.findings.map(findingText)], ['found', 2, ['local.js:1 slack-token xoxb…']]);
  await rm(join(root, 'local.js'));

  const done = await updateFeature(root, 'pay', 'complete', { phase: 'implement', evidence: '구현', waiver: '확인', runFolder: root });
  const recorded = done.completed.implement.secretScan;
  assert.deepEqual([recorded.state, recorded.files, recorded.worktrees], ['clean', 1, [{ id: tree.id, branch: tree.branch }]], 'the worktree file was read, not a silent 0');
  assert.doesNotThrow(() => validateStored(done));
});

test('merging scans: found wins, then unknown, no-git worktrees are skipped, and the record shape is checked', () => {
  const entry = { id: 'goal-0000000a-1', branch: 'wax/goal-0000000a/pay-1' };
  const clean = (files = 0) => ({ state: 'clean', base: 'a'.repeat(40), files, findings: [], more: 0 });
  assert.deepEqual(mergeSecretScans(clean(), []), clean());
  assert.deepEqual(mergeSecretScans(clean(), [[entry, { state: 'unknown', reason: 'no-git', files: 0, findings: [], more: 0 }]]), clean());
  const unknown = mergeSecretScans(clean(2), [[entry, { state: 'unknown', reason: 'too-many-files', base: 'a'.repeat(40), files: 0, findings: [], more: 0 }]]);
  assert.deepEqual([unknown.state, unknown.reason, unknown.files], ['unknown', 'too-many-files', 2], 'an unread worktree is not reported clean');
  const found = mergeSecretScans({ state: 'unknown', reason: 'too-large', files: 0, findings: [], more: 0 }, [[entry, { ...clean(1), state: 'found', findings: [{ file: 'a.js', line: 1, rule: 'aws-access-key', preview: 'AKIA…' }] }]]);
  assert.deepEqual([found.state, found.findings[0].worktree], ['found', entry.id]);
  assert.ok(validSecretScan(found));
  assert.equal(validSecretScan({ ...found, findings: [{ ...found.findings[0], worktree: '../x' }] }), false);
  assert.equal(validSecretScan({ ...found, worktrees: [{ id: 'nope' }] }), false);
});
