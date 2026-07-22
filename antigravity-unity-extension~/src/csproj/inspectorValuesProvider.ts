import * as vscode from 'vscode';
import * as net from 'net';
import * as path from 'path';

interface SerializedValueInstance {
    container: string;
    value: string;
    asset_path: string;
    local_id: number;
    is_scene: boolean;
}

interface FieldValuesMap {
    [fieldName: string]: SerializedValueInstance[];
}

export class InspectorValuesProvider implements vscode.HoverProvider {
    private decorationType: vscode.TextEditorDecorationType;
    private cache: Map<string, FieldValuesMap> = new Map();
    private activeDecorations: vscode.DecorationOptions[] = [];

    constructor(private context: vscode.ExtensionContext) {
        // Subtle grey inlay comment decoration type to match JetBrains Rider style
        this.decorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: new vscode.ThemeColor('editorInlayHint.foreground'),
                backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
                fontStyle: 'italic',
            }
        });

        // Trigger updates when active editor changes or when document is saved
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) this.updateDecorations(editor);
        }, null, context.subscriptions);

        vscode.workspace.onDidSaveTextDocument(doc => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === doc) {
                // Clear cache on save to fetch fresh values from Unity
                this.cache.delete(doc.fileName);
                this.updateDecorations(editor);
            }
        }, null, context.subscriptions);

        // Initial trigger
        if (vscode.window.activeTextEditor) {
            this.updateDecorations(vscode.window.activeTextEditor);
        }
    }

    /**
     * Parses the C# file to find all serializable fields.
     */
    private parseSerializableFields(document: vscode.TextDocument): { name: string; range: vscode.Range; type: string }[] {
        const fields: { name: string; range: vscode.Range; type: string }[] = [];
        const text = document.getText();

        // Regular expressions to find SerializeField and public fields in C# classes
        // Matches e.g. [SerializeField] private float speed; or public Transform target;
        // Supports attributes, optional access modifiers, types, and multiple variable names/assignments.
        const lineCount = document.lineCount;
        for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
            const line = document.lineAt(lineIdx);
            const textLine = line.text.trim();

            // Skip comments and usings
            if (textLine.startsWith('//') || textLine.startsWith('/*') || textLine.startsWith('*') || textLine.startsWith('using ')) {
                continue;
            }

            const isSerializeField = textLine.includes('[SerializeField]');
            const isPublic = textLine.startsWith('public ') && !textLine.includes('class ') && !textLine.includes('void ') && !textLine.includes('interface ') && !textLine.includes('struct ') && !textLine.includes('(');

            if (isSerializeField || isPublic) {
                // Parse declaration. We handle fields on the same line or subsequent line if [SerializeField] is on its own line
                let declarationLine = textLine;
                let targetLineIdx = lineIdx;

                if (isSerializeField && textLine === '[SerializeField]' && lineIdx + 1 < lineCount) {
                    declarationLine = document.lineAt(lineIdx + 1).text.trim();
                    targetLineIdx = lineIdx + 1;
                }

                // Match typical C# variable declaration: [access_modifier] [type] [name] [= value];
                // e.g., private float speed = 5.5f; or Transform target;
                const match = declarationLine.match(/(?:private|public|protected|internal)?\s+([A-Za-z0-9_<>\[\]]+)\s+([A-Za-z0-9_]+)\s*(?:=|;)/);
                if (match) {
                    const fieldType = match[1];
                    const fieldName = match[2];

                    // Skip methods or properties
                    if (declarationLine.includes('(') || declarationLine.includes('{')) {
                        continue;
                    }

                    const charIdx = line.text.indexOf(fieldName);
                    if (charIdx >= 0) {
                        const range = new vscode.Range(targetLineIdx, charIdx, targetLineIdx, charIdx + fieldName.length);
                        fields.push({ name: fieldName, range, type: fieldType });
                    }
                }
            }
        }

        return fields;
    }

    /**
     * Updates inline decorations and caches values from Unity.
     */
    private async updateDecorations(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;
        if (document.languageId !== 'csharp') return;

        const fields = this.parseSerializableFields(document);
        if (fields.length === 0) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const fileName = document.fileName;
        let fileValues = this.cache.get(fileName);

        if (!fileValues) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) return;

            const relativePath = path.relative(workspaceFolder.uri.fsPath, fileName).replace(/\\/g, '/');
            const fieldNames = fields.map(f => f.name);

            try {
                fileValues = await this.fetchSerializedValuesFromUnity(relativePath, fieldNames);
                if (fileValues) {
                    this.cache.set(fileName, fileValues);
                }
            } catch (err) {
                console.warn('[Antigravity Unity] Inspector values query failed:', err);
            }
        }

        if (!fileValues) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const decorations: vscode.DecorationOptions[] = [];

        for (const field of fields) {
            const instances = fileValues[field.name];
            if (instances && instances.length > 0) {
                // Subtle inlay comment decoration (Rider style)
                let hintText = '';
                if (instances.length === 1) {
                    hintText = `/* ${instances[0].container}: ${instances[0].value} */`;
                } else {
                    // Show a list summary
                    const samples = instances.slice(0, 2).map(inst => `${inst.container}: ${inst.value}`).join(', ');
                    const suffix = instances.length > 2 ? `, +${instances.length - 2} more` : '';
                    hintText = `/* ${samples}${suffix} */`;
                }

                decorations.push({
                    range: field.range,
                    renderOptions: {
                        after: {
                            contentText: hintText
                        }
                    }
                });
            }
        }

        editor.setDecorations(this.decorationType, decorations);
        this.activeDecorations = decorations;
    }

    /**
     * TCP query helper to retrieve values from Unity Debug Bridge.
     */
    private fetchSerializedValuesFromUnity(classPath: string, fields: string[]): Promise<FieldValuesMap> {
        const port = vscode.workspace.getConfiguration('antigravity').get<number>('debugPort', 56000);
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let buffer = '';
            let resolved = false;

            client.setTimeout(2000);

            client.connect(port, '127.0.0.1', () => {
                const command = {
                    type: 'get_serialized_values',
                    class_path: classPath,
                    fields: fields.join(',')
                };
                client.write(JSON.stringify(command) + '\n');
            });

            client.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) {
                        try {
                            const response = JSON.parse(trimmed);
                            if (response.type === 'serialized_values_result') {
                                resolved = true;
                                client.destroy();
                                resolve(response.values);
                                return;
                            } else if (response.type === 'error') {
                                resolved = true;
                                client.destroy();
                                reject(new Error(response.message));
                                return;
                            }
                        } catch {
                            // Partial chunk
                        }
                    }
                }
            });

            client.on('close', () => {
                if (!resolved) reject(new Error('Connection closed before response received'));
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
                    reject(new Error('Query timed out'));
                }
            });
        });
    }

    /**
     * vscode.HoverProvider Implementation
     */
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        if (document.languageId !== 'csharp') return null;

        const fields = this.parseSerializableFields(document);
        const hoveredField = fields.find(f => f.range.contains(position));

        if (!hoveredField) return null;

        const fileValues = this.cache.get(document.fileName);
        if (!fileValues) return null;

        const instances = fileValues[hoveredField.name];
        if (!instances || instances.length === 0) return null;

        // Build a highly-detailed JetBrains Rider style Hover Card
        const md = new vscode.MarkdownString();
        md.isTrusted = true; // Enables Command URI links!

        md.appendMarkdown(`### 🔍 Serialized Field Usages for **${hoveredField.name}**\n`);
        md.appendMarkdown(`Type: \`${hoveredField.type}\` — Assigned in **${instances.length}** instance(s).\n\n`);

        md.appendMarkdown(`| Object / Container | Value / Reference | Target Asset |\n`);
        md.appendMarkdown(`| :--- | :--- | :--- |\n`);

        for (const inst of instances) {
            // Encode command uri parameters carefully
            const args = encodeURIComponent(JSON.stringify({
                assetPath: inst.asset_path,
                localId: inst.local_id
            }));
            const pingLink = `command:antigravity-unity.pingAsset?${args}`;

            const assetTypeIcon = inst.is_scene ? '🎬' : '📦';
            const assetLabel = `${assetTypeIcon} ${path.basename(inst.asset_path)}`;

            // Create clickable links for interactive pinging!
            md.appendMarkdown(`| [**${inst.container}**](${pingLink} "Ping in Unity Editor") | \`${inst.value}\` | [${assetLabel}](${pingLink} "Ping Asset") |\n`);
        }

        md.appendMarkdown(`\n*Click on any container or asset name to automatically focus and highlight it in Unity.*`);

        return new vscode.Hover(md, hoveredField.range);
    }
}
