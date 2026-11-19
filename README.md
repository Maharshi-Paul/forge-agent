# Forge Agent

Forge Agent is a VS Code extension prototype for repository-aware coding assistance. TrueForge owns the agent loop; a local MCP server exposes bounded workspace tools; proposed edits stay in memory until reviewed hunk by hunk.

## What you need

- Node.js **22.13 or newer**
- VS Code **1.95 or newer**
- Git
- An OpenAI-compatible model provider and API key

The API key is stored locally in VS Code SecretStorage. It is never written to this repository.

## First-time setup

Open PowerShell and run:

```powershell
git clone https://github.com/Maharshi-Paul/forge-agent.git
Set-Location forge-agent
npm install
npm run build
code .
```

### Configure model providers

In VS Code, press `Ctrl+Shift+P` and run **Preferences: Open Workspace Settings (JSON)**. Add the following, replacing URLs and model names only. Do not put an API key in this file.

```json
{
  "forge.upstreams": [
    {
      "name": "primary",
      "baseUrl": "https://provider.example/v1",
      "model": "your-primary-model",
      "secretKey": "FORGE_PRIMARY_API_KEY"
    },
    {
      "name": "fallback",
      "baseUrl": "https://provider.example/v1",
      "model": "your-fallback-model",
      "secretKey": "FORGE_FALLBACK_API_KEY"
    }
  ]
}
```

For a no-cost OpenRouter prototype setup, use `https://openrouter.ai/api/v1` as `baseUrl` and `openrouter/free` as each model. Free providers can be rate-limited.

## Run in development

1. Open **Run and Debug** in VS Code.
2. Select **Run Forge Agent Extension** from the launch dropdown and click ▶. A second window opens: **Extension Development Host**.
3. In that new window, use the Command Palette (`Ctrl+Shift+P`) to run **Forge: Configure API Key**.
4. Choose `primary`, paste the primary key into the protected input, and confirm.
5. Run **Forge: Configure API Key** again and repeat for `fallback`. The same key may be used for both during testing.

The key is stored in VS Code SecretStorage. Never paste it into `settings.json`, source files, screenshots, or chat messages.

### First chat

1. In the **Extension Development Host**, run **Forge: Open Chat**.
2. Ask: `List the top-level folders of this repository.`
3. Open **View → Output** and select **Forge Agent** to see tool activity, proxy attempts, and streamed output.

On the first request, TrueForge is downloaded and started locally at `http://localhost:8790`; this can take a few minutes. Later requests reuse the local server.

## Commands

| Command | Purpose |
| --- | --- |
| **Forge: Open Chat** | Opens the prompt input and starts an agent turn. |
| **Forge: Stop** | Cancels the active TrueForge session turn. |
| **Forge: Review Changes** | Opens proposed file changes for hunk-by-hunk review. |
| **Forge: Break Primary Model** | Toggles primary-proxy fault injection for failover testing. |
| **Forge: Configure API Key** | Stores a configured upstream key in VS Code SecretStorage. |

## Development commands

```powershell
npm run build    # bundle the extension
npm run watch    # rebuild on source changes
npm test         # tests without model credentials
npm run package  # create a VSIX package
```

## How data is handled

- The model accesses the workspace only through the local MCP server.
- Repository maps, search results, and reads are capped to avoid loading whole repositories into context.
- `propose_edit` does not write to disk; it queues exact replacements in an in-memory ChangeSet.
- Only accepted hunks are applied through VS Code's `WorkspaceEdit` API.
- The local model proxy retries transient failures and can fail over to a configured backup upstream.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| **Forge Agent is not configured** | Add `forge.upstreams` to workspace settings, then use **Forge: Configure API Key** for every `secretKey`. |
| **TrueForge did not start within 60 seconds** | Wait until output says `Agent server listening on http://localhost:8790`, then retry the chat. |
| **Forge command does not appear** | Confirm you are in the **Extension Development Host** window, not the original VS Code window. |
| **Outbound URL blocked for 127.0.0.1** | Rebuild and reload the extension. |
| **A key was exposed** | Revoke it at the provider immediately, create a new key, then use **Forge: Configure API Key** again. |

## Prototype status

This repository is an architecture prototype, not a production-ready coding agent. See [architecture](docs/architecture.md), [scaling](SCALING.md), and [task scope](docs/task-log.md) for component details, limits, and planned hardening.
