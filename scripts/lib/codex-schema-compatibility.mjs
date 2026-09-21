import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_AGENT_BRIDGE_COMPATIBILITY } from '../../src/aiAgent/bridgeCompatibility.mjs';
import { platformLaunch } from './codex-app-server-client.mjs';

const containsMethod = (source, method) => source.includes(`"${method}"`);
const schemaCompatibilityCache = new Map();

export function validateCodexSchemaSources({ clientRequests, serverNotifications, serverRequests }) {
  const compatibility = AI_AGENT_BRIDGE_COMPATIBILITY.codexAppServer;
  const missingMethods = compatibility.requiredMethods.filter((method) => !containsMethod(clientRequests, method));
  const missingClientWireValues = compatibility.requiredClientWireValues.filter(
    (value) => !containsMethod(clientRequests, value),
  );
  const missingNotifications = compatibility.requiredNotifications.filter(
    (method) => !containsMethod(serverNotifications, method),
  );
  const missingServerRequests = compatibility.requiredServerRequests.filter(
    (method) => !containsMethod(serverRequests, method),
  );
  const missingServerRequestWireValues = compatibility.requiredServerRequestWireValues.filter(
    (value) => !containsMethod(serverRequests, value),
  );
  return {
    compatible: missingMethods.length === 0
      && missingClientWireValues.length === 0
      && missingNotifications.length === 0
      && missingServerRequests.length === 0
      && missingServerRequestWireValues.length === 0,
    requiredMethodCount: compatibility.requiredMethods.length,
    requiredClientWireValueCount: compatibility.requiredClientWireValues.length,
    requiredNotificationCount: compatibility.requiredNotifications.length,
    requiredServerRequestCount: compatibility.requiredServerRequests.length,
    requiredServerRequestWireValueCount: compatibility.requiredServerRequestWireValues.length,
    missingMethods,
    missingClientWireValues,
    missingNotifications,
    missingServerRequests,
    missingServerRequestWireValues,
  };
}

export function clearCodexSchemaCompatibilityCache() {
  schemaCompatibilityCache.clear();
}

export async function generateAndValidateCodexSchemas(codexBinary, {
  version = 'unknown',
  generator = generateAndValidateCodexSchemasUncached,
} = {}) {
  const cacheKey = `${String(codexBinary)}\u0000${String(version)}`;
  if (schemaCompatibilityCache.has(cacheKey)) return schemaCompatibilityCache.get(cacheKey);
  const pending = Promise.resolve().then(() => generator(codexBinary));
  schemaCompatibilityCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    schemaCompatibilityCache.delete(cacheKey);
    throw error;
  }
}

async function generateAndValidateCodexSchemasUncached(codexBinary) {
  const prefix = path.join(os.tmpdir(), 'tunacad-codex-schema-');
  const directory = await mkdtemp(prefix);
  const resolvedTemp = path.resolve(os.tmpdir()) + path.sep;
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedDirectory.startsWith(resolvedTemp)) throw new Error('Unsafe Codex schema temporary directory.');
  try {
    const launch = platformLaunch(codexBinary, [
      'app-server', 'generate-json-schema', '--out', resolvedDirectory,
    ]);
    const generated = spawnSync(launch.command, launch.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    if (generated.error) throw generated.error;
    if (generated.status !== 0) {
      throw new Error((generated.stderr || generated.stdout || 'Codex schema generation failed.').trim());
    }
    const [clientRequests, serverNotifications, serverRequests] = await Promise.all([
      readFile(path.join(resolvedDirectory, 'ClientRequest.json'), 'utf8'),
      readFile(path.join(resolvedDirectory, 'ServerNotification.json'), 'utf8'),
      readFile(path.join(resolvedDirectory, 'ServerRequest.json'), 'utf8'),
    ]);
    return validateCodexSchemaSources({ clientRequests, serverNotifications, serverRequests });
  } finally {
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
}
