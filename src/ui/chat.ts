import * as vscode from 'vscode';
import { TrueForgeClient, type DirectUpstream } from '../trueforge/client';
import { ReviewController } from '../review/review';
import { startProxy, type RunningProxy, type Upstream } from '../proxy/server';

type UpstreamSetting = { name: string; baseUrl: string; model: string; secretKey: string };

export class ForgeChat implements vscode.Disposable {
  private sessionId?: string;
  private busy = false;
  private proxy?: RunningProxy;
  private readonly upstreamStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  constructor(private readonly client: TrueForgeClient, private readonly output: vscode.OutputChannel, private readonly review: ReviewController, private readonly secrets: vscode.SecretStorage) { this.upstreamStatus.text = 'Forge: idle'; this.upstreamStatus.show(); }
  register(context: vscode.ExtensionContext): void { context.subscriptions.push(this, this.upstreamStatus, vscode.commands.registerCommand('forge.openChat', () => this.open()), vscode.commands.registerCommand('forge.stop', () => this.stop())); }
  async open(): Promise<void> {
    if (this.busy) return;
    const text = await vscode.window.showInputBox({ prompt: 'Ask Forge Agent', placeHolder: 'Describe the change you want made' });
    if (!text) return;
    try {
      this.busy = true; this.output.show(true);
      const upstreams = await this.readUpstreams();
      if (!upstreams) return;
      const upstream = upstreams[0];
      if (!this.sessionId) { this.proxy = await startProxy({ upstreams, log: (message) => this.output.appendLine(message) }); await this.client.ensureServer(); await this.client.registerProvider(upstream, this.proxy.port); this.sessionId = await this.client.createSession(upstream); }
      this.upstreamStatus.text = `Forge: ${upstream.model}`;
      this.output.appendLine(`\n> ${text}`);
      for await (const event of this.client.runTurn(this.sessionId, text)) {
        if (event.type === 'text-delta') this.output.append(event.text);
        if (event.type === 'tool-call') this.output.appendLine(`\n[tool] ${event.name} ${event.arguments.slice(0, 500)}`);
        if (event.type === 'pause') this.output.appendLine(`\n[pause] ${event.reason}; resume input will be added with approval UI.`);
        if (event.type === 'done') { this.output.appendLine(`\n[done] ${event.status}`); await this.review.open(); }
      }
    } catch (error) { this.output.appendLine(`[error] ${error instanceof Error ? error.message : String(error)}`); vscode.window.showErrorMessage('Forge Agent could not complete the turn; see Forge Agent output.'); }
    finally { this.busy = false; this.upstreamStatus.text = 'Forge: idle'; }
  }
  async stop(): Promise<void> { if (this.sessionId && this.busy) { await this.client.cancel(this.sessionId); this.output.appendLine('\n[stopped]'); } }
  togglePrimaryFailure(): boolean | undefined { return this.proxy?.togglePrimaryFailure(); }
  private async readUpstreams(): Promise<Upstream[] | undefined> { const settings = vscode.workspace.getConfiguration('forge').get<UpstreamSetting[]>('upstreams') ?? []; if (!settings.length) { this.output.appendLine('[configuration] Set forge.upstreams to an ordered array of { name, baseUrl, model, secretKey }, then store each key in VS Code SecretStorage.'); vscode.window.showWarningMessage('Forge Agent is not configured. See the Forge Agent Output Channel.'); return; } const upstreams: Upstream[] = []; for (const setting of settings) { const apiKey = await this.secrets.get(setting.secretKey) ?? process.env[setting.secretKey]; if (!apiKey) { this.output.appendLine(`[configuration] Missing SecretStorage key: ${setting.secretKey}`); vscode.window.showWarningMessage(`Forge Agent requires SecretStorage key ${setting.secretKey}.`); return; } upstreams.push({ ...setting, apiKey }); } return upstreams; }
  dispose(): void { void this.proxy?.close(); this.client.dispose(); }
}
