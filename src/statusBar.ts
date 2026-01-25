/**
 * Status Bar Manager
 * Shows connection and sync status in VS Code status bar
 */

import * as vscode from 'vscode';
import { ConnectionState, SyncStatus } from './types';

export class StatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private outputChannel: vscode.OutputChannel;
    private connectionState: ConnectionState = 'disconnected';
    private syncStatus: SyncStatus = 'idle';

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        
        // Create status bar item (right side, high priority)
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        
        this.statusBarItem.command = 'skylit.showMenu';
        this.statusBarItem.show();
        
        // Initial state
        this.updateStatus('disconnected', 'Not connected');
    }

    /**
     * Update connection status
     */
    updateStatus(state: ConnectionState, message?: string) {
        this.connectionState = state;

        switch (state) {
            case 'disconnected':
                this.statusBarItem.text = '$(circle-slash) Skylit.DEV I/O';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                    'statusBarItem.errorBackground'
                );
                this.statusBarItem.tooltip = message || 'Skylit.DEV I/O: Click to connect to WordPress';
                break;

            case 'connecting':
                this.statusBarItem.text = '$(sync~spin) Skylit.DEV I/O';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = message || 'Skylit.DEV I/O: Connecting to WordPress...';
                break;

            case 'connected':
                this.statusBarItem.text = '$(check) Skylit.DEV I/O';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = message || 'Skylit.DEV I/O: Connected to WordPress. Click for actions.';
                break;

            case 'error':
                this.statusBarItem.text = '$(error) Skylit.DEV I/O';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                    'statusBarItem.errorBackground'
                );
                this.statusBarItem.tooltip = message || 'Skylit.DEV I/O: Connection error. Click to reconnect.';
                break;
        }

        this.outputChannel.appendLine(`📊 Status: ${state} - ${message || ''}`);
    }

    /**
     * Show syncing state temporarily
     */
    async showSyncing(fileName: string) {
        const originalText = this.statusBarItem.text;
        const originalTooltip = this.statusBarItem.tooltip;

        this.statusBarItem.text = '$(sync~spin) Skylit.DEV I/O';
        this.statusBarItem.tooltip = `Skylit.DEV I/O: Syncing ${fileName}...`;

        // Reset after 1.5 seconds (temporary notification)
        setTimeout(() => {
            this.statusBarItem.text = originalText;
            this.statusBarItem.tooltip = originalTooltip;
        }, 1500);
    }

    /**
     * Show sync success (temporary notification that auto-dismisses)
     */
    showSuccess(message: string, duration: number = 2000) {
        const originalText = this.statusBarItem.text;
        const originalTooltip = this.statusBarItem.tooltip;

        this.statusBarItem.text = '$(check) Skylit.DEV I/O';
        this.statusBarItem.tooltip = `Skylit.DEV I/O: ${message}`;

        // Auto-dismiss after duration (default 2 seconds - temporary notification)
        setTimeout(() => {
            this.statusBarItem.text = originalText;
            this.statusBarItem.tooltip = originalTooltip;
        }, duration);
    }

    /**
     * Dispose status bar item
     */
    dispose() {
        this.statusBarItem.dispose();
    }
}
