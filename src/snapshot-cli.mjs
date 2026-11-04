import { t } from '../web/messages-catalog.mjs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { RUN_ID, listRuns, runFileDiff, runSummary } from './snapshots.mjs';
import { cliText } from './cli-locale.mjs';

const MARK = { '+': '+', '-': '-', '@': '', ' ': ' ' };
const STATE = { new: 'trace.runState.new', delete: 'trace.runState.delete', modify: 'trace.runState.modify' };

export async function snapshotCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, goal: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project || process.cwd());
  const { say } = cliText();
  const [command, id] = positionals;
  if (values.help || !command) { console.log(say('cli.snapshot.help')); return; }
  if (command === 'list') {
    if (positionals.length !== 1 || (values.goal !== undefined && !/^goal-[a-f0-9]{8}$/.test(values.goal))) throw new Error(t('errors.snapshotCli.usage'));
    const runs = await listRuns(root, { goal: values.goal ?? null });
    const rows = runs.map((item) => ({ run: item.run, kind: item.kind, state: item.state, reason: item.reason, goal: item.goal, feature: item.feature, phase: item.phase, tool: item.tool,
      by: item.by, target: item.target, at: item.before?.at ?? null, endedAt: item.after?.at ?? null }));
    if (values.json) { console.log(JSON.stringify({ runs: rows }, null, 2)); return; }
    if (!rows.length) { console.log(say('cli.snapshot.none')); return; }
    for (const row of rows) {
      const who = row.kind === 'restore' ? say('cli.snapshot.restoreOf', row.target ?? '-', row.by ?? '-') : `${row.tool ?? '-'}`;
      console.log(`${row.run}  [${row.state}${row.reason ? `: ${row.reason}` : ''}]  ${row.goal ?? '-'}  ${row.feature ?? '-'}  ${row.phase ?? '-'}  ${who}  ${row.at ?? '-'} → ${row.endedAt ?? '-'}`);
    }
    console.log(say('cli.snapshot.readOnly'));
    return;
  }
  if (command !== 'show' || positionals.length !== 2 || !RUN_ID.test(id)) throw new Error(t('errors.snapshotCli.usage'));
  const runs = await listRuns(root);
  const item = runs.find((entry) => entry.run === id);
  if (!item) throw new Error(t('errors.snapshots.notFound', id));
  const summary = await runSummary(root, item, { runs, files: 200 });
  const diffs = [];
  for (const file of summary.files) diffs.push(await runFileDiff(root, id, file.path).catch((error) => ({ path: file.path, error: error.message })));
  if (values.json) { console.log(JSON.stringify({ ...summary, diffs }, null, 2)); return; }
  console.log(`${summary.run}  [${summary.state}${summary.reason ? `: ${summary.reason}` : ''}]  ${summary.goal ?? '-'}  ${summary.feature ?? '-'}  ${summary.phase ?? '-'}  ${summary.at ?? '-'} → ${summary.endedAt ?? '-'}`);
  if (summary.kind === 'restore') console.log(`  ${say('cli.snapshot.restoreOf', summary.target ?? '-', summary.by ?? '-')}`);
  if (summary.concurrent) console.log(`  ${say('trace.runConcurrent', summary.concurrent)}`);
  if (summary.commits) console.log(`  ${say('trace.runCommits', summary.commits)}`);
  if (summary.state === 'ok' && !summary.count) console.log(`  ${say('trace.runNone')}`);
  for (const diff of diffs) {
    const file = summary.files.find((entry) => entry.path === diff.path);
    const counts = diff.none || diff.error ? (diff.error ?? say(diff.none === 'binary' ? 'trace.binary' : 'trace.runTooLarge')) : `+${diff.added} −${diff.removed}`;
    console.log(`\n${say('cli.snapshot.file', diff.path, say(STATE[file?.state] ?? 'trace.runState.modify'), counts)}`);
    for (const [type, text] of diff.lines ?? []) console.log(`${MARK[type] ?? ' '}${text}`);
    if (diff.omitted) console.log(say('approvals.preview.omitted', diff.omitted));
  }
  if (summary.more) console.log(say('prBody.moreFiles', summary.more));
  console.log(say('cli.snapshot.readOnly'));
}
