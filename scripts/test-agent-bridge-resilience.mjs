import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RelayConnectionSupervisor } from '../agent-bridge/src/relay-connection-supervisor.mjs';
import {
  createAgentAdapterCapabilities,
  createAgentConnection,
  createAgentThread,
  createAgentTurn,
} from '../agent-bridge/src/agent-adapter-contract.mjs';
import { FileCursorStore } from '../agent-bridge/src/cursor-store.mjs';
import { isRelaySocketStale, nextRelayHeartbeatAlarm } from '../src/aiAgent/relayHeartbeat.mjs';
import { createRelayControlMessage, parseRelayControlMessage } from '../src/aiAgent/relayControl.mjs';
import { createAgentBridgeEnvelope } from '../src/aiAgent/bridgeProtocol.mjs';
import { jitterReconnectDelay, remainingReconnectBudget } from '../src/aiAgent/reconnectPolicy.mjs';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) {
    this.sent.push(String(value));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  terminate() {
    this.close(1006, 'Synthetic socket terminated.');
  }

  messages() {
    return this.sent.map((value) => JSON.parse(value));
  }
}

class PendingSocket extends FakeSocket {
  constructor() {
    super();
    this.readyState = 0;
  }
}

class MemoryCursorStore {
  async load() { return null; }
  async save() {}
}

class FakeAdapter extends EventEmitter {
  constructor(onStart, onClose) {
    super();
    this.onStart = onStart;
    this.onClose = onClose;
    this.capabilities = createAgentAdapterCapabilities();
  }

  async connect() {
    this.onStart();
    return createAgentConnection({
      agent: { id: 'resilience-fixture', name: 'Resilience Fixture', version: '1.0.0' },
      account: { authMode: 'agentIdentity', planType: 'test', requiresAuthentication: false },
    });
  }

  async startThread() { return createAgentThread({ threadId: 'thread:resilience' }); }
  async startTurn(threadId) { return createAgentTurn({ threadId, turnId: 'turn:resilience' }); }

  async close() {
    this.onClose();
  }
}

assert.equal(isRelaySocketStale(1_000, 45_999, 45_000), false);
assert.equal(isRelaySocketStale(1_000, 46_000, 45_000), true);
assert.equal(nextRelayHeartbeatAlarm(100_000, 10_000, 15_000), 25_000);
assert.equal(nextRelayHeartbeatAlarm(20_000, 10_000, 15_000), 20_000);
assert.equal(jitterReconnectDelay(1_000, 0.2, 0), 1_000);
assert.equal(jitterReconnectDelay(1_000, 0.2, 0.5), 900);
assert.equal(jitterReconnectDelay(1_000, 0.2, 1), 800);
assert.equal(remainingReconnectBudget(1_000, 31_000, 70_000), 40_000);
assert.throws(() => jitterReconnectDelay(1_000, 1.1, 0.5), /jitter ratio/);

const sessionId = 'a947edc2-6fc8-4e8d-a5e6-931ad75262fc';
const rotationId = '374ad2e7-1de6-4778-a764-a124e100dd13';
const rotateControl = createRelayControlMessage('credentials.rotate', {
  sessionId,
  rotationId,
  bridgeToken: 'b'.repeat(43),
  agentToken: 'a'.repeat(43),
  expiresAt: Date.now() + 60_000,
});
assert.equal(parseRelayControlMessage(JSON.stringify(rotateControl), 'server').type, 'credentials.rotate');
assert.throws(() => parseRelayControlMessage(JSON.stringify({ ...rotateControl, unexpected: true }), 'server'));

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'tunacad-agent-bridge-resilience-'));
const cursorFile = path.join(temporaryDirectory, 'cursors.json');
const cursorStore = new FileCursorStore({ filePath: cursorFile });
try {
  await cursorStore.save({ sessionId, nextOutgoingSequence: 4, lastBrowserSequence: 2 });
  assert.deepEqual(await cursorStore.load(sessionId), {
    sessionId,
    nextOutgoingSequence: 4,
    lastBrowserSequence: 2,
    updatedAt: (await cursorStore.load(sessionId)).updatedAt,
  });
  await cursorStore.save({ sessionId, nextOutgoingSequence: 5, lastBrowserSequence: 3 });
  const cursorText = await readFile(cursorFile, 'utf8');
  assert.equal(cursorText.includes('agentToken'), false);
  assert.equal(cursorText.includes('bridgeToken'), false);
  await assert.rejects(
    cursorStore.save({ sessionId, nextOutgoingSequence: 6, lastBrowserSequence: 4, agentToken: 'forbidden' }),
    /forbidden field agentToken/,
  );

  const originalPairing = Object.freeze({
    sessionId,
    bridgeToken: 'original_bridge_token_'.padEnd(43, 'b'),
    agentToken: 'original_agent_token__'.padEnd(43, 'a'),
    mcpUrl: `https://tunacad.com/mcp/${sessionId}`,
    bridgeWebSocketUrl: `wss://tunacad.com/api/ai/session/${sessionId}/bridge`,
    expiresAt: Date.now() + 3_600_000,
  });
  const sockets = [];
  const pairingSeenBySocketFactory = [];
  let connectionAttempts = 0;
  let adapterStarts = 0;
  let adapterCloses = 0;
  const reconnectSleeps = [];
  const supervisor = new RelayConnectionSupervisor({
    pairing: originalPairing,
    cursorStore,
    reconnectDelaysMs: [10, 20, 40],
    reconnectJitterRatio: 0.2,
    random: () => 0,
    sleep: async (delayMs) => { reconnectSleeps.push(delayMs); },
    socketFactory: (pairing) => {
      pairingSeenBySocketFactory.push(pairing);
      connectionAttempts += 1;
      if (connectionAttempts <= 2) throw new Error('Synthetic relay dial failure.');
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    adapterFactory: () => new FakeAdapter(
      () => { adapterStarts += 1; },
      () => { adapterCloses += 1; },
    ),
  });
  supervisor.on('failure', (error) => { throw error; });
  try {
    const ready = await supervisor.start();
    assert.equal(ready.status, 'ready');
    assert.deepEqual(reconnectSleeps, [10, 20]);
    assert.equal(adapterStarts, 1);
    assert.equal(JSON.stringify(sockets[0].sent).includes(originalPairing.agentToken), false);

    const resumedConnection = once(supervisor, 'connected');
    sockets[0].close(1006, 'Synthetic transport loss.');
    const [resumed] = await resumedConnection;
    assert.equal(resumed.resumed, true);
    assert.equal(adapterStarts, 1, 'Ordinary relay reconnect must preserve the Codex process.');
    sockets[1].emit('message', Buffer.from(JSON.stringify(createAgentBridgeEnvelope({
      type: 'session.resume',
      sessionId,
      sequence: 4,
      payload: {
        lastAcceptedSequence: 6,
        supportedProtocols: ['tunacad.agent-bridge/1'],
        client: { name: 'tunacad-browser', version: '0.1.0', platform: 'test' },
      },
    }))));
    await waitFor(() => sockets[1].messages().some((message) => message.type === 'bridge.ready'));
    assert.ok(sockets[1].messages().some((message) => message.type === 'bridge.ready'));

    const activeSocket = sockets[1];
    activeSocket.emit('message', Buffer.from(JSON.stringify(rotateControl)));
    await waitFor(() => activeSocket.messages().some((message) => message.type === 'credentials.ack'));
    const committedEvent = once(supervisor, 'rotationCommitted');
    activeSocket.emit('message', Buffer.from(JSON.stringify(createRelayControlMessage('credentials.committed', {
      sessionId,
      rotationId,
    }))));
    const rotatedConnection = once(supervisor, 'connected');
    activeSocket.close(4411, 'Credentials rotated.');
    await committedEvent;
    const [rotated] = await rotatedConnection;
    assert.equal(rotated.resumed, false);
    assert.equal(adapterStarts, 2, 'MCP credential rotation must restart Codex with a new child environment.');
    assert.ok(adapterCloses >= 1);
    assert.equal(pairingSeenBySocketFactory.at(-1).bridgeToken, rotateControl.bridgeToken);
    assert.equal(pairingSeenBySocketFactory.at(-1).agentToken, rotateControl.agentToken);
    assert.equal((await cursorStore.load(sessionId)).nextOutgoingSequence >= 7, true);
    const finalCursorText = await readFile(cursorFile, 'utf8');
    assert.equal(finalCursorText.includes(rotateControl.bridgeToken), false);
    assert.equal(finalCursorText.includes(rotateControl.agentToken), false);
  } finally {
    await supervisor.close();
  }


  await verifyHalfOpenSocketDeadline(originalPairing);
  await verifyReconnectExhaustion(originalPairing);
  await verifyReconnectCancellation(originalPairing);
  await verifyBackoffCancellation(originalPairing);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('[agent-bridge] Bounded jittered reconnect, socket-open deadlines, cancellation, process preservation, cursor safety, heartbeat deadlines, and acknowledged credential rotation passed.');

async function verifyHalfOpenSocketDeadline(pairing) {
  const pending = new PendingSocket();
  const supervisor = new RelayConnectionSupervisor({
    pairing,
    cursorStore: new MemoryCursorStore(),
    reconnectDelaysMs: [],
    socketOpenTimeoutMs: 15,
    reconnectBudgetMs: 100,
    socketFactory: () => pending,
    adapterFactory: () => new FakeAdapter(() => {}, () => {}),
  });
  const startedAt = Date.now();
  await assert.rejects(supervisor.start(), /did not open within 15 ms/);
  assert.ok(Date.now() - startedAt < 500, 'A half-open relay dial must fail on its explicit open deadline.');
  assert.equal(pending.readyState, 3, 'A timed-out relay socket must be terminated.');
  await supervisor.close();
}

async function verifyReconnectExhaustion(pairing) {
  const sleeps = [];
  let attempts = 0;
  const supervisor = new RelayConnectionSupervisor({
    pairing,
    cursorStore: new MemoryCursorStore(),
    reconnectDelaysMs: [10, 20],
    reconnectJitterRatio: 0.2,
    random: () => 1,
    reconnectBudgetMs: 100,
    sleep: async (delayMs) => { sleeps.push(delayMs); },
    socketFactory: () => {
      attempts += 1;
      throw new Error('Synthetic exhausted relay dial.');
    },
    adapterFactory: () => new FakeAdapter(() => {}, () => {}),
  });
  await assert.rejects(supervisor.start(), /Synthetic exhausted relay dial/);
  assert.equal(attempts, 3, 'Initial dial plus two bounded retries must be attempted exactly once each.');
  assert.deepEqual(sleeps, [8, 16], 'Reconnect slots must apply deterministic bounded jitter.');
  await supervisor.close();
}

async function verifyReconnectCancellation(pairing) {
  const initial = new FakeSocket();
  const pending = new PendingSocket();
  let socketAttempt = 0;
  let adapterCloses = 0;
  const failures = [];
  const supervisor = new RelayConnectionSupervisor({
    pairing,
    cursorStore: new MemoryCursorStore(),
    reconnectDelaysMs: [1],
    socketOpenTimeoutMs: 5_000,
    reconnectBudgetMs: 6_000,
    sleep: async () => {},
    socketFactory: () => (socketAttempt++ === 0 ? initial : pending),
    adapterFactory: () => new FakeAdapter(() => {}, () => { adapterCloses += 1; }),
  });
  supervisor.on('failure', (error) => failures.push(error));
  await supervisor.start();
  initial.close(1006, 'Synthetic interruption before cancellation.');
  await waitFor(() => socketAttempt === 2);
  await supervisor.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pending.readyState, 3, 'Closing the supervisor must terminate a pending reconnect dial.');
  assert.equal(adapterCloses, 1, 'Cancellation must close the preserved Codex runtime exactly once.');
  assert.deepEqual(failures, [], 'Intentional reconnect cancellation must not surface as a transport failure.');
}

async function verifyBackoffCancellation(pairing) {
  const initial = new FakeSocket();
  let socketAttempt = 0;
  let adapterCloses = 0;
  const failures = [];
  const supervisor = new RelayConnectionSupervisor({
    pairing,
    cursorStore: new MemoryCursorStore(),
    reconnectDelaysMs: [5_000],
    socketFactory: () => {
      if (socketAttempt++ === 0) return initial;
      throw new Error('Synthetic dial failure before cancellable backoff.');
    },
    adapterFactory: () => new FakeAdapter(() => {}, () => { adapterCloses += 1; }),
  });
  supervisor.on('failure', (error) => failures.push(error));
  await supervisor.start();
  const backoffStarted = once(supervisor, 'reconnecting');
  initial.close(1006, 'Synthetic interruption before cancellable backoff.');
  await backoffStarted;
  const closeStartedAt = Date.now();
  await supervisor.close();
  assert.ok(Date.now() - closeStartedAt < 500, 'Closing the supervisor must cancel a pending backoff immediately.');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adapterCloses, 1, 'Backoff cancellation must close the preserved Codex runtime exactly once.');
  assert.deepEqual(failures, [], 'Intentional backoff cancellation must not surface as a transport failure.');
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for resilience state.');
}
