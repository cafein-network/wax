import { t } from '../web/messages-catalog.mjs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { worktreeBoard } from './worktree-board.mjs';
import { cliText } from './cli-locale.mjs';
import { agentTool } from './agent-tools.mjs';
import { formatSpan } from './run-trace.mjs';
import { SETUP_OUTCOME_TEXT } from './worktree-make.mjs';
import { copyResultText, integrationText, linesText } from '../web/worktree-board-text.mjs';

const STATE = { active: 'worktrees.state.active', imported: 'worktrees.state.imported', discarded: 'worktrees.state.discarded', removed: 'worktrees.state.removed' };
const RUN = { running: 'worktreeBoard.run.running', done: 'worktreeBoard.run.done', blocked: 'worktreeBoard.run.blocked', exited: 'worktreeBoard.run.exited', timeout: 'worktreeBoard.run.timeout',
  failed: 'worktreeBoard.run.failed', stopped: 'worktreeBoard.run.stopped', stuck: 'worktreeBoard.run.stuck' };
const ISSUE = { folderMissing: 'worktreeBoard.issue.folderMissing', notOnBranch: 'worktreeBoard.issue.notOnBranch', branchMissing: 'worktreeBoard.issue.branchMissing', reviewMoved: 'worktreeBoard.issue.reviewMoved' };
const PARTIAL = { timeout: 'worktreeBoard.partial.timeout', error: 'worktreeBoard.partial.error' };
const PROOF = { passed: 'worktreeBoard.proof.passed', failed: 'worktreeBoard.proof.failed', timeout: 'worktreeBoard.proof.timeout' };
const toolName = (id) => { try { return agentTool(id).label; } catch { return String(id ?? '-'); } };

export function rowText(row, board, say, now = Date.now()) {
  const since = (at) => formatSpan(now - Date.parse(at), say);
  const target = board.project.target?.name ?? say('worktreeBoard.projectHead');
  const a = row.activity;
  const activity = a.kind === 'running' ? say(a.alive === false ? 'worktreeBoard.activity.runningGone' : 'worktreeBoard.activity.running', toolName(a.tool), a.phase ?? '-')
    : a.kind === 'waiting' ? (a.reason === 'approval' ? say('worktreeBoard.activity.waitingApproval', a.action || '-')
      : a.reason === 'card' ? say('worktreeBoard.activity.waitingCard', a.detail || '-') : say('worktreeBoard.activity.waitingBlocked', say(RUN[a.outcome] ?? 'worktreeBoard.run.exited')))
    : say('worktreeBoard.activity.idle');
  const lines = [`${row.id}  [${say(STATE[row.state])}]  ${activity}${row.issue ? `  (${say(ISSUE[row.issue])})` : ''}`];
  lines.push(`  ${say('worktreeBoard.goal', row.goalTitle ?? row.goal, row.feature, row.pr ? say('worktreeBoard.reviewPr', row.pr.number, row.pr.head.slice(0, 12)) : row.branch)}`);
  const git = row.git;
  if (git) {
    const parts = [];
    if (git.uncommitted !== null) parts.push(say(git.tooMany ? 'worktreeBoard.tooMany' : 'worktreeBoard.uncommitted', git.uncommitted));
    if (git.ahead !== null) parts.push(say('worktreeBoard.ahead', git.ahead));
    if (git.baseMoved !== null) parts.push(say('worktreeBoard.baseMoved', target, git.baseMoved));
    const counted = linesText(git.lines, say);
    if (counted) parts.push(counted);
    if (parts.length) lines.push(`  ${parts.join(' · ')}`);
    if (git.integration) lines.push(`  ${integrationText(git.integration, { target: board.project.target, git }, say).text}`);
  }
  const age = [];
  if (row.createdAt) age.push(say('worktreeBoard.created', since(row.createdAt)));
  if (git?.lastCommit) age.push(say('worktreeBoard.lastCommit', since(git.lastCommit.at), git.lastCommit.subject));
  if (age.length) lines.push(`  ${age.join(' · ')}`);
  if (row.lastRun) lines.push(`  ${say('worktreeBoard.lastRun', row.lastRun.phase ?? '-', toolName(row.lastRun.tool), say(RUN[row.lastRun.outcome] ?? 'worktreeBoard.run.exited'))}`);
  const proof = !row.proof ? say('worktreeBoard.proof.none') : row.proof.outcome === 'passed' && row.proof.changedSince ? say('worktreeBoard.proof.passedChanged', row.proof.changedSince) : say(PROOF[row.proof.outcome]);
  const end = [proof];
  if (row.setup?.outcome) end.push(say('worktreeBoard.setup', [say(SETUP_OUTCOME_TEXT[row.setup.outcome] ?? 'worktrees.outcome.none'), copyResultText(row.setup.copy, say)].filter(Boolean).join(' · ')));
  if (row.link) end.push(say(row.portUp === true ? 'worktreeBoard.port.up' : row.portUp === false ? 'worktreeBoard.port.down' : 'worktreeBoard.port.unknown', row.port, row.link));
  lines.push(`  ${end.join(' · ')}`);
  for (const item of row.partial) lines.push(`  ${say(PARTIAL[item.reason] ?? 'worktreeBoard.partial.error', item.cell)}`);
  return lines;
}

export async function worktreeCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, goal: { type: 'string' }, all: { type: 'boolean' }, fast: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const { say } = cliText();
  const [command] = positionals;
  if (values.help || !command) { console.log(say('cli.worktree.help')); return; }
  if (command !== 'list' || positionals.length !== 1 || (values.goal !== undefined && !/^goal-[a-f0-9]{8}$/.test(values.goal))) throw new Error(t('errors.worktreeCli.usage'));
  const root = resolve(values.project || process.cwd());
  const board = await worktreeBoard(root, { goal: values.goal ?? null, all: Boolean(values.all), tiers: values.fast ? 1 : 3 });
  if (values.json) { console.log(JSON.stringify(board, null, 2)); return; }
  if (!board.rows.length) { console.log(say('worktreeBoard.none')); }
  else {
    const target = board.project.target;
    if (board.gitRows) console.log(target ? say('worktreeBoard.target', target.name ?? say('worktreeBoard.projectHead'), target.commit.slice(0, 12)) : say('worktreeBoard.noHead'));
    for (const row of board.rows) console.log(`\n${rowText(row, board, say).join('\n')}`);
    if (board.more) console.log(`\n${say('worktreeBoard.more', board.gitRows, board.more)}`);
  }
  if (board.removedHidden) console.log(say('worktreeBoard.removedHidden', board.removedHidden));
  for (const item of board.partial) console.log(say(PARTIAL[item.reason] ?? 'worktreeBoard.partial.error', item.cell));
  console.log(say('worktreeBoard.readOnly'));
}
