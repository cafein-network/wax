import { t } from '../web/messages-catalog.mjs';
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { WaxError } from './workflow.mjs';
import { buildReport, readRecordText, renderDiagnose } from './diagnose.mjs';
import { escapeInvisible, rewriteJsonStrings } from './json-lines.mjs';
import { scrubContext, scrubField, scrubText } from './scrub.mjs';
import { agentTool } from './agent-tools.mjs';

const { version: WAX_VERSION } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export const BUNDLE_LEVELS = Object.freeze(['skeleton', 'evidence', 'full']);
export const BUNDLE_LIMITS = Object.freeze({ files: 2000, bytes: 256 * 1024 * 1024, issues: 20 });
export const BUNDLE_MARK = 'wax diagnose bundle';
export const OMITTED = '<omitted>';
export const SKIP_TEXT = Object.freeze({ name: 'diagnose.bundle.skip.name', noLine: 'diagnose.bundle.skip.noLine', missing: 'diagnose.bundle.skip.missing', link: 'diagnose.bundle.skip.link',
  other: 'diagnose.bundle.skip.other', truncated: 'diagnose.bundle.skip.truncated' });
const LEVEL_TEXT = { skeleton: 'diagnose.bundle.level.skeleton', evidence: 'diagnose.bundle.level.evidence', full: 'diagnose.bundle.level.full' };
export const RECORDS_DIR = 'records';
export const ZIP_ROOT = 'wax-diagnose';

const RECORD_FILES = [
  /^\.wax\/chat\/pm-loop\/goal-[a-f0-9]{8}\.jsonl?$/,
  /^\.wax\/features\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/,
  /^\.wax\/approvals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/,
  /^\.wax\/chat\/snapshots\/(?:runs|restores)\.jsonl$/,
  /^\.wax\/chat\/(?:tool-health|worktree-setup|worktrees)\.jsonl$/,
  /^\.wax\/chat\/requests\/request-[a-f0-9-]{36}\.json$/,
];
export const bundleable = (file) => typeof file === 'string' && RECORD_FILES.some((pattern) => pattern.test(file));

export const BODY_KEYS = Object.freeze(['output', 'stdout', 'stderr', 'tail', 'report', 'artifacts', 'evidence', 'details', 'excerpt', 'description', 'message', 'text', 'body', 'prompt', 'quote']);
const BODY = new Set(BODY_KEYS);
const HIDDEN_KEY = /secret|token|passw(?:or)?d/i;
const HASH_FIELDS = Object.freeze([['repeatKey'], ['checks', 'key']]);
const SHA256 = /^[0-9a-f]{64}$/;
export const hashField = (parts, value) => typeof value === 'string' && SHA256.test(value)
  && HASH_FIELDS.some((tail) => parts.length >= tail.length && tail.every((name, index) => parts[parts.length - tail.length + index] === name));
const HASH_MASK = 'sha256';
const HASH_LINE = /^(\s*"repeatKey"\s*:\s*")[0-9a-f]{64}("\s*,?\s*)$/;

const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const visible = (line) => line.replace(/[^\P{Cc}\t]|[\p{Cf}\u2028\u2029]/gu, (char) => char.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
const safeName = (name, context) => scrubText(name, context).text.replace(/[<>:"|?*\\]/g, '_');

function tally() {
  const state = { count: 0, rules: {}, omitted: 0, byFile: new Map() };
  return {
    state,
    add(file, done) {
      if (!done.count) return;
      state.count += done.count;
      for (const [id, n] of Object.entries(done.rules)) state.rules[id] = (state.rules[id] ?? 0) + n;
      state.byFile.set(file, (state.byFile.get(file) ?? 0) + done.count);
    },
    omit(file) { state.omitted += 1; state.byFile.set(file, state.byFile.get(file) ?? 0); },
  };
}

function replacer({ level, context, counts, file, counted = () => true }) {
  return (value, { parts, key, line }) => {
    if (!counted(line)) return value;
    if (!key) {
      const names = parts.filter((part) => typeof part === 'string');
      if (names.some((name) => HIDDEN_KEY.test(name)) || (level === 'skeleton' && names.some((name) => BODY.has(name)))) { counts.omit(file); return OMITTED; }
    }
    const name = typeof parts.at(-1) === 'string' && !hashField(parts, value) ? parts.at(-1) : null;
    const done = key ? scrubText(value, context) : scrubField(name, value, context);
    counts.add(file, done);
    return done.text;
  };
}

function scrubTree(value, context) {
  const rules = {};
  let count = 0;
  const walk = (item, parts) => {
    if (typeof item === 'string') {
      const name = typeof parts.at(-1) === 'string' && !hashField(parts, item) ? parts.at(-1) : null;
      const done = scrubField(name, item, context);
      count += done.count;
      for (const [id, n] of Object.entries(done.rules)) rules[id] = (rules[id] ?? 0) + n;
      return done.text;
    }
    if (Array.isArray(item)) return item.map((inner, index) => walk(inner, [...parts, index]));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [walk(key, []), walk(inner, [...parts, key])]));
    return item;
  };
  return { value: walk(value, []), count, rules };
}

function rawLine(line, { level, context, counts, file }) {
  if (level === 'skeleton') { counts.omit(file); return OMITTED; }
  const done = scrubText(line.replace(/\r$/, ''), context);
  counts.add(file, done);
  return visible(done.text);
}

async function recordCopy(root, file, { keep, pointers, level, context, counts, limits }) {
  const read = await readRecordText(root, file, limits);
  if (!read) return { skipped: 'name' };
  if (read.state) return { skipped: read.state };
  const options = { level, context, counts, file };
  if (file.endsWith('.jsonl')) {
    const lines = read.text.split('\n');
    if (read.cut) lines.pop();
    else if (lines.at(-1) === '') lines.pop();
    if (lines.length > limits.lines) lines.length = limits.lines;
    let kept = 0;
    const out = lines.map((line, index) => {
      if (!keep.has(index + 1) || !line.trim()) return '';
      kept += 1;
      try { return rewriteJsonStrings(line.replace(/\r$/, ''), replacer(options)).text; } catch { return rawLine(line, options); }
    });
    return { text: `${out.join('\n')}\n`, kept };
  }
  if (read.cut) return { skipped: 'truncated' };
  const lines = read.text.split('\n');
  if (read.text.endsWith('\n')) lines.pop();
  let wanted = new Set();
  let parsed = true;
  if (keep !== 'all') {
    try {
      const { ranges } = rewriteJsonStrings(read.text, () => undefined, { want: pointers });
      for (const [start, end] of ranges.values()) for (let line = start; line <= end; line++) wanted.add(line);
    } catch { parsed = false; }
    for (const line of keep) wanted.add(line);
  } else wanted = null;
  const has = (line) => wanted === null || wanted.has(line);
  let out;
  if (parsed) {
    try {
      out = rewriteJsonStrings(read.text, replacer({ ...options, counted: has })).text.split('\n');
      if (read.text.endsWith('\n')) out.pop();
    } catch { parsed = false; }
  }
  if (!parsed) out = lines.map((line, index) => (has(index + 1) && line.trim() ? rawLine(line, options) : line));
  let kept = 0;
  const shown = out.map((line, index) => { if (!has(index + 1)) return ''; kept += 1; return line.replace(/\r$/, ''); });
  return { text: `${shown.join('\n')}\n`, kept };
}

function citesByFile(report) {
  const map = new Map();
  const entry = (file) => { if (!map.has(file)) map.set(file, { lines: new Set(), pointers: new Set() }); return map.get(file); };
  for (const dimension of report.dimensions) {
    for (const finding of dimension.findings) {
      for (const cite of finding.cites ?? []) {
        if (typeof cite?.file !== 'string') continue;
        const item = entry(cite.file);
        if (Number.isSafeInteger(cite.line) && cite.line > 0) item.lines.add(cite.line);
        if (typeof cite.pointer === 'string' && cite.pointer) item.pointers.add(cite.pointer);
      }
    }
  }
  return map;
}

function targetRecords(ctx) {
  const docs = new Set(), lines = new Map();
  for (const goal of ctx.goals) docs.add(goal.doc.file);
  for (const feature of ctx.features) docs.add(feature.doc.file);
  for (const doc of [...ctx.approvals, ...ctx.requests]) docs.add(doc.file);
  const add = ({ file, line }) => { if (!lines.has(file)) lines.set(file, new Set()); lines.get(file).add(line); };
  for (const goal of ctx.goals) (goal.log ?? []).forEach(add);
  for (const list of [ctx.snapshots, ctx.restores, ctx.health, ctx.setup, ctx.worktrees]) list.forEach(add);
  return { docs, lines };
}

function toolsSeen(ctx) {
  const ids = new Set();
  for (const goal of ctx.goals) for (const { value } of goal.log ?? []) if (typeof value.tool === 'string' && value.tool) ids.add(value.tool);
  for (const { value } of ctx.health) if (typeof value.tool === 'string' && value.tool) ids.add(value.tool);
  return [...ids].map((id) => { try { return agentTool(id).label; } catch { return null; } }).filter(Boolean).sort();
}

async function checkTarget(root, target) {
  const roots = [...new Set([path.resolve(root), await realpath(root).catch(() => path.resolve(root))])];
  for (const base of roots) for (const name of ['.wax', '.git']) if (inside(path.join(base, name), target)) throw new WaxError(t('errors.diagnose.bundleInside', name));
}

async function freshDir(target) {
  try { await mkdir(target, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new WaxError(t('errors.diagnose.bundleExists', target), 409);
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new WaxError(t('errors.diagnose.bundleParent', path.dirname(target)));
    throw error;
  }
}

async function freshFile(file, data) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

export async function makeBundle(root, id, dir, { level = 'skeleton', keepEmail = false, since = null, limits, context, say = t } = {}) {
  if (!BUNDLE_LEVELS.includes(level)) throw new WaxError(t('errors.diagnose.level', String(level)));
  if (typeof dir !== 'string' || !dir.trim()) throw new WaxError(t('errors.diagnose.usage'));
  const target = path.resolve(dir);
  await checkTarget(root, target);
  const before = await lstat(target).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));
  if (before) throw new WaxError(t('errors.diagnose.bundleExists', target), 409);
  const parent = await stat(path.dirname(target)).catch(() => null);
  if (!parent?.isDirectory()) throw new WaxError(t('errors.diagnose.bundleParent', path.dirname(target)));
  const built = await buildReport(root, id, { since, limits, context, keepEmail });
  const scrubContextUsed = built.context;
  const counts = tally();
  const done = scrubTree(built.report, scrubContextUsed);
  counts.add('report', done);
  const emailKept = Boolean(scrubContextUsed.keepEmail);
  const report = { ...done.value, scrubbed: done.count, scrubRules: done.rules, bundle: { level, keepEmail: emailKept, records: RECORDS_DIR } };

  const cites = citesByFile(built.report);
  const target_ = level === 'full' ? targetRecords(built.ctx) : { docs: new Set(), lines: new Map() };
  const names = new Set([...cites.keys(), ...target_.docs, ...target_.lines.keys()]);
  const records = [], skipped = [];
  for (const file of [...names].sort()) {
    const cited = cites.get(file) ?? { lines: new Set(), pointers: new Set() };
    const fromTarget = target_.lines.get(file) ?? new Set();
    if (!bundleable(file)) { skipped.push({ file, reason: 'name' }); continue; }
    if (!cited.lines.size && !cited.pointers.size && !target_.docs.has(file) && !fromTarget.size) { skipped.push({ file, reason: 'noLine' }); continue; }
    const keep = target_.docs.has(file) ? 'all' : new Set([...cited.lines, ...fromTarget]);
    const copy = await recordCopy(root, file, { keep, pointers: cited.pointers, level, context: scrubContextUsed, counts, limits: built.limits });
    if (copy.skipped) { skipped.push({ file, reason: copy.skipped }); continue; }
    records.push({ path: `${RECORDS_DIR}/${safeName(file.slice('.wax/'.length), scrubContextUsed)}`, file, text: copy.text, kept: copy.kept });
  }

  const json = escapeInvisible(JSON.stringify(report, null, 2));
  const files = [
    { path: 'report.md', text: renderDiagnose(report, say) },
    { path: 'report.json', text: `${json}\n` },
    ...records.map((item) => ({ path: item.path, text: item.text })),
  ];
  const state = counts.state;
  const scrubLog = [say('diagnose.bundle.log.title'), say('diagnose.bundle.log.noValues'), '',
    say('diagnose.bundle.log.total', state.count, state.omitted), '',
    say('diagnose.bundle.log.byRule'), ...(Object.keys(state.rules).length ? Object.entries(state.rules).sort(([a], [b]) => a.localeCompare(b)).map(([rule, n]) => `  ${rule}\t${n}`) : [`  ${say('diagnose.bundle.log.none')}`]), '',
    say('diagnose.bundle.log.byFile'), `  report.md, report.json\t${state.byFile.get('report') ?? 0}`,
    ...records.map((item) => `  ${item.path}\t${state.byFile.get(item.file) ?? 0}`), ''].join('\n');
  const tools = toolsSeen(built.ctx);
  const readme = [BUNDLE_MARK, '', say('diagnose.bundle.readme.intro'), '',
    say(built.report.target.kind === 'goal' ? 'diagnose.bundle.readme.targetGoal' : 'diagnose.bundle.readme.targetFeature', report.target.id, (report.target.kind === 'goal' ? report.target.features : report.target.goals).join(', ') || '-'),
    say('diagnose.bundle.readme.level', level, say(LEVEL_TEXT[level])),
    ...(report.since ? [say('diagnose.since', report.since)] : []),
    say('diagnose.bundle.readme.versions', WAX_VERSION, `${platform()} ${arch()} ${release()}`, process.version),
    say('diagnose.bundle.readme.tools', tools.join(', ') || '-'),
    say(emailKept ? 'diagnose.bundle.readme.emailKept' : 'diagnose.bundle.readme.emailScrubbed'), '',
    say('diagnose.bundle.readme.files'),
    `  report.md — ${say('diagnose.bundle.readme.reportMd')}`,
    `  report.json — ${say('diagnose.bundle.readme.reportJson')}`,
    `  ${RECORDS_DIR}/ — ${say('diagnose.bundle.readme.records', records.length)}`,
    `  scrub-log.txt — ${say('diagnose.bundle.readme.scrubLog')}`,
    `  files.txt — ${say('diagnose.bundle.readme.filesTxt')}`, '',
    say('diagnose.bundle.readme.omitted', OMITTED),
    say('diagnose.bundle.readme.never'),
    ...(skipped.length ? ['', say('diagnose.bundle.readme.skipped'), ...skipped.map((item) => `  ${safeName(item.file, scrubContextUsed)} — ${say(SKIP_TEXT[item.reason])}`)] : []), '',
    say('diagnose.bundle.review'), say('diagnose.bundle.readme.zip'), ''].join('\n');
  files.push({ path: 'scrub-log.txt', text: scrubLog }, { path: 'README.txt', text: readme });
  const sized = files.map((item) => ({ ...item, data: Buffer.from(item.text, 'utf8') }));
  const list = [say('diagnose.bundle.filesTitle'), ...sized.map((item) => `${item.data.length}\t${item.path}`), `-\tfiles.txt`, ''].join('\n');
  sized.push({ path: 'files.txt', data: Buffer.from(list, 'utf8') });
  const total = sized.reduce((sum, item) => sum + item.data.length, 0);
  if (sized.length > BUNDLE_LIMITS.files || total > BUNDLE_LIMITS.bytes) throw new WaxError(t('errors.diagnose.bundleTooLarge', sized.length, Math.round(total / 1024 / 1024)));

  await freshDir(target);
  const made = new Set(['']);
  for (const item of sized.sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = item.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const sub = parts.slice(0, index).join('/');
      if (made.has(sub)) continue;
      await mkdir(path.join(target, ...parts.slice(0, index)), { mode: 0o700 });
      made.add(sub);
    }
    await freshFile(path.join(target, ...parts), item.data);
  }
  return { dir: target, level, files: sized.map((item) => ({ path: item.path, bytes: item.data.length })), scrubbed: state.count, rules: state.rules, omitted: state.omitted, skipped };
}


async function walk(dir, limits) {
  const files = [], problems = [];
  let bytes = 0;
  async function visit(abs, rel) {
    for (const name of (await readdir(abs)).sort()) {
      const childAbs = path.join(abs, name), childRel = rel ? `${rel}/${name}` : name;
      const info = await lstat(childAbs);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) { problems.push(childRel); continue; }
      if (info.isDirectory()) { await visit(childAbs, childRel); continue; }
      files.push({ rel: childRel, abs: childAbs, size: info.size });
      bytes += info.size;
      if (files.length > limits.files || bytes > limits.bytes) throw new WaxError(t('errors.diagnose.bundleTooLarge', files.length, Math.round(bytes / 1024 / 1024)));
    }
  }
  await visit(dir, '');
  return { files, problems };
}

function hashesMasked(file, text) {
  const mask = (value, { parts, key }) => (!key && hashField(parts, value) ? HASH_MASK : undefined);
  const lineMask = (line) => line.replace(HASH_LINE, `$1${HASH_MASK}$2`);
  const parsed = (piece) => { try { return rewriteJsonStrings(piece, mask).text; } catch { return null; } };
  if (file.endsWith('.jsonl')) return text.split('\n').map((line) => (line.trim() ? parsed(line.replace(/\r$/, '')) ?? lineMask(line) : line)).join('\n');
  if (file.endsWith('.json')) return parsed(text) ?? text.split('\n').map(lineMask).join('\n');
  return text;
}

export function recheckText(file, text, context) {
  const found = [];
  hashesMasked(file, text).split('\n').forEach((line, index) => {
    const done = scrubText(line, context);
    const rules = Object.keys(done.rules).filter((rule) => !(rule === 'email' && context.keepEmail));
    if (rules.length) found.push({ file, line: index + 1, rules: rules.sort() });
  });
  return found;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) c = CRC_TABLE[(c ^ buffer[index]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

export function buildZip(entries, now = new Date()) {
  const { time, date } = dosTime(now);
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

export async function zipBundle(root, dir, { keepEmail = false, context, now = new Date(), limits = BUNDLE_LIMITS } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new WaxError(t('errors.diagnose.usage'));
  const target = path.resolve(dir);
  const info = await lstat(target).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new WaxError(t('errors.diagnose.zipNotBundle', target));
  const readme = await lstat(path.join(target, 'README.txt')).catch(() => null);
  const head = readme?.isFile() ? (await readFile(path.join(target, 'README.txt'), 'utf8')).split('\n', 1)[0].replace(/\r$/, '') : '';
  if (head !== BUNDLE_MARK) throw new WaxError(t('errors.diagnose.zipNotBundle', target));
  const zipPath = `${target}.zip`;
  if (await lstat(zipPath).then(() => true, () => false)) throw new WaxError(t('errors.diagnose.zipExists', zipPath), 409);
  const { files, problems } = await walk(target, limits);
  if (problems.length) throw new WaxError(t('errors.diagnose.zipLink', problems.slice(0, limits.issues).join(', ')));
  const scrub = context ?? scrubContext({ roots: [root, await realpath(root).catch(() => root)], keepEmail });
  const entries = [], found = [];
  for (const file of files) {
    const data = await readFile(file.abs);
    found.push(...recheckText(file.rel, data.toString('utf8'), scrub));
    entries.push({ name: `${ZIP_ROOT}/${file.rel}`, data });
  }
  if (found.length) {
    const shown = found.slice(0, limits.issues).map((item) => `${item.file}:${item.line} ${item.rules.join(',')}`).join('; ');
    throw new WaxError(t('errors.diagnose.zipFound', found.length, shown), 409);
  }
  const zip = buildZip(entries, now);
  try { await freshFile(zipPath, zip); } catch (error) {
    if (error.code === 'EEXIST') throw new WaxError(t('errors.diagnose.zipExists', zipPath), 409);
    throw error;
  }
  return { zip: zipPath, files: files.map((file) => ({ path: file.rel, bytes: file.size })), bytes: zip.length };
}
