
let loading;

export function loadSqlite() {
  loading ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
      if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
      return original.call(this, warning, ...rest);
    };
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const probe = new DatabaseSync(':memory:');
      try {
        probe.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram'); DROP TABLE t");
        return { DatabaseSync, version: probe.prepare('SELECT sqlite_version() AS v').get().v };
      } catch {
        return { error: `이 Node.js(${process.version})의 SQLite에는 전문 검색(FTS5)이 없습니다. 검색은 Node.js 22.16 이상 또는 24 이상에서 사용할 수 있습니다.` };
      } finally { probe.close(); }
    } catch {
      return { error: `이 Node.js(${process.version})에는 node:sqlite가 없습니다. 검색은 Node.js 22.16 이상 또는 24 이상에서 사용할 수 있습니다. 다른 wax 기능은 그대로 쓸 수 있습니다.` };
    } finally { process.emitWarning = original; }
  })();
  return loading;
}
