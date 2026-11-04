import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUsage, listUsage } from '../src/chat/usage.mjs';

const NOW = Date.parse('2026-10-14T09:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const record = (session, msAgo, extra = {}) => ({ schema: 1, tool: 'claude', session, model: 'claude-sonnet-4-5', at: at(msAgo), ended: false, context: { percent: 12, tokens: 24000, window: 200000 }, rateLimits: [], costUsd: 0.5, ...extra });

test('사용량: 숫자만 남긴 기록을 검증하고, 계정 플랜 사용량은 가장 새 기록을 쓴다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wax-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await listUsage(root, { now: NOW }), { claude: { limits: [], limitsAt: null, sessions: [] } }, '기록이 없으면 빈 요약');
  const dir = join(root, '.wax', 'usage');
  await mkdir(dir, { recursive: true });
  const five = (percentUsed) => [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-14T12:30:00.000Z' }, { kind: 'seven_day', percentUsed: 17, resetsAt: '2026-10-20T13:00:00.000Z' }];
  await writeFile(join(dir, 'aaaaaaaa-1111.json'), JSON.stringify(record('aaaaaaaa-1111', 60_000, { rateLimits: five(20) })));
  await writeFile(join(dir, 'bbbbbbbb-2222.json'), JSON.stringify(record('bbbbbbbb-2222', 10_000, { rateLimits: five(24) })));
  await writeFile(join(dir, 'cccccccc-3333.json'), JSON.stringify(record('cccccccc-3333', 10 * 60_000, { ended: true })));
  await writeFile(join(dir, 'dddddddd-4444.json'), JSON.stringify(record('dddddddd-4444', 2 * 86_400_000)));
  await writeFile(join(dir, 'eeeeeeee-5555.json'), '{ 손상');
  await writeFile(join(dir, 'not-a-session.txt'), 'x');
  const { claude } = await listUsage(root, { now: NOW });
  assert.deepEqual(claude.sessions.map((x) => x.session), ['bbbbbbbb-2222', 'aaaaaaaa-1111'], '살아 있는 세션만 최근 순');
  assert.equal(claude.limits[0].percentUsed, 24, '플랜 사용량은 계정 단위라 가장 새 기록');
  assert.equal(claude.limitsAt, at(10_000));
  assert.ok(!('text' in claude.sessions[0]) && !('prompt' in claude.sessions[0]), '대화 내용 필드는 없다');
});

test('사용량 기록 검증: 모양이 틀리거나 범위를 벗어난 값은 버린다', () => {
  assert.equal(cleanUsage(null), null);
  assert.equal(cleanUsage({ schema: 2, session: 'aaaaaaaa', at: at(0) }), null);
  assert.equal(cleanUsage({ schema: 1, session: '../etc', at: at(0) }), null);
  const clean = cleanUsage(record('aaaaaaaa-1111', 0, { context: { percent: 140 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30 }, { kind: 'mystery', percentUsed: 5 }, { kind: 'seven_day', percentUsed: 'x' }], costUsd: -1, model: 'm'.repeat(300) }));
  assert.equal(clean.context.percent, null);
  assert.deepEqual(clean.rateLimits, [{ kind: 'five_hour', percentUsed: 30, resetsAt: null }]);
  assert.equal(clean.costUsd, null);
  assert.equal(clean.model.length, 80);
});
