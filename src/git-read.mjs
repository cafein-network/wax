import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

export const GIT_READ_LIMITS = { concurrency: 4, timeout: 5000, statusTimeout: 10_000, buffer: 8 * 1024 * 1024 };
export const GIT_BASE_ARGS = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
export const SCRATCH_PREFIX = 'wax-git-';
const HIDDEN = /[\0\p{Cc}]/u;

const STRIP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
export function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (STRIP.includes(key.toUpperCase())) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...extra };
}

export const defaultTimeout = (args, limits = GIT_READ_LIMITS) => (args.find((arg) => !arg.startsWith('-')) === 'status' ? limits.statusTimeout : limits.timeout);

export function runGit(cwd, args, { input = '', timeout = defaultTimeout(args), env = {}, encoding = 'utf8', maxBuffer = GIT_READ_LIMITS.buffer, signal = null, file = 'git', base = GIT_BASE_ARGS } = {}) {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('git aborted'), { aborted: true })); return; }
    const child = execFile(file, [...base, ...args], { cwd, encoding, timeout, maxBuffer, windowsHide: true, env: gitEnv(env), ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          if (error.name === 'AbortError' || signal?.aborted) reject(Object.assign(new Error('git aborted'), { aborted: true }));
          else if (error.killed || error.code === 'ETIMEDOUT') reject(Object.assign(new Error(`git ${args[0] ?? ''} timed out`), { timedOut: true }));
          else reject(Object.assign(error, { stderr: String(stderr ?? '') }));
          return;
        }
        done({ code: error ? error.code : 0, stdout, stderr: String(stderr ?? '') });
      });
    child.stdin?.on('error', () => {   });
    child.stdin?.end(input);
  });
}

export function createGitReader({ concurrency = GIT_READ_LIMITS.concurrency, run = runGit, pipeRun = runPipe, limits = GIT_READ_LIMITS } = {}) {
  const queue = [];
  let active = 0, peak = 0, started = 0, order = 0;
  const pump = () => {
    while (active < concurrency && queue.length) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) {
        const a = queue[i], b = queue[best];
        if (a.network !== b.network ? !a.network : a.priority !== b.priority ? a.priority < b.priority : a.order < b.order) best = i;
      }
      const job = queue[best];
      if (job.signal?.aborted) { queue.splice(best, 1); job.reject(Object.assign(new Error('git aborted'), { aborted: true })); continue; }
      const weight = Math.min(job.weight, concurrency);
      if (active + weight > concurrency) break;
      queue.splice(best, 1);
      active += weight; started++; peak = Math.max(peak, active);
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active -= weight; pump(); });
    }
  };
  const schedule = (fn, { priority = 0, network = false, signal = null, weight = 1 } = {}) => new Promise((resolve, reject) => {
    queue.push({ fn, priority, network, signal, weight, order: order++, resolve, reject });
    pump();
  });
  const git = (cwd, args, { priority = 0, network = false, scratch = null, index = null, timeout, signal = null, env: extra = {}, ...rest } = {}) => {
    const env = { ...Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => !STRIP.includes(key.toUpperCase()))), ...scratchEnv(scratch, index) };
    return schedule(() => run(cwd, args, { ...rest, timeout: timeout ?? defaultTimeout(args, limits), env, signal }), { priority, network, signal });
  };
  const text = async (cwd, args, { ok = [0], ...options } = {}) => {
    const result = await git(cwd, args, options);
    if (!ok.includes(result.code)) throw Object.assign(new Error(String(result.stderr).trim() || `git ${args[0]} exited ${result.code}`), { code: result.code, stderr: result.stderr });
    return result.stdout;
  };
  const pipe = (cwd, first, second, { priority = 0, scratch = null, index = null, timeout, signal = null, env: extra = {}, ...rest } = {}) => {
    const env = { ...Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => !STRIP.includes(key.toUpperCase()))), ...scratchEnv(scratch, index) };
    return schedule(() => pipeRun(cwd, first, second, { ...rest, timeout: timeout ?? limits.timeout, env, signal }), { priority, signal, weight: 2 });
  };
  return { git, text, pipe, schedule, stats: () => ({ active, peak, started, queued: queue.length }), concurrency };
}

export function runPipe(cwd, first, second, { input = '', timeout = GIT_READ_LIMITS.timeout, env = {}, maxBuffer = GIT_READ_LIMITS.buffer, signal = null, file = 'git', base = GIT_BASE_ARGS } = {}) {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('git aborted'), { aborted: true })); return; }
    const options = { cwd, windowsHide: true, shell: false, env: gitEnv(env) };
    const a = spawn(file, [...base, ...first], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    const b = spawn(file, [...base, ...second], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errors = '', size = 0, finished = false, firstCode = null, secondCode = null;
    const finish = (error) => {
      if (finished) return;
      if (!error && (firstCode === null || secondCode === null)) return;
      finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (error) { a.kill(); b.kill(); reject(error); return; }
      done({ code: secondCode, stdout: out, stderr: errors, firstCode });
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(`git ${first[0] ?? ''} timed out`), { timedOut: true })), timeout);
    const onAbort = () => finish(Object.assign(new Error('git aborted'), { aborted: true }));
    signal?.addEventListener('abort', onAbort, { once: true });
    a.on('error', (error) => finish(error));
    b.on('error', (error) => finish(error));
    a.stdout.pipe(b.stdin);
    b.stdin.on('error', () => {   });
    a.stdin.on('error', () => {});
    a.stderr.on('data', (chunk) => { if (errors.length < 4000) errors += chunk; });
    b.stderr.on('data', (chunk) => { if (errors.length < 4000) errors += chunk; });
    b.stdout.setEncoding('utf8');
    b.stdout.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBuffer) { finish(Object.assign(new Error('git output too large'), { tooLarge: true })); return; }
      out += chunk;
    });
    a.on('close', (code) => { firstCode = code ?? -1; finish(); });
    b.on('close', (code) => { secondCode = code ?? -1; finish(); });
    a.stdin.end(input);
  });
}

function scratchEnv(scratch, index) {
  if (!scratch) {
    if (index) throw new Error('a temporary index needs a scratch folder');
    return {};
  }
  const env = { GIT_OBJECT_DIRECTORY: scratch.objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.alternates };
  if (index) {
    const rel = relative(scratch.dir, resolve(index));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('the temporary index must be inside the scratch folder');
    env.GIT_INDEX_FILE = resolve(index);
  }
  return env;
}

const readers = new Map();
export function projectReader(root) {
  const key = resolve(root);
  if (!readers.has(key)) readers.set(key, createGitReader());
  return readers.get(key);
}

export async function withScratch(cwd, fn, { reader = createGitReader({ concurrency: 1 }), priority = 0, signal = null } = {}) {
  const common = String(await reader.text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { priority, signal })).trim();
  if (!common || !isAbsolute(common) || common.includes(delimiter) || HIDDEN.test(common)) throw new Error('git common dir is not usable');
  const dir = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
  try {
    const objects = join(dir, 'objects');
    await mkdir(objects);
    let count = 0;
    const handle = {
      dir, objects, alternates: join(common, 'objects'),
      async index(from = null) {
        const path = join(dir, `index-${++count}`);
        if (from) {
          let info = null;
          try { info = await lstat(from); } catch {   }
          if (info?.isFile() && !info.isSymbolicLink()) {
            await copyFile(from, path);
            await utimes(path, info.atime, info.mtime);
          }
        }
        return path;
      },
    };
    return await fn(handle);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}


const hashName = (oid) => (String(oid).length === 64 ? 'sha256' : 'sha1');
const objectId = (algo, type, body) => createHash(algo).update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest('hex');
export const emptyBlobId = (like) => objectId(hashName(like), 'blob', Buffer.alloc(0));

function canonicalMode(mode) {
  const value = parseInt(mode, 8);
  const type = value & 0o170000;
  if (type === 0o040000) return '40000';
  if (type === 0o120000) return '120000';
  if (type === 0o160000) return '160000';
  return value & 0o100 ? '100755' : '100644';
}
function parseTree(body, size) {
  const out = new Map();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at), nul = body.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 1 + size > body.length) throw new Error('bad tree object');
    out.set(body.subarray(space + 1, nul).toString('latin1'), { mode: canonicalMode(body.subarray(at, space).toString('latin1')), oid: body.subarray(nul + 1, nul + 1 + size).toString('hex') });
    at = nul + 1 + size;
  }
  return out;
}
function treeBody(entries) {
  const key = ([name, item]) => (item.mode === '40000' ? `${name}/` : name);
  const sorted = [...entries].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  return Buffer.concat(sorted.flatMap(([name, item]) => [Buffer.from(`${item.mode} `), Buffer.from(name, 'latin1'), Buffer.from([0]), Buffer.from(item.oid, 'hex')]));
}
function parseBatch(out) {
  const found = new Map();
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    const [oid, type, size] = out.subarray(at, end).toString('latin1').split(' ');
    if (type === 'missing' || size === undefined) { found.set(oid, null); at = end + 1; continue; }
    const length = Number(size);
    found.set(oid, out.subarray(end + 1, end + 1 + length));
    at = end + 1 + length + 1;
  }
  return found;
}
const missingOf = (text) => new Set(String(text).split('\n').map((row) => row.trim().split(' ')).filter((parts) => parts[1] === 'missing').map((parts) => parts[0]));

export async function scratchTree(run, { base, paths, index, objects }) {
  const plain = ['-c', 'core.splitIndex=false', '-c', 'core.untrackedCache=false'];
  const input = `${paths.join('\0')}\0`;
  await run([...plain, 'read-tree', base], { index });
  await run([...plain, 'update-index', '--add', '--remove', '--info-only', '-z', '--stdin'], { index, input });
  const parts = Buffer.from(await run(['diff-index', '--cached', '-z', '--no-renames', '--ignore-submodules=none', base, '--'], { index, binary: true })).toString('latin1').split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i].startsWith(':')) break;
    const [, newMode, , newOid, status] = parts[i].slice(1).split(' ');
    changes.push({ path: parts[i + 1], mode: newMode, oid: newOid, gone: status.startsWith('D') });
  }
  const root = String(await run(['rev-parse', '--verify', '-q', `${base}^{tree}`], {})).trim();
  if (!changes.length) return root;
  const algo = hashName(root), size = algo === 'sha256' ? 32 : 20;
  const blobs = changes.filter((change) => !change.gone && change.mode !== '160000');
  if (blobs.length) {
    const check = (oids) => run(['cat-file', '--batch-check'], { input: `${[...new Set(oids)].join('\n')}\n` }).then(missingOf);
    const missing = await check(blobs.map((change) => change.oid));
    if (missing.size) {
      const write = `${index}.blobs`;
      const latin = blobs.filter((change) => missing.has(change.oid)).map((change) => Buffer.from(change.path, 'latin1'));
      await run([...plain, 'read-tree', base], { index: write });
      await run([...plain, 'update-index', '--add', '-z', '--stdin'], { index: write, input: Buffer.concat(latin.flatMap((path) => [path, Buffer.from([0])])) });
      if ((await check([...missing])).size) throw new Error('worktree files changed while making the temporary tree');
    }
  }
  const dirs = new Map([['', new Map()]]);
  for (const change of changes) {
    const names = change.path.split('/');
    for (let depth = 1; depth < names.length; depth++) { const dir = names.slice(0, depth).join('/'); if (!dirs.has(dir)) dirs.set(dir, new Map()); }
    dirs.get(names.slice(0, -1).join('/')).set(names.at(-1), change.gone ? null : { mode: change.mode, oid: change.oid });
  }
  const baseEntries = new Map();
  const order = [...dirs.keys()].sort((a, b) => (a ? a.split('/').length : 0) - (b ? b.split('/').length : 0));
  const treeOf = new Map([['', root]]);
  for (let depth = 0, rest = order; rest.length; depth++) {
    const level = rest.filter((dir) => (dir ? dir.split('/').length : 0) === depth);
    rest = rest.filter((dir) => (dir ? dir.split('/').length : 0) > depth);
    for (const dir of level) {
      if (!dir) continue;
      const cut = dir.lastIndexOf('/'), parent = cut < 0 ? '' : dir.slice(0, cut), name = dir.slice(cut + 1);
      const item = baseEntries.get(parent)?.get(name);
      if (item?.mode === '40000') treeOf.set(dir, item.oid);
    }
    const wanted = level.filter((dir) => treeOf.has(dir));
    if (wanted.length) {
      const bodies = parseBatch(Buffer.from(await run(['cat-file', '--batch'], { input: `${[...new Set(wanted.map((dir) => treeOf.get(dir)))].join('\n')}\n`, binary: true })));
      for (const dir of wanted) {
        const body = bodies.get(treeOf.get(dir));
        if (!body) throw new Error('base tree is missing');
        baseEntries.set(dir, parseTree(body, size));
      }
    }
  }
  const made = new Map(), bodies = new Map();
  for (const dir of [...order].reverse()) {
    const entries = new Map(baseEntries.get(dir) ?? []);
    for (const [name, item] of dirs.get(dir)) { if (item) entries.set(name, item); else entries.delete(name); }
    for (const [child, oid] of made) {
      const cut = child.lastIndexOf('/');
      if ((cut < 0 ? '' : child.slice(0, cut)) !== dir) continue;
      const name = child.slice(cut + 1);
      if (oid) entries.set(name, { mode: '40000', oid });
      else if (entries.get(name)?.mode === '40000') entries.delete(name);
    }
    if (!entries.size && dir) { made.set(dir, null); continue; }
    const body = treeBody(entries);
    const oid = objectId(algo, 'tree', body);
    bodies.set(oid, body);
    made.set(dir, oid);
  }
  const missing = await run(['cat-file', '--batch-check'], { input: `${[...bodies.keys()].join('\n')}\n` }).then(missingOf);
  for (const oid of missing) {
    const body = bodies.get(oid);
    if (!body) continue;
    await mkdir(join(objects, oid.slice(0, 2)), { recursive: true });
    await writeFile(join(objects, oid.slice(0, 2), oid.slice(2)), deflateSync(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body])), { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  }
  return made.get('');
}

export async function readGitVersion(reader, cwd) {
  try { return String(await reader.text(cwd, ['--version'])).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null; } catch { return null; }
}
export function gitAtLeast(version, [major, minor]) {
  const [a, b] = String(version ?? '').split('.').map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return a > major || (a === major && b >= minor);
}
