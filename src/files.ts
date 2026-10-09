import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filterWorkspaceStatusForDirectory, getWorkspaceStatusForDirectory, readComparisonOldText, type ComparisonRequest, type WorkspaceStatusResult } from './workspace-status.ts';
import { DomainError } from './store.ts';

// File-type predicates copied from @plannotator/core 0.25.7 annotatable.ts (MIT): the package
// ships TypeScript source, which Playwright's loader will not compile from node_modules.
const ANNOTATABLE_DOC_REGEX = /(?:\.(?:mdx?|txt|mmd|mermaid|dot|gv|html?|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)$/i;
const MAX_ANNOTATABLE_FILE_BYTES = 2 * 1024 * 1024;
function diagramRenderKindForPath(input: string): 'mermaid' | 'graphviz' | null {
  if (/\.(?:mmd|mermaid)$/i.test(input.trim())) return 'mermaid';
  if (/\.(?:dot|gv)$/i.test(input.trim())) return 'graphviz';
  return null;
}

// Exclusions and tree building copied from Plannotator packages/shared/reference-common.ts
// at 772c620 (MIT); see THIRD_PARTY_NOTICES.md.
export const FILE_BROWSER_EXCLUDED = [
  'node_modules/', '.git/', '.claude/', '.agents/', 'dist/', 'build/', '.next/', '__pycache__/', '.obsidian/', '.trash/',
  '.venv/', 'vendor/', 'target/', '.cache/', 'coverage/', '.turbo/', '.svelte-kit/', '.nuxt/', '.output/', '.parcel-cache/',
  '.webpack/', '.expo/', '_site/', 'public/', '.jekyll-cache/', 'out/', '.docusaurus/', 'storybook-static/',
];
const FILE_BROWSER_EXCLUDED_NAMES = new Set(FILE_BROWSER_EXCLUDED.map(entry => entry.replace(/\/+$/, '')));
export function isFileBrowserExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return false;
  return normalized.split('/').filter(Boolean).some(part => FILE_BROWSER_EXCLUDED_NAMES.has(part));
}
// Listing and changed-file filtering follow handleFileBrowserFiles in Plannotator
// packages/server/reference-handlers.ts at 772c620 (MIT), but list one directory per request.
const includeWorkspaceFile = (relativePath: string) =>
  (ANNOTATABLE_DOC_REGEX.test(relativePath) || CODE_FILE_REGEX.test(relativePath)) && !isFileBrowserExcludedPath(relativePath);
export type DirectoryEntry = { name: string; path: string; type: 'file' | 'folder' };
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
  if (!relativePath || isOutside(root, path) || !includeWorkspaceFile(relativePath)) throw new DomainError('This file type cannot be compared', 415);
  const info = await stat(path).catch(() => null);
  if (info && !info.isFile()) throw new DomainError('A regular file is required');
  if (info && info.size > MAX_ANNOTATABLE_FILE_BYTES) throw new DomainError('File exceeds the 2 MiB preview limit', 413);
  const current = info ? await readFile(path, 'utf8') : null;
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

export type FilePreviewData = { path: string; text: string; renderAs: 'markdown' | 'html' | 'mermaid' | 'graphviz' };
export type CodeFileData = { codeFile: true; filepath: string; contents: string };
// Code-link file types copied from @plannotator/core 0.25.7 code-file.ts (MIT).
const CODE_FILE_REGEX = /(?:\.(tsx?|jsx?|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|r|dart|ex|exs|vue|svelte|astro|zig|proto)|(?:^|\/)(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Vagrantfile|Brewfile|Justfile))$/i;
const isOutside = (root: string, candidate: string) => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
};
// Resolve a viewer-supplied path to a regular file of an accepted type inside the real root.
async function workspaceFile(root: string, path: string, accepted: RegExp) {
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
  if (!accepted.test(relativePath) || isFileBrowserExcludedPath(relativePath))
    throw new DomainError('This file type cannot be previewed', 415);
  const info = await stat(real);
  if (!info.isFile()) throw new DomainError('A regular file is required');
  if (info.size > MAX_ANNOTATABLE_FILE_BYTES) throw new DomainError('File exceeds the 2 MiB preview limit', 413);
  return { relativePath, text: await readFile(real, 'utf8') };
}
export async function readPreview(root: string, path: string): Promise<FilePreviewData> {
  const { relativePath, text } = await workspaceFile(root, path, ANNOTATABLE_DOC_REGEX);
  const diagram = diagramRenderKindForPath(relativePath);
  return { path: relativePath, text, renderAs: diagram ?? (/\.html?$/i.test(relativePath) ? 'html' : 'markdown') };
}
// Code links may carry a :line or :start-end suffix, which Plannotator's popout parses itself.
export async function readCode(root: string, path: string): Promise<CodeFileData> {
  const { relativePath, text } = await workspaceFile(root, path.replace(/:\d+(?:-\d+)?$/, ''), CODE_FILE_REGEX);
  return { codeFile: true, filepath: relativePath, contents: text };
}
