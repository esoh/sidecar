export type HighlightInput = { exact: string; prefix?: string; suffix?: string; label?: string };
export type ReplyMetadata = { threadTitle?: string; highlights?: HighlightInput[]; isError?: boolean };

const prefix = '[[sidecar-meta ';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shortLabel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\x00-\x1f]/.test(value);
function highlight(value: unknown): value is HighlightInput {
  return object(value) && typeof value.exact === 'string' && value.exact.trim().length > 0 && value.exact.length <= 16384 &&
    ['prefix', 'suffix'].every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 512)) &&
    (value.label === undefined || shortLabel(value.label));
}

// One optional JSON line at the start of a marked reply. Partial headers never flash in the viewer.
export function parseReply(text: string): { text: string; metadata: ReplyMetadata } {
  if (prefix.startsWith(text)) return { text: '', metadata: {} };
  if (!text.startsWith(prefix)) return { text, metadata: {} };
  const newline = text.indexOf('\n');
  if (newline < 0) return { text: '', metadata: {} };
  const line = text.slice(0, newline).trimEnd(), metadata: ReplyMetadata = {};
  try {
    const value: unknown = line.endsWith(']]') ? JSON.parse(line.slice(prefix.length, -2)) : null;
    if (object(value)) {
      if (shortLabel(value.threadTitle)) metadata.threadTitle = value.threadTitle.trim();
      if (typeof value.isError === 'boolean') metadata.isError = value.isError;
      // Preserve array positions: selection-N links must never slide onto another passage.
      if (Array.isArray(value.highlights) && value.highlights.length <= 20 && value.highlights.every(highlight)) metadata.highlights = value.highlights;
    }
  } catch { /* Invalid optional metadata must not prevent saving the answer. */ }
  return { text: text.slice(newline + 1), metadata };
}
