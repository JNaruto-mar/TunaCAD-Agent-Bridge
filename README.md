# TunaCAD Agent Bridge

Public, auditable source for `@tunacad/agent-bridge`, the local authenticated companion between a TunaCAD browser workspace and Codex App Server.

The companion uses process-scoped MCP configuration and keeps pairing and MCP credentials in memory. It does not edit persistent Codex configuration. See [agent-bridge/README.md](agent-bridge/README.md) for installation and usage.

## Verify

```sh
npm ci
npm test
```

## License

Copyright (c) 2026 Jamal Elouafi. No open-source license is granted. See [agent-bridge/LICENSE](agent-bridge/LICENSE).
