import {
  CODEX_APPROVAL_REQUEST_METHODS,
  CODEX_USER_INPUT_REQUEST_METHOD,
  mapCodexServerRequest,
} from './codexEventMapper.mjs';

const supportedRequestMethods = new Set([
  ...CODEX_APPROVAL_REQUEST_METHODS,
  CODEX_USER_INPUT_REQUEST_METHOD,
]);
const approvalDecisions = new Set(['accept', 'accept_for_session', 'decline', 'cancel']);

const finiteTime = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number.`);
  return value;
};

const roundedDuration = (end, start) => Math.round(Math.max(0, end - start) * 100) / 100;

export class CodexRequestTracker {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.pending = new Map();
  }

  register(request, receivedAtMs = this.now()) {
    if (!request || !Object.hasOwn(request, 'id') || !supportedRequestMethods.has(request.method)) {
      throw new Error('Unsupported Codex server request.');
    }
    const key = String(request.id);
    if (this.pending.has(key)) throw new Error(`Duplicate Codex server request ${key}.`);
    const descriptor = mapCodexServerRequest(request);
    if (!descriptor) throw new Error('Codex server request could not be mapped.');
    const entry = {
      key,
      method: request.method,
      threadId: request.params?.threadId ?? null,
      turnId: request.params?.turnId ?? null,
      descriptor,
      receivedAtMs: finiteTime(receivedAtMs, 'receivedAtMs'),
      respondedAtMs: null,
      decision: null,
    };
    this.pending.set(key, entry);
    return descriptor;
  }

  markResponded(requestId, decision, respondedAtMs = this.now()) {
    const entry = this.#required(requestId);
    if (entry.respondedAtMs !== null) throw new Error(`Codex server request ${entry.key} was already answered.`);
    if (CODEX_APPROVAL_REQUEST_METHODS.includes(entry.method) && !approvalDecisions.has(decision)) {
      throw new Error(`Unsupported approval decision ${String(decision)}.`);
    }
    entry.respondedAtMs = finiteTime(respondedAtMs, 'respondedAtMs');
    if (entry.respondedAtMs < entry.receivedAtMs) throw new Error('Response time precedes request time.');
    entry.decision = decision ?? null;
    return {
      requestId: entry.key,
      waitForUserMs: roundedDuration(entry.respondedAtMs, entry.receivedAtMs),
    };
  }

  resolve(notification, resolvedAtMs = this.now()) {
    if (notification?.method !== 'serverRequest/resolved') {
      throw new Error('Expected a Codex serverRequest/resolved notification.');
    }
    const key = String(notification.params?.requestId ?? '');
    const entry = this.#required(key);
    const completedAt = finiteTime(resolvedAtMs, 'resolvedAtMs');
    if (completedAt < entry.receivedAtMs) throw new Error('Resolution time precedes request time.');
    if (notification.params?.threadId && entry.threadId && notification.params.threadId !== entry.threadId) {
      throw new Error('Codex server-request resolution thread does not match the pending request.');
    }
    this.pending.delete(key);
    const autoCleared = entry.respondedAtMs === null;
    const decision = autoCleared ? 'expired' : entry.decision;
    const descriptor = CODEX_APPROVAL_REQUEST_METHODS.includes(entry.method)
      ? {
        type: 'approval.resolved',
        requestId: key,
        payload: {
          approvalId: entry.descriptor.payload.approvalId,
          domain: 'agent',
          decision,
        },
      }
      : null;
    return {
      descriptor,
      timing: {
        requestId: key,
        method: entry.method,
        autoCleared,
        waitForUserMs: entry.respondedAtMs === null
          ? null
          : roundedDuration(entry.respondedAtMs, entry.receivedAtMs),
        responseToResolutionMs: entry.respondedAtMs === null
          ? null
          : roundedDuration(completedAt, entry.respondedAtMs),
        totalMs: roundedDuration(completedAt, entry.receivedAtMs),
      },
    };
  }

  pendingCount() {
    return this.pending.size;
  }

  #required(requestId) {
    const key = String(requestId);
    const entry = this.pending.get(key);
    if (!entry) throw new Error(`Unknown Codex server request ${key}.`);
    return entry;
  }
}
