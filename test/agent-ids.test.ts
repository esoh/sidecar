import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, rename, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openAgentIds } from '../src/agent-ids.ts';

const owner = 'codex-00000000-0000-4000-8000-000000000001';
const other = 'claude-00000000-0000-4000-8000-000000000002';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-ids-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'agent-ids'), file = join(directory, 'registry.json');
  return { root, directory, file, ids: await openAgentIds(root) };
}

test('aliases and frozen delivery format survive reopen without rewriting known mappings', async t => {
  const { ids, root, file } = await fixture(t);
  await ids.allocate(owner, [{ kind: 'r', id: 'request' }], { requestId: 'request', format: 'compact-v1' });
  assert.equal(ids.encode(owner, 'r', 'request'), 'r1');
  assert.equal(await ids.resolve(owner, 'r', 'r1'), 'request');
  assert.equal(await ids.resolveOwner(ids.encode(owner, 'o', owner)), owner);
  const before = await stat(file);
  await ids.allocate(owner, [{ kind: 'r', id: 'request' }]);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  const reopened = await openAgentIds(root);
  assert.equal(reopened.encode(owner, 'r', 'request'), 'r1');
  assert.equal(await reopened.deliveryFormat(owner, 'request'), 'compact-v1');
  await assert.rejects(reopened.allocate(owner, [], { requestId: 'request', format: 'legacy' }), /format/i);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('base36 boundaries are canonical and counters are independent', async t => {
  const { ids } = await fixture(t);
  await ids.allocate(owner, Array.from({ length: 36 }, (_, i) => ({ kind: 'r', id: `request-${i + 1}` })));
  for (const [number, alias] of [[9, 'r9'], [10, 'rA'], [35, 'rZ'], [36, 'r10']] as const) assert.equal(ids.encode(owner, 'r', `request-${number}`), alias);
  await ids.allocate(other, [{ kind: 'r', id: 'request-1' }, { kind: 'd', id: 'document' }]);
  assert.equal(ids.encode(other, 'r', 'request-1'), 'r11');
  assert.equal(ids.encode(other, 'd', 'document'), 'd1');
  assert.equal(ids.encode(other, 'o', other), 'o2');
});

test('wrong owner and kind fail and invalid or unknown aliases cannot be resolved', async t => {
  const { ids } = await fixture(t);
  await ids.allocate(owner, [{ kind: 'r', id: 'request' }]);
  await assert.rejects(ids.resolve(other, 'r', 'r1'), /owner/i);
  for (const alias of ['r0', 'r01', 'ra', 'r!', 'rZZZZZZZZZZZZ', 'r2', 'd1']) await assert.rejects(ids.resolve(owner, 'r', alias), /alias/i);
  await assert.rejects(ids.resolveOwner('r1'), /alias/i);
  assert.throws(() => ids.encode(owner, 'r', 'missing'), /allocat/i);
});

test('processes preserve globally unique allocations and refresh stale caches', async t => {
  const { ids, root } = await fixture(t);
  const module = new URL('../src/agent-ids.ts', import.meta.url).href;
  const script = `import {openAgentIds} from ${JSON.stringify(module)}; const ids = await openAgentIds(process.argv[1]); const n = process.argv[2]; await ids.allocate(${JSON.stringify(owner)}, Array.from({length:20}, (_, i) => ({kind:'r',id:n+'-'+i}))); await ids.allocate(${JSON.stringify(other)}, [{kind:'d',id:n}]);`;
  await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, String(i)])));
  assert.ok(await ids.resolve(owner, 'r', 'r3C'));
  const reopened = await openAgentIds(root), aliases = new Set<string>();
  for (let n = 0; n < 6; n++) for (let i = 0; i < 20; i++) aliases.add(reopened.encode(owner, 'r', `${n}-${i}`));
  assert.equal(aliases.size, 120);
  for (let n = 0; n < 6; n++) assert.ok(reopened.encode(other, 'd', String(n)));
  await ids.allocate(owner, [{ kind: 'r', id: 'after' }]);
  assert.equal(ids.encode(owner, 'r', 'after'), 'r3D');
});

test('deletion and history restore do not reset registry counters', async t => {
  const { root, ids } = await fixture(t), directory = join(root, owner);
  await mkdir(directory); await writeFile(join(directory, 'state.json'), '{}');
  await ids.allocate(owner, [{ kind: 'd', id: 'old' }]);
  await rm(directory, { recursive: true });
  await mkdir(directory); await writeFile(join(directory, 'state.json'), '{}');
  const reopened = await openAgentIds(root);
  await reopened.allocate(owner, [{ kind: 'd', id: 'new' }]);
  assert.equal(reopened.encode(owner, 'd', 'old'), 'd1');
  assert.equal(reopened.encode(owner, 'd', 'new'), 'd2');
});

test('counter exhaustion does not publish or wrap', async t => {
  const { root, file } = await fixture(t);
  const saved = JSON.parse(await readFile(file, 'utf8')); saved.next.r = Number.MAX_SAFE_INTEGER;
  await writeFile(file, JSON.stringify(saved)); const before = await readFile(file, 'utf8');
  const ids = await openAgentIds(root);
  await assert.rejects(ids.allocate(owner, [{ kind: 'r', id: 'overflow' }]), /exhaust/i);
  assert.throws(() => ids.encode(owner, 'r', 'overflow'), /allocat/i);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('failed write does not publish an alias', async t => {
  const { ids, directory, file } = await fixture(t);
  await ids.allocate(owner, [{ kind: 'r', id: 'old' }]);
  const before = await readFile(file, 'utf8');
  // Deny temporary-file creation while leaving the last good registry readable.
  await import('node:fs/promises').then(fs => fs.chmod(directory, 0o500));
  try { await assert.rejects(ids.allocate(owner, [{ kind: 'r', id: 'new' }])); }
  finally { await import('node:fs/promises').then(fs => fs.chmod(directory, 0o700)); }
  assert.throws(() => ids.encode(owner, 'r', 'new'), /allocat/i);
  assert.equal(await readFile(file, 'utf8'), before);
  await ids.allocate(owner, [{ kind: 'r', id: 'new' }]);
  assert.equal(ids.encode(owner, 'r', 'new'), 'r2');
});

test('interrupted initialization recovers without resetting initialized data', async t => {
  const { ids, root, directory } = await fixture(t);
  await ids.allocate(owner, [{ kind: 'r', id: 'old' }]);
  await rm(join(directory, 'initialized'));
  const reopened = await openAgentIds(root);
  assert.equal(reopened.encode(owner, 'r', 'old'), 'r1');
  assert.equal(await readFile(join(directory, 'initialized'), 'utf8'), '1\n');
});

test('an initialized missing or corrupt registry never resets', async t => {
  const { root, file } = await fixture(t);
  await rename(file, `${file}.saved`);
  await assert.rejects(openAgentIds(root), /registry/i);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await writeFile(file, 'broken');
  await assert.rejects(openAgentIds(root), /registry/i);
  assert.equal(await readFile(file, 'utf8'), 'broken');
});

test('invalid mapping, counters and future versions are preserved and refused', async t => {
  const { ids, root, file } = await fixture(t);
  await ids.allocate(owner, [{ kind: 'r', id: 'request' }]);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const invalid = [
    { ...saved, version: 2 },
    { ...saved, next: { ...saved.next, r: 1 } },
    { ...saved, next: { ...saved.next, r: 3 }, ids: { ...saved.ids, r2: saved.ids.r1 } },
    { ...saved, ids: { ...saved.ids, r1: { owner: other, id: 'request' } } },
    { ...saved, deliveries: { r2: 'legacy' } },
  ];
  for (const value of invalid) {
    const raw = JSON.stringify(value); await writeFile(file, raw);
    await assert.rejects(openAgentIds(root), /registry/i);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});
