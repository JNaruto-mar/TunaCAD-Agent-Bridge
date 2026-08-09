import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, '..');
const outputRoot = path.resolve(packageRoot, 'dist');
if (path.dirname(outputRoot) !== packageRoot || path.basename(outputRoot) !== 'dist') {
  throw new Error('Refusing to assemble the companion outside agent-bridge/dist.');
}

const sources = [
  'agent-bridge/bin/tunacad-agent-bridge.mjs',
  'agent-bridge/src/agent-bridge-runtime.mjs',
  'agent-bridge/src/codex-app-server-adapter.mjs',
  'agent-bridge/src/cursor-store.mjs',
  'agent-bridge/src/relay-client.mjs',
  'agent-bridge/src/relay-connection-supervisor.mjs',
  'scripts/lib/codex-app-server-client.mjs',
  'src/aiAgent/bridgeCompatibility.mjs',
  'src/aiAgent/bridgeProtocol.mjs',
  'src/aiAgent/codexEventMapper.mjs',
  'src/aiAgent/codexRequestTracker.mjs',
  'src/aiAgent/relayControl.mjs',
];

await rm(outputRoot, { recursive: true, force: true });
const files = [];
for (const relativePath of sources) {
  const source = path.resolve(repositoryRoot, relativePath);
  if (!source.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error(`Unsafe package source ${relativePath}.`);
  const destination = path.resolve(outputRoot, relativePath);
  if (!destination.startsWith(`${outputRoot}${path.sep}`)) throw new Error(`Unsafe package destination ${relativePath}.`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const bytes = await readFile(destination);
  files.push({
    path: relativePath.replaceAll('\\', '/'),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const executable = path.resolve(outputRoot, 'agent-bridge/bin/tunacad-agent-bridge.mjs');
await chmod(executable, 0o755);
const packageJson = JSON.parse(await readFile(path.resolve(packageRoot, 'package.json'), 'utf8'));
const assembly = {
  schemaVersion: 1,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  protocol: 'tunacad.agent-bridge/1',
  files,
};
await writeFile(
  path.resolve(outputRoot, 'ASSEMBLY.json'),
  `${JSON.stringify(assembly, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o644 },
);

console.log(`[agent-bridge] Assembled ${files.length} runtime files in agent-bridge/dist.`);
