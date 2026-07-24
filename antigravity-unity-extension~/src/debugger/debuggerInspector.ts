import * as vscode from 'vscode';

export async function getActiveStackFrameId(session: vscode.DebugSession): Promise<number | undefined> {
    try {
        const threadsResponse = await session.customRequest('threads');
        if (!threadsResponse || !threadsResponse.threads || threadsResponse.threads.length === 0) {
            return undefined;
        }

        // Iterate through all active threads to find the thread paused at a breakpoint
        for (const thread of threadsResponse.threads) {
            try {
                const stackResponse = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 1 });
                if (stackResponse && stackResponse.stackFrames && stackResponse.stackFrames.length > 0) {
                    return stackResponse.stackFrames[0].id;
                }
            } catch {
                // Continue searching other threads
            }
        }
    } catch (err) {
        console.error('[Antigravity Unity] Failed to query DAP threads:', err);
    }
    return undefined;
}

export class VariableItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly value: string | undefined,
        public readonly variableType: string | undefined,
        public readonly variablesReference: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly parentRef?: number,
        public readonly expression?: string
    ) {
        super(label, collapsibleState);

        if (value !== undefined) {
            this.description = `${value} (${variableType || 'object'})`;
            this.tooltip = `${label}: ${value}\nType: ${variableType || 'unknown'}`;
        } else {
            this.tooltip = label;
        }

        if (variablesReference === 0 && value !== undefined) {
            this.contextValue = 'variableItemLeaf';
            this.iconPath = new vscode.ThemeIcon('symbol-variable');
        } else if (variablesReference > 0) {
            this.contextValue = 'variableItemContainer';
            this.iconPath = new vscode.ThemeIcon('symbol-structure');
        } else {
            this.contextValue = 'variableGroup';
            this.iconPath = new vscode.ThemeIcon('list-tree');
        }
    }
}

export class VariableInspectorTreeProvider implements vscode.TreeDataProvider<VariableItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<VariableItem | undefined | null | void> = new vscode.EventEmitter<VariableItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<VariableItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private watchExpressions: string[] = [];
    public isPaused: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            if (!session) {
                this.isPaused = false;
            }
            this.refresh();
        });

        vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
            if (e.event === 'stopped') {
                this.isPaused = true;
                this.refresh();
            } else if (e.event === 'continued') {
                this.isPaused = false;
                this.refresh();
            }
        });

        // Register DebugAdapterTracker to track standard DAP events ('stopped', 'continued')
        this.context.subscriptions.push(
            vscode.debug.registerDebugAdapterTrackerFactory('*', {
                createDebugAdapterTracker: (session: vscode.DebugSession) => {
                    if (session.type !== 'unity') return {};
                    return {
                        onDidSendMessage: (message: any) => {
                            if (message && message.type === 'event') {
                                if (message.event === 'stopped') {
                                    this.isPaused = true;
                                    this.refresh();
                                } else if (message.event === 'continued') {
                                    this.isPaused = false;
                                    this.refresh();
                                }
                            }
                        }
                    };
                }
            })
        );

        vscode.debug.onDidTerminateDebugSession(() => {
            this.isPaused = false;
            this.refresh();
        });
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public async addWatch(expression?: string): Promise<void> {
        let expr = expression;
        if (!expr) {
            expr = await vscode.window.showInputBox({
                prompt: 'Enter expression or variable name to watch',
                placeHolder: 'e.g. speed, transform.position, health'
            });
        }
        if (expr && expr.trim()) {
            const trimmed = expr.trim();
            if (!this.watchExpressions.includes(trimmed)) {
                this.watchExpressions.push(trimmed);
                this.refresh();
            }
        }
    }

    public removeWatch(item: VariableItem): void {
        if (item && item.expression) {
            const index = this.watchExpressions.indexOf(item.expression);
            if (index >= 0) {
                this.watchExpressions.splice(index, 1);
                this.refresh();
            }
        }
    }

    public getTreeItem(element: VariableItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: VariableItem): Promise<VariableItem[]> {
        const session = vscode.debug.activeDebugSession;

        if (!session || !this.isPaused) {
            if (!element) {
                return [
                    new VariableItem(
                        session ? 'Debugger Running' : 'Debugger Disconnected',
                        'Hit a breakpoint to inspect variables',
                        'status',
                        0,
                        vscode.TreeItemCollapsibleState.None
                    )
                ];
            }
            return [];
        }

        const frameId = await getActiveStackFrameId(session);
        if (frameId === undefined) {
            // Stack frame couldn't be resolved, target might have resumed
            this.isPaused = false;
            if (!element) {
                return [
                    new VariableItem(
                        'Debugger Running / Not Paused',
                        'Hit a breakpoint to inspect variables',
                        'status',
                        0,
                        vscode.TreeItemCollapsibleState.None
                    )
                ];
            }
            return [];
        }

        // Top level: Groups ("Locals", "Watch")
        if (!element) {
            return [
                new VariableItem('Locals', undefined, undefined, -1, vscode.TreeItemCollapsibleState.Expanded),
                new VariableItem('Watch', undefined, undefined, -2, vscode.TreeItemCollapsibleState.Expanded)
            ];
        }

        // Group: Locals
        if (element.label === 'Locals') {
            return await this.fetchLocals(session, frameId);
        }

        // Group: Watch
        if (element.label === 'Watch') {
            return await this.fetchWatchItems(session, frameId);
        }

        // Expanded Variable Object (child properties)
        if (element.variablesReference > 0) {
            return await this.fetchChildVariables(session, element.variablesReference);
        }

        return [];
    }

    private async fetchLocals(session: vscode.DebugSession, frameId: number): Promise<VariableItem[]> {
        try {
            const scopesResponse = await session.customRequest('scopes', { frameId });
            if (!scopesResponse || !scopesResponse.scopes) return [];

            const items: VariableItem[] = [];

            for (const scope of scopesResponse.scopes) {
                const variablesResponse = await session.customRequest('variables', { variablesReference: scope.variablesReference });
                if (variablesResponse && variablesResponse.variables) {
                    for (const v of variablesResponse.variables) {
                        const hasChildren = (v.variablesReference || 0) > 0;
                        items.push(
                            new VariableItem(
                                v.name,
                                v.value,
                                v.type,
                                v.variablesReference || 0,
                                hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                                scope.variablesReference,
                                v.name
                            )
                        );
                    }
                }
            }
            return items;
        } catch (err) {
            console.error('[Antigravity Unity] Failed to fetch DAP locals:', err);
            return [];
        }
    }

    private async fetchWatchItems(session: vscode.DebugSession, frameId: number): Promise<VariableItem[]> {
        if (this.watchExpressions.length === 0) {
            return [
                new VariableItem(
                    'No watch expressions',
                    'Right-click or click + to add watch',
                    'info',
                    0,
                    vscode.TreeItemCollapsibleState.None
                )
            ];
        }

        const items: VariableItem[] = [];
        for (const expr of this.watchExpressions) {
            try {
                const evalResponse = await session.customRequest('evaluate', {
                    expression: expr,
                    frameId,
                    context: 'watch'
                });

                if (evalResponse) {
                    const hasChildren = (evalResponse.variablesReference || 0) > 0;
                    items.push(
                        new VariableItem(
                            expr,
                            evalResponse.result,
                            evalResponse.type,
                            evalResponse.variablesReference || 0,
                            hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                            undefined,
                            expr
                        )
                    );
                }
            } catch (err: any) {
                items.push(
                    new VariableItem(
                        expr,
                        `<error: ${err.message || 'eval failed'}>`,
                        'error',
                        0,
                        vscode.TreeItemCollapsibleState.None,
                        undefined,
                        expr
                    )
                );
            }
        }
        return items;
    }

    private async fetchChildVariables(session: vscode.DebugSession, variablesReference: number): Promise<VariableItem[]> {
        try {
            const variablesResponse = await session.customRequest('variables', { variablesReference });
            if (!variablesResponse || !variablesResponse.variables) return [];

            return variablesResponse.variables.map((v: any) => {
                const hasChildren = (v.variablesReference || 0) > 0;
                return new VariableItem(
                    v.name,
                    v.value,
                    v.type,
                    v.variablesReference || 0,
                    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    variablesReference,
                    v.name
                );
            });
        } catch (err) {
            console.error('[Antigravity Unity] Failed to fetch DAP child variables:', err);
            return [];
        }
    }

    /**
     * Modifies the value of a variable at runtime in the paused stack frame memory.
     */
    public async editVariableValue(item: VariableItem): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            vscode.window.showWarningMessage('Variable modification is only available when debugger is paused at a breakpoint.');
            return;
        }

        const frameId = await getActiveStackFrameId(session);
        if (frameId === undefined) {
            vscode.window.showWarningMessage('Variable modification is only available when execution is paused at a breakpoint.');
            return;
        }

        if (!item || !item.label) return;

        const newValue = await vscode.window.showInputBox({
            prompt: `Set new value for "${item.label}"`,
            value: item.value || '',
            placeHolder: 'e.g. 100, "hello", true'
        });

        if (newValue === undefined) return; // User cancelled

        try {

            if (item.parentRef) {
                await session.customRequest('setVariable', {
                    variablesReference: item.parentRef,
                    name: item.label,
                    value: newValue
                });
            } else {
                const assignExpr = `${item.label} = ${newValue}`;
                await session.customRequest('evaluate', {
                    expression: assignExpr,
                    frameId,
                    context: 'repl'
                });
            }

            vscode.window.showInformationMessage(`Variable "${item.label}" updated to: ${newValue}`);
            this.refresh();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to modify variable "${item.label}": ${err.message || err}`);
        }
    }
}
