import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageRoot = path.resolve(repositoryRoot, 'agent-bridge');
const assemblyPath = path.resolve(packageRoot, 'dist/ASSEMBLY.json');
const npmInvocation = process.env.npm_execpath
  ? { command: process.execPath, prefix: [process.env.npm_execpath] }
  : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, description) {
  assert.equal(
    result.status,
    0,
    `${description} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function normalize(value) {
  return value.replaceAll('\\', '/');
}

function runNpm(args, options = {}) {
  const cacheRoot = path.resolve(temporaryRoot, 'npm-cache');
  return run(npmInvocation.command, [...npmInvocation.prefix, ...args], {
    ...options,
    env: {
      ...process.env,
      npm_config_cache: cacheRoot,
      npm_config_update_notifier: 'false',
      ...options.env,
    },
  });
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tunacad-agent-bridge-package-'));
try {
  const prepare = run(process.execPath, ['agent-bridge/scripts/prepare-package.mjs']);
  requireSuccess(prepare, 'Companion assembly');
  const firstAssemblyText = await readFile(assemblyPath, 'utf8');
  const assembly = JSON.parse(firstAssemblyText);
  const packageJson = JSON.parse(await readFile(path.resolve(packageRoot, 'package.json'), 'utf8'));
  const shrinkwrap = JSON.parse(await readFile(path.resolve(packageRoot, 'npm-shrinkwrap.json'), 'utf8'));

  assert.equal(assembly.schemaVersion, 1);
  assert.equal(assembly.packageName, '@tunacad/agent-bridge');
  assert.equal(assembly.packageVersion, packageJson.version);
  assert.equal(assembly.protocol, 'tunacad.agent-bridge/1');
  assert.equal(assembly.files.length, 16);
  assert.equal(new Set(assembly.files.map((file) => file.path)).size, assembly.files.length);
  assert.deepEqual(shrinkwrap.packages[''].dependencies, packageJson.dependencies);
  assert.equal(shrinkwrap.packages[''].version, packageJson.version);

  const generatedPaths = new Set(assembly.files.map((file) => normalize(file.path)));
  for (const file of assembly.files) {
    const bytes = await readFile(path.resolve(packageRoot, 'dist', file.path));
    assert.equal(bytes.byteLength, file.bytes, `${file.path} byte count changed after assembly.`);
    assert.equal(digest('sha256', bytes, 'hex'), file.sha256, `${file.path} checksum mismatch.`);
  }

  const secondPrepare = run(process.execPath, ['agent-bridge/scripts/prepare-package.mjs']);
  requireSuccess(secondPrepare, 'Repeated companion assembly');
  assert.equal(
    await readFile(assemblyPath, 'utf8'),
    firstAssemblyText,
    'Companion assembly manifest must be deterministic.',
  );

  const relativeImportPattern = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g;
  const allowedExternalImports = new Set(['ws', 'zod/v4']);
  for (const file of assembly.files.filter((entry) => entry.path.endsWith('.mjs'))) {
    const source = await readFile(path.resolve(packageRoot, 'dist', file.path), 'utf8');
    for (const match of source.matchAll(relativeImportPattern)) {
      const resolved = normalize(path.normalize(path.join(path.dirname(file.path), match[1])));
      assert.ok(generatedPaths.has(resolved), `${file.path} imports missing packaged file ${resolved}.`);
    }
    for (const match of source.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || allowedExternalImports.has(specifier),
        `${file.path} has undeclared external import ${specifier}.`,
      );
    }
  }

  const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot], {
    cwd: packageRoot,
  });
  requireSuccess(packed, 'npm pack');
  const [metadata] = JSON.parse(packed.stdout);
  assert.equal(metadata.name, '@tunacad/agent-bridge');
  assert.match(metadata.integrity, /^sha512-/);
  assert.ok(metadata.size < 250_000, `Companion tarball unexpectedly large: ${metadata.size} bytes.`);

  const archivePath = path.resolve(temporaryRoot, metadata.filename);
  const archive = await readFile(archivePath);
  assert.equal(`sha512-${digest('sha512', archive, 'base64')}`, metadata.integrity);
  assert.equal(digest('sha1', archive, 'hex'), metadata.shasum);

  const packedPaths = new Set(metadata.files.map((file) => normalize(file.path)));
  const requiredPaths = [
    'package.json',
    'README.md',
    'LICENSE',
    'npm-shrinkwrap.json',
    'dist/ASSEMBLY.json',
    ...assembly.files.map((file) => `dist/${normalize(file.path)}`),
  ];
  for (const requiredPath of requiredPaths) {
    assert.ok(packedPaths.has(requiredPath), `Tarball is missing ${requiredPath}.`);
  }
  for (const packedPath of packedPaths) {
    assert.doesNotMatch(packedPath, /(^|\/)(?:\.env[^/]*|.*\.log|tokens?|credentials?)(?:\/|$)/i);
    assert.ok(
      packedPath.startsWith('dist/') || requiredPaths.includes(packedPath),
      `Tarball includes unexpected source file ${packedPath}.`,
    );
  }

  await writeFile(
    path.resolve(temporaryRoot, 'package.json'),
    `${JSON.stringify({ name: 'tunacad-agent-bridge-install-smoke', private: true }, null, 2)}\n`,
  );
  const installed = runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', archivePath],
    { cwd: temporaryRoot },
  );
  requireSuccess(installed, 'Tarball installation');

  const installedCli = path.resolve(
    temporaryRoot,
    'node_modules/@tunacad/agent-bridge/dist/agent-bridge/bin/tunacad-agent-bridge.mjs',
  );
  const smoke = run(process.execPath, [installedCli], { cwd: temporaryRoot });
  assert.equal(smoke.status, 1, `CLI without arguments should show usage.\n${smoke.stderr}`);
  assert.match(`${smoke.stdout}\n${smoke.stderr}`, /Usage:.*tunacad-agent-bridge/s);
  assert.doesNotMatch(`${smoke.stdout}\n${smoke.stderr}`, /ERR_MODULE_NOT_FOUND/);

  console.log(
    `[agent-bridge] Package artifact passed: ${metadata.files.length} files, ${metadata.size} bytes, ${metadata.integrity.slice(0, 28)}…`,
  );
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  assert.ok(
    resolvedTemporaryRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    'Refusing to remove a package test directory outside the OS temporary directory.',
  );
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
