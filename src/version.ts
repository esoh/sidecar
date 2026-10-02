import { readFile } from 'node:fs/promises';

export async function readAppVersion(): Promise<string> {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const revision = await readFile(new URL('../.sidecar-revision', import.meta.url), 'utf8').catch(() => '');
  return `Sidecar ${version}${revision ? ` (${revision.trim().slice(0, 12)})` : ''}`;
}
