import { EventEmitter } from 'node:events';
import { AGENT_BRIDGE_TIMING_POLICY } from '../../src/aiAgent/bridgeCompatibility.mjs';
import { jitterReconnectDelay, remainingReconnectBudget } from '../../src/aiAgent/reconnectPolicy.mjs';
import {
  AGENT_RELAY_CONTROL_PROTOCOL,
  createRelayControlMessage,
  parseRelayControlMessage,
} from '../../src/aiAgent/relayControl.mjs';
import { AgentBridgeRuntime } from './agent-bridge-runtime.mjs';
import { createAgentAdapter, parseAgentProvider } from './agent-adapter-registry.mjs';
import { FileCursorStore } from './cursor-store.mjs';
import { openRelaySocket } from './relay-client.mjs';

const TERMINAL_CLOSE_CODES = new Set([1000, 4001, 4002, 4400, 4403, 4409]);

export class RelayConnectionSupervisor extends EventEmitter {
  constructor({
    pairing,
    agentProvider = 'codex',
    socketFactory = (credentials) => openRelaySocket(credentials),
    adapterFactory = (credentials) => createAgentAdapter({ provider: agentProvider, pairing: credentials }),
    runtimeFactory = (options) => new AgentBridgeRuntime(options),
    cursorStore = new FileCursorStore(),
    reconnectDelaysMs = AGENT_BRIDGE_TIMING_POLICY.reconnectDelaysMs,
    socketOpenTimeoutMs = AGENT_BRIDGE_TIMING_POLICY.relaySocketOpenTimeoutMs,
    reconnectBudgetMs = AGENT_BRIDGE_TIMING_POLICY.reconnectBudgetMs,
    reconnectJitterRatio = AGENT_BRIDGE_TIMING_POLICY.reconnectJitterRatio,
    random = Math.random,
    now = Date.now,
    sleep = cancellableDelay,
  }) {
    super();
    this.pairing = pairing;
    this.agentProvider = parseAgentProvider(agentProvider);
    this.socketFactory = socketFactory;
    this.adapterFactory = adapterFactory;
    this.runtimeFactory = runtimeFactory;
    this.cursorStore = cursorStore;
    this.reconnectDelaysMs = [...reconnectDelaysMs];
    this.socketOpenTimeoutMs = socketOpenTimeoutMs;
    this.reconnectBudgetMs = reconnectBudgetMs;
    this.reconnectJitterRatio = reconnectJitterRatio;
    this.random = random;
    this.now = now;
    this.sleep = sleep;
    this.transportAbort = new AbortController();
    this.socket = null;
    this.runtime = null;
    this.started = false;
    this.closed = false;
    this.reconnecting = null;
    this.pendingPairing = null;
    this.pendingRotationId = null;
    this.rotationCommitted = false;
    this.rotationTransition = null;
    this.cursorWrite = Promise.resolve();
  }

  async start() {
    if (this.started) throw new Error('Relay connection supervisor is already started.');
    this.started = true;
    const socket = await this.#connectWithBackoff();
    const result = await this.#activateSocket(socket);
    return result;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.transportAbort.abort();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'TunaCAD Agent Bridge stopped.');
    await this.runtime?.close();
    this.runtime = null;
    await this.cursorWrite.catch(() => undefined);
  }

  sendHeartbeat() {
    if (!this.runtime || !this.socket || this.socket.readyState !== 1) return false;
    this.runtime.sendHeartbeat();
    return true;
  }

  async #connectWithBackoff() {
    let lastError;
    const startedAtMs = this.now();
    const signal = this.transportAbort.signal;
    for (let attempt = 0; attempt <= this.reconnectDelaysMs.length; attempt += 1) {
      if (this.closed) throw new Error('Relay connection supervisor is closed.');
      if (attempt > 0) {
        const remainingMs = remainingReconnectBudget(startedAtMs, this.now(), this.reconnectBudgetMs);
        if (remainingMs <= 0) break;
        const baseDelayMs = this.reconnectDelaysMs[attempt - 1];
        const delayMs = Math.min(
          remainingMs,
          jitterReconnectDelay(baseDelayMs, this.reconnectJitterRatio, this.random()),
        );
        this.emit('reconnecting', { attempt, delayMs, baseDelayMs });
        await raceWithAbort(this.sleep(delayMs, signal), signal);
      }
      try {
        const socket = this.socketFactory(this.pairing);
        const remainingMs = remainingReconnectBudget(startedAtMs, this.now(), this.reconnectBudgetMs);
        if (remainingMs <= 0) {
          closePendingSocket(socket, 'TunaCAD relay reconnect budget was exhausted.');
          break;
        }
        await waitForOpen(socket, {
          timeoutMs: Math.min(this.socketOpenTimeoutMs, remainingMs),
          signal,
        });
        return socket;
      } catch (error) {
        if (signal.aborted) throw abortError();
        lastError = error;
      }
    }
    throw lastError ?? new Error(`TunaCAD relay reconnect budget was exhausted after ${this.reconnectBudgetMs} ms.`);
  }

  async #activateSocket(socket) {
    if (this.closed) {
      socket.close(1000, 'TunaCAD Agent Bridge stopped.');
      throw new Error('Relay connection supervisor is closed.');
    }
    this.socket = socket;
    socket.on('message', (data) => {
      if (isRelayControlInput(data)) void this.#handleControl(data);
    });
    socket.once('close', (code, reason) => this.#handleClose(socket, code, reason));
    socket.once('error', (error) => this.emit('socketError', error));

    if (this.runtime) {
      this.runtime.replaceSocket(socket);
      this.emit('connected', { resumed: true });
      return { status: 'ready', resumed: true };
    }
    const cursor = await this.cursorStore.load(this.pairing.sessionId);
    const runtime = this.runtimeFactory({
      pairing: this.pairing,
      socket,
      adapter: this.adapterFactory(this.pairing),
      initialOutgoingSequence: cursor?.nextOutgoingSequence ?? 0,
      initialBrowserSequence: cursor?.lastBrowserSequence ?? -1,
      onCursorChange: (snapshot) => this.#persistCursor(snapshot),
    });
    this.runtime = runtime;
    const result = await runtime.start();
    this.emit('connected', { resumed: false, result });
    return result;
  }

  #handleClose(socket, code, reason) {
    if (socket !== this.socket || this.closed) return;
    this.socket = null;
    this.emit('disconnected', { code, reason: reason?.toString?.() ?? '' });
    if (TERMINAL_CLOSE_CODES.has(code)) {
      this.emit('terminal', { code });
      void this.close().catch((error) => this.emit('failure', error));
      return;
    }
    if (code === 4411 && !this.rotationCommitted) {
      this.emit('failure', new Error('Relay closed for credential rotation before commit was confirmed.'));
      return;
    }
    if (!this.reconnecting) {
      this.reconnecting = this.#reconnect().finally(() => { this.reconnecting = null; });
    }
  }

  async #reconnect() {
    try {
      if (this.rotationTransition) await this.rotationTransition;
      const socket = await this.#connectWithBackoff();
      await this.#activateSocket(socket);
      this.rotationCommitted = false;
      this.rotationTransition = null;
    } catch (error) {
      if (this.closed || error?.name === 'AbortError') return;
      await this.close().catch(() => undefined);
      this.emit('failure', error);
    }
  }

  async #handleControl(input) {
    let message;
    try {
      message = parseRelayControlMessage(toProtocolInput(input), 'server');
    } catch (error) {
      this.emit('failure', error);
      this.socket?.close(4400, 'Invalid relay control message.');
      return;
    }
    if (message.sessionId !== this.pairing.sessionId) {
      this.socket?.close(4403, 'Credential rotation session mismatch.');
      return;
    }
    if (message.type === 'credentials.rotate') {
      this.pendingPairing = Object.freeze({
        ...this.pairing,
        bridgeToken: message.bridgeToken,
        agentToken: message.agentToken,
        expiresAt: message.expiresAt,
      });
      this.pendingRotationId = message.rotationId;
      this.socket?.send(JSON.stringify(createRelayControlMessage('credentials.ack', {
        sessionId: message.sessionId,
        rotationId: message.rotationId,
      })));
      this.emit('rotationPending', { rotationId: message.rotationId });
      return;
    }
    if (!this.pendingPairing || message.rotationId !== this.pendingRotationId) {
      this.socket?.close(4409, 'Unexpected credential rotation commit.');
      return;
    }
    this.pendingRotationId = null;
    this.rotationCommitted = true;
    const nextPairing = this.pendingPairing;
    this.pendingPairing = null;
    this.rotationTransition = (async () => {
      this.pairing = nextPairing;
      await this.runtime?.close();
      this.runtime = null;
      await this.cursorWrite;
    })();
    await this.rotationTransition;
    this.emit('rotationCommitted', { rotationId: message.rotationId });
  }

  #persistCursor(snapshot) {
    this.cursorWrite = this.cursorWrite
      .then(() => this.cursorStore.save(snapshot))
      .catch((error) => this.emit('cursorError', error));
  }
}

function waitForOpen(socket, { timeoutMs, signal }) {
  if (socket.readyState === 1) return Promise.resolve();
  if (socket.readyState !== 0) return Promise.reject(new Error('TunaCAD relay socket is not openable.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      closePendingSocket(socket, `TunaCAD relay socket did not open within ${timeoutMs} ms.`);
      reject(new Error(`TunaCAD relay socket did not open within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onOpen = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    const onClose = (code) => finish(reject, new Error(`TunaCAD relay closed before opening (${code}).`));
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      closePendingSocket(socket, 'TunaCAD Agent Bridge stopped while connecting.');
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.off?.('open', onOpen);
      socket.off?.('error', onError);
      socket.off?.('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => finish(reject, abortError());
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function cancellableDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => finish(reject, abortError());
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function closePendingSocket(socket, reason) {
  if (!socket || socket.readyState === 3) return;
  // ws may emit a late error when a CONNECTING socket is terminated. Keep it contained.
  socket.once?.('error', () => {});
  try {
    if (typeof socket.terminate === 'function') socket.terminate();
    else socket.close?.(1000, reason);
  } catch {
    // The open deadline is authoritative even if the transport already tore itself down.
  }
}

function abortError() {
  const error = new Error('TunaCAD relay connection was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isRelayControlInput(input) {
  try {
    const raw = toProtocolInput(input);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return JSON.parse(text)?.protocol === AGENT_RELAY_CONTROL_PROTOCOL;
  } catch {
    return false;
  }
}

function toProtocolInput(input) {
  if (typeof input === 'string' || input instanceof Uint8Array) return input;
  if (input?.data !== undefined) return toProtocolInput(input.data);
  throw new TypeError('Relay control message must be UTF-8 text.');
}
