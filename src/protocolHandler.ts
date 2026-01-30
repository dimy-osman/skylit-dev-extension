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
     * Security: Validates file is within workspace boundaries
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

            // Validate line and column bounds (prevent NaN issues)
            const line = Math.max(1, Math.min(1000000, parseInt(lineStr || '1', 10) || 1));
            const column = Math.max(0, Math.min(10000, parseInt(columnStr || '0', 10) || 0));

            // Security: Validate file is within workspace boundaries
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                this.debugLogger.error('❌ No workspace folder found - cannot validate file path');
                vscode.window.showErrorMessage('Cannot open file: No workspace folder is open');
                return;
            }

            // Normalize path for comparison
            const normalizedFilePath = filePath.replace(/\\/g, '/');
            
            // Check if file is within any workspace folder
            const isInWorkspace = workspaceFolders.some(folder => {
                const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                return normalizedFilePath.startsWith(folderPath);
            });

            if (!isInWorkspace) {
                // File is outside workspace - require user confirmation
                this.debugLogger.warn(`⚠️ File outside workspace: ${filePath}`);
                
                const choice = await vscode.window.showWarningMessage(
                    `Security: This file is outside your workspace.\n\n${filePath}\n\nDo you want to open it?`,
                    { modal: true },
                    'Open File',
                    'Cancel'
                );

                if (choice !== 'Open File') {
                    this.debugLogger.log('❌ User cancelled opening file outside workspace');
                    return;
                }
                
                this.debugLogger.log('✅ User approved opening file outside workspace');
            }

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
            vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
        }
    }
}
