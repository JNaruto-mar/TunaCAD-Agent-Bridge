import { AGENT_BRIDGE_PROTOCOL } from './bridgeProtocol.mjs';

export const CODEX_APP_SERVER_MIN_VERSION = '0.146.0';
export const CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION = '0.148.0';
export const CODEX_APP_SERVER_TESTED_VERSIONS = Object.freeze(['0.146.0', '0.147.0']);

export const AGENT_BRIDGE_TIMING_POLICY = Object.freeze({
  requestTimeoutMs: 20_000,
  mcpDiscoveryTimeoutMs: 60_000,
  turnStartTimeoutMs: 60_000,
  turnCompletionTimeoutMs: 180_000,
  interruptAcknowledgementTimeoutMs: 10_000,
  interruptCompletionTimeoutMs: 30_000,
  approvalTimeoutMs: 300_000,
  loginCompletionTimeoutMs: 10 * 60_000,
  heartbeatIntervalMs: 15_000,
  staleConnectionMs: 45_000,
  // Keep reconnects bounded, but allow ordinary Wi-Fi changes to outlive the
  // 45-second stale-heartbeat window before the local Codex process is closed.
  reconnectDelaysMs: Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000, 30_000]),
});

export const TUNACAD_REQUIRED_MCP_TOOLS = Object.freeze([
  'cad_get_capabilities',
  'cad_get_project_state',
  'cad_get_assembly_state',
  'cad_search_tools',
  'cad_validate_plan',
  'cad_stage_plan',
  'cad_get_staged_plan',
  'cad_cancel_staged_plan',
  'cad_execute_plan',
  'cad_inspect_body',
  'cad_query_body_topology',
  'cad_query_component_mate_references',
  'cad_rollback_last_ai_transaction',
]);

export const AI_AGENT_BRIDGE_COMPATIBILITY = Object.freeze({
  protocol: AGENT_BRIDGE_PROTOCOL,
  codexAppServer: Object.freeze({
    minimumVersion: CODEX_APP_SERVER_MIN_VERSION,
    maximumExclusiveVersion: CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION,
    testedVersions: CODEX_APP_SERVER_TESTED_VERSIONS,
    newerVersionBehavior: 'fail_closed_until_schema_recertified',
    transport: 'stdio',
    experimentalWebSocketAllowed: false,
    persistentConfigWritesAllowed: false,
    processConfig: Object.freeze({
      mcpUrlKey: 'mcp_servers.tunacad.url',
      bearerTokenEnvironmentKey: 'mcp_servers.tunacad.bearer_token_env_var',
      requiredKey: 'mcp_servers.tunacad.required',
    }),
    requiredMethods: Object.freeze([
      'initialize',
      'account/read',
      'account/login/start',
      'account/login/cancel',
      'config/read',
      'thread/start',
      'thread/resume',
      'turn/start',
      'turn/steer',
      'turn/interrupt',
    ]),
    requiredClientWireValues: Object.freeze([
      'untrusted',
      'read-only',
      'readOnly',
      'chatgptDeviceCode',
    ]),
    requiredNotifications: Object.freeze([
      'thread/started',
      'turn/started',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'serverRequest/resolved',
      'turn/completed',
      'account/updated',
      'account/login/completed',
    ]),
    requiredServerRequests: Object.freeze([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
    ]),
    requiredTunaCadMcpTools: TUNACAD_REQUIRED_MCP_TOOLS,
    timingPolicy: AGENT_BRIDGE_TIMING_POLICY,
  }),
});
