# Architecture

```text
VS Code Extension Host
├── Forge chat (Input Box + Output Channel)
├── TrueForge client
│   ├── local TrueForge server
│   └── inline agent session
├── local model proxy (failover transport)
├── workspace MCP server (127.0.0.1, random port)
│   ├── repo_map / search / read_range
│   ├── propose_edit (in-memory ChangeSet)
│   └── run_tests
└── review controller
    ├── forge-proposed: virtual documents
    ├── CodeLens accept/reject actions
    └── WorkspaceEdit for accepted hunks
```

The model never receives unrestricted workspace content. TrueForge orchestrates turns and tool calls; the extension’s MCP server is the only workspace-access boundary. Proposed edits are not written by tools. The review controller applies accepted content only.

## Configuration and security

Clients configure `forge.upstreams` as an ordered list of `{ name, baseUrl, model, secretKey }`. The extension resolves each API key exclusively from VS Code SecretStorage by `secretKey` (with a same-named environment variable allowed only for local development). Configuration values identify a secret; they never contain one. When configuration is absent, chat reports the missing settings in the Forge Agent Output Channel and does not start TrueForge or call a model.

## Prototype limits

The provided project is an architecture scaffold. Client teams should complete production observability, approval/question UI, test overlays for unaccepted proposals, and the remaining proxy edge-case test coverage before production use.
