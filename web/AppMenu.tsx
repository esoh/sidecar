import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './conversations.tsx';
import { TextSettings } from './TextSettings.tsx';
import { libraryPath } from './viewer-path.ts';
import { settingsShortcut } from './shortcuts.ts';

export type FormatAction = { busy: boolean; disabledReason?: string; run: () => Promise<void> };

// The app bar's one menu: Format (edit mode), the document library and Settings.
export function AppMenu({ version, format, library, children }: { version?: string; format?: FormatAction | null; library?: boolean; children?: ReactNode }) {
  const [isOpen, setOpen] = useState(false), [isSettingsOpen, setSettingsOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), returnTo = useRef<HTMLElement | null>(null);
  const items = () => [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []];
  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  const openSettings = () => { setOpen(false); setSettingsOpen(true); };
  useEffect(() => { if (isOpen) items()[0]?.focus(); }, [isOpen]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      // Not on top of another modal (unsaved changes, lightbox, proposal review); Settings itself is already open then.
      if ((event.metaKey || event.ctrlKey) && event.key === ',' && !event.repeat && !event.isComposing && !document.querySelector('dialog:modal')) {
        event.preventDefault(); returnTo.current = document.activeElement as HTMLElement | null; openSettings();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!isOpen) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest('.menu-wrap')) setOpen(false); };
    // A click into the HTML page's iframe never reaches this document, but it blurs the window.
    const leave = () => setOpen(false), out = (event: FocusEvent) => { if (event.relatedTarget && !(event.relatedTarget as Element).closest('.menu-wrap')) setOpen(false); };
    const wrap = button.current?.closest('.menu-wrap');
    document.addEventListener('pointerdown', away); window.addEventListener('blur', leave); wrap?.addEventListener('focusout', out as EventListener);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('blur', leave); wrap?.removeEventListener('focusout', out as EventListener); };
  }, [isOpen]);
  function onKeyDown(event: KeyboardEvent) {
    const list = items(), at = list.indexOf(document.activeElement as HTMLElement), move = (to: number) => { event.preventDefault(); list[(to + list.length) % list.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close();
  }
  const formatDisabled = !!format && (format.busy || !!format.disabledReason);
  return <div className="menu-wrap">
    <button ref={button} className="sidebar-toggle menu-toggle" aria-label="Menu" title="Menu" aria-haspopup="menu" aria-expanded={isOpen} aria-controls={isOpen ? 'app-menu' : undefined}
      onClick={() => setOpen(open => !open)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
      <Icon name="more" />
    </button>
    {isOpen && <div ref={menu} id="app-menu" className="app-menu" role="menu" aria-label="Menu" onKeyDown={onKeyDown}>
      {format && <>
        <button role="menuitem" aria-disabled={formatDisabled || undefined} title={format.disabledReason}
          onClick={async () => { if (formatDisabled) return; await format.run(); close(!!menu.current?.contains(document.activeElement)); }}>
          <Icon name="format" /><span>Format<small>{format.busy ? 'Loading Prettier…' : format.disabledReason ?? 'Tidy Markdown with Prettier'}</small></span>
        </button>
        <hr />
      </>}
      {!library && <a role="menuitem" href={libraryPath()} target="_blank" rel="noopener" onClick={() => close(false)}><Icon name="library" /><span>View all documents</span></a>}
      <button role="menuitem" aria-keyshortcuts={settingsShortcut.aria} onClick={() => { returnTo.current = null; openSettings(); }}><Icon name="settings" /><span>Settings</span><kbd aria-hidden="true">{settingsShortcut.label}</kbd></button>
    </div>}
    <TextSettings version={version} open={isSettingsOpen} onClose={() => { setSettingsOpen(false); const back = returnTo.current?.isConnected ? returnTo.current : button.current; returnTo.current = null; back?.focus(); }}>{children}</TextSettings>
  </div>;
}
