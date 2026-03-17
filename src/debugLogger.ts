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
    private isProfileEnabled: boolean = false;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.updateDebugStatus();
        
        // Listen for settings changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('skylit.debugOutput') || e.affectsConfiguration('skylit.debugProfile')) {
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
        this.isProfileEnabled = config.get<boolean>('debugProfile', false);
    }

    /**
     * Check if debug is enabled
     */
    public isEnabled(): boolean {
        return this.isDebugEnabled;
    }

    /**
     * Check if profile/timing logging is enabled
     */
    public isProfileEnabledFlag(): boolean {
        return this.isProfileEnabled;
    }

    /**
     * Log a profile line: process name, duration ms, heap (when debugProfile is on).
     * Only outputs when skylit.debugProfile is true; use with debugOutput for full log.
     */
    public profile(label: string, durationMs: number, extra?: string) {
        if (!this.isProfileEnabled) return;
        const heap = typeof process !== 'undefined' && process.memoryUsage ? Math.round(process.memoryUsage().heapUsed / 1024) : 0;
        const extraStr = extra ? ` ${extra}` : '';
        this.outputChannel.appendLine(`[Profile] ${label} ${durationMs}ms heap=${heap}kb${extraStr}`);
    }

    /**
     * Start a profile timer; call the returned function to end and log duration.
     * The returned function accepts an optional extra string (e.g. "skip: reason" or "post 123").
     */
    public profileStart(label: string): (extra?: string) => void {
        if (!this.isProfileEnabled) return () => {};
        const start = Date.now();
        return (extra?: string) => {
            this.profile(label, Date.now() - start, extra);
        };
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
