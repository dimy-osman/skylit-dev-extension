/**
 * Authentication Manager
 * Handles secure storage of auth tokens using VS Code SecretStorage
 */

import * as vscode from 'vscode';

export class AuthManager {
    private secretStorage: vscode.SecretStorage;
    private outputChannel: vscode.OutputChannel;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel
    ) {
        this.secretStorage = context.secrets;
        this.outputChannel = outputChannel;
    }

    /**
     * Get auth token for a site
     */
    async getToken(siteUrl: string): Promise<string | undefined> {
        const key = this.getStorageKey(siteUrl);
        const token = await this.secretStorage.get(key);
        
        if (token) {
            this.outputChannel.appendLine(`🔑 Found saved token for ${siteUrl}`);
        } else {
            this.outputChannel.appendLine(`⚠️ No token found for ${siteUrl}`);
        }

        return token;
    }

    /**
     * Save auth token for a site
     */
    async saveToken(siteUrl: string, token: string): Promise<void> {
        const key = this.getStorageKey(siteUrl);
        await this.secretStorage.store(key, token);
        this.outputChannel.appendLine(`✅ Saved token for ${siteUrl}`);
    }

    /**
     * Delete auth token for a site
     */
    async deleteToken(siteUrl: string): Promise<void> {
        const key = this.getStorageKey(siteUrl);
        await this.secretStorage.delete(key);
        this.outputChannel.appendLine(`🗑️ Deleted token for ${siteUrl}`);
    }

    /**
     * Generate storage key from site URL
     */
    private getStorageKey(siteUrl: string): string {
        // Normalize URL (remove trailing slash, protocol)
        const normalized = siteUrl
            .replace(/^https?:\/\//, '')
            .replace(/\/$/, '');
        
        return `skylit.token.${normalized}`;
    }
}
