// Public, solver-free contract checks. No account access, CLI launch or consent.
import assert from 'node:assert/strict';
import {createCodexLaunchArguments,assertProcessScopedMcpConfig} from '../agent-bridge/src/codex-app-server-adapter.mjs';
const pairing={mcpUrl:'https://tunacad.com/api/ai/controlled/mcp',agentToken:'not-a-credential',trustedAutomation:true};
const trusted=createCodexLaunchArguments(pairing.mcpUrl,true),manual=createCodexLaunchArguments(pairing.mcpUrl);
assert(trusted.includes('mcp_servers.tunacad.default_tools_approval_mode="approve"'));
assert(!manual.some(x=>x.includes('default_tools_approval_mode')));
assert(!trusted.some(x=>/approval_policy|sandbox_mode|dangerously|full-access/.test(x)));
const config={config:{mcp_servers:{tunacad:{url:pairing.mcpUrl,bearer_token_env_var:'TUNACAD_MCP_AGENT_TOKEN',required:true,default_tools_approval_mode:'approve'}}}};
assertProcessScopedMcpConfig(config,pairing);
delete config.config.mcp_servers.tunacad.default_tools_approval_mode;
assert.throws(()=>assertProcessScopedMcpConfig(config,pairing),/permission scope/);
assertProcessScopedMcpConfig(config,{...pairing,trustedAutomation:false});
config.config.mcp_servers.tunacad.default_tools_approval_mode='prompt';
assert.throws(()=>assertProcessScopedMcpConfig(config,pairing),/permission scope/);
console.log('PASS user-opted-in TunaCAD-only MCP permissions, unchanged manual/sandbox policy and fail-closed effective-config verification. No provider launched.');
