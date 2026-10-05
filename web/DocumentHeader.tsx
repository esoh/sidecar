import { useEffect, useState } from 'react';
import { DocBadges } from '@plannotator/ui/components/DocBadges';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { RepoInfo } from '../src/store.ts';

// Badge markup and copy-button styling reuse Plannotator's DocBadges/Viewer (MIT).
export function DocumentHeader({ repoInfo, markdown, onError }: {
  repoInfo?: RepoInfo; markdown: string; onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="document-tools annotation-exclude">
      <DocBadges layout="column" repoInfo={repoInfo} />
      <button
        className="document-copy flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors"
        title={copied ? 'Copied!' : 'Copy file'}
        onClick={async () => { if (await copyTextToClipboard(markdown)) setCopied(true); else onError('Could not copy file.'); }}
      >
        <svg className="w-3.5 h-3.5" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d={copied ? 'M5 13l4 4L19 7' : 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z'} />
        </svg>
        <span aria-live="polite">{copied ? 'Copied!' : 'Copy file'}</span>
      </button>
    </div>
  );
}
