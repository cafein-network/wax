import { lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { t } from '../web/messages-catalog.mjs';
import { getFeature, LABELS, PHASES, WaxError } from './workflow.mjs';
import { acceptanceTrace } from './acceptance.mjs';
import { createTreeObserver, freshnessBasis } from './freshness.mjs';
import { cliText } from './cli-locale.mjs';
import { captureLabelText, listCaptures } from './capture.mjs';
import { compareCaptures, compareLines, hasComparison } from './visual-compare.mjs';
import { usageLines } from './tool-usage.mjs';
import { agentTool } from './agent-tools.mjs';
import { unmention } from './mention.mjs';
import { rulingTableLines } from './rulings.mjs';
import { approachSummary } from './approach.mjs';
import { approachLine, approachOthersLine } from '../web/approach-text.mjs';
import { pairChangeText, pairWarnings, redGreenDefectLines, redGreenLine, redGreenWarningLines, redGreenWarningText } from '../web/red-green-text.mjs';
import { stepProgress } from './plan-progress.mjs';
import { planStepsLine, stepStateText } from '../web/plan-steps-text.mjs';
import { returnStageLines, reviewStagesLine, reviewStagesWarningLines } from '../web/review-stages-text.mjs';
import { returnStages } from './review-stages.mjs';

export const PR_BODY_LIMITS = { report: 6000, inline: 200, detail: 300, proofs: 20, files: 5, compare: 8, redGreen: 5, rulings: 10, steps: 10, body: 60_000 };

const INVISIBLE = /[\s\p{Cc}\p{Cf}]+/gu;
const HIDDEN = /[\p{Cc}\p{Cf}](?<![\n\t])/gu;
const chars = (text) => Array.from(text);
const cut = (text, limit) => { const all = chars(text); return all.length > limit ? `${all.slice(0, limit - 1).join('')}…` : text; };
export { unmention };

export function inline(value, limit = PR_BODY_LIMITS.inline) {
  const text = cut(String(value ?? '').replace(INVISIBLE, ' ').trim(), limit);
  return unmention(text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}

export function code(value, limit = PR_BODY_LIMITS.inline, table = false) {
  const text = cut(String(value ?? '').replace(INVISIBLE, ' ').trim(), limit) || ' ';
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${table ? text.replace(/\|/g, '\\|') : text}${pad}${fence}`;
}

export function quoteMarkdown(value, limit = PR_BODY_LIMITS.report) {
  const lines = String(value).replace(/\r\n?/g, '\n').replace(HIDDEN, '').split('\n');
  const out = [];
  let fence = null, used = 0, truncated = false;
  for (const line of lines) {
    const size = chars(line).length + 1;
    if (used + size > limit) { truncated = true; break; }
    used += size;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
      out.push(line);
      continue;
    }
    if (marker) { fence = marker; out.push(line); continue; }
    const heading = /^( {0,3})(#{1,6})(?=\s|$)/.exec(line);
    let text = heading ? `${heading[1]}${'#'.repeat(Math.min(6, heading[2].length + 2))}${line.slice(heading[0].length)}` : line;
    text = text.split(/(`+[^`]*?`+)/).map((part, index) => (index % 2 ? part : unmention(part.replace(/<!--/g, '&lt;!--')))).join('');
    out.push(text);
  }
  if (fence) out.push(fence);
  return { text: out.join('\n').trim(), truncated };
}

const phaseName = (phase, language) => (language === 'en' ? phase : LABELS[phase]);
const AC_STATUS = { pass: 'prBody.acPass', fail: 'prBody.acFail', unverified: 'prBody.acUnverified', pending: 'prBody.acPending' };

export async function buildPrBody(root, id, { language = cliText().language, observe } = {}) {
  const { say } = cliText(language);
  const feature = await getFeature(root, id);
  observe ??= createTreeObserver(root);
  const source = `.wax/features/${id}.json`;
  const missing = [];
  const lines = [];
  const push = (...items) => lines.push(...items);

  push(`<!-- ${say('prBody.titleComment', inline(feature.title).replace(/--/g, '- -'))} -->`, '');
  push(say('prBody.generated', code(source), code(`wax pr-body ${id}`)), '');
  const done = PHASES.filter((phase) => feature.completed[phase]).map((phase) => phaseName(phase, language));
  push(say('prBody.state', feature.phase === 'done' ? say('prBody.allDone') : phaseName(feature.phase, language), feature.iteration, feature.revision, done.length ? done.join(', ') : say('prBody.none')));
  if (feature.archivedAt) push('', say('prBody.archived'));
  if (!feature.completed.report) { missing.push('report-incomplete'); push('', say('prBody.reportNotCompleted')); }

  push('', `## ${say('prBody.summary')}`, '');
  if (feature.artifacts.report?.trim()) {
    const { text, truncated } = quoteMarkdown(feature.artifacts.report);
    push(text || say('prBody.reportEmpty'));
    if (truncated) push('', say('prBody.reportTruncated', PR_BODY_LIMITS.report, code(`docs/wax/${id}/report.md`)));
  } else {
    missing.push('report');
    push(say('prBody.reportMissing', code(`wax save report ${id} --file docs/wax/${id}/report.md`)));
  }

  const proofs = feature.proofs ?? [];
  const short = (proofId) => code(String(proofId).slice(0, 8));
  const describe = (proofId, table = false) => {
    const proof = proofs.find((item) => item.id === proofId);
    if (!proof) return say('prBody.proofMissing', short(proofId));
    if (proof.kind === 'git') return say('prBody.commitRef', code(proof.commit.slice(0, 12)));
    return say('prBody.testRef', code(proof.command.join(' '), 80, table), proof.exitCode ?? 'null', short(proof.id));
  };
  push('', `## ${say('prBody.acceptance')}`, '');
  const trace = acceptanceTrace(feature);
  if (!trace.length) { missing.push('acceptance'); push(say('prBody.noAcceptance')); }
  else {
    push(`| ${say('prBody.acColumn')} | ${say('prBody.statusColumn')} | ${say('prBody.evidenceColumn')} |`, '| --- | --- | --- |');
    for (const item of trace) {
      const linked = item.proofIds.map((proofId) => describe(proofId, true)).join('; ') || '-';
      push(`| ${item.id} | ${say(AC_STATUS[item.status])} | ${linked}${item.detail ? ` — ${inline(item.detail, PR_BODY_LIMITS.detail)}` : ''} |`);
    }
    if (!feature.completed.review) { missing.push('review'); push('', say('prBody.reviewPending')); }
    if (feature.completed.review?.acWaiver) push('', say('prBody.acWaiver', inline(feature.completed.review.acWaiver, PR_BODY_LIMITS.detail)));
  }
  push(...reviewStageLines(feature, { say }));

  push('', ...await qualityGlance(root, feature, { say, short }));

  const approach = approachSummary(feature);
  if (approach) push('', `## ${say('approach.heading')}`, '', approachLine(approach, say, (value) => inline(value)), ...(approachOthersLine(approach, say, (value) => inline(value)) ? ['', approachOthersLine(approach, say, (value) => inline(value))] : []));
  const rulings = rulingTableLines(feature, { say, inline, phaseName: (phase) => phaseName(phase, language), limit: PR_BODY_LIMITS.rulings });
  if (rulings.length) push('', `## ${say('rulings.table.heading')}`, '', ...rulings);

  push(...await workerLines(root, feature, { say, language }));

  const current = proofs.filter((proof) => proof.iteration === feature.iteration).sort((a, b) => a.at.localeCompare(b.at));
  const older = proofs.length - current.length;
  push('', `## ${say('prBody.verification')}`, '');
  const tests = current.filter((proof) => proof.kind === 'test'), commits = current.filter((proof) => proof.kind === 'git');
  const outcome = (proof) => (proof.timedOut ? say('prBody.timedOut') : proof.exitCode === 0 ? say('prBody.passed') : say('prBody.failed'));
  const author = (proof) => (proof.author ? `, ${say('prBody.by', code(proof.author, 45))}` : '');
  if (!tests.length && !commits.length) { missing.push('proofs'); push(say('prBody.noProofs')); }
  push(...redGreenLines(feature, { say, describe }));
  push(...planStepLines(feature, { say, describe, limit: PR_BODY_LIMITS.steps }));
  if (tests.length) {
    push(`### ${say('prBody.tests')}`, '');
    for (const proof of tests.slice(-PR_BODY_LIMITS.proofs)) {
      const ran = proof.commit ? say('prBody.ranAt', code(proof.commit.slice(0, 12)), proof.dirty === true ? say('prBody.dirty') : proof.dirty === false ? say('prBody.clean') : say('prBody.unknownTree')) : say('prBody.noGit');
      push(`- ${code(proof.command.join(' '), 160)} — ${outcome(proof)} (exit ${proof.exitCode ?? 'null'}), ${phaseName(proof.phase, language)}, ${ran}, ${code(proof.at, 40)}${author(proof)}, ${say('prBody.proofId', short(proof.id))}`);
    }
    if (tests.length > PR_BODY_LIMITS.proofs) push(say('prBody.moreProofs', tests.length - PR_BODY_LIMITS.proofs));
    push('');
  }
  if (commits.length) {
    push(`### ${say('prBody.commits')}`, '');
    for (const proof of commits.slice(-PR_BODY_LIMITS.proofs)) push(`- ${code(proof.commit)} — ${say('prBody.fileCount', proof.files.length)}, ${phaseName(proof.phase, language)}, ${code(proof.at, 40)}${author(proof)}`);
    if (commits.length > PR_BODY_LIMITS.proofs) push(say('prBody.moreProofs', commits.length - PR_BODY_LIMITS.proofs));
    push('');
  }
  const captures = [];
  let captureTotal = 0;
  for (const phase of PHASES) {
    const found = await listCaptures(root, feature.id, phase, feature.iteration, PR_BODY_LIMITS.proofs);
    captureTotal += found.total;
    captures.push(...found.captures.map((capture) => ({ phase, ...capture })));
  }
  if (captures.length) {
    push(`### ${say('prBody.captures')}`, '');
    for (const capture of captures.slice(-PR_BODY_LIMITS.proofs)) {
      const label = captureLabelText(capture, say);
      push(`- ${code(capture.check)}${label ? ` ${inline(label, 80)}` : ''} — ${phaseName(capture.phase, language)}, ${code(capture.artifact, 200)}`);
    }
    if (captureTotal > Math.min(captures.length, PR_BODY_LIMITS.proofs)) push(say('prBody.moreCaptures', captureTotal - Math.min(captures.length, PR_BODY_LIMITS.proofs)));
    push('');
  }
  const compare = await compareCaptures(root, feature.id, { handoffs: false }).catch(() => null);
  if (hasComparison(compare)) push(`### ${say('prBody.compare')}`, '', ...compareLines(compare, say, PR_BODY_LIMITS.compare), '');
  if (older) push(say('prBody.olderProofs', older), '');
  if (lines.at(-1) === '') lines.pop();

  const waivers = PHASES.filter((phase) => feature.completed[phase]?.waiver);
  if (waivers.length) {
    push('', `## ${say('prBody.waivers')}`, '');
    for (const phase of waivers) push(`- ${phaseName(phase, language)}: ${inline(feature.completed[phase].waiver, PR_BODY_LIMITS.detail)}`);
  }

  const usage = await import('./chat/pm-loop.mjs').then(({ featureUsage }) => featureUsage(root, id)).catch(() => null);
  const used = usageLines(usage, say);
  if (used.length) push('', `## ${say('usage.heading')}`, '', ...used.map((line) => `- ${inline(line, PR_BODY_LIMITS.detail)}`), '', say('usage.note'));

  push('', `## ${say('prBody.freshness')}`, '');
  let stale = 0, unknown = 0;
  const basis = freshnessBasis(feature);
  const fingerprinted = current.filter((proof) => proof.tree);
  for (const proof of fingerprinted) {
    const seen = await observe(proof.tree);
    if (seen.state === 'unknown') { unknown += 1; continue; }
    if (seen.state !== 'changed') continue;
    stale += 1;
    const label = describe(proof.id);
    const names = seen.files.slice(0, PR_BODY_LIMITS.files).map((file) => code(file, 120)).join(', ');
    push(`- ${label}${proof.id === basis?.id ? ` (${say('prBody.basis')})` : ''}: ${say('prBody.changedFiles', seen.files.length, names)}${seen.files.length > PR_BODY_LIMITS.files ? ` ${say('prBody.moreFiles', seen.files.length - PR_BODY_LIMITS.files)}` : ''}`);
  }
  if (!fingerprinted.length) { missing.push('freshness'); push(say('prBody.freshnessNone')); }
  else {
    if (!stale && !unknown) push(say('prBody.freshnessClean', fingerprinted.length));
    if (unknown) push(`${stale ? '\n' : ''}${say('prBody.freshnessUnknown', unknown)}`);
    if (stale) push('', say('prBody.freshnessNote'));
  }

  push('', '---', say('prBody.footer'));
  let body = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  if (chars(body).length > PR_BODY_LIMITS.body) body = `${cut(body, PR_BODY_LIMITS.body - 200)}\n\n${say('prBody.bodyTruncated')}\n`;
  return { id, title: feature.title, language, body, missing, stale };
}

export function reviewStageLines(feature, { say }) {
  const stages = feature.completed?.review?.stages;
  const returned = returnStageLines(returnStages(feature).filter((item) => item.stage), say);
  if (!stages && !returned.length) return [];
  return ['', `### ${say('reviewStages.title')}`, '', ...(stages ? [`- ${reviewStagesLine(stages, say)}`, ...reviewStagesWarningLines(stages, say).map((line) => `- ${line}`)] : []),
    ...returned.map((line) => `- ${line}`)];
}

export function redGreenLines(feature, { say, describe }) {
  const record = feature.completed?.implement?.redGreen;
  if (!record) return [];
  const lines = [`- ${redGreenLine(record, say)}`];
  if (record.pairs.length) {
    lines.push('', `| ${say('prBody.redGreenCheck')} | ${say('redGreen.red')} | ${say('redGreen.green')} | ${say('prBody.redGreenChanged')} | ${say('prBody.redGreenWarnings')} |`, '| --- | --- | --- | --- | --- |');
    for (const pair of record.pairs.slice(0, PR_BODY_LIMITS.redGreen)) {
      const warnings = pairWarnings(pair).filter((item) => item !== 'treeUnknown').map((item) => redGreenWarningText(item, say));
      lines.push(`| ${code(pair.check, 64, true)}${pair.defect ? ` (${pair.defect})` : ''} | ${describe(pair.red, true)} | ${describe(pair.green, true)} | ${inline(pairChangeText(pair, say), 80)} | ${warnings.length ? inline(warnings.join(' '), 200) : '-'} |`);
    }
    if (record.pairs.length > PR_BODY_LIMITS.redGreen) lines.push('', say('prBody.moreRedGreen', record.pairs.length - PR_BODY_LIMITS.redGreen));
  } else for (const line of redGreenWarningLines(record, say)) lines.push(`- ${line}`);
  const defects = redGreenDefectLines(record, say);
  if (defects.length) lines.push('', `- ${defects.join(' · ')}`);
  if (record.waiver) lines.push('', say('prBody.redGreenWaiver'), '', `> ${inline(record.waiver, PR_BODY_LIMITS.detail)}`);
  lines.push('');
  return lines;
}

export function planStepLines(feature, { say, describe, limit = PR_BODY_LIMITS.steps }) {
  const progress = stepProgress(feature);
  if (!progress) return [];
  const lines = [`- ${planStepsLine(progress, say)}`, '', `| ${say('planSteps.column.step')} | ${say('planSteps.column.check')} | ${say('planSteps.column.progress')} |`, '| --- | --- | --- |'];
  for (const row of progress.steps.slice(0, limit)) {
    const check = row.check ? code(row.check, 120, true) : '-';
    const state = inline(stepStateText(row, say, row.none ? cut(row.none, 120) : null), 200);
    lines.push(`| ${row.id}${row.title ? ` ${inline(row.title, 120)}` : ''} | ${check} | ${state}${row.proof ? ` (${describe(row.proof, true)})` : ''} |`);
  }
  if (progress.steps.length > limit) lines.push('', say('planSteps.more', progress.steps.length - limit));
  lines.push('');
  return lines;
}

export async function qualityGlance(root, feature, { say, short = (proofId) => code(String(proofId).slice(0, 8)) }) {
  const { CHARACTERISTICS, characteristicEvidence, manualCheckEvidence } = await import('./quality-report.mjs');
  const { openDefects } = await import('./defects.mjs');
  const lines = [`## ${say('prBody.quality')}`, ''];
  const items = characteristicEvidence(feature);
  const label = (id) => say(CHARACTERISTICS.find((item) => item.id === id).label);
  const covered = items.filter((item) => item.pass || item.fail)
    .map((item) => (item.fail ? say('prBody.qualityFailed', label(item.id), item.pass, item.fail) : say('prBody.qualityPassed', label(item.id), item.pass)));
  const none = items.filter((item) => !item.pass && !item.fail).length;
  lines.push(`- ${covered.length ? say('prBody.qualityCharacteristics', covered.join(' · '), none) : say('prBody.qualityNoCharacteristics', none)}`);
  const defects = feature.defects ?? [];
  const open = openDefects(feature);
  lines.push(`- ${defects.length ? say('prBody.qualityDefects', defects.length, open.length, open.length ? open.slice(0, 8).map((item) => code(item.id, 12)).join(', ') : '-') : say('prBody.qualityNoDefects')}`);
  const manual = await import('./manual.mjs').then(({ approvedManual }) => approvedManual(root)).catch(() => null);
  if (manual?.checks?.length) {
    const marks = manualCheckEvidence(feature, manual.checks)
      .map((item) => `${code(item.check, 80)} ${item.proofId ? say('prBody.qualityCheckPassed', short(item.proofId)) : say('prBody.qualityCheckMissing')}`);
    lines.push(`- ${say('prBody.qualityManual', marks.join(' · '))}`);
  }
  lines.push('', say('prBody.qualityFull', code(`wax quality-report ${feature.id}`)));
  return lines;
}

const RETRY_RULES = new Set(['switch-unhealthy', 'retry-transient', 'retry-unfinished', 'retry-judge', 'judge-block', 'apply-retry', 'apply-reassign']);

export async function workerLines(root, feature, { say, language }) {
  const decisions = await import('./chat/pm-loop.mjs').then(({ featureDecisions }) => featureDecisions(root, feature.id)).catch(() => []);
  const iteration = feature.iteration ?? 0;
  const mine = decisions.filter((item) => item.iteration === undefined || item.iteration === null || item.iteration === iteration);
  const launched = mine.filter((item) => item.kind === 'worker' && item.outcome === 'launched' && typeof item.tool === 'string');
  if (!launched.length) return [];
  const label = (tool) => { try { return agentTool(tool).label; } catch { return tool; } };
  const lines = ['', `## ${say('prBody.workers')}`, '', `| ${say('prBody.phaseColumn')} | ${say('prBody.toolsColumn')} | ${say('prBody.completedByColumn')} | ${say('prBody.rulesColumn')} |`, '| --- | --- | --- | --- |'];
  for (const phase of PHASES) {
    const tools = launched.filter((item) => item.phase === phase).map((item) => item.tool).filter((tool, index, all) => tool !== all[index - 1]);
    if (!tools.length) continue;
    const rules = [...new Set(mine.filter((item) => item.phase === phase && item.by === 'auto' && RETRY_RULES.has(item.rule)).map((item) => item.rule))];
    const author = feature.completed[phase]?.author;
    lines.push(`| ${language === 'en' ? phase : LABELS[phase]} | ${tools.map((tool) => inline(label(tool), 40)).join(' → ')} | ${author ? code(author, 45, true) : say('prBody.notCompleted')} | ${rules.length ? rules.map((rule) => code(rule, 40, true)).join(', ') : '-'} |`);
  }
  lines.push('', say('prBody.workersNote'));
  return lines;
}

export async function writePrBody(path, body) {
  const target = resolve(path);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new WaxError(t('errors.prBody.outMustBeAFile', path));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(target, body, { mode: 0o600 });
  return target;
}
