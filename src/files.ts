import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filterWorkspaceStatusForDirectory, getWorkspaceStatusForDirectory, getWorkspaceStatusRelativePaths, type WorkspaceStatusPayload } from './workspace-status.ts';
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
export interface VaultNode { name: string; path: string; type: 'file' | 'folder'; children?: VaultNode[] }
export function buildFileTree(relativePaths: string[], directories: string[] = []): VaultNode[] {
  const root: VaultNode[] = [];
  for (const { filePath, isDirectory } of [...relativePaths.map(filePath => ({ filePath, isDirectory: false })), ...directories.map(filePath => ({ filePath, isDirectory: true }))]) {
    const parts = filePath.split('/');
    let current = root, pathSoFar = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], isFile = i === parts.length - 1 && !isDirectory;
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      let node = current.find(n => n.name === part && n.type === (isFile ? 'file' : 'folder'));
      if (!node) {
        node = { name: part, path: pathSoFar, type: isFile ? 'file' : 'folder' };
        if (!isFile) node.children = [];
        current.push(node);
      }
      if (!isFile) current = node.children!;
    }
  }
  const sortNodes = (nodes: VaultNode[]) => {
    nodes.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
    for (const node of nodes) if (node.children) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

// Walk, cap and changed-file seeding follow handleFileBrowserFiles in Plannotator
// packages/server/reference-handlers.ts at 772c620 (MIT).
const DEFAULT_FILE_LIMIT = 5_000;
const includeWorkspaceFile = (relativePath: string) =>
  (ANNOTATABLE_DOC_REGEX.test(relativePath) || CODE_FILE_REGEX.test(relativePath)) && !isFileBrowserExcludedPath(relativePath);
type WalkState = { files: Set<string>; folders: Set<string>; limit: number; truncated: boolean };
function addFile(state: WalkState, relativePath: string) {
  if (state.files.has(relativePath)) return;
  if (state.files.size >= state.limit) { state.truncated = true; return; }
  state.files.add(relativePath);
}
async function walk(dir: string, root: string, state: WalkState): Promise<void> {
  if (state.truncated) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (state.truncated) return;
    const fullPath = join(dir, entry.name);
    const relativePath = relative(root, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!isFileBrowserExcludedPath(relativePath)) {
        // Parent navigation can reach large trees; bound directories as well as files.
        if (state.folders.size >= state.limit) { state.truncated = true; return; }
        state.folders.add(relativePath);
        await walk(fullPath, root, state);
      }
    } else if (entry.isFile() && includeWorkspaceFile(relativePath)) {
      addFile(state, relativePath);
    }
  }
}
export type FileListing = { root: string; tree: VaultNode[]; workspaceStatus: WorkspaceStatusPayload; truncated: boolean; fileLimit: number };
export async function listFiles(root: string, limit = DEFAULT_FILE_LIMIT): Promise<FileListing> {
  if (!(await stat(root).catch(() => null))?.isDirectory())
    throw new DomainError('The workspace directory is unavailable. Reopen the document from your agent.', 404);
  const state: WalkState = { files: new Set(), folders: new Set(), limit, truncated: false };
  // Seed changed files first so the cap never hides what the user just touched.
  const workspaceStatus = filterWorkspaceStatusForDirectory(await getWorkspaceStatusForDirectory(root), root, includeWorkspaceFile);
  for (const match of getWorkspaceStatusRelativePaths(workspaceStatus, root, includeWorkspaceFile)) {
    addFile(state, match);
    if (state.truncated) break;
  }
  await walk(root, root, state);
  return { root, tree: buildFileTree([...state.files].sort(), [...state.folders]), workspaceStatus, truncated: state.truncated, fileLimit: limit };
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
