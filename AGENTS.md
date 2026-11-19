# AGENTS.md — Forge-a-thon coding agent (VS Code extension on TrueForge)

Read this whole file before writing code. Build in the order of the prompts at the bottom. After every step: `npm run build` must pass and the step's acceptance test must pass before moving on. Commit and push after every step.

## Goal
A VS Code extension-native coding agent whose agent loop is **TrueForge** (MIT, github.com/truefoundry/trueforge). It must:
1. Work on large repos (never dump whole files or trees into context).
2. Make unprompted multi-file edits (agent finds all affected files itself).
3. Let the user review changes **hunk by hunk** (accept/reject each hunk).
4. Keep working when the model fails (retry, timeout, fallback chain, malformed tool-call repair).
Round 1 is judged on: public repo, PDF write-up, 4-minute demo of three fixed tasks on `pallets/flask` (see TASKS.md).

## Ground rules
- TypeScript, Node >= 22.13, VS Code extension API. Bundle with esbuild. Minimal dependencies.
- Do not invent TrueForge APIs. Read the real ones in `vendor/trueforge` (clone of the repo, already present and gitignored; do not re-clone or edit it):
  - `vendor/trueforge/docs/api/use-agent.mdx` (sessions, turns, events, pauses/approvals)
  - `vendor/trueforge/docs/openapi.json` (exact request bodies)
  - `vendor/trueforge/docs/create-agent/overview.mdx` (agent spec fields, `mcp_servers`, `require_approval_for_tools`)
  - `vendor/trueforge/packages/trueforge-sdk/reference.md` (SDK methods)
- If a field name is unclear, check openapi.json. Do not guess.
- No secrets in the repo. API keys come from VS Code SecretStorage or env vars. Never commit `.env`.
- Every long-running thing writes to an Output Channel named "Forge Agent".
- The agent loop must run strictly on TrueForge (competition rule). Our proxy only transports model requests; it never runs the loop.

## What is verified about TrueForge
- Local server: `npx @truefoundry/trueforge@latest`, default `http://localhost:8790`, SQLite, no auth.
- SDK: `import { TrueForge } from '@truefoundry/trueforge-sdk'`; `new TrueForge({ baseUrl, timeoutInSeconds: 600 })`.
- `client.sessions.create({ agent: { spec: { model: { name }, instructions, ... } } })` returns `{ data: session }`.
- `client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content }] })` is an async iterable of events. Seen event types: `model.message.delta` (use `event.threadId === 'main'`), `thread.created`, `turn.done` (`event.state.status`, `event.state.output?.content`). Turns can pause for approvals, questions, MCP auth: handle per use-agent.mdx "Handle pauses".
- MCP servers are **remote URLs registered by name**: `PUT /api/v1/settings/mcp-servers`. Agents attach by name. Tool approval is per server via `require_approval_for_tools` (`@all`, `@write`, `@destructive`, or tool names).
- Models: `PUT /api/v1/settings/model-providers` (supports any OpenAI-compatible endpoint). Check the body in openapi.json.
- TrueForge's own sandbox is remote/isolated and does NOT see the user's workspace. All workspace access goes through OUR MCP server.
- TrueForge has no model failover. We build it as a proxy.

## Architecture (all inside the extension process)
```
VS Code extension
 ├─ src/extension.ts        activate: start proxy + MCP server, register both with TrueForge, create session
 ├─ src/trueforge/client.ts wrapper over SDK: ensureServer(), registerProvider(), registerMcp(), runTurn()
 ├─ src/proxy/server.ts     OpenAI-compatible localhost proxy with failover (127.0.0.1:<port>/v1)
 ├─ src/mcp/server.ts       MCP server (streamable HTTP, 127.0.0.1:<port>/mcp) exposing workspace tools
 ├─ src/mcp/tools/*.ts      repo_map, search, read_range, propose_edit, run_tests
 ├─ src/changes/changeset.ts  pending edits per file, hunk model
 ├─ src/review/             diff provider, CodeLens accept/reject per hunk, apply accepted hunks
 └─ src/ui/chat.ts          NO webview: input box for prompts, Output Channel for streamed text and tool calls
```
Activation flow: start proxy (port P) -> start MCP server (port M) -> PUT model provider `forge-proxy` pointing at `http://127.0.0.1:P/v1` -> PUT MCP server `forge-workspace` at `http://127.0.0.1:M/mcp` -> on first user message create session with inline agent spec (model = forge-proxy model, instructions below, `mcp_servers: [forge-workspace]`).
Build order note: the MCP server and TrueForge wiring are built first against a DIRECT upstream model provider (no proxy) to prove the loop works end to end. The proxy is added afterwards and the provider is then repointed at it.
Use `@modelcontextprotocol/sdk` for the MCP server. Use `@vscode/ripgrep` for search. Use the `diff` package (`structuredPatch`) for hunks.

## MCP tools (keep outputs small; hard caps everywhere)
- `repo_map({ depth?: number })`: tree of workspace, respects .gitignore, skips node_modules/.git/dist, caps at ~400 lines, shows directory sizes when truncated.
- `search({ query, glob?, regex?: boolean, max?: number })`: ripgrep, returns `path:line: text` (max 50 hits, text truncated to 200 chars).
- `read_range({ path, start, end })`: numbered lines, max 300 lines per call. Error message tells the agent to narrow the range.
- `propose_edit({ path, edits: [{ old, new }] })`: exact-string replacements (each `old` must match exactly once, else return an error listing the closest match line). Does NOT write to disk; adds to the ChangeSet. Returns the number of hunks queued. Also support creating a new file (`create: true, content`).
- `run_tests({ command })`: runs in workspace with 120 s timeout, output truncated to the last 120 lines. Allow-list prefixes: `pytest`, `python -m pytest`, `npm test`, `uv run pytest`. Applies ACCEPTED changes only; see "Test runs" below.
Mark `propose_edit` as write and everything else read-only. Do not require TrueForge approval for propose_edit: our hunk review IS the approval.

### Test runs
Tests must see the proposed code. Simplest: `run_tests` copies the workspace changed files to a temp overlay or applies the ChangeSet to a git stash/worktree copy. Pick the simplest that works on Flask (a temp `git worktree` with the ChangeSet applied is fine). Return pass/fail + trimmed output. If this takes more than 30 minutes, fall back to running tests on the real tree after the user accepts hunks.

## Agent instructions (put in the inline agent spec)
> You are a senior engineer working inside the user's VS Code workspace through the forge-workspace tools. Never ask the user which files to change: find them. Workflow: repo_map -> search for symbols and call sites -> read_range only what you need -> propose_edit for EVERY affected file (source, tests, docs) in as few edit calls as possible -> run_tests -> fix failures with more propose_edit calls -> finish with a short summary of what changed and why. Never paste whole files. Prefer many small precise edits over rewriting files. If a tool errors, read the error and retry with a corrected call.

## Failover proxy (src/proxy/server.ts)
- Endpoint: `POST /v1/chat/completions` (streaming and non-streaming), `GET /v1/models`.
- Config: ordered chain `[{ name, baseUrl, apiKey, model }]` (OpenAI-compatible upstreams; Anthropic/Gemini via their OpenAI-compat endpoints).
- Behaviour: per-attempt timeout to first byte (default 30 s); retry same upstream up to 2x with exponential backoff on network errors / 429 / 5xx; then fail over to the next upstream with the full original request (rewriting `model`). If the stream dies mid-response, restart on the next upstream and do not forward partial garbage (buffer until first complete chunk or tool-call boundary; document the tradeoff).
- Tool-call repair: if a returned tool call has invalid JSON arguments, try `jsonrepair`; if still invalid, return the error to the model as a tool message once and retry before failing over.
- Circuit breaker: after 3 consecutive failures an upstream is skipped for 60 s.
- Observability: every attempt logs `[proxy] upstream=<name> status=<...> ms=<...>` to the Output Channel; status bar item shows the active upstream and flashes on failover.
- Demo switch: command `Forge: Break Primary Model` toggles fault injection (primary returns 500 or hangs) so the demo can show failover live.
- Unit tests with a fake upstream: success, 429 then success, 500 then fallback, hang then fallback, bad tool-call JSON repaired.

## Hunk review UI (src/review)
- On `turn.done` (and when the user clicks "Review changes"), open the ChangeSet: one entry per file with counts of hunks.
- For each file open `vscode.diff` between the real file and a virtual `forge-proposed:` document (TextDocumentContentProvider).
- CodeLens on every hunk in the proposed document: `Accept hunk` | `Reject hunk`; file-level `Accept all in file` | `Reject all in file`; global `Accept all` | `Reject all`.
- Rejecting a hunk removes it from the virtual document (the real file is untouched). Accepting applies only that hunk to the real file via `WorkspaceEdit`, keeping line offsets correct as earlier hunks are applied (apply bottom-to-top, or recompute with `applyPatch`).
- Status bar: `Forge: 3 files, 7 hunks pending`.
- After review, offer "Tell the agent what you rejected": send a follow-up user message listing rejected hunks so it can revise.

## Large repo handling
- Never read a file without a range unless it is under 300 lines.
- Cache the repo map and invalidate on file-system watcher events.
- Rely on TrueForge compaction and large-result offloading (on by default); our tools just stay small.
- Add a `SCALING.md` explaining these choices (used in the PDF).

## Deliverables checklist
- [ ] Public repo with MIT license, README (setup in <= 5 commands), `docs/` with architecture diagram
- [ ] `TASKS.md` with the three Flask tasks and the expected result of each
- [ ] A `Makefile` or npm script `npm run demo:setup` that clones flask, starts TrueForge, launches the extension host
- [ ] PDF write-up: architecture, failure-handling design, how each task was solved, limits, and every model used (competition rule: models must be declared)
- [ ] 4-minute demo video: task 1, task 2, task 3, plus a live failover moment and a hunk reject

## Prompts to give Codex (one at a time, in this order)

### P0 setup
"Read AGENTS.md fully first. Create a VS Code extension project in this repo with TypeScript and esbuild. vendor/trueforge already exists (gitignored); do not re-clone. Add scripts: build, watch, test (vitest), package. Add an Output Channel 'Forge Agent'. Commands: `forge.openChat`, `forge.reviewChanges`, `forge.breakPrimary`. Acceptance: npm run build passes, and F5 launches the extension host and the commands appear."

### P2 MCP workspace tools
"Implement src/mcp/server.ts (streamable HTTP on 127.0.0.1, random port) with the five tools in AGENTS.md using @modelcontextprotocol/sdk, and src/changes/changeset.ts. Include caps and error messages as specified. Acceptance: with the MCP Inspector (npx @modelcontextprotocol/inspector) I can call repo_map, search, read_range, propose_edit on a clone of pallets/flask, and propose_edit does not touch the disk."

### P3 TrueForge wiring (direct model first, no proxy yet)
"Implement src/trueforge/client.ts: detect or spawn the TrueForge server (`npx @truefoundry/trueforge@latest`, wait for http://localhost:8790), register a model provider pointing DIRECTLY at my real OpenAI-compatible upstream (we will swap it to the forge-proxy later), register the MCP server forge-workspace using the exact bodies from vendor/trueforge/docs/openapi.json, create a session with an inline agent spec (instructions from AGENTS.md), and expose runTurn(text) as an async generator of normalized events (text delta, tool call, pause, done). Handle approval/question pauses per use-agent.mdx. Acceptance: a script run in the extension host sends 'List the top-level folders of this repo' and streams an answer that used repo_map."

### P1 failover proxy
"Implement src/proxy/server.ts exactly as the 'Failover proxy' section describes, plus vitest tests with a fake upstream covering all five listed scenarios. Config comes from VS Code settings `forge.upstreams` (array) with keys from SecretStorage. Then update src/trueforge/client.ts to register the provider forge-proxy pointing at http://127.0.0.1:<port>/v1 instead of the direct upstream. Acceptance: `npm test` passes, and a curl to the proxy with the primary upstream returning 500 still returns a completion from the fallback."

### P5 hunk review
"Implement src/review/* exactly as the 'Hunk review UI' section describes. Use the `diff` package's structuredPatch for hunks. Acceptance: after the agent proposes edits to 3 files, I can accept hunk 1, reject hunk 2 and accept the rest, and only the accepted hunks change on disk. Add unit tests for applying a subset of hunks."

### P4 chat (no webview)
"Implement src/ui/chat.ts WITHOUT a webview: forge.openChat opens an input box, sends the text via runTurn, streams text deltas and tool calls (name, args, short result) to the 'Forge Agent' Output Channel, shows the active upstream in a status bar item, and adds a 'Forge: Stop' command that calls sessions.cancel. On turn.done, open the review flow. Acceptance: I can ask a question and see streamed text and tool calls."

### P6 tasks + hardening
"Using TASKS.md, run each of the three Flask tasks end to end through the extension. For each: fix tool errors, tune the agent instructions, and record what failed in docs/task-log.md. Then add the Break Primary Model demo flow and verify failover mid-task. Write README.md, SCALING.md, and docs/architecture.md."

### P7 polish
"Add a short walkthrough to the README with exact demo commands, make `npm run demo:setup` work from a clean clone, add a `vsce package` script, and run lint. Do not add features."

## If something blocks you
- TrueForge field mismatch: re-read openapi.json, then print the server's error body and fix the request. Do not work around by editing TrueForge.
- MCP server not reachable from TrueForge: confirm both run on the same host, bind to 127.0.0.1, and test with curl.
- Out of time: cut in this order — test overlay (run tests on the real tree after accepting), fancy proxy circuit breaker. The webview chat is already cut. Never cut: hunk review, failover demo, the three Flask tasks.
