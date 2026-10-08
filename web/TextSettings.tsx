import { libraryPath, isGateway } from './viewer-path.ts';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { Icon } from './conversations.tsx';
import type { CopyFormat } from './message-copy.ts';
import { api, errorText } from './api.ts';
import type { TunnelConfig } from '../src/tunnel-config.ts';

const MessageSettings = createContext({ copyFormat: 'markdown' as CopyFormat, windowMode: 'multiple', setCopyFormat: (_value: CopyFormat) => {}, setWindowMode: (_value: string) => {} });
export const useMessageSettings = () => useContext(MessageSettings);
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [copyFormat, setCopy] = useState<CopyFormat>(() => {
    const saved = storage.getItem('sidecar-copy-format');
    return saved === 'rich' || saved === 'plain' ? saved : 'markdown';
  });
  const [windowMode, setMode] = useState(() => storage.getItem('sidecar-window-mode') === 'single' ? 'single' : 'multiple');
  return <MessageSettings.Provider value={{ copyFormat, windowMode,
    setCopyFormat: value => { storage.setItem('sidecar-copy-format', value); setCopy(value); },
    setWindowMode: value => { storage.setItem('sidecar-window-mode', value); setMode(value); },
  }}>{children}</MessageSettings.Provider>;
}

const targets = ['document', 'conversation'] as const;
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

export function TextSettings({ version }: { version?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  const { copyFormat, windowMode, setCopyFormat, setWindowMode } = useMessageSettings();
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
  const [sizes, setSizes] = useState(() => ({ document: readSize('document'), conversation: readSize('conversation') }));
  useLayoutEffect(() => {
    for (const target of targets) {
      document.documentElement.style.setProperty(`--sidecar-${target}-scale`, String(sizes[target] / 100));
      // Plannotator's cookies preserve preferences across Sidecar's random ports.
      storage.setItem(`sidecar-${target}-text-size`, String(sizes[target]));
    }
  }, [sizes]);
  return (
    <>
      <button className="settings-toggle" aria-label="Settings" title="Settings" onClick={() => { dialog.current?.showModal(); void updateNetwork(); }}>
        <Icon name="settings" />
      </button>
      <dialog ref={dialog} className="text-settings" aria-label="Reading settings" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="settings-content">
        <div className="settings-title"><h2>Settings</h2><button aria-label="Close settings" onClick={() => dialog.current?.close()}><Icon name="close" /></button></div>
        {!new URLSearchParams(location.search).has('library') && <a className="library-menu-link" href={libraryPath()} target="_blank" rel="noopener noreferrer">View all documents</a>}
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
        <div className="text-settings-heading">
          <span>Text size</span>
          <button
            type="button"
            aria-label="Reset text sizes"
            disabled={sizes.document === 100 && sizes.conversation === 100}
            onClick={() => setSizes({ document: 100, conversation: 100 })}
          >
            Reset
          </button>
        </div>
        {targets.map((target) => (
          <label className="text-size-control" key={target}>
            <span>{target === 'document' ? 'Document' : 'Conversation'}</span>
            <output>{sizes[target]}%</output>
            <input
              type="range"
              aria-label={`${target === 'document' ? 'Document' : 'Conversation'} text size`}
              aria-valuetext={`${sizes[target]}%`}
              min={80}
              max={150}
              step={5}
              value={sizes[target]}
              onChange={(event) => setSizes({ ...sizes, [target]: event.target.valueAsNumber })}
            />
          </label>
        ))}
        <div className="text-settings-heading brightness-heading">
          <span>Text brightness</span>
          <button type="button" aria-label="Reset text brightness" disabled={brightness === 100} onClick={() => setBrightness(100)}>Reset</button>
        </div>
        <label className="text-size-control">
          <span>Brightness</span>
          <output>{brightness}%</output>
          <input type="range" aria-label="Text brightness" aria-valuetext={`${brightness}%`} min={50} max={100} step={5} value={brightness} onChange={(event) => setBrightness(event.target.valueAsNumber)} />
        </label>
        <div className="text-settings-heading brightness-heading">
          <span>Highlights</span>
          <button type="button" aria-label="Reset highlight intensity" disabled={highlightIntensity === 100} onClick={() => setHighlightIntensity(100)}>Reset</button>
        </div>
        <label className="text-size-control">
          <span>Intensity</span>
          <output>{highlightIntensity}%</output>
          <input type="range" aria-label="Highlight intensity" aria-valuetext={`${highlightIntensity}%`} min={20} max={100} step={5} value={highlightIntensity} onChange={(event) => setHighlightIntensity(event.target.valueAsNumber)} />
        </label>
        <fieldset className="message-settings"><legend>Copy messages as</legend>
          {(['markdown', 'rich', 'plain'] as const).map(format => <label key={format}><input type="radio" name="copy-format" value={format} checked={format === copyFormat} onChange={() => setCopyFormat(format)} />{format === 'markdown' ? 'Raw Markdown' : format === 'rich' ? 'Rich text' : 'Plain text'}</label>)}
        </fieldset>
        <fieldset className="message-settings"><legend>Windows</legend>
          <label><input type="radio" name="window-mode" checked={windowMode === 'single'} onChange={() => setWindowMode('single')} />One at a time</label>
          <label><input type="radio" name="window-mode" checked={windowMode === 'multiple'} onChange={() => setWindowMode('multiple')} />Multiple</label>
        </fieldset>
        {version && <div className="settings-version">{version}</div>}
        </div>
      </dialog>
    </>
  );
}
