import { lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { t } from '../web/messages-catalog.mjs';
import { getFeature, LABELS, PHASES, WaxError } from './workflow.mjs';
import { acceptanceTrace } from './acceptance.mjs';
import { createTreeObserver, freshnessBasis } from './freshness.mjs';
import { cliText } from './cli-locale.mjs';
import { captureLabelText, listCaptures } from './capture.mjs';
import { compareCaptures, compareLines, hasComparison } from './visual-compare.mjs';

export const PR_BODY_LIMITS = { report: 6000, inline: 200, detail: 300, proofs: 20, files: 5, compare: 8, body: 60_000 };

const INVISIBLE = /[\s\p{Cc}\p{Cf}]+/gu;
const HIDDEN = /[\p{Cc}\p{Cf}](?<![\n\t])/gu;
const chars = (text) => Array.from(text);
const cut = (text, limit) => { const all = chars(text); return all.length > limit ? `${all.slice(0, limit - 1).join('')}…` : text; };
const MENTION = /(^|[^\p{L}\p{N}_`/@.+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?)?)/gu;
export const unmention = (text) => text.replace(MENTION, (_, before, name) => `${before}\`@${name}\``);

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

  const current = proofs.filter((proof) => proof.iteration === feature.iteration).sort((a, b) => a.at.localeCompare(b.at));
  const older = proofs.length - current.length;
  push('', `## ${say('prBody.verification')}`, '');
  const tests = current.filter((proof) => proof.kind === 'test'), commits = current.filter((proof) => proof.kind === 'git');
  const outcome = (proof) => (proof.timedOut ? say('prBody.timedOut') : proof.exitCode === 0 ? say('prBody.passed') : say('prBody.failed'));
  const author = (proof) => (proof.author ? `, ${say('prBody.by', code(proof.author, 45))}` : '');
  if (!tests.length && !commits.length) { missing.push('proofs'); push(say('prBody.noProofs')); }
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

export async function writePrBody(path, body) {
  const target = resolve(path);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new WaxError(t('errors.prBody.outMustBeAFile', path));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(target, body, { mode: 0o600 });
  return target;
}
