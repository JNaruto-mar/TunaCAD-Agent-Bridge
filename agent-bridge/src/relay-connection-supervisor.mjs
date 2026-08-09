import { EventEmitter } from 'node:events';
import { AGENT_BRIDGE_TIMING_POLICY } from '../../src/aiAgent/bridgeCompatibility.mjs';
import {
  AGENT_RELAY_CONTROL_PROTOCOL,
  createRelayControlMessage,
  parseRelayControlMessage,
} from '../../src/aiAgent/relayControl.mjs';
import { AgentBridgeRuntime } from './agent-bridge-runtime.mjs';
import { CodexAppServerAdapter } from './codex-app-server-adapter.mjs';
import { FileCursorStore } from './cursor-store.mjs';
import { openRelaySocket } from './relay-client.mjs';

const TERMINAL_CLOSE_CODES = new Set([1000, 4001, 4002, 4400, 4403, 4409]);

export class RelayConnectionSupervisor extends EventEmitter {
  constructor({
    pairing,
    socketFactory = (credentials) => openRelaySocket(credentials),
    adapterFactory = (credentials) => new CodexAppServerAdapter({ pairing: credentials }),
    runtimeFactory = (options) => new AgentBridgeRuntime(options),
    cursorStore = new FileCursorStore(),
    reconnectDelaysMs = AGENT_BRIDGE_TIMING_POLICY.reconnectDelaysMs,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  }) {
    super();
    this.pairing = pairing;
    this.socketFactory = socketFactory;
    this.adapterFactory = adapterFactory;
    this.runtimeFactory = runtimeFactory;
    this.cursorStore = cursorStore;
    this.reconnectDelaysMs = [...reconnectDelaysMs];
    this.sleep = sleep;
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
    for (let attempt = 0; attempt <= this.reconnectDelaysMs.length; attempt += 1) {
      if (this.closed) throw new Error('Relay connection supervisor is closed.');
      if (attempt > 0) {
        const delayMs = this.reconnectDelaysMs[attempt - 1];
        this.emit('reconnecting', { attempt, delayMs });
        await this.sleep(delayMs);
      }
      try {
        const socket = this.socketFactory(this.pairing);
        await waitForOpen(socket);
        return socket;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('TunaCAD relay reconnect attempts were exhausted.');
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

function waitForOpen(socket) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    const onClose = (code) => finish(reject, new Error(`TunaCAD relay closed before opening (${code}).`));
    const finish = (callback, value) => {
      socket.off?.('open', onOpen);
      socket.off?.('error', onError);
      socket.off?.('close', onClose);
      callback(value);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
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
