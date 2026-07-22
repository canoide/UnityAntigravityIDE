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
}
