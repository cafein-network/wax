import { api, clear, el } from '/dom.mjs';

const KINDS = { message: '채널 메시지', note: '화이트보드 노트', report: '보고서', task: '업무 배정·상태', feature: '작업', document: '단계 문서', evidence: '완료 근거', history: '개선 이력', test: '테스트 근거', commit: '커밋 근거', request: '요청 대화', design: '디자인 작업' };
const PHASES = { plan: '기획', design: '설계', implement: '구현', review: '검토', report: '보고' };
const FIELDS = ['q', 'kind', 'feature', 'author', 'phase', 'from', 'to'];
const $ = (id) => document.getElementById(id);
const input = (name) => $(name === 'q' ? 'search-q' : `search-${name}`);
let config = null, status = null, cursors = [], requestNo = 0, timer = null, online = true;

for (const [value, label] of Object.entries(KINDS)) $('search-kind').append(el('option', { value, text: label }));
$('search-scope').textContent = `검색 범위: ${Object.values(KINDS).join(' · ')}. 실행 승인 기록, 세션 토큰과 AI 세션 정보는 색인하지 않습니다. 원본은 .wax의 JSON/JSONL이며 색인(.wax/search/index.db)은 언제든 다시 만들 수 있습니다.`;

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
  if (!online) { box.append(el('p', { text: '대시보드 서버와 연결이 끊겼습니다. wax init 또는 대시보드를 다시 실행한 뒤 이 페이지를 새로고침하세요.' })); return; }
  if (!status) { box.append(el('p', { text: '검색 색인 상태를 확인하는 중입니다…' })); return; }
  const running = status.job?.running;
  const lines = {
    ready: `색인 준비됨 · 문서 ${status.documents}개 · 마지막 동기화 ${status.syncedAt?.slice(0, 16).replace('T', ' ') ?? '-'}`,
    stale: `색인 사용 가능 · 아직 반영되지 않은 원본 ${status.pending}개는 검색할 때 먼저 반영합니다.`,
    building: '검색 색인을 만드는 중입니다. 끝날 때까지 결과가 일부만 나올 수 있습니다.',
    interrupted: '검색 색인 만들기가 중간에 멈췄습니다(작업이 끝났거나 대시보드가 다시 시작됨). 이어서 만들면 남은 기록부터 반영합니다. 그 전까지 결과는 일부일 수 있습니다.',
    missing: '검색 색인이 아직 없습니다. 아래 버튼으로 만드세요. 프로젝트 기록은 바꾸지 않습니다.',
    corrupt: '검색 색인이 손상됐습니다. 다시 만들면 원본 기록에서 새로 색인합니다.',
    outdated: '이 wax 버전과 색인 형식이 달라 다시 만들어야 합니다.',
    unsupported: status.error ?? '이 Node.js에서는 검색을 쓸 수 없습니다.',
  };
  box.dataset.state = running ? 'building' : status.state;
  box.append(el('p', { text: running ? '검색 색인을 만드는 중입니다…' : lines[status.state] ?? status.state }));
  const FILE_STATES = { missing: '파일 없음', refused: '프로젝트 밖·링크라 읽지 않음', 'too-large': '1MB 초과', unreadable: '읽을 수 없음' };
  if (status.damaged?.length) box.append(el('p', { class: 'kind', text: `읽지 못한 기록 ${status.damaged.reduce((n, d) => n + d.records, 0)}건은 검색에서 빠집니다: ${status.damaged.map((d) => d.file ? `${d.path} (${FILE_STATES[d.file] ?? d.file})` : `${d.path} (줄 ${d.lines.join(', ')})`).join(' · ')}` }));
  if (status.job?.error && !running) box.append(el('p', { class: 'search-error', text: `색인 작업 실패: ${status.job.error}` }));
  if (['missing', 'corrupt', 'outdated', 'interrupted'].includes(status.state) || (status.state === 'ready' && !running)) {
    const rebuild = !['missing', 'interrupted'].includes(status.state);
    box.append(el('button', { type: 'button', disabled: running || !config, onclick: () => buildIndex(rebuild),
      text: { missing: '검색 색인 만들기', interrupted: '색인 이어서 만들기', ready: '색인 다시 만들기' }[status.state] ?? '색인 다시 만들기(복구)' }));
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
  const note = [result.index?.note, result.index?.damaged ? `읽지 못한 기록 ${result.index.damaged}건 제외` : null].filter(Boolean).join(' · ');
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
    $('search-summary').textContent = '검색어를 입력하거나 필터를 고르세요. 예: 인계, 리뷰 오류, “Claude Code”, docs/wax/design, 커밋 SHA 앞자리.';
    return;
  }
  const mine = ++requestNo;
  $('search-summary').textContent = '찾는 중…';
  try {
    const result = await api(`/api/search?${new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) })}`);
    if (mine !== requestNo) return;
    showAlert(null); online = true;
    renderResults(result, append);
  } catch (error) {
    if (mine !== requestNo) return;
    showAlert(`검색하지 못했습니다: ${error.message}`);
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
  $('status').dataset.state = 'up'; $('status').textContent = '연결됨';
  const [features, presence] = await Promise.all([api('/api/features').catch(() => []), api('/api/presence').catch(() => [])]);
  for (const f of features) $('search-feature').append(el('option', { value: f.id, translate: 'no', text: `${f.title} (${f.id})` }));
  if (initial.get('feature')) $('search-feature').value = initial.get('feature');
  for (const a of presence) $('search-authors').append(el('option', { value: a.author }));
} catch { online = false; $('status').textContent = '연결 끊김'; }
await refreshStatus();
run();
const events = new EventSource('/api/events');
events.addEventListener('search', () => refreshStatus().then(() => { if (!status?.job?.running && $('search-q').value.trim()) run(); }));
events.addEventListener('open', () => { $('status').dataset.state = 'up'; $('status').textContent = '연결됨'; if (!online) { online = true; refreshStatus(); } });
events.addEventListener('error', () => { $('status').dataset.state = 'down'; $('status').textContent = '다시 연결 중…'; });
$('search-q').focus();
