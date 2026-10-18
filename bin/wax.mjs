#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildPrompt, createFeature, getFeature, listFeatures, updateFeature } from '../src/workflow.mjs';
import { diagnoseProject } from '../src/diagnostics.mjs';
import { createBackup, previewRestore, restoreBackup } from '../src/backup.mjs';
import { collectGitProof, runTestProof } from '../src/evidence.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const HELP = `wax ${version} — 기획에서 검증까지

node bin/wax.mjs start <id> --title <제목> [--description <설명>] [--type auto|general|roblox|lookbook]
node bin/wax.mjs status [id]
node bin/wax.mjs context <id> [--budget 3000]   인수인계 문맥 (문자 수 제한)
node bin/wax.mjs prompt <단계> <id>
node bin/wax.mjs save <단계> <id> --file <문서 경로>
node bin/wax.mjs complete <단계> <id> --evidence <근거> [--verdict pass]
node bin/wax.mjs iterate <id> --reason <사유>
node bin/wax.mjs edit <id> --title <제목> --description <설명>
node bin/wax.mjs archive <id>
node bin/wax.mjs restore <id>
node bin/wax.mjs doctor [--project <경로>]
node bin/wax.mjs backup > wax-backup.json
node bin/wax.mjs import --file wax-backup.json [--prefix copy-] [--apply <미리보기 fingerprint>]
node bin/wax.mjs evidence <id> [--commit HEAD] [--revision <숫자>]
node bin/wax.mjs test <id> [--revision <숫자>] [--timeout 120000] -- <실행 파일> [인수...]
종류별 검증: test ... --verification runtime|integration|visual|static --checks <검증 ID,ID> -- <실행 파일> [인수...]
필수 산출물·검증 보고: complete ... --checks-file <JSON 배열 파일>
단계 완료에 근거 연결: complete ... --proofs <근거 ID,근거 ID>

node bin/wax.mjs dashboard [--port 4330]   대시보드·채널·가상 사무실 (로컬 웹)
node bin/wax.mjs chat <명령> ...            에이전트 채널·화이트보드·일일 보고 (wax chat --help)
node bin/wax.mjs search <검색어> [--feature <id>]   기록 검색 (wax search --help, 색인: wax search index)
node bin/wax.mjs approvals list           실행 승인 상태
node bin/wax.mjs approvals codex --prompt <요청>   GUI 승인과 연결된 Codex 작업

단계: plan → design → implement → review → report
공통 옵션: --project <경로> (기본값: 현재 디렉터리), --revision <숫자>
버전 확인: wax --version (또는 -v)
출력: JSON (prompt와 context는 일반 텍스트). 자료는 <프로젝트>/.wax/features/에 저장합니다.`;


const raw = process.argv.slice(2);
let first = 0;
while (raw[first] === '--project' || raw[first]?.startsWith('--project=')) first += raw[first] === '--project' ? 2 : 1;
if (raw[first] === 'approvals') {
  try {
    const { approvalCli } = await import('../src/approval-cli.mjs');
    await approvalCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax approvals: ${error.message}`); process.exitCode = 1; }
} else if (raw[first] === 'search') {
  try {
    const { searchCli } = await import('../src/search-cli.mjs');
    await searchCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax search: ${error.message}`); process.exitCode ||= error.state ? 2 : 1; }
} else if (raw[first] === 'chat' || raw[first] === 'dashboard') {
  const { main } = await import('../src/chat/cli.mjs');
  await main([...raw.slice(0, first), ...(raw[first] === 'dashboard' ? ['serve'] : []), ...raw.slice(first + 1)]);
} else await runWorkflow();

async function runWorkflow() {
try {
  const args = process.argv.slice(2), separator = args.indexOf('--');
  const commandArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { values, positionals } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true, options: {
    project: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
    file: { type: 'string' }, evidence: { type: 'string' }, verdict: { type: 'string' }, type: { type: 'string' }, verification: { type: 'string' }, checks: { type: 'string' }, 'checks-file': { type: 'string' },
    reason: { type: 'string' }, revision: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    prefix: { type: 'string' }, apply: { type: 'string' }, commit: { type: 'string' }, proofs: { type: 'string' }, timeout: { type: 'string' }, budget: { type: 'string' }
  } });
  const [command, first, second] = positionals;
  const root = resolve(values.project ?? process.cwd());
  if (values.version) { console.log(version); }
  else if (!command || values.help || command === 'help') { console.log(HELP); }
  else {
    const revision = values.revision === undefined ? undefined : Number(values.revision);
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new Error('revision은 양의 정수이어야 합니다.');
    let result;
    if (command === 'start') result = await createFeature(root, { id: first, title: values.title ?? first, description: values.description, projectType: values.type });
    else if (command === 'status') result = first ? await getFeature(root, first) : await listFeatures(root);
    else if (command === 'context') {
      if (positionals.length !== 2) throw new Error('사용법: context <id> [--budget 3000]');
      const { buildContext } = await import('../src/context.mjs');
      process.stdout.write(await buildContext(root, first, { budget: values.budget === undefined ? undefined : Number(values.budget) }));
      return;
    }
    else if (command === 'doctor') { result = await diagnoseProject(root); if (!result.ok) process.exitCode = 1; }
    else if (command === 'backup') result = await createBackup(root);
    else if (command === 'import') {
      if (!values.file) throw new Error('--file 백업 경로가 필요합니다.');
      const backup = JSON.parse(await readFile(resolve(values.file), 'utf8'));
      result = values.apply ? await restoreBackup(root, backup, { prefix: values.prefix, fingerprint: values.apply }) : await previewRestore(root, backup, values.prefix);
      if (result.failed?.length) process.exitCode = 1;
    }
    else if (command === 'evidence') { const feature = await getFeature(root, first); result = await updateFeature(root, first, 'attach-evidence', { proof: await collectGitProof(root, feature, values.commit), revision: revision ?? feature.revision }); }
    else if (command === 'test') { result = await runTestProof(root, first, commandArgs, { revision, timeout: values.timeout === undefined ? undefined : Number(values.timeout), verification: values.verification, checks: values.checks?.split(',') }); if (!result.recorded || result.proof.exitCode !== 0 || result.proof.timedOut) process.exitCode = 1; }
    else if (command === 'prompt') { console.log(buildPrompt(await getFeature(root, second), first)); process.exit(0); }
    else if (command === 'save') {
      if (!values.file) throw new Error('--file 문서 경로가 필요합니다.');
      result = await updateFeature(root, second, 'save', { phase: first, content: await readFile(resolve(values.file), 'utf8'), revision });
    } else if (command === 'complete') result = await updateFeature(root, second, 'complete', { phase: first, evidence: values.evidence, verdict: values.verdict, revision, proofIds: values.proofs?.split(','), checks: values['checks-file'] ? JSON.parse(await readFile(resolve(values['checks-file']), 'utf8')) : undefined });
    else if (command === 'iterate') result = await updateFeature(root, first, 'iterate', { reason: values.reason, revision });
    else if (command === 'edit') result = await updateFeature(root, first, 'edit', { title: values.title, description: values.description, revision });
    else if (command === 'archive' || command === 'restore') result = await updateFeature(root, first, command === 'archive' ? 'archive-feature' : 'restore', { revision });
    else throw new Error(`알 수 없는 명령: ${command}. --help를 확인하세요.`);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(`wax: ${error.message}`); process.exitCode = 1; }
}
