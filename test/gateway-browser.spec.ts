import { writeFile, readFile, mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { test, expect } from '@playwright/test';
import { setupGateway } from './gateway-support.ts';
import { startGateway } from '../src/gateway.ts';

let f: Awaited<ReturnType<typeof setupGateway>>, cleanup: (() => Promise<void>)[];
test.beforeEach(async () => { cleanup = []; f = await setupGateway({ after: fn => { cleanup.push(fn); } }); });
test.afterEach(async () => { for (const fn of cleanup) await fn(); });

test('seven shared-origin tabs can load documents and send a message without starving HTTP requests', async ({ context }) => {
  test.setTimeout(30000);
  const pages = await Promise.all(Array.from({ length: 7 }, () => context.newPage()));
  cleanup.unshift(async () => { await Promise.all(pages.map(page => page.close())); });
  for (const [index, page] of pages.entries()) {
    const owner = f.owners[(index + 1) % 2];
    await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
    await expect(page.getByRole('heading', { name: owner.owner.agent, exact: true })).toBeVisible();
  }
  const owner = f.owners[1], page = pages[6], input = page.getByLabel('Message', { exact: true });
  await input.fill('Question from the seventh tab');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  let request: any;
  await expect.poll(async () => {
    request = Object.values<any>((await (await f.view(`/a/${owner.alias}/api/state`)).json()).requests).at(-1);
    return request?.text;
  }).toBe('Question from the seventh tab');
  await owner.agentCall(`/agent/requests/${request.id}/claim`, {});
  await owner.agentCall('/agent/replies', { requestId: request.id, documentId: owner.doc.id, threadId: request.threadId, text: 'The seventh tab works.' });
  await expect(page.locator('.sidebar').getByText('The seventh tab works.', { exact: true })).toBeVisible();
});

test('prefixed document uses only its owner APIs and preserves its draft on reload', async ({ page, context }) => {
  const owner = f.owners[1], path = `/a/${owner.alias}/?document=${owner.doc.id}`;
  const legacy = await context.newPage(), runtime = JSON.parse(await readFile(join(owner.directory, 'runtime.json'), 'utf8'));
  await legacy.goto(runtime.url + '/?document=' + owner.doc.id);
  await legacy.getByLabel('Message', { exact: true }).fill('Old origin draft');
  await legacy.waitForTimeout(150);
  const before = await legacy.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('sidecar-draft:')));
  expect(before.length).toBeGreaterThan(0);
  const errors: string[] = [], apiPaths: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.includes('/api/')) apiPaths.push(url.pathname); });
  page.on('websocket', socket => apiPaths.push(new URL(socket.url()).pathname));
  await page.goto(f.gateway.url + path);
  await expect(page.getByRole('heading', { name: 'claude', exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('A draft on the shared origin');
  await page.waitForTimeout(150); await page.reload();
  await expect(input).toHaveValue('A draft on the shared origin');
  await expect.poll(() => apiPaths.some(path => path.endsWith('/api/events'))).toBe(true);
  expect(apiPaths.every(path => path.startsWith(`/a/${owner.alias}/api/`))).toBe(true);
  expect(errors).toEqual([]);
  const stateFetches = apiPaths.filter(path => path.endsWith('/api/state')).length;
  await page.waitForTimeout(1200);
  expect(apiPaths.filter(path => path.endsWith('/api/state'))).toHaveLength(stateFetches);
  expect(apiPaths.some(path => path.includes('/api/files'))).toBe(false);
  expect(await legacy.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('sidecar-draft:')))).toEqual(before);
  await legacy.close();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Allow access on local network' }).click();
  await page.getByLabel('Public HTTPS URL', { exact: true }).fill('https://sidecar.example');
  await page.getByRole('button', { name: 'Save URL', exact: true }).click();
  await expect(page.getByRole('link', { name: /^https:\/\/sidecar\.example/ })).toHaveAttribute('href', `https://sidecar.example${path}`);
});

test('a live tab reconnects after its owner restarts and keeps its unsent draft', async ({ page }) => {
  const owner = f.owners[1], sockets: string[] = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Keep this unsent draft');
  await expect(page.getByRole('heading', { name: 'claude', exact: true })).toBeVisible();
  await owner.stop();
  await writeFile(join(owner.directory, 'review.md'), '# Reconnected document\n\nAn update while disconnected.');
  await owner.restart();
  await expect(page.getByRole('heading', { name: 'Reconnected document', exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep this unsent draft');
  expect(sockets.length).toBeGreaterThan(1);
  expect(Object.keys((await (await f.view(`/a/${owner.alias}/api/state`)).json()).requests)).toHaveLength(0);
});

test('a local tab renews its login after a gateway restart without reloading or sending its draft', async ({ page }) => {
  const owner = f.owners[1];
  let snapshots = 0;
  page.on('response', response => { if (response.ok() && new URL(response.url()).pathname.endsWith('/api/state')) snapshots++; });
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Keep this draft across gateway restart');
  await expect(page.getByRole('heading', { name: 'claude', exact: true })).toBeVisible();
  const before = snapshots;
  await f.gateway.close();
  const gateway = await startGateway({ stateRoot: f.root, port: Number(new URL(f.gateway.url).port), networkPort: 0 });
  cleanup.unshift(() => gateway.close());
  await expect.poll(() => snapshots).toBeGreaterThan(before);
  await expect(input).toHaveValue('Keep this draft across gateway restart');
  expect(Object.keys((await (await page.request.get(`${gateway.url}/a/${owner.alias}/api/state`)).json()).requests)).toHaveLength(0);
});


test('prefixed images, file windows, proposals and original versions remain on the same owner', async ({ page }) => {
  const owner = f.owners[1], base = `/a/${owner.alias}`, path = join(owner.directory, 'review.md');
  await writeFile(path, '# Review\n\nOwn document.\n\n![Local](image.svg)\n\n[Code](example.ts:1)');
  await writeFile(join(owner.directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="purple"/></svg>');
  await writeFile(join(owner.directory, 'example.ts'), 'export const answer = 42;\n');
  await page.goto(`${f.gateway.url}${base}/?document=${owner.doc.id}`);
  await expect(page.locator('#document img')).toHaveAttribute('src', new RegExp(`^${base}/api/image`));
  await expect.poll(() => page.locator('#document img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(20);
  await page.locator('#document').getByRole('link', { name: 'Code', exact: true }).click();
  const file = page.getByRole('dialog', { name: 'File: example.ts', exact: true });
  await expect(file.locator('pre code')).toContainText('export const answer = 42;');
  await file.getByRole('button', { name: 'Show in file browser' }).click();
  await expect(page.getByRole('complementary', { name: 'Files' }).getByTitle('example.ts', { exact: true })).toBeVisible();
  await file.getByRole('button', { name: 'Close file window', exact: true }).click();
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Propose a change'); await input.press('Enter');
  await expect(input).toHaveValue('');
  let request: any;
  await expect.poll(async () => { request = Object.values<any>((await (await f.view(base + '/api/state')).json()).requests).at(-1); return request?.text; }).toBe('Propose a change');
  await owner.agentCall(`/agent/requests/${request.id}/claim`, {});
  const reply = '[[sidecar-meta {"highlights":[{"exact":"Own document.","proposal":{"before":"Own document.","after":"Revised document."}}]}]]\nReview [this change](#selection-1).';
  await owner.agentCall('/agent/replies', { requestId: request.id, documentId: owner.doc.id, threadId: request.threadId, text: reply });
  await page.locator('.sidebar .proposal-card').getByRole('button', { name: 'Review change' }).click();
  const proposal = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  await expect(proposal.getByRole('button', { name: 'View original document' })).toBeVisible();
  await proposal.getByRole('button', { name: 'View original document' }).click();
  await expect(page.getByRole('region', { name: 'Original document' })).toContainText('Own document.');
  await proposal.getByRole('button', { name: 'Return to current', exact: true }).click();
  await proposal.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(() => readFile(path, 'utf8')).toContain('Revised document.');
  expect(await readFile(join(f.owners[0].directory, 'review.md'), 'utf8')).toContain('Own document.');
});

test('global agents and owner documents have independent remembered sort settings', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(f.gateway.url);
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  const rows = page.locator('.library-agent-row'); await expect(rows).toHaveCount(2);
  const first = rows.filter({ has: page.getByTitle(f.owners[0].owner.sessionId, { exact: true }) });
  await expect(first).toContainText('1 document');
  await expect(first.locator('.library-session-id')).toHaveText(`${f.owners[0].alias}:${f.owners[0].owner.sessionId.slice(0, 3)}…${f.owners[0].owner.sessionId.slice(-3)}`);
  await first.getByRole('button', { name: 'Agent actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy session ID' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(f.owners[0].owner.sessionId);
  await expect(page.getByRole('menuitem', { name: 'Copied session ID' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sort agents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await rows.filter({ has: page.getByTitle(f.owners[1].owner.sessionId, { exact: true }) }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sort documents' })).toContainText('Last opened');
  await page.getByRole('button', { name: 'Sort documents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await page.reload(); await expect(page.getByRole('button', { name: 'Sort documents' })).toContainText('Recent conversation activity');
  await page.getByRole('link', { name: 'All agents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort agents' })).toContainText('Recent conversation activity');
  await page.screenshot({ path: '/private/tmp/sidecar-gateway-agents.png' });
});

test('agent and document rows display the timestamp for the selected sort', async ({ page }) => {
  const now = Date.now(), lastMessage = now - 3 * 86400000;
  await page.clock.setFixedTime(now);
  await page.route('**/api/library', async route => {
    const response = await route.fetch(), library = await response.json();
    for (const session of library.sessions) for (const document of session.documents) {
      document.lastOpenedAt = now - 2 * 3600000;
      document.updatedAt = session.owner.agent === 'codex' ? lastMessage : 0;
    }
    await route.fulfill({ response, json: library });
  });
  await page.goto(f.gateway.url);
  const row = page.locator('.library-agent-row').filter({ has: page.getByTitle(f.owners[0].owner.sessionId, { exact: true }) });
  await expect(row).toContainText('Last opened 2h ago');
  await page.getByRole('button', { name: 'Sort agents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await expect(row).toContainText('Last message: 3d');
  await expect(row).not.toContainText('ago');
  await expect(row.locator('time')).toHaveAttribute('datetime', new Date(lastMessage).toISOString());
  await expect(row.locator('time')).toHaveAttribute('title', /\d/);
  await expect(page.locator('.library-agent-row').filter({ has: page.getByTitle(f.owners[1].owner.sessionId, { exact: true }) })).toContainText('Last message: —');
  await row.getByRole('link').click();
  const document = page.locator('.library-document');
  await expect(document).toContainText('Last opened 2h ago');
  await page.getByRole('button', { name: 'Sort documents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await expect(document).toContainText('Last message: 3d');
  await expect(document).not.toContainText('ago');
});

test('agent cards show native session names and the last-opened workspace and branch', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const owner = f.owners[0];
  const previousCodex = process.env.CODEX_HOME, previousClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = join(f.root, 'codex'); process.env.CLAUDE_CONFIG_DIR = join(f.root, 'claude');
  cleanup.unshift(async () => {
    if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  });
  const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'original-project');
  await mkdir(project, { recursive: true }); await mkdir(process.env.CODEX_HOME);
  await writeFile(join(process.env.CODEX_HOME, 'session_index.jsonl'), JSON.stringify({ id: owner.owner.sessionId, thread_name: 'Review semantic graph and queue admission evidence' }) + '\n');
  await writeFile(join(project, f.owners[1].owner.sessionId + '.jsonl'), JSON.stringify({ type: 'ai-title', sessionId: f.owners[1].owner.sessionId, aiTitle: 'Transfer review' }) + '\n');
  await owner.agentCall('/agent/documents', { path: owner.doc.path, workspace: homedir(), repoInfo: { display: 'example', branch: 'main' } });
  const file = join(owner.directory, 'latest.md'); await writeFile(file, '# Latest workspace');
  const latest = await (await owner.agentCall('/agent/documents', { path: file, workspace: process.cwd(), repoInfo: { display: 'example', branch: 'feat/workspace-labels' } })).json();
  await f.view(`/a/${owner.alias}/api/documents/${latest.id}/opened`, {});
  await page.goto(f.gateway.url);
  const row = page.locator('.library-agent-row').filter({ has: page.getByTitle(owner.owner.sessionId, { exact: true }) });
  await expect(row.locator('.library-agent-name')).toHaveText('Review semantic graph and queue admission evidence');
  await expect(row.locator('.library-agent-meta')).toContainText('Codex');
  await expect(page.locator('.library-agent-row').filter({ has: page.getByTitle(f.owners[1].owner.sessionId, { exact: true }) }).locator('.library-agent-name')).toHaveText('Transfer review');
  const workspace = row.locator('.library-agent-context');
  const displayPath = process.cwd() === homedir() ? '~' : process.cwd().startsWith(homedir() + sep) ? '~' + process.cwd().slice(homedir().length) : process.cwd();
  await expect(workspace.getByTitle(process.cwd(), { exact: true })).toHaveText(displayPath);
  await expect(row.locator('.library-agent-meta').getByTitle('feat/workspace-labels', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sort agents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await expect(row.locator('.library-agent-meta')).toContainText('feat/workspace-labels');
  await page.screenshot({ path: '/private/tmp/sidecar-agent-workspaces-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.getByTitle('feat/workspace-labels', { exact: true })).toBeVisible();
  const card = await row.getByRole('link').boundingBox();
  for (const label of [row.locator('.library-agent-name'), ...await row.locator('.library-agent-meta, .library-agent-context span').all()]) {
    const bounds = await label.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(card!.x + card!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/sidecar-agent-workspaces-mobile.png' });
  await row.getByRole('link').click();
  const header = page.locator('.library-owner-header');
  await expect(header.getByTitle('Review semantic graph and queue admission evidence', { exact: true })).toBeVisible();
  await expect(header.getByTitle(process.cwd(), { exact: true })).toHaveText(displayPath);
  await expect(header.getByTitle('feat/workspace-labels', { exact: true })).toBeVisible();
  await expect(header.getByTitle(owner.owner.sessionId, { exact: true })).toHaveText(`${owner.owner.sessionId.slice(0, 3)}…${owner.owner.sessionId.slice(-3)}`);
  await header.getByRole('button', { name: 'Codex session details' }).click();
  await expect(page.locator('.agent-session-popover code')).toHaveText(owner.owner.sessionId);
  await page.locator('.agent-session-popover').getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(owner.owner.sessionId);
  await page.keyboard.press('Escape');
  const headerBounds = await header.boundingBox();
  for (const label of await header.locator('strong, span').all()) {
    const bounds = await label.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(headerBounds!.x + headerBounds!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/sidecar-agent-documents-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: '/private/tmp/sidecar-agent-documents-desktop.png' });
  await page.getByRole('link', { name: 'All agents', exact: true }).click();
  await page.locator('.library-agent-row').filter({ has: page.getByTitle(f.owners[1].owner.sessionId, { exact: true }) }).getByRole('link').click();
  await expect(header.getByTitle('Transfer review', { exact: true })).toBeVisible();
  await expect(header.getByTitle(f.owners[1].doc.workspace, { exact: true })).toBeVisible();
});

test('unnamed sessions use the branch as the heading or fall back to Unnamed session', async ({ page }) => {
  const owner = f.owners[0];
  await owner.agentCall('/agent/documents', { path: owner.doc.path, repoInfo: { display: 'example', branch: 'feat/unnamed-review' } });
  await page.goto(f.gateway.url);
  const row = page.locator('.library-agent-row').filter({ has: page.getByTitle(owner.owner.sessionId, { exact: true }) });
  await expect(row.locator('.library-agent-name')).toHaveText('feat/unnamed-review');
  await expect(row.locator('.library-agent-meta')).not.toContainText('feat/unnamed-review');
  await expect(page.locator('.library-agent-row').filter({ has: page.getByTitle(f.owners[1].owner.sessionId, { exact: true }) }).locator('.library-agent-name')).toHaveText('Unnamed session');
  await row.getByRole('link').click();
  await expect(page.locator('.library-owner-header .library-agent-name')).toHaveText('feat/unnamed-review');
});

for (const running of [true, false]) test(`agent menu confirms closing all ${running ? 'live' : 'stopped'} documents, including pending requests`, async ({ page, context }) => {
  const owner = f.owners[1], base = `/a/${owner.alias}`;
  const source = await readFile(owner.doc.path, 'utf8');
  const file = join(owner.directory, 'second.md'); await writeFile(file, '# Second');
  const second = await (await owner.agentCall('/agent/documents', { path: file, title: 'Second' })).json();
  const question = async (documentId: string, text: string) => (await (await f.view(`${base}/api/questions`, { documentId, text, clientMessageId: text })).json());
  const answered = await question(owner.doc.id, 'Propose');
  await owner.agentCall(`/agent/requests/${answered.id}/claim`, {});
  await owner.agentCall('/agent/replies', { requestId: answered.id, documentId: owner.doc.id, threadId: answered.threadId,
    text: '[[sidecar-meta {"highlights":[{"exact":"Own document.","proposal":{"before":"Own document.","after":"Proposed text."}}]}]]\n[Proposal](#selection-1)' });
  await question(owner.doc.id, 'Queued');
  const claimed = await question(second.id, 'Claimed');
  await owner.agentCall(`/agent/requests/${claimed.id}/claim`, {});
  await f.view(`${base}/api/documents/${second.id}`);
  const viewer = await context.newPage();
  await viewer.goto(`${f.gateway.url}${base}/?document=${owner.doc.id}`);
  await viewer.getByLabel('Message', { exact: true }).fill('Unsent draft');
  await expect.poll(() => viewer.evaluate(() => Object.entries(localStorage).filter(([key, value]) => key.startsWith('sidecar-draft:') && value.includes('Unsent draft')).length)).toBe(1);
  const before = await readFile(join(owner.directory, 'state.json'), 'utf8');
  const other = await readFile(join(f.owners[0].directory, 'state.json'), 'utf8');
  const registry = await readFile(join(f.root, 'agent-ids', 'registry.json'), 'utf8');
  expect(Object.keys(JSON.parse(before).proposals)).toHaveLength(1);
  if (!running) await owner.stop();
  await page.goto(f.gateway.url);
  const row = page.locator('.library-agent-row').filter({ has: page.getByTitle(owner.owner.sessionId, { exact: true }) });
  await row.getByRole('button', { name: 'Agent actions' }).click();
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Close all 2 documents');
    expect(dialog.message()).toContain('queued and unfinished');
    await dialog.dismiss();
  });
  await page.getByRole('menuitem', { name: 'Close all documents' }).click();
  await expect(row).toContainText('2 documents');
  expect(await readFile(join(owner.directory, 'state.json'), 'utf8')).toBe(before);
  await row.getByRole('button', { name: 'Agent actions' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: 'Close all documents' }).click();
  await expect(row).toContainText('0 documents');
  await expect(row.getByRole('button', { name: 'Agent actions' })).toBeEnabled();
  const saved = JSON.parse(await readFile(join(owner.directory, 'state.json'), 'utf8'));
  for (const field of ['documents', 'threads', 'requests', 'proposals', 'proposalWrites']) expect(saved[field]).toEqual({});
  for (const id of [owner.doc.id, second.id]) {
    await expect(readdir(join(owner.directory, 'versions', id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(owner.directory, 'opened', id))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await readFile(owner.doc.path, 'utf8')).toBe(source);
  expect(await readFile(file, 'utf8')).toBe('# Second');
  expect(await readFile(join(f.owners[0].directory, 'state.json'), 'utf8')).toBe(other);
  expect(await readFile(join(f.root, 'agent-ids', 'registry.json'), 'utf8')).toBe(registry);
  await expect(viewer.getByRole('heading', { name: 'Document closed', exact: true })).toBeVisible();
  expect(await viewer.evaluate(() => Object.entries(localStorage).some(([key, value]) => key.startsWith('sidecar-draft:') && value.includes('Unsent draft')))).toBe(false);
  await row.getByRole('button', { name: 'Agent actions' }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('menuitem', { name: 'Remove agent' }).click();
  await expect(row).toContainText('0 documents');
  await row.getByRole('button', { name: 'Agent actions' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: 'Remove agent' }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(row).toHaveCount(0);
  expect(JSON.parse(await readFile(join(owner.directory, 'state.json'), 'utf8'))).toEqual(saved);
  expect(await readFile(join(f.root, 'agent-ids', 'registry.json'), 'utf8')).toBe(registry);
  await viewer.close();
});

test('agent bulk close reports partial failure and retains the documents it could not close', async ({ page }) => {
  const owner = f.owners[1], file = join(owner.directory, 'second.md'); await writeFile(file, '# Second');
  await owner.agentCall('/agent/documents', { path: file });
  await page.route(`**/api/library/${owner.key}/documents/${owner.doc.id}?discardPending=true`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Viewer unavailable. Retry when ready.' }) }));
  await page.goto(f.gateway.url);
  const row = page.locator('.library-agent-row').filter({ has: page.getByTitle(owner.owner.sessionId, { exact: true }) });
  await row.getByRole('button', { name: 'Agent actions' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: 'Close all documents' }).click();
  await expect(page.getByRole('alert')).toContainText('Closed 1 of 2 documents.');
  await expect(page.getByRole('alert')).toContainText('Viewer unavailable. Retry when ready.');
  await expect(row).toContainText('1 document');
  expect(Object.keys((await (await f.view(`/a/${owner.alias}/api/state`)).json()).documents)).toEqual([owner.doc.id]);
});

test('stopped agent retains preview and close confirmation, including its empty document list', async ({ page }) => {
  const owner = f.owners[1]; await owner.stop();
  await page.goto(f.gateway.url);
  const row = page.locator('.library-agent-row').filter({ has: page.getByTitle(owner.owner.sessionId, { exact: true }) });
  await expect(row).toContainText('Stopped');
  await row.getByRole('link').click();
  await page.getByRole('link', { name: /^claude/ }).click();
  await expect(page.getByRole('article', { name: 'Document' })).toContainText('Own document.');
  await page.getByRole('link', { name: 'All documents', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Close “claude”' }).click();
  await expect(page.getByRole('link', { name: /^claude/ })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Close “claude”' }).click();
  await expect(page.getByText('No saved documents.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'All agents', exact: true }).click();
  await expect(row).toContainText('0 documents');
});

for (const access of ['direct', 'gateway', 'network'] as const) test(`HTML scripts are opt-in and isolated through ${access}`, async ({ page }) => {
  const owner = f.owners[1];
  await writeFile(join(owner.directory, 'diagram.html'), `<!doctype html><html><body>
    <p id="result">Static diagram</p><button onclick="document.querySelector('#result').textContent='Clicked'">Trace</button>
    <script>
      const denied = action => { try { action(); return false; } catch { return true; } };
      document.querySelector('#result').textContent = 'Tab ' + location.hash;
      document.body.dataset.isolated = JSON.stringify({
        parent: denied(() => parent.document.body), cookie: denied(() => document.cookie), storage: denied(() => localStorage.length)
      });
    </script></body></html>`);
  await writeFile(join(owner.directory, 'review.md'), '# Diagram review\n\n[Basic](diagram.html#basic)\n\n[Chained](diagram.html#chained)\n\n[Nested fragment](diagram.html#chained.html#tab)');
  let base = `${f.gateway.url}/a/${owner.alias}`;
  if (access === 'direct') base = JSON.parse(await readFile(join(owner.directory, 'runtime.json'), 'utf8')).url;
  if (access === 'network') {
    const network = await (await f.view('/api/network', { enabled: true })).json();
    base = `${network.urls[0]}/a/${owner.alias}`;
    await page.goto(base + '/');
    await page.getByLabel('Passphrase', { exact: true }).fill(network.passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  }
  await page.goto(`${base}/?document=${owner.doc.id}`);
  await page.getByRole('link', { name: 'Basic', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File: diagram.html', exact: true });
  const toggle = dialog.getByRole('checkbox', { name: 'Run scripts', exact: true });
  const frame = dialog.frameLocator('iframe');
  await expect(toggle).not.toBeChecked();
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  // Run scripts off: the page's inline handlers stay blocked too.
  await frame.getByRole('button', { name: 'Trace' }).click();
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await toggle.check();
  await expect(frame.locator('#result')).toHaveText('Tab #basic');
  await expect(frame.locator('body')).toHaveAttribute('data-isolated', '{"parent":true,"cookie":true,"storage":true}');
  await frame.getByRole('button', { name: 'Trace' }).click();
  await expect(frame.locator('#result')).toHaveText('Clicked');
  await page.getByRole('link', { name: 'Chained', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'File: diagram.html', exact: true })).toHaveCount(1);
  await expect(frame.locator('#result')).toHaveText('Tab #chained');
  await page.getByRole('link', { name: 'Nested fragment', exact: true }).click();
  await expect(frame.locator('#result')).toHaveText('Tab #chained.html#tab');
  await dialog.getByRole('button', { name: 'Dock window', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('checkbox', { name: 'Run scripts', exact: true })).toBeChecked();
  await dock.getByRole('button', { name: /Move.*out of dock/ }).click();
  await toggle.uncheck();
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await dialog.getByRole('button', { name: 'Close file window' }).click();
  await page.getByRole('link', { name: 'Basic', exact: true }).click();
  await expect(toggle).not.toBeChecked();
});

test('scripted HTML blocks resource requests and keeps the main viewer policy unchanged', async ({ page }) => {
  const { createServer } = await import('node:http');
  const received: string[] = [];
  const probe = createServer((request, response) => { received.push(request.url ?? ''); response.end('external'); });
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  cleanup.unshift(() => new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve())));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing probe listener');
  const external = `http://127.0.0.1:${address.port}`;
  const owner = f.owners[1];
  const attempts = ['/api/state', `${external}/fetch`, `${external}/script`, `${external}/image`, `${external}/style`];
  await writeFile(join(owner.directory, 'probe.html'), `<!doctype html><p id="result">Static</p><script>
    const blocked = new Set();
    addEventListener('securitypolicyviolation', event => {
      blocked.add(event.effectiveDirective);
      document.body.dataset.blocked = JSON.stringify([...blocked].sort());
    });
    Promise.all([fetch('${attempts[0]}').then(() => false, () => true), fetch('${attempts[1]}').then(() => false, () => true)])
      .then(results => { document.body.dataset.fetchBlocked = JSON.stringify(results); });
    const script = document.createElement('script'); script.src='${attempts[2]}'; document.body.append(script);
    const img = new Image(); img.src='${attempts[3]}'; document.body.append(img);
    const style = document.createElement('link'); style.rel='stylesheet'; style.href='${attempts[4]}'; document.head.append(style);
    const nested = document.createElement('iframe'); nested.src='${external}/frame'; document.body.append(nested);
    document.querySelector('#result').textContent='Script ran';
  </script>`);
  await writeFile(join(owner.directory, 'review.md'), '# Probe\n\n[Probe](probe.html)');
  const base = `${f.gateway.url}/a/${owner.alias}`;
  const response = await page.goto(`${base}/?document=${owner.doc.id}`);
  expect(response!.headers()['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
  await page.getByRole('link', { name: 'Probe', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Run scripts', exact: true }).check();
  const frame = page.frameLocator('iframe[title="Preview of probe.html"]');
  await expect(frame.locator('#result')).toHaveText('Script ran');
  await expect(frame.locator('body')).toHaveAttribute('data-fetch-blocked', '[true,true]');
  await expect(frame.locator('body')).toHaveAttribute('data-blocked', '["connect-src","frame-src","img-src","script-src-elem","style-src-elem"]');
  expect(received).toEqual([]);
  // A direct open has no iframe attribute: the response header must still deny cookie access.
  // The frame's own URL spent its one-use ticket, so the viewer mints a fresh one for this open.
  const standalone = await page.context().newPage();
  try {
    const source = new URL((await page.locator('iframe[title="Preview of probe.html"]').getAttribute('src'))!, page.url());
    expect((await standalone.goto(source.href))!.status()).toBe(403);
    source.searchParams.delete('scripts'); source.searchParams.delete('ticket');
    const ticket = await page.evaluate(async url => (await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).ticket, source.href);
    await standalone.goto(`${source.href}&scripts=1&ticket=${ticket}`);
    await expect(standalone.locator('#result')).toHaveText('Script ran');
    expect(await standalone.evaluate(() => { try { void document.cookie; return false; } catch { return true; } })).toBe(true);
  } finally { await standalone.close(); }
});


for (const access of ['gateway', 'network'] as const) test(`a page with Run scripts off cannot navigate itself into scripts by link or meta refresh, and Run scripts still works, through ${access}`, async ({ page }) => {
  const owner = f.owners[1];
  let base = `${f.gateway.url}/a/${owner.alias}`;
  if (access === 'network') {
    const network = await (await f.view('/api/network', { enabled: true })).json();
    base = `${network.urls[0]}/a/${owner.alias}`;
    // Plain HTTP on a LAN address: browsers send no fetch metadata here.
    expect(new URL(base)).toMatchObject({ protocol: 'http:' });
    expect(new URL(base).hostname).not.toMatch(/^(127\.|localhost$|\[::1\]$)/);
    await page.goto(base + '/');
    await page.getByLabel('Passphrase', { exact: true }).fill(network.passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  }
  const scripted = `${base}/api/files/html?document=${owner.doc.id}&path=destination.html&scripts=1`;
  await writeFile(join(owner.directory, 'destination.html'), '<!doctype html><p id="result">Destination</p><script>document.body.dataset.authorRan = "yes"</script>');
  await writeFile(join(owner.directory, 'link.html'), `<!doctype html><a id="go" href="${scripted}">Open</a>`);
  await writeFile(join(owner.directory, 'refresh.html'), `<!doctype html><meta http-equiv="refresh" content="0;url=${scripted}"><p>Refreshing</p>`);
  const frame = page.frameLocator('.file-preview-frame');
  for (const file of ['link.html', 'refresh.html']) {
    const left = page.waitForRequest(request => request.url().includes('path=destination.html'));
    await page.goto(`${base}/?view=html&document=${owner.doc.id}&path=${file}`);
    if (file === 'link.html') await frame.locator('#go').click();
    await left;
    await page.waitForTimeout(500);
    await expect(page.getByRole('checkbox', { name: 'Run scripts' })).not.toBeChecked();
    expect(await frame.locator('body').getAttribute('data-author-ran')).toBeNull();
  }
  await page.goto(`${base}/?view=html&document=${owner.doc.id}&path=destination.html`);
  await expect(frame.locator('#result')).toHaveText('Destination');
  expect(await frame.locator('body').getAttribute('data-author-ran')).toBeNull();
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(frame.locator('body')).toHaveAttribute('data-author-ran', 'yes');
});

for (const access of ['direct', 'gateway', 'network'] as const) test(`HTML full page opens from its preview through ${access}`, async ({ page, context }) => {
  const owner = f.owners[1], filename = 'full page.html';
  await writeFile(join(owner.directory, filename), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p id="result">Static diagram</p><script>
    document.querySelector('#result').textContent='Tab ' + location.hash;
    try { document.cookie; } catch { document.body.dataset.isolated='yes'; }
  </script>`);
  await writeFile(join(owner.directory, 'review.md'), '# Full page review\n\n[Diagram](full%20page.html#chained.html#tab)');
  let base = `${f.gateway.url}/a/${owner.alias}`;
  if (access === 'direct') base = JSON.parse(await readFile(join(owner.directory, 'runtime.json'), 'utf8')).url;
  if (access === 'network') {
    const network = await (await f.view('/api/network', { enabled: true })).json();
    base = `${network.urls[0]}/a/${owner.alias}`;
    await page.goto(base + '/');
    await page.getByLabel('Passphrase', { exact: true }).fill(network.passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  }
  await page.goto(`${base}/?document=${owner.doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
  await page.getByRole('link', { name: 'Diagram', exact: true }).click();
  const preview = page.getByRole('dialog', { name: `File: ${filename}`, exact: true });
  await preview.getByRole('checkbox', { name: 'Run scripts', exact: true }).check();
  const opened = context.waitForEvent('page');
  await preview.getByRole('link', { name: 'Open full page', exact: true }).click();
  const fullPage = await opened;
  try {
    await fullPage.setViewportSize({ width: 390, height: 844 });
    const frame = fullPage.frameLocator('.file-preview-frame');
    const toggle = fullPage.getByRole('checkbox', { name: 'Run scripts', exact: true });
    await expect(frame.locator('#result')).toHaveText('Static diagram');
    await expect(toggle).not.toBeChecked();
    expect(new URL(fullPage.url()).pathname).toBe(new URL(base + '/').pathname);
    expect(new URL(fullPage.url()).hash).toBe('#chained.html#tab');
    await expect(fullPage.getByRole('link', { name: 'Back to document' })).toHaveAttribute('href', new URL(base).pathname.replace(/\/$/, '') + `/?document=${owner.doc.id}`);
    for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
      await fullPage.setViewportSize(size);
      const bounds = await fullPage.locator('.file-preview-frame').boundingBox();
      expect(bounds!.x).toBe(0);
      // The chat panel sits beside the page on desktop and replaces it on phones.
      expect(bounds!.width).toBeLessThanOrEqual(size.width);
      if (size.width <= 850) expect(bounds!.width).toBe(size.width);
      expect(bounds!.y).toBeLessThanOrEqual(60);
      // The viewer's mobile height follows the resize on the next animation frame.
      await expect.poll(async () => { const box = await fullPage.locator('.file-preview-frame').boundingBox(); return Math.abs(box!.y + box!.height - size.height) <= 1; }).toBe(true);
      expect(await fullPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await toggle.check();
    await expect(frame.locator('#result')).toHaveText('Tab #chained.html#tab');
    await expect(frame.locator('body')).toHaveAttribute('data-isolated', 'yes');
    await toggle.uncheck();
    await expect(frame.locator('#result')).toHaveText('Static diagram');
    await toggle.check();
    await fullPage.reload();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(frame.locator('#result')).toHaveText('Static diagram');
    expect(await fullPage.evaluate(() => window.opener)).toBeNull();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  } finally { await fullPage.close(); }
});

test('HTML full page logs a new browser in and returns to the exact owner, file and fragment', async ({ page }) => {
  const owner = f.owners[1];
  await writeFile(join(owner.directory, 'diagram.html'), '<p id="result">Static diagram</p><script>document.querySelector("#result").textContent=location.hash</script>');
  const network = await (await f.view('/api/network', { enabled: true })).json();
  const base = `${network.urls[0]}/a/${owner.alias}`;
  const query = new URLSearchParams({ view: 'html', document: owner.doc.id, path: 'diagram.html', directory: owner.directory, scripts: '1', returnTo: 'https://evil.example/' });
  const target = `${base}/?${query}#chained.html#tab`;
  const paths: string[] = [];
  page.on('request', request => paths.push(new URL(request.url()).pathname));
  await page.goto(target);
  await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible();
  expect(paths.some(path => path.includes('/api/'))).toBe(false);
  await page.getByLabel('Passphrase', { exact: true }).fill('wrong-passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect passphrase.');
  await page.getByLabel('Passphrase', { exact: true }).fill(network.passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.frameLocator('.file-preview-frame').locator('#result')).toHaveText('Static diagram');
  expect(page.url()).toBe(target);
  await expect(page.getByRole('checkbox', { name: 'Run scripts' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.frameLocator('.file-preview-frame').locator('#result')).toHaveText('#chained.html#tab');
  await page.reload();
  await page.getByRole('checkbox', { name: 'Run scripts' }).uncheck();
  await expect(page.frameLocator('.file-preview-frame').locator('#result')).toHaveText('Static diagram');
  expect(paths.filter(path => path.includes('/api/')).every(path => path.startsWith(`/a/${owner.alias}/api/`))).toBe(true);
  expect(paths.filter(path => path.endsWith('/api/files/html')).every(path => path === `/a/${owner.alias}/api/files/html`)).toBe(true);
});

test('HTML full page keeps file authorization and rejects non-HTML content', async ({ page }) => {
  const owner = f.owners[1], base = `${f.gateway.url}/a/${owner.alias}/?view=html&document=${owner.doc.id}`;
  await page.goto(base + '&path=review.md');
  await expect(page.getByRole('alert')).toContainText('HTTP 415');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.goto(base + '&path=../outside.html');
  await expect(page.getByRole('alert')).toContainText('HTTP 403');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.goto(base);
  await expect(page.getByRole('alert')).toContainText('document and file');
  await expect(page.locator('iframe')).toHaveCount(0);
});

// Selects an element's text in the page and releases the pointer, as a user's drag ends.
const selectInPage = (frame: import('@playwright/test').FrameLocator, selector: string) => frame.locator(selector).evaluate(node => {
  getSelection()!.selectAllChildren(node);
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
const pageHtml = '<!doctype html><body><h1 id="title">Title</h1><p>Alpha <b>beta</b>\n  gamma</p><a href="#nav" id="link">Link</a> <button id="go" onclick="document.body.dataset.clicked=\'yes\'">Go</button></body>';
async function htmlThreads() {
  const owner = f.owners[1], base = `${f.gateway.url}/a/${owner.alias}`, file = join(owner.directory, 'page.html');
  await writeFile(file, pageHtml);
  // The browser derives the path from the registered (real) workspace.
  const bound_file = `${owner.doc.workspace.replace(/\/$/, '')}/page.html`;
  const post = async (path: string, body: object) => (await f.view(`/a/${owner.alias}${path}`, body)).json();
  const bound = '00000000-0000-4000-8000-000000000001';
  await post('/api/threads', { id: bound, documentId: owner.doc.id, file: bound_file });
  await post('/api/questions', { documentId: owner.doc.id, threadId: bound, text: 'Question about the page', clientMessageId: 'bound' });
  await post('/api/questions', { documentId: owner.doc.id, text: 'Plain document question', clientMessageId: 'plain' });
  return { owner, base, file: bound_file, full: `${base}/?view=html&document=${owner.doc.id}&path=page.html` };
}

test('HTML full page lists only its file-bound threads and the document view tags them', async ({ page }) => {
  const { base, owner, full } = await htmlThreads();
  await page.goto(full);
  await expect(page.locator('.sidebar')).toContainText('Question about the page');
  await expect(page.locator('.sidebar')).not.toContainText('Plain document question');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator('.thread-row')).toHaveCount(1);
  await expect(page.locator('.thread-row .row-tag')).toHaveCount(0);
  await page.goto(`${base}/?document=${owner.doc.id}`);
  await page.getByRole('button', { name: 'Threads', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
  await expect(page.locator('.thread-row', { hasText: 'Plain document question' })).toHaveCount(1);
  await expect(page.locator('.thread-row', { hasText: 'Question about the page' }).locator('.row-tag')).toHaveText('page.html');
  await expect(page.locator('.thread-row', { hasText: 'Plain document question' }).locator('.row-tag')).toHaveCount(0);
});

test('HTML full page needs Run scripts to select, then attaches a finished selection as an html file quote on a file-bound thread', async ({ page }) => {
  const { full, file } = await htmlThreads();
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), pick = page.getByRole('button', { name: 'Pick element' });
  await expect(frame.locator('p')).toHaveText('Alpha beta gamma');
  await expect(pick).toBeDisabled(); await expect(pick).toHaveAttribute('title', /Run scripts/);
  await expect(page.getByRole('button', { name: 'Ask about selection' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(pick).toBeEnabled();
  // A real drag across the page attaches on release, like selecting text in a thread message.
  const box = (await frame.locator('p').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html');
  // Page controls such as zoom keep the attachment.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html');
  const sent = page.waitForRequest(request => request.url().endsWith('/api/questions'));
  await page.getByLabel('Message', { exact: true }).fill('What does this say?');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const body = (await sent).postDataJSON();
  expect(body.fileQuote).toMatchObject({ path: file, kind: 'html' });
  expect(body.fileQuote.exact.replace(/\s+/g, ' ').trim()).toBe('Alpha beta gamma');
  expect(body.fileQuote.selector).toBe('html > body > p');
  const state = await (await f.view(`/a/${f.owners[1].alias}/api/state`)).json();
  expect(state.threads[body.threadId].file).toBe(file);
});

test('HTML text selection works like a Markdown passage: quick menu, visible-thread draft, floating comment on a new page thread', async ({ page }) => {
  const { full, file, owner } = await htmlThreads();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), menu = page.locator('.selection-actions');
  const comment = menu.getByRole('button', { name: 'Comment' }), badge = page.locator('.sidebar .selection-badge');
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  const drag = async () => {
    const box = (await frame.locator('p').boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    return box;
  };
  // The page's own thread is open: a selection attaches to its draft, keeping typed text, and offers the menu beside it.
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Keep this draft');
  const text = await drag();
  await expect(badge).toHaveText('page.html');
  await expect(input).toHaveValue('Keep this draft');
  const placed = (await menu.boundingBox())!;
  expect(Math.abs(placed.y + placed.height / 2 - (text.y + text.height / 2))).toBeLessThan(80);
  // Clicking away in the page dismisses the menu and the pending attachment, as an outside press does for Markdown.
  await frame.locator('h1').click();
  await expect(comment).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  await expect(input).toHaveValue('Keep this draft');
  // Cancel dismisses too.
  await drag();
  await menu.getByRole('button', { name: 'Cancel selection' }).click();
  await expect(comment).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  // From the thread list, Comment opens the floating form; the new thread belongs to this page.
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await drag();
  await expect(badge).toHaveCount(0);
  await comment.click();
  const form = page.getByRole('dialog', { name: 'Comment on selection' }), field = form.getByRole('textbox');
  await field.fill('First line');
  await field.press('Shift+Enter');
  await field.pressSequentially('second line');
  const sent = page.waitForRequest(request => request.url().endsWith('/api/questions'));
  await field.press('Enter');
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ text: 'First line\nsecond line', file, fileQuote: { path: file, kind: 'html', selector: 'html > body > p' } });
  expect(body.threadId).toBeUndefined();
  await expect(form).toHaveCount(0);
  const state = await (await f.view(`/a/${owner.alias}/api/state`)).json();
  expect(state.threads[state.requests[Object.keys(state.requests).at(-1)!].threadId].file).toBe(file);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator('.thread-row', { hasText: 'First line' })).toHaveCount(1);
});

test('an HTML floating comment closes on a press in the page only when empty, survives a new selection with text, and Run scripts off clears the menu', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), menu = page.locator('.selection-actions'), form = page.getByRole('dialog', { name: 'Comment on selection' });
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const drag = async (selector: string) => {
    const box = (await frame.locator(selector).boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  await drag('p');
  // The page keeps its own keys, so the menu does not advertise C.
  await expect(menu.getByRole('button', { name: 'Comment' })).toHaveAttribute('title', 'Comment');
  await expect(menu.getByRole('button', { name: 'Comment' })).not.toHaveAttribute('aria-keyshortcuts', /./);
  await menu.getByRole('button', { name: 'Comment' }).click();
  await frame.locator('h1').click();
  await expect(form).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await drag('p');
  await menu.getByRole('button', { name: 'Comment' }).click();
  await form.getByRole('textbox').fill('Keep this comment');
  await frame.locator('h1').click();
  await drag('h1');
  await expect(form.getByRole('textbox')).toHaveValue('Keep this comment');
  await expect(menu).toHaveCount(0);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await drag('p');
  await expect(menu).toBeVisible();
  await page.getByRole('checkbox', { name: 'Run scripts' }).uncheck();
  await expect(menu).toHaveCount(0);
});

test('HTML element picking swallows page clicks until it ends', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), pick = page.getByRole('button', { name: 'Pick element' });
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(pick).toBeEnabled();
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await frame.locator('#go').click();
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(frame.locator('body')).not.toHaveAttribute('data-clicked', 'yes');
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html element');
  await expect(page.locator('.sidebar .composer')).toContainText('<button');
  await pick.click();
  await page.keyboard.press('Escape');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await frame.locator('#go').click();
  await expect(frame.locator('body')).toHaveAttribute('data-clicked', 'yes');
  await frame.locator('#link').click();
  expect(page.url()).toBe(full);
});

test('resolved file-bound threads leave the Unresolved filter', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.goto(full);
  await page.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(page.locator('.thread-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Thread status' }).click();
  await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await expect(page.locator('.thread-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Thread status' }).click();
  await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
  await expect(page.locator('.thread-row')).toHaveCount(1);
});

test('attached HTML parts reveal only while they still match the page', async ({ page }) => {
  const { full, owner } = await htmlThreads();
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), pick = page.getByRole('button', { name: 'Pick element' });
  const scripts = page.getByRole('checkbox', { name: 'Run scripts' });
  await scripts.check();
  await expect(pick).toBeEnabled();
  await pick.click();
  await frame.locator('#go').click();
  await page.getByLabel('Message', { exact: true }).fill('About this button');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const attachment = page.getByRole('button', { name: /Open (quoted|queued) file: page.html element/ });
  await attachment.click();
  await expect(frame.locator('div[data-sidecar-bridge]')).toHaveCSS('display', 'block');
  await expect(page.getByRole('status').filter({ hasText: 'changed' })).toHaveCount(0);
  await scripts.uncheck();
  await attachment.click();
  await expect(page.getByRole('status').filter({ hasText: 'Turn on Run scripts to show this on the page.' })).toBeVisible();
  await writeFile(join(owner.directory, 'page.html'), pageHtml.replace('>Go<', '>Go now<'));
  await scripts.check();
  await expect(pick).toBeEnabled();
  await attachment.click();
  await expect(page.getByRole('status').filter({ hasText: 'This part of the page changed or was removed since it was attached.' })).toBeVisible();
  await expect(frame.locator('div[data-sidecar-bridge]')).toHaveCount(0);
});

test('attached HTML text reveals across inline markup and source whitespace', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame');
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await selectInPage(frame, 'p');
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html');
  await page.getByLabel('Message', { exact: true }).fill('About this text');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await frame.locator('p').evaluate(() => getSelection()!.removeAllRanges());
  await page.getByRole('button', { name: /Open (quoted|queued) file: page.html$/ }).click();
  await expect.poll(() => frame.locator('p').evaluate(() => getSelection()!.toString().replace(/\s+/g, ' ').trim())).toBe('Alpha beta gamma');
  await expect(page.getByRole('status').filter({ hasText: 'changed' })).toHaveCount(0);
  // Revealing a saved target, then a release with no gesture of its own, never offers or attaches it.
  await frame.locator('p').dispatchEvent('mouseup');
  await page.waitForTimeout(300);
  await expect(page.locator('.sidebar .selection-badge')).toHaveCount(0);
  await expect(page.locator('.selection-actions')).toHaveCount(0);
  // Clicking away, then dragging over those same words, is a new selection and attaches.
  // (Pressing on still-selected text would start a text drag-and-drop instead.)
  await page.getByRole('button', { name: /Open (quoted|queued) file: page.html$/ }).click();
  await expect.poll(() => frame.locator('p').evaluate(() => getSelection()!.toString().replace(/\s+/g, ' ').trim())).toBe('Alpha beta gamma');
  await frame.locator('h1').click();
  await expect.poll(() => frame.locator('p').evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  const box = (await frame.locator('p').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html');
  await expect.poll(() => frame.locator('p').evaluate(() => getSelection()!.toString().replace(/\s+/g, ' ').trim())).toBe('Alpha beta gamma');
});

async function pickAndSend(page: import('@playwright/test').Page, html: string, selector: string) {
  const { full, owner } = await htmlThreads();
  await writeFile(join(owner.directory, 'page.html'), html);
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), pick = page.getByRole('button', { name: 'Pick element' });
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(pick).toBeEnabled();
  await pick.click();
  await frame.locator(selector).click();
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  const sent = page.waitForRequest(request => request.url().endsWith('/api/questions'));
  await page.getByLabel('Message', { exact: true }).fill('About this element');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  return { frame, fileQuote: (await sent).postDataJSON().fileQuote, attachment: page.getByRole('button', { name: /Open (quoted|queued) file: page.html element/ }), changed: page.getByRole('status').filter({ hasText: 'changed or was removed' }) };
}

test('picking blocks page handlers registered before it, including touch', async ({ browser, page }) => {
  const { full, owner } = await htmlThreads();
  await writeFile(join(owner.directory, 'page.html'), '<!doctype html><head><script>addEventListener("click", e => { if (e.target.id === "go") document.body.dataset.clicked = "click"; }, true);</script></head><body><button id="go" ontouchstart="document.body.dataset.touched=\'yes\'">Go</button></body>');
  const phone = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  for (const [current, tap] of [[page, false], [phone, true]] as const) {
    await current.goto(full);
    const frame = current.frameLocator('.file-preview-frame'), pick = current.getByRole('button', { name: 'Pick element' });
    await current.getByRole('checkbox', { name: 'Run scripts' }).check();
    await expect(pick).toBeEnabled();
    await (tap ? pick.tap() : pick.click());
    await (tap ? frame.locator('#go').tap() : frame.locator('#go').click());
    await expect(pick).toHaveAttribute('aria-pressed', 'false');
    expect(await frame.locator('body').evaluate(body => [body.dataset.clicked, body.dataset.touched])).toEqual([undefined, undefined]);
    // Picking off: the page's own handlers run again (on a phone the pick opened the chat over the page).
    if (tap) await current.getByRole('button', { name: 'Hide conversations' }).tap();
    await (tap ? frame.locator('#go').tap() : frame.locator('#go').click());
    await expect(frame.locator('body')).toHaveAttribute('data-clicked', 'click');
    if (tap) await expect(frame.locator('body')).toHaveAttribute('data-touched', 'yes');
  }
  await phone.close();
});

test('a picked element reveals while its full markup is unchanged and unique', async ({ page }) => {
  const long = `<!doctype html><body><div id="box"><button id="go" data-filler="${'x'.repeat(4100)}">Approve</button></div></body>`;
  const { frame, attachment, changed } = await pickAndSend(page, long, '#go');
  await attachment.click();
  await expect(frame.locator('div[data-sidecar-bridge]')).toHaveCSS('display', 'block');
  await expect(changed).toHaveCount(0);
  // A change past the 4,000-character excerpt still counts.
  await frame.locator('#go').evaluate(button => { button.textContent = 'Delete everything'; });
  await attachment.click();
  await expect(changed).toBeVisible();
});

test('a picked element whose selector became ambiguous reports changed', async ({ page }) => {
  const { frame, attachment, changed } = await pickAndSend(page, '<!doctype html><body><div id="original"><button id="go">Go</button></div></body>', '#go');
  await frame.locator('body').evaluate(body => { const copy = document.createElement('div'); copy.innerHTML = '<button id="go">Go</button>'; body.prepend(copy); });
  await attachment.click();
  await expect(changed).toBeVisible();
});

test('a picked body excerpt excludes Sidecar instrumentation and reveals unchanged', async ({ page }) => {
  const { attachment, changed, fileQuote } = await pickAndSend(page, '<!doctype html><body style="margin:0;min-height:800px"><h1>Title</h1></body>', 'body');
  expect(fileQuote).toMatchObject({ selector: 'html > body', isElement: true });
  expect(fileQuote.exact).toBe('<body style="margin:0;min-height:800px"><h1>Title</h1></body>');
  await attachment.click();
  await expect(changed).toHaveCount(0);
});

test('Run scripts keeps standards mode and layout when comments precede the doctype', async ({ page }) => {
  const { full, owner } = await htmlThreads();
  await writeFile(join(owner.directory, 'page.html'), '<!-- Generated diagram -->\n<!DOCTYPE html><html><head><style>#box { height: 100%; padding: 20px; }</style></head><body><div id="box">Diagram</div></body></html>');
  await page.goto(full);
  const box = page.frameLocator('.file-preview-frame').locator('#box');
  const layout = () => box.evaluate(element => [document.compatMode, element.getBoundingClientRect().height]);
  const before = await layout();
  expect(before[0]).toBe('CSS1Compat');
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  expect(await layout()).toEqual(before);
});

const linkPage = '<!doctype html><body><a id="code" href="src/a.ts:3">a.ts line 3</a> <a id="notes" href="./docs/notes.md">notes</a> <a id="anchor" href="#sec">section</a> '
  + '<a id="ext" href="https://example.invalid/a.ts">external</a> <a id="script" href="javascript:void 0">script</a> <a id="out" href="/tmp/sidecar-outside-example.md">outside</a> <a id="root" href="README.md:2-4">readme</a> <a id="tel" href="tel:5551234">phone</a><h2 id="sec">Section</h2></body>';
async function htmlLinks(page: import('@playwright/test').Page) {
  const context = await htmlThreads(), dir = context.owner.directory;
  await mkdir(join(dir, 'src'), { recursive: true }); await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'src/a.ts'), Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
  await writeFile(join(dir, 'src/b.ts'), 'export const b = 1;\nexport const c = 2;\n');
  await writeFile(join(dir, 'README.md'), 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(join(dir, 'docs/notes.md'), '# Notes\n\nSee [b.ts](../src/b.ts:2).\n');
  await writeFile(join(dir, 'page.html'), linkPage);
  await page.goto(context.full);
  const frame = page.frameLocator('.file-preview-frame');
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  return { ...context, frame, windows: page.locator('.reference-window') };
}

test('HTML page file links open nested Sidecar file windows at their lines while the page stays open', async ({ page }) => {
  const { frame, windows } = await htmlLinks(page);
  await frame.locator('#code').click();
  const code = page.getByRole('dialog', { name: /^File: .*src\/a\.ts$/ });
  await expect(code).toBeVisible();
  await expect(code.locator('.file-line-reference')).toContainText('Line 3');
  await frame.locator('#notes').click();
  const notes = page.getByRole('dialog', { name: /^File: .*docs\/notes\.md$/ });
  await expect(notes.getByRole('heading', { name: 'Notes' })).toBeVisible();
  // A link inside a file window opens another window; earlier windows and the page remain.
  await notes.getByRole('link', { name: 'b.ts' }).click();
  const nested = page.getByRole('dialog', { name: /^File: .*src\/b\.ts$/ });
  await expect(nested.locator('.file-line-reference')).toContainText('Line 2');
  await expect(windows).toHaveCount(3);
  // A root-level file name with a line range is a file link, not a URI scheme.
  await frame.locator('#root').click();
  await expect(page.getByRole('dialog', { name: 'File: README.md', exact: true }).locator('.file-line-reference')).toContainText('Lines 2–4');
  await expect(windows).toHaveCount(4);
  await expect(page.locator('.file-preview-frame')).toBeVisible();
  await expect(frame.locator('#code')).toBeVisible();
  // Existing window controls: zoom, minimize and dock.
  await nested.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(nested.getByRole('button', { name: 'Adjust content zoom', exact: true })).toBeEnabled();
  await nested.getByRole('button', { name: 'Minimize window', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('button', { name: 'Expand dock', exact: true })).toHaveText('1 window');
  await code.getByRole('button', { name: 'Dock window', exact: true }).click();
  await expect(windows).toHaveCount(2);
});

test('HTML page links keep anchors and URLs native, refuse outside files, and yield to picking', async ({ page }) => {
  const { frame, windows } = await htmlLinks(page);
  // The bridge cancels only local file links; a test listener records and then stops every navigation.
  const prevented = await frame.locator('body').evaluate(() => {
    const seen: Record<string, boolean> = {};
    addEventListener('click', event => { seen[(event.target as Element).id] = event.defaultPrevented; event.preventDefault(); });
    for (const id of ['anchor', 'ext', 'script', 'tel']) document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return seen;
  });
  expect(prevented).toEqual({ anchor: false, ext: false, script: false, tel: false });
  await frame.locator('#out').click();
  await expect(page.getByRole('status').filter({ hasText: 'Only files inside this document’s workspace open from the page: /tmp/sidecar-outside-example.md' })).toBeVisible();
  await expect(windows).toHaveCount(0);
  await page.getByRole('button', { name: 'Pick element' }).click();
  await frame.locator('#code').click();
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html element');
  await expect(page.locator('.sidebar .composer')).toContainText('src/a.ts:3');
  await expect(windows).toHaveCount(0);
});

test('HTML page link messages need this frame, a valid local href and a user click', async ({ page }) => {
  const { frame, windows, owner } = await htmlLinks(page);
  const post = (href: string) => frame.locator('body').evaluate((_, href) => parent.postMessage({ sidecar: 'html-bridge', type: 'open-file', href }, '*'), href);
  // Messages from any other source are ignored.
  await page.evaluate(() => postMessage({ sidecar: 'html-bridge', type: 'open-file', href: 'src/a.ts' }, '*'));
  // Hostile or oversized hrefs open nothing and grant no root.
  for (const href of ['src/a.ts' + ' '.repeat(5000), 'javascript:alert(1)', '//evil.example/a.ts', 'file://host/etc/passwd', 'https://example.invalid/src/a.ts']) await post(href);
  await post('../../../etc/passwd');
  await expect(page.getByRole('status').filter({ hasText: 'Only files inside this document’s workspace' })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(windows).toHaveCount(0);
  await post('src/a.ts:2');
  await expect(page.getByRole('dialog', { name: /^File: .*src\/a\.ts$/ }).locator('.file-line-reference')).toContainText('Line 2');
  // A refresh now restores open file windows, so close this one first.
  await page.getByRole('button', { name: 'Close file window', exact: true }).click();
  // A page script posting on its own, long after any click, opens nothing.
  await writeFile(join(owner.directory, 'page.html'), linkPage + '<script>setTimeout(() => parent.postMessage({ sidecar: "html-bridge", type: "open-file", href: "src/b.ts" }, "*"), 6000)</script>');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Run scripts' })).toBeChecked();
  await page.waitForTimeout(7000);
  await expect(page.locator('.reference-window')).toHaveCount(0);
});

test('with Run scripts off, HTML page links open no file windows', async ({ page }) => {
  const context = await htmlThreads(), dir = context.owner.directory;
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'page.html'), linkPage);
  await page.goto(context.full);
  await page.frameLocator('.file-preview-frame').locator('#code').click();
  await page.waitForTimeout(500);
  await expect(page.locator('.reference-window')).toHaveCount(0);
});

test('HTML full page header fits a phone and Chat swaps with the page', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(full);
  const frame = page.locator('.file-preview-frame');
  await expect(frame).toBeVisible();
  for (const name of ['Back to document', 'Pick element', 'Settings']) await expect(page.getByLabel(name, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, (() => { const bar = document.querySelector('.topbar')!; return bar.scrollWidth <= bar.clientWidth; })()])).toEqual([true, true]);
  await page.getByRole('button', { name: 'Show conversations' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(frame).toBeHidden();
  await page.getByRole('button', { name: 'Hide conversations' }).click();
  await expect(frame).toBeVisible();
  // The header has no room for page zoom on a phone; Settings offers it, scaling only the page.
  const pageWidth = () => page.frameLocator('.file-preview-frame').locator('body').evaluate(() => innerWidth), before = await pageWidth();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Reading settings' });
  await settings.getByRole('button', { name: 'Zoom out' }).click();
  await expect(settings.getByRole('button', { name: 'Adjust content zoom' })).toHaveText('75%');
  await expect.poll(pageWidth).toBe(Math.round(before / 0.75));
  await settings.getByRole('button', { name: 'Adjust content zoom' }).click();
  const popover = page.getByRole('dialog', { name: 'Content zoom', exact: true });
  await popover.getByRole('slider', { name: 'Zoom level' }).fill('83');
  await expect(settings.getByRole('button', { name: 'Adjust content zoom' })).toHaveText('83%');
  await expect.poll(async () => Math.abs(await pageWidth() - before / 0.83)).toBeLessThan(1);
  const bounds = (await popover.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await popover.getByRole('button', { name: 'Reset content zoom' }).click();
  await expect.poll(pageWidth).toBe(before);
  await popover.press('Escape');
  await expect(popover).toBeHidden();
  await expect(settings).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sidecar-conversation-scale'))).toBe('1');
});

const conversationsShown = (page: import('@playwright/test').Page) => page.locator('.conversation-toggle').getAttribute('aria-expanded');

test('Cmd/Ctrl+Backslash toggles the conversations from a focused field or button, once per press', async ({ page }) => {
  const owner = f.owners[1];
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  const toggle = page.locator('.conversation-toggle'), input = page.getByLabel('Message', { exact: true });
  await expect(toggle).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+\\$/);
  await expect(toggle).toHaveAttribute('title', /\((⌘|Ctrl\+)\\\)$/);
  await input.fill('Draft');
  await input.press('ControlOrMeta+Backslash');
  await expect.poll(() => conversationsShown(page)).toBe('false');
  await toggle.focus();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect.poll(() => conversationsShown(page)).toBe('true');
  await expect(input).toHaveValue('Draft');
  // Auto-repeat, composition and extra modifiers do nothing.
  await input.evaluate(field => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform), base = { code: 'Backslash', key: '\\', bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac };
    for (const extra of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { altKey: true }, mac ? { ctrlKey: true } : { metaKey: true }]) field.dispatchEvent(new KeyboardEvent('keydown', { ...base, ...extra }));
  });
  await page.waitForTimeout(100);
  expect(await conversationsShown(page)).toBe('true');
});

test('Cmd/Ctrl+Backslash reaches the viewer from inside HTML frames with Run scripts off or on, and forged messages are ignored', async ({ page }) => {
  const owner = f.owners[1];
  await writeFile(join(owner.directory, 'form.html'), '<!doctype html><body><input id="field" aria-label="Page field"><button id="go" onclick="document.body.dataset.clicked=\'yes\'">Go</button><script>document.body.dataset.ran = "yes"</script></body>');
  await writeFile(join(owner.directory, 'review.md'), '# Review\n\n[Form](form.html)');
  // Floating file window, Run scripts off.
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  await page.getByRole('link', { name: 'Form', exact: true }).click();
  const windowFrame = page.getByRole('dialog', { name: 'File: form.html', exact: true }).frameLocator('iframe');
  await windowFrame.locator('#field').fill('typed');
  await windowFrame.locator('#field').press('ControlOrMeta+Backslash');
  await expect.poll(() => conversationsShown(page)).toBe('false');
  await windowFrame.locator('#field').press('ControlOrMeta+Backslash');
  await expect.poll(() => conversationsShown(page)).toBe('true');
  await expect(windowFrame.locator('#field')).toHaveValue('typed');
  await windowFrame.locator('#go').click();
  expect(await windowFrame.locator('body').evaluate(body => [body.dataset.ran, body.dataset.clicked])).toEqual([undefined, undefined]);
  // Full page, Run scripts off then on.
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?view=html&document=${owner.doc.id}&path=form.html`);
  const frame = page.frameLocator('.file-preview-frame');
  for (const scripts of [false, true]) {
    if (scripts) { await page.getByRole('checkbox', { name: 'Run scripts' }).check(); await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes'); }
    const before = await conversationsShown(page);
    await frame.locator('#field').click();
    await frame.locator('#field').press('ControlOrMeta+Backslash');
    await expect.poll(() => conversationsShown(page)).toBe(before === 'true' ? 'false' : 'true');
    await page.waitForTimeout(100);
    expect(await conversationsShown(page)).toBe(before === 'true' ? 'false' : 'true');
  }
  // Only a current Sidecar HTML frame may forward it: messages from this window or another frame are ignored.
  const before = await conversationsShown(page);
  await page.evaluate(() => {
    const message = { sidecar: 'html-shortcut', type: 'toggle-conversations' };
    window.postMessage(message, '*');
    const other = document.createElement('iframe');
    other.srcdoc = `<script>parent.postMessage(${JSON.stringify(message)}, '*')<\/script>`;
    document.body.appendChild(other);
  });
  await page.waitForTimeout(300);
  expect(await conversationsShown(page)).toBe(before);
});

// A registered HTML file outside every workspace: the document itself, with no Markdown wrapper.
async function standaloneHtml(owner = f.owners[1]) {
  const directory = join(f.root, 'standalone');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'diagram.html');
  await writeFile(path, `<!doctype html><title>Standalone &amp; diagram</title><body><p id="result">Static diagram</p><button id="go">Go</button><script>
    document.querySelector('#result').textContent = 'Ran ' + location.hash;
    try { document.cookie; } catch { document.body.dataset.isolated = 'yes'; }
  </script></body>`);
  const doc = await (await owner.agentCall('/agent/documents', { path, generated: false })).json();
  return { owner, doc };
}

for (const access of ['direct', 'gateway', 'network'] as const) test(`a standalone HTML document opens in the full-page viewer, from the library and on reload, through ${access}`, async ({ page }) => {
  const { owner, doc } = await standaloneHtml();
  expect(doc.workspace).toBeUndefined();
  let base = `${f.gateway.url}/a/${owner.alias}`;
  if (access === 'direct') base = JSON.parse(await readFile(join(owner.directory, 'runtime.json'), 'utf8')).url;
  const target = `${base}/?document=${doc.id}#part`;
  if (access === 'network') {
    const network = await (await f.view('/api/network', { enabled: true })).json();
    base = `${network.urls[0]}/a/${owner.alias}`;
    // A new browser logs in and returns to the exact document URL.
    await page.goto(`${base}/?document=${doc.id}#part`);
    await page.getByLabel('Passphrase', { exact: true }).fill(network.passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    expect(page.url()).toBe(`${base}/?document=${doc.id}#part`);
  } else await page.goto(target);
  const frame = page.frameLocator('.file-preview-frame'), toggle = page.getByRole('checkbox', { name: 'Run scripts', exact: true });
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#document')).toHaveCount(0);
  await expect(page).toHaveTitle('Standalone & diagram');
  await expect(page.locator('.html-filename')).toHaveText('diagram.html');
  await toggle.check();
  await expect(frame.locator('#result')).toHaveText('Ran #part');
  await expect(frame.locator('body')).toHaveAttribute('data-isolated', 'yes');
  await page.reload();
  // Run scripts survives a refresh of this tab (session-scoped); turn it off to see the static page.
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  const library = page.getByRole('link', { name: 'All documents' });
  await expect(library).toHaveAttribute('href', access === 'direct' ? '/?library=1' : `/a/${owner.alias}/`);
  await library.click();
  await page.getByRole('link', { name: /Standalone & diagram/ }).click();
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  expect(new URL(page.url()).searchParams.get('document')).toBe(doc.id);
  // The Markdown document of the same owner still renders as Markdown.
  await page.goto(`${base}/?document=${owner.doc.id}`);
  await expect(page.locator('#document')).toContainText('Own document.');
  await expect(page.locator('.file-preview-frame')).toHaveCount(0);
});

test('a standalone HTML document keeps its own threads, selections, picked elements and revisions', async ({ page }) => {
  const { owner, doc } = await standaloneHtml();
  const post = async (path: string, body: object) => (await f.view(`/a/${owner.alias}${path}`, body)).json();
  await post('/api/questions', { documentId: owner.doc.id, text: 'Markdown document question', clientMessageId: 'markdown' });
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${doc.id}`);
  const frame = page.frameLocator('.file-preview-frame'), pick = page.getByRole('button', { name: 'Pick element' });
  await expect(frame.locator('#result')).toHaveText('Static diagram');
  await expect(pick).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(pick).toBeEnabled();
  await selectInPage(frame, '#result');
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('diagram.html');
  let sent = page.waitForRequest(request => request.url().endsWith('/api/questions'));
  await page.getByLabel('Message', { exact: true }).fill('What does this say?');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  let body = (await sent).postDataJSON();
  expect(body).toMatchObject({ documentId: doc.id, fileQuote: { path: doc.path, kind: 'html', exact: 'Ran ', selector: '#result' } });
  const state = await (await f.view(`/a/${owner.alias}/api/state`)).json();
  expect(state.threads[body.threadId]).toMatchObject({ documentId: doc.id });
  expect(state.threads[body.threadId].file).toBeUndefined();
  await pick.click();
  await frame.locator('#go').click();
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('diagram.html element');
  sent = page.waitForRequest(request => request.url().endsWith('/api/questions'));
  await page.getByLabel('Message', { exact: true }).fill('And this button?');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  body = (await sent).postDataJSON();
  expect(body.fileQuote).toMatchObject({ path: doc.path, kind: 'html', isElement: true, selector: '#go' });
  await expect(page.locator('.sidebar')).not.toContainText('Markdown document question');
  // An agent revision reloads the frame and keeps the Run scripts choice.
  await writeFile(doc.path, '<!doctype html><title>Revised</title><p id="result">Revised</p><script>document.querySelector("#result").textContent = "Revised and ran"</script>');
  await owner.agentCall('/agent/documents', { path: doc.path, generated: false });
  await expect(frame.locator('#result')).toHaveText('Revised and ran');
  await expect(page).toHaveTitle('Revised');
  await expect(page.getByRole('checkbox', { name: 'Run scripts' })).toBeChecked();
  await expect(pick).toBeEnabled();
  // The owner's Markdown document lists only its own threads.
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  await page.getByRole('button', { name: 'Threads', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
  await expect(page.locator('.thread-row', { hasText: 'Markdown document question' })).toHaveCount(1);
  await expect(page.locator('.thread-row', { hasText: 'What does this say?' })).toHaveCount(0);
});

test('a stopped agent’s standalone HTML document previews as a note, never as Markdown or a frame', async ({ page }) => {
  const { owner, doc } = await standaloneHtml();
  await owner.stop();
  await page.goto(`${f.gateway.url}/a/${owner.alias}/`);
  await page.getByRole('link', { name: /Standalone & diagram/ }).click();
  await expect(page.getByText('This is an HTML document.')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByText('Static diagram')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('document')).toBe(doc.id);
});

// The agent answers the thread's queued question with one marked reply carrying highlight metadata.
async function agentReply(owner: (typeof f.owners)[number], threadId: string, highlights: unknown[], text: string) {
  const state = await (await f.view(`/a/${owner.alias}/api/state`)).json();
  const request = Object.values(state.requests as Record<string, { id: string; threadId: string; documentId: string; status: string }>).find(r => r.threadId === threadId && r.status === 'queued')!;
  await owner.agentCall(`/agent/requests/${request.id}/prepare`, {});
  const replied = await owner.agentCall('/agent/replies', { requestId: request.id, documentId: request.documentId, threadId, text: `[[sc-meta ${JSON.stringify({ highlights })}]]\n${text}` });
  expect(replied.status).toBe(200);
}

test('agent HTML targets reveal on the full page only while unchanged and unique, without enabling scripts', async ({ page }) => {
  const { full } = await htmlThreads();
  const owner = f.owners[1], thread = '00000000-0000-4000-8000-000000000001';
  await agentReply(owner, thread, [
    { selector: 'p', exact: 'beta', label: 'Beta' }, { selector: '#go', exact: 'Go', element: true, label: 'Go button' },
    { selector: '#title', exact: 'Missing', label: 'Missing' }, { selector: 'body > *', exact: 'Title', label: 'Ambiguous' },
  ], 'See [beta](#selection-1) and [the button](#selection-2).');
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), scripts = page.getByRole('checkbox', { name: 'Run scripts' });
  const notice = page.locator('.html-notice'), overlay = frame.locator('div[data-sidecar-bridge]');
  await expect(page.locator('.sidebar .selection-badge')).toHaveText(['Beta', 'Go button', 'Missing', 'Ambiguous']);
  await page.getByRole('button', { name: 'Show on page: Beta' }).click();
  await expect(notice).toHaveText('Turn on Run scripts to show this on the page.');
  await expect(scripts).not.toBeChecked();
  await scripts.check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await page.locator('.message-bubble a', { hasText: 'beta' }).click();
  await expect.poll(() => frame.locator('p').evaluate(() => getSelection()!.toString())).toBe('beta');
  await expect(notice).toHaveCount(0);
  await page.locator('.message-bubble a', { hasText: 'the button' }).click();
  await expect(overlay).toHaveCSS('display', 'block');
  await expect(notice).toHaveCount(0);
  for (const name of ['Missing', 'Ambiguous']) {
    await page.getByRole('button', { name: 'Show on page: Beta' }).click();
    await expect(notice).toHaveCount(0);
    await page.getByRole('button', { name: `Show on page: ${name}` }).click();
    await expect(notice).toHaveText('This part of the page changed or was removed since it was attached.');
  }
  // An element target whose text changed is not revealed, even though its selector still matches.
  await frame.locator('#go').evaluate(button => { button.textContent = 'Delete'; });
  await page.getByRole('button', { name: 'Show on page: Beta' }).click();
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: 'Show on page: Go button' }).click();
  await expect(notice).toHaveText('This part of the page changed or was removed since it was attached.');
});

test('agent HTML targets reveal on a standalone HTML document; Markdown highlights still paint the Markdown document', async ({ page }) => {
  const { owner, doc } = await standaloneHtml();
  const post = async (path: string, body: object) => (await f.view(`/a/${owner.alias}${path}`, body)).json();
  // The registration's own thread is the one the page opens first.
  const general = Object.values((await (await f.view(`/a/${owner.alias}/api/state`)).json()).threads as Record<string, { id: string; documentId: string }>).find(thread => thread.documentId === doc.id)!;
  const html = await post('/api/questions', { documentId: doc.id, threadId: general.id, text: 'Where is the result?', clientMessageId: 'html' });
  await agentReply(owner, html.threadId, [{ selector: '#result', exact: 'Ran', label: 'Result' }], 'It is [here](#selection-1).');
  const markdownThread = Object.values((await (await f.view(`/a/${owner.alias}/api/state`)).json()).threads as Record<string, { id: string; documentId: string }>).find(thread => thread.documentId === owner.doc.id)!;
  const markdown = await post('/api/questions', { documentId: owner.doc.id, threadId: markdownThread.id, text: 'Where is it said?', clientMessageId: 'markdown' });
  await agentReply(owner, markdown.threadId, [{ selector: '#result', exact: 'Ran' }, { exact: 'Own document.' }], 'It is [here](#selection-2).');
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${doc.id}`);
  const frame = page.frameLocator('.file-preview-frame');
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await page.locator('.message-bubble a', { hasText: 'here' }).click();
  await expect.poll(() => frame.locator('#result').evaluate(() => getSelection()!.toString())).toBe('Ran');
  await expect(page.locator('.html-notice')).toHaveCount(0);
  // On a plain Markdown thread the HTML target is dropped and the Markdown selection keeps its own link.
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  await expect(page.locator('#document mark.annotation-highlight')).toHaveText('Own document.');
  await expect(page.getByRole('button', { name: /^Show on page/ })).toHaveCount(0);
  await page.locator('.message-bubble a', { hasText: 'here' }).click();
  await expect(page.locator('#document mark.annotation-highlight')).toBeFocused();
});

test('selector-less agent targets on a standalone HTML document reveal as page text, including replies saved before the fix', async ({ page }) => {
  const { owner, doc } = await standaloneHtml();
  // The title and a script repeat "Go" outside the page content; "Twice" is visible twice; "Hidden words" is only in a script.
  await writeFile(doc.path, '<!doctype html><title>Go</title><body><h1 id="go">Go</h1><script>var label = "Go", note = "Hidden words";</script><p>Twice</p><p>Twice</p></body>');
  await owner.agentCall('/agent/documents', { path: doc.path, generated: false });
  const thread = Object.values((await (await f.view(`/a/${owner.alias}/api/state`)).json()).threads as Record<string, { id: string; documentId: string }>).find(thread => thread.documentId === doc.id)!;
  await f.view(`/a/${owner.alias}/api/questions`, { documentId: doc.id, threadId: thread.id, text: 'Which button?', clientMessageId: 'which' });
  await agentReply(owner, thread.id, [{ exact: 'Go', label: 'Go text' }, { exact: 'Twice', label: 'Repeated' }, { exact: 'Hidden words', label: 'Script only' }], 'It is [this one](#selection-1).');
  const message = (await (await f.view(`/a/${owner.alias}/api/state`)).json()).threads[thread.id].messages.at(-1);
  expect(message.selections).toBeUndefined();
  expect(message.fileSelections[0].fileQuote).toEqual({ path: doc.path, kind: 'html', exact: 'Go', selector: 'body' });
  // A reply saved earlier kept the target as a Markdown passage; the viewer shows it as page text without changing saved state.
  const statePath = join(owner.directory, 'state.json'), saved = JSON.parse(await readFile(statePath, 'utf8'));
  const legacy = saved.threads[thread.id].messages.at(-1);
  legacy.selections = legacy.fileSelections.map(({ id, slug, label, fileQuote }: { id: string; slug: string; label: string; fileQuote: { exact: string } }) => ({ id, slug, label, isVisible: true, quote: { exact: fileQuote.exact, prefix: '', suffix: '', start: 0, end: fileQuote.exact.length, version: 'older' } }));
  delete legacy.fileSelections;
  await owner.stop();
  await writeFile(statePath, JSON.stringify(saved));
  await owner.restart();
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${doc.id}`);
  const frame = page.frameLocator('.file-preview-frame');
  await expect(page.getByRole('button', { name: 'Show on page: Go text' })).toBeVisible();
  await expect(page.locator('.sidebar')).not.toContainText('Passage changed');
  await expect(page.getByRole('button', { name: /View original/ })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await page.locator('.message-bubble a', { hasText: 'this one' }).click();
  await expect.poll(() => frame.locator('#go').evaluate(() => getSelection()!.toString())).toBe('Go');
  await expect(page.locator('.html-notice')).toHaveCount(0);
  // Text visible more than once is never guessed, and text only in a script is never selected.
  for (const name of ['Repeated', 'Script only']) {
    await page.getByRole('button', { name: 'Show on page: Go text' }).click();
    await expect(page.locator('.html-notice')).toHaveCount(0);
    await page.getByRole('button', { name: `Show on page: ${name}` }).click();
    await expect(page.locator('.html-notice')).toHaveText('This part of the page changed or was removed since it was attached.');
  }
  expect(JSON.parse(await readFile(statePath, 'utf8')).threads[thread.id].messages.at(-1).selections).toHaveLength(3);
});

test('an agent revision keeps the HTML reading position; revealing a target still scrolls to it', async ({ page }) => {
  const { owner, doc } = await standaloneHtml();
  const long = (label: string) => `<!doctype html><body><p id="top">Top marker</p><div style="height:3000px"></div><p id="end">${label}</p></body>`;
  await writeFile(doc.path, long('First end'));
  await owner.agentCall('/agent/documents', { path: doc.path, generated: false });
  const thread = Object.values((await (await f.view(`/a/${owner.alias}/api/state`)).json()).threads as Record<string, { id: string; documentId: string }>).find(thread => thread.documentId === doc.id)!;
  await f.view(`/a/${owner.alias}/api/questions`, { documentId: doc.id, threadId: thread.id, text: 'Where is the top?', clientMessageId: 'top' });
  await agentReply(owner, thread.id, [{ selector: '#top', exact: 'Top marker', label: 'Top' }], 'See [the top](#selection-1).');
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${doc.id}`);
  const frame = page.frameLocator('.file-preview-frame'), scrollY = () => frame.locator('body').evaluate(() => scrollY);
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await frame.locator('#end').evaluate(() => scrollTo(0, 1500));
  await page.waitForTimeout(300);
  await writeFile(doc.path, long('Second end'));
  await owner.agentCall('/agent/documents', { path: doc.path, generated: false });
  await expect(frame.locator('#end')).toHaveText('Second end');
  await expect.poll(scrollY).toBe(1500);
  await page.locator('.message-bubble a', { hasText: 'the top' }).click();
  await expect.poll(scrollY).toBeLessThan(500);
});

test('the HTML full page offers settings and zooms the page without scaling the conversation', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), pageWidth = () => frame.locator('body').evaluate(() => innerWidth);
  await expect(frame.locator('p')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('slider', { name: 'Conversation text size' }).fill('130');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sidecar-conversation-scale'))).toBe('1.3');
  await page.getByRole('button', { name: 'Close settings' }).click();
  const before = await pageWidth(), sidebar = (await page.locator('.sidebar').boundingBox())!.width;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByRole('button', { name: 'Adjust content zoom' })).toHaveText('150%');
  await expect.poll(pageWidth).toBe(Math.round(before / 1.5));
  expect((await page.locator('.sidebar').boundingBox())!.width).toBe(sidebar);
  await page.getByRole('button', { name: 'Adjust content zoom' }).click();
  const popover = page.getByRole('dialog', { name: 'Content zoom', exact: true });
  await popover.getByRole('slider', { name: 'Zoom level' }).fill('137');
  await expect.poll(async () => Math.abs(await pageWidth() - before / 1.37)).toBeLessThan(1);
  await popover.getByRole('button', { name: 'Reset content zoom' }).click();
  await expect.poll(pageWidth).toBe(before);
  await page.locator('.html-filename').click();
  await expect(popover).toBeHidden();
});

test('a fast sidebar drag across the HTML page keeps resizing and ends on release over the page', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(full);
  await expect(page.frameLocator('.file-preview-frame').locator('p')).toBeVisible();
  const sidebar = page.locator('.sidebar'), handle = (await page.locator('.sidebar-resize > div').nth(1).boundingBox())!;
  const before = (await sidebar.boundingBox())!.width, y = handle.y + 300;
  await page.mouse.move(handle.x + 3, y);
  await page.mouse.down();
  // One jump lands the pointer over the page frame; the release happens there too.
  await page.mouse.move(handle.x - 150, y);
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(before + 100);
  const after = (await sidebar.boundingBox())!.width;
  await page.mouse.move(handle.x - 400, y);
  await page.waitForTimeout(100);
  expect((await sidebar.boundingBox())!.width).toBe(after);
});

test('an agent HTML target clicked from the Markdown document opens its full page and reveals there after Run scripts', async ({ page, context }) => {
  const { base, owner } = await htmlThreads();
  const thread = '00000000-0000-4000-8000-000000000001';
  await agentReply(owner, thread, [{ selector: 'p', exact: 'beta', label: 'Beta' }, { selector: '#go', exact: 'Go', element: true, label: 'Go button' }], 'See [the button](#selection-2).');
  await page.goto(`${base}/?document=${owner.doc.id}`);
  await page.getByRole('button', { name: 'Threads', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
  await page.locator('.thread-row', { has: page.locator('.row-tag', { hasText: 'page.html' }) }).click();
  for (const [open, check] of [
    [() => page.getByRole('button', { name: 'Show on page: Beta' }).click(), async (full: import('@playwright/test').Page) => {
      await expect.poll(() => full.frameLocator('.file-preview-frame').locator('p').evaluate(() => getSelection()!.toString())).toBe('beta');
    }],
    [() => page.locator('.message-bubble a', { hasText: 'the button' }).click(), async (full: import('@playwright/test').Page) => {
      await expect(full.frameLocator('.file-preview-frame').locator('div[data-sidecar-bridge]')).toHaveCSS('display', 'block');
    }],
  ] as const) {
    const opened = context.waitForEvent('page');
    await open();
    const full = await opened;
    try {
      // The Markdown document stays put; no static file window replaces the target.
      await expect(page.locator('#document')).toBeVisible();
      await expect(page.getByRole('dialog', { name: /^File: / })).toHaveCount(0);
      const url = new URL(full.url());
      expect([url.searchParams.get('view'), url.searchParams.get('path'), url.searchParams.get('document')]).toEqual(['html', 'page.html', owner.doc.id]);
      const scripts = full.getByRole('checkbox', { name: 'Run scripts' });
      await expect(full.locator('.html-notice')).toHaveText('Turn on Run scripts to show this on the page.');
      await expect(scripts).not.toBeChecked();
      await expect(full.locator('.sidebar')).toContainText('Question about the page');
      await scripts.check();
      await check(full);
      await expect(full.locator('.html-notice')).toHaveCount(0);
    } finally { await full.close(); }
  }
});

test('a standalone HTML document opens its page file links with a workspace and explains refusal without one', async ({ page }) => {
  const owner = f.owners[1], directory = join(f.root, 'linked');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'notes.md'), '# Notes');
  for (const [name, workspace] of [['with.html', directory], ['without.html', undefined]] as const) {
    const path = join(directory, name);
    await writeFile(path, '<!doctype html><body><a id="notes" href="notes.md">Notes</a></body>');
    const doc = await (await owner.agentCall('/agent/documents', { path, generated: false, ...(workspace ? { workspace } : {}) })).json();
    await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${doc.id}`);
    await page.getByRole('checkbox', { name: 'Run scripts' }).check();
    await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
    await page.frameLocator('.file-preview-frame').locator('#notes').click();
    if (workspace) await expect(page.getByRole('dialog', { name: 'File: notes.md', exact: true }).getByRole('heading', { name: 'Notes' })).toBeVisible();
    else {
      await expect(page.locator('.html-notice')).toHaveText('Files open from the page only when this document has a workspace. Reopen it from your agent with one.');
      await expect(page.getByRole('dialog', { name: /^File: / })).toHaveCount(0);
    }
    await expect(page.locator('.file-preview-frame')).toBeVisible();
  }
});

test('HTML selection modes are icon-only toggles with tooltips, accessible names and a clear active mode', async ({ page }) => {
  const { full } = await htmlThreads();
  await page.goto(full);
  const modes = page.getByRole('group', { name: 'Selection mode' });
  const text = modes.getByRole('button', { name: 'Select text' }), pick = modes.getByRole('button', { name: 'Pick element' });
  for (const button of [text, pick]) { await expect(button).toHaveText(''); await expect(button).toBeDisabled(); await expect(button).toHaveAttribute('title', /Run scripts/); }
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(text).toHaveAttribute('aria-pressed', 'true');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(pick).toHaveAttribute('title', /^Pick element/);
  await expect(text).toHaveAttribute('title', /^Select text/);
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await expect(text).toHaveAttribute('aria-pressed', 'false');
  await text.click();
  await expect(text).toHaveAttribute('aria-pressed', 'true');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  // A keyboard selection attaches when Shift is released.
  const frame = page.frameLocator('.file-preview-frame');
  await frame.locator('h1').evaluate(node => {
    getSelection()!.selectAllChildren(node);
    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  });
  await expect(page.locator('.sidebar .selection-badge')).toHaveText('page.html');
});

test('an outside-workspace HTML target opens its tab within the click, survives a slow root grant, and offers a link when blocked', async ({ page, context }) => {
  const owner = f.owners[1], outside = join(f.root, 'outside-page');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'page.html'), pageHtml);
  const file = join(await realpath(outside), 'page.html'), thread = '00000000-0000-4000-8000-000000000003';
  await f.view(`/a/${owner.alias}/api/threads`, { id: thread, documentId: owner.doc.id, file });
  await f.view(`/a/${owner.alias}/api/questions`, { documentId: owner.doc.id, threadId: thread, text: 'Outside page question', clientMessageId: 'outside' });
  await agentReply(owner, thread, [{ selector: 'p', exact: 'beta', label: 'Beta' }], 'See [beta](#selection-1).');
  let granted = 0;
  await page.route('**/api/files/root', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue(); granted++; });
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  await page.getByRole('button', { name: 'Threads', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
  await page.locator('.thread-row', { has: page.locator('.row-tag', { hasText: 'page.html' }) }).click();
  const reveals = async (full: import('@playwright/test').Page) => {
    try {
      await full.waitForURL(/view=html/);
      expect(new URL(full.url()).searchParams.get('directory')).toBe(await realpath(outside));
      await full.getByRole('checkbox', { name: 'Run scripts' }).check();
      await expect.poll(() => full.frameLocator('.file-preview-frame').locator('p').evaluate(() => getSelection()!.toString())).toBe('beta');
      expect(await full.evaluate(() => window.opener)).toBeNull();
    } finally { await full.close(); }
  };
  // The tab exists before the delayed grant answers, then navigates to the granted page.
  let opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Show on page: Beta' }).click();
  const tab = await opened;
  expect(granted).toBe(0);
  await reveals(tab);
  expect(granted).toBe(1);
  // A blocked tab is reported with a real link instead of failing silently.
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', { name: 'Show on page: Beta' }).click();
  const fallback = page.getByRole('alert').getByRole('link', { name: 'Open the HTML page' });
  await expect(fallback).toBeVisible();
  opened = context.waitForEvent('page');
  await fallback.click();
  await reveals(await opened);
  await expect(fallback).toHaveCount(0);
});

// Live reload of open files: a tab polls with If-None-Match, so edits show without a reload and unchanged files cost no bodies.
const longPage = (label: string) => `<!doctype html><body><p>Top marker</p><div style="height:3000px"></div><p id="end">${label}</p></body>`;
test('HTML full page reloads after an edit keeping Run scripts, scroll and drafts, and remembers Run scripts per tab', async ({ page }) => {
  test.setTimeout(45000);
  const { owner, base, full } = await htmlThreads();
  await writeFile(join(owner.directory, 'page.html'), longPage('First end'));
  await page.goto(full);
  const frame = page.frameLocator('.file-preview-frame'), scripts = page.getByRole('checkbox', { name: 'Run scripts' }), draft = page.getByLabel('Message', { exact: true });
  await scripts.check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await draft.fill('typed draft');
  await frame.locator('#end').evaluate(() => scrollTo(0, 1500));
  await page.waitForTimeout(300);
  await writeFile(join(owner.directory, 'page.html'), longPage('Second end'));
  await expect(frame.locator('#end')).toHaveText('Second end', { timeout: 10000 });
  await expect(scripts).toBeChecked();
  await expect.poll(() => frame.locator('body').evaluate(() => scrollY)).toBe(1500);
  await expect(draft).toHaveValue('typed draft');
  await page.reload();
  await expect(scripts).toBeChecked();
  await writeFile(join(owner.directory, 'other.html'), longPage('Other end'));
  await page.goto(`${base}/?view=html&document=${owner.doc.id}&path=other.html`);
  await expect(page.locator('.file-preview-frame')).toBeVisible();
  await expect(scripts).not.toBeChecked();
});

test('Run scripts still toggles when session storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const proto = Storage.prototype as unknown as Record<string, (this: Storage, ...args: unknown[]) => unknown>;
    for (const name of ['getItem', 'setItem']) {
      const original = proto[name];
      proto[name] = function (this: Storage, ...args: unknown[]) { if (this === window.sessionStorage) throw new Error('blocked'); return original.apply(this, args); };
    }
  });
  const { full } = await htmlThreads();
  await page.goto(full);
  const scripts = page.getByRole('checkbox', { name: 'Run scripts' });
  await scripts.check();
  await expect(scripts).toBeChecked();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
});

async function openFiles(page: import('@playwright/test').Page, files: Record<string, string>, padding = '') {
  const owner = f.owners[1], links = Object.keys(files).map(name => `[${name}](${name})`).join('\n\n');
  for (const [name, text] of Object.entries(files)) await writeFile(join(owner.directory, name), text);
  await writeFile(join(owner.directory, 'review.md'), `# Review\n\n${links}\n\n${padding}`);
  await page.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  const open = async (name: string) => { await page.locator('#document').getByRole('link', { name, exact: true }).click(); return page.getByRole('dialog', { name: `File: ${name}`, exact: true }); };
  return { owner, open, file: (name: string) => join(owner.directory, name) };
}

test('open file windows refresh after edits, docked ones too, and a closed window stops polling', async ({ page }) => {
  test.setTimeout(45000);
  const { open, file } = await openFiles(page, { 'note.md': '# Note\n\nBefore text.', 'code.ts': 'export const before = 1;\n' });
  const note = await open('note.md'), code = await open('code.ts');
  await expect(note).toContainText('Before text.');
  await expect(code).toContainText('before');
  await code.getByRole('button', { name: 'Minimize window', exact: true }).click();
  await writeFile(file('note.md'), '# Note\n\nAfter text.');
  await writeFile(file('code.ts'), 'export const after = 2;\n');
  await expect(note).toContainText('After text.', { timeout: 10000 });
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await dock.getByRole('button', { name: 'Expand dock', exact: true }).click();
  await expect(dock.getByRole('tabpanel')).toContainText('after', { timeout: 10000 });
  await note.getByRole('button', { name: 'Close file window', exact: true }).click();
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('path=note.md')) requests.push(request.url()); });
  await page.waitForTimeout(4000);
  expect(requests).toEqual([]);
});

test('unchanged open files answer polls with 304 and no body', async ({ page }) => {
  test.setTimeout(45000);
  // WebKit surfaces a cached 200 for a wire 304, so assert the client contract; the server's 304 is covered in html-preview.test.ts.
  const polls: { etag: string | undefined; status: number; tag: string | null }[] = [];
  page.on('response', async response => {
    if (response.url().includes('/api/files/content') && response.url().includes('path=note.md')) polls.push({ etag: (await response.request().allHeaders())['if-none-match'], status: response.status(), tag: (await response.allHeaders())['etag'] ?? null });
  });
  const { open } = await openFiles(page, { 'note.md': '# Note\n\nStable text.' });
  const note = await open('note.md');
  await expect(note).toContainText('Stable text.');
  await expect.poll(() => polls.length, { timeout: 10000 }).toBeGreaterThan(2);
  expect(polls[0]).toMatchObject({ etag: undefined, status: 200 });
  for (const poll of polls.slice(1)) {
    expect(poll.etag).toBe(polls[0].tag);
    expect(poll.status === 304 || (poll.status === 200 && poll.tag === polls[0].tag)).toBe(true);
  }
  await expect(note).toContainText('Stable text.');
});

test('saved file quotes show Selection changed only once their text is gone, and File unavailable for a deleted file', async ({ page }) => {
  test.setTimeout(60000);
  const owner = f.owners[1], workspace = owner.doc.workspace.replace(/\/$/, ''), thread = '00000000-0000-4000-8000-000000000002';
  const post = (path: string, body: object) => f.view(`/a/${owner.alias}${path}`, body);
  await post('/api/threads', { id: thread, documentId: owner.doc.id });
  await post('/api/questions', { documentId: owner.doc.id, threadId: thread, text: 'Quote note', clientMessageId: 'note', fileQuote: { path: `${workspace}/note.md`, kind: 'doc', exact: 'Alpha line here.' } });
  await post('/api/questions', { documentId: owner.doc.id, threadId: thread, text: 'Quote code', clientMessageId: 'code', fileQuote: { path: `${workspace}/code.ts`, kind: 'code', exact: 'export const b = 2;', startLine: 2, endLine: 2 } });
  await agentReply(owner, thread, [], 'Noted.');
  const { open, file } = await openFiles(page, { 'note.md': '# Note\n\nAlpha line here.\n\nOther stuff.', 'code.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' });
  const note = await open('note.md'), code = await open('code.ts'), issues = page.locator('.sidebar .passage-context .changed');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator('.thread-row', { hasText: 'Noted.' }).click();
  await expect(page.locator('.sidebar')).toContainText('Quote code');
  await expect(note).toContainText('Alpha line here.');
  await expect(issues).toHaveCount(0);
  // Unrelated edits (a line inserted above the quote) leave both quotes valid.
  await writeFile(file('code.ts'), '// header\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  await writeFile(file('note.md'), '# Note\n\nAlpha line here.\n\nOther stuff changed.');
  await expect(note).toContainText('Other stuff changed.', { timeout: 10000 });
  await expect(code).toContainText('header');
  await expect(issues).toHaveCount(0);
  await writeFile(file('note.md'), '# Note\n\nGone.');
  await expect(issues).toHaveText(['Selection changed'], { timeout: 10000 });
  await writeFile(file('code.ts'), 'export const a = 1;\n');
  await expect(issues).toHaveText(['Selection changed', 'Selection changed'], { timeout: 10000 });
  await unlink(file('note.md'));
  await expect(issues.first()).toHaveText('File unavailable', { timeout: 10000 });
  await writeFile(file('note.md'), '# Note\n\nAlpha line here.');
  await writeFile(file('code.ts'), 'export const b = 2;\n');
  await expect(issues).toHaveCount(0, { timeout: 10000 });
});

test('a full-page HTML file opened while missing appears once created, and a deleted one shows unavailable then recovers with Run scripts and drafts intact', async ({ page }) => {
  test.setTimeout(60000);
  const { owner, full } = await htmlThreads();
  const frame = page.frameLocator('.file-preview-frame'), alert = page.getByRole('alert').filter({ hasText: 'This HTML file is unavailable' });
  await page.goto(full.replace('page.html', 'missing.html'));
  await expect(page.locator('.file-preview-frame')).toHaveCount(0);
  await writeFile(join(owner.directory, 'missing.html'), '<!doctype html><body><p id="here">Now here</p></body>');
  await expect(frame.locator('#here')).toHaveText('Now here', { timeout: 10000 });
  await page.goto(full);
  const scripts = page.getByRole('checkbox', { name: 'Run scripts' }), draft = page.getByLabel('Message', { exact: true });
  await scripts.check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await page.locator('.thread-row', { hasText: 'Question about the page' }).click();
  await draft.fill('typed draft');
  await unlink(join(owner.directory, 'page.html'));
  await expect(alert).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.file-preview-frame')).toHaveCount(0);
  await writeFile(join(owner.directory, 'page.html'), pageHtml);
  await expect(page.locator('.file-preview-frame')).toBeVisible({ timeout: 10000 });
  await expect(alert).toHaveCount(0);
  await expect(scripts).toBeChecked();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await expect(draft).toHaveValue('typed draft');
});

test('files displaced by one-at-a-time mode or its switch stop polling once closed', async ({ page }) => {
  test.setTimeout(60000);
  const { open } = await openFiles(page, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });
  const requests: string[] = [];
  page.on('request', request => { if (/path=[ab]\.ts/.test(request.url())) requests.push(request.url()); });
  const mode = async () => { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('radio', { name: 'One at a time', exact: true }).check(); await page.getByRole('button', { name: 'Close settings', exact: true }).click(); };
  await mode();
  await open('a.ts');
  const b = await open('b.ts');
  await expect(page.getByRole('dialog', { name: 'File: a.ts', exact: true })).toHaveCount(0);
  await b.getByRole('button', { name: 'Close file window', exact: true }).click();
  await page.waitForTimeout(500); requests.length = 0;
  await page.waitForTimeout(4000);
  expect(requests).toEqual([]);
  // Switch path: two windows in multi mode, then single keeps only the last.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Multiple', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await open('a.ts'); const second = await open('b.ts');
  await expect(page.getByRole('dialog', { name: 'File: a.ts', exact: true })).toBeVisible();
  await mode();
  await expect(page.getByRole('dialog', { name: 'File: a.ts', exact: true })).toHaveCount(0);
  await second.getByRole('button', { name: 'Close file window', exact: true }).click();
  await page.waitForTimeout(500); requests.length = 0;
  await page.waitForTimeout(4000);
  expect(requests).toEqual([]);
});

test('a docked, collapsed Markdown file still refreshes its saved source line quote validity', async ({ page }) => {
  test.setTimeout(60000);
  const owner = f.owners[1], workspace = owner.doc.workspace.replace(/\/$/, ''), thread = '00000000-0000-4000-8000-000000000003';
  const post = (path: string, body: object) => f.view(`/a/${owner.alias}${path}`, body);
  await post('/api/threads', { id: thread, documentId: owner.doc.id });
  await post('/api/questions', { documentId: owner.doc.id, threadId: thread, text: 'Quote bold', clientMessageId: 'bold', fileQuote: { path: `${workspace}/note.md`, kind: 'doc', exact: 'Alpha **bold** selected.', startLine: 1, endLine: 1 } });
  await agentReply(owner, thread, [], 'Noted.');
  const { open, file } = await openFiles(page, { 'note.md': 'Alpha **bold** selected.' });
  const note = await open('note.md'), issues = page.locator('.sidebar .passage-context .changed');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator('.thread-row', { hasText: 'Noted.' }).click();
  await expect(page.locator('.sidebar')).toContainText('Quote bold');
  await expect(note).toContainText('Alpha bold selected.');
  await note.getByRole('button', { name: 'Minimize window', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('button', { name: 'Expand dock', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(issues).toHaveCount(0);
  await writeFile(file('note.md'), 'Entirely different wording.');
  await expect(issues).toHaveText(['Selection changed'], { timeout: 10000 });
  await expect(dock.getByRole('button', { name: 'Expand dock', exact: true })).toBeVisible();
  await writeFile(file('note.md'), 'Alpha **bold** selected.');
  await expect(issues).toHaveCount(0, { timeout: 10000 });
  await expect(dock.getByRole('button', { name: 'Expand dock', exact: true })).toBeVisible();
});

test('an attached HTML quote shows Selection changed after the page text it names is gone', async ({ page }) => {
  test.setTimeout(45000);
  const { owner, file, full } = await htmlThreads();
  const asked = await f.view(`/a/${owner.alias}/api/questions`, { documentId: owner.doc.id, threadId: '00000000-0000-4000-8000-000000000001', text: 'Quote title', clientMessageId: 'title', fileQuote: { path: file, kind: 'html', exact: 'Title', selector: '#title' } });
  expect(asked.status).toBe(200);
  await agentReply(owner, '00000000-0000-4000-8000-000000000001', [], 'Noted.');
  await page.goto(full);
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  await expect(page.locator('.sidebar')).toContainText('Quote title');
  await page.waitForTimeout(500);
  await expect(page.locator('.sidebar .passage-context .changed')).toHaveCount(0);
  await writeFile(join(owner.directory, 'page.html'), pageHtml.replace('>Title<', '>Heading<'));
  await expect(page.locator('.sidebar .passage-context .changed')).toHaveText('Selection changed', { timeout: 10000 });
});

const box = async (locator: import('@playwright/test').Locator) => (await locator.boundingBox())!;
const near = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) <= 2);

test('a refresh restores open file windows, their geometry, zoom, dock state and the document scroll; a new tab starts clean', async ({ page, context }) => {
  test.setTimeout(60000);
  const padding = Array.from({ length: 120 }, (_, index) => `Paragraph ${index} of padding text.`).join('\n\n');
  const { open, owner } = await openFiles(page, { 'note.md': '# Note\n\nNote body.', 'code.ts': 'export const kept = 1;\n' }, padding);
  const note = await open('note.md'), code = await open('code.ts');
  await code.getByRole('button', { name: 'Minimize window', exact: true }).click();
  const title = note.getByRole('group', { name: 'Move file window', exact: true });
  await title.focus();
  for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowLeft');
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowDown');
  await note.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await note.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(note.getByRole('button', { name: 'Adjust content zoom' })).toHaveText('150%');
  const canvas = page.locator('main.canvas');
  await canvas.evaluate(node => node.scrollTo({ top: 600, behavior: 'instant' }));
  await expect.poll(() => canvas.evaluate(node => node.scrollTop)).toBeGreaterThan(300);
  const before = await box(note), scrolled = await canvas.evaluate(node => node.scrollTop);
  await page.waitForTimeout(500);
  await page.reload();
  const restored = page.getByRole('dialog', { name: 'File: note.md', exact: true });
  await expect(restored).toContainText('Note body.');
  expect(near(await box(restored), before)).toBe(true);
  await expect(restored.getByRole('button', { name: 'Adjust content zoom' })).toHaveText('150%');
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock).toContainText('1 window');
  await dock.getByRole('button', { name: 'Expand dock', exact: true }).click();
  await expect(dock.getByRole('tabpanel')).toContainText('kept');
  await expect(page.getByRole('dialog', { name: 'File: code.ts', exact: true })).toHaveCount(0);
  await expect.poll(async () => Math.abs((await canvas.evaluate(node => node.scrollTop)) - scrolled)).toBeLessThan(40);
  // sessionStorage is per tab: another tab on the same URL starts without the windows.
  const other = await context.newPage();
  await other.goto(`${f.gateway.url}/a/${owner.alias}/?document=${owner.doc.id}`);
  await expect(other.locator('#document')).toContainText('Paragraph 0');
  await expect(other.getByRole('dialog')).toHaveCount(0);
  await expect(other.getByRole('region', { name: 'Window dock', exact: true })).toHaveCount(0);
  await other.close();
});

test('a refresh still loads and file windows still open when session storage is blocked', async ({ page }) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    const proto = Storage.prototype as unknown as Record<string, (this: Storage, ...args: unknown[]) => unknown>;
    for (const name of ['getItem', 'setItem']) {
      const original = proto[name];
      proto[name] = function (this: Storage, ...args: unknown[]) { if (this === window.sessionStorage) throw new Error('blocked'); return original.apply(this, args); };
    }
  });
  const { open } = await openFiles(page, { 'note.md': '# Note\n\nNote body.' });
  await expect(await open('note.md')).toContainText('Note body.');
  await page.reload();
  await expect(page.locator('#document')).toContainText('note.md');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(await open('note.md')).toContainText('Note body.');
});

test('a refresh restores the full-page HTML scroll and zoom while Run scripts is on', async ({ page }) => {
  test.setTimeout(45000);
  const { owner, full } = await htmlThreads();
  await writeFile(join(owner.directory, 'page.html'), '<!doctype html><body style="margin:0"><div style="height:4000px">Tall page</div></body>');
  await page.goto(full);
  await page.getByRole('checkbox', { name: 'Run scripts' }).check();
  await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled();
  const frame = page.frameLocator('.file-preview-frame');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).first().click();
  await frame.locator('body').evaluate(() => scrollTo(0, 700));
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Run scripts' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Adjust content zoom' }).first()).toHaveText('125%');
  await expect.poll(() => frame.locator('body').evaluate(() => scrollY), { timeout: 10000 }).toBeGreaterThan(600);
});

for (const scripts of [false, true]) test(`an HTML page keeps its #step across refreshes and agent edits without reloading on the click (Run scripts ${scripts ? 'on' : 'off'})`, async ({ page }) => {
  test.setTimeout(60000);
  const { owner, full } = await htmlThreads(), file = join(owner.directory, 'page.html');
  const steps = (suffix: string) => `<!doctype html><style>.s{display:none}.s:target{display:block}</style><body><a href="#step1">one</a> <a href="#step2">two</a> <a id="to3" href="#step3">three</a><div id="step1" class="s">Step one</div><div id="step2" class="s">Step two</div><div id="step3" class="s">Step three${suffix}</div></body>`;
  await writeFile(file, steps(''));
  await page.goto(full);
  if (scripts) { await page.getByRole('checkbox', { name: 'Run scripts' }).check(); await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled(); }
  const frame = page.frameLocator('.file-preview-frame');
  await frame.locator('body').evaluate(body => { body.dataset.marker = 'first-load'; });
  await frame.locator('#to3').click();
  await expect(frame.getByText('Step three')).toBeVisible();
  await expect(page).toHaveURL(/#step3$/);
  const entries = await page.evaluate(() => history.length);
  // The click did not reload the frame, and made no history entry in the viewer.
  await page.waitForTimeout(500);
  await expect(frame.locator('body')).toHaveAttribute('data-marker', 'first-load');
  expect(await page.evaluate(() => history.length)).toBe(entries);
  await page.reload();
  await expect(frame.getByText('Step three')).toBeVisible();
  await frame.locator('body').evaluate(body => { body.dataset.marker = 'second-load'; });
  await writeFile(file, steps(' v2'));
  await expect(frame.getByText('Step three v2')).toBeVisible({ timeout: 10000 });
  await expect(page).toHaveURL(/#step3$/);
});

const frameTop = (frame: import('@playwright/test').FrameLocator, selector: string) => frame.locator(selector).evaluate(node => node.getBoundingClientRect().top);
async function openScripted(page: import('@playwright/test').Page, html: string, scripts = true) {
  const { owner, full } = await htmlThreads(), file = join(owner.directory, 'page.html');
  await writeFile(file, html);
  await page.goto(full);
  if (scripts) { await page.getByRole('checkbox', { name: 'Run scripts' }).check(); await expect(page.getByRole('button', { name: 'Pick element' })).toBeEnabled(); }
  return { file, frame: page.frameLocator('.file-preview-frame') };
}

for (const scripts of [false, true]) test(`a #step that an edit removes shows a notice, clears the URL hash and opens at the top (Run scripts ${scripts ? 'on' : 'off'})`, async ({ page }) => {
  test.setTimeout(60000);
  const steps = (three: string) => `<!doctype html><style>.s{display:none}.s:target{display:block}</style><body><a id="to3" href="#step3">three</a> <a id="route" href="#/route">route</a><div id="step1" class="s">Step one</div>${three}</body>`;
  const { file, frame } = await openScripted(page, steps('<div id="step3" class="s">Step three</div>'), scripts);
  await frame.locator('#to3').click();
  await expect(page).toHaveURL(/#step3$/);
  await page.waitForTimeout(500);
  await writeFile(file, steps(''));
  await expect(page.getByRole('status').filter({ hasText: 'Section #step3 is no longer on this page.' })).toBeVisible({ timeout: 10000 });
  await expect(page).not.toHaveURL(/#/);
  expect(await frame.locator('body').evaluate(() => scrollY)).toBe(0);
  // A page's own #/route hash is its business: kept, no notice, also across a refresh.
  await frame.locator('#route').click();
  await expect(page).toHaveURL(/#\/route$/);
  await page.reload();
  await expect(frame.locator('#route')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/route$/);
  await expect(page.getByText('is no longer on this page')).toHaveCount(0);
});

test('Run scripts: removing the hash target scrolls to its nearest surviving parent with a nearest-section notice', async ({ page }) => {
  test.setTimeout(60000);
  const doc = (three: string) => `<!doctype html><style>.s{display:none}.s:target{display:block}body{margin:0}</style><body><div style="height:2000px">filler</div><section id="steps"><a id="to3" href="#step3">three</a>${three}<div style="height:3000px">tail</div></section></body>`;
  const { file, frame } = await openScripted(page, doc('<div id="step3" class="s">Step three</div>'));
  await frame.locator('#to3').click();
  await expect(page).toHaveURL(/#step3$/);
  await page.waitForTimeout(800);
  await writeFile(file, doc(''));
  await expect(page.getByRole('status').filter({ hasText: 'Section #step3 is no longer on this page; showing the nearest remaining section.' })).toBeVisible({ timeout: 10000 });
  await expect(page).not.toHaveURL(/#/);
  await expect.poll(async () => Math.abs(await frameTop(frame, '#steps')), { timeout: 10000 }).toBeLessThan(20);
});

test('Run scripts: a revised page returns to the same paragraph (not the same pixel), across agent edits and refreshes', async ({ page }) => {
  test.setTimeout(60000);
  const doc = (inserted: string) => `<!doctype html><body style="margin:0">${inserted}<div style="height:1500px">filler</div><p id="target" style="margin:0">Target paragraph</p><div style="height:3000px">after</div></body>`;
  const { file, frame } = await openScripted(page, doc(''));
  await frame.locator('#target').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await writeFile(file, doc('<div id="inserted" style="height:900px">inserted</div>'));
  await expect(frame.locator('#inserted')).toHaveCount(1, { timeout: 10000 });
  await expect.poll(async () => Math.abs(await frameTop(frame, '#target')), { timeout: 10000 }).toBeLessThan(20);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(frame.locator('#inserted')).toHaveCount(1);
  await expect.poll(async () => Math.abs(await frameTop(frame, '#target')), { timeout: 10000 }).toBeLessThan(20);
});

test('Run scripts: a removed anchored element falls back to its surviving parent section', async ({ page }) => {
  test.setTimeout(60000);
  const doc = (anchored: string) => `<!doctype html><body style="margin:0"><div style="height:800px">filler</div><section id="part2"><div style="height:700px">intro</div>${anchored}<div style="height:3000px">tail</div></section></body>`;
  const { file, frame } = await openScripted(page, doc('<p style="margin:0">Anchored paragraph</p>'));
  await frame.locator('#part2 p').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await writeFile(file, doc(''));
  await expect(frame.locator('#part2 p')).toHaveCount(0, { timeout: 10000 });
  await expect.poll(async () => Math.abs(await frameTop(frame, '#part2')), { timeout: 10000 }).toBeLessThan(20);
});

test('Run scripts: an id-less anchor never lands on a shifted sibling', async ({ page }) => {
  test.setTimeout(60000);
  const paragraphs = (from: number) => Array.from({ length: 60 }, (_, index) => `<p style="margin:0;height:60px">Para ${index + from}</p>`).join('');
  const doc = (inserted: string) => `<!doctype html><body style="margin:0"><div>${inserted}${paragraphs(0)}</div></body>`;
  const { file, frame } = await openScripted(page, doc(''));
  await frame.getByText('Para 30', { exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await writeFile(file, doc('<p id="inserted" style="margin:0;height:400px">New</p>'));
  await expect(frame.locator('#inserted')).toHaveCount(1, { timeout: 10000 });
  await page.waitForTimeout(800);
  // Positionally the old anchor now names Para 29; its text no longer matches, so it must not be used to place the page.
  expect(Math.abs(await frame.getByText('Para 29', { exact: true }).evaluate(node => node.getBoundingClientRect().top))).toBeGreaterThan(20);
});
