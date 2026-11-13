import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { MarkdownEditor, type MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';
import { errorText, saveSource } from './api.ts';
import { scrollToLine, topVisibleLine, viewCapture } from './editor-view.ts';

export type EditModeHandle = {
  isDirty(): boolean;
  save(): Promise<boolean>;
  /** Resolves true when edit mode was left (clean, or Save/Discard chosen) and false on Cancel. */
  requestExit(): Promise<boolean>;
  revealLines(start: number, end: number): void;
};
type Choice = 'save' | 'discard' | 'cancel';

export function MarkdownEditMode({ documentId, path, markdown, version, startLine, handleRef, onExit, onError, onStatus }: {
  documentId: string; path: string; markdown: string; version: string; startLine: number;
  handleRef: MutableRefObject<EditModeHandle | null>;
  onExit: (line: number) => void; onError: (message: string) => void;
  /** Dirty and saving state, shown by the app header's controls. */
  onStatus: (status: { dirty: boolean; saving: boolean }) => void;
}) {
  const [mountKey] = useState(0);
  const editor = useRef<MarkdownEditorHandle | null>(null), view = useRef<EditorView | null>(null);
  const synced = useRef(markdown), baseVersion = useRef(version), saving = useRef(false), dirtyNow = useRef(false);
  const [dirty, setDirty] = useState(false), [asking, setAsking] = useState(false), [isSaving, setSaving] = useState(false);
  const choose = useRef<((choice: Choice) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const markDirty = (value: boolean) => { dirtyNow.current = value; setDirty(value); };

  const save = useCallback(async () => {
    const text = editor.current?.getMarkdown();
    if (text === undefined || saving.current) return false;
    if (text === synced.current) { markDirty(false); return true; }
    saving.current = true; setSaving(true);
    try {
      baseVersion.current = (await saveSource(documentId, text, baseVersion.current)).version;
      synced.current = text;
      markDirty(editor.current?.getMarkdown() !== text);
      return true;
    } catch (reason) { onError(errorText(reason)); return false; }
    finally { saving.current = false; setSaving(false); }
  }, [documentId, onError]);
  const leave = useCallback(() => {
    onExit(view.current ? topVisibleLine(view.current) : startLine);
  }, [onExit, startLine]);
  const requestExit = useCallback(async () => {
    if (!dirtyNow.current) { leave(); return true; }
    const choice = await new Promise<Choice>(resolve => { choose.current = resolve; setAsking(true); });
    setAsking(false);
    if (choice === 'cancel' || (choice === 'save' && !await save())) return false;
    dirtyNow.current = false;
    leave();
    return true;
  }, [leave, save]);
  useImperativeHandle(handleRef, () => ({
    isDirty: () => dirtyNow.current, save, requestExit,
    revealLines: start => { if (view.current) scrollToLine(view.current, start); },
  }), [save, requestExit]);
  useEffect(() => () => { handleRef.current = null; }, [handleRef]);

  useEffect(() => { onStatus({ dirty, saving: isSaving }); }, [dirty, isSaving]);
  useEffect(() => () => onStatus({ dirty: false, saving: false }), []);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (dirtyNow.current) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const mountId = `${documentId}:${mountKey}`;
  const extensions = useMemo(() => [
    viewCapture(view),
    Prec.high(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void save(); return true; } }])),
  ], [mountId]);
  // Open at the reading position as soon as the engine has created its view.
  useEffect(() => {
    if (startLine <= 1) return;
    let frame = 0, tries = 0;
    const apply = () => {
      if (view.current) scrollToLine(view.current, startLine);
      else if (++tries < 60) frame = requestAnimationFrame(apply);
    };
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [mountId]);

  return (
    <div className="markdown-edit-mode">
      <MarkdownEditor
        markdown={markdown}
        documentId={mountId}
        editorHandleRef={editor}
        onMarkdownChange={text => markDirty(text !== synced.current)}
        mode="dark"
        maxWidth={null}
        extensions={extensions}
      />
      {asking && (
        <dialog ref={dialog} className="markdown-edit-leave" aria-label="Unsaved changes"
          onCancel={event => { event.preventDefault(); choose.current?.('cancel'); }}>
          <p>You have unsaved changes.</p>
          <div>
            <button onClick={() => choose.current?.('save')}>Save</button>
            <button onClick={() => choose.current?.('discard')}>Discard</button>
            <button onClick={() => choose.current?.('cancel')}>Cancel</button>
          </div>
        </dialog>
      )}
    </div>
  );
}
