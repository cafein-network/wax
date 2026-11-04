import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, BIN } from './chat-helpers.mjs';
import { createFeature } from '../src/workflow.mjs';
import { MAX_TEST_MS, runTestProof } from '../src/evidence.mjs';

const wax = (root, ...args) => spawnSync(process.execPath, [BIN, ...args, '--project', root], { encoding: 'utf8' });

test('number and JSON file options name the option that was wrong', async (t) => {
  const root = await project(t, ['login']);
  const timeout = wax(root, 'test', 'login', '--timeout', 'abc', '--', process.execPath, '-e', '1');
  assert.equal(timeout.status, 1);
  assert.match(timeout.stderr, /wax: --timeout은\(는\) 정수여야 합니다: abc/);
  assert.match(wax(root, 'context', 'login', '--budget', '3k').stderr, /--budget은\(는\) 정수여야 합니다: 3k/);
  await writeFile(join(root, 'checks.json'), '[{ broken');
  const checks = wax(root, 'complete', 'plan', 'login', '--evidence', 'x', '--checks-file', join(root, 'checks.json'));
  assert.match(checks.stderr, /--checks-file 파일이 올바른 JSON이 아닙니다\(.*checks\.json\)/);
  assert.match(wax(root, 'import', '--file', 'missing.json').stderr, /--file 파일을 읽지 못했습니다\(missing\.json\): ENOENT/);
});

test('a test proof may run for up to 30 minutes', async (t) => {
  const root = await project(t);
  await createFeature(root, { id: 'e2e', title: 'E2E' });
  assert.equal(MAX_TEST_MS, 1_800_000);
  const passed = await runTestProof(root, 'e2e', [process.execPath, '-e', '1'], { timeout: MAX_TEST_MS });
  assert.equal(passed.recorded, true);
  await assert.rejects(runTestProof(root, 'e2e', [process.execPath, '-e', '1'], { timeout: MAX_TEST_MS + 1 }), /100~1800000ms\(30분\)/);
});
