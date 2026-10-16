import { withFileLock, processAlive, LockError } from '../file-lock.mjs';
import { WaxError } from '../workflow.mjs';
export { processAlive };
export async function withLock(path, fn, options) {
  try { return await withFileLock(path, fn, options); }
  catch (error) { if (error instanceof LockError) throw new WaxError(error.message, 409); throw error; }
}
