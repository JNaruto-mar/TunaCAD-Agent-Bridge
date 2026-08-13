import { createAgentBridgeEnvelope } from '../../src/aiAgent/bridgeProtocol.mjs';

export const AGENT_ADAPTER_CONTRACT_VERSION = 'tunacad.agent-adapter/1';

export const AGENT_ADAPTER_CAPABILITY_NAMES = Object.freeze([
  'interactiveAuthentication',
  'threadResume',
  'turnSteering',
  'turnCancellation',
  'approvalResponses',
  'userInputResponses',
  'cadOutcomeReporting',
]);

const CAPABILITY_METHODS = Object.freeze({
  interactiveAuthentication: 'beginAuthentication',
  threadResume: 'resumeThread',
  turnSteering: 'steerTurn',
  turnCancellation: 'cancelTurn',
  approvalResponses: 'respondToApproval',
  userInputResponses: 'respondToUserInput',
  cadOutcomeReporting: 'reportCadApproval',
});

const CORE_METHODS = Object.freeze(['connect', 'startThread', 'startTurn', 'close']);
const AUTH_MODES = new Set([
  'apikey', 'chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity',
  'personalAccessToken', 'bedrockApiKey',
]);

export function createAgentAdapterCapabilities(values = {}) {
  assertPlainObject(values, 'Agent adapter capabilities');
  for (const key of Object.keys(values)) {
    if (!AGENT_ADAPTER_CAPABILITY_NAMES.includes(key)) {
      throw new Error(`Unknown agent adapter capability ${key}.`);
    }
    if (typeof values[key] !== 'boolean') throw new Error(`Agent adapter capability ${key} must be boolean.`);
  }
  return Object.freeze(Object.fromEntries(
    AGENT_ADAPTER_CAPABILITY_NAMES.map((key) => [key, values[key] ?? false]),
  ));
}

export function assertAgentAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('An agent adapter object is required.');
  for (const method of ['on', 'off', ...CORE_METHODS]) requireMethod(adapter, method);
  if (!adapter.capabilities) throw new Error('Agent adapter must declare capabilities.');
  const capabilities = createAgentAdapterCapabilities(adapter.capabilities);
  for (const [capability, method] of Object.entries(CAPABILITY_METHODS)) {
    if (capabilities[capability]) requireMethod(adapter, method);
  }
  return Object.freeze({ contractVersion: AGENT_ADAPTER_CONTRACT_VERSION, capabilities });
}

export function requireAgentAdapterCapability(adapter, capability) {
  if (!AGENT_ADAPTER_CAPABILITY_NAMES.includes(capability)) {
    throw new Error(`Unknown agent adapter capability ${String(capability)}.`);
  }
  const contract = assertAgentAdapter(adapter);
  if (!contract.capabilities[capability]) {
    throw new Error(`The connected agent does not support ${capability}.`);
  }
  return CAPABILITY_METHODS[capability];
}

export function createAgentConnection({ agent, account }) {
  return Object.freeze({
    contractVersion: AGENT_ADAPTER_CONTRACT_VERSION,
    agent: createAgentIdentity(agent),
    account: createAgentAccountState(account),
  });
}

export function assertAgentConnection(value) {
  assertPlainObject(value, 'Agent adapter connection');
  assertExactKeys(value, ['contractVersion', 'agent', 'account'], 'Agent adapter connection');
  if (value.contractVersion !== AGENT_ADAPTER_CONTRACT_VERSION) {
    throw new Error(`Agent adapter connection must use ${AGENT_ADAPTER_CONTRACT_VERSION}.`);
  }
  return createAgentConnection(value);
}

export function createAgentIdentity({ id, name, version }) {
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(id ?? '')) throw new Error('Agent identity ID is invalid.');
  requiredBoundedString(name, 'Agent identity name', 80);
  requiredBoundedString(version, 'Agent identity version', 40);
  return Object.freeze({ id, name, version });
}

export function createAgentAccountState({ authMode = null, planType = null, requiresAuthentication }) {
  if (authMode !== null && !AUTH_MODES.has(authMode)) throw new Error('Agent account auth mode is invalid.');
  if (planType !== null && (typeof planType !== 'string' || planType.length > 80)) {
    throw new Error('Agent account plan type is invalid.');
  }
  if (typeof requiresAuthentication !== 'boolean') {
    throw new Error('Agent account requiresAuthentication must be boolean.');
  }
  return Object.freeze({ authMode, planType, requiresAuthentication });
}

export function toBridgeAccountState(account) {
  const normalized = createAgentAccountState(account);
  return Object.freeze({
    authMode: normalized.authMode,
    planType: normalized.planType,
    requiresOpenaiAuth: normalized.requiresAuthentication,
  });
}

export function createAgentThread({ threadId, resumed = false }) {
  requiredBoundedString(threadId, 'Agent thread ID', 200);
  if (typeof resumed !== 'boolean') throw new Error('Agent thread resumed must be boolean.');
  return Object.freeze({ threadId, resumed });
}

export function assertAgentThread(value) {
  assertPlainObject(value, 'Agent thread');
  assertExactKeys(value, ['threadId', 'resumed'], 'Agent thread');
  return createAgentThread(value);
}

export function createAgentTurn({ threadId, turnId }) {
  requiredBoundedString(threadId, 'Agent turn thread ID', 200);
  requiredBoundedString(turnId, 'Agent turn ID', 200);
  return Object.freeze({ threadId, turnId });
}

export function assertAgentTurn(value) {
  assertPlainObject(value, 'Agent turn');
  assertExactKeys(value, ['threadId', 'turnId'], 'Agent turn');
  return createAgentTurn(value);
}

export function createAgentAuthenticationChallenge({ authenticationId, verificationUrl, userCode, completion }) {
  requiredBoundedString(authenticationId, 'Agent authentication ID', 200);
  const url = new URL(verificationUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Agent authentication verification URL must be credential-free HTTPS.');
  }
  requiredBoundedString(userCode, 'Agent authentication user code', 80);
  if (!completion || typeof completion.then !== 'function') {
    throw new Error('Agent authentication completion must be promise-like.');
  }
  return Object.freeze({
    authenticationId,
    verificationUrl: url.toString(),
    userCode,
    completion,
  });
}

export function assertAgentAuthenticationChallenge(value) {
  assertPlainObject(value, 'Agent authentication challenge');
  assertExactKeys(
    value,
    ['authenticationId', 'verificationUrl', 'userCode', 'completion'],
    'Agent authentication challenge',
  );
  return createAgentAuthenticationChallenge(value);
}

export function assertAgentAdapterEvent(descriptor) {
  assertPlainObject(descriptor, 'Agent adapter event');
  assertExactKeys(descriptor, ['type', 'payload'], 'Agent adapter event');
  if (descriptor.type === 'account.updated') {
    assertPlainObject(descriptor.payload, 'Agent account event payload');
    assertExactKeys(
      descriptor.payload,
      ['authMode', 'planType', 'requiresAuthentication'],
      'Agent account event payload',
    );
    return Object.freeze({ type: descriptor.type, payload: createAgentAccountState(descriptor.payload) });
  }
  const envelope = createAgentBridgeEnvelope({
    type: descriptor.type,
    sessionId: '00000000-0000-4000-8000-000000000001',
    sequence: 0,
    payload: descriptor.payload,
    now: new Date('2026-01-01T00:00:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000002',
  });
  return Object.freeze({ type: envelope.type, payload: envelope.payload });
}

function requireMethod(adapter, method) {
  if (typeof adapter[method] !== 'function') throw new Error(`Agent adapter must implement ${method}().`);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`${label} keys are invalid.`);
  }
}

function requiredBoundedString(value, label, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters.`);
  }
  return value;
}
