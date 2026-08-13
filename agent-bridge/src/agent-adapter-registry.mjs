import { CodexAppServerAdapter } from './codex-app-server-adapter.mjs';
import { GeminiCliAdapter } from './gemini-cli-adapter.mjs';

export const DEFAULT_AGENT_PROVIDER = 'codex';
export const AGENT_PROVIDER_IDS = Object.freeze(['codex', 'gemini']);

export function parseAgentProvider(value = DEFAULT_AGENT_PROVIDER) {
  if (!AGENT_PROVIDER_IDS.includes(value)) {
    throw new Error(`Unsupported AI agent ${String(value)}. Choose codex or gemini.`);
  }
  return value;
}

export function createAgentAdapter({ provider = DEFAULT_AGENT_PROVIDER, pairing, options = {} }) {
  const selected = parseAgentProvider(provider);
  if (selected === 'codex') return new CodexAppServerAdapter({ pairing, ...options });
  return new GeminiCliAdapter({ pairing, ...options });
}
