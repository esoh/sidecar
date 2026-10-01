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
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByLabel('Question', { exact: true }).fill('Explain this document');
  await page.getByLabel('Question', { exact: true }).press('Tab'); await page.keyboard.press('Enter');
  await expect(page.locator('#threads').getByText('Explain this document', { exact: true })).toBeVisible();
  expect((await lastRequest()).quote).toBeUndefined();
  await answer('Here is the answer');
  await expect(page.locator('#threads').getByText('Here is the answer', { exact: true })).toBeVisible();
  await page.getByLabel('Follow-up').fill('Clarify further');
  await page.getByRole('button', { name: 'Send follow-up' }).click();
  await expect(page.locator('#threads').getByText('Clarify further', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await answer('A late clarification');
  await expect(page.locator('#threads').getByText('A late clarification', { exact: true })).toBeVisible();
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
  await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#threads').getByText('Explain the selection', { exact: true })).toBeVisible();
  const quote = (await lastRequest()).quote;
  expect(quote.exact).toBe('bold 😀 and code'); expect(quote.end - quote.start).toBe(quote.exact.length);
  expect(await page.locator('#document script').count()).toBe(0);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('h1')!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
  await page.getByLabel('Question', { exact: true }).fill('General after outside selection');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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
  await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#threads').getByText('What does this mean?', { exact: true })).toBeVisible();
  await page.getByLabel('Follow-up').fill('Unfinished draft');
  const replacement = join(f.directory, 'replace.md');
  await writeFile(replacement, '# After\n\n' + repeated + '\n\n' + repeated);
  await rename(replacement, join(f.directory, 'a.md'));
  await expect(page.locator('#document h1')).toHaveText('After');
  await expect(page.locator('#threads').getByText('Passage changed.', { exact: true })).toBeVisible();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await expect(page.getByLabel('Follow-up')).toHaveValue('Unfinished draft');
  await expect(page.getByLabel('Follow-up')).toBeFocused();
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
  await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
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
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('#threads img')).toHaveCount(0);
  expect((await state()).requests[request.id].status).toBe('claimed');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.reload();
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await page.getByLabel('Follow-up').fill('Keep this draft');
  await page.getByLabel('Follow-up').focus();
  await emit(1, ' second.' + markers.suffix, true);
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)> second.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Follow-up')).toBeFocused();
  await expect(page.getByLabel('Follow-up')).toHaveValue('Keep this draft');
  await f.agent('/agent/replies', { ...route, stream: true });
  await expect(page.locator('#threads').getByText('First <img src=x onerror=alert(1)> second.', { exact: true })).toHaveCount(1);
  await expect(page.locator('#threads').getByText('Agent is responding.')).toHaveCount(0);
  expect((await state()).threads[request.threadId].isResolved).toBe(true);
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
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer.getByRole('alert')).toHaveText('Try again');
  await expect(composer.getByLabel('Comment', { exact: true })).toHaveValue('Explain this passage');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
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
  await expect(page.locator(`#thread-${request.threadId}`)).toBeFocused();
  await expect(page.locator('#threads').getByText('This stays in the original conversation.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await highlight.focus(); await page.keyboard.press('Enter');
  await expect(page.locator(`#thread-${request.threadId}`)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
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
  await page.getByLabel('Question', { exact: true }).fill('A general question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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
  await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#threads').getByText('First question', { exact: true })).toBeVisible();
  const first = await lastRequest();
  await page.locator('#document mark').click();
  await expect(page.locator(`#thread-${first.threadId}`)).toBeFocused();
  expect(page.url()).toContain(f.url);
  const second = await (await f.view('/api/questions', { documentId: a.id, text: 'Second question', clientMessageId: 'second', quote: { ...first.quote, exact: 'docs', prefix: first.quote.prefix + 'the ', start: first.quote.start + 4 } })).json();
  await expect(page.locator('#threads').getByText('Second question', { exact: true })).toBeVisible();
  for (const [text, id] of [['First question', first.threadId], ['Second question', second.threadId]]) {
    await page.locator('#document mark').filter({ hasText: /^docs$/ }).click();
    await page.getByRole('button', { name: text, exact: true }).click();
    await expect(page.locator(`#thread-${id}`)).toBeFocused();
  }
  await page.reload();
  await page.locator('#document mark').filter({ hasText: /^docs$/ }).click();
  await expect(page.getByRole('button', { name: 'First question', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Second question', exact: true })).toBeVisible();
});

// The composer must not remove, resize, or replace the in-flow question form.
test('opening and closing a passage composer preserves page layout and the general draft', async ({ page }) => {
  const a = await f.register('a.md', '# Stable layout\n\n' + 'Surrounding paragraph.\n\n'.repeat(15) + 'Selected passage stays in place.');
  for (const width of [900, 375]) {
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`${f.url}/?document=${a.id}`);
    const general = page.getByRole('region', { name: 'New question' });
    await general.getByLabel('Question', { exact: true }).fill('Keep this general draft');
    await page.locator('#document p').last().scrollIntoViewIfNeeded();
    const layout = () => page.evaluate(() => ({
      scrollY,
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
    await expect(general.getByLabel('Question', { exact: true })).toHaveValue('Keep this general draft');
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
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(popup.getByRole('alert')).toHaveText('Response lost; retry');
  await compose('Second passage.');
  await expect(popup.getByRole('textbox')).toHaveValue('Second draft');
  await compose('First passage.');
  await expect(popup.getByRole('textbox')).toHaveValue('First draft');
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(popup).toHaveCount(0);
  expect(Object.keys((await state()).requests)).toHaveLength(1);
  expect((await lastRequest()).quote.exact).toBe('First passage.');
});


test('outside clicks dismiss only empty comments and preserve the clicked focus target', async ({ page }) => {
  const a = await f.register('a.md', '# Outside clicks\n\nSelected passage.');
  await page.goto(`${f.url}/?document=${a.id}`);
  await expect(page.locator('#document')).toContainText('Selected passage.');
  const popup = page.getByRole('dialog', { name: 'Comment on selection' });
  const title = page.getByLabel('Document title');
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
  await expect(title).toBeFocused();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await compose();
  await popup.getByRole('textbox').fill('Keep my draft');
  await title.click();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('textbox')).toHaveValue('Keep my draft');
  await expect(title).toBeFocused();
  await popup.getByRole('textbox').fill(' \n\t ');
  await title.click();
  await expect(popup).toHaveCount(0);
  await expect(title).toBeFocused();
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
  for (const key of ['Control+c', 'Meta+c', 'Alt+c']) await page.keyboard.press(key);
  await article.dispatchEvent('keydown', { key: 'c', isComposing: true });
  await expect(popup).toHaveCount(0);
  const title = page.getByLabel('Document title');
  await title.fill(''); await title.press('c');
  await expect(title).toHaveValue('c');
  const question = page.getByLabel('Question', { exact: true });
  await question.fill(''); await question.press('c');
  await expect(question).toHaveValue('c');
  await expect(popup).toHaveCount(0);
  await article.focus();
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
