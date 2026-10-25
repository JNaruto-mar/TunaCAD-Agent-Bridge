import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile,realpath,readdir,stat } from 'node:fs/promises';
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
  'agent-bridge/bin/companion.mjs',
  'agent-bridge/bin/companion-manager-host.mjs',
  'agent-bridge/bin/Open TunaCAD Companion.vbs',
  'agent-bridge/src/companion-manager.mjs',
  'agent-bridge/src/companion-manager-launcher.mjs',
  'agent-bridge/src/companion-manager-windows.ps1',
  'agent-bridge/src/companion-server.mjs',
  'agent-bridge/src/companion-simulation.mjs',
  'external/TunaCAD-Simulation-Bridge/simulation-bridge/trustedSimulationSession.mjs',
  'external/TunaCAD-Simulation-Bridge/simulation-bridge/electrostaticSlabLimits.mjs',
  'agent-bridge/src/companion-approval.mjs',
  'agent-bridge/src/companion-approval-windows.ps1',
  'agent-bridge/src/companion-trust-store.mjs',
  'agent-bridge/src/companion-discovery.mjs',
  'agent-bridge/src/agent-adapter-contract.mjs',
  'agent-bridge/src/agent-adapter-registry.mjs',
  'agent-bridge/src/agent-bridge-runtime.mjs',
  'agent-bridge/src/codex-app-server-adapter.mjs',
  'agent-bridge/src/gemini-cli-adapter.mjs',
  'agent-bridge/src/claude-cli-adapter.mjs',
  'agent-bridge/src/cursor-store.mjs',
  'agent-bridge/src/relay-client.mjs',
  'agent-bridge/src/relay-connection-supervisor.mjs',
  'scripts/lib/codex-app-server-client.mjs',
  'scripts/lib/codex-schema-compatibility.mjs',
  'src/aiAgent/bridgeCompatibility.mjs',
  'src/aiAgent/bridgeProtocol.mjs',
  'src/aiAgent/codexEventMapper.mjs',
  'src/aiAgent/codexRequestTracker.mjs',
  'src/aiAgent/reconnectPolicy.mjs',
  'src/aiAgent/relayControl.mjs',
];

// Assemble the canonical native runtime's dependency closure, not a second
// implementation. Resolve every source inside the public submodule boundary.
const bridgePrefix='external/TunaCAD-Simulation-Bridge/',bridgeRoot=await realpath(path.resolve(repositoryRoot,bridgePrefix));
const runtimeFiles=new Set(),pending=[path.join(bridgeRoot,'simulation-bridge/server.mts'),path.join(bridgeRoot,'simulation-bridge/providers.mts'),path.join(bridgeRoot,'simulation-bridge/providerSettings.mts'),path.join(bridgeRoot,'providers/openradioss/ExplicitBridgeRuntime.mts')];
const insideBridge=file=>{const r=path.relative(bridgeRoot,file);return r&&!r.startsWith('..')&&!path.isAbsolute(r);};
while(pending.length){const file=await realpath(pending.pop());if(!insideBridge(file))throw Error('Canonical runtime dependency escapes public Bridge');if(runtimeFiles.has(file))continue;runtimeFiles.add(file);
 const source=await readFile(file,'utf8');
 for(const match of source.matchAll(/(?:from\s*|import\s*\(|import\s*)['"](\.[^'"]+)['"]/g)){
  const candidate=path.resolve(path.dirname(file),match[1]);if(!insideBridge(candidate))throw Error('Canonical runtime import escapes public Bridge');let found;
  for(const suffix of ['', '.mts','.ts','.mjs','.js','/index.mts','/index.ts']){try{if((await stat(candidate+suffix)).isFile()){found=candidate+suffix;break;}}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}}
  if(!found)throw Error('Missing canonical runtime dependency: '+path.relative(bridgeRoot,candidate));pending.push(found);
 }
}
async function helpers(directory){for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())throw Error('Linked canonical runtime asset');const file=path.join(directory,entry.name);if(entry.isDirectory())await helpers(file);else if(/\.(ps1|cs)$/.test(entry.name))runtimeFiles.add(await realpath(file));}}
await helpers(path.join(bridgeRoot,'providers'));await helpers(path.join(bridgeRoot,'simulation-bridge'));
for(const filename of ['package.json','LICENSE'])try{const file=await realpath(path.join(bridgeRoot,filename));runtimeFiles.add(file);}catch(error){if(error.code!=='ENOENT')throw error;}
for(const file of runtimeFiles){if(!insideBridge(file))throw Error('Canonical runtime asset escapes public Bridge');const source=bridgePrefix+path.relative(bridgeRoot,file).replaceAll('\\','/');if(!sources.includes(source))sources.push(source);}

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
