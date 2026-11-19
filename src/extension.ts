import * as vscode from 'vscode';
import { startMcpServer } from './mcp/server';

const OUTPUT_CHANNEL_NAME = 'Forge Agent';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  output.appendLine('Forge Agent activated.');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    try {
      const mcp = await startMcpServer({
        workspaceRoot,
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

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.openChat', async () => {
      output.show(true);
      output.appendLine('Chat UI will be available in P4.');
      await vscode.window.showInformationMessage('Forge Agent is ready. Chat will be added in P4.');
    }),
    vscode.commands.registerCommand('forge.reviewChanges', async () => {
      output.show(true);
      output.appendLine('Hunk review will be available in P5.');
      await vscode.window.showInformationMessage('Forge change review will be added in P5.');
    }),
    vscode.commands.registerCommand('forge.breakPrimary', async () => {
      output.show(true);
      output.appendLine('Primary-model fault injection will be available in P1.');
      await vscode.window.showInformationMessage('Failover fault injection will be added in P1.');
    })
  );
}

export function deactivate(): void {
  // Future agent services are disposed through ExtensionContext subscriptions.
}
