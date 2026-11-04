import { getFeature, LABELS, PHASES } from './workflow.mjs';
import { acceptanceTrace } from './acceptance.mjs';
import { openDefects } from './defects.mjs';
import { evidenceFreshness, freshnessText } from './freshness.mjs';
import { cliText } from './cli-locale.mjs';
import { compareCaptures, compareLines, hasComparison } from './visual-compare.mjs';
import { code, inline } from './pr-body.mjs';
import { qualityRequirements } from '../web/project-types.mjs';
import { approvedManual } from './manual.mjs';
import { changeImpact } from './impact.mjs';
import { changeText, dependencyChanges } from './deps.mjs';

export const QUALITY_REPORT_LIMITS = { detail: 300, tests: 30, compare: 8 };

export const CHARACTERISTICS = [
  { id: 'functional', label: 'qualityReport.c.functional', prefixes: ['func-'] },
  { id: 'performance', label: 'qualityReport.c.performance', prefixes: ['perf-'] },
  { id: 'compatibility', label: 'qualityReport.c.compatibility', prefixes: ['compat-'] },
  { id: 'usability', label: 'qualityReport.c.usability', prefixes: ['ux-', 'a11y-'] },
  { id: 'reliability', label: 'qualityReport.c.reliability', prefixes: ['rel-'] },
  { id: 'security', label: 'qualityReport.c.security', prefixes: ['sec-'] },
  { id: 'maintainability', label: 'qualityReport.c.maintainability', prefixes: ['maint-'] },
  { id: 'portability', label: 'qualityReport.c.portability', prefixes: ['port-'] },
];
const KIND_CHARACTERISTIC = { runtime: 'functional', integration: 'functional', visual: 'usability', preview: 'usability' };
const STATUS_KEY = { pass: 'qualityReport.pass', fail: 'qualityReport.fail', unverified: 'qualityReport.unverified', pending: 'qualityReport.pending' };

const phaseName = (phase, language) => (language === 'en' ? phase : LABELS[phase]);
const outcome = (proof) => (proof.timedOut ? 'timeout' : proof.exitCode === 0 ? 'pass' : 'fail');

export function characteristicEvidence(feature) {
  const result = Object.fromEntries(CHARACTERISTICS.map(({ id }) => [id, { id, pass: 0, fail: 0, sources: [] }]));
  const add = (id, status, source) => {
    if (status === 'pass') result[id].pass += 1; else if (status === 'fail') result[id].fail += 1;
    result[id].sources.push({ status, ...source });
  };
  for (const item of acceptanceTrace(feature)) if (item.status !== 'pending') add('functional', item.status, { kind: 'acceptance', ref: item.id });
  for (const phase of PHASES) {
    for (const check of feature.completed[phase]?.checks ?? []) {
      const kind = qualityRequirements(feature.projectType, phase, feature.workMode).find((rule) => rule.id === check.id)?.kind;
      const target = KIND_CHARACTERISTIC[kind] ?? null;
      if (target) add(target, check.status, { kind: 'check', ref: check.id, phase });
    }
  }
  for (const phase of ['implement', 'review']) {
    const scan = feature.completed[phase]?.secretScan;
    if (scan?.state === 'clean' || scan?.state === 'found') add('security', scan.state === 'clean' ? 'pass' : 'fail', { kind: 'secrets', ref: `secret-scan:${phase}`, phase });
  }
  const latest = new Map();
  for (const proof of [...(feature.proofs ?? [])].filter((item) => item.kind === 'test').sort((a, b) => a.at.localeCompare(b.at))) {
    for (const check of proof.checks ?? []) latest.set(check, proof);
  }
  for (const [check, proof] of latest) {
    const target = CHARACTERISTICS.find(({ prefixes }) => prefixes.some((prefix) => check.startsWith(prefix)));
    if (target) add(target.id, outcome(proof) === 'pass' ? 'pass' : 'fail', { kind: 'test', ref: check, proof: proof.id });
  }
  return CHARACTERISTICS.map(({ id }) => result[id]);
}

export function manualCheckEvidence(feature, checks = []) {
  const squash = (text) => text.replace(/\s+/g, ' ').trim();
  const passed = (feature.proofs ?? []).filter((proof) => proof.kind === 'test' && proof.iteration === feature.iteration && outcome(proof) === 'pass');
  return checks.map((check) => {
    const wanted = squash(check);
    const proof = passed.find((item) => squash(item.command.join(' ')).includes(wanted));
    return { check, proofId: proof?.id ?? null };
  });
}

export async function buildQualityReport(root, id, { language = cliText().language, freshness, manual, impact, deps } = {}) {
  const { say, localize } = cliText(language);
  const feature = await getFeature(root, id);
  const lines = [];
  const push = (...items) => lines.push(...items);
  const proofs = feature.proofs ?? [];
  const short = (proofId) => code(String(proofId).slice(0, 8));
  const describe = (proofId) => {
    const proof = proofs.find((item) => item.id === proofId);
    if (!proof) return say('prBody.proofMissing', short(proofId));
    if (proof.kind === 'git') return say('prBody.commitRef', code(proof.commit.slice(0, 12)));
    return say('prBody.testRef', code(proof.command.join(' '), 80, true), proof.exitCode ?? 'null', short(proof.id));
  };

  push(`# ${say('qualityReport.title', inline(feature.title))}`, '');
  push(say('qualityReport.notice'), '');
  const done = PHASES.filter((phase) => feature.completed[phase]).map((phase) => phaseName(phase, language));
  push(say('prBody.state', feature.phase === 'done' ? say('prBody.allDone') : phaseName(feature.phase, language), feature.iteration, feature.revision, done.length ? done.join(', ') : say('prBody.none')));
  push('', say('qualityReport.generated', code(`.wax/features/${id}.json`), code(`wax quality-report ${id}`)));

  const characteristics = characteristicEvidence(feature);
  push('', `## ${say('qualityReport.characteristics')}`, '', say('qualityReport.characteristicsRule'), '');
  push(`| ${say('qualityReport.characteristicColumn')} | ${say('qualityReport.statusColumn')} | ${say('qualityReport.evidenceColumn')} |`, '| --- | --- | --- |');
  for (const item of characteristics) {
    const state = item.fail ? say('qualityReport.hasFailure', item.fail) : item.pass ? say('qualityReport.hasEvidence', item.pass) : say('qualityReport.noEvidence');
    const refs = item.sources.slice(0, 6).map((source) => `${code(source.ref, 64, true)} ${say(STATUS_KEY[source.status] ?? STATUS_KEY.unverified)}`).join(', ');
    push(`| ${say(CHARACTERISTICS.find(({ id: key }) => key === item.id).label)} | ${state} | ${refs || '-'}${item.sources.length > 6 ? ` ${say('qualityReport.more', item.sources.length - 6)}` : ''} |`);
  }

  push('', `## ${say('qualityReport.required')}`, '');
  const checks = PHASES.flatMap((phase) => (feature.completed[phase]?.checks ?? []).map((check) => ({ phase, ...check })));
  if (!checks.length) push(say('qualityReport.noRequired'));
  else {
    push(`| ${say('qualityReport.phaseColumn')} | ${say('qualityReport.checkColumn')} | ${say('qualityReport.statusColumn')} | ${say('qualityReport.evidenceColumn')} |`, '| --- | --- | --- | --- |');
    for (const check of checks) push(`| ${phaseName(check.phase, language)} | ${inline(check.label ?? check.id)} | ${say(STATUS_KEY[check.status] ?? STATUS_KEY.unverified)} | ${(check.proofIds ?? []).map(describe).join('; ') || '-'} |`);
  }

  push('', `## ${say('qualityReport.acceptance')}`, '');
  const trace = acceptanceTrace(feature);
  const acceptance = { total: trace.length, pass: trace.filter((item) => item.status === 'pass').length };
  if (!trace.length) push(say('prBody.noAcceptance'));
  else {
    push(`| ${say('prBody.acColumn')} | ${say('qualityReport.statusColumn')} | ${say('qualityReport.evidenceColumn')} |`, '| --- | --- | --- |');
    for (const item of trace) push(`| ${item.id} | ${say(STATUS_KEY[item.status])} | ${item.proofIds.map(describe).join('; ') || '-'}${item.detail ? ` — ${inline(item.detail, QUALITY_REPORT_LIMITS.detail)}` : ''} |`);
  }

  push('', `## ${say('qualityReport.defects')}`, '');
  const defects = feature.defects ?? [];
  const defectSummary = { total: defects.length, open: openDefects(feature).length };
  if (!defects.length) push(say('qualityReport.noDefects'));
  else {
    push(say('qualityReport.defectSummary', defects.length, defects.length - defectSummary.open, defectSummary.open), '');
    push(`| ${say('qualityReport.defectColumn')} | ${say('qualityReport.contentColumn')} | ${say('qualityReport.statusColumn')} | ${say('qualityReport.foundColumn')} | ${say('qualityReport.resolvedColumn')} | ${say('qualityReport.evidenceColumn')} |`, '| --- | --- | --- | --- | --- | --- |');
    for (const item of defects) {
      push(`| ${item.id} | ${inline(item.title)}${item.ac ? ` (${item.ac})` : ''}${item.detail ? ` — ${inline(item.detail, QUALITY_REPORT_LIMITS.detail)}` : ''} | ${say(item.status === 'open' ? 'qualityReport.defectOpen' : 'qualityReport.defectResolved')} | ${item.foundIteration} | ${item.resolvedIteration ?? '-'} | ${(item.proofIds ?? []).map(describe).join('; ') || '-'} |`);
    }
  }

  push('', `## ${say('qualityReport.tests')}`, '');
  const tests = proofs.filter((proof) => proof.kind === 'test').sort((a, b) => a.at.localeCompare(b.at));
  const testSummary = { total: tests.length, pass: tests.filter((proof) => outcome(proof) === 'pass').length };
  if (!tests.length) push(say('qualityReport.noTests'));
  else {
    const iterations = [...new Set(tests.map((proof) => proof.iteration))].sort((a, b) => a - b);
    push(`| ${say('qualityReport.iterationColumn')} | ${say('qualityReport.runsColumn')} | ${say('qualityReport.pass')} | ${say('qualityReport.fail')} |`, '| --- | --- | --- | --- |');
    for (const iteration of iterations) {
      const runs = tests.filter((proof) => proof.iteration === iteration);
      push(`| ${iteration} | ${runs.length} | ${runs.filter((proof) => outcome(proof) === 'pass').length} | ${runs.filter((proof) => outcome(proof) !== 'pass').length} |`);
    }
    push('');
    for (const proof of tests.slice(-QUALITY_REPORT_LIMITS.tests)) {
      const result = say(proof.timedOut ? 'prBody.timedOut' : proof.exitCode === 0 ? 'prBody.passed' : 'prBody.failed');
      const tags = proof.checks?.length ? `, ${proof.checks.map((check) => code(check, 64)).join(' ')}` : '';
      push(`- ${code(proof.command.join(' '), 160)} — ${result} (exit ${proof.exitCode ?? 'null'}), ${phaseName(proof.phase, language)} · ${say('qualityReport.iteration', proof.iteration)}${proof.verification ? `, ${proof.verification}` : ''}${tags}, ${code(proof.at, 40)}`);
    }
    if (tests.length > QUALITY_REPORT_LIMITS.tests) push(say('prBody.moreProofs', tests.length - QUALITY_REPORT_LIMITS.tests));
  }

  const compare = await compareCaptures(root, feature.id, { handoffs: false }).catch(() => null);
  if (hasComparison(compare)) push('', `## ${say('prBody.compare')}`, '', ...compareLines(compare, say, QUALITY_REPORT_LIMITS.compare));

  if (manual === undefined) manual = await approvedManual(root).catch(() => null);
  const manualChecks = manualCheckEvidence(feature, manual?.checks ?? []);
  if (manualChecks.length) {
    push('', `## ${say('qualityReport.manualChecks')}`, '', say('qualityReport.manualChecksRule', code(manual.hash.slice(0, 12))), '');
    for (const item of manualChecks) push(`- ${code(item.check, 200)} — ${item.proofId ? describe(item.proofId) : say('qualityReport.manualCheckMissing')}`);
  }

  if (impact === undefined) impact = await changeImpact(root, feature).catch(() => null);
  if (impact?.state === 'ok' && (impact.related.length || impact.untested.length)) {
    push('', `## ${say('qualityReport.impact')}`, '', say('qualityReport.impactRule', impact.changed), '');
    for (const item of impact.related) push(`- ${code(item.test, 200)} — ${say(!item.run ? 'cli.impact.notRun' : item.passed ? 'cli.impact.passed' : 'cli.impact.failed')} (${item.because.map((file) => code(file, 120)).join(', ')})`);
    if (impact.untested.length) push(say('cli.impact.untested', impact.untested.map((file) => code(file, 120)).join(', ')));
  }

  if (deps === undefined) deps = await dependencyChanges(root, feature).catch(() => null);
  if (deps?.state === 'changed') {
    push('', `## ${say('qualityReport.deps')}`, '', say('qualityReport.depsRule'), '');
    for (const manifest of deps.manifests) {
      for (const item of manifest.changes) push(`- ${code(manifest.file, 120)} ${code(changeText(item), 200)}${item.kind === 'removed' ? '' : ` — ${item.license ? `${inline(item.license, 80)}${item.copyleft ? ` (${say('cli.deps.copyleft')})` : ''}` : say('cli.deps.licenseUnknown')}`}`);
    }
    if (deps.lockfiles.length) push(say('cli.deps.lockfiles', deps.lockfiles.map((file) => code(file, 120)).join(', ')));
    push('', deps.audit ? `${say(deps.audit.passed ? 'cli.deps.auditPassed' : 'cli.deps.auditFailed')} (${describe(deps.audit.proofId)})` : say('cli.deps.noAudit'));
  }

  const waivers = [
    ...PHASES.filter((phase) => feature.completed[phase]?.waiver).map((phase) => say('qualityReport.proofWaiver', phaseName(phase, language), inline(feature.completed[phase].waiver, QUALITY_REPORT_LIMITS.detail))),
    ...(feature.completed.review?.acWaiver ? [say('qualityReport.acWaiver', inline(feature.completed.review.acWaiver, QUALITY_REPORT_LIMITS.detail))] : []),
    ...(feature.completed.review?.defectWaiver ? [say('qualityReport.defectWaiver', inline(feature.completed.review.defectWaiver, QUALITY_REPORT_LIMITS.detail))] : []),
  ];
  push('', `## ${say('qualityReport.waivers')}`, '');
  push(...(waivers.length ? waivers.map((line) => `- ${line}`) : [say('qualityReport.noWaivers')]));

  freshness ??= await evidenceFreshness(root, feature).catch(() => null);
  push('', `## ${say('prBody.freshness')}`, '', freshness ? inline(localize(freshnessText(freshness)), 2000) : say('prBody.freshnessNone'));

  push('', '---', say('qualityReport.footer'));
  const body = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  return { id, title: feature.title, language, body,
    summary: { deps: deps?.state === 'changed' ? { packages: deps.manifests.reduce((sum, manifest) => sum + manifest.changes.length, 0), lockfiles: deps.lockfiles.length, audited: Boolean(deps.audit), passed: deps.audit?.passed ?? null } : null, impact: impact?.state === 'ok' ? { changed: impact.changed, related: impact.related.length, notRun: impact.related.filter((item) => !item.run).length } : null, manualChecks: manualChecks.map(({ check, proofId }) => ({ check, proven: Boolean(proofId) })), characteristics: characteristics.map(({ id: key, pass, fail }) => ({ id: key, pass, fail })), acceptance, defects: defectSummary, tests: testSummary } };
}
