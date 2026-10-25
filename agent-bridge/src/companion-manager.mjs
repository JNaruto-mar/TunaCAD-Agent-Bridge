import { createInterface } from 'node:readline';
import { startCompanion, COMPANION_PROTOCOL } from './companion-server.mjs';
import { createTrustApproval } from './companion-approval.mjs';

export async function probeCompanion(transport = fetch) {
  try {
    const response = await transport('http://127.0.0.1:47831/v1/discovery', {
      headers: { Origin: 'https://tunacad.com' }, credentials: 'omit',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const value = await response.json();
    return value?.protocol === COMPANION_PROTOCOL && typeof value.companionVersion === 'string';
  } catch { return false; }
}

// Private pipe owned by the native manager. This is not a network control API.
// Only this process's Companion can be stopped; existing listeners are left alone.
export async function runManagedCompanion({
  input = process.stdin, output = process.stdout,
  probe = probeCompanion, start = startCompanion,
  approveTrust = createTrustApproval({ mode: 'native' }),
} = {}) {
  const report = (state) => output.write(JSON.stringify({ state }) + '\n');
  const control = createInterface({ input, crlfDelay: Infinity });
  let stopRequested = false;
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const stop = () => { stopRequested = true; resolveStop(); };
  control.on('line', (line) => { if (line === 'stop') stop(); });
  control.on('close', stop);
  let companion;
  try {
    if (await probe()) { report('already_running'); return; }
    if (stopRequested) { report('stopped'); return; }
    report('starting');
    companion = await start({ origins: ['https://tunacad.com'], approveTrust });
    if (!stopRequested) report('running');
    await stopped;
    report('stopping');
    await companion.close();
    companion = undefined;
    report('stopped');
  } catch (error) {
    // Provider, paths, credentials, and arbitrary exception text stay private.
    report(error?.code === 'EADDRINUSE' ? 'port_busy' : 'failed');
  } finally {
    control.close();
    if (companion) await companion.close().catch(() => {});
    // readline.close() alone leaves an inherited stdin pipe referenced on
    // Windows. Once shutdown is complete, it must not keep this host alive.
    input.unref?.();
  }
}
