export type Quote = { exact: string; prefix: string; suffix: string; start: number; end: number; version: string; isPositionVerified?: boolean };
export type MessageQuote = { threadId: string; messageId: string; exact: string };
export type FileQuote = { path: string; kind: 'doc' | 'code' | 'html'; exact: string; startLine?: number; endLine?: number; selector?: string; isElement?: true; fingerprint?: string };
// A registered .html/.htm file is a standalone HTML document; every other file is Markdown.
export const isHtmlPath = (path: string) => /\.html?$/i.test(path);
// An agent-authored HTML element target has no fingerprint: the viewer checks its text instead.
export function isFileQuote(value: unknown, isAgentTarget = false): value is FileQuote {
  return isObject(value) && string(value.path) && value.path.startsWith('/') && value.path.length <= 4096 && !/[\x00-\x1f]/.test(value.path)
    && (value.kind === 'doc' || value.kind === 'code' || value.kind === 'html') && string(value.exact) && !!value.exact.trim() && value.exact.length <= 128 * 1024
    && (value.kind === 'html' ? isSelector(value.selector) && value.startLine === undefined && value.endLine === undefined && (value.isElement === true ? (isAgentTarget ? value.fingerprint === undefined : string(value.fingerprint) && /^\d{1,9}:[0-9a-f]{8}$/.test(value.fingerprint)) : value.isElement === undefined && value.fingerprint === undefined)
      : value.selector === undefined && value.isElement === undefined && value.fingerprint === undefined)
    && ((value.startLine === undefined && value.endLine === undefined) || (number(value.startLine) && Number.isInteger(value.startLine) && value.startLine > 0 && number(value.endLine) && Number.isInteger(value.endLine) && value.endLine >= value.startLine));
}
// A standalone HTML page's agent target without a selector: its exact text, matched once in the page body.
export const pageTextSelector = 'body';
export const isSelector = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 1024 && !/[\x00-\x1f]/.test(v);
export function fileQuoteLabel(quote: FileQuote) {
  return (quote.path.split('/').pop() ?? quote.path) + (quote.isElement ? ' element' : '') + (quote.startLine ? `:${quote.startLine}${quote.endLine !== quote.startLine ? `–${quote.endLine}` : ''}` : '');
}
export function isMessageQuote(value: unknown): value is MessageQuote {
  return isObject(value) && string(value.threadId) && value.threadId.length > 0 && value.threadId.length <= 256 && string(value.messageId) && value.messageId.length > 0 && value.messageId.length <= 256 && string(value.exact) && !!value.exact.trim() && value.exact.length <= 128 * 1024;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const string = (v: unknown): v is string => typeof v === 'string';
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function isQuote(v: unknown): v is Quote {
  return isObject(v) && string(v.exact) && v.exact.length > 0 && string(v.prefix) && string(v.suffix) && string(v.version) && v.sentence === undefined && (v.isPositionVerified === undefined || typeof v.isPositionVerified === 'boolean') && number(v.start) && number(v.end) && Number.isInteger(v.start) && Number.isInteger(v.end) && v.start >= 0 && v.end >= v.start && v.end - v.start === v.exact.length;
}
