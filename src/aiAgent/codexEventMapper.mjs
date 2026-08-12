export const CODEX_APPROVAL_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

export const CODEX_USER_INPUT_REQUEST_METHOD = 'item/tool/requestUserInput';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const text = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum) : undefined;
const requiredId = (value, label) => {
  const result = String(value ?? '');
  if (!result || result.length > 160 || !idPattern.test(result)) {
    throw new Error(`Codex ${label} is missing or unsafe.`);
  }
  return result;
};
const requestCorrelation = (value, prefix) => requiredId(`${prefix}:${String(value ?? '')}`, 'request ID');

const event = (type, payload, requestId) => ({
  type,
  payload,
  ...(requestId === undefined ? {} : { requestId: String(requestId) }),
});

const threadAndTurn = (params) => ({
  threadId: requiredId(params?.threadId, 'thread ID'),
  turnId: requiredId(params?.turnId ?? params?.turn?.id, 'turn ID'),
});

const toolName = (item) => {
  if (item?.type === 'mcpToolCall') {
    const server = text(item.server, 80) ?? 'mcp';
    const tool = text(item.tool, 160) ?? 'unknown';
    return `${server}.${tool}`;
  }
  if (item?.type === 'dynamicToolCall') return text(item.tool, 160) ?? 'dynamic_tool';
  if (item?.type === 'commandExecution') return 'command_execution';
  if (item?.type === 'fileChange') return 'file_change';
  if (item?.type === 'webSearch') return 'web_search';
  return null;
};

const phaseForTool = (name) => {
  const normalized = name.toLowerCase();
  if (normalized.includes('cad_validate_plan')) return ['validating_plan', 'Validating CAD plan'];
  if (normalized.includes('cad_execute_plan')) return ['executing_plan', 'Executing CAD plan'];
  if (normalized.includes('cad_inspect')) return ['inspecting_result', 'Inspecting result'];
  if (normalized.includes('cad_get_') || normalized.includes('cad_search')) return ['inspecting_project', 'Inspecting project'];
  return null;
};

const normalizeToolStatus = (status) => {
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'declined';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'completed';
};

const normalizeTurnStatus = (status) => {
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'completed';
};

const completedPhaseForTurn = (status) => {
  if (status === 'failed') return ['failed', 'Agent run failed'];
  if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') return ['cancelled', 'Agent run cancelled'];
  return ['completed', 'Agent run completed'];
};

export function mapCodexNotification(message, context = {}) {
  if (!message || typeof message.method !== 'string' || Object.hasOwn(message, 'id')) return [];
  const params = message.params ?? {};
  if (message.method === 'account/updated') {
    const authMode = params.authMode ?? null;
    return [event('account.updated', {
      authMode,
      planType: params.planType ?? null,
      requiresOpenaiAuth: context.requiresOpenaiAuth ?? authMode === null,
    })];
  }
  if (message.method === 'thread/started') {
    return [event('thread.started', {
      threadId: requiredId(params.thread?.id, 'thread ID'),
      resumed: Boolean(context.resumed),
    })];
  }
  if (message.method === 'turn/started') {
    const refs = threadAndTurn(params);
    return [
      event('turn.started', refs),
      event('run.phase_changed', { ...refs, phase: 'submitting', label: 'Agent started' }),
    ];
  }
  if (message.method === 'item/agentMessage/delta') {
    return [event('chat.assistant_delta', {
      ...threadAndTurn(params),
      itemId: requiredId(params.itemId, 'item ID'),
      delta: text(params.delta, 16_000) ?? '',
    })];
  }
  if (message.method === 'mcpToolCall/progress') {
    return [event('tool.progress', {
      ...threadAndTurn(params),
      toolCallId: requiredId(params.itemId, 'item ID'),
      toolName: text(context.toolNames?.get?.(params.itemId), 160) ?? 'mcp.tool',
      label: text(params.message, 240) ?? 'Tool is running',
    })];
  }
  if (message.method === 'item/started') {
    const item = params.item;
    const name = toolName(item);
    if (name) {
      const refs = threadAndTurn(params);
      const tool = event('tool.started', {
        ...refs,
        toolCallId: requiredId(item.id, 'item ID'),
        toolName: name,
        ...(text(item.command ?? item.query, 240) ? { title: text(item.command ?? item.query, 240) } : {}),
      });
      const phase = phaseForTool(name);
      return phase
        ? [tool, event('run.phase_changed', { ...refs, phase: phase[0], label: phase[1] })]
        : [tool];
    }
    if (item?.type === 'reasoning' || item?.type === 'plan') {
      const refs = threadAndTurn(params);
      return [event('run.phase_changed', { ...refs, phase: 'planning', label: 'Planning CAD changes' })];
    }
    return [];
  }
  if (message.method === 'item/completed') {
    const item = params.item;
    if (item?.type === 'agentMessage') {
      return [event('chat.assistant_completed', {
        ...threadAndTurn(params),
        itemId: requiredId(item.id, 'item ID'),
        content: text(item.text, 64 * 1024) ?? '',
      })];
    }
    const name = toolName(item);
    if (!name) return [];
    return [event('tool.completed', {
      ...threadAndTurn(params),
      toolCallId: requiredId(item.id, 'item ID'),
      toolName: name,
      status: normalizeToolStatus(item.status),
      ...(text(item.error?.message ?? item.result, 2_000)
        ? { summary: text(item.error?.message ?? item.result, 2_000) }
        : {}),
    })];
  }
  if (message.method === 'turn/completed') {
    const refs = threadAndTurn(params);
    const status = normalizeTurnStatus(params.turn?.status);
    const phase = completedPhaseForTurn(params.turn?.status);
    return [
      event('turn.completed', { ...refs, status }),
      event('run.phase_changed', { ...refs, phase: phase[0], label: phase[1] }),
    ];
  }
  if (message.method === 'error') {
    const retryAfterMs = normalizeRetryAfterMs(
      params.error?.retryAfterMs
      ?? params.error?.retry_after_ms
      ?? params.retryAfterMs
      ?? params.retry_after_ms,
    );
    return [event('run.failed', {
      threadId: params.threadId ? requiredId(params.threadId, 'thread ID') : null,
      turnId: params.turnId ? requiredId(params.turnId, 'turn ID') : null,
      code: text(params.error?.code ?? 'CODEX_ERROR', 120)?.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'CODEX_ERROR',
      message: text(params.error?.message ?? params.message, 2_000) ?? 'Codex App Server reported an error.',
      retryable: Boolean(params.retryable),
      ...(retryAfterMs ? { retryAfterMs } : {}),
      correlationId: requiredId(context.correlationId ?? 'codex:error', 'correlation ID'),
    })];
  }
  return [];
}

function normalizeRetryAfterMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  return Math.min(15 * 60_000, Math.max(1_000, Math.round(milliseconds)));
}

const defaultOptions = [
  { value: 'accept', label: 'Allow' },
  { value: 'decline', label: 'Decline' },
  { value: 'cancel', label: 'Cancel run' },
];

const approvalOptions = (available) => {
  const source = Array.isArray(available) ? available : ['accept', 'decline', 'cancel'];
  const mapped = [];
  for (const decision of source) {
    if (decision === 'accept') mapped.push({ value: 'accept', label: 'Allow' });
    if (decision === 'acceptForSession') mapped.push({ value: 'accept_for_session', label: 'Allow for session' });
    if (decision === 'decline') mapped.push({ value: 'decline', label: 'Decline' });
    if (decision === 'cancel') mapped.push({ value: 'cancel', label: 'Cancel run' });
  }
  return mapped.length >= 2 ? mapped.slice(0, 4) : defaultOptions;
};

const pathLabel = (entry) => {
  const target = entry?.path;
  if (typeof target === 'string') return target;
  if (target?.type === 'path') return target.path;
  if (target?.type === 'glob_pattern') return target.pattern;
  if (target?.type === 'special') return `:${target.value?.kind ?? 'special'}`;
  return null;
};

const permissionDetails = (permissions) => {
  const fileSystem = permissions?.fileSystem;
  const paths = [
    ...(Array.isArray(fileSystem?.read) ? fileSystem.read : []),
    ...(Array.isArray(fileSystem?.write) ? fileSystem.write : []),
    ...(Array.isArray(fileSystem?.entries) ? fileSystem.entries.map(pathLabel).filter(Boolean) : []),
  ].map(String).slice(0, 100);
  return {
    ...(paths.length ? { paths } : {}),
    ...(typeof permissions?.network?.enabled === 'boolean' ? { networkAccess: permissions.network.enabled } : {}),
  };
};

export function mapCodexServerRequest(message) {
  if (!message || !Object.hasOwn(message, 'id') || typeof message.method !== 'string') return null;
  if (message.method !== CODEX_USER_INPUT_REQUEST_METHOD && !CODEX_APPROVAL_REQUEST_METHODS.includes(message.method)) {
    return null;
  }
  const params = message.params ?? {};
  const refs = threadAndTurn(params);
  if (message.method === CODEX_USER_INPUT_REQUEST_METHOD) {
    return event('user_input.requested', {
      inputRequestId: requestCorrelation(message.id, 'input'),
      ...refs,
      itemId: requiredId(params.itemId, 'item ID'),
      questions: (params.questions ?? []).map((question) => ({
        id: requiredId(question.id, 'question ID'),
        header: text(question.header, 80) ?? 'Question',
        question: text(question.question, 1_000) ?? 'Input required',
        isOther: Boolean(question.isOther),
        isSecret: Boolean(question.isSecret),
        options: (question.options ?? []).slice(0, 20).map((option) => ({
          label: text(option.label, 160) ?? 'Option',
          description: text(option.description, 1_000) ?? '',
        })),
      })),
      autoResolutionMs: params.autoResolutionMs ?? null,
    }, message.id);
  }
  const approvalId = requestCorrelation(message.id, 'approval');
  if (message.method === 'item/commandExecution/requestApproval') {
    const network = params.networkApprovalContext;
    return event('approval.requested', {
      approvalId,
      domain: 'agent',
      kind: network ? 'network' : 'command',
      title: network ? `Allow network access to ${text(network.host, 500) ?? 'this host'}?` : 'Allow this command?',
      ...(text(params.reason, 4_000) ? { description: text(params.reason, 4_000) } : {}),
      options: approvalOptions(params.availableDecisions),
      details: {
        ...(text(params.command, 4_000) ? { command: text(params.command, 4_000) } : {}),
        ...(text(params.cwd, 1_000) ? { cwd: text(params.cwd, 1_000) } : {}),
        ...(network ? { host: text(network.host, 500), protocol: network.protocol } : {}),
      },
    }, message.id);
  }
  if (message.method === 'item/fileChange/requestApproval') {
    return event('approval.requested', {
      approvalId,
      domain: 'agent',
      kind: 'file_change',
      title: 'Allow this file change?',
      ...(text(params.reason, 4_000) ? { description: text(params.reason, 4_000) } : {}),
      options: defaultOptions,
      ...(params.grantRoot ? { details: { paths: [String(params.grantRoot)] } } : {}),
    }, message.id);
  }
  return event('approval.requested', {
    approvalId,
    domain: 'agent',
    kind: 'permissions',
    title: 'Allow additional agent permissions?',
    ...(text(params.reason, 4_000) ? { description: text(params.reason, 4_000) } : {}),
    options: defaultOptions,
    details: permissionDetails(params.permissions),
  }, message.id);
}

const codexDecision = (decision) => decision === 'accept_for_session' ? 'acceptForSession' : decision;

export function createCodexApprovalResponse(request, decision) {
  if (!request || !CODEX_APPROVAL_REQUEST_METHODS.includes(request.method)) {
    throw new Error('Unsupported Codex approval request.');
  }
  if (!['accept', 'accept_for_session', 'decline', 'cancel'].includes(decision)) {
    throw new Error('Unsupported approval decision.');
  }
  if (request.method === 'item/permissions/requestApproval') {
    const accepted = decision === 'accept' || decision === 'accept_for_session';
    return {
      response: {
        permissions: accepted ? (request.params?.permissions ?? {}) : {},
        scope: decision === 'accept_for_session' ? 'session' : 'turn',
      },
      interruptTurn: decision === 'cancel',
    };
  }
  return { response: { decision: codexDecision(decision) }, interruptTurn: false };
}

export function createCodexUserInputResponse(request, answers) {
  if (request?.method !== CODEX_USER_INPUT_REQUEST_METHOD) throw new Error('Unsupported Codex user-input request.');
  const requestedIds = new Set((request.params?.questions ?? []).map((question) => question.id));
  const responseAnswers = {};
  for (const [questionId, answer] of Object.entries(answers ?? {})) {
    if (!requestedIds.has(questionId)) throw new Error(`Unexpected answer for Codex question ${questionId}.`);
    responseAnswers[questionId] = { answers: Array.isArray(answer) ? answer.map(String) : [String(answer)] };
  }
  for (const questionId of requestedIds) {
    if (!Object.hasOwn(responseAnswers, questionId)) throw new Error(`Missing answer for Codex question ${questionId}.`);
  }
  return { answers: responseAnswers };
}
