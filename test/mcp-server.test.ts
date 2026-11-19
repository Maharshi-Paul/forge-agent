import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type RunningMcpServer } from '../src/mcp/server';

describe('workspace MCP server', () => {
  let running: RunningMcpServer | undefined;

  afterEach(async () => {
    await running?.close();
  });

  it('serves tools over streamable HTTP and queues edits without writing them', async () => {
    const workspaceRoot = resolve(process.cwd());
    const original = await readFile(resolve(workspaceRoot, 'README.md'), 'utf8');
    running = await startMcpServer({ workspaceRoot });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const transport = new StreamableHTTPClientTransport(new URL(running.url));
    const client = new Client({ name: 'forge-agent-test', version: '0.0.1' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'repo_map', 'search', 'read_range', 'propose_edit', 'run_tests'
    ]));

    const map = await client.callTool({ name: 'repo_map', arguments: { depth: 1 } });
    expect(map.content).toMatchObject([{ type: 'text', text: expect.stringContaining('src/') }]);
    const search = await client.callTool({ name: 'search', arguments: { query: 'OUTPUT_CHANNEL_NAME' } });
    expect(search.content).toMatchObject([{ type: 'text', text: expect.stringContaining('src/extension.ts') }]);
    const range = await client.callTool({ name: 'read_range', arguments: { path: 'README.md', start: 1, end: 1 } });
    expect(range.content).toMatchObject([{ type: 'text', text: '1: # Forge Agent' }]);

    const result = await client.callTool({
      name: 'propose_edit',
      arguments: { path: 'README.md', edits: [{ old: '# Forge Agent', new: '# changed only in memory' }] }
    });
    expect(result.content).toMatchObject([{ type: 'text', text: expect.stringContaining('Queued 1 hunk') }]);
    expect(await readFile(resolve(workspaceRoot, 'README.md'), 'utf8')).toBe(original);

    await transport.terminateSession();
  });
});
