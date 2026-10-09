export function confirmCloseDocument(title: string): boolean {
  return window.confirm(`Close “${title}”?\n\nThis permanently deletes all threads, messages, highlights, and saved revisions for this document. Your Markdown file stays untouched. This cannot be undone.`);
}

export function confirmCloseAllDocuments(agent: string, count: number): boolean {
  return window.confirm(`Close all ${count} ${count === 1 ? 'document' : 'documents'} for “${agent}”?\n\nThis permanently deletes their threads, messages, highlights, proposals, and saved revisions, including queued and unfinished Sidecar requests.\n\nYour Markdown files and agent session stay untouched. Work already delivered to the agent may continue. This cannot be undone.`);
}
