import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readSessionNames } from '../src/session-names.ts';
import { ownerKey, type Owner } from '../src/store.ts';

test('native names prefer explicit Claude titles and refresh renames for both agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-session-names-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') };
  const project = join(env.CLAUDE_CONFIG_DIR, 'projects', 'original-project');
  await mkdir(project, { recursive: true }); await mkdir(env.CODEX_HOME);
  const codex: Owner = { agent: 'codex', sessionId: randomUUID() }, claude: Owner = { agent: 'claude', sessionId: randomUUID() };
  const index = join(env.CODEX_HOME, 'session_index.jsonl'), transcript = join(project, claude.sessionId + '.jsonl');
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  await writeFile(index, line({ id: codex.sessionId, thread_name: 'Earlier name' }) + line({ id: codex.sessionId, thread_name: 'Queue review' }));
  await writeFile(transcript, line({ type: 'custom-title', customTitle: 'Transfer review', sessionId: claude.sessionId })
    + line({ type: 'ai-title', aiTitle: 'Generated title', sessionId: claude.sessionId })
    + line({ type: 'assistant', message: { content: 'Private conversation text must not become a title.' } })
    + line({ type: 'custom-title', customTitle: 'Wrong session', sessionId: randomUUID() }) + '{unfinished');
  let names = await readSessionNames([codex, claude], env);
  assert.equal(names.get(ownerKey(codex)), 'Queue review');
  assert.equal(names.get(ownerKey(claude)), 'Transfer review');
  assert.deepEqual(await readSessionNames([codex, claude], env), names);
  await appendFile(index, line({ id: codex.sessionId, thread_name: 'Renamed queue review' }));
  await appendFile(transcript, '\n' + line({ type: 'custom-title', customTitle: '', sessionId: claude.sessionId }));
  names = await readSessionNames([codex, claude], env);
  assert.equal(names.get(ownerKey(codex)), 'Renamed queue review');
  assert.equal(names.get(ownerKey(claude)), 'Generated title');
  // Replacement/truncation must invalidate the cache too.
  await writeFile(transcript, line({ type: 'ai-title', aiTitle: 'New title', sessionId: claude.sessionId }));
  assert.equal((await readSessionNames([claude], env)).get(ownerKey(claude)), 'New title');
});

test('missing, malformed and unnamed metadata never hides an agent or invents a name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-session-names-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root };
  const owners: Owner[] = [{ agent: 'codex', sessionId: randomUUID() }, { agent: 'claude', sessionId: randomUUID() }];
  assert.equal((await readSessionNames(owners, env)).size, 0);
  await writeFile(join(root, 'session_index.jsonl'), '{bad json}\n' + JSON.stringify({ id: owners[0].sessionId, thread_name: 123 }));
  const project = join(root, 'projects', 'different-worktree'); await mkdir(project, { recursive: true });
  await writeFile(join(project, owners[1].sessionId + '.jsonl'), JSON.stringify({ type: 'user', sessionId: owners[1].sessionId, message: 'Not a session title' }));
  assert.equal((await readSessionNames(owners, env)).size, 0);
});
