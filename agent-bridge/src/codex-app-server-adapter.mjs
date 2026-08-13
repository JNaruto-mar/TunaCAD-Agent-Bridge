import { EventEmitter } from 'node:events';
import {
  CodexAppServerClient,
  assertSupportedCodexVersion,
  readCodexVersion,
} from '../../scripts/lib/codex-app-server-client.mjs';
import {
  createCodexApprovalResponse,
  createCodexUserInputResponse,
  mapCodexNotification,
} from '../../src/aiAgent/codexEventMapper.mjs';
import { CodexRequestTracker } from '../../src/aiAgent/codexRequestTracker.mjs';
import { AGENT_BRIDGE_TIMING_POLICY } from '../../src/aiAgent/bridgeCompatibility.mjs';

export const TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'TUNACAD_MCP_AGENT_TOKEN';

export class CodexAppServerAdapter extends EventEmitter {
  constructor({
    pairing,
    codexBinary = process.platform === 'win32' ? 'codex.cmd' : 'codex',
    cwd = process.cwd(),
    versionReader = readCodexVersion,
    clientFactory = (options) => new CodexAppServerClient(options),
  }) {
    super();
    if (!pairing?.mcpUrl || !pairing?.agentToken) throw new Error('Paired TunaCAD MCP credentials are required.');
    this.pairing = pairing;
    this.codexBinary = codexBinary;
    this.cwd = cwd;
    this.versionReader = versionReader;
    this.clientFactory = clientFactory;
    this.client = null;
    this.version = null;
    this.account = null;
    this.requestTracker = new CodexRequestTracker();
    this.pendingRequests = new Map();
    this.pendingRequestAliases = new Map();
    this.toolNames = new Map();
    this.pendingLogin = null;
  }

  async connect() {
    if (this.client) throw new Error('Codex App Server adapter is already connected.');
    const versionResult = this.versionReader(this.codexBinary);
    this.version = assertSupportedCodexVersion(versionResult.version);
    const args = createCodexLaunchArguments(this.pairing.mcpUrl);
    const env = {
      ...process.env,
      [TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE]: this.pairing.agentToken,
    };
    const client = this.clientFactory({ command: this.codexBinary, args, env });
    this.client = client;
    client.on('notification', (message) => this.#onNotification(message));
    client.on('serverRequest', (message) => this.#onServerRequest(message));
    client.on('protocolError', (error) => this.emit('error', error));
    client.on('exit', ({ code, signal }) => {
      if (this.client === client) this.emit('exit', { code, signal });
    });
    try {
      const initialized = await client.start({
        name: 'tunacad_agent_bridge',
        title: 'TunaCAD Agent Bridge',
        version: '0.2.8',
      });
      const accountResult = await client.request('account/read', { refreshToken: false });
      const configResult = await client.request('config/read', { includeLayers: false });
      assertProcessScopedMcpConfig(configResult, this.pairing);
      this.account = normalizeAccountState(accountResult);
      return {
        version: this.version,
        initialized,
        account: this.account,
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      this.client = null;
      throw error;
    }
  }

  async startThread(options = {}) {
    const client = this.#requiredClient();
    return client.request('thread/start', {
      cwd: this.cwd,
      ephemeral: false,
      serviceName: 'tunacad_agent_bridge',
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    });
  }

  async startDeviceCodeLogin({ timeoutMs = AGENT_BRIDGE_TIMING_POLICY.loginCompletionTimeoutMs } = {}) {
    if (this.pendingLogin) throw new Error('A Codex login is already in progress.');
    const client = this.#requiredClient();
    const started = normalizeDeviceCodeLogin(await client.request('account/login/start', {
      type: 'chatgptDeviceCode',
    }));
    const completion = this.#completeDeviceCodeLogin(client, started, timeoutMs);
    this.pendingLogin = { loginId: started.loginId, completion };
    completion.then(
      () => { if (this.pendingLogin?.completion === completion) this.pendingLogin = null; },
      () => { if (this.pendingLogin?.completion === completion) this.pendingLogin = null; },
    );
    return Object.freeze({ ...started, completion });
  }

  async cancelDeviceCodeLogin(loginId = this.pendingLogin?.loginId) {
    if (!loginId || loginId !== this.pendingLogin?.loginId) {
      throw new Error('Unknown or completed Codex login attempt.');
    }
    await this.#requiredClient().request('account/login/cancel', { loginId });
  }

  async resumeThread(threadId) {
    return this.#requiredClient().request('thread/resume', { threadId });
  }

  async startTurn(threadId, content) {
    return this.#requiredClient().request('turn/start', {
      threadId,
      input: [{ type: 'text', text: requiredPrompt(content) }],
    });
  }

  async steerTurn(threadId, turnId, content) {
    return this.#requiredClient().request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: requiredPrompt(content) }],
    });
  }

  async cancelTurn(threadId, turnId) {
    return this.#requiredClient().interruptTurn({ threadId, turnId });
  }

  async respondToApproval(approvalId, decision) {
    const request = this.#requestForAlias(approvalId);
    const mapped = createCodexApprovalResponse(request, decision);
    this.requestTracker.markResponded(request.id, decision);
    this.#requiredClient().respond(request.id, mapped.response);
    if (mapped.interruptTurn) {
      await this.#requiredClient().request('turn/interrupt', {
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      });
    }
  }

  async reportCadApproval({ threadId, turnId = null, proposalId, decision }) {
    const prompt = createCadApprovalOutcomePrompt({ proposalId, decision });
    if (turnId) {
      return {
        mode: 'steer',
        result: await this.steerTurn(threadId, turnId, prompt),
      };
    }
    return {
      mode: 'follow_up_turn',
      result: await this.startTurn(threadId, prompt),
    };
  }

  async respondToUserInput(inputRequestId, answers) {
    const request = this.#requestForAlias(inputRequestId);
    this.requestTracker.markResponded(request.id, 'responded');
    this.#requiredClient().respond(request.id, createCodexUserInputResponse(request, answers));
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.pendingRequests.clear();
    this.pendingRequestAliases.clear();
    this.toolNames.clear();
    this.pendingLogin = null;
    if (client) await client.close();
  }

  #onNotification(message) {
    if (message.method === 'account/updated') {
      this.account = normalizeAccountNotification(message.params);
    }
    if (message.method === 'serverRequest/resolved') {
      try {
        const resolved = this.requestTracker.resolve(message);
        const requestId = String(message.params?.requestId ?? '');
        const request = this.pendingRequests.get(requestId);
        this.pendingRequests.delete(requestId);
        if (request) {
          for (const [alias, entry] of this.pendingRequestAliases) {
            if (entry === request) this.pendingRequestAliases.delete(alias);
          }
        }
        if (resolved.descriptor) this.emit('event', resolved.descriptor);
        this.emit('timing', resolved.timing);
      } catch (error) {
        this.emit('error', error);
      }
      return;
    }
    const item = message.params?.item;
    if (message.method === 'item/started' && item?.id && item?.type === 'mcpToolCall') {
      this.toolNames.set(item.id, `${item.server ?? 'mcp'}.${item.tool ?? 'unknown'}`);
    }
    for (const descriptor of mapCodexNotification(message, {
      toolNames: this.toolNames,
      requiresOpenaiAuth: this.account?.requiresOpenaiAuth,
      correlationId: `codex:${message.params?.turnId ?? message.params?.turn?.id ?? 'event'}`,
    })) {
      this.emit('event', descriptor);
    }
  }

  #onServerRequest(request) {
    try {
      const descriptor = this.requestTracker.register(request);
      const key = String(request.id);
      this.pendingRequests.set(key, request);
      const alias = descriptor.payload.approvalId ?? descriptor.payload.inputRequestId;
      if (alias) this.pendingRequestAliases.set(alias, request);
      this.emit('event', descriptor);
    } catch (error) {
      this.emit('error', error);
    }
  }

  #requestForAlias(alias) {
    const request = this.pendingRequestAliases.get(alias);
    if (!request) throw new Error(`Unknown or resolved Codex request ${String(alias)}.`);
    return request;
  }

  #requiredClient() {
    if (!this.client) throw new Error('Codex App Server adapter is not connected.');
    return this.client;
  }

  async #completeDeviceCodeLogin(client, login, timeoutMs) {
    const completed = await client.waitForNotification(
      (message) => message.method === 'account/login/completed'
        && message.params?.loginId === login.loginId,
      timeoutMs,
    );
    if (completed.params?.success !== true) throw new Error('Codex device-code login did not complete successfully.');
    await client.waitForNotification(
      (message) => message.method === 'account/updated' && message.params?.authMode !== null,
      AGENT_BRIDGE_TIMING_POLICY.requestTimeoutMs,
    );
    if (!this.account || this.account.requiresOpenaiAuth) {
      throw new Error('Codex reported login completion without an authenticated account.');
    }
    return Object.freeze({ loginId: login.loginId, account: this.account });
  }
}

export function createCodexLaunchArguments(mcpUrl) {
  const url = new URL(mcpUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('The TunaCAD MCP URL must use HTTPS, except on loopback.');
  }
  return [
    'app-server',
    '--stdio',
    '-c', `mcp_servers.tunacad.url=${url.toString()}`,
    '-c', `mcp_servers.tunacad.bearer_token_env_var=${TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE}`,
    '-c', 'mcp_servers.tunacad.required=true',
  ];
}

export function assertProcessScopedMcpConfig(configResult, pairing) {
  const tunacad = configResult?.config?.mcp_servers?.tunacad;
  if (tunacad?.url !== new URL(pairing.mcpUrl).toString()) {
    throw new Error('Codex did not apply the process-scoped TunaCAD MCP URL.');
  }
  if (tunacad?.bearer_token_env_var !== TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE) {
    throw new Error('Codex did not apply the TunaCAD MCP bearer-token environment variable.');
  }
  if (tunacad?.required !== true) throw new Error('Codex did not mark the TunaCAD MCP server as required.');
  if (JSON.stringify(tunacad).includes(pairing.agentToken)) {
    throw new Error('Codex effective configuration exposed the raw TunaCAD MCP credential.');
  }
  return tunacad;
}

function normalizeAccountState(accountResult) {
  const account = accountResult?.account ?? null;
  const type = account?.type;
  const authMode = type === 'chatgpt' ? 'chatgpt' : type === 'apiKey' ? 'apikey' : null;
  return {
    authMode,
    planType: account?.planType ?? accountResult?.planType ?? null,
    requiresOpenaiAuth: Boolean(accountResult?.requiresOpenaiAuth && !account),
  };
}

function normalizeAccountNotification(params = {}) {
  return {
    authMode: params.authMode ?? null,
    planType: params.planType ?? null,
    requiresOpenaiAuth: params.authMode == null,
  };
}

export function normalizeDeviceCodeLogin(result) {
  if (result?.type !== 'chatgptDeviceCode') throw new Error('Codex returned an unexpected login type.');
  if (!/^[0-9a-f-]{36}$/i.test(result.loginId ?? '')) throw new Error('Codex returned an invalid login ID.');
  const verificationUrl = new URL(result.verificationUrl);
  const allowedHost = verificationUrl.hostname === 'chatgpt.com'
    || verificationUrl.hostname === 'auth.openai.com'
    || verificationUrl.hostname.endsWith('.auth.openai.com');
  if (verificationUrl.protocol !== 'https:' || !allowedHost || verificationUrl.username || verificationUrl.password) {
    throw new Error('Codex returned an untrusted device-code verification URL.');
  }
  if (!/^[A-Z0-9-]{4,32}$/.test(result.userCode ?? '')) {
    throw new Error('Codex returned an invalid device code.');
  }
  return Object.freeze({
    type: 'chatgptDeviceCode',
    loginId: result.loginId,
    verificationUrl: verificationUrl.toString(),
    userCode: result.userCode,
  });
}

function requiredPrompt(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('A non-empty Codex prompt is required.');
  return content;
}

export function createCadApprovalOutcomePrompt({ proposalId, decision }) {
  if (!/^cadprop_[0-9a-f-]{36}$/i.test(proposalId ?? '')) throw new Error('Invalid TunaCAD CAD proposal ID.');
  if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid TunaCAD CAD approval outcome.');
  const outcome = decision === 'accept' ? 'approved and executed' : decision === 'decline' ? 'rejected' : 'cancelled';
  return [
    'Authoritative TunaCAD browser event.',
    `CAD proposal ${proposalId} was ${outcome} by the user inside TunaCAD.`,
    `Call cad_get_staged_plan with proposalId "${proposalId}" to read its authoritative status and execution report.`,
    'If its status detail contains a user replacement request, follow that instruction, inspect current state again, and call cad_stage_plan with a new fully validated replacement proposal.',
    'Do not call cad_execute_plan or attempt to approve the proposal yourself.',
    'Briefly report the result in this same TunaCAD conversation, including objective validation results when execution succeeded.',
  ].join(' ');
}
