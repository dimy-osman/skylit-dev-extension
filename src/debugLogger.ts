/**
 * Skylit.DEV Debug Logger
 * Centralized debug logging with settings-based control
 */

import * as vscode from 'vscode';

/**
 * Debug Logger - Conditional output logging based on settings
 */
export class DebugLogger {
    private outputChannel: vscode.OutputChannel;
    private isDebugEnabled: boolean = false;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.updateDebugStatus();
        
        // Listen for settings changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('skylit.debugOutput')) {
                this.updateDebugStatus();
            }
        });
    }

    /**
     * Update debug status from settings
     */
    private updateDebugStatus() {
        const config = vscode.workspace.getConfiguration('skylit');
        this.isDebugEnabled = config.get<boolean>('debugOutput', false);
    }

    /**
     * Check if debug is enabled
     */
    public isEnabled(): boolean {
        return this.isDebugEnabled;
    }

    /**
     * Log a message (only if debug is enabled)
     */
    public log(message: string) {
        if (this.isDebugEnabled) {
            this.outputChannel.appendLine(message);
        }
    }

    /**
     * Log an error (always shown, regardless of debug setting)
     */
    public error(message: string) {
        this.outputChannel.appendLine(message);
    }

    /**
     * Log a warning (always shown, regardless of debug setting)
     */
    public warn(message: string) {
        this.outputChannel.appendLine(message);
    }

    /**
     * Log an info message (always shown, regardless of debug setting)
     */
    public info(message: string) {
        this.outputChannel.appendLine(message);
    }

    /**
     * Show the output channel
     */
    public show() {
        this.outputChannel.show();
    }

    /**
     * Dispose the output channel
     */
    public dispose() {
        this.outputChannel.dispose();
    }

    /**
     * Get the underlying output channel (for backward compatibility)
     */
    public getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }
}
