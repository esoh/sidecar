import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from './owner-lock.ts';
import { DomainError, isObject } from './store.ts';

const kinds = ['o', 'r', 'd', 't', 'm', 'e', 's', 'p', 'v'] as const;
export type IdKind = typeof kinds[number];
export type IdRef = { kind: IdKind; id: string };
export type DeliveryFormat = 'legacy' | 'compact-v1';
export type AgentIds = {
  allocate(ownerKey: string, refs: readonly IdRef[], delivery?: { requestId: string; format: DeliveryFormat }): Promise<void>;
  encode(ownerKey: string, kind: IdKind, canonicalId: string): string;
  resolve(ownerKey: string, kind: IdKind, alias: string): Promise<string>;
  resolveOwner(alias: string): Promise<string>;
  deliveryFormat(ownerKey: string, requestId: string): Promise<DeliveryFormat | undefined>;
};
type Registry = { version: 1; next: Record<IdKind, number>; ids: Record<string, { owner: string; id: string }>; deliveries: Record<string, DeliveryFormat> };
const writes = new Map<string, Promise<unknown>>();
const counters = (): Record<IdKind, number> => ({ o: 1, r: 1, d: 1, t: 1, m: 1, e: 1, s: 1, p: 1, v: 1 });
const canonicalOwner = (value: string) => /^(codex|claude)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const refKey = (owner: string, kind: IdKind, id: string) => JSON.stringify([owner, kind, id]);
const registryError = () => new DomainError('Sidecar agent ID registry is missing or invalid. Restore its central bookkeeping from backup; do not reset its counters.', 503);
function aliasKind(alias: string): IdKind | undefined {
  const kind = kinds.find(kind => alias.startsWith(kind));
  const digits = alias.slice(1), number = Number.parseInt(digits, 36);
  return kind && /^[1-9A-Z][0-9A-Z]*$/.test(digits) && Number.isSafeInteger(number) && number > 0 && number.toString(36).toUpperCase() === digits ? kind : undefined;
}
export function isAgentAlias(value: string, kind: IdKind): boolean { return aliasKind(value) === kind; }
function validate(value: unknown): Registry {
  if (!isObject(value) || value.version !== 1 || !isObject(value.next) || !isObject(value.ids) || !isObject(value.deliveries)) throw registryError();
  const registry: Registry = { version: 1, next: counters(), ids: {}, deliveries: {} };
  for (const kind of kinds) {
    const next = value.next[kind];
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 1) throw registryError();
    registry.next[kind] = next;
  }
  const canonical = new Set<string>(), owners = new Set<string>();
  for (const [alias, entry] of Object.entries(value.ids)) {
    const kind = aliasKind(alias);
    if (!kind || !isObject(entry) || typeof entry.owner !== 'string' || !canonicalOwner(entry.owner) || typeof entry.id !== 'string' || !entry.id || registry.next[kind] <= Number.parseInt(alias.slice(1), 36)) throw registryError();
    const key = refKey(entry.owner, kind, entry.id);
    if (canonical.has(key)) throw registryError();
    canonical.add(key);
    if (kind === 'o') { if (entry.id !== entry.owner) throw registryError(); owners.add(entry.owner); }
    registry.ids[alias] = { owner: entry.owner, id: entry.id };
  }
  for (const entry of Object.values(registry.ids)) if (!owners.has(entry.owner)) throw registryError();
  for (const [alias, format] of Object.entries(value.deliveries)) {
    if (aliasKind(alias) !== 'r' || !registry.ids[alias] || (format !== 'legacy' && format !== 'compact-v1')) throw registryError();
    registry.deliveries[alias] = format;
  }
  return registry;
}
async function readOptional(file: string) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}
async function persist(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function openAgentIds(stateRoot: string): Promise<AgentIds> {
  const directory = resolve(stateRoot, 'agent-ids'), file = join(directory, 'registry.json'), marker = join(directory, 'initialized');
  let cached: Registry, byCanonical = new Map<string, string>();
  function cache(registry: Registry) {
    cached = registry;
    byCanonical = new Map(Object.entries(registry.ids).map(([alias, entry]) => [refKey(entry.owner, aliasKind(alias)!, entry.id), alias]));
  }
  async function read(initialize = false) {
    const [raw, initialized] = await Promise.all([readOptional(file), readOptional(marker)]);
    if (initialized !== undefined && initialized !== '1\n' || raw === undefined && (initialized !== undefined || !initialize)) throw registryError();
    let registry: Registry;
    try { registry = raw === undefined ? { version: 1, next: counters(), ids: {}, deliveries: {} } : validate(JSON.parse(raw)); }
    catch { throw registryError(); }
    if (initialize) {
      if (raw === undefined) await persist(file, JSON.stringify(registry) + '\n');
      if (initialized === undefined) await persist(marker, '1\n');
    } else if (initialized === undefined) throw registryError();
    return registry;
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const run = (writes.get(directory) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 5000;
      let release = await acquireLock(directory);
      while (!release) {
        if (Date.now() >= deadline) throw new DomainError('Sidecar agent ID registry is busy. Check its owner.lock and retry; no IDs were issued.', 503);
        await delay(20); release = await acquireLock(directory);
      }
      try { return await work(); } finally { await release(); }
    });
    writes.set(directory, run);
    try { return await run; } finally { if (writes.get(directory) === run) writes.delete(directory); }
  }
  await locked(async () => cache(await read(true)));
  async function lookup(alias: string, kind: IdKind, owner?: string) {
    if (!isAgentAlias(alias, kind)) throw new DomainError('Invalid Sidecar ID alias');
    if (!cached.ids[alias]) cache(await read());
    const entry = cached.ids[alias];
    if (!entry) throw new DomainError('Unknown Sidecar ID alias', 404);
    if (owner !== undefined && entry.owner !== owner) throw new DomainError('Sidecar ID alias belongs to another owner', 403);
    return entry.id;
  }
  return {
    async allocate(owner, refs, delivery) {
      if (!canonicalOwner(owner)) throw new DomainError('Invalid Sidecar registry owner');
      await locked(async () => {
        const next = await read(), index = new Map(Object.entries(next.ids).map(([alias, entry]) => [refKey(entry.owner, aliasKind(alias)!, entry.id), alias]));
        let changed = false;
        const allocate = ({ kind, id }: IdRef) => {
          if (!kinds.includes(kind) || !id || kind === 'o' && id !== owner) throw new DomainError('Invalid Sidecar ID reference');
          const key = refKey(owner, kind, id), existing = index.get(key);
          if (existing) return existing;
          const number = next.next[kind];
          if (number >= Number.MAX_SAFE_INTEGER) throw new DomainError('Sidecar ID counter exhausted; no IDs were issued', 503);
          const alias = kind + number.toString(36).toUpperCase();
          next.next[kind]++; next.ids[alias] = { owner, id }; index.set(key, alias); changed = true;
          return alias;
        };
        allocate({ kind: 'o', id: owner });
        for (const ref of refs) allocate(ref);
        if (delivery) {
          const alias = allocate({ kind: 'r', id: delivery.requestId });
          if (next.deliveries[alias] && next.deliveries[alias] !== delivery.format) throw new DomainError('Cannot change a prepared Sidecar delivery format', 409);
          if (!next.deliveries[alias]) { next.deliveries[alias] = delivery.format; changed = true; }
        }
        if (changed) await persist(file, JSON.stringify(next) + '\n');
        cache(next);
      });
    },
    encode(owner, kind, id) {
      const alias = byCanonical.get(refKey(owner, kind, id));
      if (!alias) throw new DomainError('Sidecar ID has not been allocated', 409);
      return alias;
    },
    resolve: (owner, kind, alias) => lookup(alias, kind, owner),
    resolveOwner: alias => lookup(alias, 'o'),
    async deliveryFormat(owner, requestId) {
      let alias = byCanonical.get(refKey(owner, 'r', requestId));
      if (!alias || !cached.deliveries[alias]) { cache(await read()); alias = byCanonical.get(refKey(owner, 'r', requestId)); }
      return alias ? cached.deliveries[alias] : undefined;
    },
  };
}
