import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Forge Agent';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  output.appendLine('Forge Agent activated.');

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
