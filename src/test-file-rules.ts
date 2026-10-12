import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, isObject } from './store.ts';

export type TestFileRules = { include?: string[]; exclude?: string[] };
export const DEFAULT_TEST_PATTERNS = [
  '**/{test,tests,Test,Tests,__tests__,spec,specs}/**',
  '**/{__snapshots__,__fixtures__}/**',
  '**/*.{test,spec}.*', '**/test_*.py', '**/*_test.*', '**/*_spec.rb',
  '**/{Test*,*Test,*Tests}.{java,kt,cs}', '**/*Tests.swift',
];

export function isTestFile(path: string, rules: TestFileRules = {}): boolean {
  const matches = (pattern: string) => posix.matchesGlob(path.replaceAll('\\', '/'), pattern);
  return !rules.exclude?.some(matches) && [...DEFAULT_TEST_PATTERNS, ...(rules.include ?? [])].some(matches);
}

export function parseTestFileRules(value: unknown): TestFileRules {
  const invalid = () => new DomainError('Use include/exclude arrays with at most 100 nonempty glob patterns, up to 512 characters each.');
  if (!isObject(value) || Object.keys(value).some(k => !['include', 'exclude'].includes(k))) throw invalid();
  const result: TestFileRules = {};
  for (const field of ['include', 'exclude'] as const) {
    const patterns = value[field];
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || patterns.length > 100 || !patterns.every(p => typeof p === 'string' && p.length > 0 && p.length <= 512 && !/[\x00-\x1f]/.test(p))) throw invalid();
    result[field] = patterns;
  }
  return result;
}

// Common Git identity shares settings across worktrees; separate files isolate repositories.
async function settingsLocation(gitCommonDir: string) {
  const repository = await realpath(gitCommonDir);
  const configDir = process.env.SIDECAR_CONFIG ? dirname(process.env.SIDECAR_CONFIG)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'sidecar');
  const key = createHash('sha256').update(repository).digest('hex');
  return { repository, path: join(configDir, 'repositories', `${key}.json`) };
}
export async function readTestFileRules(gitCommonDir: string): Promise<TestFileRules> {
  const { repository, path } = await settingsLocation(gitCommonDir);
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}; throw new Error(`Cannot read test file rules: ${path}`); }
  if (content.length > 131072) throw new DomainError('Test file rules exceed 128 KiB.');
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new DomainError(`Invalid JSON in ${path}`); }
  if (!isObject(value) || value.repository !== repository) throw new DomainError(`Invalid repository identity in ${path}`);
  return parseTestFileRules(value.testFiles);
}
export async function writeTestFileRules(gitCommonDir: string, input: unknown): Promise<TestFileRules> {
  const testFiles = parseTestFileRules(input);
  const { repository, path } = await settingsLocation(gitCommonDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ repository, testFiles }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return testFiles;
}
