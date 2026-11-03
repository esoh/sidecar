import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filterWorkspaceStatusForDirectory, getWorkspaceStatusForDirectory, readComparisonOldText, type ComparisonRequest, type WorkspaceStatusResult } from './workspace-status.ts';
import { DomainError } from './store.ts';
import { decodeFileText, MAX_FILE_PREVIEW_BYTES } from './file-text.ts';

// File-type predicates copied from @plannotator/core 0.25.7 annotatable.ts (MIT): the package
// ships TypeScript source, which Playwright's loader will not compile from node_modules.
const ANNOTATABLE_DOC_REGEX = /(?:\.(?:mdx?|txt|mmd|mermaid|dot|gv|html?|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)$/i;
function diagramRenderKindForPath(input: string): 'mermaid' | 'graphviz' | null {
  if (/\.(?:mmd|mermaid)$/i.test(input.trim())) return 'mermaid';
  if (/\.(?:dot|gv)$/i.test(input.trim())) return 'graphviz';
  return null;
}

// Git metadata stays out of the explorer; other visibility follows Git's ignore rules.
export function isFileBrowserExcludedPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').split('/').includes('.git');
}
const includeWorkspaceFile = (relativePath: string) => !isFileBrowserExcludedPath(relativePath);
export type DirectoryEntry = { name: string; path: string; type: 'file' | 'folder'; isIgnored?: boolean };
const execFileAsync = promisify(execFile);
async function ignoredEntries(dir: string, entries: DirectoryEntry[]): Promise<Set<string>> {
  if (!entries.length) return new Set();
  // One NUL-delimited batch per loaded directory: no recursive scan or per-file Git processes.
  const check = execFileAsync('git', ['--no-optional-locks', '-C', dir, 'check-ignore', '-z', '--stdin'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  check.child.stdin?.on('error', () => {}); // Git can exit before consuming input outside a repository.
  check.child.stdin?.end(entries.map(entry => `${entry.name}${entry.type === 'folder' ? '/' : ''}\0`).join(''));
  try {
    return new Set((await check).stdout.split('\0').filter(Boolean).map(name => name.replace(/\/$/, '')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 1 || error.code === 'ENOENT' ||
      error.code === 128 && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.includes('not a git repository'))) return new Set();
    throw new DomainError('Could not check Git ignore rules. Refresh to retry.', 503);
  }
}
export type DirectoryListing = { dir: string; entries: DirectoryEntry[] };
export async function listDirectory(dir: string): Promise<DirectoryListing> {
  if (!(await stat(dir).catch(() => null))?.isDirectory())
    throw new DomainError('The workspace directory is unavailable. Reopen the document from your agent.', 404);
  const entries: DirectoryEntry[] = [];
  // Symlinks are neither files nor directories to Dirent, so they are never followed out of the root.
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !isFileBrowserExcludedPath(entry.name)) entries.push({ name: entry.name, path: join(dir, entry.name), type: 'folder' });
    else if (entry.isFile() && includeWorkspaceFile(entry.name)) entries.push({ name: entry.name, path: join(dir, entry.name), type: 'file' });
  }
  const ignored = await ignoredEntries(dir, entries);
  for (const entry of entries) if (ignored.has(entry.name)) entry.isIgnored = true;
  entries.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
  return { dir, entries };
}
export async function readStatus(directory: string, request: ComparisonRequest): Promise<WorkspaceStatusResult> {
  const status = await getWorkspaceStatusForDirectory(directory, request);
  return filterWorkspaceStatusForDirectory(status, directory, includeWorkspaceFile);
}
export type FileDiffData = { path: string; old: string | null; current: string | null; status?: 'added' | 'deleted' | 'modified' };
export async function readDiff(root: string, path: string, request: ComparisonRequest): Promise<FileDiffData> {
  const relativePath = relative(root, path).split(sep).join('/');
  if (!relativePath || isOutside(root, path) || !includeWorkspaceFile(relativePath)) throw new DomainError('This path cannot be compared', 415);
  const info = await stat(path).catch(() => null);
  if (info && !info.isFile()) throw new DomainError('A regular file is required');
  if (info && info.size > MAX_FILE_PREVIEW_BYTES) throw new DomainError('File exceeds the 2 MiB preview limit', 413);
  const current = info ? decodeFileText(await readFile(path)) : null;
  const old = await readComparisonOldText(path, request);
  if (current === null && old === null) throw new DomainError('File not found', 404);
  return { path, old, current, ...(old === null ? { status: 'added' as const } : current === null ? { status: 'deleted' as const } : old !== current ? { status: 'modified' as const } : {}) };
}
// Realpath that tolerates a missing leaf (deleted files) by resolving the nearest existing ancestor.
async function realpathLoose(path: string): Promise<string> {
  let existing = path;
  for (;;) {
    try { return resolve(await realpath(existing), relative(existing, path)); }
    catch (error) {
      const parent = dirname(existing);
      if (parent === existing || !(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) throw error;
      existing = parent;
    }
  }
}
// An absolute path is allowed when its real location is inside the real workspace or an explicitly granted root.
export async function authorizePath(workspace: string, grants: Iterable<string>, candidate: string): Promise<{ path: string; root: string }> {
  if (!isAbsolute(candidate) || candidate.includes('\0')) throw new DomainError('Expected an absolute path');
  const real = await realpathLoose(resolve(candidate)).catch(() => { throw new DomainError('Path is unavailable', 404); });
  if (!(await realpath(workspace).catch(() => null))) throw new DomainError('The workspace directory is unavailable. Reopen the document from your agent.', 404);
  for (const root of [workspace, ...grants]) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot && !isOutside(realRoot, real)) return { path: real, root: realRoot };
  }
  throw new DomainError('Open this folder in the file browser first', 403);
}

export type FilePreviewData = { path: string; text: string; renderAs: 'markdown' | 'html' | 'mermaid' | 'graphviz' | 'text' };
export type CodeFileData = { codeFile: true; filepath: string; contents: string };
const isOutside = (root: string, candidate: string) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
};
// Resolve a viewer-supplied path to a regular text file inside the real root.
async function workspaceFile(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new DomainError('Expected a path inside the workspace');
  const lexical = resolve(root, path);
  if (isOutside(root, lexical)) throw new DomainError('Path is outside the workspace', 403);
  const real = await realpath(lexical).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw new DomainError('File not found', 404);
    throw error;
  });
  const realRoot = await realpath(root);
  if (isOutside(realRoot, real)) throw new DomainError('Path is outside the workspace', 403);
  const relativePath = relative(realRoot, real).split(sep).join('/');
  if (isFileBrowserExcludedPath(relativePath))
    throw new DomainError('Files in excluded folders cannot be previewed', 415);
  const info = await stat(real);
  if (!info.isFile()) throw new DomainError('A regular file is required');
  if (info.size > MAX_FILE_PREVIEW_BYTES) throw new DomainError('File exceeds the 2 MiB preview limit', 413);
  return { relativePath, text: decodeFileText(await readFile(real)) };
}
export async function readPreview(root: string, path: string): Promise<FilePreviewData> {
  const { relativePath, text } = await workspaceFile(root, path);
  const diagram = diagramRenderKindForPath(relativePath);
  return { path: relativePath, text, renderAs: diagram ?? (/\.html?$/i.test(relativePath) ? 'html' : ANNOTATABLE_DOC_REGEX.test(relativePath) ? 'markdown' : 'text') };
}
// Code links may carry a :line or :start-end suffix, which Plannotator's popout parses itself.
export async function readCode(root: string, path: string): Promise<CodeFileData> {
  const { relativePath, text } = await workspaceFile(root, path.replace(/:\d+(?:-\d+)?$/, ''));
  return { codeFile: true, filepath: relativePath, contents: text };
}
