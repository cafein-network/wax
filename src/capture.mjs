import { t } from '../web/messages-catalog.mjs';
import { randomUUID } from 'node:crypto';
import { constants, copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { getFeature, WaxError } from './workflow.mjs';
import { runCommand } from './evidence.mjs';
import { artifactFile } from './quality.mjs';
import { qualityRequirements } from '../web/project-types.mjs';
import { captureLabels, validCaptureLabel } from './proof-schema.mjs';

async function plainDirectory(path) {
  try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new WaxError(t('errors.capture.theCaptureStoragePath'));
}

const LABEL_ERRORS = { viewport: 'errors.capture.viewportFormat', scroll: 'errors.capture.scrollFormat', state: 'errors.capture.stateFormat' };

export async function captureArtifact(root, id, { check, file, command = [], revision, timeout = 120_000, viewport, scroll, state } = {}) {
  const labels = { viewport, scroll, state };
  for (const [name, value] of Object.entries(labels)) if (value !== undefined && !validCaptureLabel(name, value)) throw new WaxError(t(LABEL_ERRORS[name], String(value).slice(0, 40)));
  if (typeof check !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(check)) throw new WaxError(t('errors.capture.theCheckIdIs'));
  if (typeof file !== 'string' || !file) throw new WaxError(t('errors.capture.fileNeedsTheCapture'));
  if (!Array.isArray(command) || command.length > 100 || command.some((arg) => typeof arg !== 'string' || arg.length > 2000) || (command.length && !command[0]) ||
      !Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) throw new WaxError(t('errors.capture.checkTheCaptureCommand'));
  const feature = await getFeature(root, id);
  if (feature.archivedAt || feature.phase === 'done' || (revision !== undefined && revision !== feature.revision)) throw new WaxError(t('errors.capture.captureInTheLatest'), 409);
  let run = null;
  if (command.length) {
    const started = Date.now();
    run = { command, ...(await runCommand(root, command, timeout)), durationMs: Date.now() - started };
    if (run.exitCode !== 0 || run.timedOut) throw new WaxError(t('errors.capture.captureCommandFailed', run.exitCode ?? run.signal ?? '없음', run.timedOut ? ', 시간 초과' : '', run.output.slice(-2000)));
  }
  const kind = qualityRequirements(feature.projectType, feature.phase, feature.workMode).find((rule) => rule.id === check)?.kind === 'preview' ? 'preview' : 'visual';
  const source = await artifactFile(root, file, kind);
  if (!source) throw new WaxError(t(kind === 'preview' ? 'errors.capture.checkThePreviewFile' : 'errors.capture.checkTheCaptureFile'));
  const parts = ['.wax', 'artifacts', feature.id, `${feature.phase}-${feature.iteration}`];
  let directory = resolve(root);
  for (const part of parts) { directory = join(directory, part); await plainDirectory(directory); }
  const name = `${check}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}${extname(source).toLowerCase()}`;
  await copyFile(source, join(directory, name), constants.COPYFILE_EXCL);
  const artifact = [...parts, name].join('/');
  if (!(await artifactFile(root, artifact, kind))) throw new WaxError(t('errors.capture.couldNotStoreThe'));
  const label = captureLabels(labels);
  if (Object.keys(label).length) await writeFile(join(directory, `${name}.json`), `${JSON.stringify({ check, ...label })}\n`, { flag: 'wx' });
  return { artifact, check, phase: feature.phase, iteration: feature.iteration, source: file, ...label,
    ...(run ? { command: run.command, exitCode: run.exitCode, durationMs: run.durationMs } : {}) };
}

const STORED = /^([a-z][a-z0-9-]{0,63})-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{8}\.(?:png|jpe?g|webp|gif|svg|html|blend|rbxlx?|mp4)$/;

export async function listCaptures(root, id, phase, iteration, limit = 40) {
  const parts = ['.wax', 'artifacts', id, `${phase}-${iteration}`];
  let directory = resolve(root);
  try {
    for (const part of parts) { directory = join(directory, part); const info = await lstat(directory); if (info.isSymbolicLink() || !info.isDirectory()) return { captures: [], total: 0 }; }
  } catch { return { captures: [], total: 0 }; }
  const names = (await readdir(directory).catch(() => [])).filter((name) => STORED.test(name)).sort();
  const captures = [];
  for (const name of names.slice(-limit)) {
    const [, check, day, h, m, sec, ms] = STORED.exec(name);
    let label = {};
    try {
      const meta = join(directory, `${name}.json`), info = await lstat(meta);
      if (info.isFile() && info.size <= 4096) label = captureLabels(JSON.parse(await readFile(meta, 'utf8')));
    } catch {   }
    captures.push({ artifact: [...parts, name].join('/'), check, at: `${day}T${h}:${m}:${sec}.${ms}Z`, ...label });
  }
  return { captures, total: names.length };
}

export const captureLabelText = (capture, say) => [capture.viewport, capture.scroll !== undefined ? say('capture.scroll', capture.scroll) : '', capture.state].filter(Boolean).join(' · ');

export const CAPTURE_IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export async function captureImageFile(root, id, folder, name) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || typeof folder !== 'string' || !/^(?:plan|design|implement|review|report)-(?:0|[1-9]\d{0,5})$/.test(folder) ||
      typeof name !== 'string' || !STORED.test(name) || !Object.hasOwn(CAPTURE_IMAGE_TYPES, extname(name).toLowerCase())) return null;
  let path = resolve(root);
  try {
    for (const part of ['.wax', 'artifacts', id, folder]) { path = join(path, part); const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) return null; }
    path = join(path, name);
    const info = await lstat(path);
    return info.isFile() && info.size > 0 && info.size <= 20 * 1024 * 1024 ? path : null;
  } catch { return null; }
}
