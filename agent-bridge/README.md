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

## Uninstall

The `npx` cache can be cleared with your normal npm cache-management policy. The optional non-secret cursor file can be removed after all bridge processes have stopped. No entry is written to `~/.codex/config.toml`.

## Support and license

This package is certified for the Codex versions listed above. Newer versions fail closed until TunaCAD certifies them. Source and redistribution remain subject to the proprietary TunaCAD license included with this package.
