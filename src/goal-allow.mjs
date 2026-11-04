import { t } from '../web/messages-catalog.mjs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { PHASES, WaxError } from './workflow.mjs';

export const ALLOW_KINDS = ['wax', 'test', 'write', 'read'];
export const ALLOW_LIMITS = { test: 500, command: 4000, evidence: 2000, offers: 500 };
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
const META = /[;&|<>$`\\(){}[\]*?~!#^\n\r\t]/;
const GOAL = /^goal-[a-f0-9]{8}$/;
const FEATURE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHELLS = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh$/;
const fail = (id, status = 400, ...values) => new WaxError(t(id, ...values), status);
export const allowKindText = (kind) => ({ wax: t('goalAllow.kind.wax'), test: t('goalAllow.kind.test'), write: t('goalAllow.kind.write'), read: t('goalAllow.kind.read') })[kind] ?? kind;

export function allowKinds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > ALLOW_KINDS.length) throw fail('errors.goalAllow.kinds', 400, ALLOW_KINDS.join(', '));
  for (const kind of value) if (!ALLOW_KINDS.includes(kind)) throw fail('errors.goalAllow.kinds', 400, ALLOW_KINDS.join(', '));
  if (new Set(value).size !== value.length) throw fail('errors.goalAllow.kinds', 400, ALLOW_KINDS.join(', '));
  return ALLOW_KINDS.filter((kind) => value.includes(kind));
}

export function testCommand(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > ALLOW_LIMITS.test || HIDDEN.test(value)) throw fail('errors.goalAllow.test', 400, ALLOW_LIMITS.test);
  return value.trim();
}

export function parseAllow(input) {
  if (input === undefined || input === null) return { kinds: [], test: '' };
  if (typeof input !== 'object' || Array.isArray(input)) throw fail('errors.goalAllow.kinds', 400, ALLOW_KINDS.join(', '));
  for (const key of Object.keys(input)) if (!['kinds', 'test'].includes(key)) throw fail('errors.goalAllow.kinds', 400, ALLOW_KINDS.join(', '));
  const kinds = allowKinds(input.kinds), test = testCommand(input.test);
  if (kinds.includes('test') && !test) throw fail('errors.goalAllow.testEmpty');
  if (kinds.includes('test') && !shellWords(test)) throw fail('errors.goalAllow.testShell');
  return { kinds, test };
}


export function shellWords(command, { strict = true, known = null } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > ALLOW_LIMITS.command) return null;
  if (/[\p{Cf}\0]/u.test(command)) return null;
  const out = [];
  let word = null;
  for (let i = 0; i < command.length;) {
    const c = command[i];
    if (c === ' ') { if (word !== null) { out.push(word); word = null; } i++; continue; }
    const option = word === null && known && out.length && Object.hasOwn(known, out.at(-1)) ? known[out.at(-1)] : null;
    const spelling = option && [...option.spellings].sort((a, b) => b.length - a.length)
      .find((item) => item && command.startsWith(item, i) && (i + item.length === command.length || command[i + item.length] === ' '));
    if (spelling) { out.push(option.mark); i += spelling.length; continue; }
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end < 0) return null;
      const part = command.slice(i + 1, end);
      if ((strict || c === '"') && META.test(part)) return null;
      word = (word ?? '') + part; i = end + 1; continue;
    }
    if (META.test(c)) return null;
    word = (word ?? '') + c; i++;
  }
  if (word !== null) out.push(word);
  return out.length ? out : null;
}

export function unwrapShell(command) {
  const words = shellWords(command, { strict: false });
  if (words?.length === 3 && SHELLS.test(words[0]) && ['-c', '-lc'].includes(words[1])) return words[2];
  return command;
}


const inside = (parent, child) => child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

export async function realTarget(path) {
  let current = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(await realpath(current), ...rest.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      try { await lstat(current); return null; } catch (missing) { if (missing.code !== 'ENOENT') return null; }
      const parent = dirname(current);
      if (parent === current) return null;
      rest.push(basename(current)); current = parent;
    }
  }
}

async function tmpDir(root) {
  const dir = join(root, '.wax', 'tmp');
  try { return (await realpath(dir)) === dir ? dir : null; } catch { return null; }
}

export async function inTmp(root, path, base = root) {
  if (typeof path !== 'string' || !path || HIDDEN.test(path)) return false;
  const tmp = await tmpDir(root);
  if (!tmp) return false;
  const lexical = resolve(base, path);
  if (!inside(tmp, lexical)) return false;
  const real = await realTarget(lexical);
  return Boolean(real && inside(tmp, real));
}

export const excludedPath = (rel) => {
  const parts = rel.split(sep);
  return parts.includes('.git') || (parts[0] === '.wax' && parts[1] === 'chat') || parts.some((part) => part.startsWith('.env'));
};

export async function readable(root, path, base = root) {
  if (typeof path !== 'string' || !path || HIDDEN.test(path)) return false;
  const lexical = resolve(base, path);
  if (!inside(root, lexical) || excludedPath(relative(root, lexical))) return false;
  const real = await realTarget(lexical);
  return Boolean(real && inside(root, real) && !excludedPath(relative(root, real)));
}


export function requestShape(request) {
  if (!request || typeof request !== 'object') return null;
  if (request.tool === 'claude') {
    const input = request.details?.input;
    const name = request.details?.tool_name;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (name === 'Bash') {
      if (Object.keys(input).some((key) => !['command', 'description', 'timeout'].includes(key)) || typeof input.command !== 'string') return null;
      return { type: 'command', command: input.command, cwd: null };
    }
    if (['Write', 'Edit', 'MultiEdit'].includes(name)) return typeof input.file_path === 'string' ? { type: 'write', paths: [input.file_path], cwd: null } : null;
    if (name === 'Read') return typeof input.file_path === 'string' ? { type: 'read', paths: [input.file_path], cwd: null } : null;
    return null;
  }
  if (request.tool === 'codex') {
    const p = request.details ?? {}, item = request.item ?? p.item ?? {};
    if (request.method === 'item/commandExecution/requestApproval') {
      if (p.networkApprovalContext) return null;
      const command = p.command ?? item.command;
      const cwd = p.cwd ?? item.cwd;
      if (typeof command !== 'string' || typeof cwd !== 'string') return null;
      return { type: 'command', command, cwd };
    }
    if (request.method === 'item/fileChange/requestApproval') {
      if (p.grantRoot != null) return null;
      const changes = item.changes;
      const list = Array.isArray(changes) ? changes : changes && typeof changes === 'object' ? Object.entries(changes).map(([path, change]) => ({ path, kind: change?.kind ?? change?.type })) : null;
      if (!list?.length || list.length > 100) return null;
      const paths = [];
      for (const change of list) {
        const kind = typeof change?.kind === 'string' ? change.kind : change?.kind?.type;
        if (typeof change?.path !== 'string' || !['add', 'update'].includes(kind) || change.kind?.move_path || change.move_path) return null;
        paths.push(change.path);
      }
      return { type: 'write', paths, cwd: typeof (p.cwd ?? item.cwd) === 'string' ? p.cwd ?? item.cwd : null };
    }
  }
  return null;
}


export function leadingCli(command, cli) {
  if (typeof command !== 'string' || typeof cli !== 'string' || !cli) return command;
  const spell = (path) => [
    ...[...new Set([path, path.replaceAll('\\', '\\\\'), path.replaceAll('\\', '/')])].flatMap((item) => [`"${item}"`, ...(/[\s"]/.test(item) ? [] : [item])]),
    ...[...new Set([path, path.replaceAll('\\', '/')])].filter((item) => !item.includes("'")).map((item) => `'${item}'`),
  ];
  const clis = spell(cli), nodes = ['node', ...spell(process.execPath)];
  const line = command.trimStart();
  for (const lead of [...nodes.flatMap((node) => clis.map((item) => `${node} ${item}`)), ...clis]) {
    if (line === lead || line.startsWith(`${lead} `)) return `wax${line.slice(lead.length)}`;
  }
  return command;
}

export function pathSpellings(path, platform = process.platform) {
  if (platform !== 'win32' || typeof path !== 'string' || !path || HIDDEN.test(path) || !win32.isAbsolute(path)) return [];
  const doubled = path.replaceAll('\\', '\\\\'), slash = path.replaceAll('\\', '/');
  const out = [];
  if (!/["$`]/.test(path)) {
    if (!path.includes('\\\\') && !path.endsWith('\\')) out.push(`"${path}"`);
    out.push(`"${doubled}"`, `"${slash}"`);
  }
  if (!path.includes("'")) out.push(`'${path}'`, `'${slash}'`);
  const bare = (item) => !/[\s'"]/.test(item) && !item.startsWith('~') && !META.test(item.replaceAll('\\', '').replaceAll('~', ''));
  for (const item of [doubled, slash]) if (bare(item)) out.push(item);
  return [...new Set(out)];
}
const KNOWN_PROJECT = '\0project', KNOWN_WORKTREE = '\0worktree';
function knownPaths(ctx, { worktree = false } = {}) {
  const project = [...new Set([ctx.root, ctx.givenRoot])].flatMap((path) => pathSpellings(path, ctx.platform));
  const worktrees = worktree && Array.isArray(ctx.worktrees) ? ctx.worktrees.flatMap((path) => pathSpellings(path, ctx.platform)) : [];
  if (!project.length && !worktrees.length) return null;
  return { '--project': { spellings: project, mark: KNOWN_PROJECT }, ...(worktrees.length ? { '--worktree': { spellings: worktrees, mark: KNOWN_WORKTREE } } : {}) };
}

function waxArgs(words, ctx) {
  if (words[0] === 'wax') return words.slice(1);
  if ((words[0] === 'node' || words[0] === process.execPath) && words[1] === ctx.cli) return words.slice(2);
  if (words[0] === ctx.cli) return words.slice(1);
  return null;
}

function options(words, allowed) {
  const out = {};
  for (let i = 0; i < words.length; i += 2) {
    const name = words[i], value = words[i + 1];
    if (typeof name !== 'string' || !name.startsWith('--') || !allowed.includes(name.slice(2)) || Object.hasOwn(out, name.slice(2))) return null;
    if (typeof value !== 'string' || !value || value.startsWith('-')) return null;
    out[name.slice(2)] = value;
  }
  return out;
}

const REVISION = /^[1-9][0-9]{0,8}$/;
const PROOFS = /^[A-Za-z0-9_-]{1,80}(?:,[A-Za-z0-9_-]{1,80}){0,19}$/;
const VERDICT = /^[a-z][a-z-]{0,30}$/;

async function sameProject(value, ctx) {
  if (value === KNOWN_PROJECT) return true;
  if (typeof value !== 'string' || !value || HIDDEN.test(value) || !isAbsolute(value)) return false;
  try { return (await realpath(value)) === ctx.root; } catch { return false; }
}
async function ownWorktree(value, ctx) {
  if (value === KNOWN_WORKTREE) return Array.isArray(ctx.worktrees) && ctx.worktrees.length > 0;
  if (typeof value !== 'string' || !value || HIDDEN.test(value) || !isAbsolute(value) || !Array.isArray(ctx.worktrees) || !ctx.worktrees.length) return false;
  try { return ctx.worktrees.includes(await realpath(value)); } catch { return false; }
}
function ownRunFolder(given, real, ctx) {
  if (typeof given !== 'string' || !given || HIDDEN.test(given) || !isAbsolute(given) || !literalFolder(given, real, ctx.platform)) return false;
  return Boolean(ctx.cwd) && real === ctx.cwd && real !== ctx.root && Array.isArray(ctx.worktrees) && ctx.worktrees.includes(real);
}
export function literalFolder(given, real, platform = process.platform) {
  if (typeof given !== 'string' || typeof real !== 'string' || !given || !real) return false;
  if (platform === 'win32') return win32.isAbsolute(given) && win32.isAbsolute(real) && win32.resolve(given).toLowerCase() === win32.resolve(real).toLowerCase();
  return posix.isAbsolute(given) && posix.isAbsolute(real) && posix.resolve(given) === real;
}
function leadingProject(args) {
  if (args[0] !== '--project') return { args, project: undefined };
  if (args.length < 2 || args.slice(2).includes('--project')) return null;
  return { args: args.slice(2), project: args[1] };
}

async function matchWax(command, ctx) {
  const words = shellWords(leadingCli(command, ctx.cli), { known: knownPaths(ctx) });
  const all = words && waxArgs(words, ctx);
  if (!all?.length) return false;
  const lead = leadingProject(all);
  if (!lead || !lead.args.length) return false;
  const [sub, ...rest] = lead.args;
  const base = ctx.cwd ?? ctx.root;
  const project = async (values) => {
    if (lead.project !== undefined && values?.project !== undefined) return false;
    const value = lead.project ?? values?.project;
    return value === undefined || sameProject(value, ctx);
  };
  if (sub === 'status') {
    if (rest[0] !== ctx.feature) return false;
    const values = options(rest.slice(1), ['project']);
    return Boolean(values) && project(values);
  }
  if (sub !== 'save' && sub !== 'complete') return false;
  if (rest[0] !== ctx.phase || rest[1] !== ctx.feature) return false;
  if (sub === 'save') {
    const values = options(rest.slice(2), ['file', 'revision', 'project']);
    if (!values?.file || (values.revision && !REVISION.test(values.revision))) return false;
    return await project(values) && inTmp(ctx.root, values.file, base);
  }
  const values = options(rest.slice(2), ['author', 'evidence', 'verdict', 'revision', 'proofs', 'checks-file', 'project']);
  if (!values || values.author !== ctx.author) return false;
  if (values.revision && !REVISION.test(values.revision)) return false;
  if (values.proofs && !PROOFS.test(values.proofs)) return false;
  if (values.verdict && !VERDICT.test(values.verdict)) return false;
  if (values.evidence && values.evidence.length > ALLOW_LIMITS.evidence) return false;
  if (values['checks-file'] && !await inTmp(ctx.root, values['checks-file'], base)) return false;
  return project(values);
}

async function matchTest(command, ctx) {
  const test = ctx.test;
  if (!test) return false;
  const line = command.trim();
  if (!shellWords(test)) return false;
  const at = line.indexOf(' -- ');
  if (at < 0 || line.slice(at + 4).trim() !== test) return false;
  const words = shellWords(leadingCli(line.slice(0, at), ctx.cli), { known: knownPaths(ctx, { worktree: true }) });
  const all = words && waxArgs(words, ctx);
  const lead = all && leadingProject(all);
  const args = lead?.args;
  if (!args || args[0] !== 'test' || args[1] !== ctx.feature) return false;
  const values = options(args.slice(2), ['revision', 'author', 'project', 'worktree']);
  if (!values || (values.revision && !REVISION.test(values.revision)) || (values.author && values.author !== ctx.author)) return false;
  if (lead.project !== undefined && values.project !== undefined) return false;
  const project = lead.project ?? values.project;
  if (project !== undefined && !await sameProject(project, ctx)) return false;
  return values.worktree === undefined || ownWorktree(values.worktree, ctx);
}

export async function matchAllow(request, kinds, context) {
  const shape = requestShape(request);
  if (!shape || !kinds?.length || !FEATURE.test(context.feature ?? '') || !PHASES.includes(context.phase)) return null;
  let ctx;
  try { ctx = { ...context, root: await realpath(context.root), givenRoot: context.root, platform: context.platform ?? process.platform, cwd: context.cwd ? await realpath(context.cwd) : undefined }; } catch { return null; }
  if (shape.cwd !== null) {
    let cwd;
    try { cwd = await realpath(shape.cwd); } catch { return null; }
    if (cwd !== ctx.root && !ownRunFolder(shape.cwd, cwd, ctx)) return null;
    ctx = { ...ctx, cwd };
  }
  if (shape.type === 'command') {
    const inner = unwrapShell(shape.command);
    for (const kind of kinds) {
      if (kind === 'wax' && (await matchWax(shape.command, ctx) || (inner !== shape.command && await matchWax(inner, ctx)))) return 'wax';
      if (kind === 'test' && (await matchTest(shape.command, ctx) || (inner !== shape.command && await matchTest(inner, ctx)))) return 'test';
    }
    return null;
  }
  if (shape.type === 'write' && kinds.includes('write')) {
    for (const path of shape.paths) if (!await inTmp(ctx.root, path, shape.cwd !== null ? ctx.cwd : ctx.root)) return null;
    return 'write';
  }
  if (shape.type === 'read' && kinds.includes('read')) {
    for (const path of shape.paths) if (!await readable(ctx.root, path)) return null;
    return 'read';
  }
  return null;
}

export async function judgeRequest(request, { kinds = [], ...ctx }) {
  const allowed = await matchAllow(request, kinds, ctx);
  if (allowed) return { allow: allowed };
  const others = ALLOW_KINDS.filter((kind) => !kinds.includes(kind) && (kind !== 'test' || ctx.test));
  const candidate = await matchAllow(request, others, ctx);
  const outside = await outOfStage(request, ctx);
  return candidate || outside ? { ...(candidate ? { candidate } : {}), ...(outside ? { outOfStage: outside } : {}) } : null;
}

export const DOC_PHASES = ['plan', 'design', 'report'];
export async function outOfStage(request, ctx) {
  const shape = requestShape(request);
  if (shape?.type !== 'write' || !DOC_PHASES.includes(ctx.phase)) return null;
  let root;
  try { root = await realpath(ctx.root); } catch { return null; }
  let cwd = null;
  try { cwd = ctx.cwd ? await realpath(ctx.cwd) : null; } catch { cwd = null; }
  const allowed = [join(root, '.wax'), join(root, 'docs', 'wax'), ...(cwd && cwd !== root ? [join(cwd, 'docs', 'wax')] : [])];
  const worktrees = join(root, '.wax', 'worktrees');
  const within = (dir, path) => inside(dir, path) && (dir !== allowed[0] || !(inside(worktrees, path) || path === worktrees));
  const outside = [];
  for (const path of shape.paths) {
    const lexical = resolve(shape.cwd ?? cwd ?? root, path);
    const real = (await realTarget(lexical)) ?? lexical;
    if (!allowed.some((dir) => within(dir, lexical) && within(dir, real))) outside.push(relative(root, lexical).split(sep).join('/').slice(0, 300));
  }
  return outside.length ? { phase: ctx.phase, paths: outside.slice(0, 5) } : null;
}


export function createGoalAllow({ now = () => Date.now() } = {}) {
  const goals = new Map(), offers = new Map(), ended = new Map(), lapsed = new Map();
  const state = (goal) => goals.get(goal) ?? null;
  return {
    get: state,
    goals: () => [...goals.keys()],
    set(goal, { kinds, test }, by) {
      if (!GOAL.test(goal)) throw fail('errors.pmLoop.invalidGoalId');
      const value = parseAllow({ kinds, test });
      if (!value.kinds.length) { goals.delete(goal); return null; }
      const entry = { kinds: value.kinds, test: value.test, by, at: new Date(now()).toISOString(), used: goals.get(goal)?.used ?? {} };
      goals.set(goal, entry); ended.delete(goal); lapsed.delete(goal);
      return entry;
    },
    add(goal, kind, by) {
      const current = state(goal);
      const kinds = [...new Set([...(current?.kinds ?? []), kind])];
      return this.set(goal, { kinds, test: current?.test ?? '' }, by);
    },
    off(goal) { lapsed.delete(goal); const had = goals.delete(goal); for (const [id, offer] of offers) if (offer.goal === goal) offers.delete(id); return had; },
    end(goal, why) { const had = this.off(goal); if (had) ended.set(goal, { why, at: new Date(now()).toISOString() }); return had; },
    lapse(goal, { kinds, test = '', at = null }) { if (!goals.has(goal)) lapsed.set(goal, { kinds: [...kinds], test, at }); },
    count(goal, kind) { const entry = state(goal); if (entry) entry.used[kind] = (entry.used[kind] ?? 0) + 1; },
    offer(approval, goal, kind) {
      if (offers.size >= ALLOW_LIMITS.offers) offers.delete(offers.keys().next().value);
      offers.set(approval, { goal, kind });
    },
    offerFor: (approval) => offers.get(approval) ?? null,
    dropOffer: (approval) => offers.delete(approval),
    view(goal) {
      const entry = state(goal);
      if (entry) return { on: true, kinds: entry.kinds, test: entry.test, by: entry.by, at: entry.at, used: { ...entry.used } };
      return { on: false, kinds: [], test: '', ...(ended.has(goal) ? { ended: ended.get(goal) } : {}), ...(lapsed.has(goal) ? { lapsed: { ...lapsed.get(goal), kinds: [...lapsed.get(goal).kinds] } } : {}) };
    },
  };
}
