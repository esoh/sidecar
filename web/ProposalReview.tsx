import { viewerPath } from './viewer-path.ts';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { parseDiffFromFile } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { storage } from '@plannotator/ui/utils/storage';
import type { MessageSelection } from '../src/store.ts';
import type { DecisionResult, Proposal, ProposalReason } from '../src/proposals.ts';
import { api, errorText } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { quoteRange } from './selection.ts';
import { usePosition } from './usePosition.ts';

const explanations: Record<ProposalReason, string> = {
  missing: 'The original source passage is no longer present.',
  ambiguous: 'More than one source passage matches. Ask the agent for a more specific proposal.',
  'context-changed': 'The source around this passage has changed.',
  'source-unavailable': 'The original document could not be read when this change was proposed.',
  overlap: 'These changes overlap. Review and accept them individually.',
  'application-unconfirmed': 'The application result could not be confirmed. Your current file was preserved.',
};
const statusLabel = (proposal: Proposal) => ({ pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', outdated: 'Outdated' })[proposal.status];
type Options = {
  documentId: string; proposals: Proposal[]; selections: MessageSelection[]; article: RefObject<HTMLElement | null>;
  version: string; isHistorical: boolean; onShowSelection: (selection: MessageSelection) => void;
  onShowOriginal: (selectionId: string) => void; onReturnToCurrent: () => void;
};
type ReviewContext = {
  proposals: Proposal[]; isHistorical: boolean; busy: Set<string>; errors: Record<string, string>; results: Record<string, DecisionResult>;
  open: (selectionId: string, invoker: HTMLElement | null) => boolean;
  decide: (proposal: Proposal, decision: 'accept' | 'reject') => Promise<void>;
  acceptReply: (proposals: Proposal[]) => Promise<void>;
};
export const ProposalReviewContext = createContext<ReviewContext | null>(null);
export const useProposalContext = () => useContext(ProposalReviewContext);
const replyKey = (p: Proposal) => `${p.threadId}/${p.messageId}`;

export function useProposalReview(options: Options) {
  const [active, setActive] = useState<{ id: string; invoker: HTMLElement | null } | null>(null);
  const [busy, setBusy] = useState(new Set<string>()), [errors, setErrors] = useState<Record<string, string>>({}), [results, setResults] = useState<Record<string, DecisionResult>>({});
  const latest = useRef(options); latest.current = options;
  const dialog = useRef<HTMLElement>(null);
  const proposal = options.proposals.find(p => p.id === active?.id), selection = options.selections.find(s => s.id === proposal?.selectionId);
  const close = useCallback(() => {
    setActive(previous => { requestAnimationFrame(() => previous?.invoker?.isConnected && previous.invoker.focus({ preventScroll: true })); return null; });
  }, []);
  useEffect(() => { setActive(null); setErrors({}); setResults({}); }, [options.documentId]);
  useEffect(() => { if (active && !proposal) setActive(null); }, [active, proposal]);
  const open = useCallback((selectionId: string, invoker: HTMLElement | null) => {
    const { proposals, selections, onShowSelection, isHistorical } = latest.current;
    const proposal = proposals.find(p => p.selectionId === selectionId), selection = selections.find(s => s.id === selectionId);
    if (!proposal || !selection) return false;
    if (!isHistorical && !invoker?.closest('#document')) onShowSelection(selection);
    setActive({ id: proposal.id, invoker }); return true;
  }, []);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>('[aria-label="Close proposed change"]')?.focus({ preventScroll: true }));
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    document.addEventListener('keydown', escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', escape); };
  }, [active, close]);
  const anchor = useCallback(() => {
    const root = latest.current.article.current;
    const range = root && !latest.current.isHistorical && selection && quoteRange(root, selection.quote, latest.current.version);
    const rect = range && range.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : active?.invoker?.getBoundingClientRect() ?? root?.getBoundingClientRect();
  }, [active, selection]);
  const bounds = useCallback(() => document.querySelector('main.canvas')?.getBoundingClientRect(), []);
  async function run(key: string, ids: string[], path: string, body: unknown) {
    if (latest.current.isHistorical || ids.some(id => busy.has(id))) return;
    setBusy(previous => new Set([...previous, ...ids])); setErrors(previous => ({ ...previous, [key]: '' }));
    try { const result = await api<DecisionResult>(path, body); setResults(previous => ({ ...previous, [key]: result })); }
    catch (reason) { setErrors(previous => ({ ...previous, [key]: errorText(reason) })); }
    finally { setBusy(previous => new Set([...previous].filter(id => !ids.includes(id)))); }
  }
  const context: ReviewContext = {
    proposals: options.proposals, isHistorical: options.isHistorical, busy, errors, results, open,
    decide: (p, decision) => run(p.id, [p.id], `/api/proposals/${p.id}/decision`, { decision }),
    acceptReply: proposals => {
      const p = proposals[0]; if (!p) return Promise.resolve();
      return run(replyKey(p), proposals.filter(p => p.status === 'pending').map(p => p.id), `/api/threads/${p.threadId}/messages/${p.messageId}/proposals/accept`, {});
    },
  };
  return { context, open, popover: proposal && selection && active ? createPortal(
    <ProposalWindow key={proposal.id} dialog={dialog} anchor={anchor} bounds={bounds} onClose={close}
      title={<><strong>{selection.label ?? 'Proposed change'}</strong><span className={`proposal-status ${proposal.status}`}>{statusLabel(proposal)}</span></>}
      footer={<>
        {options.isHistorical ? <button className="proposal-original" onClick={options.onReturnToCurrent}>Return to current</button> : proposal.baseVersion && <OriginalLink documentId={options.documentId} version={proposal.baseVersion} onOpen={() => options.onShowOriginal(selection.id)} />}
        {(proposal.status === 'pending' || proposal.status === 'outdated') && <div className="proposal-decisions">
          <button disabled={options.isHistorical || busy.has(proposal.id)} onClick={() => void context.decide(proposal, 'reject')}>Reject</button>
          <button className="proposal-accept" disabled={options.isHistorical || proposal.status !== 'pending' || busy.has(proposal.id)} onClick={() => void context.decide(proposal, 'accept')}>{busy.has(proposal.id) ? 'Saving…' : 'Accept'}</button>
        </div>}
      </>}>
      <ProposalDiff proposal={proposal} documentId={options.documentId} />
      {proposal.reason && <p className="proposal-reason">{explanations[proposal.reason]}</p>}
      {errors[proposal.id] && <p role="alert">{errors[proposal.id]}</p>}
    </ProposalWindow>, document.body) : null };
}

type ProposalGeometry = { x: number; y: number; width: number; height: number };
function proposalViewport() {
  const viewport = window.visualViewport, left = (viewport?.offsetLeft ?? 0) + 8, top = (viewport?.offsetTop ?? 0) + 8;
  return { left, top, right: left + (viewport?.width ?? innerWidth) - 16, bottom: top + (viewport?.height ?? innerHeight) - 16 };
}
function clampProposal(value: ProposalGeometry): ProposalGeometry {
  const { left, top, right, bottom } = proposalViewport();
  const width = Math.max(0, Math.min(value.width, right - left)), height = Math.max(0, Math.min(value.height, bottom - top));
  return { width, height, x: Math.max(left, Math.min(value.x, right - width)), y: Math.max(top, Math.min(value.y, bottom - height)) };
}
function ProposalWindow({ dialog, anchor, bounds, title, children, footer, onClose }: {
  dialog: RefObject<HTMLElement | null>; anchor: () => DOMRect | undefined; bounds: () => DOMRect | undefined;
  title: ReactNode; children: ReactNode; footer: ReactNode; onClose: () => void;
}) {
  const [geometry, setGeometry] = useState<ProposalGeometry | null>(null);
  const [textSize, setTextSize] = useState(() => {
    const saved = Number(storage.getItem('sidecar-proposal-text-size'));
    return Number.isInteger(saved) && saved >= 25 && saved <= 100 && saved % 5 === 0 ? saved : 100;
  });
  const stopGesture = useRef<(() => void) | null>(null);
  // Anchoring owns initial placement only; scroll and diff layout changes must not undo a gesture.
  usePosition(dialog, geometry ? null : anchor, 480, false, bounds);
  useEffect(() => { storage.setItem('sidecar-proposal-text-size', String(textSize)); }, [textSize]);
  useEffect(() => () => stopGesture.current?.(), []);
  useLayoutEffect(() => {
    const resize = () => setGeometry(previous => previous && clampProposal(previous));
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize);
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); };
  }, []);
  function gesture(event: ReactPointerEvent, edge?: string) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input'))) return;
    const original = dialog.current?.getBoundingClientRect(); if (!original) return;
    event.preventDefault(); stopGesture.current?.();
    const start = { x: event.clientX, y: event.clientY }, previous = geometry;
    setGeometry(clampProposal(original));
    const cursor = document.body.style.cursor, selection = document.body.style.userSelect;
    document.body.style.cursor = edge ? `${edge}-resize` : 'grabbing'; document.body.style.userSelect = 'none';
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const dx = next.clientX - start.x, dy = next.clientY - start.y;
      if (!edge) { setGeometry(clampProposal({ x: original.x + dx, y: original.y + dy, width: original.width, height: original.height })); return; }
      const viewport = proposalViewport(), minWidth = Math.min(280, viewport.right - viewport.left), minHeight = Math.min(220, viewport.bottom - viewport.top);
      const left = edge.includes('w') ? Math.max(viewport.left, Math.min(original.x + dx, original.right - minWidth)) : original.x;
      const top = edge.includes('n') ? Math.max(viewport.top, Math.min(original.y + dy, original.bottom - minHeight)) : original.y;
      const right = edge.includes('e') ? Math.min(viewport.right, Math.max(original.x + minWidth, original.right + dx)) : original.right;
      const bottom = edge.includes('s') ? Math.min(viewport.bottom, Math.max(original.y + minHeight, original.bottom + dy)) : original.bottom;
      setGeometry(clampProposal({ x: left, y: top, width: right - left, height: bottom - top }));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
      document.body.style.cursor = cursor; document.body.style.userSelect = selection; stopGesture.current = null;
    };
    const up = (next: PointerEvent) => { if (next.pointerId === event.pointerId) finish(); };
    const cancel = () => { finish(); setGeometry(previous); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
    stopGesture.current = finish;
  }
  return <section ref={dialog} className="floating proposal-review" role="dialog" aria-label="Proposed change" aria-modal={false}
    style={geometry ? { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height, maxHeight: 'none' } : undefined}>
    <header role="group" tabIndex={0} aria-label="Move proposed change" title="Drag to move. Arrow keys move; Shift+Arrow keys resize."
      onPointerDown={event => gesture(event)} onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        const current = dialog.current?.getBoundingClientRect(); if (!delta || !current) return;
        event.preventDefault();
        setGeometry(clampProposal({ x: current.x + (event.shiftKey ? 0 : delta[0]), y: current.y + (event.shiftKey ? 0 : delta[1]),
          width: event.shiftKey ? Math.max(280, current.width + delta[0]) : current.width, height: event.shiftKey ? Math.max(220, current.height + delta[1]) : current.height }));
      }}>
      <div>{title}</div><button aria-label="Close proposed change" onClick={onClose}>×</button>
    </header>
    <div className="proposal-text-size">
      <label htmlFor="proposal-text-size">Text size</label>
      <input id="proposal-text-size" type="range" aria-label="Proposal text size" aria-valuetext={`${textSize}%`} min={25} max={100} step={5} value={textSize} onChange={event => setTextSize(event.target.valueAsNumber)} />
      <output htmlFor="proposal-text-size">{textSize}%</output>
      <button aria-label="Reset proposal text size" disabled={textSize === 100} onClick={() => setTextSize(100)}>Reset</button>
    </div>
    <div className="proposal-content"><div style={{ zoom: textSize / 100 }}>{children}</div></div>
    <footer>{footer}</footer>
    {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => <div key={edge} className={`resize-edge resize-${edge}`} onPointerDown={event => gesture(event, edge)} />)}
  </section>;
}

function OriginalLink({ documentId, version, onOpen }: { documentId: string; version: string; onOpen: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => { let stopped = false; setAvailable(false); void fetch(viewerPath(`/api/documents/${documentId}/versions/${encodeURIComponent(version)}`), { method: 'HEAD' }).then(r => { if (!stopped) setAvailable(r.ok); }).catch(() => {}); return () => { stopped = true; }; }, [documentId, version]);
  return available ? <button className="proposal-original" onClick={onOpen}>View original document</button> : null;
}

function ProposalDiff({ proposal, documentId }: { proposal: Proposal; documentId: string }) {
  const before = useRef<HTMLDivElement>(null), after = useRef<HTMLDivElement>(null), [sourceOpen, setSourceOpen] = useState(false);
  const diff = useMemo(() => parseDiffFromFile({ name: 'document.md', contents: proposal.before }, { name: 'document.md', contents: proposal.after }), [proposal.before, proposal.after]);
  useLayoutEffect(() => { setSourceOpen((before.current?.textContent ?? '').trim() === (after.current?.textContent ?? '').trim()); }, [proposal.id, proposal.before, proposal.after]);
  return <div className="proposal-diff">
    <div className="proposal-before"><span aria-label="Removed">−</span><div ref={before}><MarkdownDocument markdown={proposal.before} documentId={documentId} anchorPrefix={`proposal-${proposal.id}-before-`} /></div></div>
    <div className="proposal-after"><span aria-label="Added">+</span><div ref={after}>{proposal.after ? <MarkdownDocument markdown={proposal.after} documentId={documentId} anchorPrefix={`proposal-${proposal.id}-after-`} /> : <em>Remove this passage</em>}</div></div>
    <details open={sourceOpen} onToggle={event => setSourceOpen(event.currentTarget.open)}><summary>Source diff</summary><FileDiff fileDiff={diff} disableWorkerPool options={{ diffStyle: 'unified', themeType: 'dark', disableFileHeader: true, overflow: 'wrap' }} /></details>
  </div>;
}

export function ProposalCard({ proposal, selection }: { proposal: Proposal; selection: MessageSelection }) {
  const review = useProposalContext();
  return <div className="proposal-card" data-proposal-id={proposal.id}>
    <div><span className={`proposal-status ${proposal.status}`}>{statusLabel(proposal)}</span><button onClick={event => review?.open(selection.id, event.currentTarget)}>{proposal.status === 'pending' ? 'Review change' : 'View change'}</button></div>
    <p className="proposal-excerpt">{proposal.before}</p>
    {proposal.reason && <p className="proposal-reason">{explanations[proposal.reason]}</p>}
  </div>;
}

export function ReplyProposalActions({ proposals }: { proposals: Proposal[] }) {
  const review = useProposalContext(); if (!review || !proposals.length) return null;
  const pending = proposals.filter(p => p.status === 'pending'), key = replyKey(proposals[0]), result = review.results[key];
  return <div className="reply-proposal-actions">
    {pending.length > 0 && <button disabled={review.isHistorical || pending.some(p => review.busy.has(p.id))} onClick={() => void review.acceptReply(proposals)}>Accept all ({pending.length})</button>}
    {result && <span role="status">{result.accepted.length} applied{result.outdated.length + result.overlapping.length ? ` · ${result.outdated.length + result.overlapping.length} left unapplied` : ''}</span>}
    {review.errors[key] && <p role="alert">{review.errors[key]}</p>}
  </div>;
}
