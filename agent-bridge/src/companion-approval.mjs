import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';

export const TRUST_APPROVAL_TIMEOUT_MS = 90_000;
const validOrigin = (origin) => {
  if (typeof origin !== 'string' || origin.length > 256 || /[\s*]/.test(origin)) return false;
  try { const url = new URL(origin); return url.origin === origin && ['https:', 'http:'].includes(url.protocol); }
  catch { return false; }
};

export async function approveTerminalTrust(origin, {
  input = stdin, output = stdout, timeoutMs = TRUST_APPROVAL_TIMEOUT_MS, createPrompt = createInterface,review,
} = {}) {
  if (!validOrigin(origin) || !input.isTTY) return false;
  const prompt = createPrompt({ input, output });
  try {
    if(review){
      const answer=await prompt.question(`Authorize simulations for ${origin}, workspace ${review.workspaceId}? Clients: ${review.clients.join(', ')}. Capabilities: ${review.capabilities.join(', ')}. Until you end or revoke it; up to ${review.maximumJobs} jobs, ${review.maximumMeshes} meshes and ${review.maximumSolverProcesses} solver processes. CAD edits and Save/Reopen do not consume the job budget. Existing native resource limits apply. Type AUTHORIZE: `,{signal:AbortSignal.timeout(timeoutMs)});return answer.trim()==='AUTHORIZE';
    }
    const answer = await prompt.question(
      `Trust ${origin} to create temporary AI workspace sessions on this computer? This does not approve CAD mutations, geometry transfer, simulation, or provider actions. Type TRUST to allow: `,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    return answer.trim() === 'TRUST';
  } catch { return false; }
  finally { prompt.close(); }
}

export async function approveWindowsTrust(origin, {
  spawnImpl = spawn, readHelper = () => readFile(new URL('./companion-approval-windows.ps1', import.meta.url), 'utf8'),
  timeoutMs = TRUST_APPROVAL_TIMEOUT_MS, environment = process.env,review,
} = {}) {
  if (!validOrigin(origin)) return false;
  let script;
  try { script = await readHelper(); } catch { return false; }
  // Origin is stdin data, never PowerShell source or a shell argument.
  // Do not pass provider credentials or workspace secrets to the helper.
  const systemRoot = environment.SystemRoot || 'C:\\Windows';
  const helperEnvironment = { SystemRoot: systemRoot };
  for (const name of ['TEMP', 'TMP']) if (environment[name]) helperEnvironment[name] = environment[name];
  return new Promise((resolve) => {
    let child, timer, settled = false, output = '';
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(allowed);
    };
    const deny = () => { try { child?.kill(); } catch { /* Always deny. */ } finish(false); };
    try {
      child = spawnImpl(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment });
      timer = setTimeout(deny, timeoutMs + 5_000);
      child.on('error', deny);
      child.on('close', (code, signal) => finish(code === 0 && !signal && output === 'ALLOW\n'));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.length > 128) deny();
      });
      child.stderr.on('data', () => {}); // Never expose arbitrary helper errors.
      child.stdin.on('error', deny);
      child.stdin.end(JSON.stringify({ origin, timeoutMs,...(review?{purpose:'simulation',review}:{}) }) + '\n');
    } catch { deny(); }
  });
}

export function createTrustApproval({
  mode = 'auto', platform = process.platform, input = stdin, output = stdout,
  nativeApproval = approveWindowsTrust, terminalApproval = approveTerminalTrust,
} = {}) {
  if (!['auto', 'native', 'terminal'].includes(mode)) throw new Error('Approval mode must be auto, native, or terminal.');
  const useNative = mode !== 'terminal' && platform === 'win32';
  if (!useNative && (mode === 'native' || !input.isTTY)) {
    throw new Error('Native approval is unavailable. Use companion --approval terminal in an interactive terminal.');
  }
  return async (origin) => {
    if (!validOrigin(origin)) return false;
    // Cancel, timeout, and native failures never launch another approval path.
    try { return await (useNative ? nativeApproval(origin) : terminalApproval(origin, { input, output })) === true; }
    catch { return false; }
  };
}

export function parseCompanionArguments(values) {
  const options = { origin: 'https://tunacad.com', approvalMode: 'auto' };
  const seen = new Set();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    if (!['--origin', '--approval'].includes(key) || !value || seen.has(key)) {
      throw new Error('Usage: tunacad-agent-bridge companion [--origin <exact-origin>] [--approval auto|native|terminal]');
    }
    seen.add(key);
    if (key === '--origin') options.origin = value;
    else if (['auto', 'native', 'terminal'].includes(value)) options.approvalMode = value;
    else throw new Error('Approval mode must be auto, native, or terminal.');
  }
  return options;
}

/** Same native/terminal consent implementation as device trust, with a distinct
 * explicit simulation scope. Trust approval itself never issues this consent. */
export function createSimulationApproval(options={}){
 const platform=options.platform??process.platform,mode=options.mode??'auto';
 return async review=>{if(review?.schema!=='tunacad-trusted-simulation-consent/1'||!validOrigin(review.origin))return false;
  try{return await(mode!=='terminal'&&platform==='win32'?(options.nativeApproval??approveWindowsTrust)(review.origin,{review}):(options.terminalApproval??approveTerminalTrust)(review.origin,{input:options.input??stdin,output:options.output??stdout,review}))===true;}catch{return false;}
 };
}
