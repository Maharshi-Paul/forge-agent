import * as vscode from 'vscode';
import { ChangeSet } from '../changes/changeset';
import { acceptedContent, proposedContent } from './apply';

const SCHEME = 'forge-proposed';

export class ReviewController implements vscode.Disposable, vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly provider: vscode.TextDocumentContentProvider;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

  constructor(private readonly root: vscode.Uri, private readonly changes: ChangeSet) {
    this.provider = { onDidChange: this.contentEmitter.event, provideTextDocumentContent: (uri) => proposedContent(this.requireFile(uri)) };
    this.status.command = 'forge.reviewChanges';
  }
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider), vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, this), this.status, this, vscode.commands.registerCommand('forge.reviewChanges', () => this.open()));
    context.subscriptions.push(vscode.commands.registerCommand('forge.acceptHunk', (path, id) => this.set(path, id, 'accepted')),
      vscode.commands.registerCommand('forge.rejectHunk', (path, id) => this.set(path, id, 'rejected')),
      vscode.commands.registerCommand('forge.acceptFile', (path) => this.all(path, 'accepted')),
      vscode.commands.registerCommand('forge.rejectFile', (path) => this.all(path, 'rejected')),
      vscode.commands.registerCommand('forge.acceptAll', () => this.allFiles('accepted')),
      vscode.commands.registerCommand('forge.rejectAll', () => this.allFiles('rejected')));
    this.refresh();
  }
  async open(): Promise<void> { for (const file of this.changes.listFiles()) { const real = vscode.Uri.joinPath(this.root, file.path); const proposed = real.with({ scheme: SCHEME, path: real.path }); await vscode.commands.executeCommand('vscode.diff', real, proposed, `Forge: ${file.path}`); } }
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] { const file = this.requireFile(document.uri); const lenses: vscode.CodeLens[] = []; for (const hunk of file.hunks) { const line = Math.max(0, document.getText().indexOf(hunk.new) >= 0 ? document.positionAt(document.getText().indexOf(hunk.new)).line : 0); const range = new vscode.Range(line, 0, line, 0); lenses.push(new vscode.CodeLens(range, { title: 'Accept hunk', command: 'forge.acceptHunk', arguments: [file.path, hunk.id] }), new vscode.CodeLens(range, { title: 'Reject hunk', command: 'forge.rejectHunk', arguments: [file.path, hunk.id] })); } return lenses; }
  private async set(path: string, id: string, status: 'accepted' | 'rejected'): Promise<void> { this.changes.setHunkStatus(path, id, status); if (status === 'accepted') await this.apply(path); this.refresh(); }
  private async all(path: string, status: 'accepted' | 'rejected'): Promise<void> { this.changes.setAllStatuses(path, status); if (status === 'accepted') await this.apply(path); this.refresh(); }
  private async allFiles(status: 'accepted' | 'rejected'): Promise<void> { for (const file of this.changes.listFiles()) await this.all(file.path, status); }
  private async apply(path: string): Promise<void> { const file = this.changes.getFile(path); if (!file) return; const target = vscode.Uri.joinPath(this.root, path); const edit = new vscode.WorkspaceEdit(); edit.replace(target, new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0), acceptedContent(file)); await vscode.workspace.applyEdit(edit); }
  private requireFile(uri: vscode.Uri) { const path = vscode.workspace.asRelativePath(uri, false); const file = this.changes.getFile(path); if (!file) throw new Error(`No proposed file for ${path}`); return file; }
  private refresh(): void { const files = this.changes.listFiles(); const count = files.reduce((n, file) => n + file.hunks.filter((hunk) => hunk.status === 'pending').length, 0); this.status.text = `Forge: ${files.length} files, ${count} hunks pending`; this.status.show(); this.emitter.fire(); for (const file of files) this.contentEmitter.fire(vscode.Uri.joinPath(this.root, file.path).with({ scheme: SCHEME })); }
  dispose(): void { this.emitter.dispose(); this.contentEmitter.dispose(); }
}
