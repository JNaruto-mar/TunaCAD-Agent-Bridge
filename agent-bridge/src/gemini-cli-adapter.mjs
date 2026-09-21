import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  createAgentAccountState,
  createAgentAdapterCapabilities,
  createAgentConnection,
  createAgentThread,
  createAgentTurn,
} from './agent-adapter-contract.mjs';
import { createCadApprovalOutcomePrompt, TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE } from './codex-app-server-adapter.mjs';

export const GEMINI_CLI_CAPABILITIES = createAgentAdapterCapabilities({
  threadResume: true,
  turnCancellation: true,
  cadOutcomeReporting: true,
});

const GEMINI_API_KEY_ENVIRONMENT_VARIABLE = 'GEMINI_API_KEY';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_PROVIDER_DIAGNOSTIC_BYTES = 16_000;

export class GeminiCliAdapter extends EventEmitter {
  constructor({
    pairing,
    geminiBinary = process.platform === 'win32' ? 'gemini.cmd' : 'gemini',
    cwd = process.cwd(),
    environment = process.env,
    versionReader = readGeminiCliVersion,
    processFactory = defaultProcessFactory,
    stateRoot = path.join(homedir(), '.tunacad', 'gemini-agent'),
    temporaryRoot = tmpdir(),
    uuid = randomUUID,
  }) {
    super();
    if (!pairing?.mcpUrl || !pairing?.agentToken) throw new Error('Paired TunaCAD MCP credentials are required.');
    this.pairing = pairing;
    this.geminiBinary = geminiBinary;
    this.cwd = cwd;
    this.environment = { ...environment };
    this.versionReader = versionReader;
    this.processFactory = processFactory;
    this.stateRoot = path.resolve(stateRoot);
    this.temporaryRoot = path.resolve(temporaryRoot);
    this.uuid = uuid;
    this.capabilities = GEMINI_CLI_CAPABILITIES;
    this.version = null;
    this.configurationDirectory = null;
    this.activeThreadId = null;
    this.activeRun = null;
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw new Error('Gemini CLI adapter is closed.');
    if (this.version) throw new Error('Gemini CLI adapter is already connected.');
    this.version = assertSupportedGeminiCliVersion(this.versionReader(this.geminiBinary));
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    this.configurationDirectory = await mkdtemp(path.join(this.temporaryRoot, 'tunacad-gemini-'));
    await writeGeminiProcessConfiguration({
      directory: this.configurationDirectory,
      pairing: this.pairing,
    });
    const authenticated = hasGeminiApiKey(this.environment);
    return createAgentConnection({
      agent: { id: 'gemini-cli', name: 'Gemini CLI', version: this.version },
      account: createAgentAccountState({
        authMode: authenticated ? 'apikey' : null,
        planType: null,
        requiresAuthentication: !authenticated,
      }),
    });
  }

  async startThread() {
    this.#requiredConnection();
    if (this.activeRun) throw new Error('Gemini CLI is already processing a turn.');
    this.activeThreadId = `gemini-pending:${this.uuid()}`;
    return createAgentThread({ threadId: this.activeThreadId, resumed: false });
  }

  async resumeThread(threadId) {
    this.#requiredConnection();
    this.activeThreadId = requiredSafeId(threadId, 'Gemini session ID');
    return createAgentThread({ threadId: this.activeThreadId, resumed: true });
  }

  async startTurn(threadId, content) {
    this.#requiredConnection();
    if (!hasGeminiApiKey(this.environment)) throw new Error('Gemini CLI authentication is required.');
    if (this.activeRun) throw new Error('Gemini CLI is already processing a turn.');
    const prompt = requiredPrompt(content);
    const requestedThreadId = requiredSafeId(threadId, 'Gemini session ID');
    const resume = !requestedThreadId.startsWith('gemini-pending:');
    const turnId = `gemini-turn:${this.uuid()}`;
    const args = createGeminiLaunchArguments(resume ? requestedThreadId : null);
    const env = this.#childEnvironment();
    const child = this.processFactory({ command: this.geminiBinary, args, cwd: this.cwd, env });
    const run = createRun({ child, requestedThreadId, turnId, resumed: resume });
    this.activeRun = run;
    this.#observeRun(run);
    child.stdin?.end?.(prompt);
    try {
      const realThreadId = await run.initialized;
      return createAgentTurn({ threadId: realThreadId, turnId });
    } catch (error) {
      await this.#terminateRun(run);
      throw error;
    }
  }

  async cancelTurn(threadId, turnId) {
    const run = this.activeRun;
    if (!run || run.threadId !== threadId || run.turnId !== turnId) {
      throw new Error('Unknown or completed Gemini CLI turn.');
    }
    run.cancelled = true;
    await this.#terminateRun(run);
  }

  async reportCadApproval({ threadId, proposalId, decision }) {
    const prompt = createCadApprovalOutcomePrompt({ proposalId, decision });
    const run = this.activeRun;
    if (run && run.threadId === threadId && !run.completed) {
      return {
        mode: 'active_turn',
        result: { threadId, turnId: run.turnId },
      };
    }
    return {
      mode: 'follow_up_turn',
      result: await this.startTurn(threadId, prompt),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.activeRun) await this.#terminateRun(this.activeRun);
    const directory = this.configurationDirectory;
    this.configurationDirectory = null;
    if (directory && path.dirname(directory) === this.temporaryRoot && path.basename(directory).startsWith('tunacad-gemini-')) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  #requiredConnection() {
    if (!this.version || !this.configurationDirectory) throw new Error('Gemini CLI adapter is not connected.');
  }

  #childEnvironment() {
    return {
      ...this.environment,
      [TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE]: this.pairing.agentToken,
      GEMINI_CLI_HOME: this.stateRoot,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(this.configurationDirectory, 'settings.json'),
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    };
  }

  #observeRun(run) {
    let stdoutBuffer = '';
    run.child.stdout?.setEncoding?.('utf8');
    run.child.stdout?.on?.('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) this.#handleStreamLine(run, line);
      }
    });
    run.child.stderr?.setEncoding?.('utf8');
    run.child.stderr?.on?.('data', (chunk) => { run.stderrTail = appendDiagnostic(run.stderrTail, chunk); });
    run.child.once?.('error', (error) => this.#failRun(run, 'GEMINI_PROCESS_START_FAILED', error));
    run.child.once?.('exit', (code, signal) => {
      if (stdoutBuffer.trim()) this.#handleStreamLine(run, stdoutBuffer.trim());
      if (!run.completed) {
        if (run.cancelled) this.#completeRun(run, 'cancelled');
        else if (code === 0) this.#completeRun(run, 'completed');
        else this.#failRun(run, 'GEMINI_PROCESS_EXITED', new Error(`Gemini CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`));
      }
      if (!run.initializedSettled) run.rejectInitialized(new Error(`Gemini CLI did not initialize (${signal ?? code ?? 'unknown'}).`));
      if (this.activeRun === run) this.activeRun = null;
    });
  }

  #handleStreamLine(run, line) {
    if (run.completed) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.#failRun(run, 'GEMINI_INVALID_JSONL', error);
      return;
    }
    try {
      this.#handleStreamEvent(run, event);
    } catch (error) {
      this.#failRun(run, 'GEMINI_INVALID_EVENT', error);
    }
  }

  #handleStreamEvent(run, event) {
    if (!event || typeof event.type !== 'string') throw new Error('Invalid Gemini event.');
    if (event.type === 'init') {
      const threadId = requiredSafeId(event.session_id ?? event.sessionId, 'Gemini session ID');
      run.threadId = threadId;
      this.activeThreadId = threadId;
      this.emit('event', { type: 'thread.started', payload: { threadId, resumed: run.resumed } });
      this.emit('event', { type: 'turn.started', payload: { threadId, turnId: run.turnId } });
      this.emit('event', {
        type: 'run.phase_changed',
        payload: { threadId, turnId: run.turnId, phase: 'submitting', label: 'Gemini CLI started' },
      });
      run.resolveInitialized(threadId);
      return;
    }
    if (!run.threadId || run.threadId.startsWith('gemini-pending:')) throw new Error('Gemini event preceded init.');
    const refs = { threadId: run.threadId, turnId: run.turnId };
    if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string' && event.content) {
      const delta = event.content.slice(0, 16_000);
      run.assistantText = `${run.assistantText}${event.content}`.slice(0, 64 * 1024);
      this.emit('event', { type: 'chat.assistant_delta', payload: { ...refs, itemId: run.messageId, delta } });
      return;
    }
    if (event.type === 'tool_use') {
      const toolCallId = requiredSafeId(event.tool_id ?? `gemini-tool:${this.uuid()}`, 'Gemini tool ID');
      const toolName = requiredToolName(event.tool_name);
      run.tools.set(toolCallId, toolName);
      this.emit('event', { type: 'tool.started', payload: { ...refs, toolCallId, toolName } });
      return;
    }
    if (event.type === 'tool_result') {
      const toolCallId = requiredSafeId(event.tool_id, 'Gemini tool ID');
      const toolName = run.tools.get(toolCallId) ?? 'tunacad.tool';
      const failed = event.status === 'error' || event.status === 'failed';
      this.emit('event', {
        type: 'tool.completed',
        payload: { ...refs, toolCallId, toolName, status: failed ? 'failed' : 'completed' },
      });
      return;
    }
    if (event.type === 'error') {
      this.#failRun(run, 'GEMINI_REPORTED_ERROR');
      return;
    }
    if (event.type === 'result') {
      const failed = event.status === 'error' || event.status === 'failed';
      if (failed) this.#failRun(run, 'GEMINI_TURN_FAILED');
      else this.#completeRun(run, 'completed');
    }
  }

  #completeRun(run, status) {
    if (run.completed || !run.threadId || run.threadId.startsWith('gemini-pending:')) return;
    run.completed = true;
    const refs = { threadId: run.threadId, turnId: run.turnId };
    if (run.assistantText && status === 'completed') {
      this.emit('event', {
        type: 'chat.assistant_completed',
        payload: { ...refs, itemId: run.messageId, content: run.assistantText },
      });
    }
    const phase = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    this.emit('event', {
      type: 'run.phase_changed',
      payload: { ...refs, phase, label: status === 'completed' ? 'Agent run completed' : status === 'cancelled' ? 'Agent run cancelled' : 'Agent run failed' },
    });
    this.emit('event', { type: 'turn.completed', payload: { ...refs, status } });
    if (this.activeRun === run) this.activeRun = null;
  }

  #failRun(run, code, cause = null) {
    if (run.completed) return;
    if (!run.initializedSettled) run.rejectInitialized(new Error('Gemini CLI could not initialize safely.'));
    if (run.threadId && !run.threadId.startsWith('gemini-pending:')) this.#completeRun(run, 'failed');
    const details = providerDiagnostic(run, cause);
    this.emit('error', new Error(`${code}: Gemini CLI failed.${details ? ` ${details}` : ''}`));
    void this.#terminateRun(run);
  }

  async #terminateRun(run) {
    if (!run || run.exited) return;
    try { run.child.kill?.(); } catch { /* Process may already be gone. */ }
    await Promise.race([run.exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
}

const REQUIRED_GEMINI_OPTIONS = Object.freeze([
  '--output-format',
  'stream-json',
  '--allowed-mcp-server-names',
  '--extensions',
  '--resume',
]);

export function readGeminiCliVersion(binary = process.platform === 'win32' ? 'gemini.cmd' : 'gemini') {
  const output = runGeminiProbe(binary, ['--version']);
  const match = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  if (!match) throw new Error('Gemini CLI returned an unrecognized version.');
  return Object.freeze({ version: match[1], help: runGeminiProbe(binary, ['--help']) });
}

function runGeminiProbe(binary, args) {
  const invocation = createProcessInvocation(binary, args);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Gemini CLI ${args[0]} check failed. Install or update Gemini CLI and retry.`);
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function assertSupportedGeminiCliVersion({ version, help }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error('Gemini CLI version is unrecognized.');
  }
  const missing = REQUIRED_GEMINI_OPTIONS.filter((option) => !help?.includes(option));
  if (missing.length) {
    throw new Error(`Gemini CLI ${version} lacks required TunaCAD chat options: ${missing.join(', ')}. Update Gemini CLI and retry.`);
  }
  return version;
}
export function createGeminiLaunchArguments(resumeThreadId = null) {
  if (resumeThreadId !== null) requiredSafeId(resumeThreadId, 'Gemini session ID');
  return [
    '--output-format', 'stream-json',
    '--allowed-mcp-server-names', 'tunacad',
    '--extensions', 'none',
    ...(resumeThreadId ? ['--resume', resumeThreadId] : []),
  ];
}

export async function writeGeminiProcessConfiguration({ directory, pairing }) {
  const mcpUrl = new URL(pairing.mcpUrl);
  if (mcpUrl.protocol !== 'https:' && !(mcpUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(mcpUrl.hostname))) {
    throw new Error('The TunaCAD MCP URL must use HTTPS, except on loopback.');
  }
  const policyPath = path.join(directory, 'tunacad-policy.toml');
  const settingsPath = path.join(directory, 'settings.json');
  const policy = [
    '[[rule]]',
    'toolName = "*"',
    'decision = "deny"',
    'priority = 900',
    'denyMessage = "Only TunaCAD MCP tools are available in this companion."',
    '',
    '[[rule]]',
    'toolName = "*"',
    'mcpName = "tunacad"',
    'decision = "allow"',
    'priority = 999',
    '',
  ].join('\n');
  const settings = {
    adminPolicyPaths: [policyPath],
    general: {
      enableAutoUpdate: false,
      checkpointing: { enabled: false },
      sessionRetention: { enabled: true, maxAge: '1d', maxCount: 20, minRetention: '1d' },
    },
    mcp: { allowed: ['tunacad'] },
    mcpServers: {
      tunacad: {
        httpUrl: mcpUrl.toString(),
        headers: { Authorization: `Bearer $${TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE}` },
        timeout: 120000,
        trust: true,
      },
    },
  };
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  if (serialized.includes(pairing.agentToken)) throw new Error('Gemini settings exposed the raw TunaCAD credential.');
  await writeFile(policyPath, policy, { encoding: 'utf8', mode: 0o600 });
  await writeFile(settingsPath, serialized, { encoding: 'utf8', mode: 0o600 });
  return Object.freeze({ policyPath, settingsPath, settings, policy });
}

function defaultProcessFactory({ command, args, cwd, env }) {
  const invocation = createProcessInvocation(command, args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function createProcessInvocation(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const values = [command, ...args];
  for (const value of values) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
      throw new Error('Gemini CLI launch arguments contain unsafe Windows shell characters.');
    }
  }
  const commandLine = values.join(' ');
  return {
    command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  };
}

function createRun({ child, requestedThreadId, turnId, resumed }) {
  let resolveInitialized;
  let rejectInitialized;
  const initialized = new Promise((resolve, reject) => { resolveInitialized = resolve; rejectInitialized = reject; });
  let resolveExited;
  const exitedPromise = new Promise((resolve) => { resolveExited = resolve; });
  const run = {
    child,
    threadId: requestedThreadId,
    turnId,
    resumed,
    initialized,
    initializedSettled: false,
    resolveInitialized(value) { if (!run.initializedSettled) { run.initializedSettled = true; resolveInitialized(value); } },
    rejectInitialized(error) { if (!run.initializedSettled) { run.initializedSettled = true; rejectInitialized(error); } },
    messageId: `gemini-message:${randomUUID()}`,
    assistantText: '',
    stderrTail: '',
    tools: new Map(),
    cancelled: false,
    completed: false,
    exited: false,
    exitedPromise,
  };
  child.once?.('exit', () => { run.exited = true; resolveExited(); });
  return run;
}

function hasGeminiApiKey(environment) {
  return typeof environment?.[GEMINI_API_KEY_ENVIRONMENT_VARIABLE] === 'string'
    && environment[GEMINI_API_KEY_ENVIRONMENT_VARIABLE].trim().length > 0;
}

function requiredSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is missing or unsafe.`);
  return value;
}

function requiredToolName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) throw new Error('Gemini tool name is missing or unsafe.');
  return value;
}

function requiredPrompt(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A non-empty Gemini prompt is required.');
  return value;
}

function appendDiagnostic(previous, chunk) {
  return `${previous}${String(chunk)}`.slice(-MAX_PROVIDER_DIAGNOSTIC_BYTES);
}

function providerDiagnostic(run, cause) {
  const values = [
    cause instanceof Error ? cause.message : cause ? String(cause) : '',
    run.stderrTail,
  ].filter(Boolean).map(redactProviderDiagnostic);
  return values.length ? `Provider diagnostic: ${values.join(' | ').slice(0, MAX_PROVIDER_DIAGNOSTIC_BYTES)}` : '';
}

function redactProviderDiagnostic(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}
