import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AgentBridgeRuntime } from '../agent-bridge/src/agent-bridge-runtime.mjs';
import {
  CodexAppServerAdapter,
  TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE,
  createCodexLaunchArguments,
  normalizeDeviceCodeLogin,
} from '../agent-bridge/src/codex-app-server-adapter.mjs';
import { CodexAppServerClient } from './lib/codex-app-server-client.mjs';
import { createAgentBridgeEnvelope } from '../src/aiAgent/bridgeProtocol.mjs';

class FakeRelaySocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) {
    this.sent.push(String(value));
  }

  messages() {
    return this.sent.map((value) => JSON.parse(value));
  }

  types() {
    return this.messages().map((message) => message.type);
  }
}

const sessionId = 'af851c18-29a7-4ae3-98d8-a83d28ee936b';
const pairing = Object.freeze({
  sessionId,
  agentToken: 'phase31_secret_mcp_token',
  mcpUrl: 'https://tunacad.invalid/mcp/probe',
});
const fixture = fileURLToPath(new URL('./fixtures/mock-codex-app-server.mjs', import.meta.url));
const socket = new FakeRelaySocket();
assert.throws(() => normalizeDeviceCodeLogin({
  type: 'chatgptDeviceCode',
  loginId: '6deca20b-f0bd-427c-8e5c-fbe7fcbab265',
  verificationUrl: 'https://example.com/phishing',
  userCode: 'TUNA-CAD1',
}), /untrusted/);
let launchOptions;
const adapter = new CodexAppServerAdapter({
  pairing,
  codexBinary: 'codex-test',
  versionReader: () => ({ version: '0.147.0', output: 'codex-cli 0.147.0' }),
  clientFactory: (options) => {
    launchOptions = options;
    return new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      env: options.env,
      requestTimeoutMs: 2_000,
    });
  },
});
let uuidCounter = 0;
const runtime = new AgentBridgeRuntime({
  pairing,
  socket,
  adapter,
  now: () => new Date('2026-08-09T12:00:00.000Z'),
  uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
});

try {
  const started = await runtime.start();
  assert.equal(started.status, 'ready');
  assert.equal(started.version, '0.147.0');
  assert.equal(started.account.authMode, 'chatgpt');
  assert.equal(started.account.requiresOpenaiAuth, false);
  assert.equal(launchOptions.env[TUNACAD_MCP_TOKEN_ENVIRONMENT_VARIABLE], pairing.agentToken);
  assert.equal(JSON.stringify(launchOptions.args).includes(pairing.agentToken), false);
  assert.deepEqual(launchOptions.args, createCodexLaunchArguments(pairing.mcpUrl));
  assert.deepEqual(socket.types().slice(0, 2), ['account.updated', 'bridge.ready']);
  assert.equal(socket.messages()[1].payload.agent.version, '0.147.0');
  assert.equal(socket.sent.join('').includes(pairing.agentToken), false);
  adapter.emit('error', new Error(`Bearer ${pairing.agentToken}`));
  assert.equal(socket.messages().at(-1).payload.message, 'Bearer [REDACTED]');
  assert.equal(socket.sent.join('').includes(pairing.agentToken), false);

  let browserSequence = 0;
  const browserMessage = (type, payload) => JSON.stringify(createAgentBridgeEnvelope({
    type,
    sessionId,
    sequence: browserSequence++,
    payload,
    now: new Date('2026-08-09T12:00:00.000Z'),
    uuid: () => `10000000-0000-4000-8000-${String(browserSequence).padStart(12, '0')}`,
  }));

  await runtime.handleBrowserMessage(browserMessage('thread.start', {}));
  await waitForSent(socket, (message) => message.type === 'thread.started');

  await runtime.handleBrowserMessage(browserMessage('chat.user_message', {
    threadId: 'thread:mock',
    content: 'Run the deterministic companion turn.',
    clientMessageId: 'client:normal',
  }));
  const completed = await waitForSent(socket, (message) => message.type === 'turn.completed');
  assert.equal(completed.payload.status, 'completed');
  assert.ok(socket.types().includes('chat.assistant_delta'));

  await runtime.handleBrowserMessage(browserMessage('chat.user_message', {
    threadId: 'thread:mock',
    content: 'APPROVAL_LIFECYCLE',
    clientMessageId: 'client:approval',
  }));
  const approval = await waitForSent(socket, (message) => message.type === 'approval.requested');
  assert.equal(approval.payload.kind, 'command');
  await runtime.handleBrowserMessage(browserMessage('approval.decision', {
    approvalId: approval.payload.approvalId,
    domain: 'agent',
    decision: 'accept',
  }));
  const resolved = await waitForSent(
    socket,
    (message) => message.type === 'approval.resolved' && message.payload.approvalId === approval.payload.approvalId,
  );
  assert.equal(resolved.payload.decision, 'accept');

  runtime.sendHeartbeat('hb_runtime_test');
  const heartbeat = socket.messages().find((message) => message.type === 'heartbeat.ping');
  assert.equal(heartbeat.payload.nonce, 'hb_runtime_test');
  const heartbeatPong = browserMessage('heartbeat.pong', { nonce: 'hb_runtime_test' });
  await runtime.handleBrowserMessage(heartbeatPong);
  assert.equal(runtime.lastHeartbeatAt, new Date('2026-08-09T12:00:00.000Z').getTime());

  await assert.rejects(
    runtime.handleBrowserMessage(heartbeatPong),
    /replay rejected/,
  );
  assert.equal(socket.sent.join('').includes(pairing.agentToken), false);
} finally {
  await runtime.close();
}

const loginSocket = new FakeRelaySocket();
const loginRuntime = new AgentBridgeRuntime({
  pairing,
  socket: loginSocket,
  adapter: new CodexAppServerAdapter({
    pairing,
    codexBinary: 'codex-test',
    versionReader: () => ({ version: '0.147.0', output: 'codex-cli 0.147.0' }),
    clientFactory: (options) => new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      env: { ...options.env, TUNACAD_MOCK_LOGIN_REQUIRED: '1' },
      requestTimeoutMs: 2_000,
    }),
  }),
});
try {
  const loginRequired = await loginRuntime.start();
  assert.equal(loginRequired.status, 'authentication_required');
  assert.equal(loginRequired.login.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(loginRequired.login.userCode, 'TUNA-CAD1');
  assert.deepEqual(loginSocket.types().slice(0, 2), ['account.updated', 'run.failed']);
  assert.equal(loginSocket.messages()[1].payload.code, 'CODEX_LOGIN_REQUIRED');
  assert.match(loginSocket.messages()[1].payload.message, /TUNA-CAD1/);
  const loginCompleted = await loginRequired.login.completion;
  assert.equal(loginCompleted.account.authMode, 'chatgpt');
  assert.equal(loginCompleted.account.requiresOpenaiAuth, false);
  await waitForSent(loginSocket, (message) => message.type === 'bridge.ready');
  assert.ok(loginSocket.types().includes('account.updated'));
  assert.equal(loginSocket.sent.join('').includes(pairing.agentToken), false);
} finally {
  await loginRuntime.close();
}

const cancellationAdapter = new CodexAppServerAdapter({
  pairing,
  codexBinary: 'codex-test',
  versionReader: () => ({ version: '0.147.0', output: 'codex-cli 0.147.0' }),
  clientFactory: (options) => new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    env: { ...options.env, TUNACAD_MOCK_LOGIN_REQUIRED: '1', TUNACAD_MOCK_LOGIN_DELAY_MS: '1000' },
    requestTimeoutMs: 2_000,
  }),
});
try {
  const connected = await cancellationAdapter.connect();
  assert.equal(connected.account.requiresOpenaiAuth, true);
  const pendingLogin = await cancellationAdapter.startDeviceCodeLogin();
  await cancellationAdapter.cancelDeviceCodeLogin(pendingLogin.loginId);
  await assert.rejects(pendingLogin.completion, /did not complete successfully/);
  await assert.rejects(cancellationAdapter.cancelDeviceCodeLogin(pendingLogin.loginId), /Unknown or completed/);
} finally {
  await cancellationAdapter.close();
}

console.log('[agent-bridge] Companion Codex stdio supervision, managed device-code login, process-scoped MCP config, authenticated Ready, streaming, approvals, heartbeat, and replay defense passed.');

async function waitForSent(relaySocket, predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = relaySocket.messages().find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for companion relay output.');
}
