import * as z from 'zod/v4';

export const AGENT_RELAY_CONTROL_PROTOCOL = 'tunacad.agent-relay/1';
export const AGENT_RELAY_ROTATION_TTL_MS = 60_000;

const protocol = z.literal(AGENT_RELAY_CONTROL_PROTOCOL);
const sessionId = z.uuid();
const rotationId = z.uuid();
const bearer = z.string().min(32).max(160).regex(/^[A-Za-z0-9_-]+$/);

const rotate = z.object({
  protocol,
  type: z.literal('credentials.rotate'),
  sessionId,
  rotationId,
  bridgeToken: bearer,
  agentToken: bearer,
  expiresAt: z.number().int().positive(),
}).strict();

const committed = z.object({
  protocol,
  type: z.literal('credentials.committed'),
  sessionId,
  rotationId,
}).strict();

const acknowledgement = z.object({
  protocol,
  type: z.literal('credentials.ack'),
  sessionId,
  rotationId,
}).strict();

export const serverRelayControlSchema = z.discriminatedUnion('type', [rotate, committed]);
export const bridgeRelayControlSchema = acknowledgement;

export function parseRelayControlMessage(input, direction) {
  const text = typeof input === 'string'
    ? input
    : input instanceof Uint8Array
      ? new TextDecoder().decode(input)
      : null;
  if (text === null) throw new TypeError('Relay control messages must be UTF-8 text.');
  const value = JSON.parse(text);
  if (direction === 'server') return serverRelayControlSchema.parse(value);
  if (direction === 'bridge') return bridgeRelayControlSchema.parse(value);
  throw new TypeError('Relay control direction must be server or bridge.');
}

export function createRelayControlMessage(type, fields) {
  const value = { protocol: AGENT_RELAY_CONTROL_PROTOCOL, type, ...fields };
  return type === 'credentials.ack'
    ? bridgeRelayControlSchema.parse(value)
    : serverRelayControlSchema.parse(value);
}
