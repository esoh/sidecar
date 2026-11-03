import { isUtf8 } from 'node:buffer';
import { DomainError } from './store.ts';

export const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;

export function decodeFileText(bytes: Buffer): string {
  if (bytes.length > MAX_FILE_PREVIEW_BYTES) throw new DomainError('File exceeds the 2 MiB preview limit', 413);
  if (bytes.includes(0) || !isUtf8(bytes))
    throw new DomainError('Preview unavailable: this file is binary or is not UTF-8 text.', 415);
  return bytes.toString('utf8');
}
