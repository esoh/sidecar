export type Quote = { exact: string; prefix: string; suffix: string; start: number; end: number; version: string; sentence?: string; isPositionVerified?: boolean };
export type MessageQuote = { threadId: string; messageId: string; exact: string };
export type FileQuote = { path: string; kind: 'doc' | 'code'; exact: string; startLine?: number; endLine?: number };
export function isFileQuote(value: unknown): value is FileQuote {
  return isObject(value) && string(value.path) && value.path.startsWith('/') && value.path.length <= 4096 && !/[\x00-\x1f]/.test(value.path)
    && (value.kind === 'doc' || value.kind === 'code') && string(value.exact) && !!value.exact.trim() && value.exact.length <= 128 * 1024
    && ((value.startLine === undefined && value.endLine === undefined) || (number(value.startLine) && Number.isInteger(value.startLine) && value.startLine > 0 && number(value.endLine) && Number.isInteger(value.endLine) && value.endLine >= value.startLine));
}
export function fileQuoteLabel(quote: FileQuote) {
  return (quote.path.split('/').pop() ?? quote.path) + (quote.startLine ? `:${quote.startLine}${quote.endLine !== quote.startLine ? `–${quote.endLine}` : ''}` : '');
}
export function isMessageQuote(value: unknown): value is MessageQuote {
  return isObject(value) && string(value.threadId) && value.threadId.length > 0 && value.threadId.length <= 256 && string(value.messageId) && value.messageId.length > 0 && value.messageId.length <= 256 && string(value.exact) && !!value.exact.trim() && value.exact.length <= 128 * 1024;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const string = (v: unknown): v is string => typeof v === 'string';
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function isQuote(v: unknown): v is Quote {
  return isObject(v) && string(v.exact) && v.exact.length > 0 && string(v.prefix) && string(v.suffix) && string(v.version) && (v.isPositionVerified === undefined || typeof v.isPositionVerified === 'boolean') && (v.sentence === undefined || (string(v.sentence) && v.sentence.length <= 512 && v.sentence.includes(v.exact.trim()))) && number(v.start) && number(v.end) && Number.isInteger(v.start) && Number.isInteger(v.end) && v.start >= 0 && v.end >= v.start && v.end - v.start === v.exact.length;
}
