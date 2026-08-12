import * as z from 'zod/v4';

export const AGENT_BRIDGE_PROTOCOL = 'tunacad.agent-bridge/1';
export const AGENT_BRIDGE_MAX_MESSAGE_BYTES = 256 * 1024;
export const AGENT_BRIDGE_MAX_TEXT_CHARS = 64 * 1024;

export const AGENT_RUN_PHASES = Object.freeze([
  'idle',
  'submitting',
  'inspecting_project',
  'planning',
  'validating_plan',
  'awaiting_cad_approval',
  'executing_plan',
  'recomputing',
  'validating_geometry',
  'rendering',
  'inspecting_result',
  'completed',
  'rejected',
  'cancelled',
  'failed',
]);

export const BROWSER_AGENT_BRIDGE_MESSAGE_TYPES = Object.freeze([
  'session.resume',
  'chat.user_message',
  'chat.steer',
  'run.cancel',
  'approval.decision',
  'user_input.response',
  'thread.start',
  'thread.resume',
  'heartbeat.pong',
]);

export const BRIDGE_AGENT_BRIDGE_MESSAGE_TYPES = Object.freeze([
  'bridge.ready',
  'account.updated',
  'thread.started',
  'turn.started',
  'chat.assistant_delta',
  'chat.assistant_completed',
  'run.phase_changed',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'proposal.staged',
  'proposal.invalidated',
  'approval.requested',
  'approval.resolved',
  'user_input.requested',
  'turn.completed',
  'run.failed',
  'heartbeat.ping',
]);

export const AGENT_BRIDGE_MESSAGE_TYPES = Object.freeze([
  ...BROWSER_AGENT_BRIDGE_MESSAGE_TYPES,
  ...BRIDGE_AGENT_BRIDGE_MESSAGE_TYPES,
]);

const boundedText = (maximum = AGENT_BRIDGE_MAX_TEXT_CHARS) => z.string().min(1).max(maximum);
const optionalBoundedText = (maximum = AGENT_BRIDGE_MAX_TEXT_CHARS) => z.string().max(maximum).optional();
const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const messageId = z.string().min(8).max(96).regex(/^msg_[0-9a-f-]{36}$/i);
const protocol = z.literal(AGENT_BRIDGE_PROTOCOL);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const clientInfo = z.object({
  name: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  version: z.string().min(1).max(40),
  platform: z.string().min(1).max(80).optional(),
}).strict();
const threadRef = { threadId: opaqueId };
const turnRef = { ...threadRef, turnId: opaqueId };
const toolRef = { ...turnRef, toolCallId: opaqueId, toolName: z.string().min(1).max(160) };
const proposalRef = { proposalId: opaqueId };
const requestId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const acceptedSequence = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

const envelope = (type, payload) => z.object({
  protocol,
  type: z.literal(type),
  sessionId: z.uuid(),
  messageId,
  requestId: requestId.optional(),
  sequence,
  sentAt: timestamp,
  payload,
}).strict();

const sessionResume = envelope('session.resume', z.object({
  lastAcceptedSequence: acceptedSequence,
  supportedProtocols: z.array(protocol).length(1),
  client: clientInfo,
}).strict());

const chatUserMessage = envelope('chat.user_message', z.object({
  threadId: opaqueId.nullable().optional(),
  content: boundedText(),
  clientMessageId: opaqueId,
}).strict());

const chatSteer = envelope('chat.steer', z.object({
  ...turnRef,
  content: boundedText(),
}).strict());

const runCancel = envelope('run.cancel', z.object({
  ...turnRef,
  reason: optionalBoundedText(500),
}).strict());

const approvalDecision = envelope('approval.decision', z.object({
  approvalId: opaqueId,
  domain: z.enum(['agent', 'cad']),
  decision: z.enum(['accept', 'accept_for_session', 'decline', 'cancel']),
}).strict());

const userInputResponse = envelope('user_input.response', z.object({
  inputRequestId: opaqueId,
  answers: z.record(
    z.string().min(1).max(80),
    z.union([z.string().max(8_000), z.array(z.string().max(8_000)).max(20)]),
  ),
}).strict());

const threadStart = envelope('thread.start', z.object({
  model: z.string().min(1).max(120).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
}).strict());

const threadResume = envelope('thread.resume', z.object({ ...threadRef }).strict());
const heartbeatPong = envelope('heartbeat.pong', z.object({ nonce: opaqueId }).strict());

const bridgeReady = envelope('bridge.ready', z.object({
  bridge: clientInfo,
  agent: z.object({ name: z.string().min(1).max(80), version: z.string().min(1).max(40) }).strict(),
  supportedProtocols: z.array(protocol).length(1),
  lastAcceptedSequence: acceptedSequence,
}).strict());

const accountUpdated = envelope('account.updated', z.object({
  authMode: z.enum([
    'apikey', 'chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity',
    'personalAccessToken', 'bedrockApiKey',
  ]).nullable(),
  planType: z.string().max(80).nullable(),
  requiresOpenaiAuth: z.boolean(),
}).strict());

const threadStarted = envelope('thread.started', z.object({
  ...threadRef,
  resumed: z.boolean(),
}).strict());

const turnStarted = envelope('turn.started', z.object({ ...turnRef }).strict());

const assistantDelta = envelope('chat.assistant_delta', z.object({
  ...turnRef,
  itemId: opaqueId,
  delta: boundedText(16_000),
}).strict());

const assistantCompleted = envelope('chat.assistant_completed', z.object({
  ...turnRef,
  itemId: opaqueId,
  content: z.string().max(AGENT_BRIDGE_MAX_TEXT_CHARS),
}).strict());

const phaseChanged = envelope('run.phase_changed', z.object({
  ...turnRef,
  phase: z.enum(AGENT_RUN_PHASES),
  label: z.string().min(1).max(160),
  detail: optionalBoundedText(1_000),
}).strict());

const toolStarted = envelope('tool.started', z.object({
  ...toolRef,
  title: optionalBoundedText(240),
}).strict());

const toolProgress = envelope('tool.progress', z.object({
  ...toolRef,
  label: z.string().min(1).max(240),
  completed: z.number().finite().nonnegative().optional(),
  total: z.number().finite().positive().optional(),
}).strict().refine(
  (value) => value.completed === undefined || value.total === undefined || value.completed <= value.total,
  { message: 'completed cannot exceed total', path: ['completed'] },
));

const toolCompleted = envelope('tool.completed', z.object({
  ...toolRef,
  status: z.enum(['completed', 'failed', 'declined', 'cancelled']),
  summary: optionalBoundedText(2_000),
}).strict());

const proposalSummary = z.object({
  goal: boundedText(1_000),
  planVersion: z.enum(['1.0', '2.0']),
  commandCount: z.number().int().positive().max(100),
  affectedPartIds: z.array(opaqueId).max(100),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
}).strict();

const proposalStaged = envelope('proposal.staged', z.object({
  ...proposalRef,
  ...turnRef,
  planHash: z.string().length(64).regex(/^[0-9a-f]+$/i),
  projectRevision: opaqueId,
  expiresAt: z.number().int().positive(),
  summary: proposalSummary,
}).strict());

const proposalInvalidated = envelope('proposal.invalidated', z.object({
  ...proposalRef,
  reason: z.enum(['project_changed', 'expired', 'cancelled', 'session_revoked', 'validation_failed']),
  detail: optionalBoundedText(1_000),
}).strict());

const approvalOption = z.object({
  value: z.enum(['accept', 'accept_for_session', 'decline', 'cancel']),
  label: z.string().min(1).max(80),
}).strict();

const approvalRequested = envelope('approval.requested', z.object({
  approvalId: opaqueId,
  domain: z.enum(['agent', 'cad']),
  kind: z.enum(['command', 'file_change', 'network', 'permissions', 'user_input', 'cad_plan']),
  title: z.string().min(1).max(240),
  description: optionalBoundedText(4_000),
  options: z.array(approvalOption).min(2).max(4),
  proposalId: opaqueId.optional(),
  details: z.object({
    command: optionalBoundedText(4_000),
    cwd: optionalBoundedText(1_000),
    host: optionalBoundedText(500),
    protocol: z.enum(['http', 'https', 'socks5Tcp', 'socks5Udp']).optional(),
    paths: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    networkAccess: z.boolean().optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.domain === 'cad' && value.kind !== 'cad_plan') {
    context.addIssue({ code: 'custom', message: 'CAD approvals must use kind cad_plan.', path: ['kind'] });
  }
  if (value.kind === 'cad_plan' && (!value.proposalId || value.domain !== 'cad')) {
    context.addIssue({ code: 'custom', message: 'CAD plan approvals require a CAD proposal.', path: ['proposalId'] });
  }
}));

const approvalResolved = envelope('approval.resolved', z.object({
  approvalId: opaqueId,
  domain: z.enum(['agent', 'cad']),
  decision: z.enum(['accept', 'accept_for_session', 'decline', 'cancel', 'expired', 'stale']),
}).strict());

const userInputQuestion = z.object({
  id: z.string().min(1).max(80),
  header: z.string().min(1).max(80),
  question: z.string().min(1).max(1_000),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(z.object({
    label: z.string().min(1).max(160),
    description: z.string().max(1_000),
  }).strict()).max(20),
}).strict();

const userInputRequested = envelope('user_input.requested', z.object({
  inputRequestId: opaqueId,
  ...turnRef,
  itemId: opaqueId,
  questions: z.array(userInputQuestion).min(1).max(3),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).nullable(),
}).strict());

const turnCompleted = envelope('turn.completed', z.object({
  ...turnRef,
  status: z.enum(['completed', 'failed', 'interrupted', 'cancelled']),
}).strict());

const runFailed = envelope('run.failed', z.object({
  threadId: opaqueId.nullable(),
  turnId: opaqueId.nullable(),
  code: z.string().min(1).max(120).regex(/^[A-Z0-9_]+$/),
  message: boundedText(2_000),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
  correlationId: opaqueId,
}).strict());

const heartbeatPing = envelope('heartbeat.ping', z.object({ nonce: opaqueId }).strict());

export const browserAgentBridgeEnvelopeSchema = z.discriminatedUnion('type', [
  sessionResume,
  chatUserMessage,
  chatSteer,
  runCancel,
  approvalDecision,
  userInputResponse,
  threadStart,
  threadResume,
  heartbeatPong,
]);

export const bridgeAgentBridgeEnvelopeSchema = z.discriminatedUnion('type', [
  bridgeReady,
  accountUpdated,
  threadStarted,
  turnStarted,
  assistantDelta,
  assistantCompleted,
  phaseChanged,
  toolStarted,
  toolProgress,
  toolCompleted,
  proposalStaged,
  proposalInvalidated,
  approvalRequested,
  approvalResolved,
  userInputRequested,
  turnCompleted,
  runFailed,
  heartbeatPing,
]);

export const agentBridgeEnvelopeSchema = z.discriminatedUnion('type', [
  ...browserAgentBridgeEnvelopeSchema.options,
  ...bridgeAgentBridgeEnvelopeSchema.options,
]);

const encodedLength = (value) => new TextEncoder().encode(value).byteLength;

export function parseAgentBridgeMessage(input, direction = 'either') {
  const text = typeof input === 'string'
    ? input
    : input instanceof Uint8Array
      ? new TextDecoder().decode(input)
      : null;
  if (text === null) throw new TypeError('Agent Bridge messages must be UTF-8 text.');
  if (encodedLength(text) > AGENT_BRIDGE_MAX_MESSAGE_BYTES) {
    throw new RangeError(`Agent Bridge message exceeds ${AGENT_BRIDGE_MAX_MESSAGE_BYTES} bytes.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SyntaxError('Agent Bridge message is not valid JSON.');
  }
  const schema = direction === 'browser'
    ? browserAgentBridgeEnvelopeSchema
    : direction === 'bridge'
      ? bridgeAgentBridgeEnvelopeSchema
      : direction === 'either'
        ? agentBridgeEnvelopeSchema
        : null;
  if (!schema) throw new TypeError('Agent Bridge direction must be browser, bridge, or either.');
  return schema.parse(value);
}

export function createAgentBridgeEnvelope({
  type,
  sessionId,
  sequence: messageSequence,
  payload,
  requestId: correlationRequestId,
  now = new Date(),
  uuid = () => crypto.randomUUID(),
}) {
  const value = {
    protocol: AGENT_BRIDGE_PROTOCOL,
    type,
    sessionId,
    messageId: `msg_${uuid()}`,
    ...(correlationRequestId ? { requestId: correlationRequestId } : {}),
    sequence: messageSequence,
    sentAt: now.toISOString(),
    payload,
  };
  return agentBridgeEnvelopeSchema.parse(value);
}
