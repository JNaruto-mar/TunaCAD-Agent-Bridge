import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import {
  AGENT_BRIDGE_TIMING_POLICY,
  CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION,
  CODEX_APP_SERVER_MIN_VERSION,
} from '../../src/aiAgent/bridgeCompatibility.mjs';

export const MINIMUM_CODEX_APP_SERVER_VERSION = CODEX_APP_SERVER_MIN_VERSION;
export const MAXIMUM_EXCLUSIVE_CODEX_APP_SERVER_VERSION = CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION;
const DEFAULT_REQUEST_TIMEOUT_MS = AGENT_BRIDGE_TIMING_POLICY.requestTimeoutMs;
const MAX_STDERR_CHARS = 32_000;

const forbiddenWindowsShellCharacters = /[&|<>^%\r\n]/;

function windowsLaunch(command, args) {
  const extension = command.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (extension === '.exe' || extension === '.com') return { command, args };
  for (const value of [command, ...args]) {
    if (forbiddenWindowsShellCharacters.test(value)) {
      throw new Error('The Codex launch command contains a character that is unsafe for cmd.exe.');
    }
  }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
}

export function platformLaunch(command, args) {
  return process.platform === 'win32' ? windowsLaunch(command, args) : { command, args };
}

export function readCodexVersion(codexBinary = process.platform === 'win32' ? 'codex.cmd' : 'codex') {
  const launch = platformLaunch(codexBinary, ['--version']);
  const result = spawnSync(launch.command, launch.args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Codex exited with status ${result.status}.`).trim());
  }
  const output = result.stdout.trim();
  const match = output.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) throw new Error(`Could not parse the Codex version from: ${output}`);
  return { version: match[1], output };
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) throw new Error(`Invalid semantic version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

export function assertSupportedCodexVersion(version) {
  if (compareVersions(version, MINIMUM_CODEX_APP_SERVER_VERSION) < 0) {
    throw new Error(
      `Codex ${version} is incompatible. TunaCAD requires ${MINIMUM_CODEX_APP_SERVER_VERSION} or newer.`,
    );
  }
  if (compareVersions(version, MAXIMUM_EXCLUSIVE_CODEX_APP_SERVER_VERSION) >= 0) {
    throw new Error(
      `Codex ${version} has not been certified. TunaCAD currently supports versions before `
      + `${MAXIMUM_EXCLUSIVE_CODEX_APP_SERVER_VERSION}.`,
    );
  }
  return version;
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    command = process.platform === 'win32' ? 'codex.cmd' : 'codex',
    args = ['app-server', '--stdio'],
    env = process.env,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = new Set();
    this.serverRequests = [];
    this.serverRequestWaiters = new Set();
    this.stderr = '';
    this.exitPromise = null;
  }

  async start(
    clientInfo = { name: 'tunacad_agent_bridge', title: 'TunaCAD Agent Bridge', version: '0.1.0' },
    capabilities = {},
  ) {
    if (this.child) throw new Error('Codex App Server is already running.');
    const launch = platformLaunch(this.command, this.args);
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.once('error', (error) => this.#failPending(error));
    child.once('exit', (code, signal) => {
      if (this.pending.size) {
        const detail = this.stderr.trim();
        this.#failPending(new Error(
          `Codex App Server exited before replying (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`,
        ));
      }
      this.emit('exit', { code, signal });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
      this.emit('stderr', chunk);
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#receiveLine(line));

    const initialized = await this.request('initialize', { clientInfo, capabilities });
    this.notify('initialized', {});
    return initialized;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex App Server is not running.'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server did not answer ${method} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  waitForNotification(predicate, timeoutMs = this.requestTimeoutMs) {
    const existingIndex = this.notifications.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(this.notifications.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        reject(new Error(`Codex App Server notification did not arrive within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.notificationWaiters.add(waiter);
    });
  }

  waitForServerRequest(predicate, timeoutMs = this.requestTimeoutMs) {
    const existingIndex = this.serverRequests.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(this.serverRequests.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.serverRequestWaiters.delete(waiter);
        reject(new Error(`Codex App Server request did not arrive within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.serverRequestWaiters.add(waiter);
    });
  }

  async interruptTurn({ threadId, turnId }, {
    acknowledgementTimeoutMs = AGENT_BRIDGE_TIMING_POLICY.interruptAcknowledgementTimeoutMs,
    completionTimeoutMs = AGENT_BRIDGE_TIMING_POLICY.interruptCompletionTimeoutMs,
  } = {}) {
    const startedAt = performance.now();
    await this.request('turn/interrupt', { threadId, turnId }, acknowledgementTimeoutMs);
    const acknowledgedAt = performance.now();
    const notification = await this.waitForNotification(
      (message) => message.method === 'turn/completed'
        && message.params?.threadId === threadId
        && message.params?.turn?.id === turnId,
      completionTimeoutMs,
    );
    const completedAt = performance.now();
    return {
      notification,
      acknowledgementMs: Math.round((acknowledgedAt - startedAt) * 100) / 100,
      completionMs: Math.round((completedAt - startedAt) * 100) / 100,
    };
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.stdin.writable) child.stdin.end();
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!exited) child.kill();
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.#failPending(new Error('Codex App Server client closed.'));
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Codex App Server client closed.'));
    }
    this.notificationWaiters.clear();
    for (const waiter of this.serverRequestWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Codex App Server client closed.'));
    }
    this.serverRequestWaiters.clear();
  }

  #write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server stdin is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receiveLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolError', new Error('Codex App Server emitted invalid JSONL.'));
      return;
    }
    if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? `Codex App Server ${pending.method} failed.`);
        Object.assign(error, { code: message.error.code, data: message.error.data });
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      for (const waiter of this.serverRequestWaiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.serverRequestWaiters.delete(waiter);
        waiter.resolve(message);
        this.emit('serverRequest', message);
        return;
      }
      this.serverRequests.push(message);
      if (this.serverRequests.length > 100) this.serverRequests.shift();
      this.emit('serverRequest', message);
      return;
    }
    if (typeof message.method === 'string') {
      for (const waiter of this.notificationWaiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.notificationWaiters.delete(waiter);
        waiter.resolve(message);
        this.emit('notification', message);
        return;
      }
      this.notifications.push(message);
      if (this.notifications.length > 1_000) this.notifications.shift();
      this.emit('notification', message);
      return;
    }
    this.emit('protocolError', new Error('Codex App Server emitted an unknown message shape.'));
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
