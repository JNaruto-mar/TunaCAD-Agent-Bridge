import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAgentAdapter, assertAgentAdapterEvent } from '../agent-bridge/src/agent-adapter-contract.mjs';
import { createAgentAdapter, parseAgentProvider } from '../agent-bridge/src/agent-adapter-registry.mjs';
import { assertSupportedClaudeCliVersion, createClaudeLaunchArguments } from '../agent-bridge/src/claude-cli-adapter.mjs';

const pairing = { mcpUrl: 'https://tunacad.com/mcp/test', agentToken: 'secret-claude-test-token' };
const root = await mkdtemp(path.join(os.tmpdir(), 'tunacad-claude-test-'));
const sessionId = '30000000-0000-4000-8000-000000000001';
const compatibleHelp = '--print --output-format --include-partial-messages --mcp-config --strict-mcp-config --resume --permission-mode --tools --allowedTools';
const launches = [];
let count = 0;
class FixtureProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(wait) {
    super();
    this.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); },
      final: (callback) => {
        queueMicrotask(() => {
          this.line({ type: 'system', subtype: 'init', session_id: sessionId });
          if (!wait) {
            this.line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } });
            this.line({ type: 'assistant', message: { content: [ { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'toolu_123', name: 'mcp__tunacad__cad_get_project' } ] } });
            this.line({ type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 'toolu_123', content: 'hidden' } ] } });
            this.line({ type: 'result', subtype: 'success', is_error: false });
            this.emit('exit', 0, null);
          }
        });
        callback();
      } });
  }
  line(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill() { queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); return true; }
}
try {
  assert.equal(parseAgentProvider('claude'), 'claude');
  assert.equal(assertSupportedClaudeCliVersion({ version: '2.1.268', help: compatibleHelp }), '2.1.268');
  assert.equal(assertSupportedClaudeCliVersion({ version: '3.0.0', help: compatibleHelp }), '3.0.0');
  assert.throws(() => assertSupportedClaudeCliVersion({ version: '1.0.0', help: '--print' }), /lacks required chat options/);
  assert.deepEqual(createClaudeLaunchArguments('mcp.json', sessionId).slice(-2), ['--resume', sessionId]);
  const adapter = createAgentAdapter({ provider: 'claude', pairing, options: {
    temporaryRoot: root,
    versionReader: () => ({ version: '2.1.268', help: compatibleHelp }),
    authReader: () => true,
    processFactory(options) { launches.push(options); count += 1; return new FixtureProcess(count === 3); },
  } });
  const capabilities = assertAgentAdapter(adapter).capabilities;
  assert.equal(capabilities.threadResume, true);
  assert.equal(capabilities.turnCancellation, true);
  assert.equal(capabilities.approvalResponses, false);
  const events = [];
  adapter.on('event', (event) => events.push(assertAgentAdapterEvent(event)));
  adapter.on('error', (error) => { throw error; });
  const connection = await adapter.connect();
  assert.equal(connection.agent.id, 'claude-cli');
  assert.equal(connection.account.requiresAuthentication, false);
  const configPath = path.join(adapter.configurationDirectory, 'mcp.json');
  const config = await readFile(configPath, 'utf8');
  assert.match(config, /Bearer \$\{TUNACAD_MCP_AGENT_TOKEN\}/);
  assert.doesNotMatch(config, /secret-claude-test-token/);
  const thread = await adapter.startThread();
  const first = await adapter.startTurn(thread.threadId, 'Inspect the project');
  assert.equal(first.threadId, sessionId);
  await waitFor(() => events.some((event) => event.type === 'turn.completed'));
  assert.deepEqual(events.map((event) => event.type), [
    'thread.started', 'turn.started', 'run.phase_changed', 'chat.assistant_delta',
    'tool.started', 'tool.completed', 'chat.assistant_completed', 'run.phase_changed', 'turn.completed',
  ]);
  assert.equal(events.find((event) => event.type === 'chat.assistant_completed').payload.content, 'Hello');
  assert.equal(launches[0].env.TUNACAD_MCP_AGENT_TOKEN, pairing.agentToken);
  assert.equal(JSON.stringify(launches[0].args).includes(pairing.agentToken), false);
  events.length = 0;
  await adapter.resumeThread(sessionId);
  await adapter.startTurn(sessionId, 'Continue');
  await waitFor(() => events.some((event) => event.type === 'turn.completed'));
  assert.deepEqual(launches[1].args.slice(-2), ['--resume', sessionId]);
  events.length = 0;
  const cancelled = await adapter.startTurn(sessionId, 'Wait');
  await adapter.cancelTurn(cancelled.threadId, cancelled.turnId);
  await waitFor(() => events.some((event) => event.type === 'turn.completed'));
  assert.equal(events.find((event) => event.type === 'turn.completed').payload.status, 'cancelled');
  await adapter.close();
  await assert.rejects(() => readFile(configPath, 'utf8'));
  const loggedOut = createAgentAdapter({ provider: 'claude', pairing, options: { temporaryRoot: root,
    versionReader: () => ({ version: '2.1.269', help: compatibleHelp }), authReader: () => false } });
  assert.equal((await loggedOut.connect()).account.requiresAuthentication, true);
  await loggedOut.close();
  console.log('Claude adapter version, MCP isolation, streaming, tools, resume, cancellation and auth fixtures passed.');
} finally { await rm(root, { recursive: true, force: true }); }

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Claude fixture');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
