import type { EditorView } from '@codemirror/view';

/** The same block (or gap) as a pixel span in each pane's scroll-content coordinates. */
export type Segment = { source: [number, number]; preview: [number, number] };
export type Heights = { scrollHeight: number; clientHeight: number };
type Side = 'source' | 'preview';
/** How long a pane the sync just scrolled ignores scroll events (its echo and CodeMirror's height corrections). */
export const QUIET_MS = 100;
/** How long the alignment markers stay lit after the last scroll. */
export const MARKER_MS = 1000;

/**
 * Where in the viewport (0 = top, 1 = bottom) the panes are aligned: `f`, except near the ends of the document, where it
 * eases to the top or bottom edge so both panes reach their ends together. Each zone is only as long as the anchor must
 * travel (`f` or `1 - f` of a screen), shrunk in a document under one screen of scrolling so the zones never overlap.
 */
export function anchorFraction(scrollTop: number, scrollHeight: number, clientHeight: number, f: number): number {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return f;
  const s = Math.min(1, max / clientHeight), top = s * f * clientHeight, bottom = s * (1 - f) * clientHeight;
  if (scrollTop < top) return f * Math.max(scrollTop / top, 0);
  if (max - scrollTop < bottom) return 1 - (1 - f) * Math.max((max - scrollTop) / bottom, 0);
  return f;
}

/** The viewport's anchor point, in scroll-content coordinates. */
export function anchorY(scrollTop: number, scrollHeight: number, clientHeight: number, f: number): number {
  return scrollTop + clientHeight * anchorFraction(scrollTop, scrollHeight, clientHeight, f);
}

/** Maps a pixel position to the same fraction of the paired segment on the other side. */
export function mapY(segments: Segment[], from: Side, y: number): number {
  const to: Side = from === 'source' ? 'preview' : 'source';
  if (!segments.length) return y;
  const hit = segments.find(segment => y < segment[from][1]) ?? segments[segments.length - 1];
  const [a, b] = hit[from], span = b - a;
  return hit[to][0] + (span > 0 ? Math.min(Math.max((y - a) / span, 0), 1) : 0) * (hit[to][1] - hit[to][0]);
}

/** The scrollTop that puts the target's anchor on the point matching the leader's anchor. */
export function targetScrollTop(segments: Segment[], from: Side, scrollTop: number, fromHeights: Heights, toHeights: Heights, f: number): number {
  const y = mapY(segments, from, anchorY(scrollTop, fromHeights.scrollHeight, fromHeights.clientHeight, f));
  const { scrollHeight, clientHeight } = toHeights;
  // Inverse of anchorY, which increases with scrollTop: bisect.
  let lo = 0, hi = Math.max(0, scrollHeight - clientHeight);
  if (y <= 0) return 0;
  if (y >= anchorY(hi, scrollHeight, clientHeight, f)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (anchorY(mid, scrollHeight, clientHeight, f) < y) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A range over a collapsed <details> still reports its hidden content's boxes; cut the rect down to what is shown. */
function visibleRect(wrapper: HTMLElement, rect: DOMRect): { top: number; bottom: number; height: number } {
  if (!wrapper.querySelector('details:not([open])')) return rect;
  let bottom = rect.top;
  for (const node of wrapper.querySelectorAll('*')) if (node.checkVisibility()) bottom = Math.max(bottom, node.getBoundingClientRect().bottom);
  return { top: rect.top, bottom, height: bottom - rect.top };
}

/** Inside a collapsed <details>, outside its summary: laid out stale or not at all, so it takes no space. */
function folded(node: Element): boolean {
  for (let d = node.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])') ?? null) {
    if (!d.querySelector(':scope > summary')?.contains(node)) return true;
  }
  return false;
}

function buildSegments(view: EditorView, preview: HTMLElement): Segment[] {
  const scroller = view.scrollDOM, doc = view.state.doc;
  const sourceBase = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const previewBase = preview.scrollTop - preview.getBoundingClientRect().top;
  const wrappers = [...preview.querySelectorAll<HTMLElement>('[data-source-line]')];
  const segments: Segment[] = [];
  let s = 0, p = 0;
  const push = (sourceEnd: number, previewEnd: number, block: boolean) => {
    const source: [number, number] = [s, Math.max(s, sourceEnd)], previewSpan: [number, number] = [p, Math.max(p, previewEnd)];
    if (block || source[1] > source[0] || previewSpan[1] > previewSpan[0]) segments.push({ source, preview: previewSpan });
    s = source[1]; p = previewSpan[1];
  };
  wrappers.forEach((wrapper, i) => {
    const line = Number(wrapper.dataset.sourceLine);
    if (!(line >= 1 && line <= doc.lines) || folded(wrapper)) return;
    const range = document.createRange();
    range.selectNodeContents(wrapper);
    const rect = visibleRect(wrapper, range.getBoundingClientRect());
    if (!rect.height) return; // collapsed or hidden
    let last = Math.min(Number(wrappers[i + 1]?.dataset.sourceLine ?? doc.lines + 1) - 1, doc.lines);
    while (last > line && !doc.line(last).text.trim()) last--;
    last = Math.max(last, line);
    push(view.lineBlockAt(doc.line(line).from).top + sourceBase, rect.top + previewBase, false);
    push(view.lineBlockAt(doc.line(last).from).bottom + sourceBase, rect.bottom + previewBase, true);
  });
  push(scroller.scrollHeight, preview.scrollHeight, false);
  return segments;
}

/**
 * Keeps the source and preview scrolled to the same passage: whichever pane the user scrolls (or the source while
 * typing) leads. The panes' blocks are measured in pixels, so wrapped paragraphs and images line up. The optional markers
 * are small triangles whose tip is moved to each pane's current alignment line, lit while either pane scrolls. Returns the cleanup.
 */
export function syncScroll(source: EditorView, preview: HTMLElement, fraction: () => number, markers?: Record<Side, HTMLElement | null>): () => void {
  const scroller = source.scrollDOM;
  const el = { source: scroller, preview } as Record<Side, HTMLElement>;
  let segments: Segment[] = [], leader: Side = 'source', frame = 0;
  // A pane the sync just scrolled ignores scroll events for a moment: its own echo, and CodeMirror's height corrections after it.
  const quiet: Record<Side, number> = { source: 0, preview: 0 };
  const heights = (side: Side): Heights => ({ scrollHeight: el[side].scrollHeight, clientHeight: el[side].clientHeight });

  let idle = 0;
  const place = () => {
    for (const side of ['source', 'preview'] as const) {
      const marker = markers?.[side], { scrollHeight, clientHeight } = heights(side);
      if (marker && clientHeight) marker.style.transform = `translateY(${anchorFraction(el[side].scrollTop, scrollHeight, clientHeight, fraction()) * clientHeight - marker.offsetHeight / 2}px)`;
    }
  };
  const light = () => {
    place();
    for (const marker of Object.values(markers ?? {})) marker?.setAttribute('data-active', '');
    clearTimeout(idle);
    idle = window.setTimeout(() => { for (const marker of Object.values(markers ?? {})) marker?.removeAttribute('data-active'); }, MARKER_MS);
  };
  const follow = (from: Side) => {
    const to: Side = from === 'source' ? 'preview' : 'source';
    if (!el[from].clientHeight || !el[to].clientHeight) return; // a hidden pane catches up when it is shown
    const target = targetScrollTop(segments, from, el[from].scrollTop, heights(from), heights(to), fraction());
    if (Math.abs(target - el[to].scrollTop) < 0.5) return;
    el[to].scrollTop = target;
    quiet[to] = performance.now() + QUIET_MS;
  };
  // CodeMirror re-measures its lines (after a font-size change, say) in its own measure cycle; build the segments after it.
  const rebuild = () => { frame = 0; source.requestMeasure({ read: () => null, write: () => { segments = buildSegments(source, preview); follow(leader); place(); } }); };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(rebuild); };
  const onScroll = (side: Side) => () => {
    light();
    if (performance.now() < quiet[side]) return;
    leader = side;
    follow(side);
  };
  const onSource = onScroll('source'), onPreview = onScroll('preview');
  // Enter, Backspace, undo and paste are handled on keydown/paste (which suppress beforeinput), so listen for all of them.
  const typing = () => { leader = 'source'; };
  const typingEvents = ['keydown', 'beforeinput', 'paste', 'cut', 'drop', 'compositionstart'];
  const resize = new ResizeObserver(schedule), mutations = new MutationObserver(schedule);
  scroller.addEventListener('scroll', onSource, { passive: true });
  preview.addEventListener('scroll', onPreview, { passive: true });
  for (const type of typingEvents) source.contentDOM.addEventListener(type, typing);
  preview.addEventListener('load', schedule, true);
  for (const node of [scroller, source.contentDOM, preview, preview.firstElementChild].filter((node): node is Element => !!node)) resize.observe(node);
  mutations.observe(preview, { childList: true, subtree: true, characterData: true });
  segments = buildSegments(source, preview);
  place();
  return () => {
    cancelAnimationFrame(frame); clearTimeout(idle);
    scroller.removeEventListener('scroll', onSource);
    preview.removeEventListener('scroll', onPreview);
    for (const type of typingEvents) source.contentDOM.removeEventListener(type, typing);
    preview.removeEventListener('load', schedule, true);
    resize.disconnect(); mutations.disconnect();
  };
}
