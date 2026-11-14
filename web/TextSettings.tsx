import { isGateway } from './viewer-path.ts';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { Icon } from './conversations.tsx';
import type { CopyFormat } from './message-copy.ts';
import { api, errorText } from './api.ts';
import type { TunnelConfig } from '../src/tunnel-config.ts';

const MessageSettings = createContext({ copyFormat: 'markdown' as CopyFormat, windowMode: 'multiple', showIgnoredFiles: false, setShowIgnoredFiles: (_value: boolean) => {}, setCopyFormat: (_value: CopyFormat) => {}, setWindowMode: (_value: string) => {}, scrollSyncPosition: 25, setScrollSyncPosition: (_percent: number) => {} });
export const useMessageSettings = () => useContext(MessageSettings);
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [copyFormat, setCopy] = useState<CopyFormat>(() => {
    const saved = storage.getItem('sidecar-copy-format');
    return saved === 'rich' || saved === 'plain' ? saved : 'markdown';
  });
  const [windowMode, setMode] = useState(() => storage.getItem('sidecar-window-mode') === 'single' ? 'single' : 'multiple');
  const [syncPercent, setPercent] = useState(() => {
    const value = Number(storage.getItem('sidecar-scroll-sync-position'));
    return storage.getItem('sidecar-scroll-sync-position') && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value / 5) * 5)) : 25;
  });
  const [showIgnoredFiles, setIgnored] = useState(() => storage.getItem('sidecar-show-ignored-files') === 'true');
  return <MessageSettings.Provider value={{ copyFormat, windowMode, showIgnoredFiles, scrollSyncPosition: syncPercent,
    setShowIgnoredFiles: value => { storage.setItem('sidecar-show-ignored-files', String(value)); setIgnored(value); },
    setCopyFormat: value => { storage.setItem('sidecar-copy-format', value); setCopy(value); },
    setWindowMode: value => { storage.setItem('sidecar-window-mode', value); setMode(value); },
    setScrollSyncPosition: percent => { storage.setItem('sidecar-scroll-sync-position', String(percent)); setPercent(percent); },
  }}>{children}</MessageSettings.Provider>;
}

const targets = ['document', 'conversation', 'editor'] as const;
const targetLabel = { document: 'Document', conversation: 'Conversation', editor: 'Editor' };
function readSize(target: string) {
  const value = Number(storage.getItem(`sidecar-${target}-text-size`));
  return Number.isInteger(value) && value >= 80 && value <= 150 && value % 5 === 0 ? value : 100;
}

function readBrightness() {
  const value = Number(storage.getItem('sidecar-text-brightness'));
  return Number.isInteger(value) && value >= 50 && value <= 100 && value % 5 === 0 ? value : 100;
}

function readHighlightIntensity() {
  const value = Number(storage.getItem('sidecar-highlight-intensity'));
  return Number.isInteger(value) && value >= 20 && value <= 100 && value % 5 === 0 ? value : 100;
}

type Category = 'reading' | 'editor' | 'files' | 'access' | 'about';
const categories: { id: Category; label: string }[] = [{ id: 'reading', label: 'Reading' }, { id: 'editor', label: 'Editor' }, { id: 'files', label: 'Files' }, { id: 'access', label: 'Access' }, { id: 'about', label: 'About' }];
const phoneQuery = '(max-width: 600px)';
function readCategory(): Category { const saved = storage.getItem('sidecar-settings-category'); return categories.find(entry => entry.id === saved)?.id ?? 'reading'; }

export function TextSettings({ version, open, onClose, children }: { version?: string; open: boolean; onClose: () => void; children?: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), nav = useRef<HTMLElement>(null), back = useRef<HTMLButtonElement>(null);
  const [category, setCategory] = useState(readCategory), [view, setView] = useState<'list' | 'detail'>('list');
  const [isPhone, setPhone] = useState(() => matchMedia(phoneQuery).matches);
  useEffect(() => {
    const query = matchMedia(phoneQuery), update = () => setPhone(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const currentButton = () => nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { setView('list'); element.showModal(); currentButton()?.focus(); void updateNetwork(); }
    else if (!open && element.open) element.close();
  }, [open]);
  const choose = (next: Category) => { storage.setItem('sidecar-settings-category', next); setCategory(next); };
  const [network, setNetwork] = useState<{ enabled: boolean; urls: string[]; isLocal: boolean; publicUrl: string | null; tunnelTarget?: string | null; passphrase?: string | null } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [tunnelConfig, setTunnelConfig] = useState<TunnelConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [networkError, setNetworkError] = useState(''), [isUpdatingNetwork, setUpdatingNetwork] = useState(false), [copiedUrl, setCopiedUrl] = useState('');
  async function updateNetwork(enabled?: boolean, changes?: { passphrase?: string; publicUrl?: string }) {
    setUpdatingNetwork(true); setNetworkError(''); setCopiedUrl('');
    try {
      const next = await api<NonNullable<typeof network>>('/api/network', enabled === undefined ? undefined : { enabled, ...changes });
      setNetwork(next); setPassphrase(next.passphrase ?? ''); setPublicUrl(next.publicUrl ?? '');
      if (enabled === undefined && next.isLocal) {
        setTunnelConfig(null); setConfigError('');
        try { setTunnelConfig((await api<{ tunnel: TunnelConfig }>('/api/tunnel-config')).tunnel); }
        catch (reason) { setConfigError(errorText(reason)); }
      }
    }
    catch (reason) { setNetworkError(errorText(reason)); }
    finally { setUpdatingNetwork(false); }
  }
  const tunnelCommand = tunnelConfig?.provider === 'ngrok' && network?.tunnelTarget
    ? `ngrok http ${network.tunnelTarget} --inspect=false${tunnelConfig.publicUrl ? ` --url '${tunnelConfig.publicUrl.replaceAll("'", "'\\''")}'` : ''}` : '';
  const { copyFormat, windowMode, showIgnoredFiles, setShowIgnoredFiles, setCopyFormat, setWindowMode, scrollSyncPosition, setScrollSyncPosition } = useMessageSettings();
  const [highlightIntensity, setHighlightIntensity] = useState(readHighlightIntensity);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidecar-highlight-intensity', `${highlightIntensity}%`);
    document.documentElement.style.setProperty('--sidecar-highlight-text', highlightIntensity <= 40 ? '#fff' : '#000');
    storage.setItem('sidecar-highlight-intensity', String(highlightIntensity));
  }, [highlightIntensity]);
  const [brightness, setBrightness] = useState(readBrightness);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidecar-text-brightness', `${brightness}%`);
    storage.setItem('sidecar-text-brightness', String(brightness));
  }, [brightness]);
  const [sizes, setSizes] = useState(() => ({ document: readSize('document'), conversation: readSize('conversation'), editor: readSize('editor') }));
  useLayoutEffect(() => {
    for (const target of targets) {
      document.documentElement.style.setProperty(`--sidecar-${target}-scale`, String(sizes[target] / 100));
      // Plannotator's cookies preserve preferences across Sidecar's random ports.
      storage.setItem(`sidecar-${target}-text-size`, String(sizes[target]));
    }
  }, [sizes]);
  const size = (target: typeof targets[number]) => <label className="setting-row" key={target}>
    <span>{targetLabel[target]}</span>
    <input type="range" aria-label={`${targetLabel[target]} text size`} aria-valuetext={`${sizes[target]}%`} min={80} max={150} step={5} value={sizes[target]} onChange={event => setSizes({ ...sizes, [target]: event.target.valueAsNumber })} />
    <output>{sizes[target]}%</output>
  </label>;
  const resetSizes = <div className="settings-actions"><button type="button" className="small-button" aria-label="Reset text sizes" disabled={targets.every(target => sizes[target] === 100)} onClick={() => setSizes({ document: 100, conversation: 100, editor: 100 })}>Reset text sizes</button></div>;
  const slider = (label: string, value: number, min: number, onChange: (value: number) => void) => <label className="setting-row">
    <span>{label}</span>
    <input type="range" aria-label={label} aria-valuetext={`${value}%`} min={min} max={100} step={5} value={value} onChange={event => onChange(event.target.valueAsNumber)} />
    <output>{value}%</output>
  </label>;
  const reset = (label: string, disabled: boolean, onClick: () => void) => <div className="settings-actions"><button type="button" className="small-button" aria-label={label} disabled={disabled} onClick={onClick}>Reset</button></div>;
  const pages: Record<Category, ReactNode> = {
    reading: <>
      <fieldset className="settings-group"><legend>Text size</legend>{size('document')}{size('conversation')}{resetSizes}</fieldset>
      <fieldset className="settings-group"><legend>Appearance</legend>
        {slider('Text brightness', brightness, 50, setBrightness)}{reset('Reset text brightness', brightness === 100, () => setBrightness(100))}
        {slider('Highlight intensity', highlightIntensity, 20, setHighlightIntensity)}{reset('Reset highlight intensity', highlightIntensity === 100, () => setHighlightIntensity(100))}
      </fieldset>
      {children && <fieldset className="settings-group"><legend>This HTML page</legend><div className="setting-row"><span>HTML page zoom</span>{children}</div></fieldset>}
    </>,
    editor: <>
      <fieldset className="settings-group"><legend>Text size</legend>{size('editor')}{resetSizes}</fieldset>
      <fieldset className="settings-group"><legend>Scroll sync</legend>
        {slider('Align at', scrollSyncPosition, 0, setScrollSyncPosition)}
        <p className="settings-hint">Panes line up the same passage this far down the screen, easing to the edges at the very start and end.</p>
      </fieldset>
    </>,
    files: <>
      <fieldset className="settings-group"><legend>Windows</legend><div className="settings-choice">
        <label><input type="radio" name="window-mode" checked={windowMode === 'single'} onChange={() => setWindowMode('single')} />One at a time</label>
        <label><input type="radio" name="window-mode" checked={windowMode === 'multiple'} onChange={() => setWindowMode('multiple')} />Multiple</label>
      </div></fieldset>
      <fieldset className="settings-group"><legend>File explorer</legend>
        <label className="settings-check"><input type="checkbox" checked={showIgnoredFiles} onChange={event => setShowIgnoredFiles(event.target.checked)} />Show gitignored files and folders</label>
      </fieldset>
      <fieldset className="settings-group"><legend>Copy messages as</legend><div className="settings-choice">
        {(['markdown', 'rich', 'plain'] as const).map(format => <label key={format}><input type="radio" name="copy-format" value={format} checked={format === copyFormat} onChange={() => setCopyFormat(format)} />{format === 'markdown' ? 'Markdown' : format === 'rich' ? 'Rich text' : 'Plain text'}</label>)}
      </div></fieldset>
    </>,
    access: <>
        <fieldset className="message-settings network-settings"><legend>Open on phone</legend>
          {network && <>
            <label><input type="checkbox" checked={network.enabled} disabled={isUpdatingNetwork || !network.isLocal} onChange={event => { void updateNetwork(event.target.checked); }} />Allow access on local network</label>
            <p>{network.isLocal ? (isGateway ? 'Shares all Sidecar agents on this computer. Requires a passphrase; stays enabled until turned off.' : 'Requires the passphrase below. Network access turns off when Sidecar restarts.') : 'Manage network access from Sidecar on your Mac.'}</p>
            {network.enabled && network.isLocal && <div className="network-passphrase">
              <label>Passphrase<input aria-label="Network passphrase" disabled={isUpdatingNetwork} value={passphrase} minLength={8} maxLength={128} spellCheck={false} autoComplete="off" onChange={event => setPassphrase(event.target.value)} /></label>
              <button type="button" disabled={isUpdatingNetwork || passphrase === network.passphrase || passphrase.length < 8} onClick={() => { void updateNetwork(true, { passphrase }); }}>Save passphrase</button>
              <p>Changing it signs out remembered browsers.</p>
            </div>}
            {network.isLocal && tunnelConfig && <div className="network-passphrase network-tunnel">
              <h3>Internet ({tunnelConfig.provider === 'cloudflare' ? 'Cloudflare' : 'ngrok'})</h3>
              <p>Ask your agent to open Sidecar through {tunnelConfig.provider === 'cloudflare' ? 'Cloudflare' : 'ngrok'}.</p>
              {tunnelConfig.publicUrl && <p>Configured address: {tunnelConfig.publicUrl}</p>}
              {tunnelCommand && <div className="network-link"><input aria-label="ngrok command" readOnly value={tunnelCommand} /><button type="button" onClick={async () => {
                if (await copyTextToClipboard(tunnelCommand)) setCopiedUrl(tunnelCommand);
                else setNetworkError('Could not copy. Select the command to copy it.');
              }}>{copiedUrl === tunnelCommand ? 'Copied' : 'Copy command'}</button></div>}
            </div>}
            {network.enabled && network.isLocal && <div className="network-passphrase network-tunnel">
              <label>Public HTTPS URL<input type="url" aria-label="Public HTTPS URL" disabled={isUpdatingNetwork} value={publicUrl} placeholder="https://sidecar.example.com" autoComplete="off" spellCheck={false} onChange={event => setPublicUrl(event.target.value)} /></label>
              <button type="button" disabled={isUpdatingNetwork || publicUrl === (network.publicUrl ?? '')} onClick={() => { void updateNetwork(true, { publicUrl }); }}>Save URL</button>
            </div>}
            {[...network.urls, ...(network.publicUrl ? [network.publicUrl] : [])].map(base => {
              const url = base + location.pathname + location.search + location.hash;
              return <div className="network-link" key={base}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a><button type="button" onClick={async () => {
                if (await copyTextToClipboard(url)) { setCopiedUrl(url); setNetworkError(''); }
                else setNetworkError('Could not copy. Select the address to copy it.');
              }}>{copiedUrl === url ? 'Copied' : 'Copy'}</button></div>;
            })}
          </>}
          {network?.isLocal && configError && <p role="alert">{configError}</p>}
          {networkError && <p role="alert">{networkError}</p>}
        </fieldset>
    </>,
    about: version ? <div className="settings-version">{version}</div> : <p className="settings-hint">No version information.</p>,
  };
  const label = categories.find(entry => entry.id === category)!.label;
  return (
    <dialog ref={dialog} className="text-settings settings-dialog" aria-label="Settings" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="settings-shell" data-view={view}>
        <div className="settings-head">
          <button ref={back} type="button" className="settings-back" aria-label="Back to categories" onClick={() => { setView('list'); setTimeout(() => currentButton()?.focus()); }}><Icon name="back" /></button>
          <h2>{isPhone && view === 'detail' ? label : 'Settings'}</h2>
          <button type="button" aria-label="Close settings" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
        </div>
        <nav ref={nav} className="settings-cats" aria-label="Settings categories" onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const at = categories.findIndex(entry => entry.id === category), next = categories[(at + (event.key === 'ArrowDown' ? 1 : -1) + categories.length) % categories.length].id;
          choose(next);
          setTimeout(() => nav.current?.querySelector<HTMLElement>(`[data-category="${next}"]`)?.focus());
        }}>
          {categories.map(entry => <button key={entry.id} type="button" data-category={entry.id} aria-current={entry.id === category ? 'page' : undefined}
            onClick={() => { choose(entry.id); setView('detail'); if (isPhone) setTimeout(() => back.current?.focus()); }}>
            <Icon name={entry.id} />{entry.label}<span className="settings-chevron"><Icon name="chevronRight" /></span>
          </button>)}
        </nav>
        <section className="settings-panel" aria-label={label}>
          <h3>{label}</h3>
          {pages[category]}
        </section>
      </div>
    </dialog>
  );
}
