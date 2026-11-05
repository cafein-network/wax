import { t } from '../web/messages-catalog.mjs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { goalOverview, pmLoopOverview, workerTools } from './chat/pm-loop.mjs';
import { cliText } from './cli-locale.mjs';
import { costLimitText, usageLines } from './tool-usage.mjs';

export async function pmLoopCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project || process.cwd());
  const { say, localize } = cliText();
  const [command, id] = positionals;
  if (values.help || !command) { console.log(say('cli.pmLoop.help')); return; }
  const budget = (goal) => say('cli.pmLoop.budget', goal.budget.usage.phaseRuns, goal.budget.limits.phaseRuns, goal.budget.usage.workers, goal.budget.limits.workers,
    goal.budget.usage.hours, goal.budget.limits.hours, goal.budget.usage.iterations, goal.budget.limits.iterations);
  const hypothesis = (item) => (item.missing ? say('pmLoop.rootCause.missing')
    : `${say('pmLoop.rootCause.hypothesis', item.hypothesis ?? '', say({ fixed: 'pmLoop.rootCause.fixed', 'not-fixed': 'pmLoop.rootCause.notFixed' }[item.result] ?? 'pmLoop.rootCause.unknown'))}${item.reproduced === false ? ` · ${say('pmLoop.rootCause.notReproduced')}` : ''}`);
  const card = (item) => `${item.feature ?? '-'}  ${item.phase ?? '-'}  ${item.kind}${item.to ? ` → ${item.to}` : ''}${item.human ? `  ${say('cli.pmLoop.human')}` : ''}\n    ${localize(item.reason)}`;
  if (command === 'list') {
    if (positionals.length !== 1) throw new Error(t('errors.pmLoopCli.usage'));
    const overview = await pmLoopOverview(root, { tools: await workerTools().catch(() => []) });
    if (values.json) { console.log(JSON.stringify(overview, null, 2)); return; }
    if (!overview.goals.length) { console.log(say('cli.pmLoop.none')); return; }
    const summary = overview.repeatReview;
    if (summary?.total) console.log(summary.unsure ? say('pmLoop.review.summaryUnsure', summary.right, summary.wrong, summary.unsure, summary.unrated) : say('pmLoop.review.summary', summary.right, summary.wrong, summary.unrated));
    for (const goal of overview.goals) console.log(`${goal.id}  [${goal.state}]  [${goal.mode}]  ${goal.title}  · ${say('cli.pmLoop.counts', goal.features.length, goal.suggestions.length, goal.waiting.length)}`);
    return;
  }
  if (!['show', 'next'].includes(command) || positionals.length !== 2) throw new Error(t('errors.pmLoopCli.usage'));
  const goal = await goalOverview(root, id, { tools: await workerTools().catch(() => []) });
  if (command === 'next') {
    if (values.json) { console.log(JSON.stringify({ goal: goal.id, state: goal.state, suggestions: goal.suggestions }, null, 2)); return; }
    console.log(say('cli.pmLoop.nextHeader', goal.id, goal.state));
    if (!goal.suggestions.length) console.log(`  ${say('cli.pmLoop.noSuggestions')}`);
    for (const item of goal.suggestions) console.log(`  ${card(item)}`);
    console.log(say('cli.pmLoop.readOnly'));
    return;
  }
  if (values.json) { console.log(JSON.stringify(goal, null, 2)); return; }
  console.log(`${goal.id}  [${goal.state}]  ${goal.title}`);
  console.log(`  ${say('cli.pmLoop.mode', goal.mode, goal.mode === 'auto' ? say('cli.pmLoop.modeBy', goal.auto?.by ?? '-', goal.auto?.used ?? 0, goal.auto?.cap ?? '-') : '')}`);
  if (goal.recipe) console.log(`  ${say('trace.recipeLabel')} ${localize(goal.recipe.title)} (${goal.recipe.id}, ${goal.recipe.source ?? '-'})`);
  console.log(`  ${budget(goal)}`);
  if (Number.isSafeInteger(goal.budget.limits.tokens)) console.log(`  ${say('cli.pmLoop.tokens', goal.budget.usage.tokens ?? 0, goal.budget.limits.tokens)}`);
  if (typeof goal.budget.limits.costUsd === 'number') console.log(`  ${costLimitText(goal.budget.usage, goal.budget.limits.costUsd, say)}`);
  for (const line of usageLines(goal.usage, say)) console.log(`  ${say('cli.pmLoop.usage', line)}`);
  console.log(`  ${say('cli.pmLoop.judgeTool', goal.judge?.label ?? '-', goal.judge?.setting ? say('cli.pmLoop.judgeToolSet') : say('cli.pmLoop.judgeToolDefault'))}`);
  if (goal.stoppedReason) console.log(`  ${say('cli.pmLoop.stopped', localize(goal.stoppedReason))}`);
  for (const worker of goal.workers ?? []) {
    console.log(`  ${say('cli.pmLoop.worker', worker.id, worker.label, worker.feature, worker.phase ?? '-')}${worker.repeat ? `  · ${say('cli.pmLoop.repeat', worker.repeat.count, worker.repeat.command || '-')}` : ''}${worker.rootCause ? `  · ${say('pmLoop.rootCause.mode', worker.rootCause.attempt ?? '-')}` : ''}`);
  }
  for (const feature of goal.features) console.log(`  ${feature.id}  ${feature.phase ?? '-'}  ${feature.assignee ? `${feature.assignee.to} (${feature.assignee.task})` : '-'}  ${feature.next.kind}  · ${localize(feature.next.reason)}`);
  if (goal.repeatReviews?.length) {
    console.log(say('cli.pmLoop.reviewsHeader'));
    for (const item of goal.repeatReviews) {
      const verdict = item.review ? `${say({ right: 'pmLoop.review.right', wrong: 'pmLoop.review.wrong', unsure: 'pmLoop.review.unsure' }[item.review.verdict] ?? 'pmLoop.review.wrong')} · ${item.review.by ?? '-'}${item.review.note ? ` · ${item.review.note}` : ''}` : say('cli.pmLoop.reviewNone');
      console.log(`  ${item.at}  ${say(item.subject === 'repeat-stuck' ? 'pmLoop.outcome.stuck' : 'pmLoop.review.warned')}  ${item.feature ?? '-'}  ${item.repeat.command || '-'}  → ${verdict}`);
    }
  }
  if (goal.decisions.length) {
    console.log(say('cli.pmLoop.decisions'));
    for (const decision of goal.decisions.slice(0, 10)) {
      console.log(`  ${decision.at}  ${decision.kind} ${decision.outcome}${decision.by ? ` · ${decision.by}` : ''}${decision.reason ? ` · ${localize(decision.reason)}` : ''}`);
      if (decision.repeat) console.log(`    ${say('cli.pmLoop.repeatProofs', decision.repeat.count, (decision.repeat.proofIds ?? []).join(', ') || '-')}`);
      if (decision.rootCause) console.log(`    ${say('cli.pmLoop.rootCause', decision.rootCause.attempt ?? '-', hypothesis(decision.rootCause))}`);
    }
  }
}
