import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { getUnityPort, findActiveUnityPort, getBridgeInfo, getActiveUnityProjectPath, isUnityWorkspace } from './portResolver';

export interface UnityInfoResponse {
    type: string;
    unity_version?: string;
    project_name?: string;
    project_path?: string;
    mono_debugger_port?: number;
    script_debugging_enabled?: boolean;
    is_playing?: boolean;
    is_paused?: boolean;
    process_id?: number;
}

export class UnityConnectionMonitor {
    private statusBarItem: vscode.StatusBarItem;
    private timer: NodeJS.Timeout | undefined;
    private isConnected: boolean = false;
    private lastUnityInfo: UnityInfoResponse | undefined;
    private activePort: number = 0;
    private failedCheckCount: number = 0;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'antigravity-unity.showUnityMenu';
        context.subscriptions.push(this.statusBarItem);

        // Register Quick Menu command for Status Bar click
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-unity.showUnityMenu', () => {
                this.showQuickMenu();
            })
        );

        // Register Manual Reconnect command with exact diagnostic messages
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-unity.checkUnityConnection', async () => {
                await this.checkConnection();
                if (this.isConnected) {
                    vscode.window.showInformationMessage(`Connected to Unity Editor v${this.lastUnityInfo?.unity_version || ''} (${this.lastUnityInfo?.project_name || ''})`);
                } else {
                    const activeProjectPath = getActiveUnityProjectPath();
                    const editorInstancePath = activeProjectPath ? path.join(activeProjectPath, 'Library', 'EditorInstance.json') : '';
                    if (editorInstancePath && fs.existsSync(editorInstancePath)) {
                        vscode.window.showWarningMessage('Unity Editor is open, but Debug Bridge is not running yet. Ensure Antigravity IDE is selected in Unity (Edit > Preferences > External Tools) and there are no C# compile errors in Unity.');
                    } else {
                        vscode.window.showWarningMessage('Unity Editor is not currently running for this project. Please open Unity Editor.');
                    }
                }
            })
        );

        // Watch for active editor tab changes to update connection for current project
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.checkConnection())
        );

        // Watch for Library/Antigravity/bridge.json changes for instant auto-reconnect
        const watcher = vscode.workspace.createFileSystemWatcher('**/Library/Antigravity/bridge.json');
        watcher.onDidCreate(() => this.checkConnection());
        watcher.onDidChange(() => this.checkConnection());
        watcher.onDidDelete(() => this.checkConnection());
        context.subscriptions.push(watcher);

        // Initial check and start polling loop (every 3 seconds)
        this.updateStatusDisconnected();
        this.checkConnection();
        this.startPolling();
    }

    private startPolling(): void {
        this.timer = setInterval(() => {
            this.checkConnection();
        }, 3000);

        this.context.subscriptions.push({
            dispose: () => {
                if (this.timer) clearInterval(this.timer);
            }
        });
    }

    public async checkConnection(): Promise<boolean> {
        if (!isUnityWorkspace()) {
            this.failedCheckCount = 0;
            this.isConnected = false;
            this.lastUnityInfo = undefined;
            this.statusBarItem.hide();
            return false;
        }

        const port = await findActiveUnityPort();
        this.activePort = port;
        try {
            const info = await this.queryUnityInfo(port);
            if (info && info.type === 'debug_info') {
                // Verify this response belongs to the correct Unity project
                const bridgeInfo = getBridgeInfo();
                if (bridgeInfo?.projectPath) {
                    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
                    if (info.project_path && normalize(info.project_path) !== normalize(bridgeInfo.projectPath)) {
                        // Connected to wrong Unity instance — fall through to disconnected
                        this.failedCheckCount = 0;
                        this.isConnected = false;
                        this.lastUnityInfo = undefined;
                        this.updateStatusDisconnected();
                        return false;
                    }
                }
                this.failedCheckCount = 0;
                this.isConnected = true;
                this.lastUnityInfo = info;
                this.updateStatusConnected(info);
                return true;
            }
        } catch {
            // Connection failed
        }

        // Connection failed — check if Unity Editor is still open (compiling / domain reloading)
        const activeProjectPath = getActiveUnityProjectPath();
        const editorInstancePath = activeProjectPath ? path.join(activeProjectPath, 'Library', 'EditorInstance.json') : '';
        const bridgeJsonPath = activeProjectPath ? path.join(activeProjectPath, 'Library', 'Antigravity', 'bridge.json') : '';

        const isEditorOpen = (editorInstancePath && fs.existsSync(editorInstancePath)) || (bridgeJsonPath && fs.existsSync(bridgeJsonPath));

        this.failedCheckCount++;

        if (isEditorOpen && this.failedCheckCount <= 2) {
            // Unity is open but temporarily unreachable (compiling scripts or reloading AppDomain)
            this.updateStatusCompiling();
            return false;
        }

        this.failedCheckCount = 0;
        this.isConnected = false;
        this.lastUnityInfo = undefined;
        this.updateStatusDisconnected();
        return false;
    }


    private updateStatusConnected(info: UnityInfoResponse): void {
        const playState = info.is_playing ? (info.is_paused ? ' ⏸️' : ' ▶️') : '';
        const debugState = info.script_debugging_enabled === false ? ' ⚠️ (Script Debugging Off)' : '';

        this.statusBarItem.text = `$(unity) Unity: Connected${playState}${debugState}`;
        this.statusBarItem.color = info.script_debugging_enabled === false ? new vscode.ThemeColor('statusBarItem.warningForeground') : '#3794ff';
        this.statusBarItem.backgroundColor = undefined;

        let warningNotice = '';
        if (info.script_debugging_enabled === false) {
            warningNotice = `\n> ⚠️ **Warning**: Unity Script Debugging is disabled in Unity Build Settings. Enable it in Unity (File > Build Settings > Script Debugging) to allow debugger breakpoints.\n`;
        }

        this.statusBarItem.tooltip = new vscode.MarkdownString(
            `### 🟢 Unity Editor Connected\n` +
            `- **Unity Version**: \`${info.unity_version || 'Unknown'}\`\n` +
            `- **Project**: \`${info.project_name || 'Unity Project'}\`\n` +
            `- **Process ID**: \`${info.process_id || 'N/A'}\`\n` +
            `- **Status**: \`${info.is_playing ? (info.is_paused ? 'Paused' : 'Playing') : 'Edit Mode'}\`\n` +
            `- **Script Debugging**: \`${info.script_debugging_enabled !== false ? 'Enabled' : 'Disabled'}\`\n` +
            `${warningNotice}\n` +
            `*Click to open Unity commands menu*`
        );
        this.statusBarItem.show();
    }

    private updateStatusCompiling(): void {
        if (!isUnityWorkspace()) {
            this.statusBarItem.hide();
            return;
        }

        this.statusBarItem.text = `$(sync~spin) Unity: Compiling...`;
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = new vscode.MarkdownString(
            `### 🟡 Unity Editor Compiling\n` +
            `Unity Editor is currently compiling C# scripts or reloading AppDomain.\n\n` +
            `*Connection will resume automatically once compilation completes.*`
        );
        this.statusBarItem.show();
    }

    private updateStatusDisconnected(): void {
        if (!isUnityWorkspace()) {
            this.statusBarItem.hide();
            return;
        }

        this.statusBarItem.text = `$(unity) Unity: Offline`;
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.statusBarItem.backgroundColor = undefined;
        const port = getUnityPort();
        this.statusBarItem.tooltip = new vscode.MarkdownString(
            `### 🔴 Unity Editor Disconnected\n` +
            `Could not reach Unity Debug Bridge on port ${port}.\n\n` +
            `**Troubleshooting**:\n` +
            `1. Make sure **Unity Editor** is open with your project.\n` +
            `2. Check that the **Antigravity** package is installed in Unity.\n` +
            `3. Verify script compile errors are fixed in Unity.\n\n` +
            `*Click to reconnect or open menu*`
        );
        this.statusBarItem.show();
    }

    private async showQuickMenu(): Promise<void> {
        const items: vscode.QuickPickItem[] = [
            {
                label: '$(debug-alt) Attach Unity Debugger',
                description: 'Start debugging Unity scripts via DotRush',
                detail: 'Attach Mono debugger'
            },
            {
                label: '$(refresh) Check / Reconnect to Unity',
                description: `Bridge Port: ${this.activePort > 0 ? this.activePort : getUnityPort()}`,
                detail: this.isConnected ? 'Status: Connected' : 'Status: Offline'
            },
            {
                label: '$(search) Find Class Usages in Unity Assets',
                description: 'Search prefabs, scenes, and scriptable objects'
            },
            {
                label: '$(sync) Regenerate Project Files',
                description: 'Update .csproj and .sln files from Unity'
            },
            {
                label: '$(book) Open Unity API Reference',
                description: 'Search official Unity ScriptReference docs'
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Antigravity Unity Menu — ${this.isConnected ? 'Connected 🟢' : 'Disconnected 🔴'}`
        });

        if (!selected) return;

        if (selected.label.includes('Attach Unity Debugger')) {
            vscode.commands.executeCommand('antigravity-unity.attachDebugger');
        } else if (selected.label.includes('Check / Reconnect')) {
            await this.checkConnection();
        } else if (selected.label.includes('Find Class Usages')) {
            vscode.commands.executeCommand('antigravity-unity.findUsagesInAssets');
        } else if (selected.label.includes('Regenerate Project Files')) {
            vscode.commands.executeCommand('antigravity-unity.regenerateProjectFiles');
        } else if (selected.label.includes('Open Unity API Reference')) {
            vscode.commands.executeCommand('antigravity-unity.openApiReference');
        }
    }

    private queryUnityInfo(port: number): Promise<UnityInfoResponse> {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let buffer = '';
            let resolved = false;

            client.setTimeout(1500);

            client.connect(port, '127.0.0.1', () => {
                client.write(JSON.stringify({ type: 'info' }) + '\n');
            });

            client.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) {
                        try {
                            const res = JSON.parse(trimmed);
                            resolved = true;
                            client.end();
                            client.destroy();
                            resolve(res);
                            return;
                        } catch {}
                    }
                }
            });

            client.on('close', () => {
                if (!resolved) reject(new Error('Closed'));
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
                    reject(new Error('Timeout'));
                }
            });
        });
    }
}
