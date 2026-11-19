import * as vscode from 'vscode';
import { startMcpServer } from './mcp/server';
import { ChangeSet } from './changes/changeset';
import { ReviewController } from './review/review';
import { TrueForgeClient } from './trueforge/client';
import { ForgeChat } from './ui/chat';

const OUTPUT_CHANNEL_NAME = 'Forge Agent';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  output.appendLine('Forge Agent activated.');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const changeSet = new ChangeSet();
    const review = new ReviewController(vscode.Uri.file(workspaceRoot), changeSet);
    review.register(context);
    const chat = new ForgeChat(new TrueForgeClient({ log: (message) => output.appendLine(message) }), output, review, context.secrets);
    chat.register(context);
    context.subscriptions.push(vscode.commands.registerCommand('forge.breakPrimary', async () => {
      const active = chat.togglePrimaryFailure();
      if (active === undefined) { output.appendLine('[proxy] Start a configured chat before toggling the primary model.'); return; }
      output.appendLine(`[proxy] primary fault injection ${active ? 'enabled' : 'disabled'}`);
    }));
    try {
      const mcp = await startMcpServer({
        workspaceRoot,
        changeSet,
        log: (message) => output.appendLine(message)
      });
      output.appendLine(`Workspace MCP server listening at ${mcp.url}`);
      context.subscriptions.push({ dispose: () => void mcp.close() });
    } catch (error) {
      output.appendLine(`Failed to start workspace MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    output.appendLine('No workspace folder is open; workspace MCP server was not started.');
  }

}

export function deactivate(): void {
  // Future agent services are disposed through ExtensionContext subscriptions.
}
