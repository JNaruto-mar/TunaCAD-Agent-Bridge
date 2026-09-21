import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentBridgeRuntime } from '../agent-bridge/src/agent-bridge-runtime.mjs';
import { createAgentAdapter } from '../agent-bridge/src/agent-adapter-registry.mjs';
import { createAgentBridgeEnvelope } from '../src/aiAgent/bridgeProtocol.mjs';

const sessionId = 'af851c18-29a7-4ae3-98d8-a83d28ee936b';
const claudeSessionId = '30000000-0000-4000-8000-000000000001';
const pairing = { sessionId, mcpUrl: 'https://tunacad.invalid/mcp/test', agentToken: 'bridge-fixture-secret' };
const help = '--print --output-format --include-partial-messages --mcp-config --strict-mcp-config --resume --permission-mode --tools --allowedTools';
const root = await mkdtemp(path.join(os.tmpdir(), 'tunacad-claude-bridge-test-'));
let launchCount = 0;
const launches = [];
class FakeRelaySocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(String(value))); }
  byType(type) { return this.sent.filter((message) => message.type === type); }
}
class FixtureProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(mode) {
    super();
    this.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final: (callback) => {
      queueMicrotask(() => {
        this.line({ type: 'system', subtype: 'init', session_id: claudeSessionId });
        if (mode !== 'wait') setTimeout(() => {
          if (mode === 'chat') {
            this.line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello TunaCAD' } } });
            this.line({ type: 'assistant', message: { content: [ { type: 'text', text: 'Hello TunaCAD' }, { type: 'tool_use', id: 'toolu_123', name: 'mcp__tunacad__cad_get_project' } ] } });
            this.line({ type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 'toolu_123', content: 'private tool data' } ] } });
          }
          this.line({ type: 'result', subtype: 'success', is_error: false });
          this.emit('exit', 0, null);
        }, 1);
      });
      callback();
    } });
  }
  line(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill() { queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); return true; }
}
const socket = new FakeRelaySocket();
const adapter = createAgentAdapter({ provider: 'claude', pairing, options: {
  temporaryRoot: root, versionReader: () => ({ version: '2.1.268', help }), authReader: () => true,
  processFactory(options) {
    launches.push(options);
    launchCount += 1;
    return new FixtureProcess(launchCount === 1 ? 'chat' : launchCount === 2 ? 'approval' : 'wait');
  },
} });
const reports = [];
const originalReport = adapter.reportCadApproval.bind(adapter);
adapter.reportCadApproval = async (value) => {
  const result = await originalReport(value);
  reports.push({ value, result });
  return result;
};
let uuidCounter = 0;
const runtime = new AgentBridgeRuntime({ pairing, socket, adapter,
  now: () => new Date('2026-09-21T00:00:00.000Z'),
  uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}` });
let browserSequence = 0;
const browserMessage = (type, payload) => JSON.stringify(createAgentBridgeEnvelope({
  type, payload, sessionId, sequence: browserSequence++, now: new Date('2026-09-21T00:00:00.000Z'),
  uuid: () => `10000000-0000-4000-8000-${String(browserSequence).padStart(12, '0')}`,
}));
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Claude bridge fixture');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
try {
  assert.equal((await runtime.start()).status, 'ready');
  assert.deepEqual(socket.sent.slice(0, 2).map((message) => message.type), ['account.updated', 'bridge.ready']);
  assert.equal(socket.byType('bridge.ready')[0].payload.agent.name, 'Claude Code CLI');
  await runtime.handleBrowserMessage(browserMessage('session.resume', {
    lastAcceptedSequence: socket.sent.at(-1).sequence,
    supportedProtocols: ['tunacad.agent-bridge/1'],
    client: { name: 'tunacad-browser', version: '0.1.0', platform: 'test' },
  }));
  await runtime.handleBrowserMessage(browserMessage('chat.user_message', {
    threadId: null, content: 'Inspect the project', clientMessageId: 'client:claude-first',
  }));
  await waitFor(() => socket.byType('turn.completed').length === 1);
  assert.equal(socket.byType('thread.started')[0].payload.threadId, claudeSessionId);
  assert.equal(socket.byType('chat.assistant_delta')[0].payload.delta, 'Hello TunaCAD');
  assert.equal(socket.byType('chat.assistant_completed')[0].payload.content, 'Hello TunaCAD');
  assert.equal(socket.byType('tool.started')[0].payload.toolName, 'mcp__tunacad__cad_get_project');
  assert.equal(socket.byType('tool.completed')[0].payload.status, 'completed');
  assert.equal(socket.byType('turn.completed')[0].payload.status, 'completed');
  assert.equal(socket.sent.some((message) => JSON.stringify(message).includes(pairing.agentToken)), false);
  assert.equal(socket.sent.some((message) => JSON.stringify(message).includes('private tool data')), false);
  const proposalId = 'cadprop_20000000-0000-4000-8000-000000000033';
  const approvalId = `cadapproval:${proposalId}`;
  await runtime.handleBrowserMessage(browserMessage('approval.decision', { approvalId, domain: 'cad', decision: 'accept' }));
  await waitFor(() => reports.length === 1 && socket.byType('turn.completed').length === 2);
  assert.deepEqual(socket.byType('approval.resolved')[0].payload, { approvalId, domain: 'cad', decision: 'accept' });
  assert.equal(reports[0].result.mode, 'follow_up_turn');
  assert.equal(reports[0].value.proposalId, proposalId);
  assert.deepEqual(launches[1].args.slice(-2), ['--resume', claudeSessionId]);
  await runtime.handleBrowserMessage(browserMessage('approval.decision', { approvalId, domain: 'cad', decision: 'accept' }));
  assert.equal(reports.length, 1);
  await assert.rejects(runtime.handleBrowserMessage(browserMessage('approval.decision', { approvalId, domain: 'cad', decision: 'decline' })), /cannot be changed/);
  await assert.rejects(runtime.handleBrowserMessage(browserMessage('approval.decision', { approvalId: 'agentapproval:test', domain: 'agent', decision: 'accept' })), /does not support approvalResponses/);
  await runtime.handleBrowserMessage(browserMessage('chat.user_message', {
    threadId: claudeSessionId, content: 'Wait for cancellation', clientMessageId: 'client:claude-cancel',
  }));
  await waitFor(() => socket.byType('turn.started').length === 3);
  const turnId = socket.byType('turn.started').at(-1).payload.turnId;
  const activeApprovalId = 'cadapproval:cadprop_20000000-0000-4000-8000-000000000034';
  await runtime.handleBrowserMessage(browserMessage('approval.decision', { approvalId: activeApprovalId, domain: 'cad', decision: 'decline' }));
  await waitFor(() => reports.length === 2);
  assert.equal(reports[1].result.mode, 'active_turn');
  assert.equal(launches.length, 3, 'An active CAD approval must not launch a competing Claude turn.');
  await runtime.handleBrowserMessage(browserMessage('run.cancel', { threadId: claudeSessionId, turnId }));
  await waitFor(() => socket.byType('turn.completed').length === 3);
  assert.equal(socket.byType('turn.completed').at(-1).payload.status, 'cancelled');
  assert.equal(socket.byType('run.failed').length, 0);
  console.log('Claude bridge fixture passed: handshake, chat stream, MCP activity, session, CAD approval, provider-approval rejection, cancellation.');
} finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
