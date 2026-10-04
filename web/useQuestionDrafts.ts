import { useEffect, useMemo, useState } from 'react';
import { isQuote, isMessageQuote, isFileQuote, type FileQuote, type MessageQuote, type Quote } from '../src/quote.ts';

export type QuestionDraft = { text: string; retry: { signature: string; id: string } | null; quote?: Quote; messageQuote?: MessageQuote; fileQuote?: FileQuote };
export type QuestionDrafts = {
  get(id: string): QuestionDraft | undefined;
  set(id: string, draft: QuestionDraft): void;
  remove(id: string, expected?: QuestionDraft): void;
  flush(): void;
  error: string;
};
const closedDocuments = new Set<string>();
export function forgetDocument(documentId: string, threadIds: string[]): string | undefined {
  closedDocuments.add(documentId);
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === `sidecar-folds:${documentId}` || key.startsWith(`sidecar-draft:${documentId}:`) || threadIds.some(id => key === `sidecar-read-reply:${id}`)) localStorage.removeItem(key);
    }
    localStorage.setItem(`sidecar-closed-document:${documentId}`, '1');
    sessionStorage.removeItem(`sidecar-thread:${documentId}`);
  } catch { return 'Document closed, but browser drafts could not be fully cleared in this browser.'; }
}
function readDraft(key: string): QuestionDraft | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved !== 'object' || !('text' in saved) || typeof saved.text !== 'string' || !('retry' in saved)) return;
    const fileQuote = 'fileQuote' in saved && isFileQuote(saved.fileQuote) ? saved.fileQuote : undefined;
    const messageQuote = !fileQuote && 'messageQuote' in saved && isMessageQuote(saved.messageQuote) ? saved.messageQuote : undefined;
    const quote = !messageQuote && 'quote' in saved && isQuote(saved.quote) ? saved.quote : undefined;
    const attachment = fileQuote ? { fileQuote } : messageQuote ? { messageQuote } : quote ? { quote } : {};
    if (saved.retry === null) return { text: saved.text, retry: null, ...attachment };
    const retry = saved.retry;
    if (retry && typeof retry === 'object' && 'signature' in retry && typeof retry.signature === 'string' && 'id' in retry && typeof retry.id === 'string')
      return { text: saved.text, retry: { signature: retry.signature, id: retry.id }, ...attachment };
  } catch { /* Keep in-memory drafts usable without browser storage. */ }
}
export function useQuestionDrafts(documentId: string): QuestionDrafts {
  const [, render] = useState(0), [error, setError] = useState('');
  const drafts = useMemo(() => {
    const values = new Map<string, QuestionDraft | undefined>(), dirty = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined, since = 0;
    const key = (id: string) => `sidecar-draft:${documentId}:${id}`;
    const flush = () => {
      clearTimeout(timer);
      if (!dirty.size) return;
      try {
        if (closedDocuments.has(documentId) || localStorage.getItem(`sidecar-closed-document:${documentId}`)) { dirty.clear(); return; }
        for (const id of dirty) {
          const draft = values.get(id);
          if (draft?.text || draft?.quote || draft?.messageQuote || draft?.fileQuote) localStorage.setItem(key(id), JSON.stringify(draft));
          else localStorage.removeItem(key(id));
        }
        dirty.clear(); setError('');
      } catch { setError('Draft could not be saved in this browser. Keep this tab open.'); }
    };
    return {
      get(id: string) { if (!values.has(id)) values.set(id, readDraft(key(id))); return values.get(id); },
      set(id: string, draft: QuestionDraft) {
        values.set(id, draft);
        if (!dirty.size) since = Date.now();
        dirty.add(id); clearTimeout(timer);
        timer = setTimeout(flush, Math.max(0, Math.min(100, 2000 - (Date.now() - since))));
        render(n => n + 1);
      },
      remove(id: string, expected?: QuestionDraft) {
        if (expected && values.get(id) !== expected) return;
        values.set(id, undefined); dirty.delete(id);
        try {
          if (!expected || localStorage.getItem(key(id)) === JSON.stringify(expected)) localStorage.removeItem(key(id));
          setError('');
        } catch { setError('Sent, but the saved draft could not be cleared in this browser.'); }
        render(n => n + 1);
      },
      flush,
    };
  }, [documentId]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') drafts.flush(); };
    window.addEventListener('pagehide', drafts.flush); document.addEventListener('visibilitychange', hidden);
    return () => { drafts.flush(); window.removeEventListener('pagehide', drafts.flush); document.removeEventListener('visibilitychange', hidden); };
  }, [drafts]);
  return useMemo(() => ({ ...drafts, error }), [drafts, error]);
}
