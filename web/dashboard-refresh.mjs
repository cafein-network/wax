export function createLatestRefresh({ load, apply, onError = () => {}, onPending = () => {} }) {
  let generation = 0, currentDate, stopped = false;
  const jobs = new Map();
  function refresh(date) {
    if (stopped) return Promise.resolve({ status: 'stale' });
    const existing = jobs.get(date);
    if (existing && currentDate === date) return existing.promise;
    currentDate = date;
    const ticket = ++generation;
    onPending(true, date);
    if (existing) { existing.ticket = ticket; return existing.promise; }
    const job = { ticket };
    jobs.set(date, job);
    const current = () => !stopped && job.ticket === generation;
    job.promise = Promise.resolve().then(() => load(date)).then(async (value) => {
      if (!current()) return { status: 'stale' };
      await apply(value, date);
      return { status: current() ? 'applied' : 'stale', value };
    }).catch((error) => {
      if (!current()) return { status: 'stale' };
      onError(error, date);
      return { status: 'error', error };
    }).finally(() => {
      jobs.delete(date);
      if (current()) onPending(false, date);
    });
    return job.promise;
  }
  function invalidate(date) {
    const current = jobs.get(date);
    if (!current) return refresh(date);
    if (!current.trailing) current.trailing = current.promise.then(() => stopped || currentDate !== date ? { status: 'stale' } : refresh(date));
    return current.trailing;
  }
  function stop() {
    stopped = true;
    generation++;
    onPending(false, currentDate);
  }
  return { refresh, invalidate, stop };
}
