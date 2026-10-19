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
import { formatWatchEvent, watchChat } from './watch.mjs';

export const USAGE = `사용법: wax chat [--project <dir>] <명령> [옵션]

  post <channel> --author <이름> [--session <ID>] (--message <전할 내용> | --file <경로>)
       [--doing <지금 하는 일>] [--to <받는 사람,받는 사람>]
       [--kind claude|codex|gemini|antigravity|copilot|human|other] [--type message|opinion|question|answer|decision]
       [--phase <단계>] [--reply-to <메시지ID>] [--json]
  read <channel> [--since <메시지ID>] [--id <메시지ID>] [--limit <n>] [--json]
  channels [--json]
  presence --author <이름> [--session <ID>] --state working|discussing|reviewing|idle|away
       [--kind <종류>] [--model <모델>] [--peer <세션 간 통신 이름>] [--feature <작업ID>] [--note <메모>] [--json]
  join --author <기본 이름> [--kind <종류>] [--model <모델>] [--peer <세션 간 통신 이름>] [--feature <작업ID>] [--state <상태>] [--note <메모>] [--json]
       세션의 첫 참여. 같은 이름이 활동 중이면 <이름>-2, -3 …으로 들어오고 그 이름을 알려 줌
  who [--json]
  reset [--author <이름>] [--json]                         지난 세션 정리. 듣는 중·작업 중이 아닌 세션 기록을 지워 이름을 비움
       (--author: 그 세션만 지움). PM·업무는 이름에 남아 같은 이름으로 다시 참여한 세션이 이어받음
  board post <작업ID> --author <이름> [--session <ID>] --type opinion|question|answer|decision
       (--message <텍스트> | --file <경로>) [--kind <종류>] [--reply-to <노트ID>] [--stance agree|disagree] [--json]
  board list <작업ID> [--since <ID>] [--json]
  board digest <작업ID> [--all] [--out <새 파일 경로>]
  board report <작업ID> --author <이름> [--session <ID>] --file <보고서.md> [--kind <종류>] [--covers-through <노트ID>] [--json]
  team [--json]                                             PM과 진행 중 업무
  usage [--json]                                            Claude 플랜 사용량(5시간·주간)과 세션별 컨텍스트(Claude Code 2.1.287 이상에서 wax 모드가 기록)
  team pm <이름> [--kind <종류>] [--replace] | team pm --clear  프로젝트 PM 지정·해제(대표가 요청할 때만, 다른 PM이 있으면 --replace)
  assign <작업ID> --to <담당자> --author <PM> [--session <ID>] (--message <지시> | --file <경로>) [--phase <단계|any>] [--json]
  tasks [--to <이름>] [--feature <작업ID>] [--all] [--json]   배정된 업무
  task accept|done|block|cancel <업무ID> --author <이름> [--session <ID>] [--message <메모>] [--json]
  daily [--date YYYY-MM-DD] [--json]                       하루 타임라인
  daily draft [--date YYYY-MM-DD] [--out <새 파일 경로>]   일일 업무보고 집계 초안
  daily report --author <이름> [--session <ID>] --file <보고서.md> [--date YYYY-MM-DD] [--kind <종류>] [--json]
  daily list [--date YYYY-MM-DD] [--json]
  watch --author <이름> [--feature <작업ID>] [--wake] [--json]  나를 부른(@이름·--to) 메시지와 내 배정을 한 줄씩 출력(멈출 때까지)
       --wake: 출력이 AI 세션을 깨울 때(Claude Code Monitor) 붙여 대시보드에 '바로 답함'으로 표시
  serve [--port <n>]                                        대시보드 (wax dashboard와 같음). 이미 켜져 있으면 주소만 알림
  참여한 이름의 post·presence·board·daily·assign·task 쓰기에는 --session <ID>를 함께 넘깁니다.
  join --author <이름> [--session <ID>] [--rename]           재참여·이름 변경에 같은 세션 ID 사용
  serve --status [--port <n>] [--json]                      대시보드가 켜져 있는지 확인(꺼져 있으면 종료 코드 1)

채널은 wax 작업 ID 또는 프로젝트 이름(프로젝트 전체 채널, general로도 부를 수 있음)입니다. 프로젝트는 --project, WAX_PROJECT, 현재 디렉터리 순으로 정합니다.`;

class UsageError extends Error {}

const OPTIONS = {
  project: { type: 'string' }, author: { type: 'string' }, kind: { type: 'string' }, message: { type: 'string' },
  file: { type: 'string' }, type: { type: 'string' }, phase: { type: 'string' }, 'reply-to': { type: 'string' },
  since: { type: 'string' }, limit: { type: 'string' }, state: { type: 'string' }, feature: { type: 'string' },
  note: { type: 'string' }, model: { type: 'string' }, peer: { type: 'string' }, stance: { type: 'string' }, doing: { type: 'string' }, to: { type: 'string' }, all: { type: 'boolean' }, out: { type: 'string' },
  id: { type: 'string' }, wake: { type: 'boolean' }, session: { type: 'string' }, rename: { type: 'boolean' }, 'covers-through': { type: 'string' }, clear: { type: 'boolean' }, replace: { type: 'boolean' }, status: { type: 'boolean' }, port: { type: 'string' }, date: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};

const time = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const formatMessage = (m) => `[${m.id}${m.phase ? ` ${m.phase}` : ''}] ${m.author}(${m.kind}) ${time(m.at)}${m.type !== 'message' ? ` <${m.type}>` : ''}${m.to?.length ? ` → ${m.to.join(', ')}` : ''}${m.replyTo ? ` ↳${m.replyTo}` : ''}${m.doing ? `\n  [하는 일] ${m.doing}` : ''}\n  ${m.body.replace(/\n/g, '\n  ')}`;
const formatTask = (t) => `[${t.id}] ${t.status}\t${t.feature}/${t.phase} → ${t.to} (PM ${t.by})\n  ${t.note.replace(/\n/g, '\n  ')}${t.updates.length ? `\n  최근: ${t.updates.at(-1).status} ${t.updates.at(-1).note ?? ''}` : ''}`;
const formatNote = (n) => `[${n.id}${n.phase ? ` ${n.phase}` : ''}] ${n.author}(${n.kind}) <${n.type}${n.stance ? `/${n.stance}` : ''}>${n.replyTo ? ` ↳${n.replyTo}` : ''}\n  ${n.body.replace(/\n/g, '\n  ')}`;

async function readInputFile(cwd, path) {
  try { return await readFile(resolve(cwd, path), 'utf8'); }
  catch (error) { if (['ENOENT', 'EISDIR', 'EACCES'].includes(error.code)) throw new WaxError(`파일을 읽을 수 없습니다: ${path}`); throw error; }
}

async function textInput(values, cwd) {
  if (values.message !== undefined && values.file !== undefined) throw new UsageError('--message와 --file 중 하나만 지정하세요.');
  if (values.file !== undefined) return readInputFile(cwd, values.file);
  if (values.message === undefined) throw new UsageError('--message 또는 --file이 필요합니다.');
  return values.message;
}

function need(positionals, index, name) {
  if (!positionals[index]) throw new UsageError(`${name}이(가) 필요합니다.`);
  return positionals[index];
}

export async function run(argv, { cwd = process.cwd(), env = process.env, stdout = process.stdout, now } = {}) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (error) { throw new UsageError(error.message); }
  const { values, positionals } = parsed;
  const [command, sub] = positionals;
  if (values.help || !command) { stdout.write(`${USAGE}\n`); return values.help ? 0 : 2; }
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
      print(result, (r) => r.messages.length ? r.messages.map(formatMessage).join('\n') : '(메시지 없음)');
      return 0;
    }
    case 'channels': {
      print(await listChannels(root), (list) => list.map((c) => `${c.name ?? c.id}\t${c.phase ?? '-'}\t${c.count}개\t${c.title ?? ''}`).join('\n'));
      return 0;
    }
    case 'presence': {
      const entry = await setPresence(root, { author: values.author, session: values.session, kind: values.kind, model: values.model, peer: values.peer, state: values.state, feature: values.feature, note: values.note }, clock);
      print(entry, (e) => `${e.author}: ${e.state}${e.feature ? ` (${e.feature})` : ''}`);
      return 0;
    }
    case 'join': {
      const entry = await joinPresence(root, { session: values.session, rename: values.rename, author: values.author, kind: values.kind, model: values.model, peer: values.peer, state: values.state, feature: values.feature, note: values.note }, clock);
      print(entry, (e) => `${e.author}: ${e.state}${e.feature ? ` (${e.feature})` : ''}${e.renamed ? `
${e.requested} 이름은 다른 세션이 쓰고 있어 ${e.author}(으)로 참여했습니다.` : ''}\n세션 ID: ${e.session} (재참여와 모든 쓰기 명령에 --session으로 사용)`);
      return 0;
    }
    case 'reset': {
      print(await resetPresence(root, { author: values.author }, clock), (r) => [
        r.removed.length ? `정리한 세션: ${r.removed.join(', ')}` : '정리할 지난 세션이 없습니다.',
        ...(r.kept.length ? [`활동 중이라 남긴 세션: ${r.kept.join(', ')} (지우려면 --author <이름>)`] : []),
      ].join('\n'));
      return 0;
    }
    case 'who': {
      print(await listPresence(root, clock), (list) => list.length
        ? list.map((e) => `${e.author}(${e.kind}${e.model ? ` · ${e.model}` : ''}${e.peer ? ` · 세션 ${e.peer}` : ''})\t${e.effectiveState}${e.listening ? ' · 듣는 중' : ''}\t${e.feature ?? '-'}\t${time(e.lastActive)}${e.note ? `\t${e.note}` : ''}`).join('\n')
        : '(참여자 없음)');
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
          ...(r.notes.length ? r.notes.map(formatNote) : ['(노트 없음)']),
          ...r.reports.map((rep) => `[보고서 ${String(rep.number).padStart(3, '0')}] ${rep.author} → ${rep.path} (seq ${rep.coversThrough}까지)`),
        ].join('\n'));
        return 0;
      }
      if (sub === 'digest') {
        const feature = await resolveTarget(root, board);
        const { notes, reports } = await listBoard(root, board);
        const digest = buildDigest({ board, title: feature?.title, notes, reports, all: values.all, now: clock.now });
        if (values.out) {
          try { await writeFile(resolve(cwd, values.out), digest.markdown, { flag: 'wx' }); }
          catch (error) { if (error.code === 'EEXIST') throw new WaxError(`${values.out}이(가) 이미 있어 덮어쓰지 않았습니다.`, 409); throw error; }
          stdout.write(`${values.out} (노트 ${digest.noteCount}개)\n`);
        } else stdout.write(`${digest.markdown}\n`);
        return 0;
      }
      if (sub === 'report') {
        if (!values.file) throw new UsageError('--file <보고서.md>가 필요합니다.');
        const record = await saveReport(root, board, {
          author: values.author, session: values.session, kind: values.kind, coversThrough: values['covers-through'],
          markdown: await readInputFile(cwd, values.file),
        }, clock);
        print(record, (r) => `${r.path} (보고서 ${String(r.number).padStart(3, '0')}, 노트 ${r.noteCount}개)`);
        return 0;
      }
      throw new UsageError('board 하위 명령은 post, list, digest, report입니다.');
    }
    case 'usage': {
      const usage = await listUsage(root);
      const label = { five_hour: '5시간', seven_day: '주간', spend_limit: '지출 한도' };
      print(usage, ({ claude }) => [
        claude.limits.length ? `Claude 플랜 사용량: ${claude.limits.map((l) => `${label[l.kind] ?? l.kind} ${l.percentUsed}%${l.resetsAt ? ` (초기화 ${new Date(l.resetsAt).toLocaleString('ko-KR')})` : ''}`).join(', ')}` : 'Claude 플랜 사용량 기록이 없습니다(Claude Code 2.1.287 이상에서 wax를 쓰면 턴마다 기록됩니다).',
        ...claude.sessions.map((x) => `- ${x.session.slice(0, 8)} ${x.model ?? '-'} 컨텍스트 ${x.context?.percent ?? '-'}%${x.costUsd !== null ? ` 비용 $${x.costUsd.toFixed(2)}` : ''}${x.ended ? ' (끝남)' : ''}`),
      ].join('\n'));
      return 0;
    }
    case 'team': {
      if (sub === 'pm') {
        if (!values.clear && !positionals[2]) throw new UsageError('PM 이름 또는 --clear가 필요합니다.');
        const team = await setPm(root, values.clear ? {} : { author: positionals[2], kind: values.kind, replace: values.replace }, clock);
        print(team, (t) => t.pm ? `PM: ${t.pm.author}(${t.pm.kind})` : 'PM을 해제했습니다.');
        return 0;
      }
      if (sub !== undefined) throw new UsageError('team 하위 명령은 pm입니다.');
      const team = { ...(await getTeam(root)), tasks: await listTasks(root) };
      print(team, (t) => [`PM: ${t.pm ? `${t.pm.author}(${t.pm.kind})` : '(지정 안 됨)'}`, ...t.tasks.map(formatTask)].join('\n'));
      return 0;
    }
    case 'assign': {
      const task = await assignTask(root, { feature: need(positionals, 1, '작업 ID'), to: values.to, phase: values.phase, author: values.author, session: values.session, body: await textInput(values, cwd) }, clock);
      print(task, (t) => t.id);
      return 0;
    }
    case 'tasks': {
      const tasks = await listTasks(root, { to: values.to, feature: values.feature, all: values.all });
      print(tasks, (list) => list.length ? list.map(formatTask).join('\n') : '(배정된 업무 없음)');
      return 0;
    }
    case 'task': {
      const task = await updateTask(root, need(positionals, 2, '업무 ID'), need(positionals, 1, '상태 변경'), { author: values.author, session: values.session, kind: values.kind, body: values.message }, clock);
      print(task, (t) => `${t.id}: ${t.status}`);
      return 0;
    }
    case 'daily': {
      if (sub === undefined || sub === 'timeline') {
        const day = await collectDay(root, values.date, clock);
        print(day, (d) => d.events.length ? d.events.map((e) => `${time(e.at)}\t${e.feature ?? '-'}\t${e.title}${e.detail ? `\t${e.detail}` : ''}`).join('\n') : `(${d.date} 기록 없음)`);
        return 0;
      }
      if (sub === 'draft') {
        const markdown = buildDailyDraft(await collectDay(root, values.date, clock), clock);
        if (values.out) {
          try { await writeFile(resolve(cwd, values.out), markdown, { flag: 'wx' }); }
          catch (error) { if (error.code === 'EEXIST') throw new WaxError(`${values.out}이(가) 이미 있어 덮어쓰지 않았습니다.`, 409); throw error; }
          stdout.write(`${values.out}\n`);
        } else stdout.write(`${markdown}\n`);
        return 0;
      }
      if (sub === 'report') {
        if (!values.file) throw new UsageError('--file <보고서.md>가 필요합니다.');
        const record = await saveDailyReport(root, { date: values.date, author: values.author, session: values.session, kind: values.kind, markdown: await readInputFile(cwd, values.file) }, clock);
        print(record, (r) => `${r.path} (${r.date} 일일 보고서 ${String(r.number).padStart(2, '0')})`);
        return 0;
      }
      if (sub === 'list') {
        print(await listDailyReports(root, { date: values.date }), (list) => list.length ? list.map((r) => `${r.date}\t${String(r.number).padStart(2, '0')}\t${r.author}(${r.kind})\t${r.path}`).join('\n') : '(일일 보고서 없음)');
        return 0;
      }
      throw new UsageError('daily 하위 명령은 draft, report, list입니다(생략하면 타임라인).');
    }
    case 'watch': {
      if (!values.author) throw new UsageError('--author <이름>이 필요합니다.');
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
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new UsageError('--port는 0~65535 사이의 숫자여야 합니다.');
      const running = Number(port) ? await probeDashboard(Number(port)) : null;
      let same = false;
      if (running) {
        if (!running.root) same = true;
        else {
          try { const [a, b] = await Promise.all([realpath(running.root), realpath(root)]); same = a === b;
            if (!same) { const [x, y] = await Promise.all([stat(a), stat(b)]); same = x.ino !== 0 && x.dev === y.dev && x.ino === y.ino; }
          } catch { same = false; }
        }
      }
      if (values.status) {
        print({ running: Boolean(same), port: Number(port), ...(running ?? {}) }, () => same ? `실행 중: ${running.url} (프로젝트 ${running.project})`
          : running ? `포트 ${port}에서 다른 프로젝트(${running.project})의 대시보드가 실행 중입니다. --port로 다른 포트를 쓰세요.` : `포트 ${port}에서 실행 중인 대시보드가 없습니다.`);
        return same ? 0 : 1;
      }
      if (same) { stdout.write(`이미 실행 중입니다: ${running.url} (프로젝트 ${running.project})\n`); return 0; }
      if (running) throw new WaxError(`포트 ${port}에서 다른 프로젝트(${running.project})의 대시보드가 실행 중입니다. --port <다른 번호>로 실행하세요.`, 409);
      try { await startServer({ root, env, port: Number(port) }); }
      catch (error) { if (error.code === 'EADDRINUSE') throw new WaxError(`포트 ${port}을(를) 다른 프로그램이 쓰고 있습니다. --port <다른 번호>로 실행하세요.`, 409); throw error; }
      return null;
    }
    default:
      throw new UsageError(`알 수 없는 명령: ${command}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const code = await run(argv);
    if (code !== null) process.exitCode = code;
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`wax chat: ${error.message}\n\n${USAGE}\n`); process.exitCode = 2; return; }
    process.stderr.write(`wax chat: ${error instanceof WaxError ? error.message : error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
