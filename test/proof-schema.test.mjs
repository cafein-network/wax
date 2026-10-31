import test from 'node:test';
import assert from 'node:assert/strict';
import { validProof } from '../src/proof-schema.mjs';

const base = { id: '00000000-0000-4000-8000-000000000001', phase: 'implement', iteration: 0, at: '2026-10-28T00:00:00Z' };
const testProof = { ...base, kind: 'test', command: ['node', '--test'], exitCode: 0, output: 'ok', durationMs: 12 };
const gitProof = { ...base, kind: 'git', commit: 'a'.repeat(40), files: ['src/a.mjs'] };

test('valid test and commit proofs pass, with or without verification checks', () => {
  assert.equal(validProof(testProof), true);
  assert.equal(validProof({ ...testProof, exitCode: null }), true, 'a killed process has no exit code');
  assert.equal(validProof({ ...testProof, verification: 'runtime', checks: ['e2e-smoke'] }), true);
  assert.equal(validProof(gitProof), true);
  assert.equal(validProof({ ...gitProof, commit: 'b'.repeat(64) }), true, 'SHA-256 repositories');
});

test('every field is checked so a stored proof cannot be malformed or oversized', () => {
  const broken = [
    null, {}, { ...testProof, id: 'short' }, { ...testProof, phase: 'done' }, { ...testProof, iteration: -1 }, { ...testProof, iteration: 1.5 },
    { ...testProof, at: 'yesterday' }, { ...testProof, kind: 'other' }, { ...testProof, command: [] }, { ...testProof, command: [1] },
    { ...testProof, command: Array(101).fill('x') }, { ...testProof, command: ['x'.repeat(2001)] }, { ...testProof, exitCode: '0' },
    { ...testProof, output: 'x'.repeat(20_001) }, { ...testProof, durationMs: -1 }, { ...testProof, durationMs: Infinity },
    { ...testProof, verification: 'runtime' }, { ...testProof, verification: 'manual', checks: [] }, { ...testProof, verification: 'static', checks: ['Bad'] },
    { ...testProof, verification: 'static', checks: Array(21).fill('a') },
    { ...gitProof, commit: 'xyz' }, { ...gitProof, commit: 'a'.repeat(39) }, { ...gitProof, files: 'src/a.mjs' },
    { ...gitProof, files: Array(1001).fill('a') }, { ...gitProof, files: ['x'.repeat(4097)] },
  ];
  broken.forEach((proof, index) => assert.equal(validProof(proof), false, `case ${index}`));
});
