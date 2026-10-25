#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import {
  exchangePairingCode,
} from '../src/relay-client.mjs';
import { RelayConnectionSupervisor } from '../src/relay-connection-supervisor.mjs';
import { AGENT_BRIDGE_TIMING_POLICY } from '../../src/aiAgent/bridgeCompatibility.mjs';
import { parseAgentProvider } from '../src/agent-adapter-registry.mjs';

if (process.argv.length === 3 && ['--version', '-v'].includes(process.argv[2])) {
  stdout.write(await readPackageVersion() + '\n');
} else if (process.argv[2] === 'companion-ui') {
  if (process.argv.length !== 3) fail('Usage: tunacad-agent-bridge companion-ui');
  const { launchCompanionManager } = await import('../src/companion-manager-launcher.mjs');
  await launchCompanionManager();
  stdout.write('TunaCAD Companion manager opened. Use Start in its window.\n');
} else if (process.argv[2] === 'companion') {
  const { parseCompanionArguments } = await import('../src/companion-approval.mjs');
  let options;
  try { options = parseCompanionArguments(process.argv.slice(3)); }
  catch (error) { fail(error.message); }
  const { runCompanion } = await import('./companion.mjs');
  await runCompanion(options.origin, options);
} else {
  await runManual();
}

async function readPackageVersion() {
  // Source checkout and assembled npm CLI have different relative roots.
  for (const relative of ['../package.json', '../../../package.json']) {
    let metadata;
    try { metadata = JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (metadata.name === '@tunacad/agent-bridge' && typeof metadata.version === 'string') return metadata.version;
  }
  throw new Error('Agent Bridge package version metadata is unavailable.');
}

async function runManual() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command !== 'connect' || !args.origin || !args.session) {
    fail('Usage: tunacad-agent-bridge connect --origin https://tunacad.com --session <session-id> [--agent codex|gemini|claude]');
  }
  if (!stdin.isTTY) fail('Pairing requires an interactive terminal so the one-time code is not placed in shell history.');

  const prompt = createInterface({ input: stdin, output: stdout });
  let pairing;
  try {
    const code = await prompt.question('TunaCAD one-time pairing code: ');
    pairing = await exchangePairingCode({ origin: args.origin, sessionId: args.session, code });
  } finally {
    prompt.close();
  }

  let heartbeatTimer;
  const supervisor = new RelayConnectionSupervisor({ pairing, agentProvider: args.agent });
  supervisor.on('reconnecting', ({ attempt, delayMs }) => {
    stdout.write(`TunaCAD relay reconnect ${attempt}/${AGENT_BRIDGE_TIMING_POLICY.reconnectDelaysMs.length} in ${delayMs} ms.\n`);
  });
  supervisor.on('rotationCommitted', () => stdout.write('TunaCAD session credentials rotated securely.\n'));
  supervisor.on('failure', (error) => reportFatal(error instanceof Error ? error.message : String(error)));
  supervisor.on('terminal', ({ code }) => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    stdout.write(`TunaCAD Agent Bridge stopped by the relay (${code}).\n`);
  });

  try {
    const result = await supervisor.start();
    heartbeatTimer = setInterval(() => supervisor.sendHeartbeat(), 15_000);
    heartbeatTimer.unref();
    if (result.status === 'authentication_required') {
      if (result.login) {
        stdout.write(`${result.agent.name} sign-in: ${result.login.verificationUrl}\n`);
        stdout.write(`Enter device code: ${result.login.userCode}\n`);
        result.login.completion.then(
          ({ account }) => stdout.write(`${result.agent.name} sign-in completed${account.planType ? ` (${account.planType})` : ''}. TunaCAD is ready.\n`),
          (error) => reportFatal(error instanceof Error ? error.message : String(error)),
        );
      } else {
        const remediation = args.agent === 'gemini'
          ? 'Set GEMINI_API_KEY in this terminal, then reconnect TunaCAD.'
          : args.agent === 'claude'
            ? 'Run claude auth login or set ANTHROPIC_API_KEY, then reconnect TunaCAD.'
            : 'Authenticate the agent, then reconnect TunaCAD.';
        stdout.write(`${result.agent.name} authentication could not be started. ${remediation}\n`);
      }
    } else {
      stdout.write(`TunaCAD Agent Bridge ready with ${result.agent.name} ${result.agent.version}. Keep this terminal open.\n`);
    }
  } catch (error) {
    reportFatal(error instanceof Error ? error.message : String(error));
    await supervisor.close();
  }

  process.once('SIGINT', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    void supervisor.close();
  });

}

function parseArguments(values) {
  const parsed = { command: values[0], agent: 'codex' };
  for (let index = 1; index < values.length; index += 1) {
    const key = values[index];
    if (key === '--code') fail('Do not put a pairing code on the command line. Enter it at the interactive prompt.');
    if (key === '--origin' || key === '--session') parsed[key.slice(2)] = values[++index];
    else if (key === '--agent') {
      try { parsed.agent = parseAgentProvider(values[++index]); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    }
    else fail(`Unknown argument: ${key}`);
  }
  return parsed;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function reportFatal(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
