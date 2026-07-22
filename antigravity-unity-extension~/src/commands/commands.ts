import * as vscode from 'vscode';
import * as net from 'net';
import * as path from 'path';

function sendTcpCommand(commandObj: any, port: number = 56000): Promise<any> {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = '';

        // Timeout after 4 seconds
        client.setTimeout(4000);

        client.connect(port, '127.0.0.1', () => {
            client.write(JSON.stringify(commandObj) + '\n');
        });

        client.on('data', (data) => {
            buffer += data.toString();
            // Single-line response ending in newline
            if (buffer.endsWith('\n') || buffer.endsWith('\r')) {
                client.destroy();
            }
        });

        client.on('close', () => {
            try {
                if (buffer) {
                    const response = JSON.parse(buffer.trim());
                    resolve(response);
                } else {
                    reject(new Error('Empty response received from Unity Editor.'));
                }
            } catch (err) {
                reject(err);
            }
        });

        client.on('error', (err) => {
            client.destroy();
            reject(err);
        });

        client.on('timeout', () => {
            client.destroy();
            reject(new Error('Connection timed out. Ensure Unity Editor is running with Antigravity.'));
        });
    });
}

export function registerCommands(context: vscode.ExtensionContext) {
    // Attach Unity Debugger (uses DotRush's "unity" debugger type)
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-unity.attachDebugger', async () => {
            const config: vscode.DebugConfiguration = {
                type: 'unity',
                name: 'Unity Debugger',
                request: 'attach',
            };

            const success = await vscode.debug.startDebugging(undefined, config);
            if (success) {
                vscode.window.showInformationMessage('Attached to Unity Editor via DotRush');
            } else {
                vscode.window.showWarningMessage(
                    'Failed to attach. Make sure DotRush extension is installed and Unity Editor is running.'
                );
            }
        })
    );

    // Unity API Reference
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-unity.openApiReference', async () => {
            const editor = vscode.window.activeTextEditor;
            let searchTerm = '';

            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    searchTerm = editor.document.getText(selection);
                } else {
                    const wordRange = editor.document.getWordRangeAtPosition(selection.active);
                    if (wordRange) {
                        searchTerm = editor.document.getText(wordRange);
                    }
                }
            }

            if (!searchTerm) {
                searchTerm = await vscode.window.showInputBox({
                    prompt: 'Enter Unity API class or method name',
                    placeHolder: 'e.g., Transform, Rigidbody, Vector3'
                }) || '';
            }

            if (searchTerm) {
                const url = `https://docs.unity3d.com/ScriptReference/30_search.html?q=${encodeURIComponent(searchTerm)}`;
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        })
    );

    // Regenerate Project Files
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-unity.regenerateProjectFiles', async () => {
            vscode.window.showInformationMessage(
                'Please regenerate project files from Unity Editor: Edit > Preferences > External Tools > Regenerate project files'
            );
        })
    );

    // Find Usages in Unity Assets (Rider-like Scene/Prefab/SO Reference Search)
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-unity.findUsagesInAssets', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active C# file.');
                return;
            }

            const doc = editor.document;
            const fullPath = doc.fileName;

            // Resolve workspace and relative path for Unity (e.g. Assets/Scripts/PlayerController.cs)
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('File must be inside a workspace folder.');
                return;
            }

            const relativePath = path.relative(workspaceFolder.uri.fsPath, fullPath).replace(/\\/g, '/');
            const port = vscode.workspace.getConfiguration('antigravity').get<number>('debugPort', 56000);

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Searching Unity assets for usages...',
                cancellable: false
            }, async () => {
                try {
                    const response = await sendTcpCommand({
                        type: 'find_usages',
                        class_path: relativePath
                    }, port);

                    if (response.type === 'usages_result') {
                        const usages = response.usages as string[];
                        if (usages.length === 0) {
                            vscode.window.showInformationMessage(`No asset usages found in the project for ${path.basename(fullPath)}.`);
                            return;
                        }

                        // Map found assets to QuickPick items
                        const items = usages.map(usage => {
                            let icon = '$(file-media)';
                            if (usage.endsWith('.unity')) icon = '$(record-keys)';
                            else if (usage.endsWith('.prefab')) icon = '$(package)';
                            else if (usage.endsWith('.asset')) icon = '$(gear)';

                            return {
                                label: `${icon} ${path.basename(usage)}`,
                                description: usage,
                                rawPath: usage
                            };
                        });

                        const selected = await vscode.window.showQuickPick(items, {
                            placeHolder: `Select asset to highlight in Unity Editor (${usages.length} found)`
                        });

                        if (selected) {
                            // Send command to Unity to ping and select the asset
                            await sendTcpCommand({
                                type: 'ping_asset',
                                asset_path: selected.rawPath
                            }, port);
                            vscode.window.showInformationMessage(`Highlighted and selected ${path.basename(selected.rawPath)} in Unity!`);
                        }
                    } else if (response.type === 'error') {
                        vscode.window.showErrorMessage(`Unity reference search error: ${response.message}`);
                    }
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to connect to Unity Debug Bridge on port ${port}: ${err.message}`);
                }
            });
        })
    );
}
