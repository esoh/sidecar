import { useLayoutEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@plannotator/ui/components/Popover';
import { storage } from '@plannotator/ui/utils/storage';
import { Icon } from './conversations.tsx';

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
    <Popover>
      <PopoverTrigger className="settings-toggle" aria-label="Settings" title="Settings">
        <Icon name="settings" />
      </PopoverTrigger>
      <PopoverContent className="text-settings" align="end" sideOffset={8} aria-label="Reading settings">
        {!new URLSearchParams(location.search).has('library') && <a className="library-menu-link" href="/?library=1" target="_blank" rel="noopener noreferrer">View all documents</a>}
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
        {version && <div className="settings-version">{version}</div>}
      </PopoverContent>
    </Popover>
  );
}
