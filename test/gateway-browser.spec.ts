import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
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
  const standalone = await page.context().newPage();
  try {
    const source = await page.locator('iframe[title="Preview of probe.html"]').getAttribute('src');
    await standalone.goto(new URL(source!, page.url()).href);
    await expect(standalone.locator('#result')).toHaveText('Script ran');
    expect(await standalone.evaluate(() => { try { void document.cookie; return false; } catch { return true; } })).toBe(true);
  } finally { await standalone.close(); }
});
