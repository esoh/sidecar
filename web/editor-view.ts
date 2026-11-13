import { EditorSelection, StateEffect, StateField, Transaction, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import type { Quote } from '../src/store.ts';
import { sourceQuote } from './selection.ts';

export function topVisibleLine(view: EditorView): number {
  return view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
}

export function scrollToLine(view: EditorView, line: number): void {
  const { from } = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 0 }) });
}

/** Centers the range in the viewport (its start, when it is taller than the editor). */
export function revealRange(view: EditorView, from: number, to: number): void {
  view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.range(from, to), { y: 'center' }) });
}

export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from[start] === to[start]) start++;
  let end = 0;
  while (end < max - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

// Agent text enters the document without becoming an undo step, so Undo never removes it.
export function applyExternalText(view: EditorView, text: string): void {
  const change = minimalChange(view.state.doc.toString(), text);
  if (change) view.dispatch({ changes: change, annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] });
}

/** The selected source text as a Markdown quote of `version`'s source (null for a blank or oversized selection). */
export function quoteOfSelection(state: EditorState, version: string): Quote | null {
  const { from, to } = state.selection.main, exact = state.sliceDoc(from, to);
  if (!exact.trim() || exact.length > 128 * 1024) return null;
  return sourceQuote(state.doc.toString(), from, to, version);
}

/** The selection's quote with the viewport box the selection toolbar anchors to. */
export function selectionQuote(view: EditorView, version: string): { quote: Quote; rect: DOMRect } | null {
  const quote = quoteOfSelection(view.state, version);
  const start = view.coordsAtPos(view.state.selection.main.from), end = view.coordsAtPos(view.state.selection.main.to);
  if (!quote || !start || !end) return null;
  const left = Math.min(start.left, end.left), top = Math.min(start.top, end.top);
  return { quote, rect: new DOMRect(left, top, Math.max(start.right, end.right) - left, Math.max(start.bottom, end.bottom) - top) };
}

// The pending selection's range follows later edits, so typing elsewhere does not break its quote.
export type TrackedRange = { from: number; to: number; exact: string };
export const setTracked = StateEffect.define<TrackedRange | null>();
export const trackedRange = StateField.define<TrackedRange | null>({
  create: () => null,
  update(range, tr) {
    for (const effect of tr.effects) if (effect.is(setTracked)) range = effect.value;
    return range && tr.docChanged ? { ...range, from: tr.changes.mapPos(range.from, 1), to: tr.changes.mapPos(range.to, -1) } : range;
  },
});
/** The tracked range as a quote of `version`, or null once its text was edited away. */
export function trackedQuote(state: EditorState, version: string): Quote | null {
  const range = state.field(trackedRange), text = state.doc.toString();
  return range && range.from < range.to && text.slice(range.from, range.to) === range.exact ? sourceQuote(text, range.from, range.to, version) : null;
}

export const setQuoteMarks = StateEffect.define<Array<{ from: number; to: number; id: string; active?: boolean }>>();
// Decorations only: the document text is never touched. Edits move the marks along until they are recomputed.
export function quoteMarks(): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(marks, tr) {
      marks = marks.map(tr.changes);
      for (const effect of tr.effects) if (effect.is(setQuoteMarks))
        marks = Decoration.set(effect.value.filter(({ from, to }) => from < to && to <= tr.state.doc.length)
          .map(({ from, to, id, active }) => Decoration.mark({ class: active ? 'edit-quote edit-quote-active' : 'edit-quote', attributes: { 'data-quote-id': id } }).range(from, to)), true);
      return marks;
    },
    provide: field => EditorView.decorations.from(field),
  });
}
