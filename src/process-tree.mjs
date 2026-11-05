import { spawnSync } from 'node:child_process';

export const TREE_KILL = { graceMs: 200, pollMs: 20 };

export const runTaskkill = (args) => {
  const result = spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  if (result.error) throw result.error;
};

export function killTree(child, { platform = process.platform, taskkill = runTaskkill, kill = (pid, signal) => process.kill(pid, signal), timers = { set: setTimeout, clear: clearTimeout },
  graceMs = TREE_KILL.graceMs, pollMs = TREE_KILL.pollMs } = {}) {
  const only = () => { try { child?.kill('SIGKILL'); } catch {   } return 'child'; };
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(only());
  if (platform === 'win32') {
    try { taskkill(['/pid', String(pid), '/T', '/F']); return Promise.resolve('taskkill'); } catch { return Promise.resolve(only()); }
  }
  try { kill(-pid, 'SIGTERM'); } catch { return Promise.resolve(only()); }
  const alive = () => { try { kill(-pid, 0); return true; } catch { return false; } };
  return new Promise((done) => {
    let waited = 0;
    const tick = () => {
      if (!alive()) { done('term'); return; }
      if (waited >= graceMs) { try { kill(-pid, 'SIGKILL'); } catch {   } done('kill'); return; }
      waited += pollMs;
      timers.set(tick, pollMs);
    };
    timers.set(tick, pollMs);
  });
}
