import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAgentBridgeReleaseTag,
  createAgentBridgeReleaseManifest,
} from './lib/agent-bridge-distribution.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageRoot = path.resolve(repositoryRoot, 'agent-bridge');
const options = parseOptions(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(path.resolve(packageRoot, 'package.json'), 'utf8'));
if (options.releaseTag) assertAgentBridgeReleaseTag(options.releaseTag, packageJson.version);

const outputRoot = path.resolve(repositoryRoot, options.output);
await mkdir(outputRoot, { recursive: true });
if ((await readdir(outputRoot)).length !== 0) {
  throw new Error('Release output directory must be empty; refusing to overwrite existing evidence.');
}

requireSuccess(run(process.execPath, ['agent-bridge/scripts/prepare-package.mjs']), 'Companion assembly');
const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', outputRoot], { cwd: packageRoot });
requireSuccess(packed, 'Companion release pack');
const [metadata] = JSON.parse(packed.stdout);
const tarballPath = path.resolve(outputRoot, metadata.filename);
const assemblyPath = path.resolve(packageRoot, 'dist/ASSEMBLY.json');
const tarballBytes = await readFile(tarballPath);
const assemblyBytes = await readFile(assemblyPath);
if (metadata.integrity !== `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`) {
  throw new Error('npm pack integrity does not match the release tarball.');
}

const manifest = createAgentBridgeReleaseManifest({
  packageName: metadata.name,
  packageVersion: metadata.version,
  tarballFileName: metadata.filename,
  tarballBytes,
  assemblyBytes,
  sourceCommit: options.sourceCommit,
});
await writeFile(
  path.resolve(outputRoot, 'agent-bridge-release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
await copyFile(assemblyPath, path.resolve(outputRoot, 'ASSEMBLY.json'));
process.stdout.write(`[agent-bridge] Release candidate built: ${metadata.filename} (${tarballBytes.byteLength} bytes).\n`);

function parseOptions(args) {
  const read = (name, fallback) => {
    const direct = args.find((arg) => arg.startsWith(`--${name}=`));
    const index = args.indexOf(`--${name}`);
    return direct?.slice(name.length + 3) ?? (index >= 0 ? args[index + 1] : fallback);
  };
  return {
    output: read('output', 'artifacts/agent-bridge-release'),
    sourceCommit: read('source-commit', process.env.GITHUB_SHA ?? resolveGitCommit()),
    releaseTag: read('release-tag'),
  };
}

function resolveGitCommit() {
  const result = run('git', ['rev-parse', 'HEAD']);
  requireSuccess(result, 'Git source revision lookup');
  return result.stdout.trim();
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
  return run(invocation.command, [...invocation.prefix, ...args], options);
}

function requireSuccess(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
