import { createAgentBridgeEnvelope, parseAgentBridgeMessage } from '../../src/aiAgent/bridgeProtocol.mjs';

const MAX_REPLAY_MESSAGES = 2_048;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

export class AgentBridgeRuntime {
  constructor({
    pairing,
    socket,
    adapter,
    initialOutgoingSequence = 0,
    initialBrowserSequence = -1,
    onCursorChange = () => {},
    now = () => new Date(),
    uuid = () => crypto.randomUUID(),
  }) {
    if (!pairing?.sessionId || !socket || !adapter) throw new Error('Pairing, relay socket, and agent adapter are required.');
    this.pairing = pairing;
    this.socket = socket;
    this.adapter = adapter;
    this.now = now;
    this.uuid = uuid;
    if (!Number.isSafeInteger(initialOutgoingSequence) || initialOutgoingSequence < 0) {
      throw new Error('The initial bridge sequence must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(initialBrowserSequence) || initialBrowserSequence < -1) {
      throw new Error('The initial browser sequence must be -1 or a non-negative safe integer.');
    }
    this.outgoingSequence = initialOutgoingSequence;
    this.lastBrowserSequence = initialBrowserSequence;
    this.lastAcknowledgedOutgoingSequence = -1;
    this.outgoingHistory = [];
    this.outgoingHistoryBytes = 0;
    this.onCursorChange = onCursorChange;
    this.lastHeartbeatAt = null;
    this.account = null;
    this.agentVersion = null;
    this.activeThreadId = null;
    this.activeTurnId = null;
    this.started = false;
    this.closed = false;
    this.boundMessage = (data) => {
      if (isRelayControlInput(data)) return;
      void this.handleBrowserMessage(data).catch((error) => this.#sendFailure(error));
    };
    this.boundAdapterEvent = (descriptor) => this.#handleAdapterEvent(descriptor);
    this.boundAdapterError = (error) => this.#sendFailure(error);
    this.boundAdapterExit = () => this.#sendFailure(new Error('Codex App Server exited unexpectedly.'), false);
  }

  async start() {
    if (this.started) throw new Error('Agent Bridge runtime is already started.');
    this.started = true;
    this.socket.on('message', this.boundMessage);
    this.adapter.on('event', this.boundAdapterEvent);
    this.adapter.on('error', this.boundAdapterError);
    this.adapter.on('exit', this.boundAdapterExit);
    try {
      const connected = await this.adapter.connect();
      this.account = connected.account;
      this.agentVersion = connected.version;
      this.#sendDescriptor({ type: 'account.updated', payload: connected.account });
      if (connected.account.requiresOpenaiAuth) {
        let login;
        try {
          login = await this.adapter.startDeviceCodeLogin();
        } catch (error) {
          this.#sendFailure(error, false, 'CODEX_LOGIN_START_FAILED');
          return { status: 'authentication_required', login: null, ...connected };
        }
        this.#sendFailure(
          new Error(`Open ${login.verificationUrl} and enter code ${login.userCode}.`),
          true,
          'CODEX_LOGIN_REQUIRED',
        );
        login.completion.catch((error) => this.#sendFailure(error, true, 'CODEX_LOGIN_FAILED'));
        return { status: 'authentication_required', login, ...connected };
      }
      this.#sendReady();
      return { status: 'ready', ...connected };
    } catch (error) {
      this.#sendFailure(error, false, 'CODEX_START_FAILED');
      throw error;
    }
  }

  async handleBrowserMessage(input) {
    if (this.closed) throw new Error('Agent Bridge runtime is closed.');
    const message = parseAgentBridgeMessage(toProtocolInput(input), 'browser');
    if (message.sessionId !== this.pairing.sessionId) throw new Error('Browser message belongs to another TunaCAD session.');
    if (message.sequence <= this.lastBrowserSequence) throw new Error('Browser message replay rejected by companion.');
    this.lastBrowserSequence = message.sequence;
    this.#cursorChanged();

    switch (message.type) {
      case 'session.resume':
        this.#acknowledgeOutgoing(message.payload.lastAcceptedSequence);
        this.#replayUnacknowledged();
        this.#sendReady();
        return;
      case 'heartbeat.pong':
        this.lastHeartbeatAt = this.now().getTime();
        return;
      case 'thread.start': {
        const result = await this.adapter.startThread(message.payload);
        this.activeThreadId = result?.thread?.id ?? this.activeThreadId;
        return;
      }
      case 'thread.resume':
        await this.adapter.resumeThread(message.payload.threadId);
        this.activeThreadId = message.payload.threadId;
        return;
      case 'chat.user_message': {
        let threadId = message.payload.threadId;
        if (!threadId) {
          const thread = await this.adapter.startThread();
          threadId = thread?.thread?.id;
        }
        if (!threadId) throw new Error('Codex did not provide a thread ID.');
        this.activeThreadId = threadId;
        const turn = await this.adapter.startTurn(threadId, message.payload.content);
        this.activeTurnId = turn?.turn?.id ?? this.activeTurnId;
        return;
      }
      case 'chat.steer':
        await this.adapter.steerTurn(message.payload.threadId, message.payload.turnId, message.payload.content);
        return;
      case 'run.cancel':
        await this.adapter.cancelTurn(message.payload.threadId, message.payload.turnId);
        return;
      case 'approval.decision':
        await this.adapter.respondToApproval(message.payload.approvalId, message.payload.decision);
        return;
      case 'user_input.response':
        await this.adapter.respondToUserInput(message.payload.inputRequestId, message.payload.answers);
        return;
      default:
        throw new Error(`Unsupported browser bridge message ${message.type}.`);
    }
  }

  sendHeartbeat(nonce = `hb_${this.uuid()}`) {
    this.#sendDescriptor({ type: 'heartbeat.ping', payload: { nonce } });
  }

  replaceSocket(socket) {
    if (!socket || socket.readyState !== 1) throw new Error('Replacement relay socket must be open.');
    this.socket.off?.('message', this.boundMessage);
    this.socket = socket;
    this.socket.on('message', this.boundMessage);
  }

  cursorSnapshot() {
    return Object.freeze({
      sessionId: this.pairing.sessionId,
      nextOutgoingSequence: this.outgoingSequence,
      lastBrowserSequence: this.lastBrowserSequence,
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.off?.('message', this.boundMessage);
    this.adapter.off('event', this.boundAdapterEvent);
    this.adapter.off('error', this.boundAdapterError);
    this.adapter.off('exit', this.boundAdapterExit);
    await this.adapter.close();
  }

  #handleAdapterEvent(descriptor) {
    if (descriptor.type === 'account.updated') {
      this.account = descriptor.payload;
      this.#sendDescriptor(descriptor);
      if (!this.account.requiresOpenaiAuth) this.#sendReady();
      return;
    }
    if (descriptor.type === 'thread.started') this.activeThreadId = descriptor.payload.threadId;
    if (descriptor.type === 'turn.started') {
      this.activeThreadId = descriptor.payload.threadId;
      this.activeTurnId = descriptor.payload.turnId;
    }
    if (descriptor.type === 'turn.completed') this.activeTurnId = null;
    this.#sendDescriptor(descriptor);
  }

  #sendReady() {
    if (!this.agentVersion || this.account?.requiresOpenaiAuth) return;
    this.#sendDescriptor({
      type: 'bridge.ready',
      payload: {
        bridge: { name: 'tunacad-agent-bridge', version: '0.1.1', platform: process.platform },
        agent: { name: 'Codex App Server', version: this.agentVersion },
        supportedProtocols: ['tunacad.agent-bridge/1'],
        lastAcceptedSequence: this.lastBrowserSequence < 0 ? 0 : this.lastBrowserSequence,
      },
    });
  }

  #sendFailure(error, retryable = true, code = 'AGENT_BRIDGE_ERROR') {
    if (this.closed || this.socket.readyState !== 1) return;
    const message = redactErrorMessage(error instanceof Error ? error.message : String(error), this.pairing);
    this.#sendDescriptor({
      type: 'run.failed',
      payload: {
        threadId: this.activeThreadId,
        turnId: this.activeTurnId,
        code,
        message: message.slice(0, 2_000),
        retryable,
        correlationId: `bridge:${this.uuid()}`,
      },
    });
  }

  #sendDescriptor(descriptor) {
    const envelope = createAgentBridgeEnvelope({
      ...descriptor,
      sessionId: this.pairing.sessionId,
      sequence: this.outgoingSequence++,
      now: this.now(),
      uuid: this.uuid,
    });
    const serialized = JSON.stringify(envelope);
    this.#rememberOutgoing(envelope.sequence, serialized);
    if (this.socket.readyState === 1) this.socket.send(serialized);
    this.#cursorChanged();
  }

  #rememberOutgoing(sequence, serialized) {
    const bytes = Buffer.byteLength(serialized);
    this.outgoingHistory.push({ sequence, serialized, bytes });
    this.outgoingHistoryBytes += bytes;
    while (
      this.outgoingHistory.length > MAX_REPLAY_MESSAGES
      || this.outgoingHistoryBytes > MAX_REPLAY_BYTES
    ) {
      const removed = this.outgoingHistory.shift();
      this.outgoingHistoryBytes -= removed?.bytes ?? 0;
    }
  }

  #acknowledgeOutgoing(sequence) {
    this.lastAcknowledgedOutgoingSequence = Math.max(this.lastAcknowledgedOutgoingSequence, sequence);
    while (this.outgoingHistory[0]?.sequence <= this.lastAcknowledgedOutgoingSequence) {
      const removed = this.outgoingHistory.shift();
      this.outgoingHistoryBytes -= removed?.bytes ?? 0;
    }
  }

  #replayUnacknowledged() {
    if (this.socket.readyState !== 1) return;
    for (const entry of this.outgoingHistory) {
      if (entry.sequence > this.lastAcknowledgedOutgoingSequence) this.socket.send(entry.serialized);
    }
  }

  #cursorChanged() {
    try {
      this.onCursorChange(this.cursorSnapshot());
    } catch {
      // Cursor persistence is non-authoritative; relay delivery remains live.
    }
  }
}

function toProtocolInput(input) {
  if (typeof input === 'string' || input instanceof Uint8Array) return input;
  if (input?.data !== undefined) return toProtocolInput(input.data);
  throw new TypeError('Relay message must be UTF-8 text.');
}

function isRelayControlInput(input) {
  try {
    const raw = toProtocolInput(input);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return JSON.parse(text)?.protocol === 'tunacad.agent-relay/1';
  } catch {
    return false;
  }
}

function redactErrorMessage(message, pairing) {
  let redacted = String(message).replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  for (const secret of [pairing?.agentToken, pairing?.bridgeToken]) {
    if (typeof secret === 'string' && secret.length >= 8) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}
