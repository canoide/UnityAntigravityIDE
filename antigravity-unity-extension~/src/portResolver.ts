import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

export interface BridgeInfo {
    port: number;
    processId?: number;
    projectName?: string;
    projectPath?: string;
    unityVersion?: string;
}

function getCandidateFolders(): string[] {
    const folders: string[] = [];

    // 1. Active editor folder (if file is inside a workspace folder or Unity project)
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (activeFolder) {
            folders.push(activeFolder.uri.fsPath);
        } else {
            // Document might be in a path outside workspace folders (e.g. open Unity project file)
            const activeFilePath = activeEditor.document.uri.fsPath;
            let dir = path.dirname(activeFilePath);
            while (dir && dir !== path.dirname(dir)) {
                if (fs.existsSync(path.join(dir, 'Assets')) || fs.existsSync(path.join(dir, 'ProjectSettings'))) {
                    folders.push(dir);
                    break;
                }
                dir = path.dirname(dir);
            }
        }
    }

    // 2. All workspace folders
    if (vscode.workspace.workspaceFolders) {
        for (const wf of vscode.workspace.workspaceFolders) {
            if (!folders.includes(wf.uri.fsPath)) {
                folders.push(wf.uri.fsPath);
            }
        }
    }

    return folders;
}

export function getActiveUnityProjectPath(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (activeFolder) {
            const p = activeFolder.uri.fsPath;
            if (fs.existsSync(path.join(p, 'Assets')) || fs.existsSync(path.join(p, 'ProjectSettings'))) {
                return p;
            }
        }
        // Walk up from active file path
        const activeFilePath = activeEditor.document.uri.fsPath;
        let dir = path.dirname(activeFilePath);
        while (dir && dir !== path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, 'Assets')) || fs.existsSync(path.join(dir, 'ProjectSettings'))) {
                return dir;
            }
            dir = path.dirname(dir);
        }
    }
    return undefined;
}

export function isUnityWorkspace(workspaceRoot?: string): boolean {
    if (workspaceRoot) {
        const assetsPath = path.join(workspaceRoot, 'Assets');
        const settingsPath = path.join(workspaceRoot, 'ProjectSettings');
        return fs.existsSync(assetsPath) || fs.existsSync(settingsPath);
    }

    const candidateFolders = getCandidateFolders();
    for (const folder of candidateFolders) {
        const assetsPath = path.join(folder, 'Assets');
        const settingsPath = path.join(folder, 'ProjectSettings');
        if (fs.existsSync(assetsPath) || fs.existsSync(settingsPath)) {
            return true;
        }
    }
    return false;
}

export function getBridgeInfo(): BridgeInfo | undefined {
    const candidateFolders = getCandidateFolders();
    for (const folder of candidateFolders) {
        const bridgeJsonPath = path.join(folder, 'Library', 'Antigravity', 'bridge.json');
        if (fs.existsSync(bridgeJsonPath)) {
            try {
                const content = fs.readFileSync(bridgeJsonPath, 'utf8');
                const data = JSON.parse(content) as BridgeInfo;
                if (data && typeof data.port === 'number' && data.port > 0) {
                    return data;
                }
            } catch {
                // Ignore parsing errors
            }
        }
    }
    return undefined;
}

function normalize(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
}

/**
 * Scans ports 56000..56015 and returns the port of a live Unity bridge
 * whose project_path matches the currently active Unity project.
 * Falls back to reading bridge.json, then to the configured port.
 */
export async function findActiveUnityPort(): Promise<number> {
    const activeProjectPath = getActiveUnityProjectPath();

    // 1. Try bridge.json first — only if project_path matches
    const bridgeInfo = getBridgeInfo();
    if (bridgeInfo?.port) {
        const resp = await queryBridgeInfo(bridgeInfo.port);
        if (resp && resp.type === 'debug_info') {
            // Matches if: no active project known, OR project_paths match
            if (!activeProjectPath || !resp.project_path ||
                normalize(resp.project_path) === normalize(activeProjectPath)) {
                return bridgeInfo.port;
            }
        }
    }

    // 2. Scan ports 56000..56015 and find the one matching the active project
    for (let port = 56000; port <= 56015; port++) {
        if (bridgeInfo?.port === port) continue; // already tried
        const resp = await queryBridgeInfo(port);
        if (resp && resp.type === 'debug_info') {
            if (!activeProjectPath || !resp.project_path ||
                normalize(resp.project_path) === normalize(activeProjectPath)) {
                return port;
            }
        }
    }

    // 3. Fallback to configured setting or 56000
    return vscode.workspace.getConfiguration('antigravity').get<number>('debugPort', 56000);
}

export function getUnityPort(): number {
    const bridgeInfo = getBridgeInfo();
    if (bridgeInfo && bridgeInfo.port) {
        return bridgeInfo.port;
    }
    return vscode.workspace.getConfiguration('antigravity').get<number>('debugPort', 56000);
}

interface BridgeInfoResponse {
    type: string;
    project_path?: string;
    project_name?: string;
    unity_version?: string;
    process_id?: number;
}

function queryBridgeInfo(port: number): Promise<BridgeInfoResponse | undefined> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        let buffer = '';

        socket.connect(port, '127.0.0.1', () => {
            socket.write(JSON.stringify({ type: 'info' }) + '\n');
        });

        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    try {
                        const parsed = JSON.parse(trimmed) as BridgeInfoResponse;
                        socket.end();
                        socket.destroy();
                        resolve(parsed);
                        return;
                    } catch { /* continue */ }
                }
            }
        });

        socket.on('error', () => { socket.destroy(); resolve(undefined); });
        socket.on('timeout', () => { socket.destroy(); resolve(undefined); });
        socket.on('close', () => resolve(undefined));
    });
}
