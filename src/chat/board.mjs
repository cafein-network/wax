import { t } from '../../web/messages-catalog.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WaxError } from '../workflow.mjs';
import * as v from './validate.mjs';
import { chatDir, checkFile, safeDir } from './paths.mjs';
import { appendRecord, makeId, readRecords } from './store.mjs';
import { resolveTarget } from './channels.mjs';
import { resolveKind, withPresenceActivity } from './presence.mjs';

async function boardFile(root, board, create) {
  if (create) await chatDir(root, null, { create: true });
  const dir = await chatDir(root, 'board', { create });
  return dir && join(dir, `${board}.jsonl`);
}

const reportDirParts = (board) => ['docs', 'wax', board, 'board-reports'];
export const reportPath = (board, number) => `docs/wax/${board}/board-reports/${String(number).padStart(3, '0')}.md`;

export async function postNote(root, board, input = {}, { now = new Date() } = {}) {
  const feature = await resolveTarget(root, board, { write: true });
  const author = v.author(input.author);
  const kind = await resolveKind(root, author, input.kind);
  const type = v.noteType(input.type);
  const body = v.body(input.body);
  const stance = v.stance(input.stance);
  const replyTo = input.replyTo ? (v.seqOf(input.replyTo, ['n'], '답글 대상 노트 ID'), input.replyTo) : null;
  if (type === 'answer' && !replyTo) throw new WaxError(t('errors.chat.board.anAnswerNoteRequires'));
  if (stance && !replyTo) throw new WaxError(t('errors.chat.board.stanceMustBeUsed'));
  const phase = v.phase(input.phase) ?? feature?.phase ?? null;
  const file = await boardFile(root, board, true);
  return withPresenceActivity(root, { author, session: input.session, kind, feature: feature ? board : undefined }, async () => {
    const note = await appendRecord(file, async (seq) => {
      if (replyTo) {
        const { records } = await readRecords(file);
        if (!records.some((record) => record.record === 'note' && record.id === replyTo)) throw new WaxError(t('errors.chat.board.theReplyTargetNote', replyTo));
      }
      return {
        schema: 1, record: 'note', id: makeId('n', seq), seq, board, author, kind, type, stance, replyTo, body,
        ...(phase ? { phase } : {}), at: now.toISOString(),
      };
    });
    return note;
  }, { now });
}

export async function listBoard(root, board, { since } = {}) {
  await resolveTarget(root, board);
  const sinceSeq = since ? v.seqOf(since, ['n', 'r'], 'since ID') : 0;
  const file = await boardFile(root, board, false);
  if (!file) return { notes: [], reports: [], skipped: 0 };
  const { records, skipped } = await readRecords(file);
  const sorted = records.filter((record) => record.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  return { notes: sorted.filter((r) => r.record === 'note'), reports: sorted.filter((r) => r.record === 'report'), skipped };
}

export async function saveReport(root, board, input = {}, { now = new Date() } = {}) {
  await resolveTarget(root, board, { write: true });
  const author = v.author(input.author);
  const kind = await resolveKind(root, author, input.kind);
  const markdown = v.body(input.markdown, v.LIMITS.report, '보고서');
  const requested = input.coversThrough ? v.seqOf(input.coversThrough, ['n'], 'covers-through 노트 ID') : null;
  const file = await boardFile(root, board, true);
  return withPresenceActivity(root, { author, session: input.session, kind }, async () => {
    const record = await appendRecord(file, async (seq) => {
      const { records } = await readRecords(file);
      const notes = records.filter((r) => r.record === 'note');
      if (!notes.length) throw new WaxError(t('errors.chat.board.thereAreNoNotes'), 409);
      const reports = records.filter((r) => r.record === 'report');
      const coversThrough = requested ?? notes.at(-1).seq;
      if (!notes.some((note) => note.seq === coversThrough)) throw new WaxError(t('errors.chat.board.coversThroughMustBe'));
      const number = (reports.at(-1)?.number ?? 0) + 1;
      const path = reportPath(board, number);
      const dir = await safeDir(root, reportDirParts(board), { create: true });
      const target = join(dir, path.split('/').at(-1));
      await checkFile(target);
      try { await writeFile(target, `${markdown}\n`, { flag: 'wx', mode: 0o644 }); }
      catch (error) { if (error.code === 'EEXIST') throw new WaxError(t('errors.chat.board.alreadyExistsAndWas', path), 409); throw error; }
      return {
        schema: 1, record: 'report', id: makeId('r', seq), seq, board, author, kind, number, path,
        coversThrough, noteCount: notes.filter((note) => note.seq <= coversThrough && note.seq > (reports.at(-1)?.coversThrough ?? 0)).length,
        at: now.toISOString(),
      };
    });
    return record;
  }, { now });
}

export async function readReport(root, board, number) {
  await resolveTarget(root, board);
  if (!Number.isInteger(number) || number < 1 || number > 999) throw new WaxError(t('errors.chat.board.invalidReportNumber'));
  const dir = await safeDir(root, reportDirParts(board));
  if (!dir) throw new WaxError(t('errors.chat.board.noSuchReport'), 404);
  const target = join(dir, reportPath(board, number).split('/').at(-1));
  await checkFile(target);
  try { return await readFile(target, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new WaxError(t('errors.chat.board.noSuchReport'), 404); throw error; }
}
