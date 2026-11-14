// Cmd+Backslash on a Mac, Ctrl+Backslash elsewhere: shows or hides the conversation sidebar from any focus.
// HTML frames forward the same key through shortcutHelper in src/html-bridge.ts; keep the two in step.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const conversationShortcut = { label: isMac ? '⌘\\' : 'Ctrl+\\', aria: isMac ? 'Meta+\\' : 'Control+\\' };
// Ctrl/Cmd+comma opens Settings (AppMenu accepts either modifier).
export const settingsShortcut = { label: isMac ? '⌘,' : 'Ctrl+,', aria: 'Meta+Comma Control+Comma' };
export const isConversationShortcut = (event: KeyboardEvent) => event.code === 'Backslash' && !event.repeat && !event.isComposing && !event.shiftKey && !event.altKey
  && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
// Only a Sidecar HTML frame currently in this page may forward the shortcut.
export const isFrameShortcut = (event: MessageEvent) => {
  const data: unknown = event.data;
  return typeof data === 'object' && data !== null && 'sidecar' in data && data.sidecar === 'html-shortcut' && 'type' in data && data.type === 'toggle-conversations'
    && !!event.source && [...document.querySelectorAll<HTMLIFrameElement>('iframe.file-preview-frame')].some(frame => frame.contentWindow === event.source);
};
