import * as vscode from 'vscode';
import { TrueForgeClient } from '../trueforge/client';
import { ReviewController } from '../review/review';
import { startProxy, type RunningProxy, type Upstream } from '../proxy/server';

type UpstreamSetting = { name: string; baseUrl: string; model: string; secretKey: string };

export class ForgeChat implements vscode.Disposable {
  private sessionId?: string;
  private busy = false;
  private proxy?: RunningProxy;
  private mcpUrl?: string;
  private readonly upstreamStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  constructor(private readonly client: TrueForgeClient, private readonly output: vscode.OutputChannel, private readonly review: ReviewController, private readonly secrets: vscode.SecretStorage) { this.upstreamStatus.text = 'Forge: idle'; this.upstreamStatus.show(); }
  register(context: vscode.ExtensionContext): void { context.subscriptions.push(this, this.upstreamStatus, vscode.commands.registerCommand('forge.openChat', () => this.open()), vscode.commands.registerCommand('forge.inlineEdit', () => this.inlineEdit()), vscode.commands.registerCommand('forge.stop', () => this.stop()), vscode.commands.registerCommand('forge.configureSecret', () => this.configureSecret())); }
  async open(context?: string): Promise<void> {
    if (this.busy) return;
    const text = await vscode.window.showInputBox({ prompt: 'Ask Forge Agent', placeHolder: 'Describe the change you want made' });
    if (!text) return;
    try {
      this.busy = true; this.output.show(true);
      const upstreams = await this.readUpstreams();
      if (!upstreams) return;
      const upstream = upstreams[0];
      if (!this.sessionId) { if (!this.mcpUrl) throw new Error('Workspace MCP server is not ready. Reload the window and try again.'); this.proxy = await startProxy({ upstreams, log: (message) => this.output.appendLine(message) }); await this.client.ensureServer(); await this.client.registerProvider(upstream, this.proxy.port); await this.client.registerMcp(this.mcpUrl); this.sessionId = await this.client.createSession(upstream); }
      this.upstreamStatus.text = `Forge: ${upstream.model}`;
      this.output.appendLine(`\n> ${text}`);
      const request = context ? `${context}\n\nUser instruction: ${text}` : text;
      this.output.appendLine(context ? '[inline edit] Selection supplied to the TrueForge turn.' : '');
      for await (const event of this.client.runTurn(this.sessionId, request)) {
        if (event.type === 'text-delta') this.output.append(event.text);
        if (event.type === 'tool-call') this.output.appendLine(`\n[tool] ${event.name} ${event.arguments.slice(0, 500)}`);
        if (event.type === 'pause') this.output.appendLine(`\n[pause] ${event.reason}; resume input will be added with approval UI.`);
        if (event.type === 'done') { this.output.appendLine(`\n[done] ${event.status}`); await this.review.open(); }
      }
    } catch (error) { this.output.appendLine(`[error] ${error instanceof Error ? error.message : String(error)}`); vscode.window.showErrorMessage('Forge Agent could not complete the turn; see Forge Agent output.'); }
    finally { this.busy = false; this.upstreamStatus.text = 'Forge: idle'; }
  }
  private async inlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage('Select the code you want Forge Agent to edit first.');
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const path = root ? vscode.workspace.asRelativePath(editor.document.uri, false) : editor.document.uri.fsPath;
    const selected = editor.document.getText(editor.selection);
    if (selected.length > 12_000) {
      vscode.window.showWarningMessage('The selected code is too large for inline edit. Select a smaller region.');
      return;
    }
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + 1;
    await this.open(`Inline-edit target: ${path}, lines ${start}-${end}. The user selected this exact code:\n\n${selected}\n\nUse workspace tools to inspect only the necessary surrounding context, then propose the smallest precise edit.`);
  }
  async stop(): Promise<void> { if (this.sessionId && this.busy) { await this.client.cancel(this.sessionId); this.output.appendLine('\n[stopped]'); } }
  private async configureSecret(): Promise<void> { const settings = vscode.workspace.getConfiguration('forge').get<UpstreamSetting[]>('upstreams') ?? []; const choices = settings.map((item) => ({ label: item.name, description: item.secretKey })); const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose the upstream key to store securely' }); if (!picked) return; const key = await vscode.window.showInputBox({ prompt: `API key for ${picked.description}`, password: true, ignoreFocusOut: true }); if (!key) return; await this.secrets.store(picked.description!, key); this.output.appendLine(`[configuration] Stored ${picked.description} in VS Code SecretStorage.`); vscode.window.showInformationMessage(`Stored ${picked.description} securely.`); }
  togglePrimaryFailure(): boolean | undefined { return this.proxy?.togglePrimaryFailure(); }
  setMcpUrl(url: string): void { this.mcpUrl = url; }
  private async readUpstreams(): Promise<Upstream[] | undefined> { const settings = vscode.workspace.getConfiguration('forge').get<UpstreamSetting[]>('upstreams') ?? []; if (!settings.length) { this.output.appendLine('[configuration] Set forge.upstreams to an ordered array of { name, baseUrl, model, secretKey }, then store each key in VS Code SecretStorage.'); vscode.window.showWarningMessage('Forge Agent is not configured. See the Forge Agent Output Channel.'); return; } const upstreams: Upstream[] = []; for (const setting of settings) { const apiKey = await this.secrets.get(setting.secretKey) ?? process.env[setting.secretKey]; if (!apiKey) { this.output.appendLine(`[configuration] Missing SecretStorage key: ${setting.secretKey}`); vscode.window.showWarningMessage(`Forge Agent requires SecretStorage key ${setting.secretKey}.`); return; } upstreams.push({ ...setting, apiKey }); } return upstreams; }
  dispose(): void { void this.proxy?.close(); this.client.dispose(); }
}
