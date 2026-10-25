import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function launchCompanionManager({
  platform = process.platform, spawnImpl = spawn, node = process.execPath,
  readHelper = () => readFile(new URL('./companion-manager-windows.ps1', import.meta.url), 'utf8'),
  environment = process.env, startupTimeoutMs = 15_000,
} = {}) {
  if (platform !== 'win32') throw new Error('The Companion manager requires Windows. Use the companion command on this platform.');
  const script = await readHelper();
  const host = fileURLToPath(new URL('../bin/companion-manager-host.mjs', import.meta.url));
  const child = spawnImpl(path.win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: environment });
  await new Promise((resolve, reject) => {
    let settled = false, output = '';
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (ready) { child.unref(); resolve(); }
      else { child.kill(); reject(new Error('Could not open the Companion manager. Check the Windows PowerShell installation.')); }
    };
    const timer = setTimeout(() => finish(false), startupTimeoutMs);
    child.once('error', () => finish(false));
    child.once('close', () => finish(false));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes('TUNACAD_MANAGER_READY\n') || output.includes('TUNACAD_MANAGER_READY\r\n')) finish(true);
      else if (output.length > 128 || output.includes('TUNACAD_MANAGER_FAILED')) finish(false);
    });
    child.stdout.on('error', () => finish(false));
    child.once('spawn', () => {
      // Paths are JSON data, never embedded in PowerShell source or shell text.
      child.stdin.on('error', () => finish(false));
      child.stdin.end(JSON.stringify({ node, host }) + '\n');
    });
  });
}
