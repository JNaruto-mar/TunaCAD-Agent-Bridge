import { WebSocket } from 'ws';

export const AGENT_BRIDGE_PROTOCOL = 'tunacad.agent-bridge/1';
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function normalizeRelayOrigin(input) {
  const url = new URL(input);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('The TunaCAD relay origin must use HTTPS, except on loopback.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The TunaCAD relay origin must not include credentials, a path, query, or fragment.');
  }
  return url.origin;
}

export function validateSessionId(value) {
  if (!SESSION_ID_PATTERN.test(value ?? '')) throw new Error('The TunaCAD session ID is invalid.');
  return value;
}

export async function exchangePairingCode({ origin, sessionId, code, fetchImpl = fetch }) {
  const relayOrigin = normalizeRelayOrigin(origin);
  validateSessionId(sessionId);
  const response = await fetchImpl(`${relayOrigin}/api/ai/session/${sessionId}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `TunaCAD pairing failed with HTTP ${response.status}.`);
  return validatePairingResult(payload, sessionId);
}

export function validatePairingResult(payload, expectedSessionId) {
  if (!payload || typeof payload !== 'object') throw new Error('The TunaCAD pairing response is invalid.');
  if (payload.protocol !== AGENT_BRIDGE_PROTOCOL || payload.sessionId !== expectedSessionId) {
    throw new Error('The TunaCAD pairing response does not match this session or protocol.');
  }
  for (const field of ['bridgeToken', 'agentToken', 'mcpUrl', 'bridgeWebSocketUrl']) {
    if (typeof payload[field] !== 'string' || payload[field].length < 1) {
      throw new Error(`The TunaCAD pairing response is missing ${field}.`);
    }
  }
  const bridgeUrl = new URL(payload.bridgeWebSocketUrl);
  const mcpUrl = new URL(payload.mcpUrl);
  const local = bridgeUrl.hostname === 'localhost' || bridgeUrl.hostname === '127.0.0.1';
  if (
    (bridgeUrl.protocol !== 'wss:' && !(local && bridgeUrl.protocol === 'ws:'))
    || (mcpUrl.protocol !== 'https:' && !(local && mcpUrl.protocol === 'http:'))
  ) {
    throw new Error('The TunaCAD pairing response contains an unsafe endpoint.');
  }
  if (bridgeUrl.host !== mcpUrl.host) throw new Error('The TunaCAD bridge and MCP endpoints must share an origin.');
  if (bridgeUrl.username || bridgeUrl.password || mcpUrl.username || mcpUrl.password) {
    throw new Error('TunaCAD endpoints must not contain URL credentials.');
  }
  if (bridgeUrl.pathname !== `/api/ai/session/${expectedSessionId}/bridge` || mcpUrl.pathname !== `/mcp/${expectedSessionId}`) {
    throw new Error('The TunaCAD pairing response contains an unexpected endpoint path.');
  }
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) {
    throw new Error('The TunaCAD pairing credential is already expired.');
  }
  return Object.freeze({
    protocol: payload.protocol,
    sessionId: payload.sessionId,
    bridgeToken: payload.bridgeToken,
    agentToken: payload.agentToken,
    mcpUrl: mcpUrl.toString(),
    bridgeWebSocketUrl: bridgeUrl.toString(),
    expiresAt: payload.expiresAt,
  });
}

export function openRelaySocket(pairing, { WebSocketImpl = WebSocket } = {}) {
  return new WebSocketImpl(pairing.bridgeWebSocketUrl, {
    headers: { Authorization: `Bearer ${pairing.bridgeToken}` },
  });
}

export function createBridgeMessage({ type, sessionId, sequence, payload, uuid = () => crypto.randomUUID() }) {
  return JSON.stringify({
    protocol: AGENT_BRIDGE_PROTOCOL,
    type,
    sessionId,
    messageId: `msg_${uuid()}`,
    sequence,
    sentAt: new Date().toISOString(),
    payload,
  });
}
