import { spawn, type ChildProcess } from 'node:child_process';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const DEFAULT_BASE_URL = 'http://localhost:8790';
const PROVIDER_NAME = 'forge-proxy';
const CONFIGURED_MODEL_NAME = 'chat-model';
const MCP_SERVER_NAME = 'forge-workspace';

export const FORGE_AGENT_INSTRUCTIONS = `You are a senior engineer working inside the user's VS Code workspace through the forge-workspace tools. Never ask the user which files to change: find them. Workflow: repo_map -> search for symbols and call sites -> read_range only what you need -> propose_edit for EVERY affected file (source, tests, docs) in as few edit calls as possible -> run_tests -> fix failures with more propose_edit calls -> finish with a short summary of what changed and why. Never paste whole files. Prefer many small precise edits over rewriting files. If a tool errors, read the error and retry with a corrected call.`;

export type DirectUpstream = { baseUrl: string; apiKey: string; model: string };
export type NormalizedTurnEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; name: string; arguments: string; toolCallId: string; threadId: string }
  | { type: 'pause'; turnId: string; lastEventId: string; reason: 'approval' | 'question' | 'mcp-auth'; pending: unknown }
  | { type: 'done'; status: string; output?: string };

export class TrueForgeClient {
  private client?: TrueForge;
  private spawned?: ChildProcess;

  constructor(private readonly options: { baseUrl?: string; log?: (message: string) => void } = {}) {}

  async ensureServer(): Promise<TrueForge> {
    const baseUrl = this.options.baseUrl ?? DEFAULT_BASE_URL;
    if (!(await isReachable(baseUrl))) {
      this.options.log?.('[trueforge] starting local server');
      this.spawned = spawn('npx', ['--yes', '@truefoundry/trueforge@latest'], {
        shell: process.platform === 'win32', windowsHide: true,
        env: { ...process.env, OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify(['127.0.0.1', 'localhost']) }
      });
      this.spawned.stdout?.on('data', (line) => this.options.log?.(`[trueforge] ${String(line).trim()}`));
      this.spawned.stderr?.on('data', (line) => this.options.log?.(`[trueforge] ${String(line).trim()}`));
      const deadline = Date.now() + 60_000;
      while (!(await isReachable(baseUrl))) {
        if (Date.now() > deadline) throw new Error(`TrueForge did not start at ${baseUrl} within 60 seconds.`);
        await delay(500);
      }
    }
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
    return this.client;
  }

  async registerProvider(upstream: DirectUpstream, proxyPort?: number): Promise<void> {
    const client = await this.requireClient();
    await client.settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'custom', name: PROVIDER_NAME, baseUrl: proxyPort ? `http://127.0.0.1:${proxyPort}/v1` : upstream.baseUrl,
        auth: { apiKey: proxyPort ? 'forge-proxy' : upstream.apiKey },
        models: [{ name: CONFIGURED_MODEL_NAME, modelId: upstream.model, properties: {} }]
      }
    });
  }

  async registerMcp(url: string): Promise<void> {
    const client = await this.requireClient();
    await client.settings.mcpServers.createOrUpdate({
      manifest: { type: 'remote', name: MCP_SERVER_NAME, url, description: 'Forge Agent workspace tools' }
    });
  }

  async createSession(upstream: DirectUpstream): Promise<string> {
    const client = await this.requireClient();
    const { data } = await client.sessions.create({ agent: { spec: {
      model: { name: `${PROVIDER_NAME}/${CONFIGURED_MODEL_NAME}` },
      instructions: FORGE_AGENT_INSTRUCTIONS,
      mcpServers: [{ name: MCP_SERVER_NAME, enableTools: ['@all'], requireApprovalForTools: [] }]
    } } });
    return data.id;
  }

  async *runTurn(sessionId: string, text: string): AsyncGenerator<NormalizedTurnEvent> {
    const client = await this.requireClient();
    const stream = await client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content: text }] });
    yield* this.normalize(stream);
  }

  async *resumeTurn(sessionId: string, turnId: string, afterEventId: string, events: unknown[]): AsyncGenerator<NormalizedTurnEvent> {
    const client = await this.requireClient();
    const stream = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId }, { timeoutInSeconds: 600 });
    await client.sessions.createTurnEvents(sessionId, turnId, { events: events as never[] });
    yield* this.normalize(stream);
  }

  async cancel(sessionId: string): Promise<void> { await (await this.requireClient()).sessions.cancel(sessionId); }
  dispose(): void { this.spawned?.kill(); }

  private async *normalize(stream: AsyncIterable<any>): AsyncGenerator<NormalizedTurnEvent> {
    let turnId = '';
    let lastEventId = '';
    for await (const event of stream) {
      lastEventId = event.id ?? lastEventId;
      if (event.type === 'turn.created') turnId = event.turnId;
      if (event.type === 'model.message.delta' && event.threadId === 'main' && event.content) yield { type: 'text-delta', text: event.content };
      if (event.type === 'model.message' && event.threadId === 'main') for (const call of event.toolCalls ?? []) yield { type: 'tool-call', name: call.toolInfo?.name ?? 'unknown', arguments: call.function?.arguments ?? '', toolCallId: call.id, threadId: event.threadId };
      if (event.type === 'tool.approval_required') yield { type: 'pause', turnId, lastEventId, reason: 'approval', pending: event };
      if (event.type === 'tool.response_required') yield { type: 'pause', turnId, lastEventId, reason: 'question', pending: event };
      if (event.type === 'mcp.auth_required') yield { type: 'pause', turnId, lastEventId, reason: 'mcp-auth', pending: event };
      if (event.type === 'turn.done') yield { type: 'done', status: event.state.status, output: event.state.output?.content };
    }
  }

  private async requireClient(): Promise<TrueForge> { return this.client ?? this.ensureServer(); }
}

async function isReachable(url: string): Promise<boolean> { try { return (await fetch(url)).ok; } catch { return false; } }
function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
