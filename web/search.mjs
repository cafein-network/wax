import { t } from './messages-catalog.mjs';
import { api, clear, el } from '/dom.mjs';
import { openEvents } from '/events.mjs';

const KINDS = { message: t('search.channelMessages'), note: t('search.whiteboardNotes'), report: t('search.reports'), task: t('search.assignmentStatus'), feature: t('search.task'), document: t('search.stageDocuments'), evidence: t('search.completionEvidence'), history: t('search.iterationHistory'), test: t('search.testEvidence'), commit: t('search.commitEvidence'), request: t('search.requestConversation'), design: t('search.designJobs') };
const PHASES = { plan: t('search.plan'), design: t('search.design'), implement: t('search.implement'), review: t('search.review'), report: t('search.report') };
const FIELDS = ['q', 'kind', 'feature', 'author', 'phase', 'from', 'to'];
const $ = (id) => document.getElementById(id);
const input = (name) => $(name === 'q' ? 'search-q' : `search-${name}`);
let config = null, status = null, cursors = [], requestNo = 0, timer = null, online = true;

for (const [value, label] of Object.entries(KINDS)) $('search-kind').append(el('option', { value, text: label }));
$('search-scope').textContent = t('search.searchScopeExecutionApproval', Object.values(KINDS).join(' · '));

function marked(text, marks = []) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [start, end] of marks) {
    if (start < at || end > text.length) continue;
    frag.append(text.slice(at, start), el('mark', { text: text.slice(start, end) }));
    at = end;
  }
  frag.append(text.slice(at));
  return frag;
}
const params = () => Object.fromEntries(FIELDS.map((name) => [name, input(name).value.trim()]).filter(([, value]) => value));
function showAlert(message) { $('search-alert').hidden = !message; $('search-alert').textContent = message ?? ''; }

function renderIndex() {
  const box = clear($('search-index'));
  if (!online) { box.append(el('p', { text: t('search.lostConnectionToThe') })); return; }
  if (!status) { box.append(el('p', { text: t('search.checkingTheSearchIndex') })); return; }
  const running = status.job?.running;
  const lines = {
    ready: t('search.indexReadyDocumentsLast', status.documents, status.syncedAt?.slice(0, 16).replace('T', ' ') ?? '-'),
    stale: t('search.indexAvailableOriginalsNot', status.pending),
    building: t('search.buildingTheSearchIndex'),
    interrupted: t('search.buildingTheSearchIndexStopped'),
    missing: t('search.thereIsNoSearch'),
    corrupt: t('search.theSearchIndexIs'),
    outdated: t('search.theIndexFormatDiffers'),
    unsupported: status.error ?? t('search.searchIsntAvailableOn'),
  };
  box.dataset.state = running ? 'building' : status.state;
  box.append(el('p', { text: running ? t('search.buildingTheSearchIndex2') : lines[status.state] ?? status.state }));
  const FILE_STATES = { missing: t('search.fileNotFound'), refused: t('search.notReadOutsideThe'), 'too-large': t('search.over1mb'), unreadable: t('search.unreadable') };
  if (status.damaged?.length) box.append(el('p', { class: 'kind', text: `읽지 못한 기록 ${status.damaged.reduce((n, d) => n + d.records, 0)}건은 검색에서 빠집니다: ${status.damaged.map((d) => d.file ? `${d.path} (${FILE_STATES[d.file] ?? d.file})` : `${d.path} (줄 ${d.lines.join(', ')})`).join(' · ')}` }));
  if (status.job?.error && !running) box.append(el('p', { class: 'search-error', text: t('search.indexTaskFailed', status.job.error) }));
  if (['missing', 'corrupt', 'outdated', 'interrupted'].includes(status.state) || (status.state === 'ready' && !running)) {
    const rebuild = !['missing', 'interrupted'].includes(status.state);
    box.append(el('button', { type: 'button', disabled: running || !config, onclick: () => buildIndex(rebuild),
      text: { missing: t('search.buildSearchIndex'), interrupted: t('search.resumeBuildingIndex'), ready: t('search.rebuildIndex') }[status.state] ?? t('search.rebuildIndexRecover') }));
  }
}

async function refreshStatus() {
  try { status = await api('/api/search/status'); online = true; }
  catch { online = false; }
  renderIndex();
}
async function buildIndex(rebuild) {
  showAlert(null);
  try { await api('/api/search/index', { method: 'POST', body: { rebuild }, token: config.token }); }
  catch (error) { showAlert(error.message); }
  await refreshStatus();
}

function renderResults(result, append) {
  const list = $('search-list');
  if (!append) clear(list);
  for (const item of result.results) {
    const when = item.at ? item.at.slice(0, 16).replace('T', ' ') : '';
    const title = item.title || (item.channel ? `#${item.channel}` : item.feature) || item.ref;
    list.append(el('li', { class: 'search-item' },
      el('p', { class: 'search-meta' }, el('span', { class: 'search-kind', text: item.kindLabel }), [item.feature, item.author, PHASES[item.phase] ?? item.phase, item.status, when].filter(Boolean).join(' · ')),
      el('h3', { translate: 'no' }, item.link ? el('a', { href: item.link }, marked(title, item.titleMarks)) : marked(title, item.titleMarks)),
      item.snippet.text ? el('p', { class: 'search-snippet', translate: 'no' }, marked(item.snippet.text, item.snippet.marks)) : null,
      el('p', { class: 'search-source' }, '원문 ', el('code', { text: item.source ?? item.ref }), item.link ? el('a', { href: item.link, text: ' 화면에서 열기 →' }) : null)));
  }
  const how = result.methods?.length ? ` · ${result.methods.map((m) => `${m.term}: ${({ trigram: '부분 일치', bigram: '두 글자 조각', scan: '전체 훑기' })[m.via]}`).join(', ')}` : '';
  const note = [result.index?.note, result.index?.damaged ? t('search.unreadableRecordsExcluded', result.index.damaged) : null].filter(Boolean).join(' · ');
  $('search-summary').textContent = result.results.length || append
    ? `${result.total}건${how}${note ? ` · ${note}` : ''}`
    : `“${result.query}”에 맞는 기록이 없습니다. 더 짧은 단어나 다른 표현을 쓰거나 필터를 지워 보세요.${note ? ` ${note}` : ''}`;
  $('search-more').hidden = !result.next; $('search-more').dataset.cursor = result.next ?? '';
  $('search-first').hidden = cursors.length === 0;
}

async function run({ cursor = null, append = false } = {}) {
  const query = params();
  history.replaceState(null, '', Object.keys(query).length ? `/search?${new URLSearchParams(query)}` : '/search');
  if (!Object.keys(query).length) {
    clear($('search-list')); $('search-more').hidden = true; $('search-first').hidden = true;
    $('search-summary').textContent = t('search.enterASearchTerm');
    return;
  }
  const mine = ++requestNo;
  $('search-summary').textContent = t('search.searching');
  try {
    const result = await api(`/api/search?${new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) })}`);
    if (mine !== requestNo) return;
    showAlert(null); online = true;
    renderResults(result, append);
  } catch (error) {
    if (mine !== requestNo) return;
    showAlert(t('search.searchFailed', error.message));
    $('search-summary').textContent = '';
    await refreshStatus();
  }
}

$('search-form').addEventListener('submit', (event) => { event.preventDefault(); cursors = []; run(); });
$('search-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { cursors = []; run(); }, 350); });
for (const name of FIELDS.slice(1)) input(name).addEventListener('change', () => { cursors = []; run(); });
$('search-more').addEventListener('click', () => { cursors.push($('search-more').dataset.cursor); run({ cursor: cursors.at(-1), append: true }); });
$('search-first').addEventListener('click', () => { cursors = []; run(); window.scrollTo({ top: 0 }); });
$('search-clear').addEventListener('click', () => { for (const name of FIELDS.slice(1)) input(name).value = ''; cursors = []; run(); });

const initial = new URLSearchParams(location.search);
for (const name of FIELDS) if (initial.get(name)) input(name).value = initial.get(name);
if (FIELDS.slice(1).some((name) => initial.get(name))) $('search-filters').open = true;

try {
  config = await api('/api/config');
  $('status').dataset.state = 'up'; $('status').textContent = t('search.connected');
  const [features, presence] = await Promise.all([api('/api/features').catch(() => []), api('/api/presence').catch(() => [])]);
  for (const f of features) $('search-feature').append(el('option', { value: f.id, translate: 'no', text: `${f.title} (${f.id})` }));
  if (initial.get('feature')) $('search-feature').value = initial.get('feature');
  for (const a of presence) $('search-authors').append(el('option', { value: a.author }));
} catch { online = false; $('status').textContent = t('search.disconnected'); }
await refreshStatus();
run();
const events = openEvents();
events.addEventListener('search', () => refreshStatus().then(() => { if (!status?.job?.running && $('search-q').value.trim()) run(); }));
events.addEventListener('open', () => { $('status').dataset.state = 'up'; $('status').textContent = t('search.connected'); if (!online) { online = true; refreshStatus(); } });
events.addEventListener('error', () => { $('status').dataset.state = 'down'; $('status').textContent = t('search.reconnecting'); });
$('search-q').focus();
