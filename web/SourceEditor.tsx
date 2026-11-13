import { useEffect, useRef, type MutableRefObject } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--primary)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--primary)' },
  { tag: [tags.monospace, tags.quote], color: 'var(--muted-foreground)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--muted-foreground)' },
  // Code inside fences, in Sidecar's code tokens (defined in app.css).
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  { tag: [tags.comment, tags.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.propertyName, tags.attributeName], color: 'var(--code-function)' },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], color: 'var(--code-type)' },
  { tag: [tags.definition(tags.variableName), tags.labelName], color: 'var(--foreground)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--code-punctuation)' },
  { tag: tags.invalid, color: 'var(--code-invalid)' },
]);

const fence = (name: string, alias: string[], support: LanguageSupport) => LanguageDescription.of({ name, alias, support });
const codeLanguages = [
  fence('javascript', ['js', 'jsx', 'mjs', 'cjs'], javascript({ jsx: true })),
  fence('typescript', ['ts', 'tsx', 'mts', 'cts'], javascript({ jsx: true, typescript: true })),
  fence('json', ['jsonc', 'json5'], json()),
  fence('python', ['py'], python()),
  fence('yaml', ['yml'], yaml()),
  fence('css', [], css()),
  fence('html', ['htm'], html()),
  fence('shell', ['sh', 'bash', 'zsh', 'console'], new LanguageSupport(StreamLanguage.define(shell))),
];

/** One CodeMirror view per mount: Markdown source, history, wrapped lines, no gutter. */
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
        history(), keymap.of([...defaultKeymap, ...historyKeymap]), markdown({ codeLanguages }), syntaxHighlighting(markdownStyle), EditorView.lineWrapping,
        EditorView.updateListener.of(update => { if (update.docChanged) change.current(update); }),
        ...extensions,
      ] }),
    });
    viewRef.current = view;
    return () => { view.destroy(); if (viewRef.current === view) viewRef.current = null; };
  }, []);
  return <div className="source-editor" ref={host} />;
}
