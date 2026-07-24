import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerCompletionProviders } from './completion/unityCompletions';
import { registerCommands } from './commands/commands';
// import { registerCsprojFixer } from './csproj/csprojFixer'; // Disabled: interferes with DotRush compilation
import { ReferenceCodeLensProvider } from './csproj/codeLensProvider';
import { UnityExplorerProvider, isUnityWorkspace } from './explorer/unityExplorer';
import { InspectorValuesProvider } from './csproj/inspectorValuesProvider';
import { VariableInspectorTreeProvider } from './debugger/debuggerInspector';
import { UnityConnectionMonitor } from './unityConnection';
import { getBridgeInfo } from './portResolver';

const DOTRUSH_EXTENSION_ID = 'nromanov.dotrush';

export class UnityDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            config.type = 'unity';
            config.name = 'Attach to Unity Editor';
            config.request = 'attach';
        }

        if (config.type === 'unity') {
            const rootPath = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (rootPath) {
                const editorInstancePath = path.join(rootPath, 'Library', 'EditorInstance.json');
                if (fs.existsSync(editorInstancePath)) {
                    config.path = editorInstancePath;
                }
                config.projectPath = rootPath;

                const bridgeInfo = getBridgeInfo();
                if (bridgeInfo && bridgeInfo.processId) {
                    config.processId = bridgeInfo.processId;
                }
            }
        }

        return config;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // MUST be first: inject dotnet into PATH before DotRush tries to spawn it.
    // GUI apps on macOS/Linux don't inherit shell PATH, causing 'spawn dotnet ENOENT'.
    injectDotnetPath();

    console.log('[Antigravity Unity] Extension activated');

    // Register Debug Configuration Provider to automatically target exact workspace Unity Editor
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('unity', new UnityDebugConfigurationProvider())
    );

    // Auto-install DotRush if not present
    await ensureDotRushInstalled();

    // Register Variable Inspector Provider
    const variableInspectorProvider = new VariableInspectorTreeProvider(context);
    const variableInspectorTreeView = vscode.window.createTreeView('antigravity-unity.variableInspector', {
        treeDataProvider: variableInspectorProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(variableInspectorTreeView);

    // Register all features (debugging handled by DotRush)
    registerCompletionProviders(context);
    registerCommands(context, variableInspectorProvider);
    // registerCsprojFixer(context); // Disabled: interferes with DotRush compilation

    // Register Reference CodeLens Provider
    const codeLensProvider = new ReferenceCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'csharp', scheme: 'file' },
            codeLensProvider
        )
    );

    // Register JetBrains Rider-like Serialized Inspector Values Provider (Decorations & Hovers)
    const inspectorValuesProvider = new InspectorValuesProvider(context);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: 'csharp', scheme: 'file' },
            inspectorValuesProvider
        )
    );

    // Register Unity Explorer TreeView
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const isUnity = isUnityWorkspace(workspaceRoot);
    vscode.commands.executeCommand('setContext', 'antigravity-unity.isUnityProject', isUnity);

    if (workspaceRoot && isUnity) {
        const unityExplorer = new UnityExplorerProvider(workspaceRoot);

        const treeView = vscode.window.createTreeView('antigravity-unity.unityExplorer', {
            treeDataProvider: unityExplorer,
            showCollapseAll: true
        });
        context.subscriptions.push(treeView);

        // Refresh command
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-unity.refreshUnityExplorer', () => {
                unityExplorer.refresh();
            })
        );

        // Expand All command
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-unity.expandAllUnityExplorer', async () => {
                await unityExplorer.expandAll(treeView);
            })
        );

        // Reveal Active File / Show Current Script command
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-unity.revealActiveFileInUnityExplorer', async () => {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    vscode.window.showInformationMessage('No active script open in editor.');
                    return;
                }
                const activeFilePath = activeEditor.document.uri.fsPath;
                const item = unityExplorer.findItemForPath(activeFilePath);
                if (item) {
                    try {
                        await treeView.reveal(item, { select: true, focus: true, expand: true });
                    } catch (err) {
                        vscode.window.showWarningMessage(`Could not locate script in Unity Explorer: ${path.basename(activeFilePath)}`);
                    }
                } else {
                    vscode.window.showInformationMessage(`The current file is outside the Unity project: ${path.basename(activeFilePath)}`);
                }
            })
        );

        // Context Menu File Management Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-unity.explorerNewFile', (item) => unityExplorer.createFile(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerNewFolder', (item) => unityExplorer.createFolder(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerRename', (item) => unityExplorer.renameItem(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerDelete', (item) => unityExplorer.deleteItem(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerDuplicate', (item) => unityExplorer.duplicateItem(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerCopyPath', (item) => unityExplorer.copyPath(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerCopyRelativePath', (item) => unityExplorer.copyRelativePath(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerRevealInOS', (item) => unityExplorer.revealInOS(item)),
            vscode.commands.registerCommand('antigravity-unity.explorerOpenToSide', (item) => unityExplorer.openToSide(item))
        );

        // Auto-refresh when files change in Assets or Packages
        const assetsPattern = new vscode.RelativePattern(workspaceRoot, '{Assets,Packages}/**/*');
        const watcher = vscode.workspace.createFileSystemWatcher(assetsPattern);
        let refreshTimeout: NodeJS.Timeout | undefined;
        const debouncedRefresh = () => {
            if (refreshTimeout) clearTimeout(refreshTimeout);
            refreshTimeout = setTimeout(() => unityExplorer.refresh(), 250);
        };
        watcher.onDidChange(debouncedRefresh);
        watcher.onDidCreate(debouncedRefresh);
        watcher.onDidDelete(debouncedRefresh);
        context.subscriptions.push(watcher);
    }

    // Watch for .csproj changes from Unity and auto-restart DotRush
    setupCsprojChangeWatcher(context);

    // Live Unity Connection Monitor & Status Bar Controller
    const unityMonitor = new UnityConnectionMonitor(context);


    console.log('[Antigravity Unity] All features registered');
}

async function ensureDotRushInstalled(): Promise<void> {
    const dotrush = vscode.extensions.getExtension(DOTRUSH_EXTENSION_ID);
    if (dotrush) {
        console.log('[Antigravity Unity] DotRush is already installed');
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        'Antigravity Unity requires DotRush for C# IntelliSense and debugging. Install now?',
        'Install DotRush',
        'Later'
    );

    if (choice === 'Install DotRush') {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Installing DotRush...',
                    cancellable: false
                },
                async () => {
                    await vscode.commands.executeCommand(
                        'workbench.extensions.installExtension',
                        DOTRUSH_EXTENSION_ID
                    );
                }
            );
            vscode.window.showInformationMessage(
                'DotRush installed! Reload window for full C# support.',
                'Reload Now'
            ).then(action => {
                if (action === 'Reload Now') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        } catch (error) {
            vscode.window.showWarningMessage(
                `Failed to install DotRush automatically. Please install it manually from the extensions marketplace: ${DOTRUSH_EXTENSION_ID}`
            );
        }
    }
}

/**
 * Detects dotnet SDK installation and injects its directory into process.env.
 * Strategy: 1) check current PATH, 2) try `which`/`where` shell command
 * (gets user's login shell PATH), 3) fall back to hardcoded candidates.
 * Sets PATH, DOTNET_ROOT, DOTNET_HOST_PATH, DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR
 * so DotRush can find dotnet for MSBuild and `dotnet restore`.
 */
function injectDotnetPath(): void {
    const currentPath = process.env.PATH || '';
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const dotnetExe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';

    // 1) Check if dotnet is already reachable in current PATH
    for (const dir of currentPath.split(pathSep)) {
        if (dir && fs.existsSync(path.join(dir, dotnetExe))) {
            applyDotnetEnv(dir, path.join(dir, dotnetExe), currentPath, pathSep);
            console.log(`[Antigravity Unity] dotnet found in PATH: ${dir}`);
            return;
        }
    }

    // 2) Try shell detection: `which dotnet` (macOS/Linux) or `where dotnet` (Windows)
    //    Login shell (-l) inherits user's full PATH from .zshrc/.bashrc/.bash_profile
    const detected = detectDotnetViaShell();
    if (detected && fs.existsSync(detected)) {
        const dir = path.dirname(detected);
        applyDotnetEnv(dir, detected, currentPath, pathSep);
        console.log(`[Antigravity Unity] dotnet detected via shell: ${detected}`);
        return;
    }

    // 3) Fallback: hardcoded candidate directories per platform
    let candidates: string[];
    if (process.platform === 'darwin') {
        candidates = [
            '/usr/local/share/dotnet',
            '/opt/homebrew/bin',
        ];
    } else if (process.platform === 'win32') {
        const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
        candidates = [
            path.join(pf, 'dotnet'),
        ];
    } else {
        const home = process.env['HOME'] || '';
        candidates = [
            '/usr/share/dotnet',
            '/usr/bin',
            '/snap/bin',
            path.join(home, '.dotnet'),
        ];
    }

    for (const dir of candidates) {
        const dotnetFullPath = path.join(dir, dotnetExe);
        if (fs.existsSync(dotnetFullPath)) {
            applyDotnetEnv(dir, dotnetFullPath, currentPath, pathSep);
            console.log(`[Antigravity Unity] dotnet found at fallback: ${dir}`);
            return;
        }
    }

    console.warn('[Antigravity Unity] dotnet not found. DotRush may not work correctly.');
}

/** Run `which dotnet` (macOS/Linux) or `where dotnet` (Windows) via login shell. */
function detectDotnetViaShell(): string | null {
    const { execSync } = require('child_process');
    try {
        let cmd: string;
        if (process.platform === 'win32') {
            cmd = 'where dotnet';
        } else {
            // Login shell (-l) to pick up PATH from .zshrc / .bashrc / .profile
            cmd = '/bin/bash -l -c "which dotnet"';
        }
        const result = execSync(cmd, { timeout: 3000, encoding: 'utf8' });
        const firstLine = result.split('\n')[0]?.trim();
        if (firstLine && path.isAbsolute(firstLine)) {
            // Resolve symlinks to get the real dotnet directory
            return fs.realpathSync(firstLine);
        }
    } catch {
        // Shell command failed — not installed or not in shell PATH
    }
    return null;
}

/** Apply dotnet environment variables so DotRush can find MSBuild and run `dotnet restore`. */
function applyDotnetEnv(dir: string, fullPath: string, currentPath: string, pathSep: string): void {
    // Ensure dotnet dir is in PATH
    if (!currentPath.split(pathSep).includes(dir)) {
        process.env.PATH = dir + pathSep + currentPath;
    }
    // DotRush's MSBuild locator probes these env vars to find dotnet
    if (!process.env.DOTNET_ROOT) {
        process.env.DOTNET_ROOT = dir;
    }
    if (!process.env.DOTNET_HOST_PATH) {
        process.env.DOTNET_HOST_PATH = fullPath;
    }
    if (!process.env.DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR) {
        process.env.DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR = dir;
    }
}

/**
 * Watches for .csproj and .sln file changes made by Unity's ProjectGeneration.
 * DotRush's built-in watcher (WorkspaceFilesWatcher) only handles .cs files,
 * and its onDidSaveTextDocument handler only catches saves from within VS Code.
 * External .csproj modifications from Unity are NOT detected by either mechanism.
 *
 * This watcher fills that gap: when Unity regenerates .csproj/.sln files
 * (e.g. after adding/deleting scripts, changing assembly definitions),
 * we detect the change and trigger dotrush.reloadWorkspace to re-read
 * the project structure and refresh Roslyn diagnostics.
 *
 * Flow: Unity changes script → AssetPostprocessor → SyncIfNeeded → Sync() →
 *       .csproj rewritten → this watcher fires → reload DotRush → diagnostics refresh.
 */
function setupCsprojChangeWatcher(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    for (const folder of workspaceFolders) {
        // Watch .csproj and .sln files directly
        const csprojWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, '*.csproj')
        );
        const slnWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, '*.sln')
        );

        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let isReloading = false;
        let pendingReload = false;

        const executeReload = async (reason: string) => {
            if (isReloading) {
                // Queue a single follow-up reload if an active reload is currently running
                pendingReload = true;
                return;
            }

            isReloading = true;
            pendingReload = false;

            console.log(`[Antigravity Unity] ${reason} — reloading DotRush workspace...`);

            try {
                await vscode.commands.executeCommand('dotrush.reloadWorkspace');
                console.log('[Antigravity Unity] DotRush workspace reload completed');
            } catch (err) {
                console.warn('[Antigravity Unity] Failed to reload DotRush workspace:', err);
            } finally {
                isReloading = false;
                if (pendingReload) {
                    pendingReload = false;
                    setTimeout(() => executeReload('Pending project changes'), 1500);
                }
            }
        };

        const triggerReload = (reason: string) => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            // Wait 2.5s for all project file writes to settle
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                executeReload(reason);
            }, 2500);
        };

        // .csproj/.sln changes (from Unity regeneration)
        const handleProjectFileChange = (uri: vscode.Uri) => {
            triggerReload(`Project file changed: ${path.basename(uri.fsPath)}`);
        };

        csprojWatcher.onDidCreate(handleProjectFileChange);
        csprojWatcher.onDidChange(handleProjectFileChange);
        slnWatcher.onDidCreate(handleProjectFileChange);
        slnWatcher.onDidChange(handleProjectFileChange);

        context.subscriptions.push(csprojWatcher, slnWatcher);
    }

    console.log('[Antigravity Unity] .csproj/.sln file watchers initialized');
}


export function deactivate() {
    console.log('[Antigravity Unity] Extension deactivated');
}
