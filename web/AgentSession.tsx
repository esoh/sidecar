import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@plannotator/ui/components/Popover';
import type { Owner } from '../src/store.ts';

export function AgentSession({ owner }: { owner: Owner }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const name = owner.agent === 'codex' ? 'Codex' : 'Claude';
  return (
    <Popover onOpenChange={() => { setCopied(false); setError(''); }}>
      <PopoverTrigger className="agent-session-trigger" aria-label={`${name} session details`} title="Session details">{name}</PopoverTrigger>
      <PopoverContent className="agent-session-popover" align="end" sideOffset={8} aria-label={`${name} session`}>
        <span>Session ID</span>
        <div><code>{owner.sessionId}</code><button type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(owner.sessionId); setCopied(true); setError(''); }
          catch { setError('Copy failed. Select the session ID to copy it.'); }
        }}>{copied ? 'Copied' : 'Copy'}</button></div>
        {error && <p role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
