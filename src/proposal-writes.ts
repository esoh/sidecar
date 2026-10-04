import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SourceFile } from './documents.ts';
import { DomainError } from './store.ts';

export type PreparedFileWrite = { source: SourceFile; temporary: string; markdown: string; beforeVersion: string; afterVersion: string };

export async function prepareFileWrite(source: SourceFile, markdown: string): Promise<PreparedFileWrite> {
  if (!Buffer.from(source.markdown, 'utf8').equals(source.bytes) || Buffer.from(markdown, 'utf8').toString('utf8') !== markdown) throw new DomainError('The source and replacement must be valid UTF-8; no file was changed', 409);
  const temporary = join(dirname(source.path), `.sidecar-${randomUUID()}.tmp`), bytes = Buffer.from(markdown, 'utf8');
  const file = await open(temporary, 'wx', source.identity.mode & 0o7777);
  try {
    await file.writeFile(bytes);
    await file.chmod(source.identity.mode & 0o7777);
    await file.sync();
  } catch (error) {
    await file.close(); await unlink(temporary).catch(() => {}); throw error;
  }
  await file.close();
  return { source, temporary, markdown, beforeVersion: source.version, afterVersion: createHash('sha256').update(bytes).digest('hex') };
}

// No await between the final identity/content check and rename. This bounds the
// external-writer race; the filesystem does not provide cross-process CAS.
export function publishFileWrite(write: PreparedFileWrite): void {
  const { source } = write;
  if (realpathSync(source.path) !== source.path) throw new DomainError('The backing path changed; no proposal was applied', 409);
  const file = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = fstatSync(file);
    if (!identity.isFile() || identity.dev !== source.identity.dev || identity.ino !== source.identity.ino || identity.mode !== source.identity.mode ||
      createHash('sha256').update(readFileSync(file)).digest('hex') !== write.beforeVersion) throw new DomainError('The document changed before this proposal could be applied. Review it again.', 409);
  } finally { closeSync(file); }
  renameSync(write.temporary, source.path);
}

export async function discardFileWrite(write: PreparedFileWrite): Promise<void> {
  try { await unlink(write.temporary); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
