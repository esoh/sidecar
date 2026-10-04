import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Thread } from '../src/store.ts';
import { Icon, MessageContent, PinSymbol, type MessageContentProps } from './conversations.tsx';
import { useMessageSettings } from './TextSettings.tsx';
import { messagePreview } from './message-copy.ts';
import { FilePreview, type OpenFile } from './FilePreview.tsx';
import type { FileQuote } from '../src/quote.ts';

type WindowPosition = { id: string; x: number; y: number; width: number; height: number; layer: number };
type Point = { x: number; y: number };
type DockPreview = { id: string; index: number };
type WindowEntry = { id: string; label: string } & (
  { kind: 'message'; threadId: string; message: Thread['messages'][number] } |
  { kind: 'file'; file: OpenFile }
);
const margin = 0, barHeight = 38, minDockHeight = 140;
function clampWindow(value: WindowPosition): WindowPosition {
  const width = Math.min(value.width, innerWidth - margin * 2), height = Math.min(value.height, innerHeight - margin * 2);
  return { ...value, width, height, x: Math.max(margin, Math.min(value.x, innerWidth - width - margin)), y: Math.max(margin, Math.min(value.y, innerHeight - height - margin)) };
}

export function PinnedWindows({ workspace, threads, files, root, documentId, openRequests, onOpened, onCloseFile, onQuoteFile, onRevealFile, onGoToMessage, ...contentProps }: {
  workspace: RefObject<HTMLDivElement | null>; threads: Thread[]; documentId: string;
  files: OpenFile[]; root?: string; onCloseFile: (id: string) => void;
  onQuoteFile: (quote: FileQuote) => void;
  onRevealFile: (path: string) => void;
  openRequests: string[]; onOpened: (ids: string[]) => void;
  onGoToMessage: (id: string) => void;
} & Pick<MessageContentProps, 'activeSelectionId' | 'passageChanged' | 'showPassage' | 'showOriginal' | 'onQuoteMessage' | 'onOpenFileQuote'>) {
  // Array order records when a window was opened; docking, focus and tab order are independent.
  const [windows, setWindows] = useState<WindowPosition[]>([]);
  const [docked, setDocked] = useState<string[]>([]), [activeDock, setActiveDock] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true), [height, setHeight] = useState(310);
  const [preview, setPreview] = useState<DockPreview | null>(null);
  const [dragging, setDragging] = useState<string | null>(null), [ghost, setGhost] = useState<Point | null>(null);
  const dock = useRef<HTMLElement>(null), tabs = useRef<HTMLDivElement>(null);
  const layer = useRef(0), stopGesture = useRef<(() => void) | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const { windowMode } = useMessageSettings();
  const entries = useMemo<WindowEntry[]>(() => [
    ...threads.flatMap(thread => thread.messages.filter(message => message.isPinned).map(message => ({ kind: 'message' as const, id: message.id, label: messagePreview(message.text), threadId: thread.id, message }))),
    ...files.map(file => ({ kind: 'file' as const, id: file.id, label: file.path.split('/').pop() ?? file.path, file })),
  ], [threads, files]);
  const labels = new Map(entries.map(entry => [entry.id, entry.label]));
  const ids = JSON.stringify(entries.map(entry => entry.id));
  const find = (id: string) => entries.find(entry => entry.id === id);
  const isFile = (id: string) => find(id)?.kind === 'file';
  const filePath = (id: string) => {
    const entry = find(id);
    return entry?.kind === 'file' ? entry.file.path : undefined;
  };
  const symbol = (id: string) => {
    const entry = find(id);
    return entry?.kind === 'file' ? <Icon name="file" /> : <PinSymbol style={entry?.message.pinStyle} />;
  };
  useEffect(() => () => stopGesture.current?.(), []);
  useEffect(() => {
    const valid = new Set(entries.map(entry => entry.id));
    setWindows(previous => previous.filter(window => valid.has(window.id)));
    setDocked(previous => previous.filter(id => valid.has(id)));
  }, [ids]);
  useEffect(() => {
    if (windowMode !== 'single') return;
    stopGesture.current?.();
    setWindows(previous => previous.slice(-1));
  }, [windowMode]);
  const windowIds = JSON.stringify(windows.map(window => window.id));
  useEffect(() => {
    const valid = new Set(windows.map(window => window.id));
    setDocked(previous => previous.filter(id => valid.has(id)));
  }, [windowIds]);
  useEffect(() => {
    const ready = openRequests.filter(id => find(id));
    if (!ready.length) return;
    const last = ready[ready.length - 1];
    pendingFocus.current = last;
    if (docked.includes(last)) { setActiveDock(last); setExpanded(true); }
    const bounds = workspace.current?.getBoundingClientRect();
    const layers = new Map(ready.map(id => [id, ++layer.current]));
    setWindows(previous => ready.reduce((current, id) => {
      const nextLayer = layers.get(id) ?? 0;
      if (current.some(window => window.id === id)) return current.map(window => window.id === id ? { ...window, layer: nextLayer } : window);
      const width = isFile(id) ? Math.min(620, Math.max(240, (bounds?.width ?? innerWidth) - 40)) : 410;
      const window = clampWindow({ id, x: (bounds?.right ?? innerWidth) - width - 20 + current.length % 4 * 18, y: 80 + current.length % 4 * 24, width, height: isFile(id) ? 480 : 330, layer: nextLayer });
      return [...(windowMode === 'single' ? [] : current), window];
    }, previous));
    onOpened(ready);
  }, [openRequests, ids]);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const target = document.getElementById(`reference-${id}`) ?? document.getElementById(`dock-tab-${id}`);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  }, [windows, expanded, activeDock]);
  useLayoutEffect(() => {
    const resize = () => setWindows(previous => previous.map(clampWindow));
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
  }, []);

  function updateWindow(id: string, change: Partial<WindowPosition>) {
    setWindows(previous => previous.map(window => window.id === id ? clampWindow({ ...window, ...change }) : window));
  }
  function raise(id: string) { updateWindow(id, { layer: ++layer.current }); }
  function close(id: string) {
    setWindows(previous => previous.filter(window => window.id !== id));
    setDocked(previous => previous.filter(value => value !== id));
    if (isFile(id)) onCloseFile(id);
  }
  function moveOut(id: string, point?: Point) {
    setDocked(previous => previous.filter(value => value !== id));
    const bounds = workspace.current?.getBoundingClientRect();
    const width = windows.find(window => window.id === id)?.width ?? 410;
    updateWindow(id, { x: point ? point.x - 120 : (bounds?.right ?? innerWidth) - width - 20, y: point ? point.y - 18 : 85, layer: ++layer.current });
  }
  function moveIn(id: string, index = docked.length) {
    setDocked(previous => { const next = previous.filter(value => value !== id); next.splice(index, 0, id); return next; });
    setActiveDock(id);
  }
  function gap(x: number, excluded: string) {
    const items = Array.from(tabs.current?.querySelectorAll<HTMLElement>('[data-dock-tab]') ?? []).filter(node => node.dataset.dockTab !== excluded);
    const index = items.findIndex(node => { const rect = node.getBoundingClientRect(); return x < rect.left + rect.width / 2; });
    return index < 0 ? items.length : index;
  }
  function dockBounds(isEmpty = visibleDock.length === 0) {
    const bounds = workspace.current?.getBoundingClientRect();
    if (!bounds) return new DOMRect();
    const dockHeight = expanded ? Math.min(isEmpty ? minDockHeight : height, Math.max(barHeight, bounds.height - 50)) : barHeight;
    return new DOMRect(bounds.left, bounds.bottom - dockHeight, bounds.width, dockHeight);
  }
  function listen(event: ReactPointerEvent, move: (point: Point) => void, finish: (cancelled: boolean) => void) {
    event.preventDefault(); stopGesture.current?.();
    const previousCursor = document.body.style.cursor, previousSelection = document.body.style.userSelect;
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'grabbing';
    const onMove = (e: PointerEvent) => { if (e.pointerId === event.pointerId) move({ x: e.clientX, y: e.clientY }); };
    const end = (cancelled: boolean) => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onCancel);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelection;
      stopGesture.current = null; finish(cancelled);
    };
    const onUp = (e: PointerEvent) => { if (e.pointerId === event.pointerId) end(false); };
    const onCancel = () => end(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); end(true); } };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onCancel); window.addEventListener('keydown', onKey); window.addEventListener('blur', onCancel);
    stopGesture.current = onCancel;
  }
  function drag(event: ReactPointerEvent, value: WindowPosition, fromDock = false) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button:not([role="tab"]), .resize-edge'))) return;
    const start = { x: event.clientX, y: event.clientY }, bounds = dockBounds(), originalOrder = [...docked];
    let detached = !fromDock, started = !fromDock, target: DockPreview | null = null, offset = { x: start.x - value.x, y: start.y - value.y };
    raise(value.id);
    listen(event, point => {
      if (!started && Math.hypot(point.x - start.x, point.y - start.y) < 6) return;
      started = true; setDragging(value.id);
      if (!detached && (point.y < bounds.top - 28 || point.x < bounds.left - 28 || point.x > bounds.right + 28)) {
        detached = true; offset = { x: Math.min(120, value.width / 2), y: 18 }; moveOut(value.id, point); setGhost(null);
      }
      const targetBounds = detached && fromDock && originalOrder.length === 1 ? dockBounds(true) : bounds;
      const inside = point.x >= targetBounds.left && point.x <= targetBounds.right && point.y >= targetBounds.top && point.y <= targetBounds.bottom;
      target = inside ? { id: value.id, index: gap(point.x, value.id) } : null;
      setPreview(target);
      if (detached) updateWindow(value.id, { x: point.x - offset.x, y: point.y - offset.y });
      else setGhost({ x: Math.min(point.x + 12, innerWidth - 250), y: Math.max(8, point.y - 100) });
    }, cancelled => {
      if (cancelled) { setDocked(originalOrder); updateWindow(value.id, value); }
      else if (target) moveIn(value.id, target.index);
      setDragging(null); setGhost(null); setPreview(null);
    });
    if (started) setDragging(value.id);
  }
  function resize(event: ReactPointerEvent, value: WindowPosition, edge: string) {
    if (event.button !== 0) return;
    event.stopPropagation(); const start = { x: event.clientX, y: event.clientY };
    listen(event, point => {
      const dx = point.x - start.x, dy = point.y - start.y;
      const left = edge.includes('w') ? Math.max(margin, Math.min(value.x + dx, value.x + value.width - Math.min(240, innerWidth - margin * 2))) : value.x;
      const top = edge.includes('n') ? Math.max(margin, Math.min(value.y + dy, value.y + value.height - Math.min(160, innerHeight - margin * 2))) : value.y;
      const right = edge.includes('e') ? Math.min(innerWidth - margin, Math.max(value.x + 240, value.x + value.width + dx)) : value.x + value.width;
      const bottom = edge.includes('s') ? Math.min(innerHeight - margin, Math.max(value.y + 160, value.y + value.height + dy)) : value.y + value.height;
      updateWindow(value.id, { x: left, y: top, width: right - left, height: bottom - top });
    }, cancelled => { if (cancelled) updateWindow(value.id, value); });
  }
  const visibleDock = docked.filter(id => windows.some(window => window.id === id) && find(id));
  const dockContentHeight = visibleDock.length ? height : minDockHeight;
  const activeId = visibleDock.includes(activeDock ?? '') ? activeDock : visibleDock[0];
  const displayedId = preview?.id ?? activeId;
  const isDockOpen = expanded || !!preview;
  const displayTabs = preview ? visibleDock.filter(id => id !== preview.id) : visibleDock;
  const renderContent = (id: string, prefix: string) => {
    const entry = find(id);
    if (entry?.kind === 'file') return <FilePreview key={entry.id} {...entry.file} documentId={documentId} root={entry.file.root ?? root} onQuoteFile={onQuoteFile} onRevealFile={onRevealFile} />;
    return entry && <div className={`message ${entry.message.role}`}><MessageContent {...contentProps} {...entry} documentId={documentId} prefix={prefix} onGoToMessage={onGoToMessage} /></div>;
  };

  return <>
    {createPortal(<div className="reference-layer">{windows.filter(window => !docked.includes(window.id) && find(window.id)).map(value => (
      <section key={value.id} id={`reference-${value.id}`} className={`reference-window${dragging === value.id ? ' is-dragging' : ''}`} role="dialog" aria-label={isFile(value.id) ? `File: ${filePath(value.id)}` : 'Pinned message'} tabIndex={-1}
        style={{ left: value.x, top: value.y, width: value.width, height: value.height, zIndex: 20 + value.layer }} onPointerDown={() => raise(value.id)}>
        <header className="reference-titlebar" role="group" tabIndex={0} aria-label={isFile(value.id) ? 'Move file window' : 'Move pinned window'} onPointerDown={event => drag(event, value)} onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
            if (delta) { event.preventDefault(); updateWindow(value.id, event.shiftKey ? { width: Math.max(240, value.width + delta[0]), height: Math.max(160, value.height + delta[1]) } : { x: value.x + delta[0], y: value.y + delta[1] }); }
          }}>
          <div className="reference-grip" title={filePath(value.id)}>{symbol(value.id)}<span>{labels.get(value.id)}</span></div>
          <button aria-label="Minimize window" title="Minimize window" onClick={() => { moveIn(value.id); setExpanded(false); }}><Icon name="minimize" /></button>
          <button aria-label="Dock window" title="Dock window" onClick={() => { moveIn(value.id); setExpanded(true); }}><Icon name="dock" /></button>
          <button aria-label={isFile(value.id) ? 'Close file window' : 'Close pinned window'} title="Close window" onClick={() => close(value.id)}><Icon name="close" /></button>
        </header>
        <div className="reference-body">{renderContent(value.id, 'reference')}</div>
        {!isFile(value.id) && <footer className="reference-footer"><button onClick={() => onGoToMessage(value.id)}>Go to message<Icon name="arrowUpRight" /></button></footer>}
        {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => <div key={edge} className={`resize-edge resize-${edge}`} onPointerDown={event => resize(event, value, edge)} />)}
      </section>
    ))}</div>, document.body)}
    {(visibleDock.length > 0 || dragging) && <section ref={dock} className={`pinned-dock${isDockOpen ? ' is-expanded' : ''}${preview ? ' is-preview' : ''}`} aria-label="Window dock" style={isDockOpen ? { height: `min(${dockContentHeight}px, calc(100% - 50px))` } : undefined}>
      {isDockOpen && <div className="dock-resize" role="separator" tabIndex={0} aria-label="Resize dock" aria-orientation="horizontal" aria-valuenow={dockContentHeight} aria-valuemin={minDockHeight} aria-valuemax={Math.max(minDockHeight, innerHeight - 100)} onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setHeight(Math.max(minDockHeight, Math.min(innerHeight - 100, height + (event.key === 'ArrowUp' ? 20 : -20)))); }
      }} onPointerDown={event => {
        const start = event.clientY, original = height;
        listen(event, point => setHeight(Math.max(minDockHeight, Math.min((workspace.current?.clientHeight ?? innerHeight) - 50, original + start - point.y))), cancelled => { if (cancelled) setHeight(original); });
      }} />}
      <header className="dock-header" onPointerDown={event => {
        const value = windows.find(window => window.id === activeId);
        if (event.target === event.currentTarget && value) drag(event, value, true);
      }}>
        {isDockOpen ? <>
          <div className="dock-tabs" ref={tabs} role="tablist" aria-label="Docked windows">
            {Array.from({ length: displayTabs.length + 1 }, (_, index) => <div className="dock-tab-position" key={displayTabs[index] ?? 'end'}>
              {preview?.index === index && <span className="dock-insertion" />}
              {displayTabs[index] && (() => {
                const id = displayTabs[index], value = windows.find(window => window.id === id);
                return <div className="dock-tab-shell" data-dock-tab={id}>
                  <button role="tab" id={`dock-tab-${id}`} aria-selected={activeId === id} aria-controls={`dock-panel-${id}`} tabIndex={activeId === id ? 0 : -1}
                    onClick={() => setActiveDock(id)} onPointerDown={event => { if (value) drag(event, value, true); }}
                    onKeyDown={event => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const at = visibleDock.indexOf(id), next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleDock.length - 1 : Math.max(0, Math.min(visibleDock.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1)));
                      if (event.altKey) { moveIn(id, next); requestAnimationFrame(() => document.getElementById(`dock-tab-${id}`)?.focus()); }
                      else { const target = visibleDock[next]; setActiveDock(target); document.getElementById(`dock-tab-${target}`)?.focus(); }
                    }} title={filePath(id)}>{symbol(id)}<span>{labels.get(id)}</span></button>
                  <button aria-label="Move out of dock" title="Move out of dock" onClick={() => moveOut(id)}><Icon name="arrowUpRight" /></button>
                  <button aria-label={isFile(id) ? 'Close file window' : 'Close pinned window'} title="Close window" onClick={() => close(id)}><Icon name="close" /></button>
                </div>;
              })()}
            </div>)}
          </div>
          <button className="dock-toggle" aria-label="Collapse dock" aria-expanded="true" onClick={() => setExpanded(false)}><Icon name="chevron" /></button>
        </> : <button className="dock-collapsed" aria-label="Expand dock" aria-expanded="false" onClick={() => setExpanded(true)}><Icon name="dock" /><span>{visibleDock.length} {visibleDock.length === 1 ? 'window' : 'windows'}</span><Icon name="chevron" /></button>}
      </header>
      {isDockOpen && <div className="reference-body" role="tabpanel" id={`dock-panel-${displayedId}`} aria-labelledby={preview ? undefined : `dock-tab-${displayedId}`} aria-label={preview ? 'Dock preview' : undefined}>
        {displayedId ? renderContent(displayedId, 'dock') : <p className="dock-empty">Drop a window here</p>}
      </div>}
      {isDockOpen && displayedId && !preview && !isFile(displayedId) && <footer className="reference-footer"><button onClick={() => onGoToMessage(displayedId)}>Go to message<Icon name="arrowUpRight" /></button></footer>}
    </section>}
    {ghost && dragging && createPortal(<div className="dock-drag-preview" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true" inert>{renderContent(dragging, 'drag-preview')}</div>, document.body)}
  </>;
}
