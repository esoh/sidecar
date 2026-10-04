import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function saveDocumentVersion(directory: string, documentId: string, data: { markdown: string; version: string }): Promise<void> {
  const versions = join(directory, 'versions', documentId);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const temporary = join(versions, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data.markdown, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(versions, `${data.version}.md`));
  } finally { await unlink(temporary).catch(() => {}); }
}
