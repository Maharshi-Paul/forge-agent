# Forge Agent

A VS Code coding-agent extension using TrueForge for the agent loop, a workspace MCP server for bounded repository access, and hunk-by-hunk review before proposed edits reach disk.

## Setup

1. `npm install`
2. Configure `forge.directUpstream.baseUrl` and `forge.directUpstream.model` in VS Code.
3. Set `FORGE_UPSTREAM_API_KEY` in the Extension Host environment (or save `forge.directUpstream.apiKey` in VS Code SecretStorage).
4. `npm run build`
5. Press F5 and run **Forge: Open Chat**.

The **Forge Agent** Output Channel displays the local MCP endpoint and streamed agent activity. Proposed changes remain in memory until reviewed through **Forge: Review Changes**.

See [architecture](docs/architecture.md), [scaling](SCALING.md), and the [task log](docs/task-log.md).
