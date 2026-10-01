import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { forwardHook } from '../src/cli.ts';
import { ownerKey } from '../src/store.ts';

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent} compaction hooks are owner-scoped, transient, and never invent cancellation`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sidecar-hooks-'));
    const owner = { agent, sessionId: randomUUID() }, key = ownerKey(owner), directory = join(root, key);
    const previous = process.env.SIDECAR_STATE_DIR;
    process.env.SIDECAR_STATE_DIR = root;
    let server = await startServer({ owner, directory });
    t.after(async () => { process.env.SIDECAR_STATE_DIR = previous; if (previous === undefined) delete process.env.SIDECAR_STATE_DIR; await server.close(); await rm(root, { recursive: true, force: true }); });
    const runtime = () => writeFile(join(directory, 'runtime.json'), JSON.stringify({ url: server.url, instanceId: server.instanceId, ownerKey: key }));
    await runtime();
    const snapshot = async () => {
      const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0]!;
      return (await fetch(server.url + '/api/state', { headers: { Cookie: cookie } })).json();
    };
    await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'PreCompact' });
    assert.equal((await snapshot()).activity, 'compacting');
    await forwardHook(agent, { session_id: randomUUID(), hook_event_name: 'PostCompact' });
    assert.equal((await snapshot()).activity, 'compacting');
    const token = await readFile(join(directory, 'agent-token'), 'utf8');
    const forged = await fetch(server.url + '/agent/lifecycle', { method: 'POST', headers: { 'X-Sidecar-Token': token }, body: JSON.stringify({ ownerKey: `${agent}-${randomUUID()}`, event: 'compaction-completed' }) });
    assert.equal(forged.status, 409);
    await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'PostCompact' });
    assert.equal((await snapshot()).activity, 'unknown');
    await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'CompactCancelled' });
    assert.equal((await snapshot()).activity, 'unknown');
    await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'PreCompact' });
    if (agent === 'codex') {
      await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'Interrupt', turn_id: 'turn-test' });
      assert.equal((await snapshot()).activity, 'unknown');
      assert.equal((await snapshot()).lastLifecycle.event, 'interrupted');
      await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'PreCompact' });
    }
    await server.close(); server = await startServer({ owner, directory }); await runtime();
    assert.equal((await snapshot()).activity, 'unknown');
    await server.close();
    await forwardHook(agent, { session_id: owner.sessionId, hook_event_name: 'PreCompact' });
    await forwardHook(agent, { session_id: randomUUID(), hook_event_name: 'PreCompact' });
  });
}
