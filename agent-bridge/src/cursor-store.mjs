import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const ALLOWED_CURSOR_KEYS = new Set(['sessionId', 'nextOutgoingSequence', 'lastBrowserSequence', 'updatedAt']);

export class FileCursorStore {
  constructor({ filePath = defaultCursorFilePath() } = {}) {
    this.filePath = path.resolve(filePath);
  }

  async load(sessionId) {
    validateSessionId(sessionId);
    const document = await this.#readDocument();
    const value = document.sessions[sessionId];
    return value ? validateCursor(value, sessionId) : null;
  }

  async save(cursor) {
    const value = validateCursor({ ...cursor, updatedAt: new Date().toISOString() }, cursor?.sessionId);
    const document = await this.#readDocument();
    document.sessions[value.sessionId] = value;
    await this.#writeDocument(document);
    return value;
  }

  async clear(sessionId) {
    validateSessionId(sessionId);
    const document = await this.#readDocument();
    if (!Object.hasOwn(document.sessions, sessionId)) return false;
    delete document.sessions[sessionId];
    await this.#writeDocument(document);
    return true;
  }

  async #readDocument() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
        throw new Error('TunaCAD cursor store has an unsupported schema.');
      }
      const sessions = {};
      for (const [sessionId, cursor] of Object.entries(parsed.sessions)) {
        sessions[sessionId] = validateCursor(cursor, sessionId);
      }
      return { schemaVersion: 1, sessions };
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, sessions: {} };
      throw error;
    }
  }

  async #writeDocument(document) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }
}

export function defaultCursorFilePath() {
  const configured = process.env.TUNACAD_AGENT_BRIDGE_STATE_DIR;
  const directory = configured ? path.resolve(configured) : path.join(os.homedir(), '.tunacad');
  return path.join(directory, 'agent-bridge-cursors.json');
}

export function validateCursor(value, expectedSessionId = value?.sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TunaCAD cursor must be an object.');
  for (const key of Object.keys(value)) {
    if (!ALLOWED_CURSOR_KEYS.has(key)) throw new Error(`TunaCAD cursor contains forbidden field ${key}.`);
  }
  validateSessionId(expectedSessionId);
  if (value.sessionId !== expectedSessionId) throw new Error('TunaCAD cursor session mismatch.');
  if (!Number.isSafeInteger(value.nextOutgoingSequence) || value.nextOutgoingSequence < 0) {
    throw new Error('TunaCAD next outgoing sequence is invalid.');
  }
  if (!Number.isSafeInteger(value.lastBrowserSequence) || value.lastBrowserSequence < -1) {
    throw new Error('TunaCAD last browser sequence is invalid.');
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('TunaCAD cursor timestamp is invalid.');
  }
  return Object.freeze({
    sessionId: value.sessionId,
    nextOutgoingSequence: value.nextOutgoingSequence,
    lastBrowserSequence: value.lastBrowserSequence,
    updatedAt: value.updatedAt,
  });
}

function validateSessionId(value) {
  if (!SESSION_ID_PATTERN.test(value ?? '')) throw new Error('TunaCAD cursor session ID is invalid.');
}
