import { readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { gitRead, taskChanges } from './secrets.mjs';

export const DEPS_LIMITS = { manifests: 50, changes: 200, fileBytes: 2 * 1024 * 1024 };
export const DEPS_CHECK = 'sec-deps';
const SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile.lock', 'composer.lock']);
const REQUIREMENTS = /^requirements(?:[-_.][\w.-]+)?\.txt$/i;
const AUDIT = /(?:^|\s)(?:audit\b|pip-audit\b|osv-scanner\b|govulncheck\b|safety\s+check\b|snyk\s+test\b)/;
const COPYLEFT = /\b(?:A?GPL|LGPL|SSPL|EUPL|MPL|OSL|CDDL|EPL)\b/i;

const inModules = (path) => /(?:^|\/)node_modules\//.test(path);

export function packageChanges(before, after) {
  const read = (text) => { try { const json = JSON.parse(text); return json && typeof json === 'object' ? json : {}; } catch { return null; } };
  const old = before === null ? {} : read(before), now = read(after);
  if (old === null || now === null) return null;
  const changes = [];
  for (const section of SECTIONS) {
    const a = old[section] && typeof old[section] === 'object' ? old[section] : {}, b = now[section] && typeof now[section] === 'object' ? now[section] : {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(name in a)) changes.push({ name, kind: 'added', to: String(b[name]), section });
      else if (!(name in b)) changes.push({ name, kind: 'removed', from: String(a[name]), section });
      else if (String(a[name]) !== String(b[name])) changes.push({ name, kind: 'updated', from: String(a[name]), to: String(b[name]), section });
    }
  }
  return changes.sort((x, y) => x.name.localeCompare(y.name));
}

export function parseRequirements(text) {
  const map = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/);
    if (match) map.set(match[1].toLowerCase().replace(/_/g, '-'), match[3].trim() || '*');
  }
  return map;
}

export function requirementChanges(before, after) {
  const a = parseRequirements(before), b = parseRequirements(after);
  const changes = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(name)) changes.push({ name, kind: 'added', to: b.get(name), section: 'requirements' });
    else if (!b.has(name)) changes.push({ name, kind: 'removed', from: a.get(name), section: 'requirements' });
    else if (a.get(name) !== b.get(name)) changes.push({ name, kind: 'updated', from: a.get(name), to: b.get(name), section: 'requirements' });
  }
  return changes.sort((x, y) => x.name.localeCompare(y.name));
}

async function installedLicense(root, manifest, name) {
  const dir = posix.dirname(manifest);
  try {
    const json = JSON.parse(await readFile(join(root, dir === '.' ? '' : dir, 'node_modules', name, 'package.json'), 'utf8'));
    const license = typeof json.license === 'string' ? json.license : typeof json.license?.type === 'string' ? json.license.type : null;
    return license ? license.slice(0, 80) : null;
  } catch { return null; }
}

export function auditProof(feature) {
  return (feature.proofs ?? []).filter((proof) => proof.kind === 'test' && proof.iteration === feature.iteration &&
    ((proof.checks ?? []).includes(DEPS_CHECK) || AUDIT.test(proof.command.join(' ')))).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) ?? null;
}

export async function dependencyChanges(root, feature) {
  const changes = await taskChanges(root, { base: feature.history?.find((event) => event.action === 'create')?.head });
  if (!changes.ok) return { state: 'unknown', reason: changes.reason, manifests: [], lockfiles: [], audit: null };
  const paths = [...changes.paths].map((path) => path.replace(/\\/g, '/')).filter((path) => !inModules(path)).sort();
  const lockfiles = paths.filter((path) => LOCKFILES.has(basename(path)));
  const declared = paths.filter((path) => basename(path) === 'package.json' || REQUIREMENTS.test(basename(path))).slice(0, DEPS_LIMITS.manifests);
  const manifests = [];
  for (const file of declared) {
    let after;
    try { after = await readFile(join(root, file), 'utf8'); } catch { continue; }
    if (after.length > DEPS_LIMITS.fileBytes) continue;
    let before = null;
    try { before = (await gitRead(root, ['cat-file', 'blob', `${changes.base}:./${file}`])).toString('utf8'); } catch { before = null; }
    const npm = basename(file) === 'package.json';
    const found = npm ? packageChanges(before, after) : requirementChanges(before, after);
    if (!found?.length) continue;
    const listed = found.slice(0, DEPS_LIMITS.changes);
    if (npm) {
      for (const item of listed) {
        if (item.kind === 'removed') continue;
        const license = await installedLicense(root, file, item.name);
        item.license = license;
        if (license && COPYLEFT.test(license)) item.copyleft = true;
      }
    }
    manifests.push({ file, ecosystem: npm ? 'npm' : 'pypi', changes: listed, more: Math.max(0, found.length - listed.length) });
  }
  const proof = auditProof(feature);
  return { state: manifests.length || lockfiles.length ? 'changed' : 'none', manifests, lockfiles,
    audit: proof ? { proofId: proof.id, passed: proof.exitCode === 0 && !proof.timedOut } : null };
}

const changeText = (item) => `${item.kind === 'added' ? `+${item.name} ${item.to}` : item.kind === 'removed' ? `-${item.name} ${item.from}` : `${item.name} ${item.from} → ${item.to}`}${item.section === 'devDependencies' ? ' [dev]' : ''}`;

export function depsPrompt(deps) {
  if (deps?.state !== 'changed') return '';
  const added = deps.manifests.flatMap((manifest) => manifest.changes.filter((item) => item.kind !== 'removed').map((item) => ({ ...item, file: manifest.file })));
  const lines = ['의존성 변경(관찰값, 판정 아님): 이 작업에서 의존성 선언이나 잠금 파일이 바뀌었습니다.'];
  for (const manifest of deps.manifests) lines.push(`- ${manifest.file}: ${manifest.changes.map(changeText).join(', ')}${manifest.more ? ` 외 ${manifest.more}개` : ''}`);
  if (deps.lockfiles.length) lines.push(`- 바뀐 잠금 파일: ${deps.lockfiles.join(', ')}`);
  const unknown = added.filter((item) => item.license === null).map((item) => item.name);
  const copyleft = added.filter((item) => item.copyleft).map((item) => `${item.name}(${item.license})`);
  if (copyleft.length) lines.push(`- 배포 조건을 확인할 라이선스: ${copyleft.join(', ')}`);
  if (unknown.length) lines.push(`- 라이선스를 확인하지 못한 패키지(설치되지 않음): ${unknown.join(', ')}`);
  if (!deps.audit) lines.push(`- 현재 주기에 감사 근거가 없습니다. 의존성 감사 명령(npm이면 npm audit --omit=dev, Python이면 pip-audit 등)을 CLI test <id> --checks ${DEPS_CHECK} -- <명령>으로 실행해 근거를 남기세요. 네트워크가 없거나 도구가 없으면 미검증으로 보고하고, 사용자 승인 없이 도구를 설치하지 마세요.`);
  else if (!deps.audit.passed) lines.push('- 마지막 감사 근거가 실패했습니다. 보고된 취약점을 검토 문서에 적고, 고칠 수 있는 것은 구현으로 되돌리세요.');
  return lines.join('\n');
}

export { changeText };
