import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorText } from './api.ts';
import { Icon } from './conversations.tsx';
import type { TestFileRules } from '../src/test-file-rules.ts';

export function TestFileSettings({ documentId, scope, onSaved }: { documentId: string; scope: string; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [include, setInclude] = useState(''), [exclude, setExclude] = useState('');
  const [error, setError] = useState(''), [isBusy, setBusy] = useState(false), [canSave, setCanSave] = useState(false);
  const endpoint = `/api/files/test-rules?${new URLSearchParams({ document: documentId, directory: scope })}`;
  async function open() {
    setError(''); setBusy(true); setCanSave(false); setInclude(''); setExclude(''); dialog.current?.showModal();
    try {
      const { testFiles } = await api<{ testFiles: TestFileRules }>(endpoint);
      setInclude((testFiles.include ?? []).join('\n')); setExclude((testFiles.exclude ?? []).join('\n')); setCanSave(true);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  async function save() {
    setError(''); setBusy(true);
    const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
    try { await api(endpoint, { include: lines(include), exclude: lines(exclude) }); onSaved(); dialog.current?.close(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <button className="icon-button" aria-label="Test file settings" title="Test file settings" onClick={() => void open()}><Icon name="settings" /></button>
    {createPortal(<dialog ref={dialog} className="text-settings test-file-settings" aria-label="Test file settings">
      <header><strong>Test file settings</strong><button className="icon-button" aria-label="Close test file settings" disabled={isBusy} onClick={() => dialog.current?.close()}><Icon name="close" /></button></header>
      <p>Local to this repository, shared across its worktrees. Paths are relative to the repository root.</p>
      <label>Include as tests<textarea rows={4} value={include} disabled={isBusy} onChange={event => setInclude(event.target.value)} placeholder="integration/**/*.check.*" spellCheck={false} /></label>
      <label>Exclude from tests<textarea rows={4} value={exclude} disabled={isBusy} onChange={event => setExclude(event.target.value)} placeholder="**/*.spec.*" spellCheck={false} /></label>
      <p>One glob pattern per line. Includes add to the defaults; exclusions always win. Leave both empty to use defaults.</p>
      <details><summary>Default patterns</summary><p>test, tests, Test, Tests, __tests__, spec and specs folders; __fixtures__ and __snapshots__; *.test.*, *.spec.*, test_*.py, *_test.*, *_spec.rb; Test*, *Test and *Tests in Java, Kotlin and C#; *Tests.swift.</p></details>
      {error && <p role="alert" className="error">{error}</p>}
      <footer><button className="secondary" disabled={isBusy} onClick={() => dialog.current?.close()}>Cancel</button><button disabled={isBusy || !canSave} onClick={() => void save()}>{isBusy ? 'Loading…' : 'Save'}</button></footer>
    </dialog>, document.body)}
  </>;
}
