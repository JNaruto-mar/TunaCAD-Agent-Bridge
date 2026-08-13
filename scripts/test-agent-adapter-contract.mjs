import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  AGENT_ADAPTER_CONTRACT_VERSION,
  assertAgentAdapter,
  assertAgentAdapterEvent,
  assertAgentAuthenticationChallenge,
  assertAgentConnection,
  assertAgentThread,
  assertAgentTurn,
  createAgentAccountState,
  createAgentAdapterCapabilities,
  createAgentConnection,
  createAgentThread,
  createAgentTurn,
  requireAgentAdapterCapability,
  toBridgeAccountState,
} from '../agent-bridge/src/agent-adapter-contract.mjs';
import { AgentBridgeRuntime } from '../agent-bridge/src/agent-bridge-runtime.mjs';
import { CodexAppServerAdapter } from '../agent-bridge/src/codex-app-server-adapter.mjs';
import { createAgentBridgeEnvelope } from '../src/aiAgent/bridgeProtocol.mjs';

class FixtureSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) { this.sent.push(String(value)); }
  messages() { return this.sent.map((value) => JSON.parse(value)); }
}

class ConformingAgentAdapter extends EventEmitter {
  constructor({ capabilities } = {}) {
    super();
    this.capabilities = createAgentAdapterCapabilities(capabilities ?? {
      interactiveAuthentication: true,
      threadResume: true,
      turnSteering: true,
      turnCancellation: true,
      approvalResponses: true,
      userInputResponses: true,
      cadOutcomeReporting: true,
    });
    this.calls = [];
  }

  async connect() {
    this.calls.push(['connect']);
    return createAgentConnection({
      agent: { id: 'fixture-agent', name: 'Fixture Agent', version: '9.4.1' },
      account: { authMode: 'agentIdentity', planType: 'fixture', requiresAuthentication: false },
    });
  }

  async beginAuthentication() {
    this.calls.push(['beginAuthentication']);
    return {
      authenticationId: 'auth:fixture',
      verificationUrl: 'https://fixture.invalid/verify',
      userCode: 'TUNA-FIXTURE',
      completion: Promise.resolve({
        account: createAgentAccountState({
          authMode: 'agentIdentity', planType: 'fixture', requiresAuthentication: false,
        }),
      }),
    };
  }

  async startThread(options = {}) {
    this.calls.push(['startThread', options]);
    return createAgentThread({ threadId: 'thread:fixture', resumed: false });
  }

  async resumeThread(threadId) {
    this.calls.push(['resumeThread', threadId]);
    return createAgentThread({ threadId, resumed: true });
  }

  async startTurn(threadId, input) {
    this.calls.push(['startTurn', threadId, input]);
    return createAgentTurn({ threadId, turnId: 'turn:fixture' });
  }

  async steerTurn(threadId, turnId, input) { this.calls.push(['steerTurn', threadId, turnId, input]); }
  async cancelTurn(threadId, turnId) { this.calls.push(['cancelTurn', threadId, turnId]); }
  async respondToApproval(requestId, decision) { this.calls.push(['respondToApproval', requestId, decision]); }
  async respondToUserInput(requestId, answers) { this.calls.push(['respondToUserInput', requestId, answers]); }
  async reportCadApproval(outcome) { this.calls.push(['reportCadApproval', outcome]); }
  async close() { this.calls.push(['close']); }
}

const capabilities = createAgentAdapterCapabilities({ threadResume: true });
assert.equal(capabilities.threadResume, true);
assert.equal(capabilities.turnSteering, false);
assert.throws(() => createAgentAdapterCapabilities({ unknownCapability: true }), /Unknown agent adapter capability/);
assert.throws(() => createAgentAdapterCapabilities({ threadResume: 'yes' }), /must be boolean/);

const incomplete = new EventEmitter();
incomplete.capabilities = createAgentAdapterCapabilities();
assert.throws(() => assertAgentAdapter(incomplete), /connect/);

const malformedCapability = new ConformingAgentAdapter({ capabilities: { threadResume: true } });
malformedCapability.resumeThread = undefined;
assert.throws(() => assertAgentAdapter(malformedCapability), /resumeThread/);

const codexContract = assertAgentAdapter(new CodexAppServerAdapter({
  pairing: { mcpUrl: 'https://tunacad.invalid/mcp/fixture', agentToken: 'fixture-token' },
}));
assert.equal(codexContract.contractVersion, AGENT_ADAPTER_CONTRACT_VERSION);
assert.ok(Object.values(codexContract.capabilities).every(Boolean));

const normalizedConnection = assertAgentConnection(createAgentConnection({
  agent: { id: 'fixture-agent', name: 'Fixture Agent', version: '9.4.1' },
  account: { authMode: 'headers', planType: null, requiresAuthentication: false },
}));
assert.equal(normalizedConnection.agent.name, 'Fixture Agent');
assert.deepEqual(toBridgeAccountState(normalizedConnection.account), {
  authMode: 'headers', planType: null, requiresOpenaiAuth: false,
});
assert.throws(() => assertAgentConnection({ ...normalizedConnection, contractVersion: 'unknown/1' }), /must use/);
assert.throws(() => assertAgentConnection({ ...normalizedConnection, initialized: {} }), /keys are invalid/);
assert.throws(() => assertAgentThread({ thread: { id: 'provider-specific' } }), /keys are invalid/);
assert.throws(() => assertAgentThread({ threadId: 'thread:fixture', resumed: false, thread: {} }), /keys are invalid/);
assert.throws(() => assertAgentTurn({ turn: { id: 'provider-specific' } }), /keys are invalid/);
assert.throws(() => assertAgentAdapterEvent({
  type: 'account.updated',
  payload: { authMode: null, planType: null, requiresOpenaiAuth: true },
}), /keys are invalid/);
assert.throws(() => assertAgentAuthenticationChallenge({
  authenticationId: 'auth:bad',
  verificationUrl: 'http://fixture.invalid/verify',
  userCode: 'BAD',
  completion: Promise.resolve(),
}), /credential-free HTTPS/);

const pairing = Object.freeze({
  sessionId: 'fb53bd83-35ae-42c5-b9cf-f03455d23168',
  agentToken: 'phase36_secret_agent_token',
  mcpUrl: 'https://tunacad.invalid/mcp/phase36',
});
const socket = new FixtureSocket();
const adapter = new ConformingAgentAdapter();
const runtime = new AgentBridgeRuntime({ pairing, socket, adapter });
let sequence = 0;
const browserMessage = (type, payload) => JSON.stringify(createAgentBridgeEnvelope({
  type,
  sessionId: pairing.sessionId,
  sequence: sequence++,
  payload,
}));

try {
  const started = await runtime.start();
  assert.equal(started.status, 'ready');
  assert.equal(started.agent.name, 'Fixture Agent');
  const ready = socket.messages().find((message) => message.type === 'bridge.ready');
  assert.deepEqual(ready.payload.agent, { name: 'Fixture Agent', version: '9.4.1' });

  await runtime.handleBrowserMessage(browserMessage('thread.start', {}));
  await runtime.handleBrowserMessage(browserMessage('thread.resume', { threadId: 'thread:fixture' }));
  await runtime.handleBrowserMessage(browserMessage('chat.user_message', {
    threadId: 'thread:fixture', content: 'Provider-neutral turn.', clientMessageId: 'client:fixture',
  }));
  await runtime.handleBrowserMessage(browserMessage('chat.steer', {
    threadId: 'thread:fixture', turnId: 'turn:fixture', content: 'Steer fixture.',
  }));
  await runtime.handleBrowserMessage(browserMessage('run.cancel', {
    threadId: 'thread:fixture', turnId: 'turn:fixture', reason: 'Fixture cancellation.',
  }));
  await runtime.handleBrowserMessage(browserMessage('approval.decision', {
    approvalId: 'approval:fixture', domain: 'agent', decision: 'accept',
  }));
  await runtime.handleBrowserMessage(browserMessage('user_input.response', {
    inputRequestId: 'input:fixture', answers: { dimension: '42' },
  }));
  await runtime.handleBrowserMessage(browserMessage('approval.decision', {
    approvalId: 'cadapproval:cadprop_30000000-0000-4000-8000-000000000036',
    domain: 'cad',
    decision: 'accept',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  for (const method of [
    'connect', 'startThread', 'resumeThread', 'startTurn', 'steerTurn', 'cancelTurn',
    'respondToApproval', 'respondToUserInput', 'reportCadApproval',
  ]) {
    assert.ok(adapter.calls.some(([name]) => name === method), `${method} was not exercised.`);
  }

  adapter.emit('event', {
    type: 'account.updated',
    payload: { authMode: 'agentIdentity', planType: 'fixture', requiresAuthentication: false },
  });
  assert.equal(socket.messages().at(-2).type, 'account.updated');
  assert.equal(socket.messages().at(-2).payload.requiresOpenaiAuth, false);

  adapter.emit('event', {
    type: 'chat.assistant_delta',
    payload: { threadId: 'thread:fixture', turnId: 'turn:fixture', itemId: 'item:bad', delta: '' },
  });
  assert.equal(socket.messages().at(-1).payload.code, 'AGENT_EVENT_REJECTED');
} finally {
  await runtime.close();
}

const limitedAdapter = new ConformingAgentAdapter({ capabilities: {} });
assert.throws(() => requireAgentAdapterCapability(limitedAdapter, 'threadResume'), /does not support/);
const limitedRuntime = new AgentBridgeRuntime({ pairing, socket: new FixtureSocket(), adapter: limitedAdapter });
try {
  await limitedRuntime.start();
  await assert.rejects(limitedRuntime.handleBrowserMessage(JSON.stringify(createAgentBridgeEnvelope({
    type: 'thread.resume',
    sessionId: pairing.sessionId,
    sequence: 0,
    payload: { threadId: 'thread:unsupported' },
  }))), /does not support threadResume/);
} finally {
  await limitedRuntime.close();
}

console.log('[phase3.6] Provider-neutral adapter contract, Codex conformance, normalization, capabilities, and fail-closed fixtures passed.');
