import { isHtmlPath, readSourceFile } from './documents.ts';
import { discardFileWrite, prepareFileWrite, publishFileWrite } from './proposal-writes.ts';
import { saveDocumentVersion } from './snapshots.ts';
import { DomainError } from './store.ts';

const CHANGED = 'The document changed on disk. Review it again.';
// `code` and `version` let the editor recognise the conflict and know which disk version a Save anyway would override.
const changed = (version: string) => new DomainError(CHANGED, 409, { code: 'changed', version });

export async function saveDocumentSource(input: { directory: string; documentId: string; path: string; markdown: string; baseVersion: string }): Promise<{ version: string; isUnchanged: boolean }> {
  if (isHtmlPath(input.path)) throw new DomainError('Only Markdown documents can be edited', 400);
  const source = await readSourceFile(input.path);
  if (source.markdown.includes('\r')) throw new DomainError('Documents with carriage returns cannot be edited', 400);
  if (input.markdown.includes('\r')) throw new DomainError('Carriage returns are not supported in edited text', 400);
  if (source.version !== input.baseVersion) throw changed(source.version);
  if (source.markdown === input.markdown) return { version: source.version, isUnchanged: true };
  await saveDocumentVersion(input.directory, input.documentId, { markdown: source.markdown, version: source.version });
  const write = await prepareFileWrite(source, input.markdown);
  try {
    await saveDocumentVersion(input.directory, input.documentId, { markdown: write.markdown, version: write.afterVersion });
    try { publishFileWrite(write, CHANGED, 'The backing path changed; the document was not saved'); }
    catch (error) {
      if (error instanceof DomainError && error.status === 409 && error.message === CHANGED) throw changed(await readSourceFile(input.path).then(latest => latest.version, () => ''));
      throw error;
    }
  } finally { await discardFileWrite(write); }
  return { version: write.afterVersion, isUnchanged: false };
}
