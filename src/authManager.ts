/**
 * Authentication Manager
 * Handles secure storage of auth tokens using VS Code SecretStorage
 */

import * as vscode from 'vscode';
import { DebugLogger } from './debugLogger';

export class AuthManager {
    private secretStorage: vscode.SecretStorage;
    private debugLogger: DebugLogger;

    constructor(
        context: vscode.ExtensionContext,
        debugLogger: DebugLogger
    ) {
        this.secretStorage = context.secrets;
        this.debugLogger = debugLogger;
    }

    /**
     * Get auth token for a site
     */
    async getToken(siteUrl: string): Promise<string | undefined> {
        const key = this.getStorageKey(siteUrl);
        const token = await this.secretStorage.get(key);
        
        if (token) {
            this.debugLogger.log(`🔑 Found saved token for ${siteUrl}`);
        } else {
            this.debugLogger.log(`⚠️ No token found for ${siteUrl}`);
        }

        return token;
    }

    /**
     * Save auth token for a site
     */
    async saveToken(siteUrl: string, token: string): Promise<void> {
        const key = this.getStorageKey(siteUrl);
        await this.secretStorage.store(key, token);
        this.debugLogger.info(`✅ Saved token for ${siteUrl}`);
    }

    /**
     * Delete auth token for a site
     */
    async deleteToken(siteUrl: string): Promise<void> {
        const key = this.getStorageKey(siteUrl);
        await this.secretStorage.delete(key);
        this.debugLogger.info(`🗑️ Deleted token for ${siteUrl}`);
    }

    /**
     * Clear auth token (alias for deleteToken)
     */
    async clearToken(siteUrl: string): Promise<void> {
        await this.deleteToken(siteUrl);
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
