export type SourceRange = { start: number; end: number };
export type ProposalInput = { before: string; after: string; prefix?: string; suffix?: string };
export type ProposalReason = 'missing' | 'ambiguous' | 'context-changed' | 'source-unavailable' | 'overlap' | 'application-unconfirmed';
export type PreparedProposal = ProposalInput & {
  prefix: string; suffix: string; baseVersion: string | null; baseRange: SourceRange | null; reason?: ProposalReason;
};
export type Proposal = PreparedProposal & {
  id: string; documentId: string; threadId: string; messageId: string; selectionId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'outdated'; createdAt: number;
  decidedAt?: number; appliedVersion?: string; appliedRange?: SourceRange;
};
export type ProposalWrite = {
  id: string; documentId: string; status: 'prepared' | 'unconfirmed'; proposalIds: string[];
  decidedAt: number; beforeVersion: string; afterVersion: string; appliedRanges: Record<string, SourceRange>;
};
export type DecisionResult = { accepted: string[]; rejected: string[]; outdated: string[]; overlapping: string[] };

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const context = (v: unknown): v is string => typeof v === 'string' && v.length <= 512;
const reasons = ['missing', 'ambiguous', 'context-changed', 'source-unavailable', 'overlap', 'application-unconfirmed'];
function isRange(v: unknown): v is SourceRange {
  return object(v) && typeof v.start === 'number' && Number.isSafeInteger(v.start) && v.start >= 0 &&
    typeof v.end === 'number' && Number.isSafeInteger(v.end) && v.end >= v.start;
}
export function isProposalInput(v: unknown): v is ProposalInput {
  return object(v) && nonempty(v.before) && v.before.length <= 16384 && typeof v.after === 'string' && v.after.length <= 16384 && v.before !== v.after &&
    (v.prefix === undefined || context(v.prefix)) && (v.suffix === undefined || context(v.suffix));
}
export function isPreparedProposal(v: unknown): v is PreparedProposal {
  if (!object(v)) return false;
  const fields = v;
  return isProposalInput(v) && context(v.prefix) && context(v.suffix) &&
    (fields.baseVersion === null || nonempty(fields.baseVersion)) && (fields.baseRange === null || (isRange(fields.baseRange) && fields.baseRange.end - fields.baseRange.start === v.before.length)) &&
    (fields.reason === undefined || (typeof fields.reason === 'string' && reasons.includes(fields.reason))) &&
    (fields.baseVersion !== null || (fields.baseRange === null && fields.reason === 'source-unavailable'));
}
export function isProposal(v: unknown): v is Proposal {
  if (!object(v)) return false;
  const fields = v;
  if (!isPreparedProposal(v) || !['id', 'documentId', 'threadId', 'messageId', 'selectionId'].every(k => nonempty(fields[k])) ||
    !timestamp(fields.createdAt) || (fields.decidedAt !== undefined && !timestamp(fields.decidedAt))) return false;
  if (fields.status === 'accepted') return timestamp(fields.decidedAt) && nonempty(fields.appliedVersion) && isRange(fields.appliedRange) && fields.appliedRange.end - fields.appliedRange.start === v.after.length && v.reason === undefined && nonempty(v.baseVersion) && isRange(v.baseRange);
  if (fields.appliedVersion !== undefined || fields.appliedRange !== undefined) return false;
  if (fields.status === 'rejected') return timestamp(fields.decidedAt);
  if (fields.decidedAt !== undefined) return false;
  if (fields.status === 'pending') return nonempty(v.baseVersion) && isRange(v.baseRange) && (v.reason === undefined || v.reason === 'overlap');
  return fields.status === 'outdated' && v.reason !== undefined && v.reason !== 'overlap';
}
export function isProposalWrite(v: unknown): v is ProposalWrite {
  if (!object(v) || !object(v.appliedRanges)) return false;
  const ranges = v.appliedRanges;
  return object(v) && nonempty(v.id) && nonempty(v.documentId) && (v.status === 'prepared' || v.status === 'unconfirmed') && timestamp(v.decidedAt) &&
    nonempty(v.beforeVersion) && nonempty(v.afterVersion) && v.beforeVersion !== v.afterVersion &&
    Array.isArray(v.proposalIds) && v.proposalIds.length > 0 && v.proposalIds.length <= 20 && v.proposalIds.every(nonempty) && new Set(v.proposalIds).size === v.proposalIds.length &&
    Object.keys(ranges).length === v.proposalIds.length && v.proposalIds.every(id => Object.hasOwn(ranges, id) && isRange(ranges[id]));
}
