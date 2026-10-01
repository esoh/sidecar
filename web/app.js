/** @typedef {import('../src/store.ts').Quote} Quote */
/** @typedef {import('../src/store.ts').Thread} Thread */
/** @typedef {import('../src/store.ts').RequestRecord} RequestRecord */
/** @param {string} text @param {Quote} quote */
export function locateQuote(text, quote) {
  if (!quote.exact) return null;
  const matches = [];
  for (let at = text.indexOf(quote.exact); at !== -1; at = text.indexOf(quote.exact, at + 1)) {
    const end = at + quote.exact.length;
    if (text.slice(Math.max(0, at - quote.prefix.length), at) === quote.prefix && text.slice(end, end + quote.suffix.length) === quote.suffix) matches.push({ start: at, end });
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}
/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] */
function element(tag, text = '') { const result = document.createElement(tag); result.textContent = text; return result; }
/** @param {string} id */
function required(id) { const result = document.getElementById(id); if (!result) throw new Error(`Missing ${id}`); return result; }
/** @template {HTMLElement} T @param {string} id @param {new() => T} Type */
function control(id, Type) { const value = required(id); if (!(value instanceof Type)) throw new Error(`Invalid ${id}`); return value; }
/** @param {string} path @param {unknown} [body] @param {string} [method] */
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed: ${response.status}`);
  return result;
}
function initialize() {
  const article = required('document'), nav = required('documents'), status = required('status'), error = required('error'), documentError = required('document-error'), preview = required('selection-preview'), threads = required('threads');
  const titleInput = control('title', HTMLInputElement), questionInput = control('question', HTMLTextAreaElement), questionForm = control('question-form', HTMLFormElement), send = control('send', HTMLButtonElement);
  let documentId = new URL(location.href).searchParams.get('document') ?? '';
  let version = '';
  let titleDraft = false;
  let refreshing = false, refreshAgain = false, connected = false;
  /** @type {Quote | undefined} */ let selection;
  /** @type {Map<string, ReturnType<typeof createThread>>} */ const threadViews = new Map();
  /** @param {() => Promise<unknown>} operation */
  function run(operation) { void operation().catch(reason => { error.textContent = reason instanceof Error ? reason.message : String(reason); }); }
  function clearSelection() { selection = undefined; preview.textContent = 'Whole document'; }
  required('clear-selection').onclick = clearSelection;
  function captureSelection() {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) { clearSelection(); return; }
    const before = document.createRange(); before.selectNodeContents(article); before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    before.setEnd(range.endContainer, range.endOffset);
    const end = before.toString().length, text = article.textContent ?? '';
    const exact = text.slice(start, end);
    if (!exact.trim()) { clearSelection(); return; }
    selection = { exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start, end, version };
    preview.textContent = exact;
  }
  document.addEventListener('mouseup', captureSelection);
  article.addEventListener('keyup', captureSelection);
  titleInput.oninput = () => { titleDraft = true; };
  required('title-form').onsubmit = event => {
    event.preventDefault(); const title = titleInput.value;
    run(async () => { await api(`/api/documents/${documentId}/title`, { title }, 'PATCH'); if (titleInput.value === title) titleDraft = false; await refresh(); });
  };
  /** @param {HTMLFormElement} form @param {HTMLTextAreaElement} input @param {HTMLButtonElement} button @param {string} [threadId] */
  function bindQuestion(form, input, button, threadId) {
    /** @type {{signature: string, id: string} | undefined} */ let retry;
    form.onsubmit = event => {
      event.preventDefault();
      if (button.disabled || !input.value.trim() || !documentId) return;
      const body = { documentId, text: input.value, ...(threadId ? { threadId } : selection ? { quote: selection } : {}) };
      const signature = JSON.stringify(body);
      if (retry?.signature !== signature) retry = { signature, id: crypto.randomUUID() };
      const clientMessageId = retry.id;
      button.disabled = true;
      run(async () => {
        try {
          await api('/api/questions', { ...body, clientMessageId });
          if (input.value === body.text) input.value = '';
          retry = undefined; if (!threadId) clearSelection(); error.textContent = '';
          await refresh();
        } finally { button.disabled = false; }
      });
    };
  }
  bindQuestion(questionForm, questionInput, send);
  /** @param {Thread} thread */
  function createThread(thread) {
    const fieldset = element('fieldset'), legend = element('legend', thread.scope === 'passage' ? 'Passage thread' : 'Document thread');
    const quote = element('blockquote'), anchorStatus = element('p'), messages = element('div'), pending = element('p');
    const draft = element('p'), draftText = element('span'); draft.append(element('strong', 'Agent (streaming): '), draftText); draft.hidden = true;
    const resolve = element('button'); resolve.type = 'button';
    resolve.onclick = () => run(async () => { await api(`/api/threads/${thread.id}/resolution`, { isResolved: resolve.textContent === 'Resolve' }); await refresh(); });
    const form = element('form'), label = element('label', 'Follow-up'), input = element('textarea'), button = element('button', 'Send follow-up');
    input.id = `follow-up-${thread.id}`; input.required = true; label.htmlFor = input.id;
    form.append(label, element('br'), input, element('br'), button); bindQuestion(form, input, button, thread.id);
    fieldset.append(legend, quote, anchorStatus, messages, draft, pending, resolve, form); threads.append(fieldset);
    return { fieldset, quote, anchorStatus, messages, draft, draftText, pending, resolve, messageIds: '' };
  }
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const state = await api('/api/state');
        const documents = Object.values(state.documents);
        if (!documentId) documentId = documents[0]?.id ?? '';
        nav.replaceChildren();
        for (const item of documents) { const link = element('a', item.title); link.href = `/?document=${item.id}`; nav.append(link, document.createTextNode(' ')); }
        const current = state.documents[documentId];
        status.textContent = !connected ? 'Disconnected from Sidecar; reconnecting…' : state.connectionError ?? (state.activity === 'compacting' ? 'Compacting context' : state.activity === 'responding' ? 'Agent is responding.' : 'Waiting for agent.');
        if (!current) { documentError.textContent = 'Open a document from your agent.'; send.disabled = true; continue; }
        document.title = current.title;
        if (!titleDraft) titleInput.value = current.title;
        documentError.textContent = current.error ?? '';
        if (version !== current.version || !version) {
          try {
            const content = await api(`/api/documents/${documentId}`);
            // Only server-rendered, escaped Markdown enters innerHTML; all comments use textContent.
            article.innerHTML = content.html; version = content.version;
            documentError.textContent = '';
          } catch (reason) { documentError.textContent = reason instanceof Error ? reason.message : String(reason); }
        }
        if (selection) preview.textContent = selection.exact + (current.error || !locateQuote(article.textContent ?? '', selection) ? ' (Passage changed.)' : '');
        for (const thread of /** @type {Thread[]} */ (Object.values(state.threads))) {
          if (thread.documentId !== documentId) continue;
          let view = threadViews.get(thread.id);
          if (!view) { view = createThread(thread); threadViews.set(thread.id, view); }
          view.quote.textContent = thread.quote?.exact ?? 'Whole document';
          view.anchorStatus.textContent = thread.quote && (current.error || !locateQuote(article.textContent ?? '', thread.quote)) ? 'Passage changed.' : '';
          view.resolve.textContent = thread.isResolved ? 'Reopen' : 'Resolve';
          const ids = thread.messages.map(message => message.id).join();
          if (ids !== view.messageIds) {
            view.messages.replaceChildren();
            for (const message of thread.messages) {
              const row = element('p'); row.append(element('strong', message.role === 'user' ? 'You: ' : 'Agent: '), element('span', message.text)); view.messages.append(row);
            }
            view.messageIds = ids;
          }
          const stream = state.stream?.threadId === thread.id ? state.stream : null;
          view.draft.hidden = !stream?.text;
          view.draftText.textContent = stream?.text ?? '';
          const pending = /** @type {RequestRecord[]} */ (Object.values(state.requests)).filter(request => request.threadId === thread.id && request.status !== 'completed');
          view.pending.textContent = pending.map(request => ({ queued: 'Queued; waiting for agent.', claimed: 'Agent is responding.', uncertain: 'Interrupted request; agent must check before retrying.', failed: 'Request failed.', completed: '' })[request.status]).join(' ') + (stream?.error ? ` ${stream.error}` : '');
        }
      } while (refreshAgain);
    } finally { refreshing = false; }
  }
  const events = new EventSource('/api/events');
  events.onopen = () => { connected = true; run(refresh); };
  events.onerror = () => { connected = false; status.textContent = 'Disconnected from Sidecar; reconnecting…'; };
  events.addEventListener('change', () => run(refresh));
  run(refresh);
}
if (typeof document !== 'undefined') initialize();
