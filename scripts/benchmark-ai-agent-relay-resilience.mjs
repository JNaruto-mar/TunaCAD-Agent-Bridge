import { EventEmitter, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { AgentBridgeRuntime } from '../agent-bridge/src/agent-bridge-runtime.mjs';
import {
  createAgentAdapterCapabilities,
  createAgentConnection,
  createAgentThread,
  createAgentTurn,
} from '../agent-bridge/src/agent-adapter-contract.mjs';
import { RelayConnectionSupervisor } from '../agent-bridge/src/relay-connection-supervisor.mjs';
import { createAgentBridgeEnvelope } from '../src/aiAgent/bridgeProtocol.mjs';

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const random = mulberry32(options.seed);
  const samples = [];
  const wallStartedAt = performance.now();

  for (let index = 0; index < options.samples; index += 1) {
    const outageDurationMs = Math.round(random() * options.maxOutageMs);
    const offlineEventCount = 1 + Math.floor(random() * options.maxOfflineEvents);
    samples.push(await runSample({ index, outageDurationMs, offlineEventCount, random }));
  }

  const successful = samples.filter((sample) => sample.status === 'reconnected');
  const failed = samples.filter((sample) => sample.status === 'failed');
  const result = {
    schemaVersion: 1,
    benchmark: 'tunacad-agent-relay-interruption-reconnection',
    mode: 'deterministic_virtual_fault_injection',
    seed: options.seed,
    sampleCount: samples.length,
    configuredMaximumOutageMs: options.maxOutageMs,
    wallClockElapsedMs: rounded(performance.now() - wallStartedAt),
    outcomes: {
      reconnected: successful.length,
      failed: failed.length,
    },
    recoveryMs: distribution(successful.map((sample) => sample.recoveryMs)),
    reconnectAttempts: distribution(successful.map((sample) => sample.reconnectAttempts)),
    replayBytes: distribution(successful.map((sample) => sample.replayBytes)),
    invariants: {
      lostEvents: sum(samples, 'lostEvents'),
      duplicateEvents: sum(samples, 'duplicateEvents'),
      codexProcessRestarts: sum(samples, 'codexProcessRestarts'),
      unexpectedFailures: failed.length,
    },
    outageBuckets: summarizeBuckets(successful),
  };

  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result.invariants).some((value) => value !== 0)) process.exitCode = 1;
}

async function runSample({ index, outageDurationMs, offlineEventCount, random: sampleRandom }) {
  const sessionId = 'a947edc2-6fc8-4e8d-a5e6-931ad75262fc';
  const pairing = Object.freeze({
    sessionId,
    bridgeToken: 'benchmark_bridge_token'.padEnd(43, 'b'),
    agentToken: 'benchmark_agent_token'.padEnd(43, 'a'),
    mcpUrl: `https://tunacad.com/mcp/${sessionId}`,
    bridgeWebSocketUrl: `wss://tunacad.com/api/ai/session/${sessionId}/bridge`,
    expiresAt: 4_102_444_800_000,
  });
  let virtualNowMs = 0;
  let networkAvailableAtMs = 0;
  let reconnecting = false;
  let injectedOfflineEvents = false;
  let adapterStarts = 0;
  let adapterStops = 0;
  let reconnectAttempts = 0;
  let reconnectDials = 0;
  let activeAdapter;
  const sockets = [];
  const cursorStore = { load: async () => null, save: async () => {} };
  const supervisor = new RelayConnectionSupervisor({
    pairing,
    cursorStore,
    now: () => virtualNowMs,
    random: sampleRandom,
    sleep: async (delayMs) => { virtualNowMs += delayMs; },
    socketFactory: () => {
      if (reconnecting) {
        reconnectDials += 1;
        if (!injectedOfflineEvents) {
          injectedOfflineEvents = true;
          for (let eventIndex = 0; eventIndex < offlineEventCount; eventIndex += 1) {
            activeAdapter.emit('event', {
              type: 'chat.assistant_delta',
              payload: {
                threadId: 'thread:benchmark',
                turnId: 'turn:benchmark',
                itemId: `item:offline:${eventIndex}`,
                delta: `offline-delta-${index}-${eventIndex}`,
              },
            });
          }
        }
        if (virtualNowMs < networkAvailableAtMs) throw new Error('Synthetic relay outage.');
      }
      const socket = new BenchmarkSocket();
      sockets.push(socket);
      return socket;
    },
    adapterFactory: () => {
      activeAdapter = new BenchmarkAdapter(
        () => { adapterStarts += 1; },
        () => { adapterStops += 1; },
      );
      return activeAdapter;
    },
    runtimeFactory: (runtimeOptions) => {
      return new AgentBridgeRuntime({
        ...runtimeOptions,
        now: () => new Date(1_800_000_000_000 + virtualNowMs),
      });
    },
  });
  supervisor.on('reconnecting', () => { reconnectAttempts += 1; });

  try {
    await supervisor.start();
    const initialSocket = sockets[0];
    activeAdapter.emit('event', {
      type: 'turn.started',
      payload: { threadId: 'thread:benchmark', turnId: 'turn:benchmark' },
    });
    activeAdapter.emit('event', {
      type: 'chat.assistant_delta',
      payload: {
        threadId: 'thread:benchmark',
        turnId: 'turn:benchmark',
        itemId: 'item:accepted',
        delta: 'accepted-before-interruption',
      },
    });
    const lastAcceptedSequence = Math.max(...initialSocket.messages().map((message) => message.sequence));
    networkAvailableAtMs = outageDurationMs;
    reconnecting = true;
    const connected = once(supervisor, 'connected');
    const failure = once(supervisor, 'failure').then(([error]) => error);
    initialSocket.close(1006, 'Synthetic benchmark relay interruption.');
    const outcome = await Promise.race([
      connected.then(([event]) => ({ status: 'reconnected', event })),
      failure.then((error) => ({ status: 'failed', error })),
    ]);
    if (outcome.status === 'failed') {
      return sampleFailure(index, outageDurationMs, offlineEventCount, reconnectAttempts, reconnectDials, adapterStarts, outcome.error);
    }

    const replacement = sockets.at(-1);
    replacement.emit('message', Buffer.from(JSON.stringify(createAgentBridgeEnvelope({
      type: 'session.resume',
      sessionId,
      sequence: 0,
      payload: {
        lastAcceptedSequence,
        supportedProtocols: ['tunacad.agent-bridge/1'],
        client: { name: 'tunacad-browser', version: 'benchmark', platform: 'test' },
      },
    }))));
    await waitFor(() => replacement.messages().filter(isOfflineDelta).length >= offlineEventCount);
    const replayed = replacement.messages().filter(isOfflineDelta);
    const uniqueIds = new Set(replayed.map((message) => message.payload.itemId));
    const replayBytes = replayed.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
    return {
      index,
      status: 'reconnected',
      outageDurationMs,
      recoveryMs: virtualNowMs,
      reconnectAttempts,
      reconnectDials,
      offlineEventCount,
      replayBytes,
      lostEvents: Math.max(0, offlineEventCount - uniqueIds.size),
      duplicateEvents: Math.max(0, replayed.length - uniqueIds.size),
      codexProcessRestarts: Math.max(0, adapterStarts - 1),
    };
  } finally {
    await supervisor.close();
    if (adapterStops > 1) throw new Error('Benchmark observed duplicate Codex runtime shutdown.');
  }
}

class BenchmarkSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) { this.sent.push(String(value)); }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  messages() { return this.sent.map((value) => JSON.parse(value)); }
}

class BenchmarkAdapter extends EventEmitter {
  constructor(onStart, onStop) {
    super();
    this.onStart = onStart;
    this.onStop = onStop;
    this.capabilities = createAgentAdapterCapabilities();
  }

  async connect() {
    this.onStart();
    return createAgentConnection({
      agent: { id: 'relay-benchmark', name: 'Relay Benchmark', version: '1.0.0' },
      account: { authMode: 'agentIdentity', planType: 'benchmark', requiresAuthentication: false },
    });
  }

  async startThread() { return createAgentThread({ threadId: 'thread:benchmark' }); }
  async startTurn(threadId) { return createAgentTurn({ threadId, turnId: 'turn:benchmark' }); }

  async close() { this.onStop(); }
}

function isOfflineDelta(message) {
  return message.type === 'chat.assistant_delta' && message.payload?.itemId?.startsWith('item:offline:');
}

function sampleFailure(index, outageDurationMs, offlineEventCount, reconnectAttempts, reconnectDials, adapterStarts, error) {
  return {
    index,
    status: 'failed',
    outageDurationMs,
    recoveryMs: null,
    reconnectAttempts,
    reconnectDials,
    offlineEventCount,
    replayBytes: 0,
    lostEvents: offlineEventCount,
    duplicateEvents: 0,
    codexProcessRestarts: Math.max(0, adapterStarts - 1),
    error: error instanceof Error ? error.message : String(error),
  };
}

function distribution(values) {
  if (values.length === 0) return { minimum: null, p50: null, p95: null, maximum: null };
  const ordered = [...values].sort((left, right) => left - right);
  return {
    minimum: ordered[0],
    p50: percentile(ordered, 0.5),
    p95: percentile(ordered, 0.95),
    maximum: ordered.at(-1),
  };
}

function percentile(ordered, quantile) {
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))];
}

function summarizeBuckets(successfulSamples) {
  const buckets = [5_000, 15_000, 30_000, 45_000];
  return buckets.map((maximum, index) => {
    const minimum = index === 0 ? 0 : buckets[index - 1];
    const matching = successfulSamples.filter((sample) => (
      sample.outageDurationMs <= maximum
      && (index === 0 ? sample.outageDurationMs >= minimum : sample.outageDurationMs > minimum)
    ));
    return {
      outageRangeMs: [minimum, maximum],
      samples: matching.length,
      recoveryMs: distribution(matching.map((sample) => sample.recoveryMs)),
    };
  });
}

function sum(values, key) {
  return values.reduce((total, value) => total + value[key], 0);
}

function rounded(value) { return Math.round(value * 100) / 100; }

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let output = value;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function parseOptions(args) {
  const read = (name, fallback) => {
    const direct = args.find((arg) => arg.startsWith(`--${name}=`));
    const index = args.indexOf(`--${name}`);
    const raw = direct?.slice(name.length + 3) ?? (index >= 0 ? args[index + 1] : undefined);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer.`);
    return value;
  };
  return {
    samples: read('samples', 100),
    seed: read('seed', 32_034),
    maxOutageMs: read('max-outage-ms', 45_000),
    maxOfflineEvents: read('max-offline-events', 64),
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for benchmark replay.');
}

await main();
