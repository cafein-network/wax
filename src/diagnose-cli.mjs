import { t } from '../web/messages-catalog.mjs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { diagnose, renderDiagnose } from './diagnose.mjs';
import { SKIP_TEXT, makeBundle, zipBundle } from './diagnose-bundle.mjs';
import { WaxError } from './workflow.mjs';
import { cliText } from './cli-locale.mjs';

export async function diagnoseCli(args, { out = (text) => process.stdout.write(text), env = process.env } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      project: { type: 'string' }, json: { type: 'boolean' }, since: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      bundle: { type: 'string' }, level: { type: 'string' }, 'keep-email': { type: 'boolean' }, zip: { type: 'string' },
    } });
  } catch { throw new Error(t('errors.diagnose.usage')); }
  const { values, positionals } = parsed;
  const { say } = cliText();
  if (values.help) { out(`${say('cli.diagnose.help')}\n`); return; }
  const root = resolve(values.project || process.cwd());
  const bundling = values.bundle !== undefined, zipping = values.zip !== undefined;
  if ((bundling || zipping) && env.WAX_WORKER === '1') throw new WaxError(t('errors.diagnose.bundleHuman'), 403);
  if (zipping) {
    if (positionals.length || bundling || values.json || values.since !== undefined || values.level !== undefined) throw new Error(t('errors.diagnose.usage'));
    const done = await zipBundle(root, values.zip, { keepEmail: Boolean(values['keep-email']) });
    out(`${[say('diagnose.zip.done', done.zip, done.files.length, done.bytes), say('diagnose.zip.note')].join('\n')}\n`);
    return;
  }
  if (positionals.length !== 1 || (!bundling && (values.level !== undefined || values['keep-email']))) throw new Error(t('errors.diagnose.usage'));
  if (bundling) {
    if (values.json) throw new Error(t('errors.diagnose.usage'));
    const done = await makeBundle(root, positionals[0], values.bundle, { level: values.level ?? 'skeleton', keepEmail: Boolean(values['keep-email']), since: values.since ?? null, say });
    const width = Math.max(...done.files.map((file) => String(file.bytes).length));
    out(`${[say('diagnose.bundle.done', done.dir, done.level),
      ...done.files.map((file) => `  ${String(file.bytes).padStart(width)}  ${file.path}`),
      say('diagnose.bundle.scrubbed', done.scrubbed, done.omitted),
      ...done.skipped.map((item) => say('diagnose.bundle.skipped', item.file, say(SKIP_TEXT[item.reason]))),
      say('diagnose.bundle.next', done.dir),
      say('diagnose.bundle.review')].join('\n')}\n`);
    return;
  }
  const report = await diagnose(root, positionals[0], { since: values.since ?? null });
  out(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderDiagnose(report, say));
}
