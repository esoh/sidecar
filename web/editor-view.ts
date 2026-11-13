import type { Extension } from '@codemirror/state';
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
