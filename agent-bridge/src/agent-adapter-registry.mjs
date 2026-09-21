import { CodexAppServerAdapter } from './codex-app-server-adapter.mjs';
import { GeminiCliAdapter } from './gemini-cli-adapter.mjs';
import { ClaudeCliAdapter } from './claude-cli-adapter.mjs';

export const DEFAULT_AGENT_PROVIDER = 'codex';
export const AGENT_PROVIDER_IDS = Object.freeze(['codex', 'gemini', 'claude']);

export function parseAgentProvider(value = DEFAULT_AGENT_PROVIDER) {
  if (!AGENT_PROVIDER_IDS.includes(value)) {
    throw new Error(`Unsupported AI agent ${String(value)}. Choose codex, gemini, or claude.`);
  }
  return value;
}

export function createAgentAdapter({ provider = DEFAULT_AGENT_PROVIDER, pairing, options = {} }) {
  const selected = parseAgentProvider(provider);
  if (selected === 'codex') return new CodexAppServerAdapter({ pairing, ...options });
  if (selected === 'gemini') return new GeminiCliAdapter({ pairing, ...options });
  return new ClaudeCliAdapter({ pairing, ...options });
}
