import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyAgentBridgeReleaseFiles } from './lib/agent-bridge-distribution.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestPath = path.resolve(options.manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const tarballPath = path.resolve(options.tarball ?? path.join(path.dirname(manifestPath), manifest.package.tarballFileName));
verifyAgentBridgeReleaseFiles({
  manifest,
  tarballBytes: await readFile(tarballPath),
  assemblyBytes: await readFile(path.resolve(options.assembly)),
});
process.stdout.write(`[agent-bridge] Offline digest verification passed for ${manifest.package.exactSpecifier}.\n`);
process.stdout.write('[agent-bridge] Authenticity still requires npm audit signatures and GitHub artifact attestation verification.\n');

function parseOptions(args) {
  const read = (name) => {
    const direct = args.find((arg) => arg.startsWith(`--${name}=`));
    const index = args.indexOf(`--${name}`);
    return direct?.slice(name.length + 3) ?? (index >= 0 ? args[index + 1] : undefined);
  };
  const manifest = read('manifest');
  const assembly = read('assembly');
  if (!manifest || !assembly) {
    throw new Error('Usage: node scripts/verify-agent-bridge-release.mjs --manifest <path> --assembly <path> [--tarball <path>]');
  }
  return { manifest, assembly, tarball: read('tarball') };
}
