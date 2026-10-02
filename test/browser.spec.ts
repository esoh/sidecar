import { test, expect, type Page } from '@playwright/test';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './support.ts';
let f: Awaited<ReturnType<typeof fixture>>;
let cleanup: (() => Promise<void>)[];
let pageErrors: string[];
test.beforeEach(async ({ page }) => {
  cleanup = []; pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('Content Security Policy')) pageErrors.push(message.text()); });
  f = await fixture({ after: fn => { cleanup.push(fn); } });
});
test.afterEach(async () => { try { expect(pageErrors).toEqual([]); } finally { for (const fn of cleanup) await fn(); } });
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
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Explain this document');
  await page.getByLabel('Message', { exact: true }).press('Tab'); await page.keyboard.press('Enter');
  await expect(page.getByRole('log').getByText('Explain this document', { exact: true })).toBeVisible();
  expect((await lastRequest()).quote).toBeUndefined();
  await answer('Here is the answer');
  await expect(page.locator('#threads').getByText('Here is the answer', { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Clarify further');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#threads').getByText('Clarify further', { exact: true })).toBeVisible();
  const followUp = await lastRequest();
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await answer('A late clarification');
  await expect(page.getByRole('log')).toHaveCount(0);
  await page.getByLabel('Thread status').selectOption('resolved');
  await page.locator(`[data-thread-id="${followUp.threadId}"]`).click();
  await expect(page.locator('#threads').getByText('A late clarification', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen thread', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit document name' }).click();
  await page.getByLabel('Document name', { exact: true }).fill('My review title');
  await page.getByLabel('Document name', { exact: true }).press('Enter');
  await expect(page).toHaveTitle('My review title');
  await page.getByLabel('Documents', { exact: true }).selectOption(b.id);
  await expect(page).toHaveTitle('Other');
  await page.getByRole('button', { name: 'Edit document name' }).click();
  await page.getByLabel('Document name', { exact: true }).fill('Second title');
  await page.getByLabel('Document name', { exact: true }).press('Enter');
  await expect(page).toHaveTitle('Second title');
  await page.getByLabel('Documents', { exact: true }).selectOption(a.id);
  await expect(page.getByRole('button', { name: 'Reopen thread', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen thread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible();
  await page.reload(); await expect(page).toHaveTitle('My review title');
  await f.reopen(); await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page).toHaveTitle('My review title');
  await expect(page.locator('#threads').getByText('A late clarification', { exact: true })).toBeVisible();
  expect((await state()).documents[b.id].title).toBe('Second title');
});

test('selection spans inline formatting, code and emoji; outside and empty selections are general', async ({ page }) => {
  const a = await f.register('a.md', '# Selection\n\nAlpha **bold 😀** and `code` omega.\n\n<script>window.injected=true</script>');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('bold 😀');
  await select(page, 'bold 😀 and code');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByTestId('selection-preview')).toHaveText('bold 😀 and code');
  await page.getByLabel('Comment', { exact: true }).fill('Explain the selection');
  await page.getByRole('dialog').getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.locator('#threads').getByText('Explain the selection', { exact: true })).toBeVisible();
  const quote = (await lastRequest()).quote;
  expect(quote.exact).toBe('bold 😀 and code'); expect(quote.end - quote.start).toBe(quote.exact.length);
  expect(await page.locator('#document script').count()).toBe(0);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.brand')!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('General after outside selection');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#threads').getByText('General after outside selection', { exact: true })).toBeVisible();
  expect((await lastRequest()).quote).toBeUndefined();
});

test('file replacement preserves draft and focus; ambiguous or missing passages preserve threads', async ({ page }) => {
  const repeated = 'prefix '.repeat(7) + 'repeat' + ' suffix'.repeat(7);
  const a = await f.register('a.md', '# Before\n\n' + repeated);
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('repeat');
  await select(page, 'repeat');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('What does this mean?');
  await page.getByRole('dialog').getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.locator('#threads').getByText('What does this mean?', { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Unfinished draft');
  const replacement = join(f.directory, 'replace.md');
  await writeFile(replacement, '# After\n\n' + repeated + '\n\n' + repeated);
  await rename(replacement, join(f.directory, 'a.md'));
  await expect(page.locator('#document h1')).toHaveText('After');
  await expect(page.locator('#threads').getByText('Passage changed', { exact: true })).toBeVisible();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unfinished draft');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await unlink(join(f.directory, 'a.md'));
  await expect(page.getByTestId('document-error')).toContainText('unavailable');
  await expect(page.locator('#threads').getByText('What does this mean?', { exact: true })).toBeVisible();
});


test('file refresh preserves the captured passage in an unsent question', async ({ page }) => {
  const a = await f.register('a.md', '# Before\n\nTarget passage.\n');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('Target passage.');
  await select(page, 'Target passage.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Please rewrite this selected passage');
  await writeFile(join(f.directory, 'a.md'), '# After\n\nReplacement passage.\n');
  await expect(page.locator('#document h1')).toHaveText('After');
  await expect(page.getByTestId('selection-preview')).toContainText('Target passage.');
  await expect(page.getByTestId('selection-preview')).toContainText('Passage changed');
  await expect(page.getByLabel('Comment', { exact: true })).toBeFocused();
  await page.getByRole('dialog').getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.locator('#threads').getByText('Please rewrite this selected passage', { exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: 'Edit document name' }).click();
    await page.getByLabel('Document name', { exact: true }).fill('First saved title');
    await page.getByLabel('Document name', { exact: true }).press('Enter');
    await serverSaved;
    await page.getByLabel('Document name', { exact: true }).fill('Second unsaved title');
    const response = page.waitForResponse(`**/api/documents/${a.id}/title`);
    release(); await (await response).finished();
    await expect(page.getByLabel('Document name', { exact: true })).toHaveValue('Second unsaved title');
    await page.getByLabel('Document name', { exact: true }).press('Enter');
    await expect(page).toHaveTitle('Second unsaved title');
  } finally { release(); }
});


test('partial replies render Markdown live without losing a follow-up draft or executing HTML', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Stream the answer');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const request = await lastRequest();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  const route = { requestId: request.id, documentId: doc.id, threadId: request.threadId };
  const markers = await (await f.agent('/agent/streams', route)).json();
  const emit = (index: number, delta: string, final = false) => f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId: 'message', turnId: 'turn', index, delta, final });
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await emit(0, markers.prefix + '**First** <img src=x onerror=alert(1)>');
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('#threads img')).toHaveCount(0);
  await expect(page.locator('#threads .message.agent strong')).toHaveText('First');
  expect((await state()).requests[request.id].status).toBe('claimed');
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await page.getByLabel('Thread status').selectOption('resolved');
  await page.locator(`[data-thread-id="${request.threadId}"]`).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await page.reload();
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await page.getByLabel('Message', { exact: true }).focus();
  await emit(1, ' second.' + markers.suffix, true);
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)> second.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await f.agent('/agent/replies', { ...route, stream: true });
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)> second.', { exact: true })).toHaveCount(1);
  await expect(page.locator('#threads').getByText('Agent is responding.')).toHaveCount(0);
  expect((await state()).threads[request.threadId].isResolved).toBe(true);
});


test('conversation Markdown renders both roles, keeps heading links local and sanitizes HTML', async ({ page }) => {
  const doc = await f.register('markdown.md', '# Shared heading\n\nDocument stays here.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Please explain **bold** and `code`.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message.user strong')).toHaveText('bold');
  await answer(`# Shared heading

[Jump to reply heading](#shared-heading)

A **bold answer** with \`inline code\`.

- First item
- Second item

| Name | Result |
| --- | --- |
| Parser | Ready |

\`\`\`typescript
const answer = 42;
\`\`\`

<details><summary>Details</summary><p>Safe content.</p><img src="x" onerror="window.__sidecarReplyScriptRan=true"></details>

<script>window.__sidecarReplyScriptRan=true</script>
`);
  const reply = page.locator('.message.agent');
  await expect(page.locator('.message.user strong')).toHaveText('bold');
  await expect(page.locator('.message.user code')).toHaveText('code');
  await expect(reply.locator('strong')).toHaveText('bold answer');
  await expect(reply.locator('code.language-typescript')).toContainText('const answer = 42;');
  await expect(reply.locator('table')).toContainText('Parser');
  await expect(reply).toContainText('Second item');
  await expect(reply.locator('script, [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__sidecarReplyScriptRan)).toBeUndefined();
  const id = await reply.getByRole('heading', { name: 'Shared heading' }).getAttribute('id');
  expect(id).toBe(`message-${(await lastRequest()).id}-agent-shared-heading`);
  await page.evaluate(() => {
    (window as any).__lastScrollTarget = '';
    Element.prototype.scrollIntoView = function () { (window as any).__lastScrollTarget = this.id; };
  });
  await reply.getByRole('link', { name: 'Jump to reply heading' }).click();
  expect(await page.evaluate(() => (window as any).__lastScrollTarget)).toBe(id);
  await expect(page.locator('#document h1')).toHaveAttribute('id', 'shared-heading');
  await page.reload();
  await expect(reply.locator('strong')).toHaveText('bold answer');
  await expect(reply.locator('script, [onerror]')).toHaveCount(0);
});

// These catch losing the selected quote on focus, failed-send data loss, and broken thread navigation.
test('floating comments retain their highlight, retry safely, and reopen the saved thread', async ({ page }) => {
  const a = await f.register('a.md', '# Selection\n\nAlpha **bold 😀** and `code` omega.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('bold 😀');
  await select(page, 'bold 😀 and code');
  const comment = page.getByRole('button', { name: 'Comment', exact: true });
  await expect(comment).toBeVisible();
  await comment.click();
  const composer = page.getByRole('dialog', { name: 'Comment on selection' });
  await expect(composer).toBeVisible();
  await expect(composer.getByLabel('Comment', { exact: true })).toBeFocused();
  await composer.getByLabel('Comment', { exact: true }).fill('Explain this passage');
  expect((await page.locator('#document mark').allTextContents()).join('')).toBe('bold 😀 and code');
  await page.route('**/api/questions', route => route.fulfill({ status: 503, json: { error: 'Try again' } }), { times: 1 });
  await composer.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(composer.getByRole('alert')).toHaveText('Try again');
  await expect(composer.getByLabel('Comment', { exact: true })).toHaveValue('Explain this passage');
  await composer.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(page.locator('#threads').getByText('Explain this passage', { exact: true })).toBeVisible();
  const request = await lastRequest();
  expect(request.quote.exact).toBe('bold 😀 and code');
  expect(Object.keys((await state()).requests)).toHaveLength(1);
  await answer('This stays in the original conversation.');
  await page.reload();
  const highlight = page.locator('#document mark').first();
  await expect(highlight).toHaveAttribute('role', 'button');
  await expect(page.locator('#document').getByRole('button', { name: 'bold 😀', exact: true })).toBeVisible();
  await highlight.click();
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', request.threadId);
  await expect(page.getByRole('button', { name: 'Threads', exact: true })).toBeFocused();
  await expect(page.locator('#threads').getByText('This stays in the original conversation.', { exact: true })).toBeVisible();
  await highlight.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', request.threadId);
  await expect(page.getByRole('button', { name: 'Threads', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await expect(page.locator(`[data-thread-id="${request.threadId}"]`)).toHaveCount(0);
  await page.getByLabel('Thread status').selectOption('resolved');
  await page.locator(`[data-thread-id="${request.threadId}"]`).click();
  await expect(page.getByRole('button', { name: 'Reopen thread', exact: true })).toBeVisible();
});

test('composer stays in a narrow viewport and cancels without submitting', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 500 });
  const a = await f.register('a.md', '# Long document\n\n' + 'A paragraph with room to scroll.\n\n'.repeat(20) + 'Final selected passage.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await page.locator('#document').getByText('Final selected passage.', { exact: true }).scrollIntoViewIfNeeded();
  await select(page, 'Final selected passage.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const composer = page.getByRole('dialog', { name: 'Comment on selection' });
  await composer.getByLabel('Comment', { exact: true }).fill('Unsent comment');
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 500 });
    await expect(async () => {
      const box = (await composer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(500);
    }).toPass();
  }
  await page.keyboard.press('Escape');
  await expect(composer).toHaveCount(0);
  expect(Object.keys((await state()).requests)).toHaveLength(0);
  await expect(page.locator('#document mark')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show conversations' }).click();
  await page.getByLabel('Message', { exact: true }).fill('A general question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#threads').getByText('A general question', { exact: true })).toBeVisible();
  expect((await lastRequest()).quote).toBeUndefined();
});

// Clicking a link's annotation must open its thread, not follow the underlying URL.
test('link highlights stay in the viewer and overlapping threads can each be opened', async ({ page }) => {
  const a = await f.register('a.md', '# Links\n\nRead [the docs](https://example.com) carefully.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('the docs');
  await select(page, 'the docs');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('First question');
  await page.getByRole('dialog').getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.locator('#threads').getByText('First question', { exact: true })).toBeVisible();
  const first = await lastRequest();
  await page.locator('#document mark').click();
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', first.threadId);
  expect(page.url()).toContain(f.url);
  const second = await (await f.view('/api/questions', { documentId: a.id, text: 'Second question', clientMessageId: 'second', quote: { ...first.quote, exact: 'docs', prefix: first.quote.prefix + 'the ', start: first.quote.start + 4 } })).json();
  await expect(page.locator('#document mark').filter({ hasText: /^docs$/ })).toBeVisible();
  for (const [text, id] of [['First question', first.threadId], ['Second question', second.threadId]]) {
    await page.locator('#document mark').filter({ hasText: /^docs$/ }).click();
    await page.getByRole('button', { name: text, exact: true }).click();
    await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', id);
  }
  await page.reload();
  await page.locator('#document mark').filter({ hasText: /^docs$/ }).click();
  await expect(page.getByRole('button', { name: 'First question', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Second question', exact: true })).toBeVisible();
});

// Floating annotation controls must preserve reading position and the current conversation draft.
test('opening and closing a passage composer preserves page layout and the general draft', async ({ page }) => {
  const a = await f.register('a.md', '# Stable layout\n\n' + 'Surrounding paragraph.\n\n'.repeat(15) + 'Selected passage stays in place.');
  for (const width of [900, 375]) {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`${f.url}/?document=${a.id}`);
    if (width < 850) await page.getByRole('button', { name: 'Show conversations' }).click();
    const general = page.locator('#threads');
    await general.getByLabel('Message', { exact: true }).fill('Keep this general draft');
    if (width < 850) await page.getByRole('button', { name: 'Hide conversations' }).click();
    await page.locator('#document p').last().scrollIntoViewIfNeeded();
    const layout = () => page.evaluate(() => ({
      scrollY: document.querySelector('.canvas')!.scrollTop,
      height: document.documentElement.scrollHeight,
      passage: document.querySelector('#document p:last-child')!.getBoundingClientRect().top,
      threads: document.querySelector('#threads')!.getBoundingClientRect().top,
    }));
    const before = await layout();
    await select(page, 'Selected passage stays in place.');
    await expect.poll(layout).toEqual(before);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Comment on selection' });
    await expect(popup).toBeVisible();
    await expect.poll(layout).toEqual(before);
    await popup.getByRole('textbox').fill('Separate passage draft');
    await popup.getByRole('textbox').press('Escape');
    await expect(popup).toHaveCount(0);
    await expect.poll(layout).toEqual(before);
    await expect(general.getByLabel('Message', { exact: true })).toHaveValue('Keep this general draft');
    expect(Object.keys((await state()).requests)).toHaveLength(0);
  }
});

test('selecting another passage preserves separate drafts and a failed-send retry', async ({ page }) => {
  const a = await f.register('a.md', '# Switch passages\n\nFirst passage.\n\nSecond passage.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('First passage.');
  const popup = page.getByRole('dialog', { name: 'Comment on selection' });
  const compose = async (quote: string) => {
    await select(page, quote);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(popup.getByTestId('selection-preview')).toHaveText(quote);
  };
  await compose('First passage.');
  await popup.getByRole('textbox').fill('First draft');
  await compose('Second passage.');
  await expect(popup.getByRole('textbox')).toHaveValue('');
  await popup.getByRole('textbox').fill('Second draft');
  await compose('First passage.');
  await expect(popup.getByRole('textbox')).toHaveValue('First draft');
  // The server saved the request, but its response was lost. Switching passages
  // must preserve the idempotency key as well as the text when the user retries.
  await page.route('**/api/questions', async route => {
    await route.fetch();
    await route.fulfill({ status: 503, json: { error: 'Response lost; retry' } });
  }, { times: 1 });
  await popup.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(popup.getByRole('alert')).toHaveText('Response lost; retry');
  await compose('Second passage.');
  await expect(popup.getByRole('textbox')).toHaveValue('Second draft');
  await compose('First passage.');
  await expect(popup.getByRole('textbox')).toHaveValue('First draft');
  await popup.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(popup).toHaveCount(0);
  expect(Object.keys((await state()).requests)).toHaveLength(1);
  expect((await lastRequest()).quote.exact).toBe('First passage.');
});


test('outside clicks dismiss only empty comments and preserve the clicked focus target', async ({ page }) => {
  const a = await f.register('a.md', '# Outside clicks\n\nSelected passage.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('Selected passage.');
  const popup = page.getByRole('dialog', { name: 'Comment on selection' });
  const title = page.getByRole('button', { name: 'Edit document name' });
  const compose = async () => {
    await select(page, 'Selected passage.');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(popup).toBeVisible();
  };
  await compose();
  await popup.getByTestId('selection-preview').click();
  await expect(popup).toBeVisible();
  await title.click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByLabel('Document name', { exact: true })).toBeFocused();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await compose();
  await popup.getByRole('textbox').fill('Keep my draft');
  await title.click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('textbox')).toHaveValue('Keep my draft');
  await expect(page.getByLabel('Document name', { exact: true })).toBeFocused();
  await popup.getByRole('textbox').fill(' \n\t ');
  await title.click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByLabel('Document name', { exact: true })).toBeFocused();
  await compose();
  await expect(popup.getByRole('textbox')).toHaveValue('');
  expect(Object.keys((await state()).requests)).toHaveLength(0);
});


test('C opens the selected comment without intercepting typing, copy shortcuts, or composition', async ({ page }) => {
  const a = await f.register('a.md', '# Comment shortcut\n\nSelected passage.');
  await page.goto(`${f.url}/?document=${a.id}`);
  const article = page.locator('#document');
  const popup = page.getByRole('dialog', { name: 'Comment on selection' });
  await expect(article).toContainText('Selected passage.');
  await article.focus();
  await page.keyboard.press('c');
  await expect(popup).toHaveCount(0);
  await select(page, 'Selected passage.');
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('document')!.dispatchEvent(event);
    return { text: data.getData('text/plain'), handled: event.defaultPrevented };
  });
  expect(copied).toEqual({ text: 'Selected passage.', handled: true });
  for (const key of ['Control+c', 'Meta+c', 'Alt+c']) await page.keyboard.press(key);
  await article.dispatchEvent('keydown', { key: 'c', isComposing: true });
  await expect(popup).toHaveCount(0);
  const title = page.getByRole('button', { name: 'Edit document name' });
  await title.click();
  await page.getByLabel('Document name', { exact: true }).fill(''); await page.getByLabel('Document name', { exact: true }).press('c');
  await expect(page.getByLabel('Document name', { exact: true })).toHaveValue('c');
  const question = page.getByLabel('Message', { exact: true });
  await question.fill(''); await question.press('c');
  await expect(question).toHaveValue('c');
  await expect(popup).toHaveCount(0);
  await article.focus();
  await select(page, 'Selected passage.');
  await page.keyboard.press('c');
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId('selection-preview')).toHaveText('Selected passage.');
  await expect(popup.getByRole('textbox')).toBeFocused();
  await expect(popup.getByRole('textbox')).toHaveValue('');
  await page.keyboard.press('c');
  await expect(popup.getByRole('textbox')).toHaveValue('c');
  await page.keyboard.press('Escape');
  expect(Object.keys((await state()).requests)).toHaveLength(0);
});


test('sidebar filters, preserves per-thread drafts, and keeps background replies in their own thread', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await expect(page.getByRole('heading', { name: 'Unnamed', exact: true })).toBeVisible();
  await message.fill('Explain the document'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest();
  await answer('First reply');
  await f.agent(`/agent/threads/${first.threadId}/title`, { title: 'Document overview' });
  await expect(page.getByRole('heading', { name: 'Document overview' })).toBeVisible();
  await message.fill('Draft in the first conversation');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await message.fill('Question in a different thread'); await message.press('Enter'); await expect(message).toHaveValue('');
  const second = await lastRequest(); expect(second.threadId).not.toBe(first.threadId);
  await message.fill('Keep second draft');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await expect(message).toHaveValue('Draft in the first conversation');
  await answer('Background reply to the second thread');
  await expect(page.getByRole('heading', { name: 'Document overview' })).toBeVisible();
  await expect(message).toHaveValue('Draft in the first conversation');
  await expect(page.locator('#threads')).not.toContainText('Background reply');
  await page.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await expect(page.getByLabel('Thread status')).toBeFocused();
  await expect(page.locator(`[data-thread-id="${first.threadId}"]`)).toHaveCount(0);
  await page.getByLabel('Thread status').selectOption('resolved');
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await page.getByRole('button', { name: 'Reopen thread' }).click();
  await expect(message).toHaveValue('Draft in the first conversation');
  await page.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await page.getByLabel('Thread status').selectOption('resolved');
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await page.getByRole('button', { name: 'Reopen thread' }).click();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByText('No resolved threads.', { exact: true })).toBeVisible();
  await page.getByLabel('Thread status').selectOption('unresolved');
  await expect(page.locator('[data-thread-id]').first()).toHaveAttribute('data-thread-id', second.threadId);
  await page.locator(`[data-thread-id="${second.threadId}"]`).click();
  await expect(message).toHaveValue('Keep second draft');
  await expect(page.locator('#threads')).toContainText('Background reply to the second thread');
});

test('composers grow, preserve Shift+Enter and IME, and submit with Enter', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await expect(message).toBeVisible();
  const height = (await message.boundingBox())!.height;
  await message.fill('One'); await message.press('Shift+Enter'); await message.pressSequentially('Two');
  await expect(message).toHaveValue('One\nTwo');
  await message.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(Object.keys((await state()).requests)).toHaveLength(0);
  await message.fill(Array.from({length: 16}, (_, i) => `Line ${i}`).join('\n'));
  const grown = (await message.boundingBox())!.height;
  expect(grown).toBeGreaterThan(height); expect(grown).toBeLessThanOrEqual(240);
  await message.press('Enter'); await expect(message).toHaveValue('');
  expect(Object.keys((await state()).requests)).toHaveLength(1);
  expect((await message.boundingBox())!.height).toBe(height);
  await select(page, 'Hello world.'); await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const comment = page.getByRole('dialog').getByLabel('Comment', { exact: true });
  await comment.fill('Explain'); await comment.press('Shift+Enter'); await comment.pressSequentially('this');
  await expect(comment).toHaveValue('Explain\nthis'); await comment.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await lastRequest()).quote.exact).toBe('Hello world.');
});


test('inline title cancellation, blur saving and failed-save recovery preserve user input', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const pencil = page.getByRole('button', { name: 'Edit document name', exact: true });
  const title = page.getByLabel('Document name', { exact: true });
  await pencil.click(); await title.fill('Cancel this'); await title.press('Escape');
  await expect(page).toHaveTitle('First heading'); await expect(pencil).toBeFocused();
  await pencil.click(); await title.fill('Saved on blur');
  await page.getByLabel('Message', { exact: true }).click();
  await expect(page).toHaveTitle('Saved on blur');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await page.route('**/api/documents/*/title', route => route.fulfill({ status: 503, json: { error: 'Save failed' } }), { times: 1 });
  await pencil.click(); await title.fill('Retry this name'); await title.press('Enter');
  await expect(title).toHaveValue('Retry this name'); await expect(page.getByRole('alert')).toHaveText('Save failed');
  await title.press('Enter'); await expect(page).toHaveTitle('Retry this name'); await expect(pencil).toBeFocused();
});

test('thread creation retry and conversation scroll survive switching', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Long answer please'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest(); await answer('A detailed explanation.\n'.repeat(100));
  const log = page.getByRole('log');
  await expect(log).toContainText('A detailed explanation.');
  await log.evaluate(el => { el.scrollTop = 230; el.dispatchEvent(new Event('scroll')); });
  const position = await log.evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const before = Object.keys((await state()).threads).length;
  await page.route('**/api/threads', async route => { await route.fetch(); await route.fulfill({ status: 503, json: { error: 'Response lost' } }); }, { times: 1 });
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Response lost');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(message).toBeVisible();
  expect(Object.keys((await state()).threads)).toHaveLength(before + 1);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(position);
});

test('a delayed send preserves a newer draft after leaving and reopening its thread', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  let release = () => {}, accepted = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { accepted = resolve; });
  await page.route('**/api/questions', async route => {
    const response = await route.fetch(); accepted(); await held; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await message.fill('First question'); await message.press('Enter'); await saved;
    const request = await lastRequest();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.locator(`[data-thread-id="${request.threadId}"]`).click();
    await message.fill('Keep this newer draft');
    const response = page.waitForResponse('**/api/questions'); release(); await (await response).finished();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.locator(`[data-thread-id="${request.threadId}"]`).click();
    await expect(message).toHaveValue('Keep this newer draft');
    expect(Object.keys((await state()).requests)).toHaveLength(1);
  } finally { release(); }
});

test('a delayed title save leaves focus in the message composer', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  const title = page.getByLabel('Document name', { exact: true });
  let release = () => {}, accepted = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { accepted = resolve; });
  await page.route('**/api/documents/*/title', async route => {
    const response = await route.fetch(); accepted(); await held; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Edit document name' }).click();
    await title.fill('Saved title'); await title.press('Enter'); await saved;
    await message.fill('Continue this message');
    const response = page.waitForResponse('**/api/documents/*/title'); release(); await (await response).finished();
    await expect(title).toHaveCount(0);
    await expect(message).toBeFocused(); await expect(message).toHaveValue('Continue this message');
  } finally { release(); }
});

test('a newer title committed on blur is saved after the pending title request', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const title = page.getByLabel('Document name', { exact: true });
  let release = () => {}, accepted = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { accepted = resolve; });
  await page.route('**/api/documents/*/title', async route => {
    const response = await route.fetch(); accepted(); await held; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Edit document name' }).click();
    await title.fill('First title'); await title.press('Enter'); await saved;
    await title.fill('Latest title'); await page.getByLabel('Message', { exact: true }).click();
    const response = page.waitForResponse('**/api/documents/*/title'); release(); await (await response).finished();
    await expect(page).toHaveTitle('Latest title');
    await expect(title).toHaveCount(0); await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
    expect((await state()).documents[doc.id].title).toBe('Latest title');
  } finally { release(); }
});

test('a delayed create response preserves messages already received through live updates', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  let release = () => {}, accepted = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { accepted = resolve; });
  let threadId = '';
  await page.route('**/api/threads', async route => {
    const response = await route.fetch(); threadId = (await response.json()).id;
    accepted(); await held; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'New conversation' }).click(); await saved;
    await page.locator(`[data-thread-id="${threadId}"]`).click();
    const message = page.getByLabel('Message', { exact: true });
    await message.fill('Sent before create response'); await message.press('Enter'); await expect(message).toHaveValue('');
    await expect(page.getByRole('log')).toContainText('Sent before create response');
    const response = page.waitForResponse('**/api/threads'); release(); await (await response).finished();
    await expect(page.getByRole('log')).toContainText('Sent before create response');
  } finally { release(); }
});

test('one header status follows native activity across documents without repeating queue messages', async ({ page }) => {
  const doc = await f.register(), other = await f.register('other.md');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const status = page.getByRole('status', { name: 'Agent status', exact: true });
  const signal = (event: string) => f.agent('/agent/lifecycle', { ownerKey: `claude-${f.owner.sessionId}`, event });
  await expect(status).toHaveText('Claude · Unknown');
  const dot = status.locator('.agent-dot');
  const indicator = status.locator('.agent-indicator');
  await indicator.hover();
  await expect(page.getByText('Status: Unknown', { exact: true })).toBeVisible();
  await expect(page.getByText('Status: Unknown', { exact: true })).toHaveText('Status: Unknown');
  await page.mouse.move(0, 0);
  await expect(page.getByText('Status: Unknown', { exact: true })).toBeHidden();
  await indicator.focus();
  await expect(page.getByText('Status: Unknown', { exact: true })).toBeVisible();
  await indicator.press('Escape');
  await expect(page.getByText('Status: Unknown', { exact: true })).toBeHidden();
  await indicator.press('Tab');
  await expect(dot).toHaveAttribute('data-activity', 'unknown');
  await signal('agent-busy'); await expect(status).toHaveText('Claude · Busy');
  await expect(dot).toHaveAttribute('data-activity', 'busy');
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('First question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest();
  await message.fill('Second question'); await message.press('Enter'); await expect(message).toHaveValue('');
  await expect(status).toHaveText('Claude · Busy · 2 queued');
  await expect(page.locator('#threads')).not.toContainText('Queued; waiting for agent.');
  await f.agent(`/agent/requests/${first.id}/claim`, {});
  await expect(status).toHaveText('Claude · Busy · 1 queued');
  await signal('compaction-started'); await expect(status).toHaveText('Claude · Compacting · 1 queued');
  await expect(dot).toHaveAttribute('data-activity', 'compacting');
  await expect(dot).not.toHaveCSS('box-shadow', 'none');
  await signal('compaction-completed'); await expect(status).toHaveText('Claude · Busy · 1 queued');
  await page.getByLabel('Documents', { exact: true }).selectOption(other.id);
  await expect(status).toHaveText('Claude · Busy · 1 queued');
  await f.agent('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'First answer' });
  await answer('Second answer');
  await expect(status).toHaveText('Claude · Busy');
  await signal('agent-idle'); await expect(status).toHaveText('Claude · Idle');
  await expect(dot).toHaveAttribute('data-activity', 'idle');
  await signal('agent-waiting'); await expect(status).toHaveText('Claude · Waiting for input');
  await expect(dot).toHaveAttribute('data-activity', 'waiting');
  await signal('agent-disconnected'); await expect(status).toHaveText('Claude · Disconnected');
  await expect(dot).toHaveAttribute('data-activity', 'disconnected');
});

test('conversation messages show their own queued and working status until answered', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('First question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest();
  await message.fill('Follow-up question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const second = await lastRequest();
  const firstStatus = page.locator('.message.user').filter({ hasText: 'First question' }).getByRole('status');
  const secondStatus = page.locator('.message.user').filter({ hasText: 'Follow-up question' }).getByRole('status');
  await expect(firstStatus).toHaveText('Queued');
  await expect(secondStatus).toHaveText('Queued');
  await f.agent(`/agent/requests/${first.id}/claim`, {});
  await expect(firstStatus).toHaveText('Working…');
  await expect(secondStatus).toHaveText('Queued');
  await page.reload();
  await expect(firstStatus).toHaveText('Working…');
  await expect(secondStatus).toHaveText('Queued');
  const markers = await (await f.agent('/agent/streams', { requestId: first.id, documentId: doc.id, threadId: first.threadId })).json();
  await f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId: 'status-reply', turnId: 'status-turn', index: 0, delta: markers.prefix + 'First answer', final: false });
  await expect(page.getByRole('log')).toContainText('First answer');
  await expect(firstStatus).toHaveCount(0);
  await expect(secondStatus).toHaveText('Queued');
  await page.reload();
  await expect(firstStatus).toHaveCount(0);
  await expect(secondStatus).toHaveText('Queued');
  await f.agent('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'First answer' });
  await expect(page.getByRole('log')).toContainText('First answer');
  await expect(firstStatus).toHaveCount(0);
  await expect(secondStatus).toHaveText('Queued');
  await f.agent(`/agent/requests/${second.id}/claim`, {});
  await expect(secondStatus).toHaveText('Working…');
  await f.agent('/agent/replies', { requestId: second.id, documentId: doc.id, threadId: second.threadId, text: 'Second answer' });
  await expect(page.getByRole('log')).toContainText('Second answer');
  await expect(page.getByRole('log').getByRole('status')).toHaveCount(0);
});

test('thread previews show unread dots and active-request spinners independently', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('First question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest();
  await message.fill('Follow-up question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const second = await lastRequest();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const row = page.locator(`[data-thread-id="${first.threadId}"]`);
  const unread = row.getByLabel('Unread reply', { exact: true });
  const progress = row.getByLabel('In progress', { exact: true });
  const queued = row.getByLabel('Queued', { exact: true });
  await expect(progress).toHaveCount(0); await expect(unread).toHaveCount(0); await expect(queued).toBeVisible();
  await f.agent(`/agent/requests/${first.id}/claim`, {});
  await expect(progress).toBeVisible(); await expect(unread).toHaveCount(0); await expect(queued).toHaveCount(0);
  await f.agent('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'First answer' });
  await expect(unread).toBeVisible(); await expect(progress).toHaveCount(0); await expect(queued).toBeVisible();
  await f.agent(`/agent/requests/${second.id}/claim`, {});
  await expect(progress).toBeVisible(); await expect(unread).toBeVisible();
  await expect(row.locator('.preview-line').getByLabel('Unread reply')).toBeVisible();
  await expect(row.locator('.preview-line').getByLabel('In progress')).toBeVisible();
  await page.reload(); await expect(unread).toBeVisible(); await expect(progress).toBeVisible();
  await row.click(); await expect(page.getByRole('log')).toContainText('First answer');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(unread).toHaveCount(0); await expect(progress).toBeVisible();
  await page.reload(); await expect(unread).toHaveCount(0);
  await f.agent('/agent/replies', { requestId: second.id, documentId: doc.id, threadId: second.threadId, text: 'Second answer' });
  await expect(unread).toBeVisible(); await expect(progress).toHaveCount(0);
  await row.click(); await expect(page.getByRole('log')).toContainText('Second answer');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(unread).toHaveCount(0);
});

test('read replies persist independently across document tabs', async ({ page, context }) => {
  const a = await f.register(), b = await f.register('b.md', '# Second document');
  const other = await context.newPage();
  await page.goto(`${f.url}/?document=${a.id}`);
  await other.goto(`${f.url}/?document=${b.id}`);
  for (const tab of [page, other]) {
    await tab.bringToFront();
    const message = tab.getByLabel('Message', { exact: true });
    await message.fill('Question'); await message.press('Enter'); await expect(message).toHaveValue('');
    await answer('Read this reply');
    await expect(tab.getByRole('log')).toContainText('Read this reply');
    await tab.getByRole('button', { name: 'Threads', exact: true }).click();
    await expect(tab.getByLabel('Unread reply', { exact: true })).toHaveCount(0);
  }
  for (const tab of [page, other]) {
    await tab.reload();
    await expect(tab.locator('.thread-row')).toHaveCount(1);
    await expect(tab.getByLabel('Unread reply', { exact: true })).toHaveCount(0);
  }
  await other.close();
});

test('clicking away from the quick menu clears its temporary selection', async ({ page }) => {
  const doc = await f.register('a.md', '# Click away\n\nFirst passage.\n\nRoom between passages.\n\nSecond passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('First passage.');
  const comment = page.getByRole('button', { name: 'Comment', exact: true });
  await select(page, 'First passage.');
  await expect(comment).toBeVisible();
  await page.locator('#document').dispatchEvent('mousedown', { detail: 2 });
  await expect(comment).toBeVisible();
  await page.getByRole('button', { name: 'Edit document name' }).click();
  await expect(comment).toHaveCount(0);
  await expect(page.locator('#document mark[data-pending]')).toHaveCount(0);
  await expect(page.getByLabel('Document name', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('document')!.contains(window.getSelection()?.anchorNode ?? null))).toBe(false);
  await select(page, 'First passage.');
  await expect(comment).toBeVisible();
  await page.locator('#document h1').click();
  await expect(comment).toHaveCount(0);
  await select(page, 'Second passage.');
  await comment.click();
  await expect(page.getByTestId('selection-preview')).toHaveText('Second passage.');
  await page.getByLabel('Comment', { exact: true }).fill('Saved passage question');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Saved passage question');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await select(page, 'First passage.');
  await expect(comment).toBeVisible();
  await page.locator('#document mark[role=button]').click();
  await expect(page.getByRole('log')).toContainText('Saved passage question');
});

test('real drags can partially overlap the previous pending selection', async ({ page }) => {
  const doc = await f.register('a.md', '# Drag selection\n\nAlpha bravo charlie delta echo foxtrot golf.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('Alpha bravo');
  async function drag(exact: string, reverse = false) {
    const points = await page.evaluate(exact => {
      const article = document.getElementById('document')!;
      const start = article.textContent!.indexOf(exact), end = start + exact.length;
      function point(offset: number) {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        let at = 0, node;
        while ((node = walker.nextNode())) {
          const length = node.textContent!.length;
          if (at + length > offset) {
            const range = document.createRange();
            range.setStart(node, offset - at); range.setEnd(node, offset - at + 1);
            const rect = range.getBoundingClientRect();
            return { x: rect.left, y: rect.top + rect.height / 2 };
          }
          at += length;
        }
        throw new Error('Missing offset');
      }
      return [point(start), point(end)];
    }, exact);
    if (reverse) points.reverse();
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
    await expect(page.locator('#document mark[data-pending]')).toHaveText(exact);
  }
  await drag('bravo charlie delta');
  await drag('charlie delta echo');
  await drag('bravo charlie', true);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByTestId('selection-preview')).toHaveText('bravo charlie');
  await page.getByLabel('Comment', { exact: true }).fill('Keep this overlapping draft');
  await drag('charlie delta echo');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('');
  await drag('bravo charlie', true);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep this overlapping draft');
});

test('rich Markdown renders Plannotator code, callouts, tables, math and diagrams safely', async ({ page }) => {
  test.setTimeout(60000);
  const doc = await f.register('rich.md', `# Rich document

> [!NOTE]
> Keep this **important** detail.

:::warning
Check the result.
:::

| Name | Result |
| --- | --- |
| Parser | Ready |

- [x] Checked task
- [ ] Pending task

Inline math $x^2$ and a display formula:

$$
\\frac{a}{b}
$$

\`\`\`typescript
const answer = 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Read] --> B[Ask]
\`\`\`

\`\`\`dot
digraph G { Read -> Ask }
\`\`\`

<details><summary>More detail</summary><p>Safe HTML text.</p><img src="x" onerror="window.__sidecarDocumentScriptRan=true"></details>

<script>window.__sidecarDocumentScriptRan=true</script>
`);
  await page.goto(`${f.url}/?document=${doc.id}`);
  const article = page.locator('#document');
  await expect(article.locator('[data-alert-kind="note"]')).toContainText('Keep this important detail.');
  await expect(article.locator('[data-directive-kind="warning"]')).toContainText('Check the result.');
  await expect(article.locator('table')).toContainText('Parser');
  await expect(article.locator('.katex')).toHaveCount(2);
  await expect(article.locator('code.language-typescript span').first()).toBeVisible();
  await expect(article.locator('[data-diagram-block="mermaid"] [data-diagram-svg] svg').first()).toBeVisible({ timeout: 30000 });
  await expect(article.locator('[data-diagram-block="graphviz"] [data-diagram-svg] svg').first()).toBeVisible({ timeout: 30000 });
  await article.locator('[data-diagram-block="mermaid"]').getByRole('button', { name: 'Expand diagram' }).click();
  const diagram = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true });
  await expect(diagram).toBeVisible();
  const closeBounds = await diagram.getByRole('button', { name: 'Close', exact: true }).boundingBox();
  const headerBounds = await diagram.locator('[data-diagram-popout-chrome]').boundingBox();
  expect(Math.abs(closeBounds!.y + closeBounds!.height / 2 - headerBounds!.y - headerBounds!.height / 2)).toBeLessThan(1);
  await diagram.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(diagram).toHaveCount(0);
  await expect(article.locator('script, [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => '__sidecarDocumentScriptRan' in window)).toBe(false);
  await select(page, 'important');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByTestId('selection-preview')).toHaveText('important');
});

test('renderer fonts, spacing, images and highlighted code survive reload and file edits', async ({ page }) => {
  const markdown = '# Renderer checks\n\nParagraph with **formatting**.\n\n[Go to code](#code)\n\n## Code\n\n```typescript\nconst selectedValue = 42;\n```\n\n| Key | Value |\n| --- | --- |\n| Cell | Ready |\n\n![Local sample](sample.svg?revision=2#view)\n\n<picture><source srcset="missing.svg" type="image/svg+xml"><img src="sample.svg" alt="Responsive fallback"></picture>\n';
  await writeFile(join(f.directory, 'sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="purple"/></svg>');
  const doc = await f.register('styles.md', markdown);
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.evaluate(() => document.fonts.ready);
  const heading = page.locator('#document h1');
  await expect(heading).toHaveCSS('font-size', '22px');
  await expect(heading).toHaveCSS('margin-bottom', '16px');
  await expect(heading).toHaveCSS('font-family', /Inter Variable/);
  await expect(page.locator('#document > .plannotator-content > p').first()).toHaveCSS('line-height', '24.375px');
  await expect(page.locator('#document code')).toHaveCSS('font-family', /Geist Mono Variable/);
  await expect(page.locator('#document code')).toHaveCSS('padding', '16px');
  const emptyIcon = page.locator('.empty-conversation svg');
  await expect(emptyIcon).toHaveCSS('display', 'inline-block');
  const iconBounds = await emptyIcon.boundingBox(), emptyBounds = await page.locator('.empty-conversation').boundingBox();
  expect(Math.abs(iconBounds!.x + iconBounds!.width / 2 - emptyBounds!.x - emptyBounds!.width / 2)).toBeLessThan(1);
  expect(await page.evaluate(() => document.fonts.check('15px "Inter Variable"') && document.fonts.check('13px "Geist Mono Variable"'))).toBe(true);
  const img = page.getByRole('img', { name: 'Local sample', exact: true });
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => img.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth)).toBe(100);
  const responsive = page.getByRole('img', { name: 'Responsive fallback', exact: true });
  await responsive.scrollIntoViewIfNeeded();
  await expect.poll(() => responsive.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth)).toBe(100);
  await img.click(); await expect(page.getByRole('dialog', { name: 'Local sample' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Local sample' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Go to code' }).click();
  await expect(page.locator('#code')).toBeInViewport();
  await select(page, 'selectedValue');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Explain this value');
  await page.getByLabel('Comment', { exact: true }).press('Enter');
  await expect(page.locator('code .annotation-highlight')).toHaveText('selectedValue');
  await page.reload();
  await expect(page.locator('code.language-typescript span').first()).toBeVisible();
  await expect(page.locator('code .annotation-highlight')).toHaveText('selectedValue');
  await writeFile(join(f.directory, 'styles.md'), markdown.replace('Renderer checks', 'Updated renderer checks'));
  await expect(heading).toHaveText('Updated renderer checks');
  await expect(page.locator('code .annotation-highlight')).toHaveText('selectedValue');
  await select(page, 'Ready');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByTestId('selection-preview')).toHaveText('Ready');
});

test('sidebar toggle preserves drafts and saved annotations reopen their conversation', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const sidebar = page.getByRole('complementary', { name: 'Conversations' });
  await expect(sidebar).toBeVisible();
  await expect(page.locator('#document')).toContainText('world');
  await select(page, 'world');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('What does this mean?');
  await page.getByLabel('Comment', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('What does this mean?');
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep my follow-up draft');
  const before = await page.locator('.canvas').boundingBox();
  await page.getByRole('button', { name: 'Hide conversations', exact: true }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show conversations', exact: true })).toHaveAttribute('aria-expanded', 'false');
  expect((await page.locator('.canvas').boundingBox())!.width).toBeGreaterThan(before!.width);
  await answer('Reply while the pane is hidden');
  const request = await lastRequest();
  expect(await page.evaluate(id => localStorage.getItem(`sidecar-read-reply:${id}`), request.threadId)).toBeNull();
  await page.locator('#document mark').click();
  await expect(sidebar).toBeVisible();
  await expect(message).toHaveValue('Keep my follow-up draft');
  await expect(page.getByRole('log')).toContainText('Reply while the pane is hidden');
  await page.getByRole('button', { name: 'Hide conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  await expect(message).toHaveValue('Keep my follow-up draft');
});

test('Plannotator resize handle saves width and restores it after collapse', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const panel = page.getByRole('complementary', { name: 'Conversations' });
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Keep draft while resizing');
  await select(page, 'world');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Keep the comment beside this passage');
  const before = (await panel.boundingBox())!;
  await page.mouse.move(before.x + 3, before.y + 100);
  await page.mouse.down();
  await page.mouse.move(before.x - 117, before.y + 100, { steps: 12 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(before.width + 120);
  await page.mouse.up();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep draft while resizing');
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep the comment beside this passage');
  await expect.poll(async () => {
    // Position follows the text range; the painted mark also has padding.
    const quote = await page.locator('#document mark[data-pending]').evaluate(mark => {
      const range = document.createRange();
      range.selectNodeContents(mark);
      return range.getBoundingClientRect().toJSON();
    });
    const popup = (await page.getByRole('dialog', { name: 'Comment on selection' }).boundingBox())!;
    return Math.abs(popup.y - quote.y - quote.height - 8);
  }).toBeLessThan(2);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const resized = (await panel.boundingBox())!;
  await page.getByRole('button', { name: 'Hide conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(resized.width);
  await page.reload();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(resized.width);
  const restored = (await panel.boundingBox())!;
  await page.mouse.move(restored.x + 3, restored.y + 100);
  await page.mouse.down();
  await page.mouse.move(restored.x + restored.width - 60, restored.y + 100, { steps: 15 });
  await expect(panel).toBeHidden();
  await page.mouse.up();
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(restored.width);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  const reopened = (await panel.boundingBox())!;
  await page.mouse.click(reopened.x + 3, reopened.y + 100);
  await expect(panel).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  await expect(page.locator('.sidebar-resize')).toBeHidden();
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390);
});


test('hidden streaming replies preserve a reader’s scroll position', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Long answer please'); await message.press('Enter');
  await expect(message).toHaveValue('');
  await answer('A detailed explanation.\n'.repeat(100));
  const log = page.locator('.messages');
  await expect(log).toContainText('A detailed explanation.');
  await message.fill('Continue'); await message.press('Enter');
  await expect(message).toHaveValue('');
  const request = await lastRequest();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  const markers = await (await f.agent('/agent/streams', {
    requestId: request.id, documentId: doc.id, threadId: request.threadId,
  })).json();
  const emit = (index: number, delta: string) => f.agent('/agent/stream-events', {
    ownerKey: `claude-${f.owner.sessionId}`, messageId: 'message', turnId: 'turn', index, delta, final: false,
  });
  await log.evaluate(el => { el.scrollTop = 230; el.dispatchEvent(new Event('scroll')); });
  const position = await log.evaluate(el => el.scrollTop);
  expect(position).toBe(230);
  await page.getByRole('button', { name: 'Hide conversations', exact: true }).click();
  await emit(0, markers.prefix + 'First chunk');
  await expect(log).toContainText('First chunk');
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(position);
  await emit(1, ' and second chunk');
  await expect(log).toContainText('First chunk and second chunk');
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(position);
});

test('resolved annotations disappear, preserve overlapping open threads, and return on reopen', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('world');
  const annotate = async (question: string) => {
    await select(page, 'world');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.getByLabel('Comment', { exact: true }).fill(question);
    await page.getByLabel('Comment', { exact: true }).press('Enter');
    await expect(page.getByRole('log')).toContainText(question);
    return lastRequest();
  };
  const first = await annotate('First passage question');
  await annotate('Second passage question');
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  const marks = page.locator('#document mark');
  await expect(marks).toHaveText('world');
  await marks.click();
  await expect(page.getByRole('log')).toContainText('First passage question');
  await expect(page.getByRole('log')).not.toContainText('Second passage question');
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(marks).toHaveCount(0);
  await expect(page.locator('#document')).toContainText('Hello world.');
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await page.reload();
  await expect(page.getByLabel('Thread status')).toHaveValue('unresolved');
  await expect(marks).toHaveCount(0);
  await page.getByLabel('Thread status').selectOption('resolved');
  await expect(page.locator('[data-thread-id]')).toHaveCount(2);
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await expect(page.getByRole('log')).toContainText('First passage question');
  await page.getByRole('button', { name: 'Reopen thread', exact: true }).click();
  await expect(marks).toHaveText('world');
  await page.reload();
  await expect(marks).toHaveText('world');
});

test('text sizes adjust each pane independently and persist across sessions', async ({ page, context }) => {
  const doc = await f.register('sizes.md', '# Reading sizes\n\nSelected text with `code`.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('Selected text');
  await select(page, 'Selected text');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Explain **this**');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await answer('A **readable reply** with `code`.');
  await expect(page.locator('.message.agent strong')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const headingHeight = (await page.locator('#document h1').boundingBox())!.height;
  const replyHeight = (await page.locator('.message.agent strong').boundingBox())!.height;
  const toolbarHeight = (await page.locator('.topbar').boundingBox())!.height;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const documentSize = page.getByRole('slider', { name: 'Document text size' });
  const conversationSize = page.getByRole('slider', { name: 'Conversation text size' });
  await expect(documentSize).toHaveValue('100');
  await documentSize.fill('150');
  expect((await page.locator('#document h1').boundingBox())!.height / headingHeight).toBeCloseTo(1.5, 1);
  expect((await page.locator('.message.agent strong').boundingBox())!.height).toBeCloseTo(replyHeight, 1);
  await conversationSize.fill('125');
  expect((await page.locator('.message.agent strong').boundingBox())!.height / replyHeight).toBeCloseTo(1.25, 1);
  await expect(page.getByLabel('Message', { exact: true })).toHaveCSS('font-size', '15px');
  expect((await page.locator('.topbar').boundingBox())!.height).toBe(toolbarHeight);
  await conversationSize.press('Escape');
  await expect(documentSize).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await page.locator('#document mark').first().click();
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', (await lastRequest()).threadId);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(documentSize).toHaveValue('150');
  await expect(conversationSize).toHaveValue('125');
  const second = await fixture({ after: fn => cleanup.push(fn) });
  const secondDoc = await second.register();
  await page.goto(`${second.url}/?document=${secondDoc.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(documentSize).toHaveValue('150');
  await expect(conversationSize).toHaveValue('125');
  await page.getByRole('button', { name: 'Reset text sizes' }).click();
  await expect(documentSize).toHaveValue('100');
  await expect(conversationSize).toHaveValue('100');
  await context.addCookies([
    { name: 'sidecar-document-text-size', value: '9999', url: second.url },
    { name: 'sidecar-conversation-text-size', value: 'not-a-number', url: second.url },
  ]);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(documentSize).toHaveValue('100');
  await expect(conversationSize).toHaveValue('100');
});

test('Back discards empty conversations but retains drafts and in-flight messages', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const firstId = await page.locator('#threads').getAttribute('data-active-thread');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByLabel('Thread status')).toBeVisible();
  await expect.poll(async () => (await state()).threads[firstId!]).toBeUndefined();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  const draftId = await page.locator('#threads').getAttribute('data-active-thread');
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator(`[data-thread-id="${draftId}"]`).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/questions', async route => { await gate; await route.continue(); }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await expect(page.locator(`[data-thread-id="${draftId}"]`)).toBeVisible();
    release();
    await expect.poll(async () => (await state()).threads[draftId!].messages.length).toBe(1);
    await page.reload();
    await expect(page.locator(`[data-thread-id="${draftId}"]`)).toBeVisible();
    expect((await state()).threads[firstId!]).toBeUndefined();
  } finally { release(); }
});
