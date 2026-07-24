import * as vscode from 'vscode';
import { VariableInspectorTreeProvider, getActiveStackFrameId } from './debuggerInspector';

let currentPanel: vscode.WebviewPanel | undefined = undefined;

export async function evaluateExpressionCommand(inspectorProvider?: VariableInspectorTreeProvider): Promise<void> {
    const session = vscode.debug.activeDebugSession;

    if (!session) {
        vscode.window.showWarningMessage('Evaluate Expression is only available when execution is paused at a breakpoint.');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    let initialExpression = '';

    if (editor) {
        const selection = editor.selection;
        if (!selection.isEmpty) {
            initialExpression = editor.document.getText(selection).trim();
        } else {
            const range = editor.document.getWordRangeAtPosition(selection.active);
            if (range) {
                initialExpression = editor.document.getText(range).trim();
            }
        }
    }

    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        if (initialExpression) {
            currentPanel.webview.postMessage({ type: 'setExpression', expression: initialExpression });
        }
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'antigravity-unity.evaluateExpressionWebview',
        'Evaluate Expression',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    currentPanel.webview.html = getWebviewContent(initialExpression);

    currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            const currentSession = vscode.debug.activeDebugSession;
            if (!currentSession) {
                currentPanel?.webview.postMessage({
                    type: 'error',
                    message: 'Debug session disconnected. Hit a breakpoint to evaluate expressions.'
                });
                return;
            }

            const frameId = await getActiveStackFrameId(currentSession);

            switch (message.command) {
                case 'evaluate': {
                    const expr = message.expression ? message.expression.trim() : '';
                    if (!expr) return;

                    try {
                        const evalPayload: any = {
                            expression: expr,
                            context: 'repl'
                        };
                        if (frameId !== undefined) {
                            evalPayload.frameId = frameId;
                        }

                        const response = await currentSession.customRequest('evaluate', evalPayload);

                        if (!response) {
                            currentPanel?.webview.postMessage({
                                type: 'evalResult',
                                expression: expr,
                                result: 'undefined',
                                valueType: 'undefined',
                                variablesReference: 0
                            });
                            return;
                        }

                        const isVoid = response.type === 'void' || response.result === 'void' || response.type === 'System.Void';

                        currentPanel?.webview.postMessage({
                            type: 'evalResult',
                            expression: expr,
                            result: isVoid ? 'void' : (response.result !== undefined ? response.result : JSON.stringify(response)),
                            valueType: response.type || (isVoid ? 'void' : 'unknown'),
                            variablesReference: isVoid ? 0 : (response.variablesReference || 0)
                        });

                        if (inspectorProvider) {
                            inspectorProvider.refresh();
                        }
                    } catch (err: any) {
                        currentPanel?.webview.postMessage({
                            type: 'error',
                            message: err.message || String(err)
                        });
                    }
                    break;
                }

                case 'fetchChildren': {
                    const ref = message.variablesReference;
                    if (!ref || ref <= 0) return;

                    try {
                        const varsResponse = await currentSession.customRequest('variables', { variablesReference: ref });
                        currentPanel?.webview.postMessage({
                            type: 'childrenResult',
                            variablesReference: ref,
                            variables: varsResponse.variables || []
                        });
                    } catch (err: any) {
                        currentPanel?.webview.postMessage({
                            type: 'error',
                            message: `Failed to fetch object properties: ${err.message || err}`
                        });
                    }
                    break;
                }
            }
        },
        undefined,
        []
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

function escapeHtmlTs(str: string): string {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getWebviewContent(initialExpr: string): string {
    const safeExpr = escapeHtmlTs(initialExpr);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Evaluate Expression</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background, #1e1e1e);
            --fg-color: var(--vscode-editor-foreground, #d4d4d4);
            --input-bg: var(--vscode-input-background, #252526);
            --input-fg: var(--vscode-input-foreground, #cccccc);
            --input-border: var(--vscode-input-border, #3c3c3c);
            --button-bg: var(--vscode-button-background, #0e639c);
            --button-fg: var(--vscode-button-foreground, #ffffff);
            --button-hover: var(--vscode-button-hoverBackground, #1177bb);
            --badge-bg: var(--vscode-badge-background, #4d4d4d);
            --badge-fg: var(--vscode-badge-foreground, #ffffff);
            --tree-hover: var(--vscode-list-hoverBackground, #2a2d2e);
            --type-color: #4ec9b0;
            --value-color: #ce9178;
            --num-color: #b5cea8;
            --keyword-color: #569cd6;
            --error-color: #f48771;
        }

        body {
            background-color: var(--bg-color);
            color: var(--fg-color);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            font-size: 13px;
            padding: 16px;
            margin: 0;
            user-select: text;
        }

        .container {
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-width: 900px;
            margin: 0 auto;
        }

        .header-title {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 15px;
            font-weight: 600;
            color: var(--fg-color);
            margin-bottom: 4px;
        }

        .input-group {
            display: flex;
            gap: 8px;
        }

        input[type="text"] {
            flex: 1;
            background-color: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            padding: 8px 10px;
            border-radius: 4px;
            font-family: "Consolas", "Courier New", monospace;
            font-size: 13px;
            outline: none;
        }

        input[type="text"]:focus {
            border-color: var(--button-bg);
        }

        button {
            background-color: var(--button-bg);
            color: var(--button-fg);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            font-weight: 600;
            cursor: pointer;
            outline: none;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        button:hover {
            background-color: var(--button-hover);
        }

        .result-card {
            background-color: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 6px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .result-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--input-border);
            padding-bottom: 8px;
        }

        .result-title {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #858585;
        }

        .type-badge {
            background-color: rgba(78, 201, 176, 0.15);
            color: var(--type-color);
            padding: 2px 8px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 11px;
            font-weight: 600;
        }

        .type-badge.void {
            background-color: rgba(86, 156, 214, 0.2);
            color: var(--keyword-color);
        }

        .value-display {
            font-family: "Consolas", "Courier New", monospace;
            font-size: 13px;
            line-height: 1.5;
            word-break: break-all;
        }

        .value-string { color: var(--value-color); }
        .value-number { color: var(--num-color); }
        .value-boolean { color: var(--keyword-color); }
        .value-void { color: var(--keyword-color); font-style: italic; }

        .tree-view {
            margin-top: 8px;
            display: flex;
            flex-direction: column;
            gap: 2px;
            font-family: "Consolas", "Courier New", monospace;
            font-size: 12px;
        }

        .tree-node {
            display: flex;
            flex-direction: column;
        }

        .tree-row {
            display: flex;
            align-items: center;
            padding: 4px 6px;
            border-radius: 3px;
            cursor: default;
        }

        .tree-row:hover {
            background-color: var(--tree-hover);
        }

        .chevron {
            width: 16px;
            height: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            user-select: none;
            color: #858585;
            font-size: 10px;
        }

        .chevron.expanded {
            transform: rotate(90deg);
        }

        .node-name {
            font-weight: 600;
            margin-right: 6px;
            color: var(--fg-color);
        }

        .node-type {
            color: #858585;
            margin-right: 8px;
            font-size: 11px;
        }

        .node-val {
            color: var(--value-color);
        }

        .children-container {
            margin-left: 18px;
            display: none;
            flex-direction: column;
            gap: 2px;
            border-left: 1px dashed var(--input-border);
            padding-left: 4px;
        }

        .children-container.open {
            display: flex;
        }

        .error-card {
            background-color: rgba(244, 135, 113, 0.1);
            border: 1px solid var(--error-color);
            color: var(--error-color);
            padding: 10px 12px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-title">
            <span>⚡ Evaluate Expression</span>
        </div>

        <div class="input-group">
            <input type="text" id="exprInput" value="${safeExpr}" placeholder="e.g. speed, _valor = 0, transform.position" autofocus />
            <button id="evalBtn">Evaluate</button>
        </div>

        <div id="resultContainer"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const exprInput = document.getElementById('exprInput');
        const evalBtn = document.getElementById('evalBtn');
        const resultContainer = document.getElementById('resultContainer');

        function doEvaluate() {
            const expr = exprInput.value;
            if (expr && expr.trim()) {
                resultContainer.innerHTML = '<div style="color: #858585; padding: 8px;">Evaluating...</div>';
                vscode.postMessage({ command: 'evaluate', expression: expr });
            }
        }

        evalBtn.addEventListener('click', doEvaluate);
        exprInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                doEvaluate();
            }
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.type) {
                case 'setExpression':
                    exprInput.value = msg.expression;
                    doEvaluate();
                    break;

                case 'evalResult':
                    renderEvalResult(msg);
                    break;

                case 'childrenResult':
                    renderChildrenResult(msg);
                    break;

                case 'error':
                    resultContainer.innerHTML = \`<div class="error-card">❌ \${escapeHtml(msg.message)}</div>\`;
                    break;
            }
        });

        function renderEvalResult(data) {
            const isVoid = data.valueType === 'void' || data.result === 'void' || data.valueType === 'System.Void';

            let typeBadgeHtml = isVoid
                ? '<span class="type-badge void">void</span>'
                : \`<span class="type-badge">\${escapeHtml(data.valueType || 'object')}</span>\`;

            let valueHtml = '';
            if (isVoid) {
                valueHtml = '<span class="value-void">void (no return value)</span>';
            } else {
                valueHtml = formatValueSpan(data.result);
            }

            let treeHtml = '';
            if (!isVoid && data.variablesReference > 0) {
                treeHtml = \`
                    <div class="tree-view">
                        <div class="tree-node" data-ref="\${data.variablesReference}">
                            <div class="tree-row">
                                <span class="chevron" onclick="toggleNode(this, \${data.variablesReference})">▶</span>
                                <span class="node-name">Result Object</span>
                                <span class="node-type">(\${escapeHtml(data.valueType)})</span>
                            </div>
                            <div class="children-container" id="children-\${data.variablesReference}"></div>
                        </div>
                    </div>
                \`;
            }

            resultContainer.innerHTML = \`
                <div class="result-card">
                    <div class="result-header">
                        <span class="result-title">Evaluation Result</span>
                        \${typeBadgeHtml}
                    </div>
                    <div class="value-display">\${valueHtml}</div>
                    \${treeHtml}
                </div>
            \`;

            // Auto-expand top level object tree if available
            if (!isVoid && data.variablesReference > 0) {
                const chevron = resultContainer.querySelector(\`.chevron[onclick*="\${data.variablesReference}"]\`);
                if (chevron) {
                    toggleNode(chevron, data.variablesReference);
                }
            }
        }

        function renderChildrenResult(data) {
            const container = document.getElementById('children-' + data.variablesReference);
            if (!container) return;

            if (!data.variables || data.variables.length === 0) {
                container.innerHTML = '<div style="color: #858585; padding: 4px;">No child properties</div>';
                return;
            }

            let html = '';
            for (const v of data.variables) {
                const hasChildren = (v.variablesReference || 0) > 0;
                const chevronHtml = hasChildren
                    ? \`<span class="chevron" onclick="toggleNode(this, \${v.variablesReference})">▶</span>\`
                    : '<span style="width: 16px; display: inline-block;"></span>';

                const valFormatted = formatValueSpan(v.value);
                const typeFormatted = v.type ? \`<span class="node-type">:\${escapeHtml(v.type)}</span>\` : '';

                html += \`
                    <div class="tree-node">
                        <div class="tree-row">
                            \${chevronHtml}
                            <span class="node-name">\${escapeHtml(v.name)}</span>
                            \${typeFormatted}
                            <span>\${valFormatted}</span>
                        </div>
                        \${hasChildren ? \`<div class="children-container" id="children-\${v.variablesReference}"></div>\` : ''}
                    </div>
                \`;
            }
            container.innerHTML = html;
        }

        function toggleNode(chevronEl, ref) {
            const container = document.getElementById('children-' + ref);
            if (!container) return;

            if (container.classList.contains('open')) {
                container.classList.remove('open');
                chevronEl.classList.remove('expanded');
            } else {
                container.classList.add('open');
                chevronEl.classList.add('expanded');
                if (!container.hasChildNodes()) {
                    container.innerHTML = '<div style="color: #858585; padding: 4px;">Loading...</div>';
                    vscode.postMessage({ command: 'fetchChildren', variablesReference: ref });
                }
            }
        }

        function formatValueSpan(valStr) {
            if (valStr === undefined || valStr === null) return '<span class="value-void">null</span>';
            const s = String(valStr);
            if (s.startsWith('"') && s.endsWith('"')) {
                return \`<span class="value-string">\${escapeHtml(s)}</span>\`;
            }
            if (!isNaN(Number(s))) {
                return \`<span class="value-number">\${escapeHtml(s)}</span>\`;
            }
            if (s === 'true' || s === 'false') {
                return \`<span class="value-boolean">\${escapeHtml(s)}</span>\`;
            }
            return \`<span>\${escapeHtml(s)}</span>\`;
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        // Auto evaluate initial expression if provided
        if (exprInput.value && exprInput.value.trim()) {
            doEvaluate();
        }
    </script>
</body>
</html>`;
}
