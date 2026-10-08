import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { setupGateway } from './gateway-support.ts';

let f: Awaited<ReturnType<typeof setupGateway>>, cleanup: (() => Promise<void>)[];
test.beforeEach(async () => { cleanup = []; f = await setupGateway({ after: fn => { cleanup.push(fn); } }); });
test.afterEach(async () => { for (const fn of cleanup) await fn(); });

test('prefixed document uses only its owner APIs and preserves its draft on reload', async ({ page }) => {
  const owner = f.owners[1], path = `/a/${owner.alias}/?document=${owner.doc.id}`;
  const errors: string[] = [], apiPaths: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.includes('/api/')) apiPaths.push(url.pathname); });
  await page.goto(f.gateway.url + path);
  await expect(page.getByRole('heading', { name: 'claude', exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('A draft on the shared origin');
  await page.waitForTimeout(150); await page.reload();
  await expect(input).toHaveValue('A draft on the shared origin');
  await expect.poll(() => apiPaths.some(path => path.endsWith('/api/events'))).toBe(true);
  expect(apiPaths.every(path => path.startsWith(`/a/${owner.alias}/api/`))).toBe(true);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Allow access on local network' }).click();
  await page.getByLabel('Public HTTPS URL', { exact: true }).fill('https://sidecar.example');
  await page.getByRole('button', { name: 'Save URL', exact: true }).click();
  await expect(page.getByRole('link', { name: /^https:\/\/sidecar\.example/ })).toHaveAttribute('href', `https://sidecar.example${path}`);
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
  await expect(rows.filter({ hasText: f.owners[0].owner.sessionId })).toContainText('1 document');
  await rows.filter({ hasText: f.owners[0].owner.sessionId }).getByRole('button', { name: 'Copy session ID' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(f.owners[0].owner.sessionId);
  await page.getByRole('button', { name: 'Sort agents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await page.getByRole('link', { name: new RegExp(f.owners[1].owner.sessionId) }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sort documents' })).toContainText('Last opened');
  await page.getByRole('button', { name: 'Sort documents' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent conversation activity' }).click();
  await page.reload(); await expect(page.getByRole('button', { name: 'Sort documents' })).toContainText('Recent conversation activity');
  await page.getByRole('link', { name: 'All agents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort agents' })).toContainText('Recent conversation activity');
  await page.screenshot({ path: '/private/tmp/sidecar-gateway-agents.png' });
});

test('stopped agent retains preview and close confirmation, including its empty document list', async ({ page }) => {
  const owner = f.owners[1]; await owner.stop();
  await page.goto(f.gateway.url);
  await expect(page.locator('.library-agent-row').filter({ hasText: owner.owner.sessionId })).toContainText('Stopped');
  await page.getByRole('link', { name: new RegExp(owner.owner.sessionId) }).click();
  await page.getByRole('link', { name: /^claude/ }).click();
  await expect(page.getByRole('article', { name: 'Document' })).toContainText('Own document.');
  await page.getByRole('link', { name: 'All documents', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Close “claude”' }).click();
  await expect(page.getByRole('link', { name: /^claude/ })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Close “claude”' }).click();
  await expect(page.getByText('No saved documents.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'All agents', exact: true }).click();
  await expect(page.locator('.library-agent-row').filter({ hasText: owner.owner.sessionId })).toContainText('0 documents');
});
