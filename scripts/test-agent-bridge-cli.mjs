import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const options = process.argv.slice(2);
const option = (name, fallback) => { const at = options.indexOf(name); return at < 0 ? fallback : options[at + 1]; };
const cli = path.resolve(option('--cli', 'agent-bridge/bin/tunacad-agent-bridge.mjs'));
const metadataPath = path.resolve(option('--package-json', 'agent-bridge/package.json'));
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tunacad-cli-test-'));
const run = (args, prefix = []) => {
  const result = spawnSync(process.execPath, [...prefix, cli, ...args], { cwd: temporaryRoot, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  return result;
};
try {
  for (const flag of ['--version', '-v']) {
    const result = run([flag]);
    assert.equal(result.status, 0, flag + ' must exit successfully');
    assert.equal(result.stdout, metadata.version + '\n', flag + ' must print only the exact metadata version');
    assert.equal(result.stderr, '');
  }

  // Stub only the Companion runner in isolated child processes: verify routing,
  // without opening a listener, discovering providers, or granting any trust.
  const loaderPath = path.join(temporaryRoot, 'companion-routing-loader.mjs');
  const companionUrl = pathToFileURL(path.join(path.dirname(cli), 'companion.mjs')).href;
  const stub = "export async function runCompanion(origin, options) { process.stdout.write(JSON.stringify({origin, options}) + '\\n'); }";
  await writeFile(loaderPath, 'export async function load(url, context, nextLoad) { if (url === ' + JSON.stringify(companionUrl) + ') return { format: "module", shortCircuit: true, source: ' + JSON.stringify(stub) + ' }; return nextLoad(url, context); }\n');
  const companion = run(['companion'], ['--experimental-loader', pathToFileURL(loaderPath).href]);
  assert.equal(companion.status, 0, companion.stderr);
  assert.deepEqual(JSON.parse(companion.stdout), { origin: 'https://tunacad.com', options: { origin: 'https://tunacad.com', approvalMode: 'auto' } });
  const fallback = run(['companion', '--origin', 'http://localhost:8080', '--approval', 'terminal'], ['--experimental-loader', pathToFileURL(loaderPath).href]);
  assert.equal(fallback.status, 0);
  assert.deepEqual(JSON.parse(fallback.stdout), { origin: 'http://localhost:8080', options: { origin: 'http://localhost:8080', approvalMode: 'terminal' } });

  for (const args of [[], ['connect']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: tunacad-agent-bridge connect --origin/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  }
  const manual = run(['connect', '--origin', 'https://tunacad.com', '--session', '10000000-0000-4000-8000-000000000001']);
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /Pairing requires an interactive terminal/);
  console.log('Focused Agent Bridge CLI checks passed: --version/-v exact metadata output and exit 0, cwd-independent lookup, Companion routing/defaults/terminal options, and unchanged manual connect usage/TTY requirement.');
} finally {
  const resolved = path.resolve(temporaryRoot);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(resolved, { recursive: true, force: true });
}
