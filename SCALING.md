# Scaling approach

Forge Agent keeps repository data out of the model context unless the agent asks for a narrow, bounded view.

- `repo_map` respects `.gitignore`, skips generated/vendor-heavy directories, limits output to roughly 400 lines, and reports truncated directory sizes.
- `search` uses ripgrep and returns at most 50 results with each match truncated to 200 characters.
- `read_range` requires explicit line bounds and rejects requests above 300 lines.
- Proposed changes are held in an in-memory ChangeSet. The agent sends exact replacements; the reviewer decides which hunks reach the workspace.
- TrueForge provides session compaction and large-tool-response offloading; the MCP tools additionally keep their own responses small.

These limits make the agent suitable for large repositories without dumping trees or whole files into a prompt.
