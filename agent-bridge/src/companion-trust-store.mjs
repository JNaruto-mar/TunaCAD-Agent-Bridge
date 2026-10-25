import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultCursorFilePath } from './cursor-store.mjs';

// Only installation trust belongs here, never relay/session/provider credentials.
export class CompanionTrustStore {
  constructor(filePath = path.join(path.dirname(defaultCursorFilePath()), 'companion-trust.json')) {
    this.filePath = filePath;
    this.records = new Map();
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (value.schemaVersion !== 1 || !Array.isArray(value.devices) || value.devices.length > 32) throw new Error('Invalid Companion trust store.');
      for (const device of value.devices) {
        if (Object.keys(device).sort().join(',') !== 'id,key,origin'
          || !/^[a-f0-9]{64}$/.test(device.key) || !/^[a-f0-9-]{36}$/.test(device.id)
          || new URL(device.origin).origin !== device.origin) throw new Error('Invalid Companion trust record.');
        this.records.set(device.id, device);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, devices: [...this.records.values()] }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filePath);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
