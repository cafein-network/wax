import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getFeature, updateFeature, WaxError } from './workflow.mjs';
const exec = promisify(execFile);
async function git(root, args) {
  try { return (await exec('git', ['--no-pager', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout; }
  catch { throw new WaxError('Git 기록을 읽지 못했습니다. 저장소와 커밋을 확인하세요.'); }
}
export async function collectGitProof(root, feature, ref = 'HEAD') {
  if (typeof ref !== 'string' || !ref || ref.length > 200 || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new WaxError('유효한 커밋 또는 브랜치 이름이 필요합니다.');
  const commit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  const files = (await git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit, '--'])).split('\0').filter(Boolean);
  if (files.length > 1000) throw new WaxError('변경 파일이 1,000개를 넘습니다. 더 작은 커밋으로 근거를 연결하세요.');
  return { id: randomUUID(), kind: 'git', phase: feature.phase, iteration: feature.iteration, at: new Date().toISOString(), commit, files };
}
export const windowsCommandHint = (command, platform = process.platform) => platform === 'win32' && !/\.(exe|com)$/i.test(command[0])
  ? ' Windows에서는 npx·playwright-cli 같은 .cmd 실행 파일을 셸 없이 실행할 수 없습니다. node node_modules/@playwright/test/cli.js test처럼 node로 실행하세요.' : '';
export function runCommand(root, command, timeout) {
  return new Promise((resolve, reject) => {
    const failed = () => new WaxError(`명령을 실행하지 못했습니다. 실행 파일 경로를 확인하세요.${windowsCommandHint(command)}`);
    let child;
    try { child = spawn(command[0], command.slice(1), { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(failed()); return; }
    let output = '', truncated = false, timedOut = false, killTimer;
    const append = (chunk) => { output += chunk.toString(); if (output.length > 20_000) { output = output.slice(0, 10_000) + output.slice(-10_000); truncated = true; } };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', append); child.stderr.on('data', append);
    const stop = (signal) => { try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch {   } };
    const interrupt = () => { stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 2000); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 2000); }, timeout);
    child.on('error', () => { cleanup(); reject(failed()); });
    child.on('close', (exitCode, signal) => { cleanup(); resolve({ exitCode, signal, output, truncated, timedOut }); });
  });
}
export async function runTestProof(root, id, command, { revision, timeout = 120_000, verification, checks = [] } = {}) {
  if ((verification !== undefined && !['static', 'runtime', 'integration', 'visual'].includes(verification)) || !Array.isArray(checks) || checks.length > 20 || !checks.every(check => typeof check === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(check))) throw new WaxError('검증 종류 또는 검증 항목 ID가 올바르지 않습니다.');
  if (!Array.isArray(command) || !command.length || command.length > 100 || command.some((arg) => typeof arg !== 'string' || arg.length > 2000) || !command[0] ||
      !Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) throw new WaxError('실행할 명령과 100~300000ms 제한이 필요합니다.');
  const feature = await getFeature(root, id);
  if (feature.archivedAt || feature.phase === 'done' || (revision !== undefined && revision !== feature.revision)) throw new WaxError('현재 진행 중인 최신 작업에서 테스트를 실행하세요.', 409);
  let commit = null, dirty = null;
  try { commit = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); dirty = Boolean((await git(root, ['status', '--porcelain'])).trim()); } catch {   }
  const started = Date.now();
  const result = await runCommand(root, command, timeout);
  const proof = { id: randomUUID(), kind: 'test', phase: feature.phase, iteration: feature.iteration, at: new Date().toISOString(), command, commit, dirty, durationMs: Date.now() - started, ...result,
    ...(verification !== undefined || checks.length ? { verification: verification || 'static', checks: [...new Set(checks)] } : {}) };
  try { return { recorded: true, proof, feature: await updateFeature(root, id, 'attach-evidence', { proof, revision: feature.revision }) }; }
  catch (error) { return { recorded: false, proof, error: '테스트 도중 작업이 변경되었거나 기록을 저장하지 못했습니다. 이 JSON 결과를 보관하고 최신 기록을 확인하세요.' }; }
}
