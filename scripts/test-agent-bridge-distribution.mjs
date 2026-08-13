import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_BRIDGE_RELEASE_REPOSITORY,
  AGENT_BRIDGE_RELEASE_WORKFLOW,
  assertAgentBridgeReleaseManifest,
  assertAgentBridgeReleaseTag,
  parseNpmPackMetadata,
  verifyAgentBridgeReleaseFiles,
} from './lib/agent-bridge-distribution.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tunacad-agent-bridge-distribution-'));
const outputRoot = path.resolve(temporaryRoot, 'release');
const consumerRoot = path.resolve(temporaryRoot, 'consumer');

try {
  requireSuccess(run(process.execPath, [
    'scripts/build-agent-bridge-release.mjs',
    '--output', outputRoot,
    '--source-commit', 'a'.repeat(40),
    '--release-tag', 'agent-bridge-v0.2.8',
  ], {
    env: {
      ...process.env,
      npm_config_cache: path.resolve(temporaryRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  }), 'Release candidate build');

  const manifestPath = path.resolve(outputRoot, 'agent-bridge-release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const tarballPath = path.resolve(outputRoot, manifest.package.tarballFileName);
  const tarballBytes = await readFile(tarballPath);
  const assemblyPath = path.resolve(outputRoot, 'ASSEMBLY.json');
  const assemblyBytes = await readFile(assemblyPath);
  assert.doesNotThrow(() => verifyAgentBridgeReleaseFiles({ manifest, tarballBytes, assemblyBytes }));
  requireSuccess(run(process.execPath, [
    'scripts/verify-agent-bridge-release.mjs',
    '--manifest', manifestPath,
    '--assembly', assemblyPath,
  ]), 'Release digest verifier CLI');
  assert.equal(manifest.source.repository, AGENT_BRIDGE_RELEASE_REPOSITORY);
  assert.equal(manifest.source.workflow, AGENT_BRIDGE_RELEASE_WORKFLOW);
  assert.equal(manifest.package.exactSpecifier, '@tunacad/agent-bridge@0.2.8');

  const tampered = Buffer.from(tarballBytes);
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  assert.throws(
    () => verifyAgentBridgeReleaseFiles({ manifest, tarballBytes: tampered, assemblyBytes }),
    /digest verification failed/,
  );
  assert.throws(() => assertAgentBridgeReleaseManifest({
    ...manifest,
    trustPolicy: { ...manifest.trustPolicy, npmSigstoreProvenanceRequired: false },
  }), /trust policy/);
  assert.throws(() => assertAgentBridgeReleaseTag('v0.2.8', '0.2.8'), /agent-bridge-v0.2.8/);
  const npmPackFixture = {
    name: '@tunacad/agent-bridge',
    version: '0.2.8',
    filename: 'tunacad-agent-bridge-0.2.8.tgz',
    integrity: 'sha512-fixture',
    files: [],
  };
  assert.deepEqual(parseNpmPackMetadata(JSON.stringify([npmPackFixture])), npmPackFixture);
  assert.deepEqual(parseNpmPackMetadata(JSON.stringify(npmPackFixture)), npmPackFixture);
  assert.deepEqual(parseNpmPackMetadata(JSON.stringify({
    '@tunacad/agent-bridge': npmPackFixture,
  })), npmPackFixture);
  assert.throws(() => parseNpmPackMetadata('[]'), /exactly one package/);
  assert.throws(() => parseNpmPackMetadata('{}'), /exactly one package/);
  assert.throws(() => parseNpmPackMetadata(JSON.stringify({
    'wrong-package': npmPackFixture,
  })), /package key/);

  await writeFile(path.resolve(temporaryRoot, 'preserved-codex-config.toml'), 'model = "unchanged"\n', 'utf8');
  await writeFile(path.resolve(temporaryRoot, 'preserved-cursor-state.json'), '{"schemaVersion":1,"sessions":{}}\n', 'utf8');
  await mkdir(consumerRoot);
  await writeFile(path.resolve(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'tunacad-agent-bridge-uninstall-fixture',
    private: true,
  }, null, 2)}\n`, 'utf8');
  requireSuccess(runNpm(['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
    cwd: consumerRoot,
  }), 'Exact local release installation');
  const installedPackage = path.resolve(consumerRoot, 'node_modules/@tunacad/agent-bridge/package.json');
  assert.equal(JSON.parse(await readFile(installedPackage, 'utf8')).version, '0.2.8');
  requireSuccess(runNpm(['uninstall', '--no-audit', '--no-fund', '@tunacad/agent-bridge'], {
    cwd: consumerRoot,
  }), 'Local release uninstall');
  await assert.rejects(readFile(installedPackage), (error) => error?.code === 'ENOENT');
  assert.equal(await readFile(path.resolve(temporaryRoot, 'preserved-codex-config.toml'), 'utf8'), 'model = "unchanged"\n');
  assert.equal(await readFile(path.resolve(temporaryRoot, 'preserved-cursor-state.json'), 'utf8'), '{"schemaVersion":1,"sessions":{}}\n');

  const packageJson = JSON.parse(await readFile(path.resolve(repositoryRoot, 'agent-bridge/package.json'), 'utf8'));
  assert.equal(packageJson.repository.url, 'git+https://github.com/JNaruto-mar/TunaCAD-Agent-Bridge.git');
  const workflow = await readFile(path.resolve(repositoryRoot, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /environment:\s*agent-bridge-production/);
  assert.match(workflow, /npm@11\.19\.0/);
  assert.doesNotMatch(workflow, /npm@latest/);
  assert.match(workflow, /npm publish/);
  assert.match(workflow, /npm audit signatures/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);

  process.stdout.write('[agent-bridge] OIDC release, attestations, digest verification, exact update, and non-destructive uninstall fixtures passed.\n');
} finally {
  const resolved = path.resolve(temporaryRoot);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  await rm(resolved, { recursive: true, force: true });
}

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

function runNpm(args, options = {}) {
  const invocation = process.env.npm_execpath
    ? { command: process.execPath, prefix: [process.env.npm_execpath] }
    : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
  return run(invocation.command, [...invocation.prefix, ...args], {
    ...options,
    env: {
      ...process.env,
      npm_config_cache: path.resolve(temporaryRoot, 'npm-cache'),
      npm_config_update_notifier: 'false',
      ...options.env,
    },
  });
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
