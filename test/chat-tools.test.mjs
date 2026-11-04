import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_BINS, parseVersion, toolVersions, installedVersion } from '../src/chat/tools.mjs';
import { CLI_NEWS, newerThan } from '../web/office/cli-news.mjs';

test('설치된 도구 버전: --version 출력에서 번호만 읽고, 없는 도구는 설치 안 됨으로 둔다', async () => {
  assert.deepEqual(TOOL_BINS.map((tool) => tool.kind), ['claude', 'codex', 'copilot', 'gemini', 'antigravity', 'grok'], '지원 도구 여섯 개만');
  assert.equal(parseVersion('2.1.299 (Claude Code)'), '2.1.299');
  assert.equal(parseVersion('codex-cli 0.162.1'), '0.162.1');
  assert.equal(parseVersion('GitHub Copilot CLI 1.0.97.\n'), '1.0.97');
  assert.equal(parseVersion('command not found'), null);
  const seen = [];
  const tools = await toolVersions({ fresh: true, run: async (bin) => { seen.push(bin); return bin === 'claude' ? '2.1.299' : null; } });
  assert.deepEqual(seen.sort(), ['agy', 'claude', 'codex', 'copilot', 'gemini', 'grok']);
  assert.deepEqual(tools.filter((tool) => tool.installed).map((tool) => [tool.kind, tool.version]), [['claude', '2.1.299']]);
  const cached = await toolVersions({ run: async () => { throw new Error('다시 실행하면 안 된다'); } });
  assert.equal(cached, tools, '10분 동안은 기억한 값을 쓴다');
});

test('도구 소식: 버전 비교와 소식 형식', () => {
  assert.equal(newerThan('2.1.299', '2.1.290'), true);
  assert.equal(newerThan('0.162.1', '0.162.1'), false);
  assert.equal(newerThan('1.0.100', '1.0.97'), true, '숫자로 비교한다(문자열이 아니라)');
  assert.equal(newerThan('1.0', 'abc'), false, '모르면 새 버전이라고 하지 않는다');
  assert.match(CLI_NEWS.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(CLI_NEWS.tools).sort(), TOOL_BINS.map((tool) => tool.kind).filter((kind) => kind !== 'grok').sort(), 'Grok Build를 뺀 다섯 도구 모두 소식이 있다');
  for (const [kind, news] of Object.entries(CLI_NEWS.tools)) {
    assert.match(news.latest, /^\d+\.\d+\.\d+$/, kind);
    assert.match(news.source, /^https:\/\//, `${kind} 출처`);
    assert.ok(news.items.length && news.items.every((item) => typeof item.text === 'string' && item.text.length <= 90), `${kind} 소식은 말풍선에 맞게 짧게`);
  }
});


test('리나는 설치 버전이 소식보다 새로우면 최신이라고 단정하지 않는다', async () => {
  const { npcGuide } = await import('../web/office/chatter.mjs');
  const guide = npcGuide('tools', { tools: [{ kind: 'claude', label: 'Claude Code', installed: true, version: '2.1.302' }] });
  const installed = guide.sections[0].items[0];
  assert.match(installed, /2\.1\.302.*소식 기준 2\.1\.301보다 새로 설치됨/);
  assert.doesNotMatch(installed, /최신/);
  assert.equal(CLI_NEWS.tools.claude.latest, '2.1.301');
  assert.ok(CLI_NEWS.tools.claude.items.some((item) => item.version === '2.1.301'));
});

test('설치 도구 캐시는 10분 후 또는 수동 재조회 시 갱신된다', async () => {
  const base = Date.now() + 1000000;
  const before = await toolVersions({ now: base, fresh: true, run: async (bin) => bin === 'claude' ? '2.1.299' : null });
  assert.equal((await toolVersions({ now: base + 599000, run: async () => { throw Error('cached'); } })), before);
  const after = await toolVersions({ now: base + 601000, run: async (bin) => bin === 'claude' ? '2.1.300' : null });
  assert.equal(after.find((tool) => tool.kind === 'claude').version, '2.1.300');
  const forced = await toolVersions({ now: base + 602000, fresh: true, run: async (bin) => bin === 'claude' ? '2.1.301' : null });
  assert.equal(forced.find((tool) => tool.kind === 'claude').version, '2.1.301');
});


test('Claude native installation wins over an older GUI PATH binary, with PATH fallback', async () => {
  const seen = [];
  assert.equal(await installedVersion('claude', {home: '/known-home', platform: 'darwin', read: async path => {seen.push(path);return path === 'claude' ? '2.1.274' : '2.1.301';}}), '2.1.301');
  assert.equal(seen.length, 2);
  assert.equal(await installedVersion('claude', {home: '/known-home', platform: 'linux', read: async path => path === 'claude' ? '2.1.301' : null}), '2.1.301');
  assert.equal(await installedVersion('claude', {home: '/known-home', platform: 'win32', read: async path => {assert.equal(path, 'claude');return '2.1.301';}}), '2.1.301');
});
