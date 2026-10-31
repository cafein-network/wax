#!/usr/bin/env node
import { t } from '../web/messages-catalog.mjs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildPrompt, completePhase, createFeature, getFeature, listFeatures, updateFeature } from '../src/workflow.mjs';
import { approvedRules, rulesPrompt } from '../src/chat/rules.mjs';
import { diagnoseProject } from '../src/diagnostics.mjs';
import { createBackup, previewRestore, restoreBackup } from '../src/backup.mjs';
import { collectGitProof, runTestProof } from '../src/evidence.mjs';
import { captureArtifact } from '../src/capture.mjs';
import { evidenceFreshness, freshnessText } from '../src/freshness.mjs';
import { featureStatus } from '../src/status.mjs';
import { cliText } from '../src/cli-locale.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const { say, localize } = cliText();


const raw = process.argv.slice(2);
let first = 0;
while (raw[first] === '--project' || raw[first]?.startsWith('--project=')) first += raw[first] === '--project' ? 2 : 1;
if (raw[first] === 'approvals') {
  try {
    const { approvalCli } = await import('../src/approval-cli.mjs');
    await approvalCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax approvals: ${localize(error.message)}`); process.exitCode = 1; }
} else if (raw[first] === 'search') {
  try {
    const { searchCli } = await import('../src/search-cli.mjs');
    await searchCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax search: ${localize(error.message)}`); process.exitCode ||= error.state ? 2 : 1; }
} else if (raw[first] === 'wiki') {
  try {
    const { wikiCli } = await import('../src/wiki-cli.mjs');
    await wikiCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax wiki: ${localize(error.message)}`); process.exitCode = 1; }
} else if (raw[first] === 'recall') {
  try {
    const { recallCli } = await import('../src/recall.mjs');
    await recallCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax recall: ${localize(error.message)}`); process.exitCode ||= error.state ? 2 : 1; }
} else if (raw[first] === 'trigger') {
  try {
    const { triggerCli } = await import('../src/trigger-cli.mjs');
    await triggerCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax trigger: ${localize(error.message)}`); process.exitCode = 1; }
} else if (raw[first] === 'pm-loop') {
  try {
    const { pmLoopCli } = await import('../src/pm-loop-cli.mjs');
    await pmLoopCli([...raw.slice(0, first), ...raw.slice(first + 1)]);
  } catch (error) { console.error(`wax pm-loop: ${localize(error.message)}`); process.exitCode = 1; }
} else if (raw[first] === 'mcp') {
  try {
    const { mcpCli } = await import('../src/mcp.mjs');
    await mcpCli([...raw.slice(0, first), ...raw.slice(first + 1)], { version });
  } catch (error) { console.error(`wax mcp: ${localize(error.message)}`); process.exitCode = 1; }
} else if (raw[first] === 'chat' || raw[first] === 'dashboard') {
  const { main } = await import('../src/chat/cli.mjs');
  await main([...raw.slice(0, first), ...(raw[first] === 'dashboard' ? ['serve'] : []), ...raw.slice(first + 1)]);
} else await runWorkflow();

function intOption(values, name) {
  if (values[name] === undefined) return undefined;
  const number = Number(values[name]);
  if (!Number.isInteger(number)) throw new Error(t('errors.wax.mustBeAnInteger', name, values[name]));
  return number;
}
async function readJsonOption(name, path) {
  let text;
  try { text = await readFile(resolve(path), 'utf8'); } catch (error) { throw new Error(t('errors.wax.couldNotReadThe', name, path, error.code ?? error.message)); }
  try { return JSON.parse(text); } catch (error) { throw new Error(t('errors.wax.theFileIsNot', name, path, error.message)); }
}

async function runWorkflow() {
try {
  const args = process.argv.slice(2), separator = args.indexOf('--');
  const commandArgs = separator < 0 ? [] : args.slice(separator + 1);
  const { values, positionals } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true, options: {
    project: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
    file: { type: 'string' }, evidence: { type: 'string' }, verdict: { type: 'string' }, type: { type: 'string' }, verification: { type: 'string' }, checks: { type: 'string' }, 'checks-file': { type: 'string' },
    reason: { type: 'string' }, revision: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    prefix: { type: 'string' }, apply: { type: 'string' }, commit: { type: 'string' }, proofs: { type: 'string' }, 'no-proof': { type: 'string' }, 'ac-unverified': { type: 'string' }, author: { type: 'string' }, timeout: { type: 'string' }, budget: { type: 'string' }, check: { type: 'string' }, viewport: { type: 'string' }, scroll: { type: 'string' }, state: { type: 'string' },
    out: { type: 'string' }, json: { type: 'boolean' }
  } });
  const [command, first, second] = positionals;
  const root = resolve(values.project ?? process.cwd());
  if (values.version) { console.log(version); }
  else if (!command || values.help || command === 'help') { console.log(say('cli.wax.help', version)); }
  else {
    const revision = values.revision === undefined ? undefined : Number(values.revision);
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new Error(t('errors.wax.revisionMustBeA'));
    let result;
    if (command === 'start') result = await createFeature(root, { id: first, title: values.title ?? first, description: values.description, projectType: values.type });
    else if (command === 'status') result = first ? await featureStatus(root, first) : await listFeatures(root);
    else if (command === 'context') {
      if (positionals.length !== 2) throw new Error(t('errors.wax.usageContextIdBudget'));
      const { buildContext } = await import('../src/context.mjs');
      process.stdout.write(await buildContext(root, first, { budget: intOption(values, 'budget') }));
      return;
    }
    else if (command === 'pr-body') {
      if (positionals.length !== 2 || values.out === '') throw new Error(t('errors.wax.usagePrBody'));
      const { buildPrBody, writePrBody } = await import('../src/pr-body.mjs');
      const draft = await buildPrBody(root, first);
      const out = values.out === undefined ? undefined : await writePrBody(values.out, draft.body);
      if (values.json) console.log(JSON.stringify({ ...draft, ...(out ? { out } : {}) }, null, 2));
      else if (!out) process.stdout.write(draft.body);
      else {
        console.log(say('cli.prBody.saved', out));
        if (draft.missing.length) console.log(say('cli.prBody.missing', draft.missing.join(', ')));
        console.log(say('cli.prBody.next', JSON.stringify(out)));
      }
      return;
    }
    else if (command === 'trace') {
      if (positionals.length !== 2 || values.out !== undefined) throw new Error(t('errors.wax.usageTrace'));
      const { buildRunTrace } = await import('../src/run-trace.mjs');
      const { markdown, ...trace } = await buildRunTrace(root, first);
      if (values.json) console.log(JSON.stringify(trace, null, 2)); else process.stdout.write(markdown);
      return;
    }
    else if (command === 'compare') {
      if (positionals.length !== 2 || values.out !== undefined) throw new Error(t('errors.wax.usageCompare'));
      const { compareCaptures, renderCompareMarkdown } = await import('../src/visual-compare.mjs');
      const compare = await compareCaptures(root, first);
      if (values.json) console.log(JSON.stringify(compare, null, 2)); else process.stdout.write(renderCompareMarkdown(compare));
      return;
    }
    else if (command === 'doctor') { result = await diagnoseProject(root); if (!result.ok) process.exitCode = 1; }
    else if (command === 'backup') result = await createBackup(root);
    else if (command === 'import') {
      if (!values.file) throw new Error(t('errors.wax.fileNeedsTheBackup'));
      const backup = await readJsonOption('file', values.file);
      result = values.apply ? await restoreBackup(root, backup, { prefix: values.prefix, fingerprint: values.apply }) : await previewRestore(root, backup, values.prefix);
      if (result.failed?.length) process.exitCode = 1;
    }
    else if (command === 'evidence') { const feature = await getFeature(root, first); result = await updateFeature(root, first, 'attach-evidence', { proof: await collectGitProof(root, feature, values.commit, { author: values.author }), revision: revision ?? feature.revision }); }
    else if (command === 'test') { result = await runTestProof(root, first, commandArgs, { revision, timeout: intOption(values, 'timeout'), verification: values.verification, checks: values.checks?.split(','), author: values.author }); if (!result.recorded || result.proof.exitCode !== 0 || result.proof.timedOut) process.exitCode = 1; }
    else if (command === 'capture') result = await captureArtifact(root, first, { check: values.check, file: values.file, command: commandArgs, revision, timeout: intOption(values, 'timeout'), viewport: values.viewport, scroll: values.scroll, state: values.state });
    else if (command === 'prompt') {
      const feature = await getFeature(root, second);
      const freshness = first === 'report' ? freshnessText(await evidenceFreshness(root, feature)) : '';
      console.log(buildPrompt(feature, first, { rules: rulesPrompt(await approvedRules(root)), freshness })); process.exit(0);
    }
    else if (command === 'save') {
      if (!values.file) throw new Error(t('errors.wax.fileNeedsTheDocument'));
      result = await updateFeature(root, second, 'save', { phase: first, content: await readFile(resolve(values.file), 'utf8'), revision });
    } else if (command === 'complete') {
      const done = await completePhase(root, second, first, { evidence: values.evidence, verdict: values.verdict, author: values.author, revision, proofIds: values.proofs, waiver: values['no-proof'], acWaiver: values['ac-unverified'], checks: values['checks-file'] ? await readJsonOption('checks-file', values['checks-file']) : undefined });
      if (done.warning) console.error(`wax: ${say('cli.warning', localize(done.warning))}`);
      result = done.feature;
    }
    else if (command === 'iterate') result = await updateFeature(root, first, 'iterate', { reason: values.reason, author: values.author, revision });
    else if (command === 'edit') result = await updateFeature(root, first, 'edit', { title: values.title, description: values.description, revision });
    else if (command === 'archive' || command === 'restore') result = await updateFeature(root, first, command === 'archive' ? 'archive-feature' : 'restore', { revision });
    else throw new Error(t('errors.wax.unknownCommandSeeHelp', command));
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(`wax: ${localize(error.message)}`); process.exitCode = 1; }
}
