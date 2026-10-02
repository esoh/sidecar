import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

function withInput(command: string, args: string[], cwd: string, input: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(error)));
    child.stdin.end(input);
  });
}

test('installer preserves a working release on failure and safely publishes an update', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-install-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'source repo'), tools = join(directory, 'tools');
  const install = join(directory, 'app data'), bin = join(directory, 'user bin');
  await mkdir(join(repository, 'scripts'), { recursive: true });
  await mkdir(join(repository, 'src'));
  await mkdir(tools);
  await copyFile(join(root, 'scripts/sidecar'), join(repository, 'scripts/sidecar'));
  await chmod(join(repository, 'scripts/sidecar'), 0o755);
  await writeFile(join(repository, 'src/cli.ts'), `
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (process.argv.includes('--version')) console.log('Sidecar ' + version);
else { let input = ''; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input })); }
`);
  // The installer test is offline; the separate clean-install smoke uses real pnpm.
  await writeFile(join(tools, 'pnpm'), `#!${process.execPath}\nconst fs = require('node:fs');
require('node:assert/strict').deepEqual(process.argv.slice(4), ['install', '--prod', '--frozen-lockfile']);
if (process.env.SIDECAR_TEST_FAIL_INSTALL) process.exit(17);
fs.symlinkSync(${JSON.stringify(join(root, 'node_modules'))}, process.argv[3] + '/node_modules', 'dir');
`);
  await chmod(join(tools, 'pnpm'), 0o755);
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Sidecar Test', '-c', 'user.email=sidecar@example.invalid', ...args], { cwd: repository });
  await git('init', '-b', 'main');
  const revision = async (version: string) => {
    await writeFile(join(repository, 'package.json'), JSON.stringify({ type: 'module', version }));
    await git('add', '.'); await git('commit', '-m', version);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  const first = await revision('0.1.0');
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, SIDECAR_REPOSITORY: repository, SIDECAR_INSTALL_DIR: install, SIDECAR_BIN_DIR: bin };
  const run = (extra = {}) => exec('bash', [join(root, 'install.sh')], { env: { ...env, ...extra } });
  await run(); await run(); // Installing the same revision again is idempotent.
  const command = join(bin, 'sidecar');
  const before = await readlink(join(install, 'current'));
  assert.equal(before, join(install, 'releases', first));
  assert.match((await exec(command, ['--version'])).stdout, /Sidecar 0.1.0/);
  assert.deepEqual(JSON.parse(await withInput(command, ['reply', 'id with spaces', '--stdin'], directory, 'body\n$(not-a-command)')), {
    args: ['reply', 'id with spaces', '--stdin'], cwd: directory, input: 'body\n$(not-a-command)',
  });
  const second = await revision('0.2.0');
  await assert.rejects(run({ SIDECAR_TEST_FAIL_INSTALL: '1' }));
  assert.equal(await readlink(join(install, 'current')), before);
  assert.match((await exec(command, ['--version'])).stdout, /Sidecar 0.1.0/);
  await chmod(bin, 0o555);
  try {
    await assert.rejects(run(), /EACCES|permission denied/i);
    assert.equal(await readlink(join(install, 'current')), before, 'publishing failure must retain the selected release');
  } finally { await chmod(bin, 0o755); }
  await run();
  assert.equal(await readlink(join(install, 'current')), join(install, 'releases', second));
  assert.match((await exec(command, ['--version'])).stdout, /Sidecar 0.2.0/);
  assert.match((await exec(join(before, 'scripts/sidecar'), ['--version'])).stdout, /Sidecar 0.1.0/);
  await rm(command); await writeFile(command, 'Unrelated command');
  await assert.rejects(run(), /Refusing to replace an unrelated command/);
  assert.equal(await readFile(command, 'utf8'), 'Unrelated command');
});

test('both native manifests load the canonical skill and share the application version', async () => {
  const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const host of ['claude', 'codex']) {
    const manifest = JSON.parse(await readFile(join(root, `.${host}-plugin/plugin.json`), 'utf8'));
    assert.equal(manifest.version, app.version);
    assert.equal(manifest.skills, './.agents/skills/');
    assert.match(await readFile(join(root, manifest.skills, 'sidecar/SKILL.md'), 'utf8'), /sidecar --version/);
  }
  assert.ok(app.dependencies.tsx, 'production installations need the TypeScript loader');
});
