# TunaCAD Agent Bridge

The TunaCAD Agent Bridge connects a TunaCAD browser workspace to a locally installed Codex App Server without editing persistent Codex configuration.

## Requirements

- Node.js 20 or newer.
- Codex CLI `0.146.x` or `0.147.x`.
- A current TunaCAD pairing command and one-time code from **Connect AI Agent** in the workspace.
- A verified TunaCAD account; email verification happens in the browser before a pairing session is created.

## Connect

Copy the exact command shown by TunaCAD. It has this form:

```sh
npx --yes @tunacad/agent-bridge@0.2.7 connect --origin https://tunacad.com --session <session-id>
```

Enter the one-time code only at the interactive prompt. Do not place the code in command history. If Codex authentication is required, the bridge displays the official OpenAI device-code URL and code.

The pairing and MCP credentials remain in process memory. Only non-secret sequence cursors are stored under `~/.tunacad/agent-bridge-cursors.json`. Stop the process with Ctrl+C and revoke the session from TunaCAD when finished.

## Verify and update

TunaCAD pins the complete package version in every pairing command. Do not replace that version with `latest`. A production release is published only by the protected `publish.yml` workflow in the public `JNaruto-mar/TunaCAD-Agent-Bridge` release repository through npm trusted publishing. npm records registry signatures and Sigstore provenance; GitHub separately attests the exact tarball and its digest manifest.

To verify a registry installation, use a temporary project with a current npm CLI:

```sh
npm install --save-exact @tunacad/agent-bridge@0.2.7
npm audit signatures
```

For a downloaded GitHub release, first verify both subjects against the TunaCAD Agent Bridge repository, then compare the tarball with the manifest:

```sh
gh attestation verify tunacad-agent-bridge-0.2.7.tgz --repo JNaruto-mar/TunaCAD-Agent-Bridge
gh attestation verify agent-bridge-release-manifest.json --repo JNaruto-mar/TunaCAD-Agent-Bridge
node scripts/verify-agent-bridge-release.mjs --manifest agent-bridge-release-manifest.json --assembly ASSEMBLY.json
```

Only update when TunaCAD displays a new exact version and both signature/provenance verification and compatibility checks pass. The bridge fails closed for uncertified Codex versions.

## Uninstall

First revoke the AI session in TunaCAD and stop every bridge process. An `npx --yes ...` launch creates no global package installation; npm manages its own cache lifecycle. For an explicit installation, run `npm uninstall @tunacad/agent-bridge` in that project, or `npm uninstall --global @tunacad/agent-bridge` for a global installation.

Uninstall deliberately preserves `~/.tunacad/agent-bridge-cursors.json`, because package removal must never delete user state implicitly. After all bridge processes have stopped and every TunaCAD AI session has been revoked, that non-secret cursor file may be removed manually. On Windows it is under `%USERPROFILE%\.tunacad`; on macOS and Linux it is under `~/.tunacad`. The companion never writes to `~/.codex/config.toml`, and uninstall must leave it unchanged.

## Support and license

This package is certified for the Codex versions listed above. Newer versions fail closed until TunaCAD certifies them. Source and redistribution remain subject to the proprietary TunaCAD license included with this package.
