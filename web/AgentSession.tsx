import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@plannotator/ui/components/Popover';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { Owner } from '../src/store.ts';
import { api, errorText, type ViewerState } from './api.ts';

export function AgentSession({ owner, reset }: { owner: Owner; reset?: ViewerState['reset'] }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const [sending, setSending] = useState(false), [requested, setRequested] = useState(false);
  const resetting = sending || reset?.status === 'checking' || reset?.status === 'interrupting';
  const name = owner.agent === 'codex' ? 'Codex' : 'Claude';
  return (
    <Popover onOpenChange={() => { setCopied(false); setError(''); setRequested(false); }}>
      <PopoverTrigger className="agent-session-trigger" aria-label={`${name} session details`} title="Session details">{name}</PopoverTrigger>
      <PopoverContent className="agent-session-popover" align="end" sideOffset={8} aria-label={`${name} session`}>
        <span>Session ID</span>
        <div><code>{owner.sessionId}</code><button type="button" onClick={async () => {
          if (await copyTextToClipboard(owner.sessionId)) { setCopied(true); setError(''); }
          else setError('Copy failed. Select the session ID to copy it.');
        }}>{copied ? 'Copied' : 'Copy'}</button></div>
        {reset !== undefined && <button type="button" className="agent-reset" disabled={resetting}
          title="Interrupt this agent if working and release stuck requests. Saved messages stay."
          onClick={async () => {
            setSending(true); setRequested(true); setError('');
            try { await api('/api/agent/reset', {}); }
            catch (reason) { setError(errorText(reason)); }
            finally { setSending(false); }
          }}>{resetting ? 'Resetting…' : 'Reset'}</button>}
        {requested && reset?.status === 'done' && <p role="status">Reset complete.</p>}
        {reset?.status === 'failed' && <p role="alert">{reset.error}</p>}
        {error && <p role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
