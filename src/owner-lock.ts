import { mkdir, readFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}
export async function acquireLock(directory: string): Promise<(() => Promise<void>) | null> {
  const lock = join(directory, 'owner.lock'), reclaim = join(directory, 'reclaim.lock');
  async function create() {
    const file = await open(lock, 'wx', 0o600);
    try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    return async () => { if (Number(await readFile(lock, 'utf8').catch(() => '0')) === process.pid) await rm(lock, { force: true }); };
  }
  try { return await create(); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const pid = Number(await readFile(lock, 'utf8').catch(() => '0'));
  if (isAlive(pid)) return null;
  // Serialize stale-lock recovery. A crashed recovery fails closed until this tiny marker is removed.
  try { await mkdir(reclaim, { mode: 0o700 }); } catch { return null; }
  try {
    const current = Number(await readFile(lock, 'utf8').catch(() => '0'));
    if (isAlive(current)) return null;
    await rm(lock, { force: true });
    try { return await create(); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return null;
      throw error;
    }
  } finally { await rm(reclaim, { recursive: true, force: true }); }
}
