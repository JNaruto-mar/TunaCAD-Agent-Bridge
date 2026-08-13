import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAgentAdapter, assertAgentAdapterEvent } from '../agent-bridge/src/agent-adapter-contract.mjs';
import { createAgentAdapter, parseAgentProvider } from '../agent-bridge/src/agent-adapter-registry.mjs';
import {
  GeminiCliAdapter,
  assertSupportedGeminiCliVersion,
  createGeminiLaunchArguments,
} from '../agent-bridge/src/gemini-cli-adapter.mjs';

const pairing = {
  mcpUrl: 'https://tunacad.com/mcp/00000000-0000-4000-8000-000000000036',
  agentToken: 'secret-agent-token-phase36b',
};
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tunacad-gemini-adapter-test-'));
const stateRoot = path.join(temporaryRoot, 'state');
const launches = [];
let launchIndex = 0;

try {
  assert.equal(assertSupportedGeminiCliVersion('0.52.0'), '0.52.0');
  assert.equal(assertSupportedGeminiCliVersion('0.52.99'), '0.52.99');
  assert.throws(() => assertSupportedGeminiCliVersion('0.51.9'), /not certified/);
  assert.throws(() => assertSupportedGeminiCliVersion('0.53.0'), /not certified/);
  assert.deepEqual(createGeminiLaunchArguments(), [
    '--output-format', 'stream-json', '--allowed-mcp-server-names', 'tunacad', '--extensions', 'none',
  ]);
  assert.deepEqual(createGeminiLaunchArguments('30000000-0000-4000-8000-000000000001').slice(-2), [
    '--resume', '30000000-0000-4000-8000-000000000001',
  ]);
  assert.equal(parseAgentProvider(), 'codex');
  assert.equal(parseAgentProvider('gemini'), 'gemini');
  assert.throws(() => parseAgentProvider('unknown'), /Unsupported AI agent/);

  const unauthenticated = new GeminiCliAdapter({
    pairing,
    environment: {},
    stateRoot,
    temporaryRoot,
    versionReader: () => ({ version: '0.52.0' }),
  });
  const unauthenticatedConnection = await unauthenticated.connect();
  assert.equal(unauthenticatedConnection.account.requiresAuthentication, true);
  assert.equal(unauthenticatedConnection.account.authMode, null);
  await unauthenticated.close();

  const adapter = createAgentAdapter({
    provider: 'gemini',
    pairing,
    options: {
      environment: { GEMINI_API_KEY: 'secret-gemini-api-key' },
      stateRoot,
      temporaryRoot,
      versionReader: () => ({ version: '0.52.7' }),
      uuid: sequenceUuid(),
      processFactory(options) {
        launches.push(options);
        launchIndex += 1;
        return new FixtureGeminiProcess({
          sessionId: launchIndex === 1
            ? '30000000-0000-4000-8000-000000000001'
            : '30000000-0000-4000-8000-000000000001',
          complete: launchIndex < 3,
        });
      },
    },
  });
  const contract = assertAgentAdapter(adapter);
  assert.equal(contract.capabilities.threadResume, true);
  assert.equal(contract.capabilities.turnCancellation, true);
  assert.equal(contract.capabilities.turnSteering, false);
  assert.equal(contract.capabilities.approvalResponses, false);
  assert.equal(contract.capabilities.userInputResponses, false);
  assert.equal(contract.capabilities.cadOutcomeReporting, true);

  const events = [];
  const errors = [];
  adapter.on('event', (event) => events.push(assertAgentAdapterEvent(event)));
  adapter.on('error', (error) => errors.push(error));
  const connection = await adapter.connect();
  assert.equal(connection.agent.id, 'gemini-cli');
  assert.equal(connection.agent.version, '0.52.7');
  assert.equal(connection.account.authMode, 'apikey');
  assert.equal(connection.account.requiresAuthentication, false);

  const settingsPath = launches.length === 0
    ? path.join(adapter.configurationDirectory, 'settings.json')
    : launches[0].env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const settingsText = await readFile(settingsPath, 'utf8');
  const policyText = await readFile(path.join(adapter.configurationDirectory, 'tunacad-policy.toml'), 'utf8');
  assert.doesNotMatch(settingsText, /secret-agent-token-phase36b|secret-gemini-api-key/);
  assert.match(settingsText, /Bearer \$TUNACAD_MCP_AGENT_TOKEN/);
  assert.deepEqual(JSON.parse(settingsText).mcp.allowed, ['tunacad']);
  assert.match(policyText, /decision = "deny"[\s\S]*priority = 900/);
  assert.match(policyText, /mcpName = "tunacad"[\s\S]*decision = "allow"[\s\S]*priority = 999/);

  const pending = await adapter.startThread();
  assert.match(pending.threadId, /^gemini-pending:/);
  const firstTurn = await adapter.startTurn(pending.threadId, 'Inspect the TunaCAD project.');
  assert.equal(firstTurn.threadId, '30000000-0000-4000-8000-000000000001');
  await waitFor(() => events.some((event) => event.type === 'turn.completed'));
  assert.deepEqual(events.map((event) => event.type), [
    'thread.started', 'turn.started', 'run.phase_changed', 'chat.assistant_delta',
    'tool.started', 'tool.completed', 'chat.assistant_completed', 'run.phase_changed', 'turn.completed',
  ]);
  assert.equal(events.find((event) => event.type === 'thread.started').payload.resumed, false);
  assert.equal(events.find((event) => event.type === 'tool.started').payload.toolName, 'tunacad.cad_get_project');
  assert.equal(JSON.stringify(events).includes('secret-tool-output'), false);
  assert.equal(launches[0].env.TUNACAD_MCP_AGENT_TOKEN, pairing.agentToken);
  assert.equal(launches[0].env.GEMINI_API_KEY, 'secret-gemini-api-key');
  assert.equal(JSON.stringify(launches[0].args).includes(pairing.agentToken), false);
  assert.equal(JSON.stringify(launches[0].args).includes('secret-gemini-api-key'), false);

  events.length = 0;
  const resumed = await adapter.resumeThread(firstTurn.threadId);
  assert.equal(resumed.resumed, true);
  await adapter.startTurn(resumed.threadId, 'Continue safely.');
  await waitFor(() => events.some((event) => event.type === 'turn.completed'));
  assert.deepEqual(launches[1].args.slice(-2), ['--resume', resumed.threadId]);
  assert.equal(events.find((event) => event.type === 'thread.started').payload.resumed, true);

  events.length = 0;
  const cancellation = await adapter.startTurn(resumed.threadId, 'Wait for cancellation.');
  await adapter.cancelTurn(cancellation.threadId, cancellation.turnId);
  await waitFor(() => events.some((event) => event.type === 'turn.completed'));
  const terminal = events.filter((event) => event.type === 'turn.completed');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].payload.status, 'cancelled');
  assert.equal(errors.length, 0);

  await adapter.close();
  await assert.rejects(() => readFile(settingsPath, 'utf8'));
  console.log('[phase3.6] Gemini CLI 0.52.x streaming, resume, cancellation, MCP isolation, redaction, and registry fixtures passed.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function FixtureGeminiProcess({ sessionId, complete }) {
  const fixture = new EventEmitter();
  fixture.stdout = new PassThrough();
  fixture.stderr = new PassThrough();
  const line = (value) => fixture.stdout.write(`${JSON.stringify(value)}\n`);
  fixture.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) {
      queueMicrotask(() => {
        line({ type: 'init', session_id: sessionId, model: 'gemini-test' });
        if (!complete) return;
        line({ type: 'message', role: 'assistant', content: 'Project inspected.', delta: true });
        line({ type: 'tool_use', tool_name: 'tunacad.cad_get_project', tool_id: 'gemini-tool:1', parameters: { secret: 'never-relay' } });
        line({ type: 'tool_result', tool_id: 'gemini-tool:1', status: 'success', output: 'secret-tool-output' });
        line({ type: 'result', status: 'success', stats: { input_tokens: 10 } });
        fixture.emit('exit', 0, null);
      });
      callback();
    },
  });
  fixture.kill = () => {
    queueMicrotask(() => fixture.emit('exit', null, 'SIGTERM'));
    return true;
  };
  return fixture;
}

function sequenceUuid() {
  let value = 0;
  return () => `40000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Gemini fixture state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
