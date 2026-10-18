import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildIndex, indexStatus, search } from './search.mjs';
import { DOC_KINDS } from './search-sources.mjs';

const HELP = `wax search — 기록 검색 (색인: .wax/search/index.db, 원본은 그대로)

wax search <검색어...> [--feature <작업ID>] [--kind <종류>] [--author <이름>] [--phase <단계>]
                     [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit 20] [--cursor <다음 페이지>] [--no-sync] [--json]
wax search index [--rebuild] [--json]     색인 만들기·재구축 (처음 한 번, 손상·형식 변경 시 --rebuild)
wax search status [--json]                색인 상태·미반영 변경·손상 기록

검색어: 띄어 쓴 단어는 모두 포함(AND). "따옴표"는 구절. 세 글자 이상은 부분 일치, 두 글자(예: 인계, UI)는 단어 조각 일치,
        한 글자는 전체 훑기라 느릴 수 있습니다. 대소문자 구분 없음. 결과는 최신순.
종류: ${Object.entries(DOC_KINDS).map(([key, label]) => `${key}(${label})`).join(', ')}
검색할 때마다 바뀐 기록만 먼저 색인에 반영합니다(--no-sync로 생략).`;

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
  const print = (value, human) => console.log(values.json ? JSON.stringify(value, null, 2) : human(value));
  if (values.help || !positionals.length) { console.log(HELP); return; }
  if (positionals[0] === 'index' && positionals.length === 1) {
    const result = await buildIndex(root, { rebuild: values.rebuild });
    return print(result, (r) => `검색 색인 ${values.rebuild ? '재구축' : '동기화'} 완료: 원본 ${r.sources}개 중 ${r.changed}개 반영, 문서 ${r.documents}개, ${r.ms}ms${r.badRecords ? ` · 읽지 못한 기록 ${r.badRecords}건(wax search status)` : ''}`);
  }
  if (positionals[0] === 'status' && positionals.length === 1) {
    const status = await indexStatus(root);
    if (!['ready', 'stale', 'building', 'interrupted'].includes(status.state)) process.exitCode = 2;
    return print(status, (s) => [`검색 색인: ${s.state}`, ...(s.documents !== undefined ? [`문서 ${s.documents}개 · 원본 ${s.indexedSources}개 · 미반영 ${s.pending}개 · 마지막 동기화 ${s.syncedAt ?? '-'} · ${Math.round((s.bytes ?? 0) / 1024)}KB`] : []),
      ...(s.damaged?.length ? s.damaged.map((d) => `읽지 못한 기록: ${d.path} ${d.records}건 (줄 ${d.lines.join(', ')})`) : []), ...(s.error ? [s.error] : []), ...(s.next ? [s.next] : [])].join('\n'));
  }
  const query = positionals.join(' ');
  const result = await search(root, { query, feature: values.feature, kind: values.kind, author: values.author, phase: values.phase, from: values.from, to: values.to, limit: values.limit, cursor: values.cursor }, { sync: !values['no-sync'] });
  print(result, (r) => {
    const lines = [`"${query}" ${r.total}건${r.index.changed ? ` (색인에 변경 ${r.index.changed}개 반영)` : ''}${r.index.note ? ` · ${r.index.note}` : ''}${r.index.damaged ? ` · 읽지 못한 기록 ${r.index.damaged}건 제외` : ''}`];
    if (!r.results.length) lines.push('결과가 없습니다. 다른 단어나 더 짧은 검색어, 필터 해제를 시도하세요.');
    r.results.forEach((item, index) => {
      lines.push(`${index + 1}. [${item.kindLabel}] ${mark(item.title || item.feature || item.ref, item.titleMarks)} · ${[item.author, item.phase, item.at?.slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ')}`);
      if (item.snippet.text) lines.push(`   ${mark(item.snippet.text.replace(/\s+/g, ' '), item.snippet.marks)}`);
      lines.push(`   원문: ${item.source ?? item.ref}${item.link ? ` · 화면: ${item.link}` : ''}`);
    });
    if (r.next) lines.push(`다음 페이지: wax search ${JSON.stringify(query)} --cursor ${r.next}`);
    return lines.join('\n');
  });
}
