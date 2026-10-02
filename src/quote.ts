export type Quote = { exact: string; prefix: string; suffix: string; start: number; end: number; version: string; sentence?: string };

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const string = (v: unknown): v is string => typeof v === 'string';
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function isQuote(v: unknown): v is Quote {
  return isObject(v) && string(v.exact) && v.exact.length > 0 && string(v.prefix) && string(v.suffix) && string(v.version) && (v.sentence === undefined || (string(v.sentence) && v.sentence.length <= 512 && v.sentence.includes(v.exact.trim()))) && number(v.start) && number(v.end) && Number.isInteger(v.start) && Number.isInteger(v.end) && v.start >= 0 && v.end >= v.start && v.end - v.start === v.exact.length;
}
