import { t } from './messages-catalog.mjs';

const YES = { 'same-commit': 'worktreeBoard.judge.sameCommit', ancestor: 'worktreeBoard.judge.ancestor', 'same-tree': 'worktreeBoard.judge.sameTree',
  'merge-adds-nothing': 'worktreeBoard.judge.mergeAddsNothing', 'patch-id': 'worktreeBoard.judge.patchId' };
const COPY_RESULT = { ok: 'worktrees.copyResult.ok', partial: 'worktrees.copyResult.partial', none: 'worktrees.copyResult.none', stopped: 'worktrees.copyResult.stopped',
  unsupported: 'worktrees.copyResult.unsupported' };
export function copyResultText(copy, say = t) {
  if (!copy || !COPY_RESULT[copy.state]) return null;
  return say(COPY_RESULT[copy.state], Number.isInteger(copy.entries) ? copy.entries : 0);
}
const UNKNOWN = { review: 'worktreeBoard.judge.review', timeout: 'worktreeBoard.judge.timeout', tooDeep: 'worktreeBoard.judge.tooDeep', gitOld: 'worktreeBoard.judge.gitOld', noHead: 'worktreeBoard.judge.noHead',
  tooMany: 'worktreeBoard.judge.tooMany', tooLarge: 'worktreeBoard.judge.tooLarge', baseline: 'worktreeBoard.judge.baseline', error: 'worktreeBoard.judge.error' };

export function integrationText(integration, { target = null, git = null } = {}, say = t) {
  const name = target?.name ?? say('worktreeBoard.projectHead');
  if (!integration) return { kind: 'pending', text: '…' };
  if (integration.integrated === true) {
    if (integration.reason === 'no-changes' || (['ancestor', 'same-commit'].includes(integration.reason) && git?.tip && git.tip === git.base)) return { kind: 'noChanges', text: say('worktreeBoard.judge.noChanges') };
    return { kind: 'integrated', text: say(YES[integration.reason] ?? 'worktreeBoard.judge.sameTree', name, String(integration.commit ?? '').slice(0, 7)) };
  }
  if (integration.integrated === false) return { kind: 'not', text: say('worktreeBoard.judge.not', name) };
  return { kind: 'unknown', text: say(UNKNOWN[integration.reason] ?? 'worktreeBoard.judge.error') };
}

export function linesText(lines, say = t) {
  if (!lines) return null;
  if (lines.tooMany) return say('worktreeBoard.linesTooMany');
  const parts = [say('worktreeBoard.lines', lines.added, lines.removed)];
  if (lines.binary) parts.push(say('worktreeBoard.linesBinary', lines.binary));
  return parts.join(' · ');
}
