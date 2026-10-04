# File Browser and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collapsible Files panel that lists the open document's agent-declared workspace with Plannotator's file browser and previews files read-only.

**Architecture:** The CLI records a canonical `workspace` directory on each document. Two cookie-authenticated viewer routes list and read files strictly inside that stored root, using server code ported from Plannotator. The viewer imports Plannotator's `FileBrowser`/`useFileBrowser` from the installed `@plannotator/ui` 0.47.0 and swaps the main pane to a read-only preview, reusing the original-document banner pattern.

**Tech Stack:** Node 22 + tsx, `node:test`, React 19, esbuild bundle-on-load, Playwright, `@plannotator/ui` 0.47.0, `@plannotator/core` 0.25.7.

**Spec:** `docs/superpowers/specs/2026-10-03-file-browser-design.md`

## Global Constraints

- Work only in `/Users/seanoh/ws/pg/sidecar/.claude/worktrees/file-browser` on branch `feat/file-browser`. Never edit the main checkout or other worktrees.
- Plannotator reference source: `/private/tmp/claude-501/-Users-seanoh-ws-pg-amc/c3f10180-8357-4853-b492-fb04b09d3bbd/scratchpad/plannotator`, commit `772c620302f584654c3d8e17bbffb2c6255d3331` (MIT terms). If that clone is gone, re-clone `https://github.com/backnotprop/plannotator` and `git checkout 772c620302f584654c3d8e17bbffb2c6255d3331`.
- Do not upgrade `@plannotator/ui` (stays `0.47.0`). Add exactly one dependency: `@plannotator/core` pinned to `0.25.7`.
- The client never supplies a directory. Every file route resolves its root from the stored document record.
- Browsing and previewing never register documents, create threads, or contact the agent.
- State stays at version 3; `workspace` is an optional document field. No migration.
- Previously shipped behavior must remain intact: pins/windows/dock, copy modes, text sizing, library browsing, search, drafts, Stop, message quoting, original-document view.
- Keep UI compact and Plannotator-styled. No live file watching.
- Commit messages: conventional (`feat:`, `docs:`, `test:`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: `pnpm test` (all backend), `node --import tsx --test test/NAME.test.ts` (one file), `pnpm typecheck`, `pnpm exec playwright test` (one worker, ~2.5 min), `pnpm exec playwright test -g "TITLE"`.

## Review Focus

- Opening a preview while a passage comment has an unsent draft: the draft must survive; reselecting the passage after **Back to document** restores it. (Task 3 browser test.)
- Navigating from the conversation while a preview is open (quote click → passage, **View original document**): the preview must close so the target is visible. (Task 3 browser test.)
- A workspace with no previewable files: show "No previewable files in this workspace.", not Plannotator's "Add directories in Settings → Files" hint. (Task 3 browser test.)
- A workspace removed after opening (worktree torn down): listing returns 404 with a clear message and the panel shows it instead of crashing. (Task 2 route test, Task 3 renders `FileBrowser`'s error state.)
- Relative images inside a previewed Markdown file must not resolve against the open document's folder and display an unrelated image; previews pass an empty document ID so `/api/image` refuses them. (Task 3 browser test.)

---

### Task 1: Record the agent-declared workspace

**Files:**
- Modify: `src/store.ts` (DocumentRecord type, `isDocument`, `registerDocument`)
- Modify: `src/server.ts` (`POST /agent/documents`)
- Modify: `src/cli.ts` (`workspaceMetadata`, `open`, parseArgs options, help text)
- Modify: `.agents/skills/sidecar/SKILL.md` (open instructions)
- Modify: `README.md` ("Use from an agent")
- Test: `test/repository.test.ts`

**Interfaces:**
- Produces: `DocumentRecord.workspace?: string` (absolute real directory path); `registerDocument(state, { path, title?, generated, repoInfo?, workspace? })`; `workspaceMetadata(explicit?: string, cwd?: string): Promise<{ workspace?: string; repoInfo?: RepoInfo }>` exported from `src/cli.ts`; viewer state `documents[id].workspace`.

- [ ] **Step 1: Install dependencies in the worktree**

Run: `pnpm install --frozen-lockfile --offline`
Expected: completes without network errors.

- [ ] **Step 2: Write the failing test**

Append to `test/repository.test.ts` (add `mkdir`, `realpath` to the `node:fs/promises` import and `workspaceMetadata` to the `../src/cli.ts` import):

```ts
test('documents record the declared or Git workspace and badge it', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'example'), linked = join(root, 'task');
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
  await git('init', '-b', 'main', repo);
  await git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  await git('-C', repo, 'worktree', 'add', '-b', 'feature/files', linked);
  await mkdir(join(linked, 'docs'));
  const task = { workspace: linked, repoInfo: { display: 'example', branch: 'feature/files' } };
  assert.deepEqual(await workspaceMetadata(undefined, join(linked, 'docs')), task);
  // An agent sitting in the main checkout declares the worktree it is working in.
  assert.deepEqual(await workspaceMetadata(linked, repo), task);
  assert.deepEqual(await workspaceMetadata('../task', repo), task);
  assert.deepEqual(await workspaceMetadata(undefined, root), {});
  await assert.rejects(workspaceMetadata(join(root, 'missing'), repo));

  const f = await fixture(t), doc = await f.register();
  assert.equal(doc.workspace, undefined);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: 'relative/dir' })).status, 400);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: doc.path })).status, 400);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: join(root, 'missing') })).status, 400);
  assert.equal((await (await f.agent('/agent/documents', { path: doc.path, ...task })).json()).workspace, linked);
  await f.reopen();
  assert.equal((await (await f.view('/api/state')).json()).documents[doc.id].workspace, linked);
  // Reopening without workspace information keeps the known root; a new declaration replaces it.
  assert.equal((await (await f.agent('/agent/documents', { path: doc.path })).json()).workspace, linked);
  assert.equal((await (await f.agent('/agent/documents', { path: doc.path, workspace: repo })).json()).workspace, repo);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test test/repository.test.ts`
Expected: FAIL — `workspaceMetadata` is not exported.

- [ ] **Step 4: Store the field**

In `src/store.ts`:

```ts
export type DocumentRecord = { id: string; path: string; generated: boolean; providedTitle?: string; userTitle?: string; repoInfo?: RepoInfo; workspace?: string };
```

Append to the `isDocument` condition: `&& (v.workspace === undefined || (string(v.workspace) && isAbsolute(v.workspace)))`.

Change `registerDocument`'s input type to `{path: string; title?: string; generated: boolean; repoInfo?: RepoInfo; workspace?: string}` and add, beside the `repoInfo` assignment:

```ts
  if (input.workspace !== undefined) document.workspace = input.workspace;
```

- [ ] **Step 5: Validate it at the agent route**

In `src/server.ts`, add `stat` to the `node:fs/promises` import. In the `POST /agent/documents` handler, after the `repoInfo` check:

```ts
        let workspace: string | undefined;
        if (body.workspace !== undefined) {
          const declared = text(body, 'workspace');
          if (!isAbsolute(declared)) throw new DomainError('Workspace must be an absolute directory path');
          workspace = await realpath(declared).catch(() => { throw new DomainError('Workspace must be an existing directory'); });
          if (!(await stat(workspace)).isDirectory()) throw new DomainError('Workspace must be an existing directory');
        }
```

and pass `workspace` into `registerDocument(state, { ..., repoInfo, workspace })`.

- [ ] **Step 6: Compute it in the CLI**

In `src/cli.ts`, add `realpath` to the `node:fs/promises` import (create the import if absent) and add below `repositoryInfo`:

```ts
// The browsed root: the worktree the agent declares, else the Git top-level of its working directory.
export async function workspaceMetadata(explicit?: string, cwd = process.cwd()) {
  let workspace: string | undefined;
  if (explicit) workspace = await realpath(resolve(cwd, explicit));
  else {
    const topLevel = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000 }).then(result => result.stdout.trim(), () => '');
    if (topLevel) workspace = await realpath(topLevel);
  }
  const repoInfo = await repositoryInfo(workspace ?? cwd);
  return { ...(workspace ? { workspace } : {}), ...(repoInfo ? { repoInfo } : {}) };
}
```

Add `workspace: { type: 'string' }` to the `parseArgs` options. In `open`, replace `repoInfo: await repositoryInfo()` with `...(await workspaceMetadata(values.workspace))`. In the help text change the Open line to:

```
Open: sidecar open --agent codex|claude --session UUID --file /absolute/document.md [--workspace /absolute/worktree]
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --import tsx --test test/repository.test.ts test/store.test.ts test/server.test.ts`
Expected: PASS.

- [ ] **Step 8: Document it**

In `.agents/skills/sidecar/SKILL.md`, replace the sentence "Run from the agent’s project workspace: `open` records its repository and branch for the document header." with:

```
Pass `--workspace /absolute/worktree` naming the checkout you are actually working in — especially a linked worktree when your session started in the main checkout. Without it, `open` uses the Git top-level of your working directory. The workspace roots the viewer's Files panel and its repository/branch badge. Rerun `open` for the same file with a new `--workspace` after moving to another worktree.
```

In `README.md` "Use from an agent", after the `sidecar open ...` code block's following paragraph, add:

```
`--workspace /absolute/worktree` records the checkout the agent is working in; it defaults to the Git top-level of the command's working directory. It roots the document's Files panel and repository/branch badge. Reopening the same file with a different `--workspace` updates it.
```

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add src/store.ts src/server.ts src/cli.ts .agents/skills/sidecar/SKILL.md README.md test/repository.test.ts
git commit -m "feat: record each document's agent-declared workspace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Workspace file listing and content routes

**Files:**
- Create: `src/workspace-status.ts` (verbatim copy)
- Create: `src/files.ts`
- Modify: `src/server.ts` (two GET routes)
- Modify: `package.json`, `pnpm-lock.yaml` (`@plannotator/core` 0.25.7)
- Modify: `THIRD_PARTY_NOTICES.md`
- Test: `test/files.test.ts`

**Interfaces:**
- Consumes: `DocumentRecord.workspace` (Task 1).
- Produces: `GET /api/files?document=ID` → `FileListing = { root: string; tree: VaultNode[]; workspaceStatus: WorkspaceStatusPayload; truncated: boolean; fileLimit: number }`; `GET /api/files/content?document=ID&path=RELATIVE` → `FilePreviewData = { path: string; text: string; renderAs: 'markdown' | 'html' | 'mermaid' | 'graphviz' }`. `VaultNode = { name: string; path: string; type: 'file' | 'folder'; children?: VaultNode[] }` with `path` relative to `root`. Errors are `{ error }` with 400/403/404/413/415.

- [ ] **Step 1: Add the core dependency**

Run: `pnpm add @plannotator/core@0.25.7 --save-exact --offline`
Expected: `package.json` gains `"@plannotator/core": "0.25.7"`; the lockfile resolves the already-present 0.25.7.

- [ ] **Step 2: Write the failing tests**

Create `test/files.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listFiles, readPreview, type VaultNode } from '../src/files.ts';
import { fixture } from './support.ts';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
const names = (nodes: VaultNode[]) => nodes.map(node => node.type === 'folder' ? `${node.name}/` : node.name).sort();

test('listing follows Plannotator file types, exclusions and folder-first order', async t => {
  const root = await workspace(t);
  await write(root, {
    'README.md': '# Hi', 'docs/plan.md': '# Plan', 'docs/flow.mmd': 'graph TD; A-->B', 'page.html': '<p>x</p>',
    'config.yaml': 'a: 1', 'src.ts': 'export {}', '.env': 'SECRET=1', '.env.example': 'SECRET=',
    'node_modules/pkg/README.md': '# dep', '.claude/worktrees/x/notes.md': '# nested worktree',
  });
  const listing = await listFiles(root);
  assert.equal(listing.root, root);
  assert.equal(listing.truncated, false);
  assert.equal(listing.fileLimit, 5000);
  assert.equal(listing.tree[0].type, 'folder');
  assert.deepEqual(names(listing.tree), names([
    { name: 'docs', path: 'docs', type: 'folder' }, { name: '.env.example', path: '.env.example', type: 'file' },
    { name: 'config.yaml', path: 'config.yaml', type: 'file' }, { name: 'page.html', path: 'page.html', type: 'file' },
    { name: 'README.md', path: 'README.md', type: 'file' },
  ]));
  assert.deepEqual(names(listing.tree.find(node => node.name === 'docs')!.children!), ['flow.mmd', 'plan.md']);
  assert.equal(listing.tree.find(node => node.name === 'docs')!.children!.find(node => node.name === 'plan.md')!.path, 'docs/plan.md');
});

test('changed files survive the cap and report Git status', async t => {
  const root = await workspace(t);
  await git(root, 'init', '-b', 'main');
  await write(root, { 'a0.md': '# 0', 'a1.md': '# 1', 'a2.md': '# 2', 'a3.md': '# 3' });
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  await write(root, { 'z-untracked.md': '# new', 'a0.md': '# 0 changed\n\nmore\n' });
  const listing = await listFiles(root, 3);
  assert.equal(listing.truncated, true);
  assert.equal(listing.fileLimit, 3);
  assert.ok(names(listing.tree).includes('z-untracked.md'));
  assert.ok(names(listing.tree).includes('a0.md'));
  assert.equal(listing.workspaceStatus.available, true);
  assert.ok(Object.keys(listing.workspaceStatus.files).some(path => path.endsWith('z-untracked.md')));
});

test('a workspace outside Git still lists files', async t => {
  const root = await workspace(t);
  await write(root, { 'notes.md': '# Notes' });
  const listing = await listFiles(root);
  assert.deepEqual(names(listing.tree), ['notes.md']);
  assert.equal(listing.workspaceStatus.available, false);
});

test('previews stay inside the workspace and say how to render', async t => {
  const root = await workspace(t), outside = await workspace(t);
  await write(outside, { 'secret.md': '# secret' });
  await write(root, {
    'docs/plan.md': '# Plan', 'flow.mmd': 'graph TD; A-->B', 'graph.gv': 'digraph { a -> b }', 'page.html': '<p>x</p>',
    'notes.txt': 'plain', 'src.ts': 'export {}', '.env': 'SECRET=1', 'node_modules/pkg/README.md': '# dep',
    'big.md': 'x'.repeat(2 * 1024 * 1024 + 1),
  });
  await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));
  assert.deepEqual(await readPreview(root, 'docs/plan.md'), { path: 'docs/plan.md', text: '# Plan', renderAs: 'markdown' });
  assert.equal((await readPreview(root, 'notes.txt')).renderAs, 'markdown');
  assert.equal((await readPreview(root, 'flow.mmd')).renderAs, 'mermaid');
  assert.equal((await readPreview(root, 'graph.gv')).renderAs, 'graphviz');
  assert.equal((await readPreview(root, 'page.html')).renderAs, 'html');
  const status = (path: string) => readPreview(root, path).then(() => 200, (error: { status?: number }) => error.status);
  assert.equal(await status(`../${basename(outside)}/secret.md`), 403);
  assert.equal(await status(join(outside, 'secret.md')), 400);
  assert.equal(await status('escape.md'), 403);
  assert.equal(await status('src.ts'), 415);
  assert.equal(await status('.env'), 415);
  assert.equal(await status('node_modules/pkg/README.md'), 415);
  assert.equal(await status('big.md'), 413);
  assert.equal(await status('missing.md'), 404);
  assert.equal(await status(''), 400);
});

test('viewer file routes read only the stored document workspace', async t => {
  const root = await workspace(t);
  await write(root, { 'notes.md': '# Notes' });
  const f = await fixture(t), doc = await f.register();
  assert.equal((await f.view(`/api/files?document=${doc.id}`)).status, 404);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  const listing = await (await f.view(`/api/files?document=${doc.id}&dirPath=${encodeURIComponent('/etc')}`)).json();
  assert.equal(listing.root, root);
  assert.deepEqual(names(listing.tree), ['notes.md']);
  assert.deepEqual(await (await f.view(`/api/files/content?document=${doc.id}&path=notes.md`)).json(), { path: 'notes.md', text: '# Notes', renderAs: 'markdown' });
  assert.equal((await f.view(`/api/files/content?document=${doc.id}&path=${encodeURIComponent('../notes.md')}`)).status, 403);
  assert.equal((await fetch(`${f.url}/api/files?document=${doc.id}`)).status, 403);
  assert.equal((await f.view('/api/files?document=missing')).status, 404);
  await rm(root, { recursive: true, force: true });
  const gone = await f.view(`/api/files?document=${doc.id}`);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /workspace directory is unavailable/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --test test/files.test.ts`
Expected: FAIL — cannot find module `../src/files.ts`.

- [ ] **Step 4: Copy Plannotator's Git status verbatim**

Run:

```bash
P=/private/tmp/claude-501/-Users-seanoh-ws-pg-amc/c3f10180-8357-4853-b492-fb04b09d3bbd/scratchpad/plannotator
{ printf '%s\n' '// Copied from Plannotator packages/shared/workspace-status.ts at 772c620 (MIT); see THIRD_PARTY_NOTICES.md.'; cat "$P/packages/shared/workspace-status.ts"; } > src/workspace-status.ts
```

It already uses only `node:` APIs and imports its types from `@plannotator/core/workspace-status-types`. Do not edit it beyond the header line.

- [ ] **Step 5: Write `src/files.ts`**

```ts
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ANNOTATABLE_DOC_REGEX, MAX_ANNOTATABLE_FILE_BYTES, diagramRenderKindForPath } from '@plannotator/core/annotatable';
import { filterWorkspaceStatusForDirectory, getWorkspaceStatusForDirectory, getWorkspaceStatusRelativePaths, type WorkspaceFileChange, type WorkspaceStatusPayload } from './workspace-status.ts';
import { DomainError } from './store.ts';

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
export function buildFileTree(relativePaths: string[]): VaultNode[] {
  const root: VaultNode[] = [];
  for (const filePath of relativePaths) {
    const parts = filePath.split('/');
    let current = root, pathSoFar = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], isFile = i === parts.length - 1;
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
const includeWorkspaceFile = (relativePath: string, _change: WorkspaceFileChange) =>
  ANNOTATABLE_DOC_REGEX.test(relativePath) && !isFileBrowserExcludedPath(relativePath);
type WalkState = { files: Set<string>; limit: number; truncated: boolean };
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
      if (!isFileBrowserExcludedPath(relativePath)) await walk(fullPath, root, state);
    } else if (entry.isFile() && ANNOTATABLE_DOC_REGEX.test(entry.name) && !isFileBrowserExcludedPath(relativePath)) {
      addFile(state, relativePath);
    }
  }
}
export type FileListing = { root: string; tree: VaultNode[]; workspaceStatus: WorkspaceStatusPayload; truncated: boolean; fileLimit: number };
export async function listFiles(root: string, limit = DEFAULT_FILE_LIMIT): Promise<FileListing> {
  if (!(await stat(root).catch(() => null))?.isDirectory())
    throw new DomainError('The workspace directory is unavailable. Reopen the document from your agent.', 404);
  const state: WalkState = { files: new Set(), limit, truncated: false };
  // Seed changed files first so the cap never hides what the user just touched.
  const workspaceStatus = filterWorkspaceStatusForDirectory(await getWorkspaceStatusForDirectory(root), root, includeWorkspaceFile);
  for (const match of getWorkspaceStatusRelativePaths(workspaceStatus, root, includeWorkspaceFile)) {
    addFile(state, match);
    if (state.truncated) break;
  }
  await walk(root, root, state);
  return { root, tree: buildFileTree([...state.files].sort()), workspaceStatus, truncated: state.truncated, fileLimit: limit };
}

export type FilePreviewData = { path: string; text: string; renderAs: 'markdown' | 'html' | 'mermaid' | 'graphviz' };
const isOutside = (root: string, candidate: string) => {
  const fromRoot = relative(root, candidate);
  return fromRoot.startsWith('..') || isAbsolute(fromRoot);
};
export async function readPreview(root: string, path: string): Promise<FilePreviewData> {
  if (!path || isAbsolute(path)) throw new DomainError('Expected a path inside the workspace');
  const lexical = resolve(root, path);
  if (isOutside(root, lexical)) throw new DomainError('Path is outside the workspace', 403);
  const real = await realpath(lexical).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new DomainError('File not found', 404);
    throw error;
  });
  const realRoot = await realpath(root);
  if (isOutside(realRoot, real)) throw new DomainError('Path is outside the workspace', 403);
  const relativePath = relative(realRoot, real).split(sep).join('/');
  if (!ANNOTATABLE_DOC_REGEX.test(relativePath) || isFileBrowserExcludedPath(relativePath))
    throw new DomainError('This file type cannot be previewed', 415);
  const info = await stat(real);
  if (!info.isFile()) throw new DomainError('A regular file is required');
  if (info.size > MAX_ANNOTATABLE_FILE_BYTES) throw new DomainError('File exceeds the 2 MiB preview limit', 413);
  const diagram = diagramRenderKindForPath(relativePath);
  return { path: relativePath, text: await readFile(real, 'utf8'), renderAs: diagram ?? (/\.html?$/i.test(relativePath) ? 'html' : 'markdown') };
}
```

- [ ] **Step 6: Add the routes**

In `src/server.ts`, import `{ listFiles, readPreview } from './files.ts'` and add immediately after the `GET /api/library` line:

```ts
      if (method === 'GET' && (path === '/api/files' || path === '/api/files/content')) {
        // The root always comes from the document record; the viewer cannot name a directory.
        const document = get(store.read().documents, target.searchParams.get('document') ?? '');
        if (!document.workspace) throw new DomainError('This document has no recorded workspace. Reopen it from your agent.', 404);
        json(response, path === '/api/files'
          ? await listFiles(document.workspace)
          : await readPreview(document.workspace, target.searchParams.get('path') ?? ''));
        return;
      }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --import tsx --test test/files.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Record provenance**

In `THIRD_PARTY_NOTICES.md`, before the "Inter and Geist Mono" paragraph, add:

```
`src/workspace-status.ts` is copied unchanged from Plannotator's
`packages/shared/workspace-status.ts`. The file-browser exclusions and tree
builder in `src/files.ts` are copied from `packages/shared/reference-common.ts`,
and its walk, file cap and changed-file seeding follow `handleFileBrowserFiles`
in `packages/server/reference-handlers.ts`. File-type predicates are imported
from the published `@plannotator/core` 0.25.7 `annotatable` module.
Source: https://github.com/backnotprop/plannotator/tree/772c620302f584654c3d8e17bbffb2c6255d3331/packages
```

- [ ] **Step 9: Full backend run, typecheck, commit**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

```bash
git add package.json pnpm-lock.yaml src/workspace-status.ts src/files.ts src/server.ts test/files.test.ts THIRD_PARTY_NOTICES.md
git commit -m "feat: list and read files inside a document's workspace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Files panel and read-only preview

**Files:**
- Create: `web/FilesPanel.tsx`
- Create: `web/FilePreview.tsx`
- Modify: `web/app.tsx` (state, toggle, layout, preview swap, navigation exits)
- Modify: `web/conversations.tsx` (`folder` icon path)
- Modify: `web/app.css`
- Modify: `README.md`, `THIRD_PARTY_NOTICES.md`
- Modify: `docs/superpowers/specs/2026-10-03-file-browser-design.md` (HTML sandbox line)
- Test: `test/browser.spec.ts`

**Interfaces:**
- Consumes: `GET /api/files`, `GET /api/files/content`, `FilePreviewData` (Task 2); `ViewerState.documents[id].workspace` (Task 1).
- Produces: `FilesPanel({ documentId: string; root: string; activePath: string | null; onSelect: (relativePath: string) => void })`; `FilePreview({ documentId: string; path: string; onReturn: () => void })`.

- [ ] **Step 1: Write the failing browser tests**

Append to `test/browser.spec.ts`:

```ts
async function filesWorkspace(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-files-ui-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test('files panel previews workspace files read-only and keeps drafts', async ({ page }) => {
  const root = await filesWorkspace({
    'docs/plan.md': '# Plan heading\n\nPlan body text.\n\n![chart](a.png)\n',
    'page.html': '<p id="static">Static HTML</p><script>document.getElementById("static").textContent = "ran"</script>',
    'flow.mmd': 'graph TD\n  Start --> Finish\n',
    'src.ts': 'export {};\n',
  });
  const doc = await f.register('main.md', '# Main document\n\nMain body passage for comments.\n');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('Main body passage');
  await expect(page.getByRole('button', { name: 'Show files' })).toHaveCount(0);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.getByRole('button', { name: 'Show files' }).click();
  const panel = page.getByRole('complementary', { name: 'Files' });
  await expect(panel.getByText('plan.md', { exact: true })).toBeVisible();
  await expect(panel.getByText('page.html', { exact: true })).toBeVisible();
  await expect(panel.getByText('src.ts', { exact: true })).toHaveCount(0);

  await select(page, 'Main body passage');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Draft survives preview');
  await panel.getByText('plan.md', { exact: true }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('heading', { name: 'Plan heading' })).toBeVisible();
  await expect(preview).toContainText('docs/plan.md');
  await expect(page.locator('#document')).toBeHidden();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await expect(preview.locator('img').first()).toHaveAttribute('src', /[?&]document=&/);
  await page.evaluate(() => {
    const text = [...document.querySelectorAll('.file-preview p')].find(p => p.textContent === 'Plan body text.')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.keyboard.press('c');
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);

  await panel.getByText('page.html', { exact: true }).click();
  const frame = page.frameLocator('iframe[title="Preview of page.html"]');
  await expect(frame.locator('#static')).toHaveText('Static HTML');
  await expect(page.locator('iframe[title="Preview of page.html"]')).toHaveAttribute('sandbox', '');
  await panel.getByText('flow.mmd', { exact: true }).click();
  await expect(preview.locator('svg').first()).toBeVisible();

  await preview.getByRole('button', { name: 'Back to document' }).click();
  await expect(page.locator('#document')).toBeVisible();
  await select(page, 'Main body passage');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Draft survives preview');
  expect(Object.keys((await state()).documents)).toEqual([doc.id]);
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Files' })).toBeVisible();
});

test('files panel handles empty workspaces, its own document and conversation navigation', async ({ page }) => {
  const empty = await filesWorkspace({ 'src.ts': 'export {};\n' });
  const root = await filesWorkspace({ 'nav.md': '# Navigation\n\nQuoted passage text.\n', 'a.md': '# A file\n' });
  const doc = await (await f.agent('/agent/documents', { path: join(root, 'nav.md'), workspace: empty })).json();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByRole('button', { name: 'Show files' }).click();
  const panel = page.getByRole('complementary', { name: 'Files' });
  await expect(panel).toContainText('No previewable files in this workspace.');
  await expect(panel).not.toContainText('Settings');

  // A new declaration re-roots the open panel through the live state update.
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await expect(panel.getByText('nav.md', { exact: true })).toBeVisible();
  await writeFile(join(root, 'b.md'), '# B file\n');
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await expect(panel.getByText('b.md', { exact: true })).toBeVisible();

  await select(page, 'Quoted passage text');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('About this passage');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await answer('Noted.');
  await panel.getByText('a.md', { exact: true }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('heading', { name: 'A file' })).toBeVisible();
  await page.getByRole('log').getByText('Quoted passage text').first().click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('#document')).toBeVisible();
  await panel.getByText('a.md', { exact: true }).click();
  await expect(preview).toBeVisible();
  // Selecting the open document's own file returns to it.
  await panel.getByText('nav.md', { exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('#document')).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec playwright test -g "files panel"`
Expected: FAIL — no **Show files** button appears.

- [ ] **Step 3: Add the folder icon**

In `web/conversations.tsx`, add to the `paths` object:

```ts
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
```

- [ ] **Step 4: Write `web/FilesPanel.tsx`**

```tsx
import { useEffect } from 'react';
import { FileBrowser } from '@plannotator/ui/components/sidebar/FileBrowser';
import { setFileTreeBackend, useFileBrowser } from '@plannotator/ui/hooks/useFileBrowser';

// Plannotator's file browser (MIT) over Sidecar's document-scoped listing; see THIRD_PARTY_NOTICES.md.
export function FilesPanel({ documentId, root, activePath, onSelect }: {
  documentId: string; root: string; activePath: string | null; onSelect: (relativePath: string) => void;
}) {
  const browser = useFileBrowser();
  const { fetchAll, fetchTree } = browser;
  useEffect(() => {
    // The server ignores the browser's directory and lists the document's stored workspace.
    setFileTreeBackend({
      loadTree: () => fetch(`/api/files?document=${encodeURIComponent(documentId)}`),
      loadVaultTree: async () => Response.json({ error: 'Vaults are unavailable' }, { status: 404 }),
      watchTrees: () => undefined,
    });
    fetchAll([root]);
  }, [documentId, root, fetchAll]);
  const dir = browser.dirs[0];
  const isEmpty = !!dir && !dir.isLoading && !dir.error && dir.tree.length === 0;
  return (
    <aside className="files-panel" id="files-panel" aria-label="Files">
      <div className="files-panel-header">
        <span>Files</span>
        <button aria-label="Refresh files" title="Refresh files" onClick={() => fetchTree(root)}>Refresh</button>
      </div>
      {isEmpty ? (
        <p className="files-empty">No previewable files in this workspace.</p>
      ) : (
        <FileBrowser
          dirs={browser.dirs}
          expandedFolders={browser.expandedFolders}
          onToggleFolder={browser.toggleFolder}
          collapsedDirs={browser.collapsedDirs}
          onToggleCollapse={browser.toggleCollapse}
          onSelectFile={(absolutePath) => onSelect(absolutePath.slice(root.length + 1))}
          activeFile={activePath ? `${root}/${activePath}` : null}
          onFetchAll={() => fetchAll([root])}
        />
      )}
    </aside>
  );
}
```

- [ ] **Step 5: Write `web/FilePreview.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { FilePreviewData } from '../src/files.ts';
import { api, errorText } from './api.ts';
import { MarkdownDocument } from './MarkdownDocument.tsx';

// Diagram sources render through the same fenced blocks as Plannotator's documents.
function fenced(language: string, text: string) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}\n`;
}

export function FilePreview({ documentId, path, onReturn }: { documentId: string; path: string; onReturn: () => void }) {
  const [preview, setPreview] = useState<FilePreviewData | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    setPreview(null);
    setError('');
    api<FilePreviewData>(`/api/files/content?document=${encodeURIComponent(documentId)}&path=${encodeURIComponent(path)}`)
      .then((loaded) => { if (!stopped) setPreview(loaded); }, (reason) => { if (!stopped) setError(errorText(reason)); });
    return () => { stopped = true; };
  }, [documentId, path]);
  const markdown = preview && (preview.renderAs === 'markdown' ? preview.text
    : preview.renderAs === 'mermaid' ? fenced('mermaid', preview.text)
    : preview.renderAs === 'graphviz' ? fenced('dot', preview.text) : null);
  return (
    <section className="original-document file-preview" aria-label="File preview">
      <div className="original-banner">
        <span>Previewing <code>{path}</code> · Read-only</span>
        <button onClick={onReturn}>Back to document</button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !preview ? (
        <p role="status">Loading file…</p>
      ) : markdown === null ? (
        // Sidecar's CSP is inherited by srcdoc, so the preview stays static: no scripts, opaque origin.
        <iframe className="file-preview-frame" title={`Preview of ${path}`} sandbox="" srcDoc={preview.text} />
      ) : (
        <article className="document-card w-full bg-card rounded-xl p-5 md:p-8 lg:p-10 xl:p-12 shadow-xl border border-border/50">
          {/* An empty document ID keeps relative images from resolving against the open document's folder. */}
          <MarkdownDocument markdown={markdown} documentId="" anchorPrefix="file-preview-" />
        </article>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Wire the panel into `web/app.tsx`**

Imports:

```tsx
import { FilesPanel } from './FilesPanel.tsx';
import { FilePreview } from './FilePreview.tsx';
```

After the `panelResize` layout effect add:

```tsx
  const [isFilesShown, setFilesShown] = useState(() => {
    try { return localStorage.getItem('sidecar-files-open') === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('sidecar-files-open', String(isFilesShown)); } catch { /* per-browser convenience only */ }
  }, [isFilesShown]);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const filesResize = useResizablePanel({
    storageKey: 'sidecar-files-width',
    defaultWidth: 280,
    side: 'left',
    onSnapClose: () => setFilesShown(false),
    onClick: () => setFilesShown(false),
    apply: (width) => document.documentElement.style.setProperty('--sidecar-files-width', `${width}px`),
  });
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidecar-files-width', `${filesResize.width}px`);
  }, [filesResize.width]);
```

After `clearPendingSelection` is defined, add:

```tsx
  const openPreview = (path: string) => {
    if (current?.workspace && `${current.workspace}/${path}` === current.path) { setPreviewPath(null); return; }
    // Keep passage drafts in passageDrafts; only drop the live selection on the hidden document.
    clearPendingSelection();
    window.getSelection()?.removeAllRanges();
    setOriginalMessageId(null);
    setPreviewPath(path);
    if (innerWidth <= 850) setFilesShown(false);
  };
```

In `selectionActions.showOriginal` and `selectionActions.showPassage`, add `setPreviewPath(null);` beside their `setOriginalMessageId(...)` calls.

In the top bar, immediately before the conversations `sidebar-toggle` button:

```tsx
        {current?.workspace && (
          <button
            className="sidebar-toggle"
            aria-label={isFilesShown ? 'Hide files' : 'Show files'}
            title={isFilesShown ? 'Hide files' : 'Show files'}
            aria-expanded={isFilesShown}
            aria-controls="files-panel"
            onClick={() => setFilesShown((shown) => !shown)}
          >
            <Icon name="folder" />
          </button>
        )}
```

Change the layout element and add the panel before `.document-workspace`:

```tsx
      <div className={`layout${isSidebarShown ? '' : ' sidebar-collapsed'}${isFilesShown && current?.workspace ? ' files-open' : ''}`}>
        {isFilesShown && current?.workspace && (
          <>
            <FilesPanel documentId={documentId} root={current.workspace} activePath={previewPath} onSelect={openPreview} />
            <ResizeHandle
              {...filesResize.handleProps}
              className="files-resize"
              side="left"
              hideHoverTrack
              tooltip="Drag to resize · Click to collapse"
              onCollapse={() => setFilesShown(false)}
            />
          </>
        )}
```

Inside `.reading-width`, render the preview first and hide the others while it is open:

```tsx
            {previewPath && (
              <FilePreview key={previewPath} documentId={documentId} path={previewPath} onReturn={() => setPreviewPath(null)} />
            )}
            {!previewPath && originalMessage?.quote && (
```

Change the error paragraph condition to `!previewPath && !originalMessage && (documentError || !current)` and the article's `hidden` to `hidden={!!originalMessage || !!previewPath}`.

- [ ] **Step 7: Style it**

Append to `web/app.css`:

```css
.layout.files-open {
  grid-template-columns: var(--sidecar-files-width, 280px) 0 minmax(0, 1fr) 0 var(--sidecar-panel-width, 365px);
}
.layout.files-open.sidebar-collapsed {
  grid-template-columns: var(--sidecar-files-width, 280px) 0 minmax(0, 1fr);
}
.files-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--card);
}
.files-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.files-panel-header button {
  font: inherit;
  letter-spacing: 0;
  text-transform: none;
  color: var(--primary);
  background: transparent;
  border: 0;
  padding: 2px 4px;
  cursor: pointer;
}
.files-panel-header button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.files-empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--muted-foreground);
}
.files-resize {
  z-index: 5;
}
.file-preview-frame {
  width: 100%;
  height: 75vh;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: white;
}
@media (max-width: 850px) {
  .layout.files-open,
  .layout.files-open.sidebar-collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .files-panel {
    position: fixed;
    top: 49px;
    bottom: 0;
    left: 0;
    width: min(300px, 100vw);
    z-index: 4;
    box-shadow: 15px 0 40px #0004;
  }
  .files-resize {
    display: none;
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm exec playwright test -g "files panel"`
Expected: PASS (2 tests). If the HTML frame is blank, inspect the console for a CSP `frame-src` refusal of `about:srcdoc`; if present, add `frame-src 'self' about:;` to the CSP header in `src/server.ts` `handle()` and rerun.

- [ ] **Step 9: Visual check**

Run: `pnpm exec playwright test -g "files panel previews"` after temporarily adding `await page.screenshot({ path: '/private/tmp/sidecar-files-panel.png', fullPage: true });` right after the `plan.md` preview assertion, and again at 600×600 with `await page.setViewportSize({ width: 600, height: 600 })` saving `/private/tmp/sidecar-files-panel-narrow.png`. Read both images: panel compact, Plannotator typography, no overlap with the conversation pane, banner legible. Remove the temporary lines.

- [ ] **Step 10: Document and record provenance**

In `README.md`, after the "Browse all documents" section, add:

```
## Workspace files

The folder button in the top bar opens a **Files** panel listing the document's workspace — the worktree its agent declared with `--workspace`, or the Git top-level it opened from. It uses Plannotator's file browser: the same file types, excluded folders (such as `node_modules` and `.claude`), 5,000-file cap, filter box, and Git change badges. Changed and untracked files are listed even past the cap. **Refresh** reloads the tree; it does not watch for changes.

Selecting a file previews it read-only in place of the document, with **Back to document** to return. Markdown, text and data files render as Markdown, Mermaid and Graphviz sources as diagrams, and HTML in a static sandboxed frame. Previewing never registers a document, starts a conversation, or contacts the agent; passage comments are unavailable until you return. Relative images inside previewed files are not loaded. The panel's width and open state are saved in this browser. Documents without a recorded workspace hide the button; reopen them from the agent to add one.
```

In `THIRD_PARTY_NOTICES.md`, after the Task 2 paragraph, add:

```
The Files panel imports `FileBrowser` and `useFileBrowser` from the published
`@plannotator/ui` 0.47.0, connected to Sidecar through its `setFileTreeBackend`
seam. The preview banner reuses Sidecar's original-document styling.
```

In the spec, replace "HTML in an `srcdoc` iframe with Plannotator's `sandbox="allow-scripts"` policy (opaque origin, so it cannot reach Sidecar's cookie or API)" with "HTML in an `srcdoc` iframe with an empty `sandbox` (opaque origin, no scripts): Sidecar's page CSP is inherited by `srcdoc` and would block inline scripts anyway, so the preview is static".

- [ ] **Step 11: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add web/FilesPanel.tsx web/FilePreview.tsx web/app.tsx web/conversations.tsx web/app.css test/browser.spec.ts README.md THIRD_PARTY_NOTICES.md docs/superpowers/specs/2026-10-03-file-browser-design.md
git commit -m "feat: browse and preview workspace files beside the document

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification and as-built note

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-file-browser-design.md` (As built)

- [ ] **Step 1: Run every suite, logging full output**

```bash
pnpm test > /private/tmp/sidecar-files-backend.log 2>&1; echo "backend=$?"
pnpm typecheck > /private/tmp/sidecar-files-types.log 2>&1; echo "types=$?"
pnpm exec playwright test > /private/tmp/sidecar-files-browser.log 2>&1; echo "browser=$?"
git diff --check origin/main...HEAD; echo "diffcheck=$?"
```

Expected: every exit code 0. On a failure, read the log, fix the root cause in the owning task's files, and commit the fix separately.

- [ ] **Step 2: Add the as-built note**

Append to the spec:

```
As built on 2026-10-03: server listing and preview live in `src/files.ts` with Plannotator's Git status copied unchanged into `src/workspace-status.ts`; the viewer imports `FileBrowser`/`useFileBrowser` from `@plannotator/ui` 0.47.0 through `setFileTreeBackend`. HTML previews use an empty sandbox. Relative images in previews are intentionally not resolved.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-03-file-browser-design.md
git commit -m "docs: note the file browser as built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
