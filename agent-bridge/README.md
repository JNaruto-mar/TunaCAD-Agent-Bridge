# TunaCAD Agent Bridge

The TunaCAD Agent Bridge connects a TunaCAD browser workspace to a supported local AI agent without editing persistent provider configuration. Codex remains the default; Gemini CLI and Claude Code CLI are also supported.

## Requirements

- Node.js 20 or newer.
- Node.js 24 or newer for native simulations; local Gmsh 4.15.2, CalculiX 2.16
  (Electrostatics), and the supported fingerprinted OpenRadioss 2026 installation
  (Explicit Dynamics). Providers must already be installed and configured.
- Codex CLI `>=0.150.0`; TunaCAD has tested `0.150.0` through `0.155.1` and schema-checks newer versions at startup.
- Optional: a Gemini CLI with the required headless streaming, MCP allowlist, extension, and resume options, plus a `GEMINI_API_KEY` environment variable.
- For the recommended path, keep TunaCAD Companion running on the local computer. Manual pairing remains available under Advanced / manual pairing.
- A TunaCAD account authenticated with Google or GitHub OAuth in the browser before a pairing session is created.

### AI readiness

Manual CAD does not require an AI-client sign-in. For AI automation, sign in to
the selected Codex or Claude client using its existing provider flow; Gemini's
current adapter requires its configured API key. Never paste credentials into
TunaCAD. Installation alone is not proof of authentication: AI Connect reports
**Sign-in not verified** when the adapter cannot establish it reliably.

Start Companion using the existing manager or command below. With AI Connect
open, TunaCAD detects it automatically after startup. **Allow** trusts the device;
**Authorize** permits the reviewed simulation scope. These remain distinct human
actions. In-scope simulation iterations reuse the authorized session without
repeating per-stage confirmations.

## Install or update

The 0.2.18 release candidate includes the canonical native Simulation Bridge,
shared trusted simulation authorization and automatic project-result delivery.
It retains `--version`, `-v` and the Windows `companion-ui` manager. Version 0.2.17
does not contain this native runtime. Install 0.2.18 only after its publication.

For an explicit global installation, install or update the exact supported release and verify it with npm:

```powershell
npm install --global @tunacad/agent-bridge@0.2.18
npm list --global @tunacad/agent-bridge --depth=0
```

Run the same `npm install --global` command again to update an older global installation. Do not substitute `latest` for the exact version shown by TunaCAD.

## Recommended persistent Companion

For this checkout, start:

```powershell
node agent-bridge/bin/tunacad-agent-bridge.mjs companion
```

With a Companion-enabled package installed, use `tunacad-agent-bridge companion`. Keep Companion running; no background service or automatic CLI installer is installed. Production permits only `https://tunacad.com`.

### Windows manager (local maintenance candidate)

This checkout now includes a Windows Forms manager. Double-click
`agent-bridge/bin/Open TunaCAD Companion.vbs` in File Explorer, then click
**Start**. Node.js 20 or newer must be available on PATH. Alternatively run
`node agent-bridge/bin/tunacad-agent-bridge.mjs companion-ui` from the checkout;
a package containing this feature also supports `tunacad-agent-bridge companion-ui`.
The manager is not included in the published 0.2.16 release.

PowerShell and the local Companion process remain hidden behind the manager.
**Start** checks for an existing Companion, starts one if needed, and shows
startup/running/error state. **Stop** closes only the Companion owned by this
window and its AI sessions. If another process already runs Companion, the
manager reports that fact and does not take it over or stop it. Minimize the
manager while using TunaCAD. Closing an owned running manager asks whether to
stop; Cancel keeps it open. Device trust is preserved. No Windows login
startup, global installation, execution-policy change, or trust approval is
performed automatically. The native **Allow / Cancel** device-trust dialog
remains a separate confirmation after connecting in the browser.

The current dev server reports `http://localhost:8080`. For that exact browser origin, start:

```powershell
node agent-bridge/bin/tunacad-agent-bridge.mjs companion --origin http://localhost:8080
```

If you instead open `http://127.0.0.1:8080`, use `--origin http://127.0.0.1:8080`; localhost and 127.0.0.1 are separate origins. Only the one exact origin passed to this process is allowed, including its port. There is no wildcard localhost trust.

The frontend must serve this unreleased UI and have working authentication/relay APIs. The published production UI cannot validate an unpublished browser change unless that change is already served there; this task does not publish it. The previous live attempt was blocked by seven unrelated Simulation Bridge .mts parsing errors and a browser-control sandbox startup failure. See [COMPANION-REVIEW.md](COMPANION-REVIEW.md) for the review, evidence, and manual live-validation checklist.

Open **Connect AI Agent**, select **Trust this computer**, then choose **Allow** in the Windows-native **TunaCAD Companion** prompt. The dialog shows the exact requesting origin. **Cancel** is the default (including Enter/Escape); closing it or waiting 90 seconds denies trust. Only an explicit **Allow** creates device trust. This does not approve CAD mutations, geometry transfer, simulation, or provider actions. Windows uses its built-in PowerShell/Windows Forms runtime with no visible console needed for approval. No desktop framework or new dependency is installed.

For advanced/headless use, start `tunacad-agent-bridge companion --approval terminal` in an interactive terminal, then type `TRUST`. macOS/Linux currently use this terminal path by default; native approval there is not implemented yet. Without an interactive terminal on those platforms, startup fails safely. On Windows, a native helper failure denies the request; it never falls through to another approval prompt or silently approves. Use the explicit terminal mode if native dialogs are unavailable. `--approval native` requires Windows. This one-time confirmation binds the browser profile to the exact TunaCAD origin. Sign in to TunaCAD and the chosen AI provider when required. Compatible installed Codex, Gemini, and Claude CLIs are discovered using existing bounded version/help/schema checks; click **Check again** after installing or updating a CLI yourself. The default AI preference is retained locally.

On later visits, the browser verifies the Companion and creates a new authenticated relay workspace automatically. Pairing codes are exchanged internally; users do not copy commands or codes. Reloading or reopening creates new temporary credentials. Browser page-close and disconnect attempt to revoke the workspace; the relay independently enforces expiration. **Disconnect & revoke session** preserves trust. **Forget this computer** removes the device trust and closes/revokes its Companion sessions; trusting again requires local confirmation. Clear trust before uninstalling if desired. Clearing browser site data also requires trusting again.

Trust records contain only an opaque device ID, exact origin, and HMAC key in `~/.tunacad/companion-trust.json`, or `TUNACAD_AGENT_BRIDGE_STATE_DIR/companion-trust.json`. Writes follow the existing private state-directory convention (0700 directory/0600 file on Unix; user-profile permissions on Windows). The browser stores the ID and a non-extractable HMAC CryptoKey in origin-scoped IndexedDB `tunacad-companion-trust`, object store `device`. Only the default agent ID goes in localStorage (`tunacad.default-ai`). Workspace bearer credentials are never placed in this persistent trust store or localStorage. The existing tab-scoped sessionStorage record temporarily contains the browser credential for manual reload recovery and for revoking a previous managed session; it is not device trust. Managed reloads discard/revoke that workspace and create a fresh session. Direct MCP bearer credentials are not persisted by this path. Companion relay/provider credentials and browser-owned revocation credentials are memory-only and bounded by relay expiration.

The listener binds only `127.0.0.1:47831`, validates exact Host and allowed Origin before CORS/discovery, verifies origin/path/body-bound HMAC proofs and fresh nonces, rejects replays, and signs responses. The tiny discovery response contains only protocol/version and no credentials or agent paths. Authenticated status reports CLI IDs, installation/version/compatibility only. Trust authorizes fresh sessions and never CAD, geometry transfer, provider operations, or simulation approvals. Other websites cannot establish sessions. Browser local-network permission may need to be allowed. When local access is unavailable, use Advanced / manual pairing or Advanced direct MCP.

**Advanced direct MCP** retains all external-client configurations and short-lived credentials. The dialog masks the bearer by default; **Reveal credential** shows it explicitly and **Copy configuration** copies the original valid configuration. Switching clients or sessions resets reveal. Disconnect invalidates the relay credential. No bearer is added to logs, telemetry, or endpoint URLs.

## Advanced / manual connect

Copy the exact command shown by TunaCAD. It has this form:

```sh
npx --yes @tunacad/agent-bridge@0.2.17 connect --origin https://tunacad.com --session <session-id>
```

Enter the one-time code only at the interactive prompt. Do not place the code in command history. If Codex authentication is required, the bridge displays the official OpenAI device-code URL and code.

## Optional Gemini CLI adapter

Select **Gemini CLI** in TunaCAD before copying the command. Set the API key only in the same terminal, then run the copied command, which ends with `--agent gemini`:

```powershell
$env:GEMINI_API_KEY = 'your-key'
npx --yes @tunacad/agent-bridge@0.2.17 connect --origin https://tunacad.com --session <session-id> --agent gemini
```

Do not append the API key to the command. The bridge passes it only to the Gemini child process. It creates a temporary system settings file whose MCP header references `TUNACAD_MCP_AGENT_TOKEN`; the raw short-lived bearer token is never written there. A supplemental admin policy denies every non-TunaCAD tool and allows only the `tunacad` MCP server. Gemini conversation state is isolated under `~/.tunacad/gemini-agent`, limited to 20 sessions and one day, so an exact session UUID can resume after a companion restart.

The bridge checks Gemini CLI options at startup and accepts compatible older and newer versions. Gemini supports thread resume and turn cancellation in this adapter. Steering an active turn, provider approval responses, interactive login, and provider user-input prompts are unavailable and fail closed. TunaCAD browser-owned CAD staging and approval are unchanged.

## Claude Code CLI adapter

Select **Claude Code CLI** in TunaCAD before copying the command. The copied command ends with `--agent claude`:

```sh
npx --yes @tunacad/agent-bridge@0.2.17 connect --origin https://tunacad.com --session <session-id> --agent claude
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
npm install --save-exact @tunacad/agent-bridge@0.2.17
npm audit signatures
```

Compare npm's `dist.integrity` with the reviewed dry-run integrity and install the exact version in a temporary project before updating TunaCAD. Run `npm audit signatures` when npm's signature service is reachable. Only update when TunaCAD displays a new exact version and the integrity, installation, signature, and compatibility checks pass. Newer untested Codex versions remain enabled only when their required stable app-server schema is compatible, with a non-blocking warning.

## Uninstall

First revoke the AI session in TunaCAD and stop every bridge process. An `npx --yes ...` launch creates no global package installation; npm manages its own cache lifecycle. For an explicit installation, run `npm uninstall @tunacad/agent-bridge` in that project, or `npm uninstall --global @tunacad/agent-bridge` for a global installation.

Uninstall deliberately preserves `~/.tunacad/agent-bridge-cursors.json`, because package removal must never delete user state implicitly. After all bridge processes have stopped and every TunaCAD AI session has been revoked, that non-secret cursor file may be removed manually. On Windows it is under `%USERPROFILE%\.tunacad`; on macOS and Linux it is under `~/.tunacad`. The companion never writes to `~/.codex/config.toml`, and uninstall must leave it unchanged.

## Support and license

This package is tested for the Codex range listed above. Versions below the minimum and versions missing required stable app-server features fail closed. Source and redistribution remain subject to the proprietary TunaCAD license included with this package.
