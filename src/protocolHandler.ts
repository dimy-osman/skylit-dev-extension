/**
 * Protocol Handler
 * Handles skylit:// protocol for jump-to-block functionality
 */

import * as vscode from 'vscode';
import { DebugLogger } from './debugLogger';

export class ProtocolHandler {
    private debugLogger: DebugLogger;

    constructor(debugLogger: DebugLogger) {
        this.debugLogger = debugLogger;
    }

    /**
     * Register URI handler for skylit:// protocol
     */
    register(context: vscode.ExtensionContext) {
        const handler = vscode.window.registerUriHandler({
            handleUri: async (uri: vscode.Uri) => {
                await this.handleUri(uri);
            }
        });

        context.subscriptions.push(handler);
        this.debugLogger.log('✅ Protocol handler registered for skylit://');
    }

    /**
     * Handle skylit:// URI
     */
    private async handleUri(uri: vscode.Uri) {
        this.debugLogger.log(`📍 Received URI: ${uri.toString()}`);

        // Parse URI: skylit://jump?file=/path/to/file.html&line=42
        if (uri.path === '/jump' || uri.path === 'jump') {
            await this.handleJumpToFile(uri);
        } else {
            this.debugLogger.log(`⚠️ Unknown protocol action: ${uri.path}`);
        }
    }

    /**
     * Handle jump-to-file action
     */
    private async handleJumpToFile(uri: vscode.Uri) {
        try {
            // Parse query parameters
            const params = new URLSearchParams(uri.query);
            const filePath = params.get('file');
            const lineStr = params.get('line');
            const columnStr = params.get('column');

            if (!filePath) {
                this.debugLogger.error('❌ Missing file parameter');
                return;
            }

            const line = lineStr ? parseInt(lineStr, 10) : 1;
            const column = columnStr ? parseInt(columnStr, 10) : 0;

            this.debugLogger.log(`📂 Opening file: ${filePath} at line ${line}`);

            // Open file in editor
            const fileUri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Show document with cursor at specified line
            const editor = await vscode.window.showTextDocument(document, {
                selection: new vscode.Range(
                    line - 1, // VS Code uses 0-based line numbers
                    column,
                    line - 1,
                    column
                ),
                viewColumn: vscode.ViewColumn.One
            });

            // Reveal line at center of viewport
            editor.revealRange(
                new vscode.Range(line - 1, 0, line - 1, 0),
                vscode.TextEditorRevealType.InCenter
            );

            this.debugLogger.info(`✅ Opened ${filePath} at line ${line}`);
            // No popup notification - status bar is enough

        } catch (error: any) {
            this.debugLogger.error(`❌ Error opening file: ${error.message}`);
        }
    }
}
