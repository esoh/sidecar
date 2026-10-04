export function confirmCloseDocument(title: string): boolean {
  return window.confirm(`Close “${title}”?\n\nThis permanently deletes all threads, messages, highlights, and saved revisions for this document. Your Markdown file stays untouched. This cannot be undone.`);
}
