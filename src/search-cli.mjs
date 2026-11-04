import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildIndex, indexStatus, search } from './search.mjs';
import { DOC_KINDS } from './search-sources.mjs';
import { cliText } from './cli-locale.mjs';


const mark = (text, marks) => {
  let out = '', at = 0;
  for (const [a, b] of marks) { out += `${text.slice(at, a)}«${text.slice(a, b)}»`; at = b; }
  return out + text.slice(at);
};

export async function searchCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    project: { type: 'string' }, feature: { type: 'string' }, kind: { type: 'string' }, author: { type: 'string' }, phase: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' }, 'no-sync': { type: 'boolean' },
    rebuild: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project ?? process.cwd());
  const { say, localize } = cliText();
  const print = (value, human) => console.log(values.json ? JSON.stringify(value, null, 2) : human(value));
  if (values.help || !positionals.length) { console.log(say('cli.search.help', Object.entries(DOC_KINDS).map(([key, label]) => `${key}(${localize(label)})`).join(', '))); return; }
  if (positionals[0] === 'index' && positionals.length === 1) {
    const result = await buildIndex(root, { rebuild: values.rebuild });
    return print(result, (r) => say(values.rebuild ? 'cli.search.rebuilt' : 'cli.search.synced', r.sources, r.changed, r.documents, r.ms, r.badRecords ? ` · ${say('cli.search.unreadableRecords', r.badRecords)}` : ''));
  }
  if (positionals[0] === 'status' && positionals.length === 1) {
    const status = await indexStatus(root);
    if (!['ready', 'stale', 'building', 'interrupted'].includes(status.state)) process.exitCode = 2;
    return print(status, (s) => [say('cli.search.state', s.state), ...(s.documents !== undefined ? [say('cli.search.stats', s.documents, s.indexedSources, s.pending, s.syncedAt ?? '-', Math.round((s.bytes ?? 0) / 1024))] : []),
      ...(s.damaged?.length ? s.damaged.map((d) => say('cli.search.damaged', d.path, d.records, d.lines.join(', '))) : []), ...(s.error ? [localize(s.error)] : []), ...(s.next ? [localize(s.next)] : [])].join('\n'));
  }
  const query = positionals.join(' ');
  const result = await search(root, { query, feature: values.feature, kind: values.kind, author: values.author, phase: values.phase, from: values.from, to: values.to, limit: values.limit, cursor: values.cursor }, { sync: !values['no-sync'] });
  print(result, (r) => {
    const lines = [say('cli.search.total', query, r.total, r.index.changed ? ` ${say('cli.search.changesApplied', r.index.changed)}` : '', r.index.note ? ` · ${localize(r.index.note)}` : '', r.index.damaged ? ` · ${say('cli.search.damagedExcluded', r.index.damaged)}` : '')];
    if (!r.results.length) lines.push(say('cli.search.noResults'));
    r.results.forEach((item, index) => {
      lines.push(`${index + 1}. [${localize(item.kindLabel)}] ${mark(item.title || item.feature || item.ref, item.titleMarks)} · ${[item.author, item.phase, item.at?.slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ')}`);
      if (item.snippet.text) lines.push(`   ${mark(item.snippet.text.replace(/\s+/g, ' '), item.snippet.marks)}`);
      lines.push(`   ${say('cli.search.source', item.source ?? item.ref)}${item.link ? ` · ${say('cli.search.screen', item.link)}` : ''}`);
    });
    if (r.next) lines.push(say('cli.search.nextPage', JSON.stringify(query), r.next));
    return lines.join('\n');
  });
}
