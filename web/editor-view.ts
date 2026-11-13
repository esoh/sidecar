import { Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

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
