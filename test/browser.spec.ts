import { test, expect, type Page } from '@playwright/test';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './support.ts';
let f: Awaited<ReturnType<typeof fixture>>;
let cleanup: (() => Promise<void>)[];
test.beforeEach(async () => { cleanup = []; f = await fixture({ after: fn => { cleanup.push(fn); } }); });
test.afterEach(async () => { for (const fn of cleanup) await fn(); });
async function state() { return (await f.view('/api/state')).json(); }
async function lastRequest() { return Object.values<any>((await state()).requests).at(-1)!; }
async function answer(text: string) {
  const request = await lastRequest();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  await f.agent('/agent/replies', { requestId: request.id, documentId: request.documentId, threadId: request.threadId, text });
}
async function select(page: Page, exact: string) {
  await page.evaluate(exact => {
    const article = document.getElementById('document')!;
    const start = article.textContent!.indexOf(exact), end = start + exact.length;
    if (start < 0) throw new Error('Selection text missing');
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let at = 0, hasStart = false, node;
    while ((node = walker.nextNode())) {
      const length = node.textContent!.length;
      if (!hasStart && at + length > start) { range.setStart(node, start - at); hasStart = true; }
      if (hasStart && at + length >= end) { range.setEnd(node, end - at); break; }
      at += length;
    }
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, exact);
}

test('general questions, follow-ups, late replies and independent document titles', async ({ page }) => {
  const a = await f.register(), b = await f.register('b.md', '# Other\n\nSecond document.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByLabel('Question', { exact: true }).fill('Explain this document');
  await page.getByLabel('Question', { exact: true }).press('Tab'); await page.keyboard.press('Enter');
  await expect(page.getByText('Explain this document', { exact: true })).toBeVisible();
  expect((await lastRequest()).quote).toBeUndefined();
  await answer('Here is the answer');
  await expect(page.getByText('Here is the answer', { exact: true })).toBeVisible();
  await page.getByLabel('Follow-up').fill('Clarify further');
  await page.getByRole('button', { name: 'Send follow-up' }).click();
  await expect(page.getByText('Clarify further', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await answer('A late clarification');
  await expect(page.getByText('A late clarification', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await page.getByLabel('Document title').fill('My review title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page).toHaveTitle('My review title');
  await page.getByRole('link', { name: 'Other', exact: true }).click();
  await expect(page).toHaveTitle('Other');
  await page.getByLabel('Document title').fill('Second title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page).toHaveTitle('Second title');
  await page.getByRole('link', { name: 'My review title', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();
  await page.reload(); await expect(page).toHaveTitle('My review title');
  await f.reopen(); await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page).toHaveTitle('My review title');
  await expect(page.getByText('A late clarification', { exact: true })).toBeVisible();
  expect((await state()).documents[b.id].title).toBe('Second title');
});

test('selection spans inline formatting, code and emoji; outside and empty selections are general', async ({ page }) => {
  const a = await f.register('a.md', '# Selection\n\nAlpha **bold 😀** and `code` omega.\n\n<script>window.injected=true</script>');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('bold 😀');
  await select(page, 'bold 😀 and code');
  await expect(page.getByTestId('selection-preview')).toHaveText('bold 😀 and code');
  await page.getByLabel('Question', { exact: true }).fill('Explain the selection');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Explain the selection', { exact: true })).toBeVisible();
  const quote = (await lastRequest()).quote;
  expect(quote.exact).toBe('bold 😀 and code'); expect(quote.end - quote.start).toBe(quote.exact.length);
  expect(await page.locator('#document script').count()).toBe(0);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('h1')!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.getByTestId('selection-preview')).toHaveText('Whole document');
  await page.getByLabel('Question', { exact: true }).fill('General after outside selection');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('General after outside selection', { exact: true })).toBeVisible();
  expect((await lastRequest()).quote).toBeUndefined();
});

test('file replacement preserves draft and focus; ambiguous or missing passages preserve threads', async ({ page }) => {
  const repeated = 'prefix '.repeat(7) + 'repeat' + ' suffix'.repeat(7);
  const a = await f.register('a.md', '# Before\n\n' + repeated);
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('repeat');
  await select(page, 'repeat');
  await page.getByLabel('Question', { exact: true }).fill('What does this mean?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('What does this mean?', { exact: true })).toBeVisible();
  await page.getByLabel('Follow-up').fill('Unfinished draft');
  const replacement = join(f.directory, 'replace.md');
  await writeFile(replacement, '# After\n\n' + repeated + '\n\n' + repeated);
  await rename(replacement, join(f.directory, 'a.md'));
  await expect(page.locator('#document h1')).toHaveText('After');
  await expect(page.getByText('Passage changed.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Follow-up')).toHaveValue('Unfinished draft');
  await expect(page.getByLabel('Follow-up')).toBeFocused();
  await unlink(join(f.directory, 'a.md'));
  await expect(page.getByTestId('document-error')).toContainText('unavailable');
  await expect(page.getByText('What does this mean?', { exact: true })).toBeVisible();
});


test('file refresh preserves the captured passage in an unsent question', async ({ page }) => {
  const a = await f.register('a.md', '# Before\n\nTarget passage.\n');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('Target passage.');
  await select(page, 'Target passage.');
  await page.getByLabel('Question', { exact: true }).fill('Please rewrite this selected passage');
  await writeFile(join(f.directory, 'a.md'), '# After\n\nReplacement passage.\n');
  await expect(page.locator('#document h1')).toHaveText('After');
  await expect(page.getByTestId('selection-preview')).toContainText('Target passage.');
  await expect(page.getByTestId('selection-preview')).toContainText('Passage changed');
  await expect(page.getByLabel('Question', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Please rewrite this selected passage', { exact: true })).toBeVisible();
  const request = await lastRequest();
  expect(request.quote.exact).toBe('Target passage.');
  expect((await state()).threads[request.threadId].scope).toBe('passage');
});


test('a delayed title save preserves newer unsaved typing', async ({ page }) => {
  const a = await f.register();
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page).toHaveTitle('First heading');
  let release = () => {}, saved = () => {};
  const holdResponse = new Promise<void>(resolve => { release = resolve; });
  const serverSaved = new Promise<void>(resolve => { saved = resolve; });
  await page.route(`**/api/documents/${a.id}/title`, async route => {
    const response = await route.fetch();
    saved(); await holdResponse; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByLabel('Document title').fill('First saved title');
    await page.getByRole('button', { name: 'Save title' }).click();
    await serverSaved;
    await page.getByLabel('Document title').fill('Second unsaved title');
    const refreshed = page.waitForResponse(`**/api/state`);
    release(); await refreshed;
    await expect(page.getByLabel('Document title')).toHaveValue('Second unsaved title');
    await page.getByRole('button', { name: 'Save title' }).click();
    await expect(page).toHaveTitle('Second unsaved title');
  } finally { release(); }
});


test('partial replies update live without losing a follow-up draft or rendering HTML', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Question', { exact: true }).fill('Stream the answer');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Follow-up')).toBeVisible();
  const request = await lastRequest();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  const route = { requestId: request.id, documentId: doc.id, threadId: request.threadId };
  const markers = await (await f.agent('/agent/streams', route)).json();
  const emit = (index: number, delta: string, final = false) => f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId: 'message', turnId: 'turn', index, delta, final });
  await page.getByLabel('Follow-up').fill('Keep this draft');
  await emit(0, markers.prefix + 'First <img src=x onerror=alert(1)>');
  await expect(page.getByText('First <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('#threads img')).toHaveCount(0);
  expect((await state()).requests[request.id].status).toBe('claimed');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.reload();
  await expect(page.getByText('First <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await page.getByLabel('Follow-up').fill('Keep this draft');
  await page.getByLabel('Follow-up').focus();
  await emit(1, ' second.' + markers.suffix, true);
  await expect(page.getByText('First <img src=x onerror=alert(1)> second.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Follow-up')).toBeFocused();
  await expect(page.getByLabel('Follow-up')).toHaveValue('Keep this draft');
  await f.agent('/agent/replies', { ...route, stream: true });
  await expect(page.getByText('First <img src=x onerror=alert(1)> second.', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Agent is responding.')).toHaveCount(0);
  expect((await state()).threads[request.threadId].isResolved).toBe(true);
});
