import { useLayoutEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@plannotator/ui/components/Popover';
import { storage } from '@plannotator/ui/utils/storage';
import { Icon } from './conversations.tsx';

const targets = ['document', 'conversation'] as const;
function readSize(target: string) {
  const value = Number(storage.getItem(`sidecar-${target}-text-size`));
  return Number.isInteger(value) && value >= 80 && value <= 150 && value % 5 === 0 ? value : 100;
}

export function TextSettings() {
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
      <PopoverContent className="text-settings" align="end" sideOffset={8} aria-label="Text size settings">
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
      </PopoverContent>
    </Popover>
  );
}
