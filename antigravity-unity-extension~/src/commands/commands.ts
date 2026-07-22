import * as vscode from 'vscode';
import * as net from 'net';
import * as path from 'path';
import { exec } from 'child_process';



/**
 * Restores and brings the Unity Editor OS window to the foreground using its exact process ID.
 * On Windows: encodes the PowerShell script as Base64 UTF-16LE and uses -EncodedCommand to
 * avoid all quoting/escaping issues with multi-line Add-Type scripts.
 * On macOS: uses `open -a Unity`.
 */
function focusUnityWindowByPid(pid: number) {
    if (process.platform !== 'win32') {
        if (process.platform === 'darwin') {
            exec('open -a Unity');
        }
        return;
    }

    // Multi-line PowerShell script using here-string syntax for Add-Type.
    // Passed via -EncodedCommand (Base64 UTF-16LE) to avoid all quoting issues.
    const script = `
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne 0) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
    [Win32]::ShowWindow($p.MainWindowHandle, 9)
    [Win32]::BringWindowToTop($p.MainWindowHandle)
    [Win32]::SetForegroundWindow($p.MainWindowHandle)
}
`;

    // Encode as UTF-16LE Base64 — required by PowerShell -EncodedCommand
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`);
}

function sendTcpCommand(commandObj: any, port: number = 56000): Promise<any> {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let buffer = '';
        let resolved = false;

        client.setTimeout(5000);

        client.connect(port, '127.0.0.1', () => {
            client.write(JSON.stringify(commandObj) + '\n');
        });

        client.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    try {
                        const response = JSON.parse(trimmed);
                        resolved = true;
                        client.destroy();
                        resolve(response);
                        return;
                    } catch {
                        // Continue accumulating if chunk was partial
                    }
                }
            }
        });

        client.on('close', () => {
            if (!resolved) {
                reject(new Error('Connection closed before receiving response from Unity Editor.'));
            }
        });

        client.on('error', (err) => {
            if (!resolved) {
                client.destroy();
                reject(err);
            }
        });

        client.on('timeout', () => {
            if (!resolved) {
                client.destroy();
                reject(new Error('Connection timed out. Ensure Unity Editor is running with Antigravity.'));
            }
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

    // Ping asset in Unity directly (interactive click from hover/decorations)
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-unity.pingAsset', async (arg: { assetPath?: string; localId?: number }) => {
            const port = vscode.workspace.getConfiguration('antigravity').get<number>('debugPort', 56000);
            try {
                // Focus Unity Window first if we can resolve the pid
                // Retrieve info first to get PID
                const info = await sendTcpCommand({ type: 'info' }, port).catch(() => null);
                if (info && typeof info.process_id === 'number') {
                    focusUnityWindowByPid(info.process_id);
                }

                await sendTcpCommand({
                    type: 'ping_asset',
                    asset_path: arg.assetPath,
                    local_id: arg.localId
                }, port);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to ping asset in Unity: ${err.message}`);
            }
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
                    // Resolve the exact PID of the connected Unity instance before searching
                    // (PID will be returned in the find_usages response, no extra round-trip needed)
                    let unityPid: number | null = null;

                    const response = await sendTcpCommand({
                        type: 'find_usages',
                        class_path: relativePath
                    }, port);

                    if (response.type === 'usages_result') {
                        // Extract PID from the response (included by Unity bridge to avoid extra round-trip)
                        if (typeof response.process_id === 'number') {
                            unityPid = response.process_id as number;
                        }

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
                            placeHolder: `Select asset usage (${usages.length} found)`
                        });

                        if (selected) {
                            // Focus the exact connected Unity instance by PID before sending the command
                            if (unityPid !== null) {
                                focusUnityWindowByPid(unityPid);
                            }

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
