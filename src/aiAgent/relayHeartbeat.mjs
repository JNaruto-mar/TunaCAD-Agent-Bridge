import { AGENT_BRIDGE_TIMING_POLICY } from './bridgeCompatibility.mjs';

export function isRelaySocketStale(
  lastSeenAt,
  now = Date.now(),
  staleMs = AGENT_BRIDGE_TIMING_POLICY.staleConnectionMs,
) {
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs <= 0) {
    throw new TypeError('Relay heartbeat timestamps and timeout must be finite.');
  }
  return now - lastSeenAt >= staleMs;
}

export function nextRelayHeartbeatAlarm(
  sessionExpiresAt,
  now = Date.now(),
  intervalMs = AGENT_BRIDGE_TIMING_POLICY.heartbeatIntervalMs,
) {
  if (!Number.isFinite(sessionExpiresAt) || !Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('Relay alarm timestamps and interval must be finite.');
  }
  return Math.min(sessionExpiresAt, now + intervalMs);
}
