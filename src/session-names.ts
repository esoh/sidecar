import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isObject, ownerKey, type Owner } from './store.ts';

type Names = { name?: string; custom?: string; generated?: string };
const cache = new Map<string, { stamp: string; names: Promise<Map<string, Names>> }>();
const title = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;

async function readTitles(path: string): Promise<Map<string, Names>> {
  try {
    const info = await stat(path), stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
    const saved = cache.get(path);
    if (saved?.stamp === stamp) return await saved.names;
    const names = (async () => {
      const result = new Map<string, Names>();
      const input = createReadStream(path, { encoding: 'utf8' }), lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          // Only title records are parsed or cached; never use prompts as fallback names.
          if (!/"(?:thread_name|customTitle|aiTitle|agentName)"\s*:/.test(line)) continue;
          try {
            const value: unknown = JSON.parse(line);
            if (!isObject(value)) continue;
            if (typeof value.id === 'string' && typeof value.thread_name === 'string') result.set(value.id, { name: title(value.thread_name) });
            if (typeof value.sessionId !== 'string') continue;
            const current = result.get(value.sessionId) ?? {};
            if (value.type === 'custom-title' && typeof value.customTitle === 'string') current.custom = title(value.customTitle);
            else if (value.type === 'ai-title' && typeof value.aiTitle === 'string') current.generated = title(value.aiTitle);
            else if (value.type === 'agent-name' && typeof value.agentName === 'string') current.name = title(value.agentName);
            else continue;
            result.set(value.sessionId, current);
          } catch { /* Ignore incomplete writes and unsupported native metadata. */ }
        }
        return result;
      } finally { lines.close(); input.destroy(); }
    })();
    cache.set(path, { stamp, names });
    return await names;
  } catch { cache.delete(path); return new Map(); }
}

export async function readSessionNames(owners: Owner[], env: NodeJS.ProcessEnv = process.env): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const projects = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const directories = owners.some(owner => owner.agent === 'claude')
    ? await readdir(projects, { withFileTypes: true }).then(entries => entries.filter(entry => entry.isDirectory()).map(entry => join(projects, entry.name))).catch(() => []) : [];
  await Promise.all(owners.map(async owner => {
    let path: string | undefined;
    if (owner.agent === 'codex') path = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'session_index.jsonl');
    else {
      // A linked worktree may differ from the directory where Claude began the session.
      const files = await Promise.all(directories.map(async directory => {
        const path = join(directory, owner.sessionId + '.jsonl');
        return stat(path).then(info => ({ path, modified: info.mtimeMs })).catch(() => null);
      }));
      path = files.filter(file => file !== null).sort((a, b) => b.modified - a.modified)[0]?.path;
    }
    if (!path) return;
    const names = (await readTitles(path)).get(owner.sessionId), name = names?.name || names?.custom || names?.generated;
    if (name) result.set(ownerKey(owner), name);
  }));
  return result;
}
