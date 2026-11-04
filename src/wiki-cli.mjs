import { t } from '../web/messages-catalog.mjs';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatIngest, formatLint, ingest, lint, listPages, readPage, savePage, skip } from './wiki.mjs';
import { cliText } from './cli-locale.mjs';


export async function wikiCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    project: { type: 'string' }, file: { type: 'string' }, base: { type: 'string' }, author: { type: 'string' }, batch: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project ?? process.cwd());
  const { say } = cliText();
  const print = (value, human) => console.log(values.json ? JSON.stringify(value, null, 2) : human(value));
  const [command, target] = positionals;
  if (values.help || !command) { console.log(say('cli.wiki.help')); return; }
  if (command === 'list') return print(await listPages(root), (pages) => pages.length ? pages.map((p) => say('cli.wiki.page', p.slug, p.title, p.refs.length, p.updatedAt.slice(0, 10))).join('\n') : say('cli.wiki.noPages'));
  if (command === 'show') return print(await readPage(root, target), (page) => `${page.markdown}\n---\n${say('cli.wiki.hash', page.hash, page.slug)}`);
  if (command === 'ingest') {
    const batch = values.batch === undefined ? 20 : Number(values.batch);
    return print(await ingest(root, { batch }), formatIngest);
  }
  if (command === 'save') {
    if (!values.file) throw new Error(t('errors.wikiCli.fileMarkdownFileIs'));
    const markdown = await readFile(resolve(values.file), 'utf8');
    return print(await savePage(root, target, markdown, { base: values.base, author: values.author }), (r) => say(r.created ? 'cli.wiki.created' : 'cli.wiki.updated', r.path, r.hash, r.refs.length));
  }
  if (command === 'skip') return print(await skip(root, (target ?? '').split(',').map((ref) => ref.trim()).filter(Boolean)), (r) => say('cli.wiki.skipped', r.seen));
  if (command === 'lint') {
    const results = await lint(root);
    print(results, formatLint);
    if (results.some((page) => page.problems.some((p) => p.level === 'error'))) process.exitCode = 1;
    return;
  }
  throw new Error(t('errors.wikiCli.unknownCommandSeeWax', command));
}
