import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

export type NodeKind =
    | 'root-assets'
    | 'root-packages'
    | 'readonly-group'
    | 'directory'
    | 'file'
    | 'readonly-directory'
    | 'readonly-file';

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

export class UnityExplorerItem extends vscode.TreeItem {
    public readonly fsPath: string;
    public readonly kind: NodeKind;

    constructor(
        label: string,
        fsPath: string,
        kind: NodeKind,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.fsPath = fsPath;
        this.kind = kind;
        this.tooltip = fsPath;

        switch (kind) {
            case 'root-assets':
                this.iconPath = new vscode.ThemeIcon('folder-opened');
                this.contextValue = 'unityAssetsRoot';
                break;

            case 'root-packages':
                this.iconPath = new vscode.ThemeIcon('package');
                this.contextValue = 'unityPackagesRoot';
                break;

            case 'readonly-group':
                this.iconPath = new vscode.ThemeIcon('lock');
                this.description = 'read only';
                this.contextValue = 'unityReadOnlyGroup';
                break;

            case 'directory':
                this.resourceUri = vscode.Uri.file(fsPath);
                this.iconPath = vscode.ThemeIcon.Folder;
                this.contextValue = 'unityDirectory';
                break;

            case 'readonly-directory':
                this.resourceUri = vscode.Uri.file(fsPath);
                this.iconPath = vscode.ThemeIcon.Folder;
                this.description = 'read only';
                this.contextValue = 'unityReadOnly';
                break;

            case 'file':
                this.resourceUri = vscode.Uri.file(fsPath);
                this.iconPath = vscode.ThemeIcon.File;
                this.contextValue = 'unityFile';
                this.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [vscode.Uri.file(fsPath)]
                };
                break;

            case 'readonly-file':
                this.resourceUri = vscode.Uri.file(fsPath);
                this.iconPath = vscode.ThemeIcon.File;
                this.description = 'read only';
                this.contextValue = 'unityReadOnly';
                this.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [vscode.Uri.file(fsPath)]
                };
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

export class UnityExplorerProvider implements vscode.TreeDataProvider<UnityExplorerItem> {
    private readonly _onDidChangeTreeData =
        new vscode.EventEmitter<UnityExplorerItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly workspaceRoot: string) {}

    /** Call to refresh the entire tree or a specific node. */
    refresh(item?: UnityExplorerItem): void {
        this._onDidChangeTreeData.fire(item);
    }

    getTreeItem(element: UnityExplorerItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: UnityExplorerItem): vscode.ProviderResult<UnityExplorerItem[]> {
        if (!element) {
            return this.getRootItems();
        }

        switch (element.kind) {
            case 'root-assets':
                return this.listDirectory(
                    path.join(this.workspaceRoot, 'Assets'),
                    'directory',
                    'file'
                );

            case 'root-packages':
                return this.getPackagesChildren();

            case 'readonly-group':
                return this.listDirectory(
                    path.join(this.workspaceRoot, 'Library', 'PackageCache'),
                    'readonly-directory',
                    'readonly-file'
                );

            case 'directory':
                return this.listDirectory(element.fsPath, 'directory', 'file');

            case 'readonly-directory':
                return this.listDirectory(element.fsPath, 'readonly-directory', 'readonly-file');

            default:
                return [];
        }
    }

    getParent(element: UnityExplorerItem): vscode.ProviderResult<UnityExplorerItem> {
        if (!element || !element.fsPath) {
            return undefined;
        }

        const normPath = path.normalize(element.fsPath);
        const assetsPath = path.normalize(path.join(this.workspaceRoot, 'Assets'));
        const packagesPath = path.normalize(path.join(this.workspaceRoot, 'Packages'));
        const cacheDir = path.normalize(path.join(this.workspaceRoot, 'Library', 'PackageCache'));

        if (normPath === assetsPath || normPath === packagesPath) {
            return undefined;
        }

        const parentDir = path.dirname(normPath);

        if (normPath.startsWith(assetsPath + path.sep)) {
            if (parentDir === assetsPath) {
                return new UnityExplorerItem(
                    'Assets',
                    assetsPath,
                    'root-assets',
                    vscode.TreeItemCollapsibleState.Expanded
                );
            }
            return new UnityExplorerItem(
                path.basename(parentDir),
                parentDir,
                'directory',
                vscode.TreeItemCollapsibleState.Expanded
            );
        }

        if (normPath.startsWith(packagesPath + path.sep)) {
            if (parentDir === packagesPath) {
                return new UnityExplorerItem(
                    'Packages',
                    packagesPath,
                    'root-packages',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
            }
            return new UnityExplorerItem(
                path.basename(parentDir),
                parentDir,
                'directory',
                vscode.TreeItemCollapsibleState.Collapsed
            );
        }

        if (normPath.startsWith(cacheDir + path.sep)) {
            if (parentDir === cacheDir) {
                return new UnityExplorerItem(
                    'Read Only',
                    cacheDir,
                    'readonly-group',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
            }
            return new UnityExplorerItem(
                path.basename(parentDir),
                parentDir,
                'readonly-directory',
                vscode.TreeItemCollapsibleState.Collapsed
            );
        }

        return undefined;
    }

    findItemForPath(targetFsPath: string): UnityExplorerItem | undefined {
        if (!targetFsPath || !fs.existsSync(targetFsPath)) {
            return undefined;
        }

        const normTarget = path.normalize(targetFsPath);
        const assetsPath = path.normalize(path.join(this.workspaceRoot, 'Assets'));
        const packagesPath = path.normalize(path.join(this.workspaceRoot, 'Packages'));
        const cacheDir = path.normalize(path.join(this.workspaceRoot, 'Library', 'PackageCache'));

        let isDirectory = false;
        try {
            isDirectory = fs.statSync(normTarget).isDirectory();
        } catch {
            return undefined;
        }

        if (normTarget === assetsPath) {
            return new UnityExplorerItem('Assets', assetsPath, 'root-assets', vscode.TreeItemCollapsibleState.Expanded);
        }

        if (normTarget === packagesPath) {
            return new UnityExplorerItem('Packages', packagesPath, 'root-packages', vscode.TreeItemCollapsibleState.Collapsed);
        }

        if (normTarget.startsWith(assetsPath + path.sep)) {
            const kind: NodeKind = isDirectory ? 'directory' : 'file';
            const state = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
            return new UnityExplorerItem(path.basename(normTarget), normTarget, kind, state);
        }

        if (normTarget.startsWith(packagesPath + path.sep)) {
            const kind: NodeKind = isDirectory ? 'directory' : 'file';
            const state = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
            return new UnityExplorerItem(path.basename(normTarget), normTarget, kind, state);
        }

        if (normTarget.startsWith(cacheDir + path.sep)) {
            const kind: NodeKind = isDirectory ? 'readonly-directory' : 'readonly-file';
            const state = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
            return new UnityExplorerItem(path.basename(normTarget), normTarget, kind, state);
        }

        return undefined;
    }

    async expandAll(treeView: vscode.TreeView<UnityExplorerItem>): Promise<void> {
        const expandItem = async (item: UnityExplorerItem) => {
            if (
                item.kind === 'directory' ||
                item.kind === 'readonly-directory' ||
                item.kind === 'root-assets' ||
                item.kind === 'root-packages' ||
                item.kind === 'readonly-group'
            ) {
                try {
                    await treeView.reveal(item, { expand: true, select: false, focus: false });
                    const children = await this.getChildren(item);
                    if (children) {
                        for (const child of children) {
                            if (
                                child.kind === 'directory' ||
                                child.kind === 'readonly-directory' ||
                                child.kind === 'root-assets' ||
                                child.kind === 'root-packages' ||
                                child.kind === 'readonly-group'
                            ) {
                                await expandItem(child);
                            }
                        }
                    }
                } catch { }
            }
        };

        const roots = await this.getChildren();
        if (roots) {
            for (const root of roots) {
                await expandItem(root);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Root
    // -------------------------------------------------------------------------

    private getRootItems(): UnityExplorerItem[] {
        const items: UnityExplorerItem[] = [];

        const assetsPath = path.join(this.workspaceRoot, 'Assets');
        if (fs.existsSync(assetsPath)) {
            items.push(new UnityExplorerItem(
                'Assets',
                assetsPath,
                'root-assets',
                vscode.TreeItemCollapsibleState.Expanded
            ));
        }

        const packagesPath = path.join(this.workspaceRoot, 'Packages');
        if (fs.existsSync(packagesPath)) {
            items.push(new UnityExplorerItem(
                'Packages',
                packagesPath,
                'root-packages',
                vscode.TreeItemCollapsibleState.Collapsed
            ));
        }

        return items;
    }

    // -------------------------------------------------------------------------
    // Packages section
    // -------------------------------------------------------------------------

    private getPackagesChildren(): UnityExplorerItem[] {
        const packagesPath = path.join(this.workspaceRoot, 'Packages');
        const items: UnityExplorerItem[] = [];

        // manifest.json
        const manifestPath = path.join(packagesPath, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            items.push(this.makeFileItem('manifest.json', manifestPath));
        }

        // packages-lock.json
        const lockPath = path.join(packagesPath, 'packages-lock.json');
        if (fs.existsSync(lockPath)) {
            items.push(this.makeFileItem('packages-lock.json', lockPath));
        }

        // Local packages: sub-folders inside Packages/
        const seenPaths = new Set<string>([manifestPath, lockPath]);
        try {
            const entries = fs.readdirSync(packagesPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const fullPath = path.join(packagesPath, entry.name);
                if (!seenPaths.has(fullPath)) {
                    seenPaths.add(fullPath);
                    items.push(new UnityExplorerItem(
                        entry.name,
                        fullPath,
                        'directory',
                        vscode.TreeItemCollapsibleState.Collapsed
                    ));
                }
            }
        } catch { }

        // Local packages: file: paths declared in manifest.json
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                const deps: Record<string, string> = manifest.dependencies ?? {};
                for (const version of Object.values(deps)) {
                    if (typeof version !== 'string' || !version.startsWith('file:')) {
                        continue;
                    }
                    // Unity resolves file: paths relative to the project root
                    const rel = version.slice(5);
                    const absPath = path.isAbsolute(rel)
                        ? rel
                        : path.resolve(this.workspaceRoot, rel);

                    if (!seenPaths.has(absPath) && fs.existsSync(absPath)) {
                        seenPaths.add(absPath);
                        items.push(new UnityExplorerItem(
                            path.basename(absPath),
                            absPath,
                            'directory',
                            vscode.TreeItemCollapsibleState.Collapsed
                        ));
                    }
                }
            } catch { }
        }

        // Read Only group (Library/PackageCache)
        const cacheDir = path.join(this.workspaceRoot, 'Library', 'PackageCache');
        if (fs.existsSync(cacheDir)) {
            items.push(new UnityExplorerItem(
                'Read Only',
                cacheDir,
                'readonly-group',
                vscode.TreeItemCollapsibleState.Collapsed
            ));
        }

        return items;
    }

    // -------------------------------------------------------------------------
    // Generic directory listing
    // -------------------------------------------------------------------------

    private listDirectory(
        dirPath: string,
        dirKind: 'directory' | 'readonly-directory',
        fileKind: 'file' | 'readonly-file'
    ): UnityExplorerItem[] {
        const items: UnityExplorerItem[] = [];

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const dirs: fs.Dirent[] = [];
            const files: fs.Dirent[] = [];

            for (const entry of entries) {
                // Skip .meta sidecars and hidden entries
                if (entry.name.endsWith('.meta')) continue;
                if (entry.name.startsWith('.')) continue;

                if (entry.isDirectory()) {
                    dirs.push(entry);
                } else if (entry.isFile()) {
                    files.push(entry);
                }
            }

            // Folders first, then files — both alphabetical
            dirs.sort((a, b) => a.name.localeCompare(b.name));
            files.sort((a, b) => a.name.localeCompare(b.name));

            for (const d of dirs) {
                items.push(new UnityExplorerItem(
                    d.name,
                    path.join(dirPath, d.name),
                    dirKind,
                    vscode.TreeItemCollapsibleState.Collapsed
                ));
            }

            for (const f of files) {
                items.push(new UnityExplorerItem(
                    f.name,
                    path.join(dirPath, f.name),
                    fileKind,
                    vscode.TreeItemCollapsibleState.None
                ));
            }
        } catch { }

        return items;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private makeFileItem(label: string, fsPath: string): UnityExplorerItem {
        return new UnityExplorerItem(label, fsPath, 'file', vscode.TreeItemCollapsibleState.None);
    }

    // -------------------------------------------------------------------------
    // File Explorer Context Operations
    // -------------------------------------------------------------------------

    async createFile(item?: UnityExplorerItem): Promise<void> {
        let targetDir = path.join(this.workspaceRoot, 'Assets');
        if (item?.fsPath) {
            try {
                const stat = fs.statSync(item.fsPath);
                targetDir = stat.isDirectory() ? item.fsPath : path.dirname(item.fsPath);
            } catch { }
        }

        const filename = await vscode.window.showInputBox({
            prompt: 'Enter file name',
            placeHolder: 'NewScript.cs'
        });

        if (!filename || !filename.trim()) {
            return;
        }

        const cleanName = filename.trim();
        const newFilePath = path.join(targetDir, cleanName);

        if (fs.existsSync(newFilePath)) {
            vscode.window.showErrorMessage(`File "${cleanName}" already exists.`);
            return;
        }

        let content = '';
        if (cleanName.endsWith('.cs')) {
            const className = path.basename(cleanName, '.cs').replace(/[^a-zA-Z0-9_]/g, '');
            content = `using UnityEngine;

public class ${className} : MonoBehaviour
{
    void Start()
    {

    }

    void Update()
    {

    }
}
`;
        }

        fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
        fs.writeFileSync(newFilePath, content, 'utf-8');
        this.refresh();

        try {
            const doc = await vscode.workspace.openTextDocument(newFilePath);
            await vscode.window.showTextDocument(doc);
        } catch { }
    }

    async createFolder(item?: UnityExplorerItem): Promise<void> {
        let targetDir = path.join(this.workspaceRoot, 'Assets');
        if (item?.fsPath) {
            try {
                const stat = fs.statSync(item.fsPath);
                targetDir = stat.isDirectory() ? item.fsPath : path.dirname(item.fsPath);
            } catch { }
        }

        const folderName = await vscode.window.showInputBox({
            prompt: 'Enter folder name',
            placeHolder: 'NewFolder'
        });

        if (!folderName || !folderName.trim()) {
            return;
        }

        const cleanName = folderName.trim();
        const newFolderPath = path.join(targetDir, cleanName);

        if (fs.existsSync(newFolderPath)) {
            vscode.window.showErrorMessage(`Folder "${cleanName}" already exists.`);
            return;
        }

        fs.mkdirSync(newFolderPath, { recursive: true });
        this.refresh();
    }

    async renameItem(item?: UnityExplorerItem): Promise<void> {
        if (!item?.fsPath || !fs.existsSync(item.fsPath)) {
            return;
        }

        const oldPath = item.fsPath;
        const currentName = path.basename(oldPath);

        const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name',
            value: currentName
        });

        if (!newName || !newName.trim() || newName.trim() === currentName) {
            return;
        }

        const cleanName = newName.trim();
        const newPath = path.join(path.dirname(oldPath), cleanName);

        if (fs.existsSync(newPath)) {
            vscode.window.showErrorMessage(`An item named "${cleanName}" already exists.`);
            return;
        }

        try {
            fs.renameSync(oldPath, newPath);

            // Rename accompanying .meta file if it exists
            const oldMeta = oldPath + '.meta';
            const newMeta = newPath + '.meta';
            if (fs.existsSync(oldMeta)) {
                fs.renameSync(oldMeta, newMeta);
            }

            this.refresh();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to rename: ${err.message}`);
        }
    }

    async deleteItem(item?: UnityExplorerItem): Promise<void> {
        if (!item?.fsPath || !fs.existsSync(item.fsPath)) {
            return;
        }

        const targetPath = item.fsPath;
        const targetName = path.basename(targetPath);
        const metaPath = targetPath + '.meta';

        const choice = await vscode.window.showWarningMessage(
            `Are you sure you want to delete "${targetName}"?`,
            { modal: true },
            'Move to Trash',
            'Delete Permanently'
        );

        if (!choice) {
            return;
        }

        try {
            if (choice === 'Move to Trash') {
                await vscode.workspace.fs.delete(vscode.Uri.file(targetPath), { recursive: true, useTrash: true });
                if (fs.existsSync(metaPath)) {
                    await vscode.workspace.fs.delete(vscode.Uri.file(metaPath), { recursive: true, useTrash: true });
                }
            } else {
                fs.rmSync(targetPath, { recursive: true, force: true });
                if (fs.existsSync(metaPath)) {
                    fs.rmSync(metaPath, { recursive: true, force: true });
                }
            }
            this.refresh();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to delete "${targetName}": ${err.message}`);
        }
    }

    async duplicateItem(item?: UnityExplorerItem): Promise<void> {
        if (!item?.fsPath || !fs.existsSync(item.fsPath)) {
            return;
        }

        const srcPath = item.fsPath;
        const parentDir = path.dirname(srcPath);
        const isDir = fs.statSync(srcPath).isDirectory();

        let dupPath = '';
        if (isDir) {
            const baseName = path.basename(srcPath);
            let counter = 1;
            dupPath = path.join(parentDir, `${baseName} copy`);
            while (fs.existsSync(dupPath)) {
                counter++;
                dupPath = path.join(parentDir, `${baseName} copy ${counter}`);
            }
        } else {
            const ext = path.extname(srcPath);
            const baseName = path.basename(srcPath, ext);
            let counter = 1;
            dupPath = path.join(parentDir, `${baseName} copy${ext}`);
            while (fs.existsSync(dupPath)) {
                counter++;
                dupPath = path.join(parentDir, `${baseName} copy ${counter}${ext}`);
            }
        }

        try {
            copyRecursiveSync(srcPath, dupPath);
            this.refresh();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to duplicate: ${err.message}`);
        }
    }

    async copyPath(item?: UnityExplorerItem): Promise<void> {
        if (item?.fsPath) {
            await vscode.env.clipboard.writeText(item.fsPath);
        }
    }

    async copyRelativePath(item?: UnityExplorerItem): Promise<void> {
        if (item?.fsPath) {
            const rel = vscode.workspace.asRelativePath(item.fsPath);
            await vscode.env.clipboard.writeText(rel);
        }
    }

    async revealInOS(item?: UnityExplorerItem): Promise<void> {
        if (item?.fsPath) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.fsPath));
        }
    }

    async openToSide(item?: UnityExplorerItem): Promise<void> {
        if (item?.fsPath && fs.existsSync(item.fsPath) && !fs.statSync(item.fsPath).isDirectory()) {
            await vscode.window.showTextDocument(vscode.Uri.file(item.fsPath), {
                viewColumn: vscode.ViewColumn.Beside
            });
        }
    }
}

/** Utility to check if a workspace root is a Unity project */
export function isUnityWorkspace(workspaceRoot?: string): boolean {
    if (!workspaceRoot) return false;
    const assetsPath = path.join(workspaceRoot, 'Assets');
    const settingsPath = path.join(workspaceRoot, 'ProjectSettings');
    return fs.existsSync(assetsPath) || fs.existsSync(settingsPath);
}

/** Recursively copies files and directories while skipping .meta sidecar files */
function copyRecursiveSync(src: string, dest: string): void {
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        for (const child of fs.readdirSync(src)) {
            if (child.endsWith('.meta')) continue; // Omit .meta files so Unity creates fresh GUIDs
            copyRecursiveSync(path.join(src, child), path.join(dest, child));
        }
    } else {
        if (!src.endsWith('.meta')) {
            fs.copyFileSync(src, dest);
        }
    }
}

