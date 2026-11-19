import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { ChangeSet, ChangeSetError, type TextEdit } from '../changes/changeset';

const MAX_MAP_LINES = 400;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_LINE_LENGTH = 200;
const MAX_READ_LINES = 300;
const TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

export type McpServerOptions = {
  workspaceRoot: string;
  changeSet?: ChangeSet;
  log?: (message: string) => void;
};

export type RunningMcpServer = {
  url: string;
  port: number;
  changeSet: ChangeSet;
  close(): Promise<void>;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

/** Starts the workspace MCP endpoint on loopback and an OS-selected port. */
export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const changeSet = options.changeSet ?? new ChangeSet();
  const ignored = await readIgnoreRules(workspaceRoot);
  const sessions = new Map<string, Session>();

  const createAgentServer = (): McpServer => createWorkspaceMcpServer({
    workspaceRoot,
    changeSet,
    ignored,
    log: options.log
  });

  const httpServer = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/mcp') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    try {
      const sessionId = request.headers['mcp-session-id'];
      const id = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        const existing = id ? sessions.get(id) : undefined;
        if (existing) {
          await existing.transport.handleRequest(request, response, body);
          return;
        }
        if (id) {
          sendRpcError(response, 404, 'Session not found');
          return;
        }
        if (!isInitializeRequest(body)) {
          sendRpcError(response, 400, 'Initialize the MCP session before making requests.');
          return;
        }

        let transport: StreamableHTTPServerTransport;
        const server = createAgentServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server });
          }
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        return;
      }

      if ((request.method === 'GET' || request.method === 'DELETE') && id) {
        const session = sessions.get(id);
        if (!session) {
          sendRpcError(response, 404, 'Session not found');
          return;
        }
        await session.transport.handleRequest(request, response);
        return;
      }

      sendRpcError(response, 405, 'Use POST /mcp to initialize a session.');
    } catch (error) {
      options.log?.(`[mcp] ${errorMessage(error)}`);
      if (!response.headersSent) {
        sendRpcError(response, 500, errorMessage(error));
      }
    }
  });

  const port = await listen(httpServer);
  const close = async (): Promise<void> => {
    await Promise.all([...sessions.values()].map(async ({ transport, server }) => {
      await transport.close();
      await server.close();
    }));
    sessions.clear();
    await new Promise<void>((resolveClose, rejectClose) => httpServer.close((error) => error ? rejectClose(error) : resolveClose()));
  };

  return { url: `http://127.0.0.1:${port}/mcp`, port, changeSet, close };
}

export function createWorkspaceMcpServer(context: WorkspaceToolContext): McpServer {
  const server = new McpServer({ name: 'forge-workspace', version: '0.0.1' });
  server.registerTool('repo_map', {
    description: 'Return a capped, gitignore-aware tree of the workspace.',
    inputSchema: { depth: z.number().int().min(1).max(8).optional() },
    annotations: { readOnlyHint: true }
  }, async ({ depth }) => textResult(await repoMap(context, depth ?? 3)));

  server.registerTool('search', {
    description: 'Search workspace files with ripgrep. Results are capped at 50 short lines.',
    inputSchema: {
      query: z.string().min(1),
      glob: z.string().min(1).optional(),
      regex: z.boolean().optional(),
      max: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ query, glob, regex, max }) => textResult(await searchWorkspace(context, query, glob, regex ?? false, max ?? MAX_SEARCH_RESULTS)));

  server.registerTool('read_range', {
    description: 'Read a numbered, bounded line range from one workspace file.',
    inputSchema: {
      path: z.string().min(1),
      start: z.number().int().min(1),
      end: z.number().int().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async ({ path, start, end }) => textResult(await readRange(context, path, start, end)));

  server.registerTool('propose_edit', {
    description: 'Queue exact text replacements for review. This never writes to disk.',
    inputSchema: {
      path: z.string().min(1),
      edits: z.array(z.object({ old: z.string(), new: z.string() })).optional(),
      create: z.boolean().optional(),
      content: z.string().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (args) => textResult(await proposeEdit(context, args)));

  server.registerTool('run_tests', {
    description: 'Run an allow-listed test command for up to 120 seconds; output is capped to its final 120 lines.',
    inputSchema: { command: z.string().min(1) },
    annotations: { readOnlyHint: true }
  }, async ({ command }) => textResult(await runTests(context, command)));

  return server;
}

export type WorkspaceToolContext = {
  workspaceRoot: string;
  changeSet: ChangeSet;
  ignored: readonly IgnoreRule[];
  log?: (message: string) => void;
};

type IgnoreRule = { pattern: string; negate: boolean };

async function repoMap(context: WorkspaceToolContext, depth: number): Promise<string> {
  const lines = ['.'];
  let truncated = false;
  const walk = async (directory: string, level: number): Promise<void> => {
    if (level >= depth || lines.length >= MAX_MAP_LINES) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = 0; index < entries.length; index += 1) {
      if (lines.length >= MAX_MAP_LINES) {
        truncated = true;
        return;
      }
      const entry = entries[index];
      const fullPath = resolve(directory, entry.name);
      const path = toWorkspacePath(context.workspaceRoot, fullPath);
      if (entry.isDirectory() && isIgnored(path, context.ignored)) {
        continue;
      }
      lines.push(`${'  '.repeat(level)}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) {
        if (level + 1 >= depth) {
          const size = await childCount(fullPath);
          if (size > 0) {
            lines.push(`${'  '.repeat(level + 1)}… (${size} entries; depth limit)`);
          }
        } else {
          await walk(fullPath, level + 1);
        }
      }
    }
  };
  await walk(context.workspaceRoot, 0);
  if (truncated) {
    lines.push(`… (tree truncated at ${MAX_MAP_LINES} lines)`);
  }
  return lines.join('\n');
}

async function searchWorkspace(context: WorkspaceToolContext, query: string, glob: string | undefined, regex: boolean, max: number): Promise<string> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**'];
  if (!regex) args.push('--fixed-strings');
  if (glob) args.push('--glob', glob);
  args.push('--', query, '.');
  const output = await collectProcess(await getRipgrepPath(), args, context.workspaceRoot, max);
  if (output.status !== 0 && output.status !== 1) {
    return `search failed: ${output.stderr.trim() || `ripgrep exited with ${output.status}`}`;
  }
  if (output.lines.length === 0) return 'No matches.';
  return output.lines.map((line) => truncateSearchLine(line)).join('\n');
}

async function readRange(context: WorkspaceToolContext, path: string, start: number, end: number): Promise<string> {
  if (end < start) return 'Error: end must be greater than or equal to start.';
  if (end - start + 1 > MAX_READ_LINES) {
    return `Error: read_range is limited to ${MAX_READ_LINES} lines. Narrow the requested range.`;
  }
  const filePath = safeWorkspacePath(context.workspaceRoot, path);
  const lines: string[] = [];
  let lineNumber = 0;
  const reader = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    lineNumber += 1;
    if (lineNumber >= start && lineNumber <= end) lines.push(`${lineNumber}: ${line}`);
    if (lineNumber >= end) break;
  }
  if (lineNumber < start) return `Error: ${path} has only ${lineNumber} lines.`;
  return lines.join('\n');
}

async function proposeEdit(context: WorkspaceToolContext, args: { path: string; edits?: TextEdit[]; create?: boolean; content?: string }): Promise<string> {
  const filePath = safeWorkspacePath(context.workspaceRoot, args.path);
  try {
    if (args.create) {
      if (args.content === undefined) return 'Error: content is required when create is true.';
      try {
        await access(filePath);
        return `Error: ${args.path} already exists; use edits instead of create.`;
      } catch {
        context.changeSet.queueNewFile(args.path, args.content);
        return `Queued 1 hunk for new file ${args.path}. No files were written to disk.`;
      }
    }
    if (!args.edits?.length) return 'Error: edits is required unless create is true.';
    const diskContent = await readFile(filePath, 'utf8');
    const queued = context.changeSet.queueEdits(args.path, diskContent, args.edits);
    return `Queued ${queued.length} hunk${queued.length === 1 ? '' : 's'} for ${args.path}. No files were written to disk.`;
  } catch (error) {
    if (error instanceof ChangeSetError) return `Error: ${error.message}`;
    return `Error proposing ${args.path}: ${errorMessage(error)}`;
  }
}

async function runTests(context: WorkspaceToolContext, command: string): Promise<string> {
  const allowed = ['pytest', 'python -m pytest', 'npm test', 'uv run pytest'];
  if (!allowed.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
    return `Error: command is not allowed. Allowed prefixes: ${allowed.join(', ')}.`;
  }
  const result = await runProcess(command, context.workspaceRoot, TEST_TIMEOUT_MS);
  const suffix = result.timedOut ? '\nTimed out after 120 seconds.' : '';
  return `Tests ${result.status === 0 && !result.timedOut ? 'passed' : 'failed'} (exit ${result.status}).${suffix}\n${lastLines(result.output, 120)}`.trim();
}

function safeWorkspacePath(workspaceRoot: string, path: string): string {
  const absolute = resolve(workspaceRoot, path);
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error('Path must stay within the workspace.');
  }
  return absolute;
}

function toWorkspacePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).split(sep).join('/');
}

async function readIgnoreRules(workspaceRoot: string): Promise<readonly IgnoreRule[]> {
  try {
    const source = await readFile(resolve(workspaceRoot, '.gitignore'), 'utf8');
    return source.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return [];
      return [{ pattern: trimmed.replace(/^!/, '').replace(/\/$/, ''), negate: trimmed.startsWith('!') }];
    });
  } catch {
    return [];
  }
}

function isIgnored(path: string, rules: readonly IgnoreRule[]): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => FORBIDDEN_DIRECTORIES.has(segment))) return true;
  let ignored = false;
  for (const rule of rules) {
    const expression = globExpression(rule.pattern);
    if (expression.test(path) || expression.test(basename(path))) ignored = !rule.negate;
  }
  return ignored;
}

function globExpression(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`(^|.*/)${escaped}($|/.*)`);
}

async function childCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return 0;
  }
}

async function collectProcess(command: string, args: string[], cwd: string, max: number): Promise<{ status: number | null; stderr: string; lines: string[] }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const lines: string[] = [];
    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const split = buffer.split(/\r?\n/);
      buffer = split.pop() ?? '';
      for (const line of split) {
        if (lines.length < max) lines.push(line);
        if (lines.length === max) child.kill();
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('close', (status) => resolveProcess({ status, stderr, lines }));
  });
}

async function runProcess(command: string, cwd: string, timeoutMs: number): Promise<{ status: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveProcess({ status: null, output: error.message, timedOut });
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolveProcess({ status, output, timedOut });
    });
  });
}

function truncateSearchLine(line: string): string {
  const normalized = line.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
  const match = /^(.+?:\d+:)(.*)$/.exec(normalized);
  if (!match) return normalized.slice(0, MAX_SEARCH_LINE_LENGTH);
  return `${match[1]}${match[2].slice(0, MAX_SEARCH_LINE_LENGTH)}`;
}

function lastLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(-count).join('\n');
}

function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('MCP request body exceeds 1 MB.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON request body.');
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('Could not determine MCP server port.'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function sendRpcError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getRipgrepPath(): Promise<string> {
  // Keep this ESM-only dependency external to the CommonJS extension bundle.
  return (await import('@vscode/ripgrep')).rgPath;
}
