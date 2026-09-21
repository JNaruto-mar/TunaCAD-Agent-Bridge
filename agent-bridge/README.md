# TunaCAD Agent Bridge

The TunaCAD Agent Bridge connects a TunaCAD browser workspace to a supported local AI agent without editing persistent provider configuration. Codex remains the default; Gemini CLI and Claude Code CLI are also supported.

## Requirements

- Node.js 20 or newer.
- Codex CLI `>=0.150.0`; TunaCAD has tested `0.150.0` through `0.155.1` and schema-checks newer versions at startup.
- Optional: a Gemini CLI with the required headless streaming, MCP allowlist, extension, and resume options, plus a `GEMINI_API_KEY` environment variable.
- A current TunaCAD pairing command and one-time code from **Connect AI Agent** in the workspace.
- A TunaCAD account authenticated with Google or GitHub OAuth in the browser before a pairing session is created.

## Install or update

The recommended setup needs no permanent installation: copy the exact versioned `npx --yes` command shown by TunaCAD whenever you connect.

For an explicit global installation, install or update the exact supported release and verify it with npm:

```powershell
npm install --global @tunacad/agent-bridge@0.2.15
npm list --global @tunacad/agent-bridge --depth=0
```

Run the same `npm install --global` command again to update an older global installation. Do not substitute `latest` for the exact version shown by TunaCAD.

## Connect

Copy the exact command shown by TunaCAD. It has this form:

```sh
npx --yes @tunacad/agent-bridge@0.2.15 connect --origin https://tunacad.com --session <session-id>
```

Enter the one-time code only at the interactive prompt. Do not place the code in command history. If Codex authentication is required, the bridge displays the official OpenAI device-code URL and code.

## Optional Gemini CLI adapter

Select **Gemini CLI** in TunaCAD before copying the command. Set the API key only in the same terminal, then run the copied command, which ends with `--agent gemini`:

```powershell
$env:GEMINI_API_KEY = 'your-key'
npx --yes @tunacad/agent-bridge@0.2.15 connect --origin https://tunacad.com --session <session-id> --agent gemini
```

Do not append the API key to the command. The bridge passes it only to the Gemini child process. It creates a temporary system settings file whose MCP header references `TUNACAD_MCP_AGENT_TOKEN`; the raw short-lived bearer token is never written there. A supplemental admin policy denies every non-TunaCAD tool and allows only the `tunacad` MCP server. Gemini conversation state is isolated under `~/.tunacad/gemini-agent`, limited to 20 sessions and one day, so an exact session UUID can resume after a companion restart.

The bridge checks Gemini CLI options at startup and accepts compatible older and newer versions. Gemini supports thread resume and turn cancellation in this adapter. Steering an active turn, provider approval responses, interactive login, and provider user-input prompts are unavailable and fail closed. TunaCAD browser-owned CAD staging and approval are unchanged.

## Claude Code CLI adapter

Select **Claude Code CLI** in TunaCAD before copying the command. The copied command ends with `--agent claude`:

```sh
npx --yes @tunacad/agent-bridge@0.2.15 connect --origin https://tunacad.com --session <session-id> --agent claude
```

Sign in with `claude auth login` or provide `ANTHROPIC_API_KEY` in the terminal. The bridge checks the installed CLI for the headless streaming, MCP isolation, and resume options it requires. Compatible newer versions remain usable. It creates a temporary MCP configuration that references the short-lived token through `TUNACAD_MCP_AGENT_TOKEN`, and limits available tools to TunaCAD MCP tools. Claude sessions can resume by their session ID; turn cancellation stops the CLI process. Browser-owned CAD approval remains in TunaCAD.
The pairing and MCP credentials remain in process memory. Only non-secret sequence cursors are stored under `~/.tunacad/agent-bridge-cursors.json`. Stop the process with Ctrl+C and revoke the session from TunaCAD when finished.

## Verify and update

TunaCAD pins the complete package version in every pairing command. Do not replace that version with `latest`. Releases are published interactively from a clean, reviewed source checkout with the maintainer's npm account and two-factor authentication. Direct terminal publishing does not produce GitHub/Sigstore provenance, so the release procedure requires a dry run, exact registry integrity comparison, a clean installation, and registry-signature verification when npm's signature service is reachable.

From the package root, publish one immutable version at a time:

```sh
npm login --auth-type=web
npm whoami
npm publish --dry-run --access public --provenance=false
npm publish --access public --provenance=false
npm view @tunacad/agent-bridge@<version> version dist.integrity --json
```

Never put an npm password, access token, or one-time code in the command line, repository, logs, or support messages. Complete npm's interactive browser/2FA prompt instead. A published npm version cannot be overwritten.

To verify a registry installation, use a temporary project with a current npm CLI:

```sh
npm install --save-exact @tunacad/agent-bridge@0.2.15
npm audit signatures
```

Compare npm's `dist.integrity` with the reviewed dry-run integrity and install the exact version in a temporary project before updating TunaCAD. Run `npm audit signatures` when npm's signature service is reachable. Only update when TunaCAD displays a new exact version and the integrity, installation, signature, and compatibility checks pass. Newer untested Codex versions remain enabled only when their required stable app-server schema is compatible, with a non-blocking warning.

## Uninstall

First revoke the AI session in TunaCAD and stop every bridge process. An `npx --yes ...` launch creates no global package installation; npm manages its own cache lifecycle. For an explicit installation, run `npm uninstall @tunacad/agent-bridge` in that project, or `npm uninstall --global @tunacad/agent-bridge` for a global installation.

Uninstall deliberately preserves `~/.tunacad/agent-bridge-cursors.json`, because package removal must never delete user state implicitly. After all bridge processes have stopped and every TunaCAD AI session has been revoked, that non-secret cursor file may be removed manually. On Windows it is under `%USERPROFILE%\.tunacad`; on macOS and Linux it is under `~/.tunacad`. The companion never writes to `~/.codex/config.toml`, and uninstall must leave it unchanged.

## Support and license

This package is tested for the Codex range listed above. Versions below the minimum and versions missing required stable app-server features fail closed. Source and redistribution remain subject to the proprietary TunaCAD license included with this package.
