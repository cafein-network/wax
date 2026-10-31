import { t } from '../../web/messages-catalog.mjs';
import { cliLanguage, cliText } from '../cli-locale.mjs';
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WaxError } from '../workflow.mjs';
import { resolveProject } from './paths.mjs';
import { listChannels, postMessage, readMessages, resolveTarget } from './channels.mjs';
import { joinPresence, listPresence, resetPresence, setPresence } from './presence.mjs';
import { listBoard, postNote, saveReport } from './board.mjs';
import { buildDigest } from './digest.mjs';
import { buildDailyDraft, collectDay, listDailyReports, saveDailyReport } from './daily.mjs';
import { assignTask, getTeam, listTasks, setPm, updateTask } from './team.mjs';
import { listUsage } from './usage.mjs';
import { buildSkillMap, formatSkillMap } from './skill-map.mjs';
import { collectWorkNotes, formatWorkNotes, saveMemo } from './work-notes.mjs';
import { formatCandidates, formatRules, lintRules, listRules, proposeRule, ruleCandidates } from './rules.mjs';
import { formatWatchEvent, watchChat } from './watch.mjs';

export const USAGE = t('cli.chat.usage');

class UsageError extends Error {}

const OPTIONS = {
  project: { type: 'string' }, author: { type: 'string' }, kind: { type: 'string' }, message: { type: 'string' },
  file: { type: 'string' }, type: { type: 'string' }, phase: { type: 'string' }, 'reply-to': { type: 'string' },
  since: { type: 'string' }, limit: { type: 'string' }, state: { type: 'string' }, feature: { type: 'string' },
  note: { type: 'string' }, model: { type: 'string' }, peer: { type: 'string' }, stance: { type: 'string' }, doing: { type: 'string' }, to: { type: 'string' }, all: { type: 'boolean' }, out: { type: 'string' },
  id: { type: 'string' }, wake: { type: 'boolean' }, session: { type: 'string' }, rename: { type: 'boolean' }, 'covers-through': { type: 'string' }, clear: { type: 'boolean' }, replace: { type: 'boolean' }, status: { type: 'boolean' }, port: { type: 'string' }, date: { type: 'string' }, days: { type: 'string' }, why: { type: 'string' }, source: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};

const time = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const formatMessage = (m, say) => `[${m.id}${m.phase ? ` ${m.phase}` : ''}] ${m.author}(${m.kind}) ${time(m.at)}${m.type !== 'message' ? ` <${m.type}>` : ''}${m.to?.length ? ` → ${m.to.join(', ')}` : ''}${m.replyTo ? ` ↳${m.replyTo}` : ''}${m.doing ? `\n  ${say('cli.chat.doing', m.doing)}` : ''}\n  ${m.body.replace(/\n/g, '\n  ')}`;
const formatTask = (task, say, localize) => `[${task.id}] ${task.status}\t${task.feature}/${task.phase} → ${task.to} (PM ${task.by})\n  ${task.note.replace(/\n/g, '\n  ')}${task.updates.length ? `\n  ${say('cli.chat.latest', `${task.updates.at(-1).status} ${task.updates.at(-1).note ?? ''}`)}${task.updates.at(-1).warning ? `\n  ${say('cli.warning', localize(task.updates.at(-1).warning))}` : ''}` : ''}`;
const formatNote = (n) => `[${n.id}${n.phase ? ` ${n.phase}` : ''}] ${n.author}(${n.kind}) <${n.type}${n.stance ? `/${n.stance}` : ''}>${n.replyTo ? ` ↳${n.replyTo}` : ''}\n  ${n.body.replace(/\n/g, '\n  ')}`;

async function readInputFile(cwd, path) {
  try { return await readFile(resolve(cwd, path), 'utf8'); }
  catch (error) { if (['ENOENT', 'EISDIR', 'EACCES'].includes(error.code)) throw new WaxError(t('errors.chat.cli.cannotReadTheFile', path)); throw error; }
}

async function textInput(values, cwd) {
  if (values.message !== undefined && values.file !== undefined) throw new UsageError(t('errors.chat.cli.giveOnlyOneOf'));
  if (values.file !== undefined) return readInputFile(cwd, values.file);
  if (values.message === undefined) throw new UsageError(t('errors.chat.cli.messageOrFileIs'));
  return values.message;
}

const busyMessage = (running, port) => running.root
  ? t('errors.chat.cli.portBusyOtherProject', port, running.project)
  : t('errors.chat.cli.portBusyUnknownProject', port, running.version ?? t('errors.chat.cli.olderVersion'));
function need(positionals, index, name) {
  if (!positionals[index]) throw new UsageError(t('errors.chat.cli.isRequired', name));
  return positionals[index];
}

export async function run(argv, { cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, now } = {}) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (error) { throw new UsageError(error.message); }
  const { values, positionals } = parsed;
  const [command, sub] = positionals;
  const { language, say, localize } = cliText(cliLanguage(env));
  if (values.help || !command) { stdout.write(`${say('cli.chat.usage')}\n`); return values.help ? 0 : 2; }
  const root = await resolveProject({ project: values.project, env, cwd });
  const clock = { now: now ?? new Date() };
  const print = (value, human) => stdout.write(`${values.json ? JSON.stringify(value) : human(value)}\n`);

  switch (command) {
    case 'post': {
      const message = await postMessage(root, need(positionals, 1, '채널'), {
        author: values.author, session: values.session, kind: values.kind, type: values.type, phase: values.phase,
        replyTo: values['reply-to'], doing: values.doing, to: values.to, body: await textInput(values, cwd),
      }, clock);
      print(message, (m) => m.id);
      return 0;
    }
    case 'read': {
      const result = await readMessages(root, need(positionals, 1, '채널'), { since: values.since, id: values.id, limit: values.limit });
      print(result, (r) => r.messages.length ? r.messages.map((m) => formatMessage(m, say)).join('\n') : say('cli.chat.noMessages'));
      return 0;
    }
    case 'channels': {
      print(await listChannels(root), (list) => list.map((c) => `${c.name ?? c.id}\t${c.phase ?? '-'}\t${say('cli.chat.messageCount', c.count)}\t${c.title ?? ''}`).join('\n'));
      return 0;
    }
    case 'presence': {
      const entry = await setPresence(root, { author: values.author, session: values.session, kind: values.kind, model: values.model, peer: values.peer, state: values.state, feature: values.feature, note: values.note }, clock);
      print(entry, (e) => `${e.author}: ${e.state}${e.feature ? ` (${e.feature})` : ''}`);
      return 0;
    }
    case 'join': {
      const entry = await joinPresence(root, { session: values.session, rename: values.rename, author: values.author, kind: values.kind, model: values.model, peer: values.peer, state: values.state, feature: values.feature, note: values.note }, clock);
      print(entry, (e) => `${e.author}: ${e.state}${e.feature ? ` (${e.feature})` : ''}${e.renamed ? `\n${say('cli.chat.renamed', e.requested, e.author)}` : ''}\n${say('cli.chat.sessionId', e.session)}`);
      return 0;
    }
    case 'reset': {
      print(await resetPresence(root, { author: values.author }, clock), (r) => [
        r.removed.length ? say('cli.chat.clearedSessions', r.removed.join(', ')) : say('cli.chat.noPastSessions'),
        ...(r.kept.length ? [say('cli.chat.keptSessions', r.kept.join(', '))] : []),
      ].join('\n'));
      return 0;
    }
    case 'who': {
      print(await listPresence(root, clock), (list) => list.length
        ? list.map((e) => `${e.author}(${e.kind}${e.model ? ` · ${e.model}` : ''}${e.peer ? ` · ${say('cli.chat.peerSession', e.peer)}` : ''})\t${e.effectiveState}${e.listening ? ` · ${say('cli.chat.listening')}` : ''}\t${e.feature ?? '-'}\t${time(e.lastActive)}${e.note ? `\t${e.note}` : ''}`).join('\n')
        : say('cli.chat.noMembers'));
      return 0;
    }
    case 'board': {
      const board = need(positionals, 2, '작업 ID');
      if (sub === 'post') {
        const note = await postNote(root, board, {
          author: values.author, session: values.session, kind: values.kind, type: values.type, stance: values.stance,
          replyTo: values['reply-to'], phase: values.phase, body: await textInput(values, cwd),
        }, clock);
        print(note, (n) => n.id);
        return 0;
      }
      if (sub === 'list') {
        const result = await listBoard(root, board, { since: values.since });
        print(result, (r) => [
          ...(r.notes.length ? r.notes.map(formatNote) : [say('cli.chat.noNotes')]),
          ...r.reports.map((rep) => say('cli.chat.boardReport', String(rep.number).padStart(3, '0'), rep.author, rep.path, rep.coversThrough)),
        ].join('\n'));
        return 0;
      }
      if (sub === 'digest') {
        const feature = await resolveTarget(root, board);
        const { notes, reports } = await listBoard(root, board);
        const digest = buildDigest({ board, title: feature?.title, notes, reports, all: values.all, now: clock.now });
        if (values.out) {
          try { await writeFile(resolve(cwd, values.out), digest.markdown, { flag: 'wx' }); }
          catch (error) { if (error.code === 'EEXIST') throw new WaxError(t('errors.chat.cli.alreadyExistsAndWas', values.out), 409); throw error; }
          stdout.write(`${say('cli.chat.digestSaved', values.out, digest.noteCount)}\n`);
        } else stdout.write(`${digest.markdown}\n`);
        return 0;
      }
      if (sub === 'report') {
        if (!values.file) throw new UsageError(t('errors.chat.cli.fileReportMdIs'));
        const record = await saveReport(root, board, {
          author: values.author, session: values.session, kind: values.kind, coversThrough: values['covers-through'],
          markdown: await readInputFile(cwd, values.file),
        }, clock);
        print(record, (r) => say('cli.chat.reportSaved', r.path, String(r.number).padStart(3, '0'), r.noteCount));
        return 0;
      }
      throw new UsageError(t('errors.chat.cli.boardSubcommandsArePost'));
    }
    case 'usage': {
      const usage = await listUsage(root);
      const label = { five_hour: say('cli.chat.fiveHours'), seven_day: say('cli.chat.weekly'), spend_limit: say('cli.chat.spendingLimit') };
      const locale = language === 'en' ? 'en-US' : 'ko-KR';
      print(usage, ({ claude }) => [
        claude.limits.length ? say('cli.chat.planUsage', claude.limits.map((l) => `${label[l.kind] ?? l.kind} ${l.percentUsed}%${l.resetsAt ? ` (${say('cli.chat.resets', new Date(l.resetsAt).toLocaleString(locale))})` : ''}`).join(', ')) : say('cli.chat.noPlanUsage'),
        ...claude.sessions.map((x) => `- ${x.session.slice(0, 8)} ${x.model ?? '-'} ${say('cli.chat.context', x.context?.percent ?? '-')}${x.costUsd !== null ? ` ${say('cli.chat.cost', x.costUsd.toFixed(2))}` : ''}${x.ended ? ` ${say('cli.chat.ended')}` : ''}`),
      ].join('\n'));
      return 0;
    }
    case 'team': {
      if (sub === 'pm') {
        if (!values.clear && !positionals[2]) throw new UsageError(t('errors.chat.cli.aPmNameOr'));
        const team = await setPm(root, values.clear ? {} : { author: positionals[2], kind: values.kind, replace: values.replace }, clock);
        print(team, (result) => result.pm ? `PM: ${result.pm.author}(${result.pm.kind})` : say('cli.chat.pmCleared'));
        return 0;
      }
      if (sub !== undefined) throw new UsageError(t('errors.chat.cli.theTeamSubcommandIs'));
      const team = { ...(await getTeam(root)), tasks: await listTasks(root) };
      print(team, (result) => [`PM: ${result.pm ? `${result.pm.author}(${result.pm.kind})` : say('cli.chat.notSet')}`, ...result.tasks.map((task) => formatTask(task, say, localize))].join('\n'));
      return 0;
    }
    case 'notes': {
      const days = values.days === undefined ? 7 : Number(values.days);
      print(await collectWorkNotes(root, need(positionals, 1, t('errors.chat.cli.memberName')), { days, now: clock.now }), formatWorkNotes);
      return 0;
    }
    case 'memo': {
      const memo = await saveMemo(root, { author: values.author, session: values.session, kind: values.kind, feature: values.feature, body: await textInput(values, cwd) }, clock);
      print(memo, (m) => say('cli.chat.memoSaved', m.id, m.author));
      return 0;
    }
    case 'rules': {
      if (sub === undefined) { print(await listRules(root, { all: values.all }), formatRules); return 0; }
      if (sub === 'candidates') { print(await ruleCandidates(root), formatCandidates); return 0; }
      if (sub === 'lint') {
        const stale = await lintRules(root);
        print(stale, (list) => list.length ? list.map((item) => `- ${item.id} ${item.body}\n  ${say('cli.chat.missingEvidence', item.missing.join(', '))}`).join('\n') : say('cli.chat.allEvidenceFound'));
        return stale.length ? 1 : 0;
      }
      if (sub === 'propose') {
        const rule = await proposeRule(root, { author: values.author, session: values.session, kind: values.kind, body: await textInput(values, cwd), why: values.why, sources: values.source?.split(',') }, clock);
        print(rule, (r) => say('cli.chat.ruleProposed', r.id));
        return 0;
      }
      throw new UsageError(t('errors.chat.cli.rulesSubcommandsAreCandidates'));
    }
    case 'skills': {
      print(await buildSkillMap(root, clock), formatSkillMap);
      return 0;
    }
    case 'assign': {
      const task = await assignTask(root, { feature: need(positionals, 1, '작업 ID'), to: values.to, phase: values.phase, author: values.author, session: values.session, body: await textInput(values, cwd) }, clock);
      print(task, (result) => result.id);
      return 0;
    }
    case 'tasks': {
      const tasks = await listTasks(root, { to: values.to, feature: values.feature, all: values.all });
      print(tasks, (list) => list.length ? list.map((task) => formatTask(task, say, localize)).join('\n') : say('cli.chat.noAssignments'));
      return 0;
    }
    case 'task': {
      const task = await updateTask(root, need(positionals, 2, '업무 ID'), need(positionals, 1, t('errors.chat.cli.statusChange')), { author: values.author, session: values.session, kind: values.kind, body: values.message, taskDoneCheck: env.WAX_TASK_DONE_CHECK ?? '' }, clock);
      if (task.updates.at(-1)?.warning) stderr.write(`wax chat: ${say('cli.warning', localize(task.updates.at(-1).warning))}\n`);
      print(task, (result) => `${result.id}: ${result.status}`);
      return 0;
    }
    case 'daily': {
      if (sub === undefined || sub === 'timeline') {
        const day = await collectDay(root, values.date, clock);
        print(day, (d) => d.events.length ? d.events.map((e) => `${time(e.at)}\t${e.feature ?? '-'}\t${e.title}${e.detail ? `\t${e.detail}` : ''}`).join('\n') : say('cli.chat.noRecordsOn', d.date));
        return 0;
      }
      if (sub === 'draft') {
        const markdown = buildDailyDraft(await collectDay(root, values.date, clock), clock);
        if (values.out) {
          try { await writeFile(resolve(cwd, values.out), markdown, { flag: 'wx' }); }
          catch (error) { if (error.code === 'EEXIST') throw new WaxError(t('errors.chat.cli.alreadyExistsAndWas', values.out), 409); throw error; }
          stdout.write(`${values.out}\n`);
        } else stdout.write(`${markdown}\n`);
        return 0;
      }
      if (sub === 'report') {
        if (!values.file) throw new UsageError(t('errors.chat.cli.fileReportMdIs'));
        const record = await saveDailyReport(root, { date: values.date, author: values.author, session: values.session, kind: values.kind, markdown: await readInputFile(cwd, values.file) }, clock);
        print(record, (r) => say('cli.chat.dailyReportSaved', r.path, r.date, String(r.number).padStart(2, '0')));
        return 0;
      }
      if (sub === 'list') {
        print(await listDailyReports(root, { date: values.date }), (list) => list.length ? list.map((r) => `${r.date}\t${String(r.number).padStart(2, '0')}\t${r.author}(${r.kind})\t${r.path}`).join('\n') : say('cli.chat.noDailyReports'));
        return 0;
      }
      throw new UsageError(t('errors.chat.cli.dailySubcommandsAreDraft'));
    }
    case 'watch': {
      if (!values.author) throw new UsageError(t('errors.chat.cli.authorNameIsRequired'));
      const stop = await watchChat(root, {
        author: values.author, feature: values.feature, wake: values.wake,
        write: (event) => stdout.write(`${values.json ? JSON.stringify(event) : formatWatchEvent(event)}\n`),
        onError: (error) => process.stderr.write(`wax chat watch: ${error.message}\n`),
      });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { Promise.resolve(stop()).finally(() => process.exit(0)); });
      return null;
    }
    case 'serve': {
      const { DEFAULT_PORT, probeDashboard, startServer } = await import('./server.mjs');
      const port = values.port ?? env.WAX_DASHBOARD_PORT ?? String(DEFAULT_PORT);
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new UsageError(t('errors.chat.cli.portMustBeA'));
      const running = Number(port) ? await probeDashboard(Number(port)) : null;
      let same = false;
      if (running) {
        if (running.root) {
          try { const [a, b] = await Promise.all([realpath(running.root), realpath(root)]); same = a === b;
            if (!same) { const [x, y] = await Promise.all([stat(a), stat(b)]); same = x.ino !== 0 && x.dev === y.dev && x.ino === y.ino; }
          } catch { same = false; }
        }
      }
      if (values.status) {
        print({ running: Boolean(same), port: Number(port), ...(running ?? {}) }, () => same ? say('cli.chat.running', running.url, running.project)
          : running ? localize(busyMessage(running, port)) : say('cli.chat.notRunning', port));
        return same ? 0 : 1;
      }
      if (same) { stdout.write(`${say('cli.chat.alreadyRunning', running.url, running.project)}\n`); return 0; }
      if (running) throw new WaxError(busyMessage(running, port), 409);
      try { await startServer({ root, env, port: Number(port) }); }
      catch (error) { if (error.code === 'EADDRINUSE') throw new WaxError(t('errors.chat.cli.anotherProgramIsUsing', port), 409); throw error; }
      return null;
    }
    default:
      throw new UsageError(t('errors.chat.cli.unknownCommand', command));
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const code = await run(argv);
    if (code !== null) process.exitCode = code;
  } catch (error) {
    const { say, localize } = cliText(cliLanguage());
    if (error instanceof UsageError) { process.stderr.write(`wax chat: ${localize(error.message)}\n\n${say('cli.chat.usage')}\n`); process.exitCode = 2; return; }
    process.stderr.write(`wax chat: ${error instanceof WaxError ? localize(error.message) : error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
