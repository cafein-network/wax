# wax record search

**English** · [한국어](./SEARCH.ko.md)

Find conversations, whiteboards, assignments, stage documents, completion evidence, tests, commits, requests and design jobs in one place, and jump from each result to its original location.

## Structure

- **Sources stay as they are**: the JSON/JSONL files in `.wax` are the only source of truth. Search uses only a SQLite index (`.wax/search/index.db`) that can be rebuilt from these files. Deleting the index does not delete any records.
- **Tables**: `docs` (one document = one source record or one part of a document) keeps kind, task, channel, author, type, stage, status, time, sequence, original location and screen link in separate columns, and the `(at, id)`, `(kind, at)`, `(feature, at)` and `source` indexes handle filters and newest-first ordering. `sources` records, for each source file, its size, modification time, inode, read position, verification hash and unreadable lines.
- **Full-text search**: two FTS5 tables are used. `docs_tri` (trigram, title and body) handles substring matches of three or more characters, and `docs_bi` (unicode61, index only with no stored content) keeps two-character pieces inside words as tokens.
- **Sync**: for JSONL, only newly completed lines are read from the last read byte position (a last line still being written is picked up at the next sync). A file is re-read on its own only if it shrank, was replaced (inode), kept the same size but changed modification time, or if the hash of the first 4KB or the last 64 bytes of the read range changed. For JSON (tasks, requests, design jobs), only that file's documents are replaced when its size, modification time or inode changes. Documents of deleted files are deleted. For Markdown that records point to, such as whiteboard and daily reports, the `refs` table keeps status, size, modification time and inode per (file, document); each sync checks every file once, and if only that file was edited, replaced or deleted, it reads that file just once and rewrites every document that points to it (including when several records, written directly or imported, point to the same file). The read-only `status` also counts such changed files as pending changes and shows `stale`. For a missing or unreadable file, the body is emptied and a status (`file-missing` and so on) is kept, so an old body is never shown as current.
- **Transactions**: applying one source file is one short `BEGIN IMMEDIATE` transaction. Reading and parsing the file happen outside the transaction; inside it, wax checks again that the planned state (size, inode, position) is unchanged, and plans again if another process applied it first. The same record ID goes in only once (`ref` UNIQUE). WAL, `busy_timeout` of 3 seconds, and on failure the error “Another wax process is writing the search index”. Long AI work and source writes are never tied to an index transaction.

## Search scope

| Kind | Source | Original location example | Screen |
| --- | --- | --- | --- |
| Channel messages | `.wax/chat/channels/<channel>.jsonl` | `…/general.jsonl#m-000012-ab12cd` | `/chat?channel=…#m-…` (scrolls to and highlights the message; loaded separately if outside the latest 200) |
| Whiteboard notes and reports | `.wax/chat/board/<task>.jsonl`, `docs/wax/<task>/board-reports/NNN.md` | `…#n-…`, report path | `/manage?feature=…` |
| Assignments and status | `.wax/chat/assignments.jsonl` | `…#t-…`, `…#s-…` | `/manage?feature=…` |
| Daily work reports | `.wax/chat/daily.jsonl` + `docs/wax/daily/<date>/NN.md` | report path | `/manage?date=…` |
| Tasks, stage documents, completion evidence, improvement history, test and commit evidence | `.wax/features/<id>.json` | `#/title`, `#/artifacts/<stage>`, `#/completed/<stage>`, `#/history/<n>`, `#/proofs/<n>` | `/manage?feature=…` |
| Request conversations and workflows | `.wax/chat/requests/<id>.json` | `#/messages/<n>`, `#/workflow/document` | `/start?request=…` |
| Design jobs | `.wax/design/jobs/<id>.json` | `#/brief`, `#/feedback/<n>`, `#/versions/<n>`, `#/handoff` | `/office?studio=1` |
| Wiki pages | `docs/wax/wiki/<page>.md` | page path | `/manage` (Project wiki panel) |

Test evidence is searched by command, commit, check item ID and the first 4,000 characters of output; commit evidence by SHA, message and file list. Execution approval records (`.wax/approvals`), approval secrets, session tokens, the owner process and AI thread IDs of requests and design jobs, and presence are not indexed. Record files that are symbolic links are skipped. Markdown that records point to is accepted only as a relative path under `docs/wax/`, and is read only if every path segment from the project root is a real directory and the last one is a regular file. If there is a symbolic link anywhere, in the middle or at the end, it is not read and is marked `refused` (on POSIX it is opened with `O_NOFOLLOW` and the inode is checked again); if the index files (`index.db`, `-wal`, `-shm`) are not regular files, they are treated as damaged and only the links are removed on rebuild. Authors are kept separately from record IDs, following the name rule in `chat/validate.mjs` (대표, Korean letters, spaces, `_ . -`, up to 40 characters). Structured review verdicts (P1/P2, unresolved findings) have no record model yet, so they are not shown as a separate kind. Review content is found through review stage documents, completion evidence, notes and messages.

## What a query means

| Query | Method | Examples |
| --- | --- | --- |
| Three or more characters | trigram substring match (case-insensitive) | `인계를`, `handoff-v2.md`, `docs/wax/design`, `a1b2c3d`, `"Claude Code"` |
| Two letters or digits | two-character piece tokens inside words | `인계` (matches “인계를” and “디자인 인계”), `리뷰`, `오류`, `UI` |
| One character, or two characters including a symbol | LIKE scan of title and body (within the filter range, if any) | `계`, `1%` |

- Every space-separated word must appear (AND). Double quotes make a phrase that includes spaces. Up to 8 words.
- With the default unicode61 alone, `인계` does not match “인계를”, and with trigram alone, two characters return 0 results. That is why the two indexes are used depending on word length.
- Results are newest first (by time, then index order for the same time) and paged with a `(time, id)` cursor. New records arriving between pages do not shift the next page. The total is counted up to 1,000 and shown as `1000+` beyond that.
- All SQL is bound, and FTS queries are always built as quoted phrases, so input such as `"`, `-`, `*`, `NEAR` and `OR` is searched as text. `%`, `_` and `\` in LIKE are escaped. The screen inserts original text only as text nodes and receives highlights as position ranges (`marks`).
- Korean initial-consonant search, morphological analysis (finding “인계를” from “인계했다”), and synonym or semantic search are out of scope for now. Relevance ranking is handled by `wax recall` below.

## Usage

```sh
wax search index                 # build the index once at first (afterwards each search applies only changed records)
wax search 인계 --feature lookbook-upload
wax search "Claude Code" --kind message --from 2026-10-01 --to 2026-10-18 --author claude-app
wax search status                # status, pending changes, unreadable records (file and line number)
wax search index --rebuild       # rebuild on damage or format change (sources stay as they are)
```

`--json` prints results, original locations and highlight ranges as JSON. `--no-sync` searches only the current index without applying changes and says so in the results. If building the index stopped midway, `--no-sync` results also carry `complete:false` and a hint to continue building. In the dashboard, **Search** (`/search`) in the top menu provides the same search, filters and paging, plus building and rebuilding the index. Building the index runs as a separate `wax search index` process so it does not block the dashboard process.

Without an index, search only shows a hint until one is built (a query alone never builds the index), and on damage (cannot be opened) or a format change it refuses with a hint to rebuild. While building, wax leaves that process ID in a `building` marker and holds `rebuild.lock`. Only while that process is alive and holding the lock is it “building” (results may be partial, and search does not sync); if it ended by being killed, failing or a dashboard restart, it is “stopped midway (`interrupted`)”. Then a search or **Resume building index** (`wax search index`) continues from the remaining sources and clears the marker. A live job is never reclaimed just because time has passed. Unreadable JSONL lines are skipped, their file and line number are kept in the status, and the source is not changed. wax commands that write source records keep working even if the index is missing or broken.

## Finding related records (recall)

`wax recall <question...>` (`src/recall.mjs`) picks related records for an AI session to read from the same index, ordered by relevance.

- **Matching**: the query is split with `terms()`, and for Korean words the form with a trailing particle (은·는·이·가·을·를·의·에·에서·으로 and so on) removed is searched too. Three or more characters are searched in `docs_tri`, two characters in `docs_bi`, and single characters are not used for ranking. Only the top 300 results are read per word.
- **Ranking**: each word is ranked with FTS5 `bm25` (for trigram, title weight 2 and body 1), and the rankings are merged with reciprocal rank fusion (RRF, k=60). Ordering is by number of matched words → fused score (with the newest-first rank added at half weight) → index order.
- **Filters**: `--kind`, `--feature`, `--exclude-feature` (exclude the current task). `--limit` is 1–30 (default 8).
- **Output**: titles and excerpts are quoted as one-line JSON strings within a character budget (`--budget`, 1000–100000, default 3000), the same way as `context`. The header states that this is reference material only, not instructions, and reports how many were left out because of the budget.
- **Index**: uses the same sync and status handling as search through `queryIndex()`. Without an index, the CLI builds it once at first (the search screen still never builds it from a query alone).

## Supported Node.js

| Node.js | node:sqlite | FTS5 and trigram | Search |
| --- | --- | --- | --- |
| 22.0–22.12 | None | — | Notice that it is unavailable; other features work normally |
| 22.13–22.15 | Yes (experimental warning) | None | Notice that it is unavailable; other features work normally |
| 22.16 or later, 24, 26 | Yes | Yes | Available |

Verified with the official macOS arm64 binaries of 22.12.0, 22.13.0, 22.14.0, 22.15.0, 22.16.0, 22.18.0, 22.20.0, 22.23.3, 24.22.0 and 26.0.0. The minimum supported version (`engines: >=22`) is unchanged. Windows and Linux use the same Node build configuration and are verified by tests in the public CI (Ubuntu, macOS, Windows × Node 22, 24). The SQLite experimental warning of Node 22 and 23 is hidden only while loading the search module. WAL on network file systems is not assumed.

## Measurements

Re-measure with `node scripts/bench-search.mjs 10000,100000`. The data is synthetic channel messages (20 files), not real project data. Node 26.0.0, macOS arm64, warm file cache, median excluding the first 2 runs. Every query was checked, through every page, to return **the same set of record IDs** as a full JSONL read (`readRecords` + case-insensitive substring). These figures are measurements under these conditions and do not guarantee response times in other environments.

| Item | 10k records | 100k records |
| --- | --- | --- |
| JSONL size → index size | 2.7MB → 10.8MB | 27.6MB → 107.9MB |
| Full index (`wax search index`, including process startup) | 0.87 s | 9.2 s (peak memory about 196MB) |
| Sync with no changes / sync after adding 100 records | 0.8ms / 7.9ms | 1.0ms / 6.2ms |
| CLI search `wax search 인계 --json` (including process startup) | 96ms | 99ms (peak memory about 94MB) |
| Dashboard API `GET /api/search?q=인계` (including sync, through the response JSON) | 4.8ms | 4.4ms |

First page (20 results) query, compared with a full JSONL read:

| Query | 10k: matches / JSONL / index | 100k: matches / JSONL / index |
| --- | --- | --- |
| Common Korean two characters `개발` | 6,315 / 12.3ms / 2.6ms | 63,157 / 144ms / 27.3ms |
| Rare Korean two characters `인계` | 11 / 11.5ms / 0.09ms | 101 / 138ms / 0.19ms |
| Three characters with a particle `인계를` | 11 / 11.0ms / 0.09ms | 101 / 133ms / 0.23ms |
| Rare English `handoff` | 11 / 11.2ms / 0.13ms | 101 / 124ms / 0.30ms |
| Common English `review` | 6,314 / 11.5ms / 2.9ms | 63,157 / 124ms / 34.0ms |
| Path `docs/wax/design` | 11 / 10.3ms / 0.28ms | 101 / 116ms / 0.41ms |
| SHA prefix `a1b2c3d` | 11 / 10.0ms / 0.13ms | 101 / 116ms / 0.25ms |
| Task filter `인계` + one task | 1 / 10.5ms / 0.14ms | 5 / 120ms / 0.38ms |
| Date filter `개발` + one day | 371 / 11.0ms / 2.9ms | 3,715 / 144ms / 33.5ms |

Common words with many matches sort the whole match set newest first and count up to 1,000, so they take tens of ms at 100k records. Rare words and filter combinations take under 1ms. In the browser, from when typing stops until results are drawn took about 0.8 seconds, including the 350ms input wait (fixture of 32 records, including Playwright typing). Most of the index size is the original text (a copy of the body) plus the trigram index; the two-character index is stored without content.

## Phase 2: switching the source storage (not part of this change)

The final goal is to store state and history in `.wax/wax.db` and use JSON for export and backup. This search index is the step before that and does not change the sources.

- **Boundaries**: the places that read and write sources are `workflow.mjs` (tasks), `chat/store.mjs` (JSONL appends and locks), `chat/requests.mjs` and `chat/design.mjs` (atomic JSON writes), `approvals.mjs`, `backup.mjs`, and `chat/watcher.mjs` (change detection). The safe order for the switch is to put storage adapters (`readFeature/updateFeature`, `appendRecord/readRecords`, `readJob/writeJob`) at these boundaries and verify the JSON adapter and the SQLite adapter with the same contract tests.
- **Schema versions**: the index refuses and rebuilds when `meta.schema` differs (currently 3: version 2 tracks referenced Markdown, version 3 tracks every document pointing to the same file). The source DB will have its own separate `schema_version` and step-by-step migrations, with a version lock so that an older wax refuses to write when it uses the same project.
- **Switch commands**: `wax storage migrate --dry-run` (report comparing counts and hashes) → create a backup → per-file transactional copy with recorded progress (resume after interruption) → compare the JSON sources and the DB by every record hash → mark as switched only after explicit confirmation. `init` and ordinary queries must never switch or delete automatically, and `wax storage rollback` must be able to return to the JSON sources.
- **Contracts to settle before the switch**: task revisions and conflict detection, conversation and board IDs (`m-`/`n-` sequence + random), file-content references for stage documents and evidence (`#/artifacts/…`), the backup, restore and doctor formats, concurrent writes from several CLI processes (current file locks → DB transactions), the watcher's incremental reads (file size and mtime → DB change sequence), and running alongside older CLI versions.
- **Follow-up verification**: switch dry-run with resume and rollback, refusing mixed-version concurrent runs, round-tripping large backups, Windows file locks and WAL; design outputs (images, Blender files) stay as files, with only paths and metadata in the DB.
