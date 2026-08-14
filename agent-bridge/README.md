# TunaCAD Agent Bridge

The TunaCAD Agent Bridge connects a TunaCAD browser workspace to a supported local AI agent without editing persistent provider configuration. Codex remains the default; Gemini CLI is an optional Phase 3.6B adapter.

## Requirements

- Node.js 20 or newer.
- Codex CLI `0.146.x` or `0.147.x`.
- Optional: Gemini CLI `0.52.x` and a `GEMINI_API_KEY` environment variable.
- A current TunaCAD pairing command and one-time code from **Connect AI Agent** in the workspace.
- A verified TunaCAD account; email verification happens in the browser before a pairing session is created.

## Connect

Copy the exact command shown by TunaCAD. It has this form:

```sh
npx --yes @tunacad/agent-bridge@0.2.10 connect --origin https://tunacad.com --session <session-id>
```

Enter the one-time code only at the interactive prompt. Do not place the code in command history. If Codex authentication is required, the bridge displays the official OpenAI device-code URL and code.

## Optional Gemini CLI adapter

Select **Gemini CLI** in TunaCAD before copying the command. Set the API key only in the same terminal, then run the copied command, which ends with `--agent gemini`:

```powershell
$env:GEMINI_API_KEY = 'your-key'
npx --yes @tunacad/agent-bridge@0.2.10 connect --origin https://tunacad.com --session <session-id> --agent gemini
```

Do not append the API key to the command. The bridge passes it only to the Gemini child process. It creates a temporary system settings file whose MCP header references `TUNACAD_MCP_AGENT_TOKEN`; the raw short-lived bearer token is never written there. A supplemental admin policy denies every non-TunaCAD tool and allows only the `tunacad` MCP server. Gemini conversation state is isolated under `~/.tunacad/gemini-agent`, limited to 20 sessions and one day, so an exact session UUID can resume after a companion restart.

Gemini CLI `0.52.x` supports thread resume and turn cancellation in this adapter. Steering an active turn, provider approval responses, interactive login, and provider user-input prompts are unavailable and fail closed. TunaCAD browser-owned CAD staging and approval are unchanged.

The pairing and MCP credentials remain in process memory. Only non-secret sequence cursors are stored under `~/.tunacad/agent-bridge-cursors.json`. Stop the process with Ctrl+C and revoke the session from TunaCAD when finished.

## Verify and update

TunaCAD pins the complete package version in every pairing command. Do not replace that version with `latest`. A production release is published only by the protected `publish.yml` workflow in the public `JNaruto-mar/TunaCAD-Agent-Bridge` release repository through npm trusted publishing. npm records registry signatures and Sigstore provenance; GitHub separately attests the exact tarball and its digest manifest.

To verify a registry installation, use a temporary project with a current npm CLI:

```sh
npm install --save-exact @tunacad/agent-bridge@0.2.10
npm audit signatures
```

For a downloaded GitHub release, first verify both subjects against the TunaCAD repository, then compare the tarball with the manifest:

```sh
gh attestation verify tunacad-agent-bridge-0.2.10.tgz --repo JNaruto-mar/TunaCAD-Agent-Bridge
gh attestation verify agent-bridge-release-manifest.json --repo JNaruto-mar/TunaCAD-Agent-Bridge
node <TunaCAD-source-checkout>/scripts/verify-agent-bridge-release.mjs --manifest agent-bridge-release-manifest.json --assembly ASSEMBLY.json
```

Only update when TunaCAD displays a new exact version and both signature/provenance verification and compatibility checks pass. The bridge fails closed for uncertified Codex versions.

## Uninstall

First revoke the AI session in TunaCAD and stop every bridge process. An `npx --yes ...` launch creates no global package installation; npm manages its own cache lifecycle. For an explicit installation, run `npm uninstall @tunacad/agent-bridge` in that project, or `npm uninstall --global @tunacad/agent-bridge` for a global installation.

Uninstall deliberately preserves `~/.tunacad/agent-bridge-cursors.json`, because package removal must never delete user state implicitly. After all bridge processes have stopped and every TunaCAD AI session has been revoked, that non-secret cursor file may be removed manually. On Windows it is under `%USERPROFILE%\.tunacad`; on macOS and Linux it is under `~/.tunacad`. The companion never writes to `~/.codex/config.toml`, and uninstall must leave it unchanged.

## Support and license

This package is certified for the Codex versions listed above. Newer versions fail closed until TunaCAD certifies them. Source and redistribution remain subject to the proprietary TunaCAD license included with this package.
