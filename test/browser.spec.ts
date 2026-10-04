import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile, rename, unlink, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createState, registerDocument, ownerKey } from '../src/store.ts';
import { fixture } from './support.ts';
let f: Awaited<ReturnType<typeof fixture>>;
let cleanup: (() => Promise<void>)[];
let pageErrors: string[];
test.beforeEach(async ({ page, context }, info) => {
  cleanup = []; pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('Content Security Policy')) pageErrors.push(message.text()); });
  f = await fixture({ after: fn => { cleanup.push(fn); } });
  // Most UI tests exercise delivered chat. Transport tests control the handoff explicitly.
  if (!info.tags.includes('@manual-delivery')) {
    await context.route('**/api/questions', async route => {
      const response = await route.fetch();
      if (response.ok()) await f.agent(`/agent/requests/${(await response.json()).id}/accepted`, {});
      await route.fulfill({ response });
    });
    const view = f.view;
    f.view = async (...args) => {
      const response = await view(...args);
      if (args[0] === '/api/questions' && args[1] && response.ok) await f.agent(`/agent/requests/${(await response.clone().json()).id}/accepted`, {});
      return response;
    };
  }
});
test.afterEach(async () => { try { expect(pageErrors).toEqual([]); } finally { for (const fn of cleanup) await fn(); } });
async function state() { return (await f.view('/api/state')).json(); }
async function lastRequest() { return Object.values<any>((await state()).requests).at(-1)!; }
async function answer(text: string) {
  const request = await lastRequest();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  await f.agent('/agent/replies', { requestId: request.id, documentId: request.documentId, threadId: request.threadId, text });
}

async function proposalReply(page: Page, markdown = '# Retry policy\n\nThe client retries **failed requests** three times.\n') {
  const doc = await f.register('proposal.md', markdown);
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Propose an edit'); await input.press('Enter');
  await expect(input).toHaveValue('');
  await answer('[[sidecar-meta {"highlights":[{"exact":"The client retries failed requests three times.","label":"Retry policy","proposal":{"before":"The client retries **failed requests** three times.","after":"The client retries **temporary failures** up to three times."}}]}]]\nReview [the retry policy](#selection-1).');
  await expect(page.locator('.sidebar .proposal-card')).toBeVisible();
  return doc;
}

test('proposal annotations, reply links and cards open one review without moving the thread; acceptance persists', async ({ page }) => {
  const doc = await proposalReply(page), original = await readFile(doc.path, 'utf8');
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Keep my draft');
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  await page.locator('#document mark').first().click();
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('temporary failures');
  expect(await readFile(doc.path, 'utf8')).toBe(original);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  const link = page.locator('.sidebar .message-bubble').getByRole('link', { name: 'the retry policy' });
  const log = page.getByRole('log'); const before = await log.evaluate(node => node.scrollTop);
  await link.click(); await expect(dialog).toBeVisible(); expect(await log.evaluate(node => node.scrollTop)).toBe(before);
  await page.keyboard.press('Escape'); await expect(link).toBeFocused();
  const review = page.locator('.sidebar .proposal-card').getByRole('button', { name: 'Review change', exact: true });
  await review.focus(); await review.press('Enter'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(dialog).toContainText('Accepted');
  expect(await readFile(doc.path, 'utf8')).toBe('# Retry policy\n\nThe client retries **temporary failures** up to three times.\n');
  await expect(input).toHaveValue('Keep my draft');
  await page.keyboard.press('Escape'); await page.reload();
  await expect(page.locator('.sidebar .proposal-card')).toContainText('Accepted');
  await expect(page.locator('.sidebar .proposal-card').getByRole('button', { name: 'View change' })).toBeVisible();
  await expect(input).toHaveValue('Keep my draft');
});

test('proposal rejection preserves bytes and hidden pinned proposals remain reviewable', async ({ page }) => {
  const doc = await proposalReply(page), original = await readFile(doc.path, 'utf8');
  const selection = page.locator('.sidebar .message-selection');
  await selection.getByRole('button', { name: 'Hide selection', exact: true }).click();
  await expect(page.locator('#document mark')).toHaveCount(0);
  const message = page.locator('.sidebar .message.agent'); await message.hover(); await message.getByRole('button', { name: 'Pin message', exact: true }).click();
  const window = page.locator('.reference-window'); await expect(window).toBeVisible();
  await window.getByRole('button', { name: 'Review change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true }); await expect(dialog).toBeVisible();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(dialog).toContainText('Rejected'); expect(await readFile(doc.path, 'utf8')).toBe(original);
  await page.reload(); await expect(page.locator('.sidebar .proposal-card')).toContainText('Rejected');
});

test('proposal Accept all is per reply and explains overlapping and outdated targets', async ({ page }) => {
  const markdown = 'abcdef' + '.'.repeat(40) + 'valid' + '.'.repeat(40) + 'stale' + '.'.repeat(40) + 'other';
  const doc = await f.register('bulk.md', markdown); await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Propose several'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const highlights = [{ exact: 'abc', proposal: { before: 'abc', after: 'A' } }, { exact: 'bcd', proposal: { before: 'bcd', after: 'B' } }, { exact: 'valid', proposal: { before: 'valid', after: 'accepted' } }, { exact: 'stale', proposal: { before: 'already gone', after: 'new' } }];
  await answer(`[[sidecar-meta ${JSON.stringify({ highlights })}]]\nFirst suggestions.`);
  await input.fill('Another proposal'); await input.press('Enter');
  await expect(input).toHaveValue('');
  await answer('[[sidecar-meta {"highlights":[{"exact":"other","proposal":{"before":"other","after":"untouched"}}]}]]\nLater suggestion.');
  const first = page.locator('.sidebar .message.agent').first(), second = page.locator('.sidebar .message.agent').last();
  await first.getByRole('button', { name: 'Accept all (3)', exact: true }).click();
  await expect(first).toContainText('1 applied'); await expect(first).toContainText('overlap'); await expect(first).toContainText('Outdated');
  await expect(second).toContainText('Pending');
  expect(await readFile(doc.path, 'utf8')).toBe(markdown.replace('valid', 'accepted'));
});

test('proposal source diff exposes formatting-only changes and deletion with safe Markdown rendering', async ({ page }) => {
  const doc = await f.register('format.md', '**Bold**\n\nDelete me\n'); await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Propose formatting'); await input.press('Enter');
  await expect(input).toHaveValue('');
  await answer('[[sidecar-meta {"highlights":[{"exact":"Bold","proposal":{"before":"**Bold**","after":"_Bold_"}},{"exact":"Delete me","proposal":{"before":"Delete me","after":""}}]}]]\nTwo changes.');
  await page.locator('.sidebar .proposal-card').first().getByRole('button', { name: 'Review change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  await expect(dialog.locator('details')).toHaveAttribute('open', '');
  await expect(dialog).toContainText('**Bold**'); await expect(dialog).toContainText('_Bold_');
  await expect(dialog.locator('.proposal-before')).toContainText('−'); await expect(dialog.locator('.proposal-after')).toContainText('+');
  await page.keyboard.press('Escape'); await page.locator('.sidebar .proposal-card').last().getByRole('button', { name: 'Review change' }).click();
  await expect(dialog).toContainText('Remove this passage'); await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(dialog).toContainText('Accepted');
  expect(await readFile(doc.path, 'utf8')).toBe('**Bold**\n\n\n');
  await page.keyboard.press('Escape'); await input.fill('Suggest HTML'); await input.press('Enter');
  await expect(input).toHaveValue('');
  await answer('[[sidecar-meta {"highlights":[{"exact":"Bold","proposal":{"before":"**Bold**","after":"<script>window.proposalExecuted=true</script><a href=\\"javascript:alert(1)\\">click</a>"}}]}]]\nUnsafe source is text.');
  await page.locator('.sidebar .proposal-card').last().getByRole('button', { name: 'Review change' }).click();
  await expect(dialog.locator('script')).toHaveCount(0); await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'proposalExecuted' in window)).toBe(false);
});

test('proposal review respects original-view read-only mode and keeps within a resized document viewport', async ({ page }) => {
  await proposalReply(page, '# Retry policy\n\nThe client retries **failed requests** three times.\n\n' + 'More context.\n\n'.repeat(60));
  const card = page.locator('.sidebar .proposal-card'), dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  await card.getByRole('button', { name: 'Review change' }).click();
  await page.setViewportSize({ width: 950, height: 650 });
  await expect.poll(async () => { const box = await dialog.boundingBox(), canvas = await page.locator('main.canvas').boundingBox(); return !!box && !!canvas && box.x >= canvas.x && box.x + box.width <= canvas.x + canvas.width + 1 && box.y >= canvas.y && box.y + box.height <= 651; }).toBe(true);
  await dialog.getByRole('button', { name: 'View original document', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Return to current', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Accept', exact: true })).toBeEnabled();
  await page.locator('main.canvas').evaluate(node => { node.scrollTop = 150; });
  await expect.poll(async () => (await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(48);
  // The resize handle is an outside click; reopening must use its new canvas bounds.
  const panel = (await page.locator('.sidebar').boundingBox())!;
  await page.mouse.move(panel.x + 3, panel.y + 100); await page.mouse.down();
  await page.mouse.move(panel.x + 83, panel.y + 100, { steps: 5 }); await page.mouse.up();
  await card.getByRole('button', { name: 'Review change' }).click();
  await expect.poll(async () => { const box = (await dialog.boundingBox())!, canvas = (await page.locator('main.canvas').boundingBox())!; return box.x + box.width <= canvas.x + canvas.width; }).toBe(true);
  await page.locator('.brand').click(); await expect(dialog).toBeHidden();
});

test('proposal decisions remain retryable after a save error and resolving a thread does not decide them', async ({ page }) => {
  const doc = await proposalReply(page), original = await readFile(doc.path, 'utf8'), request = await lastRequest();
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await page.locator(`[data-thread-id="${request.threadId}"]`).click();
  await page.locator('.sidebar .proposal-card').getByRole('button', { name: 'Review change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  await expect(dialog).toContainText('Pending'); await expect(page.locator('#document mark')).toHaveCount(0);
  await page.route('**/api/proposals/*/decision', route => route.fulfill({ status: 409, json: { error: 'The file changed during preparation. Try again.' } }), { times: 1 });
  await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Try again');
  expect(await readFile(doc.path, 'utf8')).toBe(original);
  await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(dialog).toContainText('Accepted'); await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect((await state()).threads[request.threadId].isResolved).toBe(true);
});

test('proposal source-unavailable diagnostics have no acceptance or original-document action', async ({ page }) => {
  const markdown = '# Temporarily missing\n\nOriginal sentence.\n', doc = await f.register('missing-proposal.md', markdown);
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Propose'); await input.press('Enter'); await expect(input).toHaveValue('');
  await unlink(doc.path);
  await answer('[[sidecar-meta {"highlights":[{"exact":"Original sentence.","proposal":{"before":"Original sentence.","after":"Revised sentence."}}]}]]\nA suggestion.');
  await writeFile(doc.path, markdown);
  await page.locator('.sidebar .proposal-card').getByRole('button', { name: 'View change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true });
  await expect(dialog).toContainText('could not be read');
  await expect(dialog.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'View original document', exact: true })).toHaveCount(0);
  expect(await readFile(doc.path, 'utf8')).toBe(markdown);
});

test('proposal diagnostics and ambiguous source stay non-actionable after navigation clarification', async ({ page }) => {
  const doc = await f.register('ambiguous-proposals.md', '# Same\n\nSame\n'); await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true }); await input.fill('Propose'); await input.press('Enter');
  await expect(input).toHaveValue('');
  await answer('[[sidecar-meta {"highlights":[{"exact":"Same","proposal":{"before":"Same","after":"New"}},{"exact":"Same","proposal":{"before":"","after":"Invalid"}}]}]]\nCheck these.');
  await expect(page.locator('.sidebar')).toContainText('This proposed change could not be prepared.');
  const first = page.locator('.sidebar .message-selection').first();
  await first.getByRole('button', { name: 'Choose passage' }).click();
  await page.getByRole('button', { name: 'Use passage 1', exact: true }).click();
  await first.getByRole('button', { name: 'View change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Proposed change', exact: true }); await expect(dialog).toContainText('Outdated');
  await expect(dialog.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
});

test('the agent popover resets idle mismatches without losing output or a draft', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Explain'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const request = await lastRequest();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const key = ownerKey(f.owner);
  await f.agent('/agent/stream-events', { ownerKey: key, turnId: 'old-turn', messageId: 'partial', index: 0, delta: prepared.stream.prefix + 'Partial answer', final: false });
  await f.agent('/agent/lifecycle', { ownerKey: key, event: 'agent-idle' });
  await input.fill('Keep this draft');
  await page.getByRole('button', { name: 'Claude session details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
  await page.screenshot({ path: '/private/tmp/sidecar-reset-popover.png' });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resetting…' })).toBeDisabled();
  expect((await state()).requests[request.id].status).toBe('claimed');
  const poll = await (await f.agent('/agent/control', { ownerKey: key, event: 'poll', turnId: 'idle' })).json();
  await f.agent('/agent/control', { ownerKey: key, event: 'reset-idle', resetId: poll.reset.id, turnId: 'idle' });
  await expect(page.getByText('Reset complete.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('log')).toContainText('Partial answer');
  await expect(page.getByRole('log')).toContainText('Stopped');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await page.reload();
  await expect(page.getByRole('log')).toContainText('Partial answer');
});

test('queued previews wait for batch delivery and keep selections, order and drafts', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  const log = page.getByRole('log');
  await expect(page.locator('#document')).toContainText('Hello world.');
  await select(page, 'Hello world.');
  await input.fill('Explain **this passage**'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const first = await lastRequest();
  await input.fill('And this follow-up'); await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(queue).toContainText('Queued · 2');
  await expect(queue.getByRole('listitem')).toHaveText(['Explain this passage', 'And this follow-up']);
  await expect(log.locator('.message.user')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Show queued selection' })).toHaveCount(1);
  const prepared = await (await f.agent(`/agent/requests/${first.id}/prepare`, {})).json();
  await expect(queue.getByRole('listitem')).toHaveCount(2);
  await input.fill('Arrived after the batch'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const later = await lastRequest();
  await input.fill('Keep this draft'); await page.reload();
  await expect(queue).toContainText('Queued · 3');
  await expect(log.locator('.message.user')).toHaveCount(0);
  await f.agent(`/agent/requests/${first.id}/accepted`, {});
  await expect(queue.getByRole('listitem')).toHaveText(['Arrived after the batch']);
  await expect(log.locator('.message.user .message-bubble')).toHaveText(['Explain this passage', 'And this follow-up']);
  await expect(log.locator('.message-selection')).toContainText('Hello world.');
  await expect(log.locator('.message-status')).toHaveText('Working…');
  await f.agent('/agent/stream-events', { ownerKey: ownerKey(f.owner), turnId: 'queue-test', messageId: 'final', index: 0, delta: prepared.stream.prefix + 'First answer' + prepared.stream.suffix, final: true });
  await f.agent(`/agent/requests/${later.id}/prepare`, {});
  await expect(queue).toBeVisible();
  await f.agent(`/agent/requests/${later.id}/accepted`, {});
  await expect(queue).toHaveCount(0);
  await expect(log.locator('.message-bubble')).toHaveText(['Explain this passage', 'And this follow-up', 'First answer', 'Arrived after the batch']);
  await expect(input).toHaveValue('Keep this draft');
  await page.reload();
  await expect(queue).toHaveCount(0);
  await expect(log.locator('.message.user')).toHaveCount(3);
});

test('queued previews survive uncertain delivery and agent claims persist receipt', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Waiting for receipt'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const request = await lastRequest();
  await f.agent(`/agent/requests/${request.id}/prepare`, {});
  await f.reopen();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  await expect(queue).toContainText('Waiting for receipt');
  await expect(page.getByRole('log').locator('.message.user')).toHaveCount(0);
  await f.agent(`/agent/requests/${request.id}/claim`, { resume: true });
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('Waiting for receipt');
  await f.reopen();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('Waiting for receipt');
});

test('matching output moves a queued batch into chat even when its acknowledgement is missing', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Inspect this'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const request = await lastRequest();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  const emit = (messageId: string, delta: string) => f.agent('/agent/stream-events', { ownerKey: ownerKey(f.owner), turnId: 'receipt-test', messageId, index: 0, delta, final: true });
  await emit('unrelated', 'An unrelated update');
  await expect(queue).toBeVisible();
  await emit('progress', prepared.stream.progress.prefix + 'Inspecting now' + prepared.stream.progress.suffix);
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole('log').locator('.message-bubble')).toHaveText(['Inspect this', 'Inspecting now']);
  expect((await state()).requests[request.id].acceptedAt).toEqual(expect.any(Number));
  await f.reopen();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(queue).toHaveCount(0);
  await expect(page.getByRole('log').locator('.message-bubble')).toHaveText(['Inspect this', 'Inspecting now']);
});

test('unfinished replies show bounded recovery and a Retry button without disturbing the draft', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Explain'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const request = await lastRequest();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const control = (event: string, turnId: string) => f.agent('/agent/control', { ownerKey: ownerKey(f.owner), event, turnId, marker: prepared.stream.prefix });
  await input.fill('Keep my draft');
  await control('started', 'first'); await control('completed', 'first');
  await expect(page.getByText('Reply wasn’t saved; recovering…', { exact: true })).toBeVisible();
  const recovery = (await state()).requests[request.id].replyRecovery;
  await f.agent(`/agent/requests/${request.id}/recover`, { recoveryId: recovery.id });
  await control('started', 'second'); await control('completed', 'second');
  await expect(page.getByText('Reply couldn’t be saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry saving reply', exact: true }).click();
  await expect(page.getByText('Reply wasn’t saved; recovering…', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep my draft');
  await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Recovered.' });
  await expect(page.locator('.message.agent').getByText('Recovered.', { exact: true })).toBeVisible();
  await expect(page.getByText('Reply wasn’t saved; recovering…', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('Keep my draft');
});

test('a batch shares one Working/Stopped indicator and preserves partial text without interrupting on Enter', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register('stop.md');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Explain'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const request = await lastRequest();
  await input.fill('Also explain the follow-up'); await input.press('Enter');
  await expect(input).toHaveValue('');
  const second = await lastRequest();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  await f.agent(`/agent/requests/${request.id}/accepted`, {});
  await expect(page.locator('.message-status')).toHaveCount(1);
  await expect(page.locator('.message-status')).toHaveText('Working…');
  await expect(page.locator('.messages .message.user')).toHaveCount(2);
  const stop = page.getByRole('button', { name: 'Stop response', exact: true });
  const control = (event: string) => f.agent('/agent/control', { ownerKey: ownerKey(f.owner), event, turnId: 'active-turn' });
  await control('poll');
  await expect(stop).toHaveCount(0);
  await f.agent('/agent/stream-events', { ownerKey: ownerKey(f.owner), turnId: 'active-turn', messageId: 'reply', index: 0, delta: prepared.stream.prefix + 'Partial **answer**', final: false });
  await f.agent('/agent/control', { ownerKey: ownerKey(f.owner), event: 'started', turnId: 'active-turn', marker: prepared.stream.prefix });
  await expect(stop).toBeEnabled();
  await expect(page.locator('.message-status')).toHaveCount(0);
  await input.press('Enter');
  expect((await state()).stream.stopping).toBe(false);
  await input.fill('Follow-up'); await expect(stop).toHaveCount(0);
  await input.fill(''); await control('poll'); await expect(stop).toBeEnabled();
  await stop.click(); await expect(stop).toBeDisabled();
  await expect(page.getByText('Stopping…', { exact: true })).toBeVisible();
  expect((await (await control('poll')).json()).stop).toEqual({ requestId: request.id, turnId: 'active-turn' });
  await control('interrupted');
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
  expect((await state()).requests[second.id].status).toBe('stopped');
  await expect(page.locator('.messages .message.agent')).toContainText('Partial answer');
  await expect(stop).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
});

test('quotes from sent messages, floating windows and the dock keep their source and draft', async ({ page }) => {
  const doc = await f.register('quotes.md');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Explain'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Explain');
  await answer('Alpha **bold** and `code` omega.');
  const request = await lastRequest(), source = (await state()).threads[request.threadId].messages.at(-1);
  const bubble = page.locator('.messages .message.agent .message-bubble');
  const selectMessage = async (selector: string, keyboard = false) => page.locator(selector).evaluate((root, keyboard) => {
    const range = document.createRange(); range.selectNodeContents(root.querySelector('p')!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    root.dispatchEvent(keyboard ? new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }) : new MouseEvent('mouseup', { bubbles: true }));
  }, keyboard);
  await selectMessage('.messages .message.agent .message-bubble');
  await expect(page.locator('.draft-selection')).toContainText('Alpha bold and code omega.');
  await input.fill('Clarify'); await page.reload();
  await expect(input).toHaveValue('Clarify');
  await expect(page.locator('.draft-selection')).toContainText('Alpha bold and code omega.');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Clarify');
  const followup = await lastRequest();
  expect(followup.messageQuote).toEqual({ threadId: request.threadId, messageId: source.id, exact: 'Alpha bold and code omega.' });
  expect(followup.quote).toBeUndefined();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await expect(page.locator('.messages .message-quote')).toContainText('Alpha bold and code omega.');
  await bubble.hover();
  await page.locator('.messages .message.agent').getByRole('button', { name: 'Pin message', exact: true }).click();
  const floating = page.getByRole('dialog', { name: 'Pinned message', exact: true });
  await expect(floating).toBeVisible();
  await selectMessage('[aria-label="Pinned message"] .message-bubble');
  await expect(page.locator('.draft-selection')).toContainText('Alpha bold and code omega.');
  await page.getByRole('button', { name: 'Remove selection', exact: true }).click();
  await expect(page.locator('.draft-selection')).toHaveCount(0);
  await floating.getByRole('button', { name: 'Dock window', exact: true }).click();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await selectMessage('.pinned-dock .message-bubble', true);
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', request.threadId);
  await expect(page.locator('.draft-selection')).toContainText('Alpha bold and code omega.');
  await select(page, 'Hello world.');
  await expect(page.locator('.draft-selection')).toContainText('Hello world.');
  await expect(page.locator('.draft-selection')).not.toContainText('Alpha bold');
  // A hidden conversation must retain its own draft when a different pinned source opens.
  await answer('Follow-up answer.');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await input.fill('Other thread'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Other thread');
  await answer('Separate reply.');
  const other = await lastRequest();
  await selectMessage('.messages .message.agent .message-bubble');
  await input.fill('Keep this quote');
  await page.getByRole('button', { name: 'Hide conversations', exact: true }).click();
  await selectMessage('.pinned-dock .message-bubble');
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', request.threadId);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator(`[data-thread-id="${other.threadId}"]`).click();
  await expect(input).toHaveValue('Keep this quote');
  await expect(page.locator('.draft-selection')).toContainText('Separate reply.');
});

test('pinned references retain selections and dock expansion after the last tab is removed', async ({ page }) => {
  const doc = await f.register('pins.md', '# Pins\n\nA useful passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Find the useful passage');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Find the useful passage');
  await answer('[[sidecar-meta {"highlights":[{"exact":"A useful passage."}]}]]\nRead **this** [passage](#selection-1).');
  const message = page.locator('.messages .message.agent');
  await message.hover();
  await message.getByRole('button', { name: 'Pin message', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Pinned message', exact: true })).toHaveCount(1);
  const pins = page.getByRole('navigation', { name: 'Pinned messages' });
  await expect(pins.getByRole('button', { name: /Read/ })).toHaveCount(1);
  await pins.getByRole('button', { name: 'Pin options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Pin options', exact: true });
  await options.getByRole('button', { name: 'Star', exact: true }).click();
  await options.getByRole('button', { name: 'Violet', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.reload();
  await pins.getByRole('button', { name: 'Pin options', exact: true }).click();
  await expect(options.getByRole('button', { name: 'Star', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(options.getByRole('button', { name: 'Violet', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await options.getByRole('button', { name: 'Letters', exact: true }).click();
  await page.keyboard.press('a');
  await expect(options.getByRole('button', { name: 'A', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('7');
  await expect(options.getByRole('button', { name: '7', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await options.getByRole('button', { name: 'Cyan', exact: true }).click();
  await options.getByRole('button', { name: 'Go to message', exact: true }).press('Enter');
  await expect(options).toBeHidden();
  await expect(message).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Pinned message', exact: true })).toHaveCount(0);
  await pins.getByRole('button', { name: /Read/ }).click();
  const floating = page.getByRole('dialog', { name: 'Pinned message', exact: true });
  await expect(floating).toContainText('A useful passage.');
  await floating.getByRole('button', { name: 'Hide selection', exact: true }).click();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await writeFile(join(f.directory, 'pins.md'), '# Pins\n\nThe document has changed.');
  await expect(floating).toContainText('Passage changed');
  await floating.getByRole('button', { name: 'View original document' }).click();
  await expect(page.getByRole('region', { name: 'Original document', exact: true }).locator('mark')).toHaveText('A useful passage.');
  await page.getByRole('button', { name: 'Return to current' }).press('Enter');
  const beforeResize = (await floating.boundingBox())!;
  const edge = (await floating.locator('.resize-w').boundingBox())!;
  await page.mouse.move(edge.x + 3, edge.y + 40); await page.mouse.down();
  await page.mouse.move(edge.x - 67, edge.y + 40, { steps: 5 }); await page.mouse.up();
  expect((await floating.boundingBox())!.width).toBeGreaterThan(beforeResize.width + 50);
  await floating.getByRole('button', { name: 'Dock window', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('tabpanel')).toBeVisible();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await dock.getByRole('button', { name: 'Go to message', exact: true }).click();
  await expect(page.locator('.messages .message.agent')).toBeFocused();
  await expect(dock.getByRole('tabpanel')).toBeVisible();
  const rememberedHeight = (await dock.boundingBox())!.height;
  expect(rememberedHeight).toBeGreaterThan(140);
  await dock.getByRole('button', { name: 'Move out of dock', exact: true }).click();
  await expect(dock).toBeHidden();
  const title = await floating.locator('.reference-titlebar').boundingBox();
  const canvas = await page.locator('.document-workspace').boundingBox();
  await page.mouse.move(title!.x + 80, title!.y + 18); await page.mouse.down();
  await expect(dock).toContainText('Drop a window here');
  expect((await dock.boundingBox())!.height).toBe(140);
  await page.mouse.move(canvas!.x + 90, canvas!.y + canvas!.height - 200, { steps: 10 });
  await expect(dock).not.toHaveClass(/is-preview/);
  await page.mouse.move(canvas!.x + 90, canvas!.y + canvas!.height - 130, { steps: 10 });
  await expect(dock.getByRole('tabpanel')).toBeVisible();
  await page.mouse.up();
  await expect(floating).toHaveCount(0);
  await expect(dock.getByRole('tabpanel')).toBeVisible();
  expect((await dock.boundingBox())!.height).toBe(rememberedHeight);
  await dock.getByRole('button', { name: 'Close pinned window', exact: true }).click();
  await expect(dock).toBeHidden();
  await expect(pins.getByRole('button', { name: /Read/ })).toHaveCount(1);
  await pins.getByRole('button', { name: 'Pin options', exact: true }).click();
  await options.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(pins).toHaveCount(0);
});

test('message copy formats exclude selection controls and preserve Markdown code and external links', async ({ page, context }) => {
  const doc = await f.register('copy.md', '# Copy\n\nThe passage.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Locate this');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Locate this');
  await answer('[[sidecar-meta {"highlights":[{"exact":"The passage."}]}]]\nRead **this** [passage](#selection-1) and [guide](https://example.com).\n\n`[example](#selection-2)`\n\n    [code example](#selection-3)\n\nSee [reference][ref].\n\n[ref]: #selection-1');
  const reply = page.locator('.messages .message.agent');
  await reply.hover();
  const copy = reply.getByRole('button', { name: 'Copy message', exact: true });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Read **this** passage and [guide](https://example.com).\n\n`[example](#selection-2)`\n\n    [code example](#selection-3)\n\nSee reference.\n\n');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Plain text', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await reply.hover(); await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Read this passage and guide.\n\n[example](#selection-2)\n\n[code example](#selection-3)\n\nSee reference.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Rich text', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await reply.hover(); await copy.click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read())[0].types)).toContain('text/html');
  const html = await page.evaluate(async () => (await (await navigator.clipboard.read())[0].getType('text/html')).text());
  expect(html).toContain('<strong>this</strong>');
  expect(html).toMatch(/href="https:\/\/example\.com\/?"/);
  expect(html).not.toContain('href="#selection');
  expect(html).not.toContain('The passage.');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Rich text', exact: true })).toBeChecked();
});

test('pin list condenses, tabs reorder, and single-window mode keeps the latest opened reference', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  for (const text of ['First question', 'Second question']) {
    await page.getByLabel('Message', { exact: true }).fill(text);
    await page.getByLabel('Message', { exact: true }).press('Enter');
    await expect(page.getByRole('log')).toContainText(text);
    await answer(text === 'First question' ? 'First answer' : 'Second answer');
  }
  const messages = page.locator('.messages .message');
  await expect(messages).toHaveCount(4);
  let releaseState!: () => void;
  const delayedState = new Promise<void>(resolve => { releaseState = resolve; });
  await page.route('**/api/state', async route => { await delayedState; await route.continue(); });
  try {
    for (const message of [messages.nth(0), messages.nth(1)]) {
      await message.hover(); await message.getByRole('button', { name: 'Pin message', exact: true }).click();
    }
  } finally { releaseState(); }
  await expect(page.getByRole('dialog', { name: 'Pinned message', exact: true })).toHaveCount(2);
  await page.unroute('**/api/state');
  while (await page.getByRole('button', { name: 'Close pinned window', exact: true }).count()) await page.getByRole('button', { name: 'Close pinned window', exact: true }).first().click();
  for (const message of [messages.nth(0), messages.nth(1)]) {
    await message.hover(); await message.getByRole('button', { name: 'Unpin message', exact: true }).click();
  }
  for (const message of await messages.all()) {
    await message.hover(); await message.getByRole('button', { name: 'Pin message', exact: true }).click();
    await page.getByRole('button', { name: 'Close pinned window', exact: true }).click();
  }
  const pins = page.getByRole('navigation', { name: 'Pinned messages' });
  await expect(pins.locator('.pinned-message-row')).toHaveCount(2);
  await pins.getByRole('button', { name: '2 more' }).click();
  for (const name of ['First question', 'First answer', 'Second question']) {
    await pins.getByRole('button', { name, exact: true }).click();
    await page.getByRole('dialog', { name: 'Pinned message', exact: true }).getByRole('button', { name: 'Dock window', exact: true }).click();
  }
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('tab')).toHaveText(['First question', 'First answer', 'Second question']);
  const last = await dock.getByRole('tab', { name: 'Second question', exact: true }).boundingBox();
  const first = await dock.getByRole('tab').first().boundingBox();
  await page.mouse.move(last!.x + 20, last!.y + 15); await page.mouse.down();
  await page.mouse.move(first!.x + 2, first!.y + 15, { steps: 10 });
  await expect(page.locator('.dock-drag-preview')).toBeVisible();
  await page.mouse.up();
  await expect(dock.getByRole('tab')).toHaveText(['Second question', 'First question', 'First answer']);
  const reordered = dock.getByRole('tab', { name: 'Second question', exact: true });
  await reordered.focus(); await page.keyboard.press('Alt+ArrowRight');
  await expect(reordered).toBeFocused();
  await expect(dock.getByRole('tab')).toHaveText(['First question', 'Second question', 'First answer']);
  await dock.getByRole('tab', { name: 'First answer', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'One at a time', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(dock.getByRole('tab')).toHaveText(['Second question']);
  await expect(pins.locator('.pinned-message-row')).toHaveCount(4);
  await pins.getByRole('button', { name: 'First question', exact: true }).click();
  await expect(dock).toBeHidden();
  const floating = page.getByRole('dialog', { name: 'Pinned message', exact: true });
  await expect(floating).toHaveCount(1);
  await expect(floating).toContainText('First question');
  await page.setViewportSize({ width: 360, height: 420 });
  await expect.poll(async () => {
    const rect = await floating.boundingBox();
    return !!rect && rect.x === 0 && rect.width === 360 && rect.y >= 0 && rect.y + rect.height <= 420;
  }).toBe(true);
});

test('collapsed dock accepts only its bar, previews insertion, and stays collapsed after a drop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Question');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Question');
  await answer('Answer');
  await expect(page.locator('.messages .message')).toHaveCount(2);
  for (const message of await page.locator('.messages .message').all()) {
    await message.hover(); await message.getByRole('button', { name: 'Pin message', exact: true }).click();
    await page.getByRole('button', { name: 'Close pinned window', exact: true }).click();
  }
  const pins = page.getByRole('navigation', { name: 'Pinned messages' });
  await pins.getByRole('button', { name: 'Question', exact: true }).click();
  await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('button', { name: 'Expand dock', exact: true })).toHaveText('1 window');
  await pins.getByRole('button', { name: 'Answer', exact: true }).click();
  const floating = page.getByRole('dialog', { name: 'Pinned message', exact: true });
  await floating.getByRole('button', { name: 'Dock window', exact: true }).click();
  await expect(dock.getByRole('tabpanel')).toHaveText('Answer');
  await expect(dock.getByRole('tab', { name: 'Answer', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dock.getByRole('button', { name: 'Move out of dock', exact: true }).last().click();
  await dock.getByRole('button', { name: 'Collapse dock', exact: true }).click();
  const dockBox = (await dock.boundingBox())!;
  async function startDrag() {
    const title = (await floating.locator('.reference-titlebar').boundingBox())!;
    await page.mouse.move(title.x + 60, title.y + 18); await page.mouse.down();
  }
  await startDrag();
  await page.mouse.move(dockBox.x + 10, dockBox.y - 60, { steps: 10 });
  await expect(dock.getByRole('tabpanel')).toHaveCount(0);
  await page.mouse.up(); await expect(floating).toBeVisible();
  await startDrag();
  await page.mouse.move(dockBox.x + 10, dockBox.y + 18, { steps: 10 });
  await expect(dock.getByRole('tabpanel')).toBeVisible();
  await expect(page.locator('.dock-insertion')).toBeVisible();
  await page.mouse.move(dockBox.x + 10, dockBox.y - 60, { steps: 10 });
  await expect(dock.getByRole('tabpanel')).toHaveCount(0);
  await page.mouse.move(dockBox.x + 10, dockBox.y + 18, { steps: 10 });
  await page.mouse.up();
  await expect(floating).toHaveCount(0);
  await expect(dock.getByRole('button', { name: 'Expand dock', exact: true })).toHaveText('2 windows');
  await dock.getByRole('button', { name: 'Expand dock', exact: true }).click();
  await expect(dock.getByRole('tab')).toHaveText(['Answer', 'Question']);
  const beforeResize = (await dock.boundingBox())!;
  const resize = (await dock.getByRole('separator').boundingBox())!;
  await page.mouse.move(resize.x + 80, resize.y + 3); await page.mouse.down();
  await page.mouse.move(resize.x + 80, resize.y - 77, { steps: 5 }); await page.mouse.up();
  expect((await dock.boundingBox())!.height).toBeGreaterThan(beforeResize.height + 60);
});
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

test('each agent selection has a persistent eye, stable reply link, and independent historical view', async ({ page }) => {
  const doc = await f.register('highlights.md', '# Landmarks\n\nFirst **passage**. Second passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Please identify both passages.');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Please identify both passages.');
  await answer('[[sidecar-meta {"threadTitle":"Document landmarks","highlights":[{"exact":"First passage.","label":"First"},{"exact":"Second passage."}]}]]\nSee [first](#selection-1) and [second](#selection-2).');
  const badges = page.locator('.message-selection');
  await expect(badges).toHaveCount(2);
  await expect(badges.first()).toContainText('First');
  await expect.poll(() => page.locator('#document mark').allTextContents().then(t => t.join(''))).toBe('First passage.Second passage.');
  await badges.first().getByRole('button', { name: 'Hide selection', exact: true }).click();
  await expect(badges.first().getByRole('button', { name: 'Show selection', exact: true })).toBeVisible();
  await expect(page.locator('#document mark')).toHaveText('Second passage.');
  await page.getByRole('log').getByRole('link', { name: 'first', exact: true }).click();
  await expect(badges.first()).toHaveAttribute('data-active', 'true');
  await expect(page.locator('#document mark')).toHaveText('Second passage.');
  await page.reload();
  await expect(badges.first().getByRole('button', { name: 'Show selection', exact: true })).toBeVisible();
  await expect(page.locator('#document mark')).toHaveText('Second passage.');
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await page.locator('[data-thread-id]').click();
  await page.getByRole('button', { name: 'Reopen thread', exact: true }).click();
  await expect(badges.getByRole('button', { name: 'Show selection', exact: true })).toHaveCount(2);
  await expect(page.locator('#document mark')).toHaveCount(0);
  await page.getByRole('button', { name: 'Thread actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show all selections', exact: true }).click();
  await expect(badges.getByRole('button', { name: 'Hide selection', exact: true })).toHaveCount(2);
  await page.getByRole('log').getByRole('link', { name: 'second', exact: true }).click();
  await expect(badges.last()).toHaveAttribute('data-active', 'true');
  await expect(page.locator('#document mark[data-active]')).toHaveText('Second passage.');
  await page.getByRole('button', { name: 'Thread actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide all selections', exact: true }).click();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Thread actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show all selections', exact: true }).click();
  await expect(badges.getByRole('button', { name: 'Hide selection', exact: true })).toHaveCount(2);
  await badges.last().getByRole('button', { name: 'Hide selection', exact: true }).click();
  await writeFile(join(f.directory, 'highlights.md'), '# Landmarks\n\nFirst **passage**. Replacement passage.');
  await expect(badges.last()).toContainText('Passage changed');
  await badges.last().getByRole('button', { name: 'View original document' }).click();
  await expect(page.getByRole('region', { name: 'Original document', exact: true }).locator('mark')).toHaveText('Second passage.');
  await badges.last().getByRole('button', { name: 'Show selection', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Original document', exact: true }).locator('mark')).toHaveText('Second passage.');
  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(page.locator('#document')).toContainText('Replacement passage.');
  await expect(page.locator('#document mark').filter({ hasText: 'Second' })).toHaveCount(0);
});

test('ambiguous highlights can be clarified in their original revision without changing the document or draft', async ({ page }) => {
  const markdown = '# Review\n\n## Author Summary\n\nNew introduction.\n\nSee Author Summary.';
  const doc = await f.register('duplicate.md', markdown);
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Where did you edit?'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Where did you edit?');
  await answer('[[sidecar-meta {"highlights":[{"exact":"Author Summary"}]}]]\nUnder [Author Summary](#selection-1).');
  const badge = page.locator('.message-selection');
  await expect(badge).toContainText('Multiple matching passages');
  await expect(badge).not.toContainText('Passage changed');
  await input.fill('Keep this draft');
  await badge.getByRole('button', { name: 'Choose passage' }).click();
  const original = page.getByRole('region', { name: 'Original document', exact: true });
  await expect(original.getByRole('group', { name: 'Choose matching passage' }).getByRole('button')).toHaveCount(2);
  await expect(original.locator('mark')).toHaveCount(0);
  await original.getByRole('button', { name: 'Use passage 1', exact: true }).click();
  await expect(original.locator('h2 mark')).toHaveText('Author Summary');
  await expect(original.getByRole('group', { name: 'Choose matching passage' })).toHaveCount(0);
  await expect(badge).not.toContainText('Multiple matching passages');
  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(page.locator('#document h2 mark')).toHaveText('Author Summary');
  await expect(input).toHaveValue('Keep this draft');
  expect(await readFile(join(f.directory, 'duplicate.md'), 'utf8')).toBe(markdown);
  // Later edits above the passage must use context, not the original offset.
  await writeFile(join(f.directory, 'duplicate.md'), '# Inserted above\n\n' + markdown);
  await expect(page.locator('#document')).toContainText('Inserted above');
  await expect(page.locator('#document h2 mark')).toHaveText('Author Summary');
  await page.reload();
  await expect(page.locator('#document h2 mark')).toHaveText('Author Summary');
  await expect(input).toHaveValue('Keep this draft');
  // The same words elsewhere must not take over a deleted heading's annotation.
  await writeFile(join(f.directory, 'duplicate.md'), '# Review\n\nSee Author Summary.');
  await expect(badge).toContainText('Selection context changed');
  await expect(page.locator('#document mark')).toHaveCount(0);
  await badge.getByRole('button', { name: 'View original document' }).click();
  await expect(original.locator('h2 mark')).toHaveText('Author Summary');
});

test('agent prefix/suffix context disambiguates headings without a repair and missing originals explain the failure', async ({ page }) => {
  const doc = await f.register('context.md', '# Review\n\n## Author Summary\n\nNew introduction.\n\nSee Author Summary.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Point to it'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Point to it');
  await answer('[[sidecar-meta {"highlights":[{"exact":"Author Summary","suffix":"\\nNew introduction."},{"exact":"Never existed"}]}]]\nHere.');
  await expect(page.locator('#document h2 mark')).toHaveText('Author Summary');
  await expect(page.locator('.message-selection').first()).not.toContainText('Multiple matching passages');
  await page.locator('.message-selection').last().getByRole('button', { name: 'View original document' }).click();
  await expect(page.getByRole('region', { name: 'Original document', exact: true })).toContainText('The selection could not be found in this saved version.');
});

test('agent source apostrophes locate rendered smart quotes and retain genuine passage changes', async ({ page }) => {
  const first = "Before admission: the transfer chain must identify the same surviving party and referring CallSessions. The admission's recorded route and session destinations must also agree.";
  const second = "The graph compares the original requested extension or phone number with the admission's recorded dialed address.";
  const third = 'The requested destination can be a ring group or a location.';
  const doc = await f.register('smart-quotes.md', '# Checks\n\n' + first.replace('CallSessions', '`CallSession`s') + '\n\n' + second + '\n\n' + third);
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Highlight these');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Highlight these');
  await answer('[[sidecar-meta ' + JSON.stringify({ highlights: [first, second, third].map(exact => ({ exact })) }) + ']]\nHere are the three passages.');
  await expect(page.locator('.message-selection')).toHaveCount(3);
  await expect(page.getByText('Passage changed', { exact: true })).toHaveCount(0);
  await expect(page.locator('#document mark')).toHaveCount(5); // The code span splits the first passage into three marks.
  await writeFile(join(f.directory, 'smart-quotes.md'), '# Checks\n\nChanged content.');
  await expect(page.getByText('Passage changed', { exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'View original document' }).first().click();
  await expect(page.getByRole('region', { name: 'Original document' }).locator('mark')).toHaveCount(3);
});

test('a message annotation toggle hides mixed selections and shows all hidden selections', async ({ page }) => {
  const doc = await f.register('message-annotations.md', '# Notes\n\nFirst passage. Second passage. Third passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Show me the first two.'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Show me the first two.');
  await answer('[[sidecar-meta {"highlights":[{"exact":"First passage."},{"exact":"Second passage."}]}]]\nThe first two.');
  await input.fill('And the third.'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('And the third.');
  await answer('[[sidecar-meta {"highlights":[{"exact":"Third passage."}]}]]\nThe third.');
  const first = page.getByRole('log').locator('.message.agent').first();
  const second = page.getByRole('log').locator('.message.agent').last();
  await first.hover();
  await expect(first.getByRole('button', { name: 'Hide message annotations', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.message.user').getByRole('button', { name: /message annotations/ })).toHaveCount(0);
  await first.getByRole('button', { name: 'Hide selection', exact: true }).first().click();
  await expect(first.getByRole('button', { name: 'Show selection', exact: true })).toHaveCount(1);
  await first.getByRole('button', { name: 'Hide message annotations', exact: true }).click();
  await expect(first.getByRole('button', { name: 'Show selection', exact: true })).toHaveCount(2);
  await expect(page.locator('#document mark')).toHaveText('Third passage.');
  await page.reload();
  await expect(first.getByRole('button', { name: 'Show message annotations', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await first.getByRole('button', { name: 'Show message annotations', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#document mark')).toHaveText(['First passage.', 'Second passage.', 'Third passage.']);
  await expect(second.getByRole('button', { name: 'Hide message annotations', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('clicking a later agent highlight scrolls its own selection card into view', async ({ page }) => {
  const highlights = Array.from({ length: 20 }, (_, i) => ({ exact: `Passage ${i + 1}.` }));
  const doc = await f.register('many-highlights.md', '# Many highlights\n\n' + highlights.map(h => h.exact).join(' '));
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Highlight these passages.');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Highlight these passages.');
  await answer(`[[sidecar-meta ${JSON.stringify({ highlights })}]]\nDone.`);
  const target = page.locator('.message-selection').last();
  await expect(page.locator('.message-selection')).toHaveCount(20);
  await page.locator('#document mark').filter({ hasText: /^Passage 20\.$/ }).click();
  await expect(target).toHaveAttribute('data-active', 'true');
  await expect.poll(async () => {
    const card = await target.boundingBox(), log = await page.getByRole('log').boundingBox();
    return !!card && !!log && card.y >= log.y && card.y + card.height <= log.y + log.height + 1;
  }).toBe(true);
});

test('inline selection links move the document without scrolling the conversation', async ({ page }) => {
  const highlights = Array.from({ length: 20 }, (_, i) => ({ exact: `Passage ${i + 1}.` }));
  const doc = await f.register('inline-highlights.md', '# Landmarks\n\n' + highlights.map(h => `${h.exact}\n\nContext for this paragraph.`).join('\n\n'));
  await page.goto(`${f.url}/?document=${doc.id}`);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Show me the landmarks.'); await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Show me the landmarks.');
  await answer(`[[sidecar-meta ${JSON.stringify({ highlights })}]]\nSee [tenth](#selection-10) and [first](#selection-1).`);
  const log = page.getByRole('log');
  const link = log.getByRole('link', { name: 'tenth', exact: true });
  await link.scrollIntoViewIfNeeded();
  const before = await log.evaluate(node => node.scrollTop);
  await link.click();
  await expect(page.locator('#document mark').filter({ hasText: /^Passage 10\.$/ })).toBeInViewport();
  expect(await page.locator('.canvas').evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  expect(await log.evaluate(node => node.scrollTop)).toBe(before);
  await log.getByRole('link', { name: 'first', exact: true }).click();
  await expect(page.locator('#document mark').filter({ hasText: /^Passage 1\.$/ })).toBeInViewport();
  expect(await log.evaluate(node => node.scrollTop)).toBe(before);
  await writeFile(doc.path, '# Updated document\n\nThe old passages have changed.');
  await expect(page.getByText('Passage changed', { exact: true })).toHaveCount(20);
  await link.scrollIntoViewIfNeeded();
  const beforeOriginal = await log.evaluate(node => node.scrollTop);
  await link.click();
  await expect(page.getByRole('region', { name: 'Original document' })).toBeVisible();
  expect(await log.evaluate(node => node.scrollTop)).toBe(beforeOriginal);
});

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
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await answer('A late clarification');
  await expect(page.getByRole('log')).toHaveCount(0);
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
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
  expect(quote.sentence).toBe('Alpha bold 😀 and code omega.');
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
  await expect(page.getByRole('log').getByText('General after outside selection', { exact: true })).toBeVisible();
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
  await expect(page.locator('#threads').getByText('Multiple matching passages', { exact: true })).toBeVisible();
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
  expect(request.quote.sentence).toBeUndefined();
  expect((await state()).threads[request.threadId].messages[0].selections[0].quote).toEqual(request.quote);
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
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
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
  expect(id).toMatch(/^message-.+-shared-heading$/);
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
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await expect(page.locator(`[data-thread-id="${request.threadId}"]`)).toHaveCount(0);
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
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
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
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
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await expect(page.getByLabel('Thread status')).toBeFocused();
  await expect(page.locator(`[data-thread-id="${first.threadId}"]`)).toHaveCount(0);
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await page.getByRole('button', { name: 'Reopen thread' }).click();
  await expect(message).toHaveValue('Draft in the first conversation');
  await page.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await page.getByRole('button', { name: 'Reopen thread' }).click();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByText('No resolved threads.', { exact: true })).toBeVisible();
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Unresolved', exact: true }).click();
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
    await expect(page.locator('#document')).toContainText('Hello world.');
    await select(page, 'Hello');
    await message.fill('First question'); await message.press('Enter'); await saved;
    const request = await lastRequest();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.locator(`[data-thread-id="${request.threadId}"]`).click();
    await select(page, 'world.');
    await message.fill('Keep this newer draft');
    const response = page.waitForResponse('**/api/questions'); release(); await (await response).finished();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.locator(`[data-thread-id="${request.threadId}"]`).click();
    await expect(message).toHaveValue('Keep this newer draft');
    await expect(page.locator('.draft-selection')).toContainText('world.');
    expect((await state()).requests[request.id].quote.exact).toBe('Hello');
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

test('one header status follows native activity across documents without repeating queue messages', { tag: '@manual-delivery' }, async ({ page }) => {
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
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
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

test('delivered messages show Working while later inputs stay in the queue', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('First question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest();
  const firstStatus = page.locator('.message.user').filter({ hasText: 'First question' }).getByRole('status');
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  await expect(queue).toContainText('First question');
  await expect(firstStatus).toHaveCount(0);
  await f.agent(`/agent/requests/${first.id}/claim`, {});
  await message.fill('Follow-up question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const second = await lastRequest();
  const secondStatus = page.locator('.message.user').filter({ hasText: 'Follow-up question' }).getByRole('status');
  await expect(firstStatus).toHaveText('Working…');
  await expect(queue).toContainText('Follow-up question');
  await expect(secondStatus).toHaveCount(0);
  await page.reload();
  await expect(firstStatus).toHaveText('Working…');
  await expect(queue).toContainText('Follow-up question');
  const markers = await (await f.agent('/agent/streams', { requestId: first.id, documentId: doc.id, threadId: first.threadId })).json();
  await f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId: 'status-reply', turnId: 'status-turn', index: 0, delta: markers.prefix + 'First answer', final: false });
  await expect(page.getByRole('log')).toContainText('First answer');
  await expect(firstStatus).toHaveCount(0);
  await expect(queue).toContainText('Follow-up question');
  await page.reload();
  await expect(firstStatus).toHaveCount(0);
  await expect(queue).toContainText('Follow-up question');
  await f.agent('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'First answer' });
  await expect(page.getByRole('log')).toContainText('First answer');
  await expect(firstStatus).toHaveCount(0);
  await expect(queue).toContainText('Follow-up question');
  await f.agent(`/agent/requests/${second.id}/claim`, {});
  await expect(secondStatus).toHaveText('Working…');
  await f.agent('/agent/replies', { requestId: second.id, documentId: doc.id, threadId: second.threadId, text: 'Second answer' });
  await expect(page.getByRole('log')).toContainText('Second answer');
  await expect(page.getByRole('log').getByRole('status')).toHaveCount(0);
});

test('thread previews show unread dots and active-request spinners independently', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('First question'); await message.press('Enter'); await expect(message).toHaveValue('');
  const first = await lastRequest();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const row = page.locator(`[data-thread-id="${first.threadId}"]`);
  const unread = row.getByLabel('Unread reply', { exact: true });
  const progress = row.getByLabel('In progress', { exact: true });
  const queued = row.getByLabel('Queued', { exact: true });
  await expect(progress).toHaveCount(0); await expect(unread).toHaveCount(0); await expect(queued).toBeVisible();
  await f.agent(`/agent/requests/${first.id}/claim`, {});
  const second = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'Follow-up question', clientMessageId: 'after-delivery' })).json();
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

test('resolved annotations disappear, preserve overlapping open threads, and stay hidden when a new message is sent', async ({ page }) => {
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
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  const marks = page.locator('#document mark');
  await expect(marks).toHaveText('world');
  await marks.click();
  await expect(page.getByRole('log')).toContainText('First passage question');
  await expect(page.getByRole('log')).not.toContainText('Second passage question');
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(marks).toHaveCount(0);
  await expect(page.locator('#document')).toContainText('Hello world.');
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await page.reload();
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await expect(marks).toHaveCount(0);
  await page.getByLabel('Thread status').click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await expect(page.locator('[data-thread-id]')).toHaveCount(2);
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await expect(page.getByRole('log')).toContainText('First passage question');
  await expect(page.getByRole('button', { name: 'Reopen thread', exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Another passage question');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Another passage question');
  expect((await lastRequest()).threadId).toBe(first.threadId);
  await expect(marks).toHaveCount(0);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByLabel('Thread status')).toHaveText('Unresolved');
  await expect(page.locator(`[data-thread-id="${first.threadId}"]`)).toBeVisible();
  await page.reload();
  await expect(marks).toHaveCount(0);
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
  await expect(page.locator('.settings-version')).toHaveText((await state()).appVersion);
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

test('changed passages open the saved document while preserving the conversation and latest source', async ({ page }) => {
  const doc = await f.register('original.md', '# Original heading\n\nBefore the change.\n\n```typescript\nconst original = 1;\n```');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('const original = 1;');
  await select(page, 'const original = 1;');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Explain the original');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
  await writeFile(join(f.directory, 'original.md'), '# Revised heading\n\nA replacement.');
  await expect(page.locator('#threads').getByText('Passage changed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View original document' }).click();
  const original = page.getByRole('region', { name: 'Original document', exact: true });
  await expect(original.getByRole('heading', { name: 'Original heading' })).toBeVisible();
  await expect.poll(() => original.locator('mark[data-active]').allTextContents().then(parts => parts.join(''))).toBe('const original = 1;');
  await expect(page.locator('#document')).toBeHidden();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  await expect(original.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0);
  await answer('The **original** sets the value to one.');
  await expect(page.locator('.message.agent strong')).toHaveText('original');
  await expect(original.getByRole('heading', { name: 'Original heading' })).toBeVisible();
  await writeFile(join(f.directory, 'original.md'), '# Latest heading\n\nAnother replacement.');
  await expect(page.locator('#document h1')).toHaveText('Latest heading');
  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(page.locator('#document h1')).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  await page.reload();
  await page.getByRole('button', { name: 'View original document' }).click();
  await expect(original.getByRole('heading', { name: 'Original heading' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to current' }).click();
  const request = await lastRequest();
  await unlink(join(f.directory, 'versions', doc.id, `${request.quote.version}.md`));
  await page.getByRole('button', { name: 'View original document' }).click();
  await expect(original.getByRole('alert')).toContainText('This version was not saved');
  await page.getByRole('button', { name: 'Return to current' }).click();
  await expect(page.locator('#document h1')).toHaveText('Latest heading');
  // An older installation can have persisted threads with no archived Markdown.
  await page.reload();
  await expect(page.locator('#threads').getByText('Passage changed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View original document' })).toHaveCount(0);
  await expect(page.getByRole('log')).toContainText('sets the value to one');
  await expect(page.locator('#document h1')).toBeVisible();
});

test('the active thread has a distinct passage highlight, including overlapping annotations', async ({ page }) => {
  const doc = await f.register('active.md', '# Highlight context\n\nAlpha bravo charlie delta.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('Alpha bravo');
  async function annotate(text: string) {
    await select(page, text);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.getByLabel('Comment', { exact: true }).fill(`Explain ${text}`);
    await page.getByRole('button', { name: 'Send comment', exact: true }).click();
    await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
    return lastRequest();
  }
  const first = await annotate('Alpha bravo');
  const second = await annotate('bravo charlie');
  const activeText = () => page.locator('#document mark[data-active]').allTextContents().then(parts => parts.join(''));
  await expect.poll(activeText).toBe('bravo charlie');
  const activeColor = await page.locator('#document mark[data-active]').first().evaluate(node => getComputedStyle(node).backgroundColor);
  const otherColor = await page.locator('#document mark:not([data-active])').first().evaluate(node => getComputedStyle(node).backgroundColor);
  expect(activeColor).not.toBe(otherColor);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator('#document mark[data-active]')).toHaveCount(0);
  await page.locator(`[data-thread-id="${first.threadId}"]`).click();
  await expect.poll(activeText).toBe('Alpha bravo');
  await page.getByRole('button', { name: 'Show passage: Alpha bravo', exact: true }).click();
  await expect(page.locator('#document mark[data-active]').first()).toBeFocused();
  await expect(page.locator('#threads')).toHaveAttribute('data-active-thread', first.threadId);
  await page.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await page.locator(`[data-thread-id="${second.threadId}"]`).click();
  await expect.poll(activeText).toBe('bravo charlie');
});

test('thread drafts debounce browser writes and survive reloads, thread switches and reopened pages', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('sidecar-draft:')) document.documentElement.dataset.draftWrites = String(Number(document.documentElement.dataset.draftWrites ?? 0) + 1);
      return setItem.call(this, key, value);
    };
  });
  const doc = await f.register();
  const url = `${f.url}/?document=${doc.id}`;
  await page.goto(url);
  const message = page.getByLabel('Message', { exact: true });
  await expect(message).toBeVisible();
  const first = await page.locator('#threads').getAttribute('data-active-thread');
  const draft = 'An unsent question that should survive reloading.';
  await message.pressSequentially(draft);
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.dataset.draftWrites ?? 0))).toBeGreaterThan(0);
  expect(await page.evaluate(() => Number(document.documentElement.dataset.draftWrites))).toBeLessThan(draft.length / 2);
  await page.reload();
  await expect(message).toHaveValue(draft);
  await message.fill('Latest characters before reload');
  await page.reload();
  await expect(message).toHaveValue('Latest characters before reload');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator(`[data-thread-id="${first}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await message.fill('A different thread draft');
  const second = await page.locator('#threads').getAttribute('data-active-thread');
  await page.goto('about:blank');
  await page.goto(url);
  await expect(message).toHaveValue('A different thread draft');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.locator(`[data-thread-id="${first}"]`).click();
  await expect(message).toHaveValue('Latest characters before reload');
  await message.fill('');
  await page.reload();
  await expect(message).toHaveValue('');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect.poll(async () => (await state()).threads[first!]).toBeUndefined();
  await page.locator(`[data-thread-id="${second}"]`).click();
  await expect(message).toHaveValue('A different thread draft');
  expect(Object.keys((await state()).requests)).toHaveLength(0);
});

test('saved drafts retain retry IDs after a lost response and clear only after success', async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await expect(page.locator('#document')).toContainText('Hello world.');
  await select(page, 'Hello world.');
  await message.fill('Send this exactly once');
  await page.route('**/api/questions', async route => {
    await route.fetch();
    await route.fulfill({ status: 503, json: { error: 'Response lost' } });
  }, { times: 1 });
  await message.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Response lost');
  const original = await lastRequest();
  await page.reload();
  await expect(message).toHaveValue('Send this exactly once');
  await expect(page.locator('.draft-selection')).toContainText('Hello world.');
  await message.press('Enter');
  await expect(message).toHaveValue('');
  expect(Object.keys((await state()).requests)).toEqual([original.id]);
  await page.reload();
  await expect(message).toHaveValue('');
  await select(page, 'Hello world.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('A passage question');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await message.fill('Unsent annotated-thread follow-up');
  await page.reload();
  await expect(message).toHaveValue('Unsent annotated-thread follow-up');
});

test('unavailable browser draft storage preserves typing and does not block a successful send', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('sidecar-draft:')) throw new DOMException('Storage full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('My question is still usable');
  await expect(page.getByRole('alert')).toHaveText('Draft could not be saved in this browser. Keep this tab open.');
  await expect(message).toHaveValue('My question is still usable');
  await message.press('Enter');
  await expect(message).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(message).toHaveValue('');
  expect(Object.keys((await state()).requests)).toHaveLength(1);
});


test('Settings opens the all-agent library and session popovers copy original IDs', async ({ page, context }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-browser-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  f = await fixture({ after: fn => cleanup.unshift(fn) }, 20, root);
  const doc = await f.register('current.md', '# Current document');
  const old = createState({ agent: 'codex', sessionId: randomUUID() }), key = ownerKey(old.owner);
  const directory = join(root, key); await mkdir(directory);
  const path = join(directory, 'saved.md'); await writeFile(path, '# Saved document\n\nOld **content**.\n\n![local](image.svg)');
  await writeFile(join(directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  registerDocument(old, { path, generated: false });
  await writeFile(join(directory, 'state.json'), JSON.stringify(old));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
  await page.getByRole('button', { name: 'Claude session details', exact: true }).click();
  await expect(page.getByText(f.owner.sessionId, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(f.owner.sessionId);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const [library] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'View all documents', exact: true }).click()]);
  await expect(library.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(library.getByRole('link', { name: /Current document/ })).toHaveAttribute('href', `${f.url}/?document=${doc.id}`);
  const opened = library.getByRole('link', { name: /Current document/ }).locator('time');
  await expect(opened).toHaveText('now');
  const openedAt = Date.parse((await opened.getAttribute('datetime'))!);
  await expect(opened).toHaveAttribute('title', /\d/);
  for (const [minutes, label] of [[5, '5m ago'], [120, '2h ago'], [4320, '3d ago'], [20160, '2w ago'], [86400, '2mo ago'], [1051200, '2y ago']] as const) {
    await library.clock.setFixedTime(new Date(openedAt + minutes * 60000 + 1000));
    await library.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(opened).toHaveText(label);
  }
  await library.clock.setFixedTime(new Date());
  await library.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(library.getByRole('link', { name: /Saved document/ })).toContainText('Last opened —');
  await library.getByRole('button', { name: 'Codex session details', exact: true }).click();
  await expect(library.getByText(old.owner.sessionId, { exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await library.evaluate(() => navigator.clipboard.readText())).toBe(old.owner.sessionId);
  await library.keyboard.press('Escape');
  await library.getByRole('link', { name: /Saved document/ }).click();
  await expect(library.getByRole('article', { name: 'Document' })).toContainText('Old content.');
  await expect(library.getByText(/Read-only preview/)).toBeVisible();
  await expect(library.getByRole('textbox')).toHaveCount(0);
  await expect.poll(() => library.getByAltText('local', { exact: true }).evaluate(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  await library.getByRole('link', { name: 'All documents', exact: true }).click();
  await expect(library.locator('.library-session').first()).toHaveAttribute('aria-label', `codex ${old.owner.sessionId}`);
  await expect(library.getByRole('link', { name: /Saved document/ }).locator('time')).toHaveCount(1);
});

test('close confirmation preserves cancel, blocks pending work, and clears drafts in every open tab', async ({ page, context }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep this question'); await message.press('Enter');
  await expect(message).toHaveValue('');
  const request = await lastRequest();
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('pending agent requests');
  await answer('Done');
  await expect(page.getByRole('log')).toContainText('Done');
  await message.fill('Unsent draft');
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('permanently deletes all threads');
    expect(dialog.message()).toContain('Markdown file stays untouched');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(message).toHaveValue('Unsent draft');
  expect((await state()).documents[doc.id]).toBeDefined();
  const otherTab = await context.newPage();
  await otherTab.goto(`${f.url}/?document=${doc.id}`);
  await expect(otherTab.getByLabel('Message', { exact: true })).toHaveValue('Unsent draft');
  await otherTab.getByLabel('Message', { exact: true }).fill('Draft from another tab');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Document closed', exact: true })).toBeVisible();
  await expect(otherTab.getByRole('heading', { name: 'Document closed', exact: true })).toBeVisible();
  for (const tab of [page, otherTab]) {
    expect(await tab.evaluate(({ documentId, threadId }) => ({
      drafts: Object.keys(localStorage).filter(key => key.startsWith(`sidecar-draft:${documentId}:`)),
      read: localStorage.getItem(`sidecar-read-reply:${threadId}`),
      selected: sessionStorage.getItem(`sidecar-thread:${documentId}`),
    }), { documentId: doc.id, threadId: request.threadId })).toEqual({ drafts: [], read: null, selected: null });
  }
  await page.getByRole('link', { name: 'Browse all documents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  expect((await state()).documents).toEqual({});
});

test('closing one document offers the library and keeps the remaining document draft', async ({ page }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-close-library-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  f = await fixture({ after: fn => cleanup.unshift(fn) }, 20, root);
  const doc = await f.register(), other = await f.register('other.md', '# Keep me');
  await page.goto(`${f.url}/?document=${other.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep the other draft');
  await page.getByLabel('Documents', { exact: true }).selectOption(doc.id);
  await expect(page).toHaveTitle('First heading');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Document closed', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Browse all documents', exact: true }).click();
  await page.getByRole('link', { name: /Keep me/ }).click();
  await expect(page).toHaveTitle('Keep me');
  await expect(message).toHaveValue('Keep the other draft');
  const saved = await state();
  expect(Object.keys(saved.documents)).toEqual([other.id]);
});

test('thread titles edit inline and persist without letting the agent overwrite them', async ({ page }) => {
  const doc = await f.register(); await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep this conversation'); await message.press('Enter'); await expect(message).toHaveValue('');
  const request = await lastRequest(); await answer('Saved answer');
  const pencil = page.getByRole('button', { name: 'Edit thread title', exact: true });
  const title = page.getByLabel('Thread title', { exact: true });
  await pencil.click(); await title.fill('Discard me'); await title.press('Escape');
  await expect(page.getByRole('heading', { name: 'Unnamed', exact: true })).toBeVisible();
  await expect(pencil).toBeFocused();
  await pencil.click(); await title.fill('Retry behavior'); await title.press('Enter');
  await expect(page.getByRole('heading', { name: 'Retry behavior', exact: true })).toBeVisible();
  await expect(pencil).toBeFocused();
  expect((await f.agent(`/agent/threads/${request.threadId}/title`, { title: 'Agent overwrite' })).status).toBe(409);
  await page.route('**/api/threads/*/title', route => route.fulfill({ status: 503, json: { error: 'Save failed' } }), { times: 1 });
  await pencil.click(); await title.fill('My thread title'); await title.press('Enter');
  await expect(title).toHaveValue('My thread title'); await expect(page.getByRole('alert')).toHaveText('Save failed');
  await title.press('Enter'); await expect(page.getByRole('heading', { name: 'My thread title', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'My thread title', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.locator(`[data-thread-id="${request.threadId}"]`)).toContainText('My thread title');
});

test('thread search highlights the first match with bounded context and supports all statuses', async ({ page }) => {
  const doc = await f.register('search.md', '## Search review\n\nOpening paragraph.\n\n## Retry policy\n\nMore details.');
  const create = async (text: string, key: string, isResolved = false) => {
    const request = await (await f.view('/api/questions', { documentId: doc.id, text, clientMessageId: key })).json();
    await f.agent(`/agent/requests/${request.id}/claim`, {});
    await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'The newest answer has no search term.' });
    if (isResolved) await f.view(`/api/threads/${request.threadId}/resolution`, { isResolved });
    return request;
  };
  const first = await create('Before context. '.repeat(12) + 'Retry? the first occurrence. ' + 'After context. '.repeat(20) + 'Retry? the second occurrence.', 'first');
  const second = await create('Resolved Retry? discussion.', 'second', true);
  await create('Different subject.', 'third');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document h2').first()).toHaveCSS('margin-top', '32px');
  const h2 = page.locator('#document h2').nth(1);
  await expect(h2).toHaveCSS('margin-top', '32px'); await expect(h2).toHaveCSS('margin-bottom', '12px');
  await expect(h2).toHaveCSS('padding-top', '0px'); await expect(h2).toHaveCSS('padding-bottom', '0px');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
  expect((await f.view('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const filter = page.getByLabel('Thread status');
  await expect(filter).toHaveText('Unresolved');
  const search = page.getByRole('searchbox', { name: 'Search threads' });
  await search.fill('retry?');
  await expect(page.locator('.thread-row')).toHaveCount(1);
  const row = page.locator(`[data-thread-id="${first.threadId}"]`), preview = row.locator('.thread-preview');
  await expect(preview.locator('mark')).toHaveText('Retry?');
  await expect(preview).toContainText('the first occurrence'); await expect(preview).not.toContainText('second occurrence');
  await expect(preview).toHaveCSS('-webkit-line-clamp', '2');
  const bounds = await preview.boundingBox();
  const lineHeight = await preview.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
  expect(bounds!.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
  await filter.click(); await expect(page.getByRole('menuitemradio', { name: 'Unresolved', exact: true })).toBeChecked();
  await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
  await expect(page.locator('.thread-row')).toHaveCount(2);
  await filter.focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'All', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(filter).toBeFocused();
  await filter.click(); await page.getByRole('menuitemradio', { name: 'Resolved', exact: true }).click();
  await expect(page.locator('.thread-row')).toHaveCount(1);
  await expect(page.locator(`[data-thread-id="${second.threadId}"]`)).toBeVisible();
  await search.fill('no such phrase'); await expect(page.getByText('No matching threads.')).toBeVisible();
  await search.fill('retry?'); await filter.click(); await page.getByRole('menuitemradio', { name: 'All', exact: true }).click();
  await row.click(); await expect(page.getByRole('log')).toContainText('the first occurrence');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(search).toHaveValue('retry?');
  await page.screenshot({ path: '/private/tmp/sidecar-thread-search.png', fullPage: true });
  await filter.click(); await page.screenshot({ path: '/private/tmp/sidecar-thread-filter.png', fullPage: true });
});


test('document badges, copy and brightness preserve text anchors and controls', async ({ page, context }) => {
  const markdown = '## Repository review\n\nText with **emphasis** and `code`.\n\n```js\nconst answer = 42;\n```\n';
  const doc = await f.register('header.md', markdown);
  await f.agent('/agent/documents', { path: doc.path, repoInfo: { display: 'sidecar', branch: 'feature/sidebar' } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('.document-tools').getByTitle('sidecar', { exact: true })).toBeVisible();
  await expect(page.locator('.document-tools').getByTitle('feature/sidebar', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open with/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy file', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied!', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
  await select(page, 'Text with emphasis');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Explain this text');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByRole('log').getByText('Explain this text', { exact: true })).toBeVisible();
  await answer('A **clear** reply.');
  expect((await lastRequest()).quote.prefix).not.toContain('Copy');
  expect((await lastRequest()).quote.prefix).not.toContain('feature/sidebar');
  await expect(page.locator('#document h2')).toHaveCSS('margin-top', '32px');
  const glyphColor = () => page.locator('#document h2').evaluate(el => getComputedStyle(el).webkitTextFillColor);
  const original = await glyphColor();
  const background = await page.locator('#document').evaluate(el => getComputedStyle(el).backgroundColor);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const brightness = page.getByRole('slider', { name: 'Text brightness', exact: true });
  await expect(brightness).toHaveValue('100');
  await expect(brightness).toHaveAttribute('max', '100');
  await brightness.fill('60');
  expect(await glyphColor()).not.toBe(original);
  expect(await glyphColor()).toContain('/ 0.54'); // H2 starts at 90% foreground opacity.
  expect(await page.locator('.message.agent strong').evaluate(el => getComputedStyle(el).webkitTextFillColor)).toContain('/ 0.54');
  expect(await page.locator('#document').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(background);
  expect(await page.locator('.document-copy').evaluate(el => getComputedStyle(el).webkitTextFillColor)).not.toContain('/ 0.6');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(brightness).toHaveValue('60');
  await page.getByRole('button', { name: 'Reset text brightness' }).click();
  await expect(brightness).toHaveValue('100');
  expect(await glyphColor()).toBe(original);
  await brightness.press('Escape');
  await page.setViewportSize({ width: 600, height: 800 });
  const badgeBox = (await page.locator('.document-tools').boundingBox())!;
  expect((await page.locator('#document h2').boundingBox())!.y).toBeGreaterThan(badgeBox.y + badgeBox.height);
});

test('progress updates remain in history and Working moves below the latest update', { tag: '@manual-delivery' }, async ({ page }) => {
  const doc = await f.register();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Inspect this document');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#threads').getByRole('status').filter({ hasText: 'Queued' })).toBeVisible();
  const request = await lastRequest();
  const event = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  await f.agent(`/agent/requests/${request.id}/accepted`, {});
  await expect(page.locator('#threads').getByRole('status').filter({ hasText: 'Working' })).toBeVisible();
  const emit = (messageId: string, delta: string) => f.agent('/agent/stream-events', { ownerKey: ownerKey(f.owner), turnId: 'test', messageId, index: 0, delta, final: true });
  await emit('progress', event.stream.progress.prefix + 'I’ll inspect the file.' + event.stream.progress.suffix);
  await expect(page.locator('.message.agent').getByText('I’ll inspect the file.', { exact: true })).toBeVisible();
  await expect(page.locator('.message.agent').getByRole('status')).toHaveText('Working…');
  await expect(page.locator('.message.user').getByRole('status')).toHaveCount(0);
  await emit('final', event.stream.prefix + 'The file looks good.' + event.stream.suffix);
  await expect(page.locator('.message.agent')).toHaveCount(2);
  await expect(page.locator('#threads').getByRole('status').filter({ hasText: 'Working' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.message.agent')).toHaveCount(2);
  await expect(page.getByRole('log')).toContainText('I’ll inspect the file.');
  await expect(page.getByRole('log')).toContainText('The file looks good.');
});

test('highlight intensity dims selections without dimming text and persists across reload', async ({ page }) => {
  const doc = await f.register('a.md', '# Highlight settings\n\nSelect this passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('Select this passage.');
  await select(page, 'Select this passage.');
  const original = await page.locator('mark[data-pending]').evaluate(e => getComputedStyle(e).backgroundColor);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Highlight intensity', exact: true });
  await slider.fill('30');
  await slider.press('Escape');
  await select(page, 'Select this passage.');
  const dimmed = page.locator('mark[data-pending]');
  await expect(dimmed).toHaveText('Select this passage.');
  expect(await dimmed.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe(original);
  expect(await dimmed.evaluate(e => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(slider).toHaveValue('30');
  await page.getByRole('button', { name: 'Reset highlight intensity' }).click();
  await expect(slider).toHaveValue('100');
  await slider.press('Escape');
  await select(page, 'Select this passage.');
  expect(await page.locator('mark[data-pending]').evaluate(e => getComputedStyle(e).backgroundColor)).toBe(original);
});

test('message selection attaches to the next input, replaces, dismisses and moves to a new comment', async ({ page }) => {
  const doc = await f.register('selections.md', '# Selections\n\nFirst passage. Second passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep this text');
  await select(page, 'First passage.');
  const badge = page.locator('.sidebar .draft-selection');
  await expect(badge).toContainText('First passage.');
  await message.click();
  await expect(badge).toBeVisible();
  await select(page, 'Second passage.');
  await expect(badge).toContainText('Second passage.');
  await page.locator('.brand').click();
  await expect(badge).toHaveCount(0);
  await expect(page.locator('mark[data-pending]')).toHaveCount(0);
  await expect(message).toHaveValue('Keep this text');
  await select(page, 'First passage.');
  await page.getByRole('button', { name: 'Remove selection', exact: true }).click();
  await expect(badge).toHaveCount(0);
  const initialId = await page.locator('#threads').getAttribute('data-active-thread');
  await select(page, 'Second passage.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(badge).toHaveCount(0);
  await page.getByLabel('Comment', { exact: true }).fill('New selected conversation');
  await page.getByLabel('Send comment', { exact: true }).click();
  await expect(page.getByRole('log')).toContainText('New selected conversation');
  const request = await lastRequest();
  expect(request.threadId).not.toBe(initialId);
  expect(request.quote.exact).toBe('Second passage.');
  await page.getByLabel('Threads', { exact: true }).click();
  await page.locator(`[data-thread-id="${initialId}"]`).click();
  await expect(message).toHaveValue('Keep this text');
  await expect(badge).toHaveCount(0);
});

test('selection draft survives thread switches and reload, then each message owns its passage', async ({ page }) => {
  const doc = await f.register('selections.md', '# Selections\n\nFirst passage. Second passage.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await expect(message).toBeVisible();
  const id = await page.locator('#threads').getAttribute('data-active-thread');
  await select(page, 'First passage.');
  await page.getByLabel('Threads', { exact: true }).click();
  await expect(page.locator(`[data-thread-id="${id}"]`)).toContainText('Draft');
  await page.locator(`[data-thread-id="${id}"]`).click();
  await page.reload();
  await expect(page.locator('.draft-selection')).toContainText('First passage.');
  await message.fill('First question'); await message.press('Enter');
  await expect(page.locator('.message-selection')).toHaveCount(1);
  await expect(page.locator('.draft-selection')).toHaveCount(0);
  await message.fill('General follow-up'); await message.press('Enter');
  await expect(page.getByRole('log')).toContainText('General follow-up');
  await select(page, 'Second passage.');
  await message.fill('Second question'); await message.press('Enter');
  await expect(page.locator('.message-selection')).toHaveCount(2);
  expect((await state()).threads[id!].messages.filter((m: any) => m.role === 'user').map((m: any) => m.selections?.[0].quote.exact)).toEqual(['First passage.', undefined, 'Second passage.']);
  await expect.poll(() => page.locator('#document mark[data-active]').allTextContents().then(t => t.join(''))).toBe('Second passage.');
  await page.getByRole('button', { name: 'Show passage: First passage.', exact: true }).click();
  await expect.poll(() => page.locator('#document mark[data-active]').allTextContents().then(t => t.join(''))).toBe('First passage.');
  await page.getByRole('button', { name: 'Show passage: Second passage.', exact: true }).click();
  await expect.poll(() => page.locator('#document mark[data-active]').allTextContents().then(t => t.join(''))).toBe('Second passage.');
});

test('message history navigates identical selections within one thread and preserves per-message old versions', async ({ page }) => {
  const doc = await f.register('history.md', '# History\n\nAlpha bravo charlie.');
  await page.goto(`${f.url}/?document=${doc.id}`);
  const message = page.getByLabel('Message', { exact: true });
  await expect(message).toBeVisible();
  const id = await page.locator('#threads').getAttribute('data-active-thread');
  for (const question of ['First reference', 'Second reference']) {
    await select(page, 'Alpha bravo');
    await message.fill(question); await message.press('Enter');
    await expect(page.getByRole('log')).toContainText(question);
  }
  const saved = (await state()).threads[id!].messages;
  await page.locator('#document mark').filter({ hasText: 'Alpha bravo' }).click();
  await expect(page.locator('.selection-actions').getByRole('button', { name: 'First reference', exact: true })).toBeVisible();
  await page.locator('.selection-actions').getByRole('button', { name: 'First reference', exact: true }).click();
  await expect(page.locator(`[data-message-id="${saved[0].id}"]`)).toHaveAttribute('data-active', 'true');
  await page.locator('#document mark').filter({ hasText: 'Alpha bravo' }).click();
  await page.locator('.selection-actions').getByRole('button', { name: 'Second reference', exact: true }).click();
  await expect(page.locator(`[data-message-id="${saved[1].id}"]`)).toHaveAttribute('data-active', 'true');
  await writeFile(join(f.directory, 'history.md'), '# Changed\n\nDifferent passage.');
  await expect(page.locator('#document h1')).toHaveText('Changed');
  await expect(page.getByText('Passage changed', { exact: true })).toHaveCount(2);
  await page.locator(`[data-message-id="${saved[0].id}"]`).getByRole('button', { name: 'View original document' }).click();
  await expect(page.getByRole('region', { name: 'Original document', exact: true })).toContainText('Alpha bravo charlie.');
  await expect(page.getByRole('log')).toBeVisible();
  await page.getByRole('button', { name: 'Return to current' }).click();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByLabel('Search threads').fill('Alpha bravo');
  await expect(page.locator('.thread-preview mark')).toHaveText('Alpha bravo');
});

async function filesWorkspace(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-files-ui-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test('selected code attaches its file and lines, survives drafts, and can be quoted from the dock', async ({ page }) => {
  const code = 'export function check() {\n  return true;\n}\n';
  const root = await filesWorkspace({ 'app.ts': code });
  const doc = await f.register('main.md', `# Main\n\nHello world.\n\n[Code](${root}/app.ts:2)`);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.locator('#document').getByRole('link', { name: 'Code', exact: true }).click();
  const file = page.getByRole('dialog', { name: 'File: app.ts', exact: true });
  await expect(file.locator('pre code')).toContainText('return true;');
  await expect(file.locator('[data-line-number-content]')).toHaveText(['1', '2', '3', '4']);
  const capture = async (keyboard = false) => page.locator('.code-file-view').evaluate((root, keyboard) => {
    const text = root.querySelector('diffs-container')!.shadowRoot!.querySelector('pre code')!;
    const nodes = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const start = text.textContent!.indexOf('  return true;'), end = start + '  return true;'.length;
    let at = 0, started = false, node;
    const range = document.createRange();
    while ((node = nodes.nextNode())) {
      const length = node.textContent!.length;
      if (!started && at + length > start) { range.setStart(node, start - at); started = true; }
      if (started && at + length >= end) { range.setEnd(node, end - at); break; }
      at += length;
    }
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    root.dispatchEvent(keyboard ? new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }) : new MouseEvent('mouseup', { bubbles: true }));
  }, keyboard);
  await capture();
  await expect(page.locator('.draft-selection')).toContainText('app.ts:2');
  await expect(page.locator('.draft-selection')).toContainText('return true;');
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Explain this line');
  await page.reload();
  await expect(input).toHaveValue('Explain this line');
  await expect(page.locator('.draft-selection')).toContainText('app.ts:2');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Explain this line');
  const request = await lastRequest();
  expect(request.fileQuote).toEqual({ path: `${root}/app.ts`, kind: 'code', exact: '  return true;', startLine: 2, endLine: 2 });
  expect(request.quote).toBeUndefined();
  await expect(page.locator('#document mark')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open quoted file: app.ts:2', exact: true }).click();
  await expect(file.locator('pre code')).toContainText('return true;');
  await file.getByRole('button', { name: 'Dock window', exact: true }).click();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await capture(true);
  await expect(page.locator('.draft-selection')).toContainText('app.ts:2');
  await expect(page.locator('#threads')).not.toHaveAttribute('data-active-thread', request.threadId);
  await page.getByRole('button', { name: 'Remove selection', exact: true }).click();
  await expect(page.locator('.draft-selection')).toHaveCount(0);
  await select(page, 'Hello world.');
  await expect(page.locator('.draft-selection')).toContainText('Hello world.');
  await capture();
  await expect(page.locator('.draft-selection')).toContainText('app.ts:2');
  await expect(page.locator('.draft-selection')).not.toContainText('Hello world.');
  await page.getByRole('button', { name: 'Remove selection', exact: true }).click();
  await page.locator('.code-file-view [data-column-number="2"]').click();
  await expect(page.locator('.draft-selection')).toContainText('app.ts:2');
  await expect(page.locator('.draft-selection')).toContainText('return true;');
  await page.locator('.code-file-view [data-column-number="4"]').click();
  await expect(page.locator('.draft-selection')).toContainText('return true;');
  await page.locator('.code-file-view').evaluate(root => {
    const shadow = root.querySelector('diffs-container')!.shadowRoot!;
    const first = shadow.querySelector('[data-line="2"]')!, last = shadow.querySelector('[data-line="3"]')!;
    const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.childNodes.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator('.draft-selection')).toContainText('app.ts:2–3');
  await page.getByLabel('Message', { exact: true }).fill('Explain these lines');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect.poll(async () => (await lastRequest()).fileQuote?.exact).toBe('  return true;\n}');
  expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe(code);
});

test('dragging code text repeatedly attaches the exact snippet in floating and docked windows', async ({ page }) => {
  const root = await filesWorkspace({ 'app.ts': 'export function check() {\n  return true;\n}\n' });
  const doc = await f.register('main.md', `# Main\n\n[Code](${root}/app.ts:2)`);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.locator('#document').getByRole('link', { name: 'Code', exact: true }).click();
  const file = page.getByRole('dialog', { name: 'File: app.ts', exact: true });
  await expect(file.locator('[data-line="2"]')).toContainText('return true;');
  await file.locator('[data-column-number="1"]').click();
  await file.locator('[data-column-number="4"]').click();
  await expect(page.locator('.draft-selection .quote-excerpt')).toHaveText('export function check() {');
  async function drag(line: number, from: number, to: number) {
    const points = await page.locator(`.code-file-view [data-line="${line}"]`).evaluate((element, offsets) => offsets.map(offset => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && offset > node.textContent!.length) { offset -= node.textContent!.length; node = walker.nextNode(); }
      const range = document.createRange(); range.setStart(node!, offset); range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y + rect.height / 2 };
    }), [from, to]);
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 12 });
    await page.mouse.up();
  }
  await drag(2, 2, 8);
  await expect(page.locator('.draft-selection .quote-excerpt')).toHaveText('return');
  await drag(1, 7, 15);
  await expect(page.locator('.draft-selection .quote-excerpt')).toHaveText('function');
  await file.getByRole('button', { name: 'Dock window', exact: true }).click();
  await drag(2, 13, 9);
  await expect(page.locator('.draft-selection .quote-excerpt')).toHaveText('true');
  await page.locator('.code-file-view [data-column-number="1"]').click();
  await expect(page.locator('.draft-selection .quote-excerpt')).toHaveText('export function check() {');
  await page.locator('.code-file-view [data-column-number="4"]').click();
  await expect(page.locator('.draft-selection .quote-excerpt')).toHaveText('export function check() {');
  await page.getByLabel('Message', { exact: true }).fill('Explain this');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('log')).toContainText('Explain this');
  expect((await lastRequest()).fileQuote.exact).toBe('export function check() {');
});

test('file roots navigate, reset, and reveal a nested file without losing drafts or changing workspace', async ({ page }) => {
  const code = 'export const answer = 42;\n';
  const base = await filesWorkspace({ 'project/src/deep/target.ts': code, 'outside.md': '# Outside' });
  for (let i = 0; i < 45; i++) await writeFile(join(base, 'project', 'src', 'deep', `a${i}.ts`), code);
  const root = `${base}/project`;
  const doc = await f.register('main.md', `# Main\n\n[Target](${root}/src/deep/target.ts:1)`);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
  const toggle = page.getByRole('button', { name: 'Show files' });
  const box = await toggle.boundingBox();
  expect(box!.x).toBe(0); expect(box!.y).toBeGreaterThanOrEqual(49);
  await expect(page.locator('.topbar').getByRole('button', { name: 'Show files' })).toHaveCount(0);
  await page.locator('#document').getByRole('link', { name: 'Target' }).click();
  const file = page.getByRole('dialog', { name: 'File: src/deep/target.ts', exact: true });
  await expect(file.locator('pre code')).toContainText(code.trim());
  await file.getByRole('button', { name: 'Show in file browser' }).click();
  const panel = page.getByRole('complementary', { name: 'Files' });
  const selected = panel.getByTitle('src/deep/target.ts', { exact: true });
  await expect(selected).toBeFocused();
  await expect(selected).toHaveClass(/active/);
  await expect(selected).toBeInViewport();
  await expect(panel.getByRole('button', { name: 'Go to parent folder' })).toBeInViewport();
  await panel.getByRole('button', { name: 'Filter files', exact: true }).click();
  await panel.getByRole('searchbox', { name: 'Filter files' }).fill('no match');
  await file.getByRole('button', { name: 'Show in file browser' }).click();
  await expect(selected).toBeFocused();
  await panel.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(panel.getByRole('button', { name: 'Change visible root' })).toHaveText(base);
  await expect(panel.getByTitle('outside.md', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Change visible root' }).click();
  await panel.getByRole('textbox', { name: 'Visible root' }).fill(`${root}/src`);
  await panel.getByRole('textbox', { name: 'Visible root' }).press('Enter');
  await expect(panel.getByRole('button', { name: 'Change visible root' })).toHaveText(`${root}/src`);
  await panel.getByRole('button', { name: 'Reset visible root', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Change visible root' })).toHaveText(root);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft');
  expect((await state()).documents[doc.id].workspace).toBe(root);
  expect(Object.keys((await state()).documents)).toEqual([doc.id]);
  await page.screenshot({ path: '/private/tmp/sidecar-file-navigation.png' });
});

test('file windows share the dock with pinned replies and reopen without duplicates', async ({ page }) => {
  const root = await filesWorkspace({ 'a.md': '# First file\n', 'b.yml': 'enabled: true\n' });
  const doc = await f.register('main.md', '# Main document\n\nKeep this visible.');
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByLabel('Message', { exact: true }).fill('A useful reply');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log').getByText('A useful reply', { exact: true })).toBeVisible();
  await answer('Keep this reply handy.');
  const reply = page.locator('.messages .message.agent');
  await reply.hover();
  await reply.getByRole('button', { name: 'Pin message', exact: true }).click();
  await page.getByRole('dialog', { name: 'Pinned message', exact: true }).getByRole('button', { name: 'Dock window', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Unsent draft');
  await page.getByRole('button', { name: 'Show files' }).click();
  const panel = page.getByRole('complementary', { name: 'Files' });
  await panel.getByTitle('a.md', { exact: true }).click();
  const first = page.getByRole('dialog', { name: 'File: a.md', exact: true });
  await expect(first.getByRole('heading', { name: 'First file' })).toBeVisible();
  await expect(page.locator('#document')).toBeVisible();
  await first.getByRole('button', { name: 'Dock window', exact: true }).click();
  await panel.getByTitle('b.yml', { exact: true }).click();
  const second = page.getByRole('dialog', { name: 'File: b.yml', exact: true });
  await expect(second.locator('pre code')).toContainText('enabled: true');
  await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await second.getByRole('button', { name: 'Minimize window', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand dock' })).toHaveText('3 windows');
  // Reopening a docked file expands and selects its existing tab.
  await panel.getByTitle('a.md', { exact: true }).click();
  const dock = page.getByRole('region', { name: 'Window dock', exact: true });
  await expect(dock.getByRole('tab')).toHaveCount(3);
  await expect(dock.getByRole('tab', { name: 'a.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dock.getByRole('tab', { name: 'a.md', exact: true })).toBeFocused();
  await expect(dock.getByRole('heading', { name: 'First file' })).toBeVisible();
  await expect(first).toHaveCount(0);
  const fileTab = dock.locator('.dock-tab-shell').filter({ has: page.getByRole('tab', { name: 'a.md', exact: true }) });
  await fileTab.getByRole('button', { name: 'Move out of dock' }).click();
  await expect(first).toBeVisible();
  await panel.getByTitle('a.md', { exact: true }).click();
  await expect(first).toHaveCount(1);
  await expect(first).toBeFocused();
  const before = await first.boundingBox();
  await first.getByRole('group', { name: 'Move file window' }).press('Shift+ArrowRight');
  await expect.poll(async () => (await first.boundingBox())!.width).toBe(before!.width + 10);
  await first.getByRole('button', { name: 'Close file window' }).click();
  await expect(first).toHaveCount(0);
  await expect(dock.getByRole('tab')).toHaveCount(2);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unsent draft');
  expect(Object.keys((await state()).documents)).toEqual([doc.id]);
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# First file\n');
  // The existing one-window setting applies across files and pinned replies.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'One at a time', exact: true }).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(dock.getByRole('tab')).toHaveText(['b.yml']);
  await panel.getByTitle('a.md', { exact: true }).click();
  await expect(dock).toHaveCount(0);
  await expect(first).toBeVisible();
  await page.setViewportSize({ width: 360, height: 420 });
  await expect.poll(async () => {
    const rect = await first.boundingBox();
    return !!rect && rect.x >= 0 && rect.x + rect.width <= 360 && rect.y >= 0 && rect.y + rect.height <= 420;
  }).toBe(true);
});

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
  await expect(panel.getByTitle('docs/plan.md', { exact: true })).toBeVisible();
  await expect(panel.getByTitle('page.html', { exact: true })).toBeVisible();
  await expect(panel.getByTitle('src.ts', { exact: true })).toBeVisible();

  await select(page, 'Main body passage');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Draft survives preview');
  await panel.getByTitle('docs/plan.md', { exact: true }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('heading', { name: 'Plan heading' })).toBeVisible();
  await expect(preview).toContainText('docs/plan.md');
  await expect(page.locator('#document')).toBeVisible();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await expect(preview.locator('img').first()).toHaveAttribute('src', /[?&]document=&/);
  await page.evaluate(() => {
    const text = [...document.querySelectorAll('.file-preview p')].find(p => p.textContent === 'Plan body text.')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.keyboard.press('c');
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await page.getByRole('dialog', { name: 'File: docs/plan.md', exact: true }).getByRole('button', { name: 'Close file window' }).click();

  await panel.getByTitle('page.html', { exact: true }).click();
  const frame = page.frameLocator('iframe[title="Preview of page.html"]');
  await expect(frame.locator('#static')).toHaveText('Static HTML');
  await expect(page.locator('iframe[title="Preview of page.html"]')).toHaveAttribute('sandbox', '');
  await page.getByRole('dialog', { name: 'File: page.html', exact: true }).getByRole('button', { name: 'Close file window' }).click();
  await panel.getByTitle('flow.mmd', { exact: true }).click();
  await expect(preview.locator('svg').first()).toBeVisible();

  await page.getByRole('dialog', { name: 'File: flow.mmd', exact: true }).getByRole('button', { name: 'Close file window' }).click();
  await expect(page.locator('#document')).toBeVisible();
  await select(page, 'Main body passage');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Draft survives preview');
  expect(Object.keys((await state()).documents)).toEqual([doc.id]);
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Files' })).toBeVisible();
});

test('JSON and YAML file previews preserve literal content and indentation as highlighted code', async ({ page }) => {
  const json = '{\n  "label": "**literal** <b>text</b>",\n  "fence": "```",\n  "nested": {\n    "enabled": true\n  }\n}';
  const yaml = '# Keep this comment\nnested:\n  label: "**literal** <b>text</b>"\n  items:\n    - first\n    - second';
  const files = { 'data.JSON': json, 'config.YML': yaml, 'config.yaml': yaml };
  const root = await filesWorkspace(files);
  const doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByRole('button', { name: 'Show files' }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  for (const [path, source, language] of [['data.JSON', json, 'json'], ['config.YML', yaml, 'yaml'], ['config.yaml', yaml, 'yaml']]) {
    await page.getByRole('complementary', { name: 'Files' }).getByTitle(path, { exact: true }).click();
    const code = preview.locator('pre code');
    await expect(code).toBeVisible();
    await expect.poll(async () => (await code.locator('[data-line]').allTextContents()).join('\n')).toBe(source);
    await expect(code.locator('span[style]').first()).toBeVisible();
    await expect(preview.locator('strong, b, h1, ul')).toHaveCount(0);
    await page.getByRole('dialog', { name: `File: ${path}`, exact: true }).getByRole('button', { name: 'Close file window' }).click();
  }
});

test('files panel handles empty workspaces, its own document and conversation navigation', async ({ page }) => {
  const empty = await filesWorkspace({ 'ignored.bin': 'not previewable' });
  const root = await filesWorkspace({ 'nav.md': '# Navigation\n\nQuoted passage text.\n', 'a.md': '# A file\n' });
  const doc = await (await f.agent('/agent/documents', { path: join(root, 'nav.md'), workspace: empty })).json();
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByRole('button', { name: 'Show files' }).click();
  const panel = page.getByRole('complementary', { name: 'Files' });
  await expect(panel).toContainText('No previewable files in this workspace.');
  await expect(panel).not.toContainText('Settings');

  // A new declaration re-roots the open panel through the live state update.
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await expect(panel.getByTitle('nav.md', { exact: true })).toBeVisible();
  await writeFile(join(root, 'b.md'), '# B file\n');
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await expect(panel.getByTitle('b.md', { exact: true })).toBeVisible();

  await select(page, 'Quoted passage text');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('Comment', { exact: true }).fill('About this passage');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByRole('log').getByText('About this passage', { exact: true })).toBeVisible();
  await answer('Noted.');
  await panel.getByTitle('a.md', { exact: true }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('heading', { name: 'A file' })).toBeVisible();
  await page.getByRole('log').getByText('Quoted passage text').first().click();
  await expect(preview).toBeVisible();
  await expect(page.locator('#document')).toBeVisible();
  await panel.getByTitle('a.md', { exact: true }).click();
  await expect(preview).toBeVisible();
  // The backing file can also be read in its own window without registering another document.
  await panel.getByTitle('nav.md', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'File: nav.md', exact: true }).getByRole('heading', { name: 'Navigation' })).toBeVisible();
  await expect(page.locator('#document')).toBeVisible();
});

test('file previews attach a file quote after the conversation pane toggles', async ({ page }) => {
  const root = await filesWorkspace({ 'other.md': '# Other\n\nOther text.\n' });
  const doc = await f.register('main.md', '# Main\n\nAttach this passage please.\n');
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await expect(page.locator('#document')).toContainText('Attach this passage');
  await page.getByRole('button', { name: 'Show files' }).click();
  await page.getByRole('complementary', { name: 'Files' }).getByTitle('other.md', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'File preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide conversations' }).click();
  await page.getByRole('button', { name: 'Show conversations' }).click();
  await page.getByRole('dialog', { name: 'File: other.md', exact: true }).focus();
  await page.evaluate(() => {
    const text = document.querySelector('.file-preview p')!.firstChild!;
    const range = document.createRange(); range.selectNodeContents(text);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    document.querySelector('.file-preview article')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  });
  await expect(page.locator('.annotation-toolbar')).toHaveCount(0);
  await page.keyboard.press('c');
  await expect(page.getByLabel('Comment', { exact: true })).toHaveCount(0);
  await expect(page.locator('.draft-selection')).toContainText('other.md');
  await expect(page.locator('.draft-selection')).toContainText('Other text.');
});

test('opened files retain their own roots when the document workspace changes', async ({ page }) => {
  const first = await filesWorkspace({ 'a.md': '# From first root\n' });
  const second = await filesWorkspace({ 'a.md': '# From second root\n' });
  const doc = await f.register('main.md', '# Main\n\nBody.\n');
  await f.agent('/agent/documents', { path: doc.path, workspace: first });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByRole('button', { name: 'Show files' }).click();
  const panel = page.getByRole('complementary', { name: 'Files' }), preview = page.getByRole('region', { name: 'File preview' });
  await panel.getByTitle('a.md', { exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'From first root' })).toBeVisible();
  await f.agent('/agent/documents', { path: doc.path, workspace: second });
  await expect(panel.getByRole('button', { name: 'Change visible root' })).toHaveText(second);
  await expect(preview.getByRole('heading', { name: 'From first root' })).toBeVisible();
  await page.getByRole('dialog', { name: 'File: a.md', exact: true }).getByRole('button', { name: 'Close file window' }).click();
  await panel.getByTitle('a.md', { exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'From second root' })).toBeVisible();
  await writeFile(join(second, 'a.md'), '# Edited on disk\n');
  await panel.getByTitle('a.md', { exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'Edited on disk' })).toBeVisible();
});

test('files panel never shows Plannotator settings hint while loading', async ({ page }) => {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('No directories configured')) (window as unknown as { sawHint: boolean }).sawHint = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const root = await filesWorkspace({ 'a.md': '# A\n' });
  const doc = await f.register('main.md', '# Main\n\nBody.\n');
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  await page.goto(`${f.url}/?document=${doc.id}`);
  await page.getByRole('button', { name: 'Show files' }).click();
  await expect(page.getByRole('complementary', { name: 'Files' }).getByTitle('a.md', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sawHint?: boolean }).sawHint ?? false)).toBe(false);
});

test('file links in documents and replies open explicitly chosen files beyond the workspace too', async ({ page, context }) => {
  const outside = await filesWorkspace({ 'far.md': '# Far\n' });
  const root = await filesWorkspace({
    'docs/main.md': `# Main\n\nRead [the sibling](sibling.md), [the app](../src/app.ts:1), and \`src/app.ts:1\`.\n\nAlso [far doc](${outside}/far.md).\n`,
    'docs/sibling.md': '# Sibling heading\n',
    'docs/guide.md': '# Guide heading\n',
    'src/app.ts': 'export const answer = 42;\n',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const doc = await (await f.agent('/agent/documents', { path: join(root, 'docs', 'main.md'), workspace: root })).json();
  await page.goto(`${f.url}/?document=${doc.id}`);
  const article = page.locator('#document'), preview = page.getByRole('region', { name: 'File preview' });
  await article.getByRole('link', { name: 'the sibling' }).click();
  await expect(preview.getByRole('heading', { name: 'Sibling heading' })).toBeVisible();
  expect(page.url()).toContain(`document=${doc.id}`);
  await page.getByRole('dialog', { name: 'File: docs/sibling.md', exact: true }).getByRole('button', { name: 'Close file window' }).click();

  await article.getByRole('link', { name: 'the app' }).click();
  await expect(page.getByText('export const answer = 42;')).toBeVisible();
  await page.getByRole('dialog', { name: 'File: src/app.ts', exact: true }).getByRole('button', { name: 'Close file window' }).click();
  await expect(page.getByText('export const answer = 42;')).toHaveCount(0);
  await article.getByText('src/app.ts:1', { exact: true }).click();
  await expect(page.getByText('export const answer = 42;')).toBeVisible();
  await page.getByRole('dialog', { name: 'File: src/app.ts', exact: true }).getByRole('button', { name: 'Close file window' }).click();

  await article.getByRole('link', { name: 'far doc' }).click();
  await expect(preview.getByRole('heading', { name: 'Far', exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Show in file browser' }).click();
  await expect(page.getByRole('button', { name: 'Change visible root' })).toHaveText(outside);
  await expect(page.locator('.file-tree-item.active')).toHaveAttribute('title', 'far.md');
  await page.getByRole('dialog', { name: 'File: far.md', exact: true }).getByRole('button', { name: 'Close file window' }).click();

  await page.getByLabel('Message', { exact: true }).fill('Where is the guide?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log').getByText('Where is the guide?', { exact: true })).toBeVisible();
  await answer(`See [the guide](${root}/docs/guide.md).`);
  await page.getByRole('log').getByRole('link', { name: 'the guide' }).click();
  await expect(preview.getByRole('heading', { name: 'Guide heading' })).toBeVisible();

  const bare = await f.register('bare.md', '# Bare\n\nSee [a file](/tmp/elsewhere.md).\n');
  await page.goto(`${f.url}/?document=${bare.id}`);
  await page.locator('#document').getByRole('link', { name: 'a file' }).click();
  await expect(preview).toContainText('This document has no recorded workspace');
});
