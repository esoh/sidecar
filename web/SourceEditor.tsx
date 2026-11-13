import { useEffect, useRef, type MutableRefObject } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--primary)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--primary)' },
  { tag: [tags.monospace, tags.quote], color: 'var(--muted-foreground)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--muted-foreground)' },
]);

/** One CodeMirror view per mount : Markdown source, history, wrapped lines, no gutter. */
export function SourceEditor({ initial, extensions, onChange, viewRef }: {
  initial: string; extensions: Extension[];
  onChange: (update: ViewUpdate) => void;
  viewRef: MutableRefObject<EditorView | null>;
}) {
  const host = useRef<HTMLDivElement>(null), change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: initial, extensions: [
        history(), keymap.of([...defaultKeymap, ...historyKeymap]), markdown(), syntaxHighlighting(markdownStyle), EditorView.lineWrapping,
        EditorView.updateListener.of(update => { if (update.docChanged) change.current(update); }),
        ...extensions,
      ] }),
    });
    viewRef.current = view;
    return () => { view.destroy(); if (viewRef.current === view) viewRef.current = null; };
  }, []);
  return <div className="source-editor" ref={host} />;
}
