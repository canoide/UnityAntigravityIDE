import * as vscode from 'vscode';

export class ReferenceCodeLensProvider implements vscode.CodeLensProvider {
    private enabled: boolean = true;
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        this.enabled = vscode.workspace.getConfiguration('antigravity').get<boolean>('enableCodeLens', true);

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity.enableCodeLens')) {
                this.enabled = vscode.workspace.getConfiguration('antigravity').get<boolean>('enableCodeLens', true);
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
        if (!this.enabled) return [];

        const codeLenses: vscode.CodeLens[] = [];

        // Parse line by line
        for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
            if (token.isCancellationRequested) return [];

            const line = document.lineAt(lineIdx);
            const textLine = line.text;

            // Skip comments and imports/usings
            const trimmed = textLine.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('using ')) {
                continue;
            }

            // 1. Match Classes / Structs / Interfaces
            const classMatch = textLine.match(/\b(?:class|struct|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (classMatch) {
                const name = classMatch[1];
                const charIdx = textLine.indexOf(name);
                if (charIdx >= 0) {
                    const range = new vscode.Range(lineIdx, charIdx, lineIdx, charIdx + name.length);
                    // Standard C# references CodeLens
                    codeLenses.push(new vscode.CodeLens(range));

                    // Rider-like Unity Asset Usages CodeLens
                    const assetLens = new vscode.CodeLens(range);
                    assetLens.command = {
                        title: '🔍 Find Usages in Unity Assets',
                        command: 'antigravity-unity.findUsagesInAssets'
                    };
                    codeLenses.push(assetLens);
                }
                continue;
            }

            // 2. Match Public / Protected / Internal Methods
            const methodMatch = textLine.match(/\b(?:public|protected|internal)\s+(?:static|virtual|override|async)?\s*([\w<>\[\]\?]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
            if (methodMatch) {
                const name = methodMatch[2];
                const charIdx = textLine.indexOf(name);
                if (charIdx >= 0 && name !== 'if' && name !== 'for' && name !== 'while' && name !== 'switch') {
                    const range = new vscode.Range(lineIdx, charIdx, lineIdx, charIdx + name.length);
                    codeLenses.push(new vscode.CodeLens(range));
                }
                continue;
            }

            // 3. Match Public / Protected / Internal Properties
            const propMatch = textLine.match(/\b(?:public|protected|internal)\s+(?:static|virtual|override)?\s*([\w<>\[\]\?]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*(?:get|set)/);
            if (propMatch) {
                const name = propMatch[2];
                const charIdx = textLine.indexOf(name);
                if (charIdx >= 0) {
                    const range = new vscode.Range(lineIdx, charIdx, lineIdx, charIdx + name.length);
                    codeLenses.push(new vscode.CodeLens(range));
                }
            }
        }

        return codeLenses;
    }

    public async resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken): Promise<vscode.CodeLens | null> {
        // Find locations of references for active document at target position
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return null;

        const document = activeEditor.document;
        const position = codeLens.range.start;

        try {
            // Execute built-in VS Code references query on LSP
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                position
            );

            // Filter out the declaration itself from the reference list if possible
            const hasLocations = locations && locations.length > 0;
            const refLocations = locations ? locations.filter(loc =>
                !(loc.uri.toString() === document.uri.toString() && loc.range.contains(position))
            ) : [];

            // If we filtered out the definition but there were locations, use the filtered count,
            // otherwise fallback to total locations minus 1 (or 0)
            const referenceCount = hasLocations ? Math.max(0, locations.length - 1) : 0;
            const title = referenceCount === 1 ? '1 reference' : `${referenceCount} references`;

            codeLens.command = {
                title: title,
                command: 'editor.action.showReferences',
                arguments: [document.uri, position, locations || []]
            };
            return codeLens;
        } catch (err) {
            codeLens.command = {
                title: '0 references',
                command: ''
            };
            return codeLens;
        }
    }
}
