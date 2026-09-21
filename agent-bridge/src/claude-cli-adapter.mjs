import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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


export const CLAUDE_CLI_CAPABILITIES = createAgentAdapterCapabilities({
  threadResume: true,
  turnCancellation: true,
  cadOutcomeReporting: true,
});

const CLAUDE_API_KEY_ENVIRONMENT_VARIABLE = 'ANTHROPIC_API_KEY';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_PROVIDER_DIAGNOSTIC_BYTES = 16_000;

export class ClaudeCliAdapter extends EventEmitter {
  constructor({
    pairing,
    claudeBinary = 'claude',
    cwd = process.cwd(),
    environment = process.env,
    versionReader = readClaudeCliVersion,
    authReader = readClaudeAuthStatus,
    processFactory = defaultProcessFactory,
    temporaryRoot = tmpdir(),
    uuid = randomUUID,
  }) {
    super();
    if (!pairing?.mcpUrl || !pairing?.agentToken) throw new Error('Paired TunaCAD MCP credentials are required.');
    this.pairing = pairing;
    this.claudeBinary = claudeBinary;
    this.cwd = cwd;
    this.environment = { ...environment };
    this.versionReader = versionReader;
    this.authReader = authReader;
    this.processFactory = processFactory;
    this.temporaryRoot = path.resolve(temporaryRoot);
    this.uuid = uuid;
    this.capabilities = CLAUDE_CLI_CAPABILITIES;
    this.version = null;
    this.configurationDirectory = null;
    this.activeThreadId = null;
    this.activeRun = null;
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw new Error('Claude Code CLI adapter is closed.');
    if (this.version) throw new Error('Claude Code CLI adapter is already connected.');
    this.version = assertSupportedClaudeCliVersion(this.versionReader(this.claudeBinary));
    this.configurationDirectory = await mkdtemp(path.join(this.temporaryRoot, 'tunacad-claude-'));
    await writeClaudeProcessConfiguration({
      directory: this.configurationDirectory,
      pairing: this.pairing,
    });
    const authenticated = hasClaudeApiKey(this.environment);
    const loggedIn = authenticated ? true : this.authReader(this.claudeBinary);
    return createAgentConnection({
      agent: { id: 'claude-cli', name: 'Claude Code CLI', version: this.version },
      account: createAgentAccountState({
        authMode: authenticated ? 'apikey' : null,
        planType: null,
        requiresAuthentication: loggedIn === false,
      }),
    });
  }

  async startThread() {
    this.#requiredConnection();
    if (this.activeRun) throw new Error('Claude Code CLI is already processing a turn.');
    this.activeThreadId = `claude-pending:${this.uuid()}`;
    return createAgentThread({ threadId: this.activeThreadId, resumed: false });
  }

  async resumeThread(threadId) {
    this.#requiredConnection();
    this.activeThreadId = requiredSafeId(threadId, 'Claude session ID');
    return createAgentThread({ threadId: this.activeThreadId, resumed: true });
  }

  async startTurn(threadId, content) {
    this.#requiredConnection();
    if (this.activeRun) throw new Error('Claude Code CLI is already processing a turn.');
    const prompt = requiredPrompt(content);
    const requestedThreadId = requiredSafeId(threadId, 'Claude session ID');
    const resume = !requestedThreadId.startsWith('claude-pending:');
    const turnId = `claude-turn:${this.uuid()}`;
    const args = createClaudeLaunchArguments(path.join(this.configurationDirectory, 'mcp.json'), resume ? requestedThreadId : null);
    const env = this.#childEnvironment();
    const child = this.processFactory({ command: this.claudeBinary, args, cwd: this.cwd, env });
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
      throw new Error('Unknown or completed Claude Code CLI turn.');
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
    if (directory && path.dirname(directory) === this.temporaryRoot && path.basename(directory).startsWith('tunacad-claude-')) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  #requiredConnection() {
    if (!this.version || !this.configurationDirectory) throw new Error('Claude Code CLI adapter is not connected.');
  }

  #childEnvironment() {
    return {
      ...this.environment,
      [TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE]: this.pairing.agentToken,
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
    run.child.once?.('error', (error) => this.#failRun(run, 'CLAUDE_PROCESS_START_FAILED', error));
    run.child.once?.('exit', (code, signal) => {
      if (stdoutBuffer.trim()) this.#handleStreamLine(run, stdoutBuffer.trim());
      if (!run.completed) {
        if (run.cancelled) this.#completeRun(run, 'cancelled');
        else if (code === 0 && run.resultSeen) this.#completeRun(run, 'completed');
        else this.#failRun(run, 'CLAUDE_PROCESS_EXITED', new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`));
      }
      if (!run.initializedSettled) run.rejectInitialized(new Error(`Claude Code CLI did not initialize (${signal ?? code ?? 'unknown'}).`));
      if (this.activeRun === run) this.activeRun = null;
    });
  }

  #handleStreamLine(run, line) {
    if (run.completed) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.#failRun(run, 'CLAUDE_INVALID_JSONL', error);
      return;
    }
    try {
      this.#handleStreamEvent(run, event);
    } catch (error) {
      this.#failRun(run, 'CLAUDE_INVALID_EVENT', error);
    }
  }

  #handleStreamEvent(run, event) {
    if (!event || typeof event.type !== 'string') throw new Error('Invalid Claude event.');
    if (event.type === 'system' && event.subtype === 'init') {
      const threadId = requiredSafeId(event.session_id, 'Claude session ID');
      run.threadId = threadId;
      this.activeThreadId = threadId;
      this.emit('event', { type: 'thread.started', payload: { threadId, resumed: run.resumed } });
      this.emit('event', { type: 'turn.started', payload: { threadId, turnId: run.turnId } });
      this.emit('event', { type: 'run.phase_changed', payload: { threadId, turnId: run.turnId, phase: 'submitting', label: 'Claude Code CLI started' } });
      run.resolveInitialized(threadId);
      return;
    }
    if (!run.initializedSettled) throw new Error('Claude event preceded init.');
    const refs = { threadId: run.threadId, turnId: run.turnId };
    if (event.type === 'stream_event') {
      if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') this.#addText(run, refs, event.event.delta.text);
      return;
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && !run.streamedText) this.#addText(run, refs, block.text);
        if (block.type === 'tool_use') {
          const toolCallId = requiredSafeId(block.id, 'Claude tool ID');
          const toolName = requiredToolName(block.name);
          run.tools.set(toolCallId, toolName);
          this.emit('event', { type: 'tool.started', payload: { ...refs, toolCallId, toolName } });
        }
      }
      run.streamedText = false;
      return;
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const toolCallId = requiredSafeId(block.tool_use_id, 'Claude tool ID');
        const toolName = run.tools.get(toolCallId) ?? 'tunacad.tool';
        this.emit('event', { type: 'tool.completed', payload: { ...refs, toolCallId, toolName, status: block.is_error ? 'failed' : 'completed' } });
        run.tools.delete(toolCallId);
      }
      return;
    }
    if (event.type === 'result') {
      run.resultSeen = true;
      if (event.is_error || event.subtype?.startsWith('error')) this.#failRun(run, 'CLAUDE_TURN_FAILED', new Error(typeof event.result === 'string' ? event.result : 'Claude reported an error.'));
      else this.#completeRun(run, 'completed');
    }
  }

  #addText(run, refs, value) {
    if (typeof value !== 'string' || !value) return;
    run.streamedText = true;
    run.assistantText = `${run.assistantText}${value}`.slice(0, 64 * 1024);
    this.emit('event', { type: 'chat.assistant_delta', payload: { ...refs, itemId: run.messageId, delta: value.slice(0, 16_000) } });
  }
  #completeRun(run, status) {
    if (run.completed || !run.threadId || run.threadId.startsWith('claude-pending:')) return;
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
    if (!run.initializedSettled) run.rejectInitialized(new Error('Claude Code CLI could not initialize safely.'));
    if (run.threadId && !run.threadId.startsWith('claude-pending:')) this.#completeRun(run, 'failed');
    const details = providerDiagnostic(run, cause, this.pairing.agentToken);
    this.emit('error', new Error(`${code}: Claude Code CLI failed.${details ? ` ${details}` : ''}`));
    void this.#terminateRun(run);
  }

  async #terminateRun(run) {
    if (!run || run.exited) return;
    try { run.child.kill?.(); } catch { /* Process may already be gone. */ }
    await Promise.race([run.exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
}

export function readClaudeCliVersion(binary = 'claude') {
  const version = runClaudeProbe(binary, ['--version']);
  const match = version.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  if (!match) throw new Error('Claude Code CLI returned an unrecognized version.');
  return { version: match[1], help: runClaudeProbe(binary, ['--help']) };
}

export function readClaudeAuthStatus(binary = 'claude') {
  const invocation = createProcessInvocation(binary, ['auth', 'status']);
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error) return null;
  try {
    const status = JSON.parse(result.stdout);
    return typeof status.loggedIn === 'boolean' ? status.loggedIn : null;
  } catch { return null; }
}
function runClaudeProbe(binary, args) {
  const invocation = createProcessInvocation(binary, args);
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`Claude Code CLI ${args[0]} check failed. Install or update Claude Code and retry.`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function assertSupportedClaudeCliVersion({ version, help }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('Claude Code CLI version is unrecognized.');
  const required = ['--print', '--output-format', '--include-partial-messages', '--mcp-config', '--strict-mcp-config', '--resume', '--permission-mode', '--tools', '--allowedTools'];
  const missing = required.filter((flag) => !help?.includes(flag));
  if (missing.length) throw new Error(`Claude Code CLI ${version} lacks required chat options: ${missing.join(', ')}.`);
  return version;
}

export function createClaudeLaunchArguments(configPath, resumeThreadId = null) {
  if (resumeThreadId !== null) requiredSafeId(resumeThreadId, 'Claude session ID');
  return ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
    '--mcp-config', configPath, '--strict-mcp-config', '--tools', '',
    '--allowedTools', 'mcp__tunacad__*', '--permission-mode', 'dontAsk',
    ...(resumeThreadId ? ['--resume', resumeThreadId] : [])];
}

export async function writeClaudeProcessConfiguration({ directory, pairing }) {
  const mcpUrl = new URL(pairing.mcpUrl);
  if (mcpUrl.protocol !== 'https:' && !(mcpUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(mcpUrl.hostname))) throw new Error('The TunaCAD MCP URL must use HTTPS, except on loopback.');
  const configPath = path.join(directory, 'mcp.json');
  const config = { mcpServers: { tunacad: { type: 'http', url: mcpUrl.toString(), headers: { Authorization: 'Bearer ${TUNACAD_MCP_AGENT_TOKEN}' } } } };
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serialized.includes(pairing.agentToken)) throw new Error('Claude MCP settings exposed the raw TunaCAD credential.');
  await writeFile(configPath, serialized, { encoding: 'utf8', mode: 0o600 });
  return { configPath, config };
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
  if (process.platform !== 'win32' || (command !== 'claude' && !/\\.(cmd|bat)$/i.test(command))) return { command, args };
  const values = [command, ...args];
  for (const value of values) {
    if (typeof value !== 'string' || /["%\r\n&|<>^]/.test(value)) throw new Error('Claude CLI launch arguments contain unsafe Windows shell characters.');
  }
  return { command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/c', values.map((value) => value === '' || /\s/.test(value) ? `"${value}"` : value).join(' ')] };
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
    messageId: `claude-message:${randomUUID()}`,
    assistantText: '',
    streamedText: false,
    resultSeen: false,
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

function hasClaudeApiKey(environment) {
  return typeof environment?.[CLAUDE_API_KEY_ENVIRONMENT_VARIABLE] === 'string'
    && environment[CLAUDE_API_KEY_ENVIRONMENT_VARIABLE].trim().length > 0;
}

function requiredSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is missing or unsafe.`);
  return value;
}

function requiredToolName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) throw new Error('Claude tool name is missing or unsafe.');
  return value;
}

function requiredPrompt(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A non-empty Claude prompt is required.');
  return value;
}

function appendDiagnostic(previous, chunk) {
  return `${previous}${String(chunk)}`.slice(-MAX_PROVIDER_DIAGNOSTIC_BYTES);
}

function providerDiagnostic(run, cause, token) {
  const values = [
    cause instanceof Error ? cause.message : cause ? String(cause) : '',
    run.stderrTail,
  ].filter(Boolean).map((value) => redactProviderDiagnostic(value, token));
  return values.length ? `Provider diagnostic: ${values.join(' | ').slice(0, MAX_PROVIDER_DIAGNOSTIC_BYTES)}` : '';
}

function redactProviderDiagnostic(value, token) {
  return String(value).replaceAll(token, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}
