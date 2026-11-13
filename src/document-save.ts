import { isHtmlPath, readSourceFile } from './documents.ts';
import { discardFileWrite, prepareFileWrite, publishFileWrite } from './proposal-writes.ts';
import { saveDocumentVersion } from './snapshots.ts';
import { DomainError } from './store.ts';

export async function saveDocumentSource(input: { directory: string; documentId: string; path: string; markdown: string; baseVersion: string }): Promise<{ version: string; isUnchanged: boolean }> {
  if (isHtmlPath(input.path)) throw new DomainError('Only Markdown documents can be edited', 400);
  const source = await readSourceFile(input.path);
  if (source.markdown.includes('\r')) throw new DomainError('Documents with carriage returns cannot be edited', 400);
  if (input.markdown.includes('\r')) throw new DomainError('Carriage returns are not supported in edited text', 400);
  if (source.version !== input.baseVersion) throw new DomainError('The document changed on disk. Review it again.', 409);
  if (source.markdown === input.markdown) return { version: source.version, isUnchanged: true };
  await saveDocumentVersion(input.directory, input.documentId, { markdown: source.markdown, version: source.version });
  const write = await prepareFileWrite(source, input.markdown);
  try {
    await saveDocumentVersion(input.directory, input.documentId, { markdown: write.markdown, version: write.afterVersion });
    publishFileWrite(write, 'The document changed on disk. Review it again.');
  } finally { await discardFileWrite(write); }
  return { version: write.afterVersion, isUnchanged: false };
}
