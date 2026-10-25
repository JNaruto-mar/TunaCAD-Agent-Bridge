import { readCodexVersion, assertSupportedCodexVersion } from '../../scripts/lib/codex-app-server-client.mjs';
import { generateAndValidateCodexSchemas } from '../../scripts/lib/codex-schema-compatibility.mjs';
import { readGeminiCliVersion, assertSupportedGeminiCliVersion } from './gemini-cli-adapter.mjs';
import { readClaudeCliVersion, assertSupportedClaudeCliVersion } from './claude-cli-adapter.mjs';

export async function discoverCompanionAgents({
  readers = { codex: readCodexVersion, gemini: readGeminiCliVersion, claude: readClaudeCliVersion },
  qualifyCodex = generateAndValidateCodexSchemas,
} = {}) {
  const agents = [];
  for (const id of ['codex', 'gemini', 'claude']) {
    let probe;
    try { probe = readers[id](); }
    catch { agents.push({ id, installed: false, version: null, compatible: false }); continue; }
    let compatible = false;
    try {
      if (id === 'codex') {
        assertSupportedCodexVersion(probe.version);
        compatible = (await qualifyCodex(process.platform === 'win32' ? 'codex.cmd' : 'codex', { version: probe.version })).compatible;
      } else {
        (id === 'gemini' ? assertSupportedGeminiCliVersion : assertSupportedClaudeCliVersion)(probe);
        compatible = true;
      }
    } catch { /* Only minimal compatibility status leaves this process. */ }
    agents.push({ id, installed: true, version: probe.version, compatible });
  }
  return agents;
}
