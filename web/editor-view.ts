import { EditorSelection, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import type { FileQuote } from '../src/quote.ts';

// The editor package owns its view; this hands it to the host for as long as the document is mounted.
export function viewCapture(ref: { current: EditorView | null }): Extension {
  return ViewPlugin.define(view => {
    ref.current = view;
    return { destroy() { if (ref.current === view) ref.current = null; } };
  });
}

export function topVisibleLine(view: EditorView): number {
  return view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
}

export function scrollToLine(view: EditorView, line: number): void {
  const { from } = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'start' }) });
}

/** Centers the lines' span in the viewport (its start, when the span is taller than the editor). */
export function revealLineRange(view: EditorView, start: number, end: number): void {
  const at = (line: number) => view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.range(at(start).from, at(Math.max(start, end)).to), { y: 'center' }) });
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
  if (change) view.dispatch({ changes: change, annotations: Transaction.addToHistory.of(false) });
}

/** The editor's selected source text as a line quote, with the viewport box the selection toolbar anchors to. */
export function selectionQuote(view: EditorView, path: string): { quote: FileQuote; rect: DOMRect } | null {
  const { from, to } = view.state.selection.main, exact = view.state.sliceDoc(from, to);
  if (!exact.trim() || exact.length > 128 * 1024) return null;
  const start = view.coordsAtPos(from), end = view.coordsAtPos(to);
  if (!start || !end) return null;
  const left = Math.min(start.left, end.left), top = Math.min(start.top, end.top);
  return {
    quote: { path, kind: 'doc', exact, startLine: view.state.doc.lineAt(from).number, endLine: view.state.doc.lineAt(to).number },
    rect: new DOMRect(left, top, Math.max(start.right, end.right) - left, Math.max(start.bottom, end.bottom) - top),
  };
}

export const setQuoteMarks = StateEffect.define<Array<{ from: number; to: number; id: string }>>();
// Decorations only: the document text is never touched. Edits move the marks along until they are recomputed.
export function quoteMarks(): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(marks, tr) {
      marks = marks.map(tr.changes);
      for (const effect of tr.effects) if (effect.is(setQuoteMarks))
        marks = Decoration.set(effect.value.filter(({ from, to }) => from < to && to <= tr.state.doc.length)
          .map(({ from, to, id }) => Decoration.mark({ class: 'edit-quote', attributes: { 'data-quote-id': id } }).range(from, to)), true);
      return marks;
    },
    provide: field => EditorView.decorations.from(field),
  });
}
