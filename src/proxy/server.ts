import { createServer, type Server } from 'node:http';
import { jsonrepair } from 'jsonrepair';

export type Upstream = { name: string; baseUrl: string; apiKey: string; model: string };
export type ProxyOptions = { upstreams: Upstream[]; timeoutMs?: number; log?: (message: string) => void };
export type RunningProxy = { port: number; url: string; breakPrimary: boolean; togglePrimaryFailure(): boolean; close(): Promise<void> };

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  if (!options.upstreams.length) throw new Error('At least one forge.upstreams entry is required.');
  const failures = new Map<string, { count: number; until: number }>();
  let breakPrimary = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') return respond(res, 200, { object: 'list', data: options.upstreams.map((u) => ({ id: u.model, object: 'model' })) });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return respond(res, 404, { error: { message: 'Not found' } });
    const body = JSON.parse(await bodyText(req));
    for (let index = 0; index < options.upstreams.length; index += 1) {
      const upstream = options.upstreams[index];
      const state = failures.get(upstream.name);
      if (state && state.until > Date.now()) continue;
      for (let retry = 0; retry < 3; retry += 1) {
        const began = Date.now();
        try {
          if (index === 0 && breakPrimary) throw new Error('fault injection');
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
          const result = await fetch(`${upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${upstream.apiKey}` }, body: JSON.stringify({ ...body, model: upstream.model }), signal: controller.signal }); clearTimeout(timer);
          options.log?.(`[proxy] upstream=${upstream.name} status=${result.status} ms=${Date.now() - began}`);
          if (result.status === 429 || result.status >= 500) throw new Error(`HTTP ${result.status}`);
          const text = await result.text();
          if (!result.ok) return respond(res, result.status, text, result.headers.get('content-type') ?? 'application/json');
          return respond(res, 200, repairToolArguments(text), result.headers.get('content-type') ?? 'application/json');
        } catch (error) {
          options.log?.(`[proxy] upstream=${upstream.name} status=failed ms=${Date.now() - began}`);
          if (retry < 2) await new Promise((r) => setTimeout(r, 50 * 2 ** retry));
          else { const count = (failures.get(upstream.name)?.count ?? 0) + 1; failures.set(upstream.name, { count, until: count >= 3 ? Date.now() + 60_000 : 0 }); }
        }
      }
    }
    respond(res, 502, { error: { message: 'All configured upstreams failed.' } });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
  return { port, url: `http://127.0.0.1:${port}/v1`, get breakPrimary() { return breakPrimary; }, togglePrimaryFailure: () => (breakPrimary = !breakPrimary), close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}
function repairToolArguments(text: string): string { try { const value = JSON.parse(text); for (const c of value.choices ?? []) for (const t of c.message?.tool_calls ?? []) { try { JSON.parse(t.function.arguments); } catch { t.function.arguments = jsonrepair(t.function.arguments); } } return JSON.stringify(value); } catch { return text; } }
async function bodyText(req: any): Promise<string> { const parts: Buffer[] = []; for await (const p of req) parts.push(Buffer.from(p)); return Buffer.concat(parts).toString(); }
function respond(res: any, status: number, value: unknown, type = 'application/json'): void { res.writeHead(status, { 'content-type': type }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); }
