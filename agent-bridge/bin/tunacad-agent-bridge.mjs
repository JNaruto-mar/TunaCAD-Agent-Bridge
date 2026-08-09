#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  exchangePairingCode,
} from '../src/relay-client.mjs';
import { RelayConnectionSupervisor } from '../src/relay-connection-supervisor.mjs';

const args = parseArguments(process.argv.slice(2));
if (args.command !== 'connect' || !args.origin || !args.session) {
  fail('Usage: tunacad-agent-bridge connect --origin https://tunacad.com --session <session-id>');
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
const supervisor = new RelayConnectionSupervisor({ pairing });
supervisor.on('reconnecting', ({ attempt, delayMs }) => {
  stdout.write(`TunaCAD relay reconnect ${attempt}/5 in ${delayMs} ms.\n`);
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
      stdout.write(`Codex sign-in: ${result.login.verificationUrl}\n`);
      stdout.write(`Enter device code: ${result.login.userCode}\n`);
      result.login.completion.then(
        ({ account }) => stdout.write(`Codex sign-in completed${account.planType ? ` (${account.planType})` : ''}. TunaCAD is ready.\n`),
        (error) => reportFatal(error instanceof Error ? error.message : String(error)),
      );
    } else {
      stdout.write('Codex login could not be started. Run `codex login`, then reconnect TunaCAD.\n');
    }
  } else {
    stdout.write(`TunaCAD Agent Bridge ready with Codex ${result.version}. Keep this terminal open.\n`);
  }
} catch (error) {
  reportFatal(error instanceof Error ? error.message : String(error));
  await supervisor.close();
}

process.once('SIGINT', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  void supervisor.close();
});

function parseArguments(values) {
  const parsed = { command: values[0] };
  for (let index = 1; index < values.length; index += 1) {
    const key = values[index];
    if (key === '--code') fail('Do not put a pairing code on the command line. Enter it at the interactive prompt.');
    if (key === '--origin' || key === '--session') parsed[key.slice(2)] = values[++index];
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
