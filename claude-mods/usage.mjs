
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

async function save($, usage, ended = false) {
  try {
    if (!(await $.fs.exists('.wax'))) return;
    const session = String(await $.session.id());
    if (!SESSION_ID.test(session)) return;
    const model = await $.session.model();
    const record = {
      schema: 1, tool: 'claude', session, model: typeof model === 'string' ? model : null, at: new Date().toISOString(), ended,
      context: usage?.context ? { percent: num(usage.context.percent), tokens: num(usage.context.tokens), window: num(usage.context.window) } : null,
      rateLimits: (usage?.rateLimits ?? []).map((limit) => ({ kind: String(limit.kind), percentUsed: num(limit.percentUsed), resetsAt: limit.resetsAt ?? null })),
      costUsd: num(usage?.cost?.usd),
    };
    await $.fs.write(`.wax/usage/${session}.json`, JSON.stringify(record));
  } catch {
  }
}

export function register(on) {
  let last = null;
  on('session.measure', async ($, e, next) => {
    const result = await next(e);
    last = e;
    await save($, e);
    return result;
  });
  on('session.end', async ($, e, next) => {
    const result = await next(e);
    if (last) await save($, last, true);
    return result;
  });
}
