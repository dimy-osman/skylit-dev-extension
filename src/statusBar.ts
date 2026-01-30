/**
 * Status Bar Manager
 * Shows connection and sync status in VS Code status bar
 */

import * as vscode from 'vscode';
import { ConnectionState, SyncStatus } from './types';
import { DebugLogger } from './debugLogger';

export class StatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private debugLogger: DebugLogger;
    private connectionState: ConnectionState = 'disconnected';
    private syncStatus: SyncStatus = 'idle';
    private resetTimeout: NodeJS.Timeout | null = null;
    private baseText: string = '$(circle-slash) Skylit.DEV I/O';
    private baseTooltip: string = 'Skylit.DEV I/O: Not connected';

    constructor(debugLogger: DebugLogger) {
        this.debugLogger = debugLogger;
        
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
     * Update connection status (this is the base state we always restore to)
     */
    updateStatus(state: ConnectionState, message?: string) {
        this.connectionState = state;
        
        // Clear any pending reset timeout
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = null;
        }

        switch (state) {
            case 'disconnected':
                this.baseText = '$(circle-slash) Skylit.DEV I/O';
                this.baseTooltip = message || 'Skylit.DEV I/O: Click to connect to WordPress';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                    'statusBarItem.errorBackground'
                );
                break;

            case 'connecting':
                this.baseText = '$(sync~spin) Skylit.DEV I/O';
                this.baseTooltip = message || 'Skylit.DEV I/O: Connecting to WordPress...';
                this.statusBarItem.backgroundColor = undefined;
                break;

            case 'connected':
                this.baseText = '$(check) Skylit.DEV I/O';
                this.baseTooltip = message || 'Skylit.DEV I/O: Connected to WordPress. Click for actions.';
                this.statusBarItem.backgroundColor = undefined;
                break;

            case 'error':
                this.baseText = '$(error) Skylit.DEV I/O';
                this.baseTooltip = message || 'Skylit.DEV I/O: Connection error. Click to reconnect.';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                    'statusBarItem.errorBackground'
                );
                break;
        }

        this.statusBarItem.text = this.baseText;
        this.statusBarItem.tooltip = this.baseTooltip;
        this.debugLogger.log(`📊 Status: ${state} - ${message || ''}`);
    }

    /**
     * Show syncing state temporarily (always restores to base connection state)
     */
    showSyncing(fileName: string) {
        // Clear any existing reset timeout
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
        }

        this.statusBarItem.text = '$(sync~spin) Skylit.DEV I/O';
        this.statusBarItem.tooltip = `Skylit.DEV I/O: Syncing ${fileName}...`;

        // Reset to base state after 1.5 seconds
        this.resetTimeout = setTimeout(() => {
            this.resetTimeout = null;
            this.statusBarItem.text = this.baseText;
            this.statusBarItem.tooltip = this.baseTooltip;
        }, 1500);
    }

    /**
     * Show sync success (temporary notification that auto-dismisses to base state)
     */
    showSuccess(message: string, duration: number = 2000) {
        // Clear any existing reset timeout
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
        }

        this.statusBarItem.text = '$(check) Skylit.DEV I/O';
        this.statusBarItem.tooltip = `Skylit.DEV I/O: ${message}`;

        // Reset to base state after duration
        this.resetTimeout = setTimeout(() => {
            this.resetTimeout = null;
            this.statusBarItem.text = this.baseText;
            this.statusBarItem.tooltip = this.baseTooltip;
        }, duration);
    }

    /**
     * Show error temporarily (resets to base state after duration)
     */
    showError(message: string, duration: number = 3000) {
        // Clear any existing reset timeout
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
        }

        this.statusBarItem.text = '$(error) Skylit.DEV I/O';
        this.statusBarItem.tooltip = `Skylit.DEV I/O: ${message}`;

        // Reset to base state after duration
        this.resetTimeout = setTimeout(() => {
            this.resetTimeout = null;
            this.statusBarItem.text = this.baseText;
            this.statusBarItem.tooltip = this.baseTooltip;
        }, duration);
    }

    /**
     * Force reset to base connection state (for use in catch blocks)
     */
    resetToBase() {
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = null;
        }
        this.statusBarItem.text = this.baseText;
        this.statusBarItem.tooltip = this.baseTooltip;
    }

    /**
     * Dispose status bar item
     */
    dispose() {
        this.statusBarItem.dispose();
    }
}
